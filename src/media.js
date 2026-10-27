// FFmpeg helpers: probing, decoding audio for transcription, timeline assets, and rendering edits.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Frame = require('./renderer/frame');

// The installed app ships ffmpeg next to its resources (resources/bin); in development
// ffmpeg-static's binary is used. (Inside app.asar it lives in app.asar.unpacked.)
const fs = require('node:fs');
const WIN = process.platform === 'win32';
const bundledFfmpeg = process.resourcesPath && path.join(process.resourcesPath, 'bin', WIN ? 'ffmpeg.exe' : 'ffmpeg');
const ffmpegPath = bundledFfmpeg && fs.existsSync(bundledFfmpeg)
  ? bundledFfmpeg
  : require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

function runFfmpeg(args, { onStderr, collectStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', collectStdout ? 'pipe' : 'ignore', 'pipe'] });
    const chunks = [];
    let stderr = '';
    proc.stdout?.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => {
      const text = c.toString();
      stderr += text;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      onStderr?.(text);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve({ stderr, stdout: Buffer.concat(chunks) });
      const err = new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-800)}`);
      err.stderr = stderr;
      reject(err);
    });
  });
}

// ffmpeg -i with no output always exits non-zero, so parse its stderr directly.
// Some videos store non-square pixels (e.g. 1080x1080 shown as 9:16). Turning them into
// square pixels first keeps every thumbnail, frame and export at the shape it is shown at.
const SQUARE = 'scale=trunc(iw*sar/2)*2:ih,setsar=1';

async function probe(filePath) {
  let stderr = '';
  try {
    ({ stderr } = await runFfmpeg(['-hide_banner', '-i', filePath]));
  } catch (err) {
    if (err.stderr == null) throw err;
    stderr = err.stderr;
  }
  const dur = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null;
  // Size as displayed: phones store portrait video as landscape plus a rotation tag, and
  // ffmpeg applies that rotation when decoding.
  const videoLine = stderr.split('\n').findIndex((l) => /Stream #\d+:\d+.*: Video:/.test(l) && !/attached pic/.test(l));
  let width = null;
  let height = null;
  if (videoLine >= 0) {
    const size = stderr.split('\n')[videoLine].match(/, (\d{2,5})x(\d{2,5})/);
    if (size) [width, height] = [Number(size[1]), Number(size[2])];
    const sar = stderr.split('\n')[videoLine].match(/\[SAR (\d+):(\d+)/);
    if (size && sar && Number(sar[1]) > 0 && Number(sar[2]) > 0) width = Math.trunc((width * Number(sar[1])) / Number(sar[2]) / 2) * 2; // same rounding as SQUARE
    const rot = stderr.match(/displaymatrix: rotation of (-?[\d.]+) degrees/);
    if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [width, height] = [height, width];
  }
  return {
    duration,
    hasVideo: videoLine >= 0,
    hasAudio: /Stream #\d+:\d+.*: Audio:/.test(stderr),
    width,
    height,
  };
}

// whisper.cpp expects 16 kHz mono 16-bit WAV.
async function decodeToWav(filePath, wavPath) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath]);
}

// Small mono AAC file for uploading to a cloud speech service.
async function encodeForUpload(filePath, outPath) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', outPath]);
}

// Pauses as [start, end] seconds, plus total duration.
async function findSilences(filePath, { noise = '-32dB', minSeconds = 0.35 } = {}) {
  const { stderr } = await runFfmpeg(['-hide_banner', '-nostdin', '-i', filePath, '-af', `silencedetect=noise=${noise}:d=${minSeconds}`, '-f', 'null', '-']);
  const silences = [];
  let start = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end: ([\d.]+)/);
    if (e && start != null) {
      silences.push([start, Number(e[1])]);
      start = null;
    }
  }
  const dur = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  if (start != null) silences.push([start, duration]);
  return { silences, duration };
}

async function extractClip(wavPath, outPath, start, end) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', wavPath, '-c', 'copy', outPath]);
}

// Waveform envelope: peak absolute amplitude (0..1) per 1/perSecond seconds.
async function computePeaks(filePath, perSecond = 50) {
  const rate = 8000;
  const { stdout } = await runFfmpeg(
    ['-hide_banner', '-nostdin', '-i', filePath, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'],
    { collectStdout: true },
  );
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
  const bucket = Math.round(rate / perSecond);
  const peaks = new Array(Math.ceil(samples.length / bucket));
  for (let b = 0; b < peaks.length; b++) {
    let max = 0;
    const end = Math.min(samples.length, (b + 1) * bucket);
    for (let i = b * bucket; i < end; i++) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    peaks[b] = Math.round((max / 32768) * 1000) / 1000;
  }
  return { perSecond, peaks };
}

// Small thumbnails spread over the video for the timeline filmstrip, as data URLs.
async function extractFrames(filePath, duration, outDir, { maxFrames = 400, height = 132 } = {}) {
  const interval = Math.max(0.5, duration / maxFrames);
  await runFfmpeg([
    '-hide_banner', '-nostdin', '-y', '-i', filePath, '-an',
    '-vf', `fps=1/${interval.toFixed(3)},${SQUARE},scale=-2:${height}`,
    '-q:v', '5', path.join(outDir, 'f%05d.jpg'),
  ]);
  const files = (await fsp.readdir(outDir)).filter((f) => /^f\d+\.jpg$/.test(f)).sort();
  return Promise.all(files.map(async (f, i) => ({
    // fps filter frames sit at the middle of each interval
    t: (i + 0.5) * interval,
    src: `data:image/jpeg;base64,${(await fsp.readFile(path.join(outDir, f))).toString('base64')}`,
  })));
}

// Faces across the video for auto-framing: `samples` evenly spaced frames go through the
// Vision face finder (vendor/facedetect). Returns [{ t, faces: [{ x, y, w, h }] }] with boxes
// as fractions of the displayed picture.
const FACEDETECT = path.join(__dirname, '..', 'vendor', 'facedetect', 'facedetect').replace('app.asar', 'app.asar.unpacked');

async function findFaces(filePath, duration, workDir, { samples = 16 } = {}) {
  try { await fsp.access(FACEDETECT); } catch {
    throw new Error('Auto-framing needs the face finder. Build it once with scripts/build-facedetect.sh.');
  }
  const interval = Math.max(0.2, duration / samples);
  await runFfmpeg([
    '-hide_banner', '-nostdin', '-y', '-i', filePath, '-an',
    '-vf', `fps=1/${interval.toFixed(3)},${SQUARE},scale=480:-2`, '-frames:v', String(samples),
    '-q:v', '4', path.join(workDir, 'face%03d.jpg'),
  ]);
  const files = (await fsp.readdir(workDir)).filter((f) => /^face\d+\.jpg$/.test(f)).sort();
  const out = await new Promise((resolve, reject) => {
    const child = spawn(FACEDETECT, files.map((f) => path.join(workDir, f)));
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`Face finder failed (${code}).`))));
  });
  const byFile = new Map(out.split('\n').filter(Boolean).map((line) => { const j = JSON.parse(line); return [path.basename(j.file), j.faces]; }));
  return files.map((f, i) => ({ t: (i + 0.5) * interval, faces: byFile.get(f) ?? [] }));
}

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

// The cleaned voice as its own audio file, for previewing Studio Sound.
async function enhanceAudio(filePath, outPath) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', filePath, '-vn', '-af', `${STUDIO_SOUND},aresample=48000`, '-c:a', 'aac', '-b:a', '160k', outPath]);
}

// Quote a path for use as a filter option value.
function filterPath(p) {
  // Windows paths: forward slashes, with the drive colon escaped below.
  if (WIN) p = p.replace(/\\/g, '/');
  return `'${p.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;
}

