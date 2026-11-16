// The Descript-style editor (2.10): selection toolbar, script gutter, scenes, ⌘K palette,
// collapsible timeline, regrouped side panel, top bar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { probe } = require('../../src/media.js');
const H = require('./helpers.js');

const TIMEOUT = { timeout: 90_000 };
const state = (page, expr) => page.evaluate(`(() => { const s = window.cutlineState; return ${expr}; })()`);
const shown = (page) => page.locator('#transcript .w:not(.cut)').allTextContents();

test('cut a sentence, add B-roll and export without the menu bar', TIMEOUT, async () => {
  const dir = H.tempDir();
  const photo = H.makeImage(dir);
  H.makeProject(dir, H.makeVideo(dir));
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    // Select "five six seven eight": the toolbar appears above the selection.
    await H.selectWords(page, 4, 7);
    const bar = page.locator('#sel-bar');
    await bar.waitFor();
    const barBox = await bar.boundingBox();
    const wordBox = await page.locator('#transcript .w[data-i="4"]').boundingBox();
    assert.ok(barBox.y + barBox.height <= wordBox.y + 2, 'above the words');
    assert.ok(await page.locator('#btn-restore').isHidden(), 'nothing cut in the selection yet');
    await bar.locator('#btn-cut').click();
    assert.deepEqual(await state(page, '[...s.deleted].sort((a, b) => a - b)'), [4, 5, 6, 7]);
    // Select "two", add B-roll there from the toolbar: Media opens; the photo goes in at that word.
    await H.selectWords(page, 1, 1);
    await page.locator('#sel-broll').click();
    await page.locator('#panel-media:not([hidden])').waitFor();
    assert.ok(Math.abs((await page.evaluate(() => document.getElementById('video').currentTime)) - 0.8) < 0.05);
    await page.evaluate((p) => window.cutlineTest.insertBroll(p), photo);
    await H.until(() => state(page, 's.tracks.length === 1'), 'the B-roll');
    await page.click('#btn-export');
    await page.click('#export-go');
    await H.until(async () => /Exported/.test(await page.locator('#toast').textContent()), 'the export', 60_000);
    const out = await probe(path.join(dir, 'export.mp4'));
    // 7 s less "five six seven eight" (4.0 s to the end).
    assert.ok(Math.abs(out.duration - 4.0) < 0.15, `exported ${out.duration} s`);
    // The stats are one line under the video.
    assert.match(await page.locator('#stats').textContent(), /^0:0\d of 0:07 · 4 cuts$/);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('script gutter, cut words shown struck through, palette, timeline collapse and the side panel', TIMEOUT, async () => {
  const dir = H.tempDir();
  const words = H.WORDS.map((w, i) => ({ ...w, speaker: i < 4 ? '0' : '1' }));
  const file = H.makeProject(dir, H.makeVideo(dir), { words, speakers: { 0: 'Asha', 1: 'Ravi' }, deleted: [1] });
  let { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    // Names in the gutter, beside the first line; each paragraph's edited start time under them.
    const label = await page.locator('#transcript p >> nth=1').locator('.speaker-label').boundingBox();
    const first = await page.locator('#transcript .w[data-i="4"]').boundingBox();
    assert.ok(label.x + label.width <= first.x, 'the name is left of the text');
    assert.deepEqual(await page.locator('#transcript .para-time').allTextContents(), ['0:00', '0:03']);
    await page.locator('#transcript .para-time >> nth=1').click();
    assert.equal(await page.evaluate(() => document.getElementById('video').currentTime), 4);

    // ⌘K: Show cut words. The cut word is struck through in the text, and restorable.
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('cut words');
    await page.keyboard.press('Enter');
    await page.locator('#transcript .w.cut[data-i="1"]').waitFor();
    await H.selectWords(page, 1, 1);
    await page.locator('#btn-restore').click();
    assert.deepEqual(await state(page, '[...s.deleted]'), []);

    // The timeline collapses to its bar from the handle, and ⌥⌘T opens it again.
    await page.locator('#tl-resize').click();
    assert.ok(await page.evaluate(() => document.body.classList.contains('tl-collapsed')));
    assert.ok(await page.locator('.tl-body').isHidden());
    await page.keyboard.press('Alt+Meta+t');
    assert.ok(!(await page.evaluate(() => document.body.classList.contains('tl-collapsed'))));

    // The side panel: Project first; it reopens on the panel last used.
    assert.deepEqual(await page.locator('.rail-btn').evaluateAll((b) => b.map((x) => x.dataset.panel)), ['project', 'properties', 'captions', 'media', 'ai']);
    await page.click('.rail-btn[data-panel="media"]');
    await page.click('#btn-toggle-sidebar');
    await page.click('#btn-toggle-sidebar');
    assert.ok(await page.locator('#panel-media').isVisible());

    // The project is renamed from its name in the top bar.
    await page.locator('#doc-title').click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('Interview');
    await page.keyboard.press('Enter');
    await H.until(() => fs.existsSync(path.join(path.dirname(file), 'Interview.talkcut')), 'the rename');
    await H.closeApp(app);

    // After a relaunch the side panel starts closed (the video gets the room); the toolbar
    // button opens it where it was.
    ({ app, page } = await H.launch(dir));
    await H.openFromHome(page);
    assert.ok(await page.locator('.sidebar').isHidden());
    await page.click('#btn-toggle-sidebar');
    assert.ok(await page.locator('#panel-media').isVisible());
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scenes: start with "/", rename, reorder in the rail, remove; saved with the project', TIMEOUT, async () => {
  const dir = H.tempDir();
  const file = H.makeProject(dir, H.makeVideo(dir));
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    // Cursor before "five", then "/".
    await page.locator('#transcript .w[data-i="4"]').click({ position: { x: 2, y: 6 } });
    await page.keyboard.press('/');
    await page.locator('#transcript .scene-head').waitFor();
    assert.ok(await page.locator('#scene-rail').isVisible());
    assert.deepEqual(await page.locator('#scene-rail .scene-name').allTextContents(), ['Opening', 'Scene 1']);
    // Rename by double-clicking the heading.
    await page.locator('#transcript .scene-title').dblclick();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('The ending');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.locator('#scene-rail .scene-name').allTextContents(), ['Opening', 'The ending']);
    // Drag "The ending" above "Opening" in the rail: its words play first.
    await page.locator('#scene-rail .scene-item >> nth=1').dragTo(page.locator('#scene-rail .scene-item >> nth=0'), { targetPosition: { x: 20, y: 4 } });
    await H.until(async () => (await shown(page)).join(' ') === 'five six seven eight one two three four', 'the scenes to swap');
    assert.deepEqual(await state(page, 's.kept'), [[4, 7], [0, 4]]);
    assert.deepEqual(await page.locator('#scene-rail .scene-name').allTextContents(), ['The ending', 'Opening']);
    const saved = await H.until(() => { const p = H.readProject(file); return p.scenes?.[0]?.title === 'The ending' && p.order ? p : null; }, 'the autosave');
    assert.deepEqual(saved.scenes, [{ id: 5, title: 'The ending' }, { id: 1, title: 'Opening' }], 'the opening part became a scene of its own');
    // Undo the move; remove the scene break with its ×.
    await page.click('#btn-undo');
    await H.until(async () => (await shown(page))[0] === 'one', 'the undo');
    await page.locator('#transcript .scene-head').hover();
    await page.locator('#transcript .scene-remove').click();
    await H.until(async () => (await page.locator('#transcript .scene-head').count()) === 0, 'the scene to go');
    assert.ok(await page.locator('#scene-rail').isHidden());
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Room for the video: on a 1440×900 window a 16:9 video gets a real preview, the side panel
// starts closed, there is no black box around the picture, and the words sit on the voice track.
test('the video gets the room on a laptop screen', TIMEOUT, async () => {
  const dir = H.tempDir();
  H.makeProject(dir, H.makeVideo(dir, { size: '1280x720' }));
  const { app, page } = await H.launch(dir);
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await H.openFromHome(page);
    await page.waitForTimeout(300);
    // The side panel is closed until you open it from the rail.
    assert.ok(await page.locator('.sidebar').isHidden(), 'side panel closed at start');
    assert.equal(await page.locator('.rail-btn.on').count(), 0);
    const pic = await page.locator('#pic').boundingBox();
    assert.ok(pic.width >= 600, `preview picture ${Math.round(pic.width)} px wide`);
    assert.ok(Math.abs(pic.width / pic.height - 16 / 9) < 0.02);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.player')).backgroundColor), 'rgba(0, 0, 0, 0)');
    // The timeline is shorter, and words are labels on the voice track, not a row of their own.
    const tl = await page.locator('.timeline-panel').boundingBox();
    assert.ok(tl.height <= 260, `timeline ${Math.round(tl.height)} px tall`);
    const heads = await page.locator('.tl-head').allTextContents();
    assert.ok(!heads.some((t) => t.trim() === 'Words'), heads.join(', '));
    const chip = await page.locator('.tl-chip.word').first().boundingBox();
    const voice = await page.locator('.tl-head:has-text("Voice")').boundingBox();
    assert.ok(chip.y >= voice.y - 1 && chip.y + chip.height <= voice.y + voice.height + 1, 'word labels on the voice track');
    // Opening a panel from the rail still works; with no history it is Project.
    await page.click('#btn-toggle-sidebar');
    await page.locator('#panel-project:not([hidden])').waitFor();
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
