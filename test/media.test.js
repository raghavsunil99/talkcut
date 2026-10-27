const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const { probe, decodeToWav, findSilences, computePeaks, extractFrames, prepareFontsDir, pixelAt, renderEdit } = require('../src/media.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-test-'));
const video = path.join(dir, 'in.mp4');
const audio = path.join(dir, 'in.wav');

test.before(() => {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', audio]);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('probe detects streams and duration', async () => {
  const v = await probe(video);
  assert.equal(v.hasVideo, true);
  assert.equal(v.hasAudio, true);
  assert.ok(Math.abs(v.duration - 6) < 0.1, `duration ${v.duration}`);
  const a = await probe(audio);
  assert.equal(a.hasVideo, false);
  assert.equal(a.hasAudio, true);
});

test('probe finds the video stream even when metadata makes the log long', async () => {
  // Camera files carry lots of metadata; the Stream lines end up far from the end of ffmpeg's log.
  const tagged = path.join(dir, 'tagged.mov');
  const tags = Array.from({ length: 40 }, (_, i) => ['-metadata', `comment${i}=${'x'.repeat(60)}`]).flat();
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-c', 'copy', ...tags, '-movflags', 'use_metadata_tags', tagged]);
  const info = await probe(tagged);
  assert.equal(info.hasVideo, true);
  assert.equal(info.hasAudio, true);
});

test('decodeToWav writes 16 kHz mono 16-bit audio', async () => {
  const wav = path.join(dir, 'decoded.wav');
  await decodeToWav(video, wav);
  const header = fs.readFileSync(wav).subarray(0, 44);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt16LE(22), 1); // channels
  assert.equal(header.readUInt32LE(24), 16000); // sample rate
  assert.equal(header.readUInt16LE(34), 16); // bits per sample
});

test('renderEdit keeps only the selected ranges (video)', async () => {
  const out = path.join(dir, 'out.mp4');
  await renderEdit({ input: video, output: out, ranges: [[0, 1.5], [3, 4.5]], hasVideo: true, hasAudio: true, duration: 6 });
  const info = await probe(out);
  assert.equal(info.hasVideo, true);
  assert.equal(info.hasAudio, true);
  assert.ok(Math.abs(info.duration - 3) < 0.15, `duration ${info.duration}`);
});

test('renderEdit works for audio-only input', async () => {
  const out = path.join(dir, 'out.m4a');
  let lastProgress = 0;
  await renderEdit({ input: audio, output: out, ranges: [[1, 2], [4, 6]], hasVideo: false, hasAudio: true, duration: 6, onProgress: (p) => { lastProgress = p; } });
  const info = await probe(out);
  assert.equal(info.hasVideo, false);
  assert.ok(Math.abs(info.duration - 3) < 0.1, `duration ${info.duration}`);
  assert.ok(lastProgress > 0.5, `progress ${lastProgress}`);
});

test('computePeaks returns a 0..1 envelope at the requested rate', async () => {
  const { perSecond, peaks } = await computePeaks(audio, 50);
  assert.equal(perSecond, 50);
  assert.ok(Math.abs(peaks.length - 300) <= 2, `peaks ${peaks.length}`);
  assert.ok(peaks.every((p) => p >= 0 && p <= 1));
  // ffmpeg's sine source plays at amplitude 1/8
  const max = Math.max(...peaks);
  assert.ok(Math.abs(max - 0.125) < 0.01, `peak ${max}`);
});

test('findSilences finds a pause between tones', async () => {
  const gapped = path.join(dir, 'gapped.wav');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', gapped]);
  const { silences, duration } = await findSilences(gapped);
  assert.ok(Math.abs(duration - 5.5) < 0.1, `duration ${duration}`);
  assert.equal(silences.length, 1, JSON.stringify(silences));
  assert.ok(Math.abs(silences[0][0] - 2) < 0.1 && Math.abs(silences[0][1] - 3.5) < 0.1, JSON.stringify(silences));
});

test('extractFrames returns evenly spaced thumbnails', async () => {
  const out = fs.mkdtempSync(path.join(dir, 'frames-'));
  const frames = await extractFrames(video, 6, out, { maxFrames: 6, height: 36 });
  assert.ok(frames.length >= 5 && frames.length <= 7, `frames ${frames.length}`);
  assert.ok(frames[0].src.startsWith('data:image/jpeg;base64,'));
  assert.ok(frames[1].t > frames[0].t);
});

