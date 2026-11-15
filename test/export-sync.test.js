// The export keeps picture, sound and captions in step however many cuts there are, keeps the
// source frame rate, and does not click at cuts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const { probe, pixelAt, renderEdit } = require('../src/media.js');
const E = require('../src/renderer/edits.js');
const F = require('../src/renderer/frame.js');
const { GROUP } = require('../src/renderer/render-plan.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-sync-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const make = (name, args) => { const out = path.join(dir, name); execFileSync(ffmpeg, ['-hide_banner', '-y', ...args, out], { stdio: 'ignore' }); return out; };

test('snapRanges moves range edges to whole frames, drops slivers and joins touching ranges', () => {
  assert.deepEqual(E.snapRanges([[0, 1.01], [2.02, 2.03], [3.049, 4]], 10), [[0, 1], [3, 4]]);
  assert.deepEqual(E.snapRanges([[0, 0.96], [1.04, 2]], 10), [[0, 2]]);
  assert.deepEqual(E.snapRanges([[0.2, 1]], 0), [[0.2, 1]], 'no frame rate: left alone');
  const snapped = E.snapRanges([[0.123, 4.567]], 30);
  assert.deepEqual(E.snapRanges(snapped, 30), snapped, 'snapping twice changes nothing');
});

test('frameRate keeps the source rate up to 60 and the NTSC rates exact', () => {
  assert.deepEqual(F.frameRate(25), { value: 25, text: '25' });
  assert.equal(F.frameRate(29.97).text, '30000/1001');
  assert.equal(F.frameRate(23.98).text, '24000/1001');
  assert.equal(F.frameRate(59.94).text, '60000/1001');
  assert.equal(F.frameRate(30).text, '30');
  assert.equal(F.frameRate(120).value, 60);
  assert.equal(F.frameRate(null).value, 30);
  assert.equal(F.frameRate(0).value, 30);
});

test('a 25 fps video is exported at 25 fps', async () => {
  const src = make('pal.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '3', '-pix_fmt', 'yuv420p']);
  const info = await probe(src);
  assert.equal(info.fps, 25);
  const out = path.join(dir, 'pal-out.mp4');
  await renderEdit({ input: src, output: out, ranges: [[0, 1], [1.5, 2.5]], hasVideo: true, hasAudio: true, duration: 3, width: 160, height: 120, fps: info.fps });
  const result = await probe(out);
  assert.equal(result.fps, 25);
  assert.ok(Math.abs(result.duration - 2) < 0.06, `duration ${result.duration}`);
});

test('after 80 cuts the picture is still exactly where the edited timeline says', async () => {
  // A white frame flashes at every whole second (three frames long) on black.
  const src = make('flash.mp4', [
    '-f', 'lavfi', '-i', "color=c=black:s=160x120:r=30,drawbox=color=white:t=fill:enable='lt(mod(t\\,1)\\,0.1)'",
    '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '41', '-pix_fmt', 'yuv420p', '-g', '15',
  ]);
  // 80 short pieces with uneven edges; every other one holds a flash.
  const ranges = [];
  for (let i = 0; i < 80; i++) {
    const start = Math.max(0, i * 0.5 - 0.1 + (i % 7) * 0.01);
    ranges.push([start, start + 0.3]);
  }
  assert.ok(ranges.length > GROUP * 2, 'spans several groups');
  const out = path.join(dir, 'flash-out.mp4');
  await renderEdit({ input: src, output: out, ranges, hasVideo: true, hasAudio: true, duration: 41, width: 160, height: 120, fps: 30 });

  const snapped = E.snapRanges(ranges, 30);
  const total = E.totalLength(snapped);
  const result = await probe(out);
  assert.ok(Math.abs(result.duration - total) < 0.06, `exported ${result.duration} s, timeline says ${total} s`);
  // The flashes at 10 s, 24 s and 38 s (pieces 20, 48 and 76): white on the frame the timeline
  // gives, black on the frame before it.
  const bright = async (t) => (await pixelAt(out, t, 80, 60))[0];
  for (const second of [10, 24, 38]) {
    const e = E.toEdited(snapped, second);
    assert.ok(await bright(e + 0.001) > 200, `flash of ${second} s is showing just after ${e.toFixed(3)} s`);
    assert.ok(await bright(e - 1 / 30 - 0.001) < 60, `the frame before ${e.toFixed(3)} s is still black`);
  }
});

test('cuts in the middle of a sound do not click', async () => {
  const src = make('tone.wav', ['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000', '-t', '6']);
  const out = path.join(dir, 'tone-out.wav');
  // Each cut ends on a peak of the wave and resumes on a trough: the worst case for a click.
  const q = 1 / 1200; // a quarter of a 300 Hz cycle
  await renderEdit({ input: src, output: out, ranges: [[0.5, 1 + q], [2 + 3 * q, 3 + q], [4 + 3 * q, 5]], hasVideo: false, hasAudio: true, duration: 6 });
  const pcm = execFileSync(ffmpeg, ['-hide_banner', '-i', out, '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  let peak = 0;
  let jump = 0;
  for (let i = 1; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
    jump = Math.max(jump, Math.abs(samples[i] - samples[i - 1]));
  }
  // A clean 300 Hz wave moves 4% of its height per sample; a hard cut here would jump 200%.
  assert.ok(jump < peak * 0.1, `largest step between samples is ${(100 * jump / peak).toFixed(1)}% of the peak`);
});
