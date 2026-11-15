// Editor benchmark on a long project: how long opening, a single-word cut and undo take, and how
// smoothly playback runs.   node scripts/bench-editor.js [minutes=60]
// A test-pattern video with about 2.5 words a second, captions on and 20 photos on tracks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../test/e2e/helpers.js');

const minutes = Number(process.argv[2] ?? 60);
const seconds = minutes * 60;

(async () => {
  const cache = path.join(os.tmpdir(), 'talkcut-bench');
  fs.mkdirSync(cache, { recursive: true });
  const videoName = `editor-${minutes}m.mp4`;
  if (!fs.existsSync(path.join(cache, videoName))) {
    console.log(`Making a ${minutes}-minute video…`);
    H.makeVideo(cache, { name: videoName, seconds });
  }
  const video = path.join(cache, videoName);
  const photo = H.makeImage(cache, 'bench-photo.png');

  const words = [];
  for (let t = 0.2, i = 0; t < seconds - 1; t += 0.4, i++) {
    words.push({ text: `${['so', 'this', 'video', 'is', 'about', 'jobs', 'and', 'money', 'for', 'everyone', 'here', 'today'][i % 12]}${i % 12 === 11 ? '.' : ''}`, start: t, end: t + 0.3 });
  }
  const tracks = [{
    id: 't1', type: 'overlay', name: 'Overlay 1',
    items: Array.from({ length: 20 }, (_, k) => ({ id: `p${k}`, kind: 'image', name: 'photo.png', path: photo, start: (k + 1) * (seconds / 21), length: 3, box: { x: 0.6, y: 0.05, w: 0.35, h: 0.3 } })),
  }];
  const dir = H.tempDir();
  const file = H.makeProject(dir, video, {
    media: { path: video, name: videoName, duration: seconds, hasVideo: true, hasAudio: true, width: 320, height: 240 },
    words, tracks, captions: { enabled: true, preset: 'highlight' },
  });
  console.log(`${words.length} words, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB project file`);

  const { app, page } = await H.launch(dir);
  try {
    const t0 = Date.now();
    await H.openFromHome(page);
    console.log(`open project: ${Date.now() - t0} ms`);

    // In-page timing: from the key press to the next painted frame.
    const timeKey = (key, opts = {}) => page.evaluate(([k, o]) => new Promise((resolve) => {
      const t = performance.now();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t)));
    }), [key, opts]);
    const cuts = [];
    const undos = [];
    // Clicking a button, timed the same way.
    const timeClick = (sel) => page.evaluate((q) => new Promise((resolve) => {
      const t = performance.now();
      document.querySelector(q).click();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t)));
    }), sel);
    // Selecting a word with a click.
    const selects = [];
    for (const i of [100, 2000, 4500, 7000, 8800, 300, 5000, 6000]) {
      const w = page.locator(`#transcript .w[data-i="${i}"]`);
      await w.scrollIntoViewIfNeeded();
      await w.click();
      selects.push(await page.evaluate((idx) => new Promise((resolve) => {
        const el = document.querySelector(`#transcript .w[data-i="${idx}"]`);
        const r = el.getBoundingClientRect();
        const t = performance.now();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 1, clientY: r.top + 2, shiftKey: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t)));
      }), i));
      cuts.push(await timeKey('Backspace'));
      undos.push(await timeClick('#btn-undo'));
    }
    const stats = (a) => `median ${a.slice().sort((x, y) => x - y)[a.length >> 1].toFixed(0)} ms, worst ${Math.max(...a).toFixed(0)} ms`;
    console.log(`select a word (Shift-click): ${stats(selects)}`);
    console.log(`single-word cut: ${stats(cuts)}`);
    console.log(`undo: ${stats(undos)}`);

    // Playback across a stretch with B-roll and captions.
    await page.evaluate((t) => { document.getElementById('video').currentTime = t; }, seconds / 21 - 1);
    await page.click('#btn-play');
    const frames = await page.evaluate(() => new Promise((resolve) => {
      const times = [];
      const end = performance.now() + 4000;
      const tick = (t) => { times.push(t); if (t < end) requestAnimationFrame(tick); else resolve(times); };
      requestAnimationFrame(tick);
    }));
    await page.click('#btn-play');
    const gaps = frames.slice(1).map((t, i) => t - frames[i]);
    const fps = (frames.length - 1) / ((frames.at(-1) - frames[0]) / 1000);
    console.log(`playback: ${fps.toFixed(1)} fps, slowest frame ${Math.max(...gaps).toFixed(0)} ms, frames over 20 ms: ${gaps.filter((g) => g > 20).length} of ${gaps.length}`);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