test('probe reports display size, swapping it for rotated phone video', async () => {
  const rotated = path.join(dir, 'rotated.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation:v:0', '90', '-i', video, '-c', 'copy', rotated]);
  const plain = await probe(video);
  assert.deepEqual([plain.width, plain.height], [320, 240]);
  const info = await probe(rotated);
  assert.deepEqual([info.width, info.height], [240, 320]);
});

test('renderEdit lays B-roll over the picture and burns in captions', async () => {
  const C = require('../src/renderer/captions.js');
  const red = path.join(dir, 'red.png');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', '-update', '1', red]);
  const words = [{ text: 'Glassdoor', start: 0.2, end: 1.0 }, { text: 'లో', start: 1.0, end: 1.6 }, { text: 'account', start: 4.2, end: 5.0 }];
  const assPath = path.join(dir, 'caps.ass');
  fs.writeFileSync(assPath, C.buildAss({
    words, deleted: new Set(), settings: { enabled: true, preset: 'boxed', position: 'middle', size: 'large' },
    language: 'te', width: 320, height: 240, toEdited: (t) => (t >= 3 ? t - 1.5 : t),
  }));
  const fontsDir = await prepareFontsDir(path.join(dir, 'fonts'));
  const out = path.join(dir, 'composed.mp4');
  // keep 0-1.5 and 3-6 (4.5 s); B-roll covers edited 2.0-3.0
  await renderEdit({
    input: video, output: out, ranges: [[0, 1.5], [3, 6]], hasVideo: true, hasAudio: true, duration: 6,
    width: 320, height: 240, overlays: [{ path: red, kind: 'image', start: 2.0, end: 3.0 }], assPath, fontsDir,
  });
  const info = await probe(out);
  assert.ok(Math.abs(info.duration - 4.5) < 0.15, `duration ${info.duration}`);
  const [r, g, b] = await pixelAt(out, 2.5, 5, 5);
  assert.ok(r > 200 && g < 60 && b < 60, `expected red B-roll, got ${[r, g, b]}`);
  const before = await pixelAt(out, 1.0, 5, 5);
  assert.ok(!(before[0] > 200 && before[1] < 60), `B-roll should not show at 1.0 s, got ${before}`);
  // The boxed caption puts a dark box in the middle while words are on screen.
  const mid = await pixelAt(out, 0.5, 160, 120);
  const plainMid = await pixelAt(video, 0.5, 160, 120);
  assert.notDeepEqual(mid, plainMid, 'caption should change the middle of the frame');
});

test('renderEdit applies speed, volume, frame shape, rotation and crop', async () => {
  // 4 s kept at 2x speed in a square frame: 2 s long, 1080x1080, black bars above and below the 4:3 picture
  const square = path.join(dir, 'square.mp4');
  await renderEdit({ input: video, output: square, ranges: [[0, 4]], hasVideo: true, hasAudio: true, duration: 6, width: 320, height: 240, clip: { canvas: '1:1', speed: 2, volume: 0.5 } });
  const sq = await probe(square);
  assert.deepEqual([sq.width, sq.height], [1080, 1080]);
  assert.ok(Math.abs(sq.duration - 2) < 0.15, `duration ${sq.duration}`);
  const bar = await pixelAt(square, 1, 540, 20);
  assert.ok(bar.every((c) => c < 30), `expected a black bar, got ${bar}`);
  const mid = await pixelAt(square, 1, 540, 540);
  assert.ok(!mid.every((c) => c < 30), 'picture in the middle');

  const turned = path.join(dir, 'turned.mp4');
  await renderEdit({ input: video, output: turned, ranges: [[0, 1]], hasVideo: true, hasAudio: false, duration: 6, width: 320, height: 240, clip: { rotate: 90 } });
  const t = await probe(turned);
  assert.deepEqual([t.width, t.height], [240, 320]);

  const cropped = path.join(dir, 'cropped.mp4');
  await renderEdit({ input: video, output: cropped, ranges: [[0, 1]], hasVideo: true, hasAudio: false, duration: 6, width: 320, height: 240, clip: { crop: { l: 0.25, r: 0.25 } } });
  const c = await probe(cropped);
  assert.deepEqual([c.width, c.height], [160, 240]);
});

