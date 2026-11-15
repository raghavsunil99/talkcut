// Dialogs and panels split out of app.js: each one opens, works and closes in the real app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./helpers.js');

const TIMEOUT = { timeout: 90_000 };

const withProject = (fn, extra) => withProjectIn(H.tempDir(), extra, fn);

async function withProjectIn(dir, extra, fn) {
  const file = H.makeProject(dir, H.makeVideo(dir), extra);
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    await fn({ app, page, dir, file });
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the API keys dialog lists keys, opens the add form and closes', TIMEOUT, () => withProject(async ({ page }) => {
  await page.click('#btn-keys');
  await page.locator('#keys-dialog').waitFor();
  assert.equal(await page.locator('#keys-dialog .key-list li.empty').count(), 2, 'one empty list per service');
  await page.click('#btn-add-key');
  await page.locator('#key-add-form').waitFor();
  await page.click('#key-add-cancel');
  assert.equal(await page.locator('#key-add-form').isHidden(), true);
  await page.click('#keys-close');
  await H.until(() => page.locator('#keys-dialog').isHidden(), 'the dialog to close');
}));

test('the export dialog saves captions alone as an SRT file', TIMEOUT, () => withProject(async ({ page, dir }) => {
  await page.click('#btn-export');
  await page.click('#export-presets [data-preset="captions"]');
  assert.equal(await page.locator('#export-go').textContent(), 'Save captions…');
  await page.click('#export-go');
  const srt = require('node:path').join(dir, 'export.srt');
  await H.until(() => fs.existsSync(srt), 'the SRT file');
  const text = fs.readFileSync(srt, 'utf8');
  assert.match(text, /^1\n00:00:00,200 --> /);
  assert.match(text, /one two three four/);
}));

test('find and replace fixes every match, remembers the fix, and undoes', TIMEOUT, () => withProject(async ({ page }) => {
  const word = (i) => page.locator(`#transcript .w[data-i="${i}"]`).textContent();
  await page.click('#btn-find');
  await page.fill('#find-text', 'two');
  assert.equal(await page.locator('#find-count').textContent(), '1 match in the transcript');
  await page.fill('#find-replace', 'TOO');
  await page.check('#find-remember');
  await page.click('#find-go');
  await H.until(async () => (await word(1)) === 'TOO', 'the replacement');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('cutline.wordList'))), [['two', 'TOO']]);
  await page.click('#btn-undo');
  await H.until(async () => (await word(1)) === 'two', 'the undo');

  // Right-click a word: the menu offers Correct, Cut, Find, Speaker, Play and Copy.
  await page.locator('#transcript .w[data-i="3"]').click({ button: 'right' });
  await page.locator('#word-menu').waitFor();
  assert.equal(await page.locator('#word-menu li').count(), 6);
}));

test('the item inspector edits a B-roll photo, undoes and deletes it', TIMEOUT, async () => {
  const dir = H.tempDir();
  const photo = H.makeImage(dir);
  const tracks = [{ id: 't1', type: 'overlay', name: 'Overlay 1', items: [{ id: 'i1', kind: 'image', name: 'photo.png', path: photo, start: 1, length: 2, box: { x: 0, y: 0, w: 1, h: 1 } }] }];
  await withProjectIn(dir, { tracks }, async ({ page, file }) => {
    const item = () => H.readProject(file).tracks[0].items[0];
    await page.locator('.tl-item').first().click();
    await page.locator('#item-props').waitFor();
    assert.equal(await page.locator('#props-title').textContent(), 'B-roll');
    await page.fill('#item-fade-in', '1');
    await page.press('#item-fade-in', 'Enter');
    await H.until(() => item().fadeIn === 1, 'the fade to be saved');
    await page.click('#btn-undo');
    await H.until(() => item().fadeIn === 0, 'the undo to be saved');
    await page.locator('.tl-item').first().click();
    await page.click('#item-delete');
    await H.until(() => H.readProject(file).tracks[0].items.length === 0, 'the delete to be saved');
  });
});

test('a title added from Elements can be retyped', TIMEOUT, () => withProject(async ({ page, file }) => {
  await page.click('.rail-btn[data-panel="elements"]');
  await page.click('.text-preset[data-preset="title"]');
  await page.locator('#text-edit').waitFor();
  await page.fill('#text-content', 'Top 5 tips');
  await page.locator('#text-content').blur();
  await H.until(() => H.readProject(file).tracks?.[0]?.items?.[0]?.text === 'Top 5 tips', 'the title to be saved');
  assert.equal(H.readProject(file).tracks[0].items[0].kind, 'text');
}));

test('the video can be selected and nudged on the canvas, and cropped', TIMEOUT, () => withProject(async ({ page, file }) => {
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await H.until(() => page.evaluate(() => window.cutlineState.mainSel), 'the video to be selected');
  await page.keyboard.press('Shift+ArrowRight');
  await H.until(() => Math.abs((H.readProject(file).clip?.x ?? 0) - 0.1) < 0.01, 'the 10% nudge to be saved');

  // Selecting the video opened Properties.
  await page.click('#prop-crop-canvas');
  await H.until(() => page.evaluate(() => document.body.classList.contains('cropping')), 'crop mode');
  await page.keyboard.press('Enter');
  await H.until(async () => /Cropped/.test(await page.locator('#toast').textContent()), 'the crop to finish');
  assert.equal(await page.evaluate(() => document.body.classList.contains('cropping')), false);
}));

test('the project is renamed by editing its title', TIMEOUT, () => withProject(async ({ page, dir }) => {
  const title = page.locator('#doc-title');
  await title.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('My Reel');
  await page.keyboard.press('Enter');
  const projects = require('node:path').join(dir, 'projects');
  await H.until(() => fs.existsSync(require('node:path').join(projects, 'My Reel.talkcut')), 'the renamed file');
  assert.equal(fs.existsSync(require('node:path').join(projects, 'Demo.talkcut')), false);
  assert.equal(await title.textContent(), 'My Reel');
}));
