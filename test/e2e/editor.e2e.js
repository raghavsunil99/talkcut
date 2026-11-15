// Drives the real app: open a project, edit it, export, close and reopen.
// Run with `npm run test:e2e` (needs the Electron binary that `npm ci` installs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { probe } = require('../../src/media.js');
const H = require('./helpers.js');

const TIMEOUT = { timeout: 90_000 };

// Close the editor window the way the user does (the red button), and wait until it is gone.
async function closeWindow(app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await H.until(() => app.windows().length === 0, 'the window to close');
}

test('cut, undo, redo, shorten a pause, turn on captions and export', TIMEOUT, async () => {
  const dir = H.tempDir();
  const file = H.makeProject(dir, H.makeVideo(dir));
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);

    // Cut "two three": 0.8 s up to where "four" starts at 2.0 s.
    await H.selectWords(page, 1, 2);
    await page.keyboard.press('Backspace');
    await page.locator('#transcript .del[data-from="1"][data-to="2"]').waitFor();
    await page.click('#btn-undo');
    await page.locator('#transcript .w[data-i="1"]').waitFor();
    await page.click('#btn-redo');
    await page.locator('#transcript .del[data-from="1"][data-to="2"]').waitFor();

    // The 1.6 s pause after "four" shrinks to 0.2 s.
    await page.click('.rail-btn[data-panel="ai"]');
    await page.click('#btn-pauses');
    await page.click('#review-apply');

    await page.click('.rail-btn[data-panel="captions"]');
    await page.locator('#cap-enabled').check();

    // Autosave writes all of it to the project file.
    const saved = await H.until(() => {
      const p = H.readProject(file);
      return p.captions?.enabled && p.cutGaps?.length ? p : null;
    }, 'the autosave');
    assert.deepEqual(saved.deleted, [1, 2]);
    assert.deepEqual(saved.cutGaps, [3]);

    await page.click('#btn-export');
    await page.click('#export-go');
    await H.until(async () => /Exported/.test(await page.locator('#toast').textContent()), 'the export to finish', 60_000);

    // 7 s, minus 1.2 s of cut words, minus 1.4 s of the shortened pause.
    const out = await probe(path.join(dir, 'export.mp4'));
    assert.ok(out.hasVideo && out.hasAudio);
    assert.ok(Math.abs(out.duration - 4.4) < 0.15, `exported ${out.duration} s, expected about 4.4 s`);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('closing right after an edit saves it, and reopening shows the same edit', TIMEOUT, async () => {
  const dir = H.tempDir();
  const file = H.makeProject(dir, H.makeVideo(dir));
  let { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    await H.selectWords(page, 5, 5);
    await page.keyboard.press('Backspace');
    await page.locator('#transcript .del[data-from="5"]').waitFor();
    // Close at once, well inside the 1.5 s autosave delay.
    await closeWindow(app);
    const saved = H.readProject(file);
    assert.deepEqual(saved.deleted, [5]);
    await H.closeApp(app);

    ({ app, page } = await H.launch(dir));
    await H.openFromHome(page);
    await page.locator('#transcript .del[data-from="5"][data-to="5"]').waitFor();
    assert.equal(await page.locator('#transcript .w').count(), 7);
    // Opening alone does not rewrite the project.
    const { savedAt: _a, ...before } = saved;
    const { savedAt: _b, ...after } = H.readProject(file);
    assert.deepEqual(after, before);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('speaker names come back on reopen, and removing them can be undone', TIMEOUT, async () => {
  const dir = H.tempDir();
  const words = H.WORDS.map((w, i) => ({ ...w, speaker: i < 4 ? 's1' : 's2' }));
  H.makeProject(dir, H.makeVideo(dir), { words, speakers: { s1: 'Raghav', s2: 'Guest' } });
  const { app, page } = await H.launch(dir);
  const labels = () => page.locator('#transcript .speaker-label').allTextContents();
  try {
    await H.openFromHome(page);
    assert.deepEqual(await labels(), ['Raghav', 'Guest']);
    await page.locator('#transcript .speaker-label').first().click();
    await page.locator('#speaker-menu li', { hasText: 'Remove all speaker labels' }).click();
    await H.until(async () => (await labels()).length === 0, 'the labels to go');
    await page.click('#btn-undo');
    await H.until(async () => (await labels()).join('|') === 'Raghav|Guest', 'the labels to come back');
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed transcription keeps the video open without a transcript', TIMEOUT, async () => {
  const dir = H.tempDir();
  // A silent soundtrack: the transcriber finds no speech, before any model is needed.
  const video = H.makeVideo(dir, { tone: false });
  const { app, page } = await H.launch(dir);
  try {
    // What dropping the file on the window (or the Dock icon) does.
    await page.locator('#home').waitFor();
    await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('media:open-path', p), video);
    await page.locator('#engine-dialog').waitFor();
    await page.click('#engine-dialog [data-engine="fast"]');
    await page.click('#engine-go');
    await H.until(async () => /Transcription failed/.test(await page.locator('#toast').textContent()), 'the failure message');
    assert.ok(await page.locator('#video').getAttribute('src'), 'the video stays loaded');
    assert.equal(await page.locator('#home').isHidden(), true);
    const projects = fs.readdirSync(path.join(dir, 'projects')).filter((f) => f.endsWith('.talkcut'));
    assert.equal(projects.length, 1, 'a project file is created');
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a B-roll file that was moved can be located when the project opens', TIMEOUT, async () => {
  const dir = H.tempDir();
  const moved = H.makeImage(dir, 'found-again.png');
  const tracks = [{
    id: 't1', type: 'overlay', name: 'Overlay 1',
    items: [{ id: 'i1', kind: 'image', name: 'photo.png', path: path.join(dir, 'gone', 'photo.png'), start: 1, length: 2, box: { x: 0, y: 0, w: 1, h: 1 } }],
  }];
  const file = H.makeProject(dir, H.makeVideo(dir), { tracks });
  const { app, page } = await H.launch(dir);
  try {
    // Answer the two native dialogs: "Locate…", then pick the file.
    await app.evaluate(({ dialog }, picked) => {
      dialog.showMessageBox = async () => ({ response: 0 });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
    }, moved);
    await H.openFromHome(page);
    assert.equal(H.readProject(file).tracks[0].items[0].path, moved);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file passed on the command line opens (npm start -- clip.mp4)', TIMEOUT, async () => {
  const dir = H.tempDir();
  const video = H.makeVideo(dir);
  const { app, page } = await H.launch(dir, { args: [video] });
  try {
    await page.locator('#engine-dialog').waitFor();
    assert.equal(await page.locator('#engine-file').textContent(), 'clip.mp4');
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('playback skips a cut and the caption preview follows the speech', TIMEOUT, async () => {
  const dir = H.tempDir();
  H.makeProject(dir, H.makeVideo(dir), { deleted: [1, 2], captions: { enabled: true, preset: 'oneword' } });
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    // Start on "one" (0.2 s). "two three" (0.8 s to 2.0 s) are cut, so playback jumps to "four".
    await page.locator('#transcript .w[data-i="0"]').click();
    // Sample the playhead every frame for 2 s while playing.
    const samples = page.evaluate(() => new Promise((resolve) => {
      const v = document.getElementById('video');
      const seen = [];
      const end = performance.now() + 2000;
      const tick = () => { seen.push(v.currentTime); if (performance.now() < end) requestAnimationFrame(tick); else resolve(seen); };
      requestAnimationFrame(tick);
    }));
    await page.click('#btn-play');
    const seen = await samples;
    assert.ok(Math.max(...seen) > 2.05, `playback reached ${Math.max(...seen)} s`);
    const inside = seen.filter((t) => t > 0.95 && t < 1.95);
    assert.deepEqual(inside, [], 'the playhead never shows the cut stretch');
    const caption = await H.until(async () => {
      const t = await page.locator('#caption-layer:not([hidden]) .caption-line').textContent().catch(() => '');
      return t.trim() ? t.trim() : null;
    }, 'a caption');
    assert.ok(!/TWO|THREE/.test(caption), `cut words must not be captioned, got ${caption}`);
    await page.click('#btn-play');
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