test('renderEdit can mute and slow down audio-only edits', async () => {
  const out = path.join(dir, 'slow.m4a');
  await renderEdit({ input: audio, output: out, ranges: [[0, 2]], hasVideo: false, hasAudio: true, duration: 6, clip: { speed: 0.5, muted: true } });
  const info = await probe(out);
  assert.ok(Math.abs(info.duration - 4) < 0.15, `duration ${info.duration}`);
  const { peaks } = await computePeaks(out, 10);
  assert.ok(Math.max(...peaks) < 0.01, `should be silent, peak ${Math.max(...peaks)}`);
});

test('overlay boxes place pictures inside the frame', async () => {
  const red = path.join(dir, 'red-pip.png');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', '-update', '1', red]);
  const out = path.join(dir, 'pip.mp4');
  await renderEdit({
    input: video, output: out, ranges: [[0, 3]], hasVideo: true, hasAudio: true, duration: 6, width: 320, height: 240,
    overlays: [{ path: red, kind: 'image', start: 0, end: 3, box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }],
  });
  const inside = await pixelAt(out, 1, 240, 180);
  const outside = await pixelAt(out, 1, 60, 40);
  assert.ok(inside[0] > 200 && inside[1] < 60, `lower-right quarter should be red, got ${inside}`);
  assert.ok(!(outside[0] > 200 && outside[1] < 60), `top-left should be the video, got ${outside}`);
});

test('music on an audio track is mixed in and ducked under the voice', async () => {
  // voice: 2 s of tone then 2 s of silence; music: loud for 4 s
  const voice = path.join(dir, 'voice.wav');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2', '-filter_complex', '[0][1]concat=n=2:v=0:a=1,volume=4', voice]);
  const music = path.join(dir, 'music.wav');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-af', 'volume=3', music]);
  const render = async (duck) => {
    const out = path.join(dir, `mix-${duck}.m4a`);
    await renderEdit({ input: voice, output: out, ranges: [[0, 4]], hasVideo: false, hasAudio: true, duration: 4, audio: [{ path: music, start: 0, end: 4, offset: 0, volume: 1, duck }] });
    const { peaks } = await computePeaks(out, 10);
    const peak = (a, b) => Math.max(...peaks.slice(a * 10, b * 10));
    return { speaking: peak(0.6, 1.6), quiet: peak(2.6, 3.6) };
  };
  const plain = await render(false);
  const ducked = await render(true);
  assert.ok(plain.quiet > 0.2, `music should play in the quiet part, peak ${plain.quiet}`);
  assert.ok(ducked.quiet > 0.2, `ducked music returns when the voice stops, peak ${ducked.quiet}`);
  assert.ok(ducked.speaking < plain.speaking - 0.1, `music should duck under the voice: ${ducked.speaking} vs ${plain.speaking}`);
});

test('Studio Sound lowers background noise and evens out loudness', async () => {
  // a quiet tone with steady hiss under it, and hiss alone in the second half
  const noisy = path.join(dir, 'noisy.wav');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3,volume=0.6',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=3',
    '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=white:a=0.03:r=44100',
    '-filter_complex', '[0][1]concat=n=2:v=0:a=1[t];[t][2]amix=inputs=2:normalize=0', noisy]);
  const render = async (enhance) => {
    const out = path.join(dir, `ss-${enhance}.wav`);
    await renderEdit({ input: noisy, output: out, ranges: [[0, 6]], hasVideo: false, hasAudio: true, duration: 6, clip: { enhance } });
    const { peaks } = await computePeaks(out, 10);
    const avg = (a, b) => peaks.slice(a * 10, b * 10).reduce((x, y) => x + y, 0) / ((b - a) * 10);
    return { tone: avg(0.5, 2.5), hiss: avg(3.5, 5.5) };
  };
  const plain = await render(false);
  const clean = await render(true);
  const ratio = (r) => r.tone / Math.max(1e-4, r.hiss);
  assert.ok(ratio(clean) > ratio(plain) * 2, `signal-to-noise should improve a lot: ${ratio(plain).toFixed(1)} -> ${ratio(clean).toFixed(1)}`);
});

test('renderEdit refuses an empty edit', async () => {
  await assert.rejects(renderEdit({ input: audio, output: path.join(dir, 'x.m4a'), ranges: [], hasVideo: false, hasAudio: true, duration: 6 }), /Nothing left/);
});

