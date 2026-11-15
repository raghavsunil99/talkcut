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
