// Dialogs and panels split out of app.js: each one opens, works and closes in the real app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./helpers.js');

const TIMEOUT = { timeout: 90_000 };

async function withProject(fn, extra) {
  const dir = H.tempDir();
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
