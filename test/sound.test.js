// Studio Sound v2 (2.9): RNNoise with a strength, and a loudness target for the export.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const { voiceChain, buildRenderArgs, STUDIO_SOUND } = require('../src/renderer/render-plan.js');
const F = require('../src/renderer/frame.js');
const { renderEdit, probe, measureLoudness, matchLoudness, enhanceAudio, RNNOISE_MODEL } = require('../src/media.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline sound ')); // a space, like many real folders
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const make = (name, args) => { const out = path.join(dir, name); execFileSync(ffmpeg, ['-hide_banner', '-y', ...args, out], { stdio: 'ignore' }); return out; };
// Speech (the Mac's own text-to-speech, with pauses) at 44.1 kHz with hiss under it, and a picture.
// Tones would not do: RNNoise is made for speech and treats a tone as noise.
let speech = null;
function speechFile() {
  if (speech) return speech;
  const aiff = path.join(dir, 'speech.aiff');
  execFileSync('say', ['-o', aiff, 'Hello there. [[slnc 600]] This is a test of studio sound. [[slnc 600]] The hiss should go away. [[slnc 600]] Thank you.'], { stdio: 'ignore' });
  speech = aiff;
  return speech;
}
const noisy = () => make('noisy.mp4', [
  '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30',
  '-i', speechFile(),
  '-f', 'lavfi', '-i', 'anoisesrc=color=white:sample_rate=44100:amplitude=0.02',
  '-filter_complex', '[1:a]aresample=44100,apad[v];[v][2:a]amix=inputs=2:normalize=0:duration=first[a]', '-map', '0:v', '-map', '[a]', '-t', '6', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
]);

