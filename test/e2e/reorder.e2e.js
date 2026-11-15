// Moving words in the real app: cut and paste, drag, playback order, export, save and reopen,
// and opening a project saved by an older version.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { probe } = require('../../src/media.js');
const H = require('./helpers.js');

const TIMEOUT = { timeout: 90_000 };
const shown = (page) => page.locator('#transcript .w').allTextContents();
const state = (page, expr) => page.evaluate(`(() => { const s = window.cutlineState; return ${expr}; })()`);
// Click the left half of a word: the text cursor goes before it.
const clickBefore = (page, i) => page.locator(`#transcript .w[data-i="${i}"]`).click({ position: { x: 2, y: 6 } });

test('a version 2 project opens, is upgraded, and the old file is kept beside it', TIMEOUT, async () => {
  const dir = H.tempDir();
  const file = H.makeProject(dir, H.makeVideo(dir), { deleted: [1] });
  const before = fs.readFileSync(file, 'utf8');
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    await page.locator('#transcript .del[data-from="1"][data-to="1"]').waitFor();
    assert.equal(fs.readFileSync(`${file}.v2.bak`, 'utf8'), before);
    const saved = H.readProject(file);
    assert.equal(saved.version, 3);
    assert.deepEqual(saved.words.map((w) => w.id), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(saved.deleted, [1]);
    assert.equal(saved.order, null);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cut a sentence, paste it at the start: transcript, preview, captions, export and reopen agree', TIMEOUT, async () => {
  const dir = H.tempDir();
  const file = H.makeProject(dir, H.makeVideo(dir));
  let { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    if (!(await page.locator('#cap-enabled').isVisible())) await page.click('.rail-btn[data-panel="captions"]');
    await page.locator('#cap-enabled').check();

    // ⌘X on "five six seven eight", cursor before "one", ⌘V.
    await H.selectWords(page, 4, 7);
    await page.keyboard.press('ControlOrMeta+x');
    await page.locator('#transcript .del[data-from="4"][data-to="7"]').waitFor();
    await clickBefore(page, 0);
    await page.keyboard.press('ControlOrMeta+v');
    await H.until(async () => (await shown(page)).join(' ') === 'five six seven eight one two three four', 'the words to move');
    assert.deepEqual(await state(page, 's.order'), [[4, 7], [0, 4]]);
    assert.deepEqual(await state(page, 's.kept'), [[4, 7], [0, 4]]);
    assert.deepEqual(await state(page, '[...s.deleted]'), [], 'the pasted words are back');
    assert.deepEqual(await state(page, 's.words.map((w) => w.id)'), [5, 6, 7, 8, 1, 2, 3, 4]);
    // Captions follow: the first one is the moved sentence.
    assert.deepEqual(await state(page, 's.captionSpans[0].words'), [0, 1, 2, 3]);

    // Preview: from the top, the recording plays 4 → 7 s, jumps back to 0 and stops at 4 s.
    await clickBefore(page, 0);
    await H.until(async () => Math.abs(await page.evaluate(() => document.getElementById('video').currentTime) - 4) < 0.05, 'the seek to the first word');
    assert.equal(await page.locator('#time-current').textContent(), '0:00.0');
    await page.evaluate(() => {
      window.samples = [];
      const v = document.getElementById('video');
      window.sampler = setInterval(() => window.samples.push(v.currentTime), 40);
    });
    await page.click('#btn-play');
    await H.until(() => page.evaluate(() => document.getElementById('video').paused && window.samples.length > 50), 'playback to reach the end', 30_000);
    const samples = await page.evaluate(() => { clearInterval(window.sampler); return window.samples; });
    const firstLow = samples.findIndex((t) => t < 3.5);
    assert.ok(firstLow > 10, 'it plays the moved piece first');
    assert.ok(samples.slice(0, firstLow).every((t) => t >= 3.9), 'nothing from before 4 s while the moved piece plays');
    assert.ok(samples.slice(firstLow).every((t) => t < 4.05), 'then only the first half of the recording');
    assert.ok(Math.max(...samples.slice(0, firstLow)) > 6.8, 'the moved piece plays to its end');
    const end = await page.evaluate(() => document.getElementById('video').currentTime);
    assert.ok(Math.abs(end - 3.99) < 0.05, `stops at the end of the edit (${end})`);
    assert.equal(await page.locator('#time-current').textContent(), '0:06.9');

    // Autosave, then export: the whole 7 s, nothing lost or doubled.
    const saved = await H.until(() => { const p = H.readProject(file); return p.order ? p : null; }, 'the autosave');
    assert.deepEqual(saved.order, [[4, 7], [0, 4]]);
    assert.equal(saved.words.map((w) => w.text).join(' '), 'five six seven eight one two three four');
    await page.click('#btn-export');
    await page.click('#export-go');
    await H.until(async () => /Exported/.test(await page.locator('#toast').textContent()), 'the export to finish', 60_000);
    const out = await probe(path.join(dir, 'export.mp4'));
    assert.ok(Math.abs(out.duration - 7) < 0.15, `exported ${out.duration} s, expected 7 s`);

    // Undo puts the sentence back; redo moves it again.
    await page.click('#btn-undo');
    await H.until(async () => (await shown(page)).length === 4, 'the undo of the paste');
    await page.click('#btn-undo');
    await H.until(async () => (await shown(page)).join(' ') === 'one two three four five six seven eight', 'the undo of the cut');
    assert.equal(await state(page, 's.order'), null);
    await page.click('#btn-redo');
    await page.click('#btn-redo');
    await H.until(async () => (await shown(page)).join(' ') === 'five six seven eight one two three four', 'the redo');
    await H.until(() => H.readProject(file).order, 'the autosave after redo');
    await H.closeApp(app);

    // Reopen: the same order.
    ({ app, page } = await H.launch(dir));
    await H.openFromHome(page);
    assert.equal((await shown(page)).join(' '), 'five six seven eight one two three four');
    assert.deepEqual(await state(page, 's.kept'), [[4, 7], [0, 4]]);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('drag selected words to a new place; a click on the selection still just places the cursor', TIMEOUT, async () => {
  const dir = H.tempDir();
  H.makeProject(dir, H.makeVideo(dir));
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    await H.selectWords(page, 1, 2);
    const from = await page.locator('#transcript .w[data-i="1"]').boundingBox();
    const to = await page.locator('#transcript .w[data-i="7"]').boundingBox();
    await page.mouse.move(from.x + 4, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 30, from.y + from.height / 2, { steps: 3 });
    await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 5 });
    await page.locator('#transcript .w.drop-after[data-i="7"]').waitFor();
    await page.mouse.up();
    await H.until(async () => (await shown(page)).join(' ') === 'one four five six seven eight two three', 'the drag to move the words');
    assert.deepEqual(await state(page, 's.order'), [[0, 0.8], [2, 7], [0.8, 2]]);
    assert.deepEqual(await state(page, '[s.anchor, s.focus]'), [6, 7], 'the moved words stay selected');

    // Cutting a moved word cuts its own stretch of the recording.
    await page.keyboard.press('Backspace');
    assert.deepEqual(await state(page, 's.kept'), [[0, 0.8], [2, 7]]);
    await page.click('#btn-undo');

    // A plain click on the selection: no move, the cursor goes there.
    await H.selectWords(page, 6, 7);
    await page.locator('#transcript .w[data-i="6"]').click({ position: { x: 2, y: 6 } });
    assert.deepEqual(await state(page, '[s.anchor, s.caret]'), [-1, 6]);
    assert.equal((await shown(page)).join(' '), 'one four five six seven eight two three');

    // Correcting text across the join is refused; within one piece it works.
    await H.selectWords(page, 5, 6);
    await page.keyboard.press('Enter');
    assert.match(await page.locator('#toast').textContent(), /moved/);
    await page.locator('#transcript .w[data-i="6"]').dblclick();
    await page.keyboard.type('TWO');
    await page.keyboard.press('Enter');
    await H.until(async () => (await shown(page)).join(' ') === 'one four five six seven eight TWO three', 'the correction');
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