// Render only the kept time ranges, concatenated in order. Optionally lay B-roll over the
// picture (overlays: { path, kind: 'video'|'image', start, end, offset } in edited seconds;
// the main audio keeps playing underneath) and burn in an ASS caption file.
async function renderEdit({
  input, output, ranges, hasVideo, hasAudio, duration, width, height,
  overlays = [], audio = [], assPath = null, textAssPath = null, fontsDir = null, clip = null, crf = 18, onProgress,
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
  if (hasVideo) args.push('-map', '[outv]', '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', '30');
  if (hasAudio) args.push('-map', '[outa]');
  if (hasAudio && /\.(mp4|mov|m4a)$/i.test(output)) args.push('-c:a', 'aac', '-b:a', '192k');
  if (/\.(mp4|mov|m4a)$/i.test(output)) args.push('-movflags', '+faststart');
  args.push(output);

  const total = (ranges.reduce((sum, [s, e]) => sum + (e - s), 0) || duration || 1) / speed;
  await runFfmpeg(args, {
    onStderr: (text) => {
      const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) onProgress?.(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / total));
    },
  });
}

// libass only looks in the fonts folder it is given; link the macOS fonts that cover the
// caption scripts (Telugu, Devanagari, Bangla, Kannada, Tamil, Malayalam, Latin) into one.
const CAPTION_FONT_FILES = [
  '/System/Library/Fonts/KohinoorTelugu.ttc',
  '/System/Library/Fonts/Kohinoor.ttc',
  '/System/Library/Fonts/KohinoorBangla.ttc',
  '/System/Library/Fonts/NotoSansKannada.ttc',
  '/System/Library/Fonts/Supplemental/Tamil Sangam MN.ttc',
  '/System/Library/Fonts/Supplemental/Malayalam Sangam MN.ttc',
  '/System/Library/Fonts/Avenir Next.ttc',
];