// Speech level over the level in the quietest tenth of the file (the pauses), in dB.
function contrast(file) {
  const raw = execFileSync(ffmpeg, ['-hide_banner', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const frames = [];
  for (let i = 0; i + 320 <= x.length; i += 320) { let s = 0; for (let k = i; k < i + 320; k++) s += x[k] * x[k]; frames.push(s / 320); }
  frames.sort((a, b) => a - b);
  const q = (p) => frames[Math.floor(frames.length * p)];
  return 10 * Math.log10(q(0.9) / Math.max(1e-12, q(0.1)));
}

test('the RNNoise chain runs at 48 kHz with the strength as its mix; the old chain is kept for the phone build', () => {
  const c = voiceChain({ engine: 'rnnoise', strength: 0.8, modelPath: '/m/sh.rnnn', filterPath: (p) => `'${p}'` });
  assert.match(c, /^highpass=f=75,aresample=48000,arnndn=m='\/m\/sh\.rnnn':mix=0\.80,/);
  assert.equal(voiceChain({ engine: 'nlm', strength: 1 }), STUDIO_SOUND);
  assert.equal(voiceChain({ engine: 'rnnoise', strength: 1 }), STUDIO_SOUND, 'no model: the old chain');
  assert.match(voiceChain({ engine: 'nlm', strength: 0.5 }), /anlmdn=s=3\.50/);
  const clip = F.normalize({ enhance: true, enhanceStrength: 0.3 });
  const { args } = buildRenderArgs({ input: 'a.mp4', output: 'o.mp4', ranges: [[0, 1]], hasVideo: false, hasAudio: true, duration: 2, clip, rnnoiseModel: '/m/sh.rnnn', filterPath: (p) => p });
  assert.match(args[args.indexOf('-filter_complex') + 1], /arnndn=m=\/m\/sh\.rnnn:mix=0\.30/);
});

test('clip settings: strength defaults to 80% and loudness only takes the two targets', () => {
  assert.equal(F.normalize({}).enhanceStrength, 0.8);
  assert.equal(F.normalize({ enhanceStrength: 3 }).enhanceStrength, 1);
  assert.equal(F.normalize({}).loudness, null);
  assert.equal(F.normalize({ loudness: '-14' }).loudness, -14);
  assert.equal(F.normalize({ loudness: -9 }).loudness, null);
});

test('the bundled model is there and a real export with Studio Sound uses it, from a folder with a space', async () => {
  assert.ok(fs.existsSync(RNNOISE_MODEL));
  assert.match(fs.readFileSync(RNNOISE_MODEL, 'utf8').slice(0, 40), /^rnnoise-nu model file version 1/);
  const src = noisy();
  const out = path.join(dir, 'clean.mp4');
  await renderEdit({ input: src, output: out, ranges: [[0, 6]], hasVideo: true, hasAudio: true, duration: 6, width: 160, height: 120, fps: 30, clip: F.normalize({ enhance: true }) });
  const info = await probe(out);
  assert.ok(info.hasAudio && Math.abs(info.duration - 6) < 0.1, `duration ${info.duration}`);
  // The hiss in the pauses is far quieter after cleaning, measured against the speech (the
  // chain's compressor raises the voice too).
  const before = contrast(src);
  const after = contrast(out);
  assert.ok(after > before + 10, `speech over hiss ${before.toFixed(1)} dB before, ${after.toFixed(1)} dB after`);
  // And it really went through RNNoise: the same export without the model (the old chain) differs.
  const old = path.join(dir, 'old.mp4');
  await renderEdit({ input: src, output: old, ranges: [[0, 6]], hasVideo: true, hasAudio: true, duration: 6, width: 160, height: 120, fps: 30, clip: F.normalize({ enhance: true }), rnnoiseModel: null });
  const pcm = (f) => execFileSync(ffmpeg, ['-hide_banner', '-i', f, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  const a = pcm(out);
  const b = pcm(old);
  let diff = 0;
  for (let i = 0; i < Math.min(a.length, b.length) / 2; i++) diff += Math.abs(a.readInt16LE(i * 2) - b.readInt16LE(i * 2));
  assert.ok(diff / (a.length / 2) > 50, `RNNoise and the old chain give different sound (mean difference ${(diff / (a.length / 2)).toFixed(0)})`);
  // The preview file is made the same way.
  const preview = path.join(dir, 'preview.m4a');
  await enhanceAudio(src, preview, { strength: 0.8 });
  assert.ok((await probe(preview)).hasAudio);
});

test('the loudness target lands within 0.5 LU, up or down, and leaves the picture alone', async () => {
  const src = noisy();
  for (const target of [-14, -16, -23]) {
    const file = path.join(dir, `loud${target}.mp4`);
    fs.copyFileSync(src, file);
    const { before, after } = await matchLoudness(file, target);
    assert.ok(Math.abs(after.lufs - target) <= 0.5, `target ${target}: ${before.lufs} → ${after.lufs} LUFS`);
    assert.ok(after.peak <= -0.9, `true peak ${after.peak} dBTP`);
    const info = await probe(file);
    assert.ok(info.hasVideo && Math.abs(info.duration - 6) < 0.1);
  }
  // Audio-only exports too.
  const m4a = path.join(dir, 'voice.m4a');
  execFileSync(ffmpeg, ['-hide_banner', '-y', '-i', src, '-vn', '-c:a', 'aac', m4a], { stdio: 'ignore' });
  const { after } = await matchLoudness(m4a, -14);
  assert.ok(Math.abs(after.lufs + 14) <= 0.5, `m4a: ${after.lufs}`);
  const wav = path.join(dir, 'voice.wav');
  execFileSync(ffmpeg, ['-hide_banner', '-y', '-i', src, '-vn', wav], { stdio: 'ignore' });
  assert.ok(Math.abs((await matchLoudness(wav, -16)).after.lufs + 16) <= 0.5);
  const mp3 = path.join(dir, 'voice.mp3');
  execFileSync(ffmpeg, ['-hide_banner', '-y', '-i', src, '-vn', '-ac', '2', mp3], { stdio: 'ignore' });
  assert.ok(Math.abs((await matchLoudness(mp3, -14)).after.lufs + 14) <= 0.5, 'mp3, stereo');
  assert.ok(Number.isFinite((await measureLoudness(src)).lufs));
});