test('text items are burned in where their box is', async () => {
  const X = require('../src/renderer/text.js');
  const black = path.join(dir, 'black.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', black]);
  const textAssPath = path.join(dir, 'text.ass');
  fs.writeFileSync(textAssPath, X.buildAss([{ kind: 'text', text: 'X', style: { preset: 'callout' }, box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, start: 0, end: 3 }], { width: 320, height: 240 }));
  const fontsDir = await prepareFontsDir(path.join(dir, 'fonts-text'));
  const out = path.join(dir, 'text.mp4');
  await renderEdit({ input: black, output: out, ranges: [[0, 3]], hasVideo: true, hasAudio: true, duration: 3, width: 320, height: 240, textAssPath, fontsDir });
  const box = await pixelAt(out, 1.5, 165, 125); // corner of the yellow callout box
  const outside = await pixelAt(out, 1.5, 60, 40);
  assert.ok(box[0] > 180 && box[1] > 160 && box[2] < 120, `callout box should be yellow, got ${box}`);
  assert.ok(outside[0] < 40, `outside should stay black, got ${outside}`);
});

test('overlays can fit inside their box and fade in', async () => {
  const red = path.join(dir, 'red-wide.png');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=200x50', '-frames:v', '1', '-update', '1', red]);
  const out = path.join(dir, 'contain.mp4');
  await renderEdit({
    input: video, output: out, ranges: [[0, 3]], hasVideo: true, hasAudio: true, duration: 6, width: 320, height: 240,
    overlays: [{ path: red, kind: 'image', start: 0, end: 3, box: { x: 0, y: 0, w: 1, h: 1 }, fit: 'contain', fadeIn: 1 }],
  });
  const middle = await pixelAt(out, 2, 160, 120);
  const top = await pixelAt(out, 2, 160, 10);
  const early = await pixelAt(out, 0.1, 160, 120);
  assert.ok(middle[0] > 200 && middle[1] < 60, `centre band should be red, got ${middle}`);
  assert.ok(!(top[0] > 200 && top[1] < 60), `above the fitted picture shows the video, got ${top}`);
  assert.ok(!(early[0] > 200 && early[1] < 60), `still fading in at 0.1 s, got ${early}`);
});

test('flip and a blurred background in the export', async () => {
  // left half red, right half blue
  const split = path.join(dir, 'split.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x240:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x240:d=2', '-filter_complex', '[0][1]hstack', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', split]);
  const out = path.join(dir, 'flip-blur.mp4');
  await renderEdit({ input: split, output: out, ranges: [[0, 2]], hasVideo: true, hasAudio: false, duration: 2, width: 320, height: 240,
    clip: { canvas: '9:16', flipH: true, bgMode: 'blur' } });
  const left = await pixelAt(out, 1, 300, 960);
  const right = await pixelAt(out, 1, 780, 960);
  const bgTop = await pixelAt(out, 1, 540, 60);
  assert.ok(left[2] > 150 && left[0] < 100, `flipped: left is blue, got ${left}`);
  assert.ok(right[0] > 150 && right[2] < 100, `flipped: right is red, got ${right}`);
  assert.ok(bgTop[0] + bgTop[1] + bgTop[2] > 60, `blurred picture behind, not black, got ${bgTop}`);
});

test('non-square pixels are shown at their real shape', async () => {
  // 240x240 stored, shown as 9:16 (SAR 9:16), left half red and right half blue
  const anamorphic = path.join(dir, 'sar.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=120x240:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=120x240:d=2', '-filter_complex', '[0][1]hstack,setsar=9/16', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', anamorphic]);
  const info = await probe(anamorphic);
  assert.deepEqual([info.width, info.height], [134, 240]);
  const frames = await extractFrames(anamorphic, 2, fs.mkdtempSync(path.join(dir, 'f-')), { maxFrames: 1, height: 64 });
  const jpeg = Buffer.from(frames[0].src.split(',')[1], 'base64');
  // JPEG SOF0 holds height then width
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  const [h, w] = [jpeg.readUInt16BE(sof + 5), jpeg.readUInt16BE(sof + 7)];
  assert.ok(Math.abs(w / h - 9 / 16) < 0.05, `thumbnail is 9:16, got ${w}x${h}`);
  const out = path.join(dir, 'sar-out.mp4');
  await renderEdit({ input: anamorphic, output: out, ranges: [[0, 2]], hasVideo: true, hasAudio: false, duration: 2, width: info.width, height: info.height, clip: { canvas: '9:16' } });
  const left = await pixelAt(out, 1, 270, 960);
  const right = await pixelAt(out, 1, 810, 960);
  assert.ok(left[0] > 150 && right[2] > 150, `fills 9:16 without bars or stretching, got ${left} / ${right}`);
});