// Windows: Nirmala UI covers Telugu and the other Indian scripts; Segoe UI the Latin text.
const WINDOWS_FONT_FILES = ['Nirmala.ttc', 'Nirmala.ttf', 'NirmalaB.ttf', 'NirmalaS.ttf', 'segoeui.ttf', 'segoeuib.ttf', 'seguisb.ttf']
  .map((f) => path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', f));

async function prepareFontsDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  for (const f of WIN ? WINDOWS_FONT_FILES : CAPTION_FONT_FILES) {
    const target = path.join(dir, path.basename(f).replace(/\s+/g, '-'));
    // Windows needs admin rights for symlinks, so it copies the font files instead.
    await (WIN ? fsp.copyFile(f, target) : fsp.symlink(f, target)).catch(() => {});
  }
  return dir;
}

// One frame's RGB at a point, for tests and checks.
async function pixelAt(filePath, t, x, y) {
  const { stdout } = await runFfmpeg(
    // yuv420p needs even crop sizes; read the top-left pixel of a 2x2 block
    ['-hide_banner', '-nostdin', '-ss', String(t), '-i', filePath, '-frames:v', '1', '-vf', `crop=2:2:${x - (x % 2)}:${y - (y % 2)},format=rgb24`, '-f', 'rawvideo', 'pipe:1'],
    { collectStdout: true },
  );
  return [...stdout.subarray(0, 3)];
}

// A single thumbnail for a B-roll clip or image, as a data URL.
async function thumbnail(filePath, at = 0.5, height = 120) {
  const { stdout } = await runFfmpeg(
    ['-hide_banner', '-nostdin', '-ss', String(at), '-i', filePath, '-frames:v', '1', '-vf', `${SQUARE},scale=-2:${height}`, '-f', 'mjpeg', '-q:v', '6', 'pipe:1'],
    { collectStdout: true },
  ).catch(() => runFfmpeg(
    ['-hide_banner', '-nostdin', '-i', filePath, '-frames:v', '1', '-vf', `${SQUARE},scale=-2:${height}`, '-f', 'mjpeg', '-q:v', '6', 'pipe:1'],
    { collectStdout: true },
  ));
  return `data:image/jpeg;base64,${stdout.toString('base64')}`;
}

module.exports = {
  probe, decodeToWav, encodeForUpload, enhanceAudio, STUDIO_SOUND, findSilences, extractClip, computePeaks, extractFrames, findFaces, thumbnail,
  prepareFontsDir, pixelAt, renderEdit,
};
