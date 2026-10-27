// The export recipe: the ffmpeg arguments for an edit. Shared by the desktop app (which runs
// ffmpeg itself) and the Android app (ffmpeg.wasm), so both make the same video.
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const Frame = isNode ? require('./frame.js') : root.CutlineFrame;

  // Studio Sound: rumble filter, non-local-means noise reduction, a noise gate that quiets the
  // gaps between words, a little presence for clarity, gentle compression and a limiter.
  // (Loudness normalisation was tried and dropped: it turns quiet stretches, hiss included, back
  // up.) On a hissy test signal this took signal-to-noise from 7.6 to over 200.
  const STUDIO_SOUND = [
    'highpass=f=75',
    'anlmdn=s=7',
    'agate=threshold=0.03:ratio=6:attack=5:release=250:range=0.05',
    'equalizer=f=3200:t=q:w=1.2:g=3',
    'acompressor=threshold=0.1:ratio=3:attack=10:release=200:makeup=1.5',
    'alimiter=limit=0.9',
  ].join(',');

  // Some videos store non-square pixels (e.g. 1080x1080 shown as 9:16). Turning them into
  // square pixels first keeps every thumbnail, frame and export at the shape it is shown at.
  const SQUARE = 'scale=trunc(iw*sar/2)*2:ih,setsar=1';

  // Render only the kept time ranges, concatenated in order. Optionally lay B-roll over the
  // picture (overlays: { path, kind: 'video'|'image', start, end, offset } in edited seconds;
  // the main audio keeps playing underneath) and burn in ASS caption and text files.
  // filterPath quotes a file path for use inside a filter option.
  // Returns { args, total } where total is the output length in seconds (for progress).
  function buildRenderArgs({
    input, output, ranges, hasVideo, hasAudio, duration, width, height,
    overlays = [], audio = [], assPath = null, textAssPath = null, fontsDir = null, clip = null, crf = 18,
    preset = 'medium', filterPath,
  }) {
  // Crop, rotation, frame and placement (see renderer/frame.js); speed and volume come last so
    // B-roll and caption times, which are on the edited timeline, stay in step.
    const L = Frame.layout(width || 1280, height || 720, clip);
    const { speed, volume, muted, enhance } = L.props;
    if (!ranges.length) throw new Error('Nothing left to export: every part of the media is cut.');
    const parts = [];
    const labels = [];
    ranges.forEach(([start, end], i) => {
      const s = start.toFixed(3);
      const e = end.toFixed(3);
      if (hasVideo) parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS,${SQUARE}[v${i}]`);
      if (hasAudio) parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
      labels.push(`${hasVideo ? `[v${i}]` : ''}${hasAudio ? `[a${i}]` : ''}`);
    });
    const outs = `${hasVideo ? '[cv]' : ''}${hasAudio ? '[ca]' : ''}`;
    parts.push(`${labels.join('')}concat=n=${ranges.length}:v=${hasVideo ? 1 : 0}:a=${hasAudio ? 1 : 0}${outs}`);

    const inputs = ['-i', input];
    // Extra sounds to mix with the voice: overlay videos turned up, and audio-track items.
    const sounds = [];
    if (hasVideo) {
      const W = L.frame.w;
      const H = L.frame.h;
      const { crop, draw } = L;
      const flips = `${L.props.flipH ? ',hflip' : ''}${L.props.flipV ? ',vflip' : ''}`;
      const turn = ({ 90: ',transpose=1', 180: ',hflip,vflip', 270: ',transpose=2' }[L.rotate] ?? '') + flips;
      const cropped = crop.x || crop.y || crop.w !== Math.round(width) || crop.h !== Math.round(height);
      const framed = draw.x !== 0 || draw.y !== 0 || draw.w !== W || draw.h !== H;
      if (!width || !height) {
        // Size unknown: keep the picture as it is, rounded to even dimensions for x264.
        parts.push('[cv]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p[base]');
      } else if (!framed) {
        parts.push(`[cv]${cropped ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : ''}${turn.slice(1) ? `${turn.slice(1)},` : ''}scale=${W}:${H},setsar=1,format=yuv420p[base]`);
      } else {
        const cropTurn = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}${turn}`;
        if (L.props.bgMode === 'blur') {
          // A zoomed, blurred copy of the same picture fills the frame behind it.
          parts.push('[cv]split=2[cvp][cvb]');
          parts.push(`[cvp]${cropTurn},scale=${draw.w}:${draw.h},setsar=1[pic]`);
          parts.push(`[cvb]${cropTurn},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=${Math.max(2, Math.round(W / 8 / 2) * 2)}:${Math.max(2, Math.round(H / 8 / 2) * 2)},boxblur=6:2,scale=${W}:${H},eq=brightness=-0.06,setsar=1[bg]`);
          parts.push(`[bg][pic]overlay=${draw.x}:${draw.y},format=yuv420p[base]`);
        } else {
          parts.push(`[cv]${cropTurn},scale=${draw.w}:${draw.h},setsar=1[pic]`);
          parts.push(`color=c=${L.props.background.replace('#', '0x')}:s=${W}x${H}:r=30[bg]`);
          parts.push(`[bg][pic]overlay=${draw.x}:${draw.y}:shortest=1,format=yuv420p[base]`);
        }
      }
      let last = 'base';
      overlays.forEach((o, i) => {
        const k = inputs.filter((x) => x === '-i').length;
        const d = Math.max(0.1, o.end - o.start);
        const t0 = o.start.toFixed(3);
        const t1 = o.end.toFixed(3);
        // Position and size within the frame (fractions); the picture fills its box.
        const box = o.box ?? { x: 0, y: 0, w: 1, h: 1 };
        const bw = Math.max(2, Math.round((box.w * W) / 2) * 2);
        const bh = Math.max(2, Math.round((box.h * H) / 2) * 2);
        const bx = Math.round(box.x * W);
        const by = Math.round(box.y * H);
        const alpha = (o.opacity ?? 1) < 1 ? `,colorchannelmixer=aa=${(o.opacity ?? 1).toFixed(3)}` : '';
        // 'cover' fills the box and crops; 'contain' fits inside it on a transparent background.
        const fit = o.fit === 'contain'
          ? `scale=${bw}:${bh}:force_original_aspect_ratio=decrease,setsar=1,format=yuva420p,pad=${bw}:${bh}:(ow-iw)/2:(oh-ih)/2:color=black@0${alpha}`
          : `scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},setsar=1,format=yuva420p${alpha}`;
        const fades = [
          o.fadeIn > 0 ? `fade=t=in:st=${t0}:d=${o.fadeIn.toFixed(3)}:alpha=1` : null,
          o.fadeOut > 0 ? `fade=t=out:st=${Math.max(o.start, o.end - o.fadeOut).toFixed(3)}:d=${o.fadeOut.toFixed(3)}:alpha=1` : null,
        ].filter(Boolean).map((f) => `,${f}`).join('');
        if (o.kind === 'image') {
          inputs.push('-loop', '1', '-framerate', '30', '-t', d.toFixed(3), '-i', o.path);
          parts.push(`[${k}:v]${SQUARE},${fit},setpts=PTS-STARTPTS+${t0}/TB${fades}[b${i}]`);
        } else {
          inputs.push('-i', o.path);
          parts.push(`[${k}:v]trim=start=${(o.offset || 0).toFixed(3)}:duration=${d.toFixed(3)},setpts=PTS-STARTPTS+${t0}/TB,${SQUARE},${fit}${fades}[b${i}]`);
          if (o.hasAudio && (o.volume ?? 0) > 0) sounds.push({ input: k, start: o.start, length: d, offset: o.offset || 0, volume: o.volume, duck: false });
        }
        parts.push(`[${last}][b${i}]overlay=${bx}:${by}:enable='between(t,${t0},${t1})':eof_action=pass[o${i}]`);
        last = `o${i}`;
      });
      // Text and titles sit above the overlays, captions above everything.
      if (textAssPath) {
        parts.push(`[${last}]ass=filename=${filterPath(textAssPath)}${fontsDir ? `:fontsdir=${filterPath(fontsDir)}` : ''}[tx]`);
        last = 'tx';
      }
      if (assPath) {
        parts.push(`[${last}]ass=filename=${filterPath(assPath)}${fontsDir ? `:fontsdir=${filterPath(fontsDir)}` : ''}[sv]`);
      } else {
        parts.push(`[${last}]null[sv]`);
      }
      parts.push(speed !== 1 ? `[sv]setpts=PTS/${speed}[outv]` : '[sv]null[outv]');
    }
    for (const a of audio) {
      const k = inputs.filter((x) => x === '-i').length;
      inputs.push('-i', a.path);
      sounds.push({ input: k, start: a.start, length: Math.max(0.1, a.end - a.start), offset: a.offset || 0, volume: a.volume ?? 1, duck: a.duck !== false });
    }
    if (hasAudio) {
      const gain = muted ? 0 : volume;
      const voiceChain = [enhance ? STUDIO_SOUND : null, gain !== 1 ? `volume=${gain.toFixed(3)}` : null].filter(Boolean);
      parts.push(`[ca]${voiceChain.length ? voiceChain.join(',') : 'anull'}[voice]`);
      let mixed = 'voice';
      if (sounds.length) {
        const prep = (snd, i) => {
          const ms = Math.round(snd.start * 1000);
          parts.push(`[${snd.input}:a]atrim=start=${snd.offset.toFixed(3)}:duration=${snd.length.toFixed(3)},asetpts=PTS-STARTPTS,volume=${snd.volume.toFixed(3)},adelay=${ms}:all=1,aformat=sample_rates=48000:channel_layouts=stereo[s${i}]`);
          return `[s${i}]`;
        };
        const ducked = sounds.filter((x) => x.duck).map((x) => prep(x, sounds.indexOf(x)));
        const plain = sounds.filter((x) => !x.duck).map((x) => prep(x, sounds.indexOf(x)));
        const mixInputs = ['[v0]'];
        parts.push('[voice]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[v0][vkey]');
        if (ducked.length) {
          // Music under speech: compress it whenever the voice is loud (sidechain ducking).
          parts.push(`${ducked.join('')}amix=inputs=${ducked.length}:normalize=0:duration=longest[music]`);
          parts.push('[music][vkey]sidechaincompress=threshold=0.02:ratio=12:attack=20:release=400:makeup=1[ducked]');
          mixInputs.push('[ducked]');
        } else {
          parts.push('[vkey]anullsink');
        }
        mixInputs.push(...plain);
        parts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:normalize=0:duration=first:dropout_transition=0[mixed]`);
        mixed = 'mixed';
      }
      parts.push(`[${mixed}]${speed !== 1 ? Frame.atempoChain(speed) : 'anull'}[outa]`);
    }

    const args = ['-hide_banner', '-nostdin', '-y', ...inputs, '-filter_complex', parts.join(';')];
    if (hasVideo) args.push('-map', '[outv]', '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', '30');
    if (hasAudio) args.push('-map', '[outa]');
    if (hasAudio && /\.(mp4|mov|m4a)$/i.test(output)) args.push('-c:a', 'aac', '-b:a', '192k');
    if (/\.(mp4|mov|m4a)$/i.test(output)) args.push('-movflags', '+faststart');
    args.push(output);

    const total = (ranges.reduce((sum, [s, e]) => sum + (e - s), 0) || duration || 1) / speed;
    return { args, total };
  }

  const api = { STUDIO_SOUND, SQUARE, buildRenderArgs };
  if (isNode) module.exports = api;
  else root.CutlineRenderPlan = api;
})(typeof window !== 'undefined' ? window : globalThis);
