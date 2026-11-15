// Cancelling an export or a transcription from the progress overlay.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers.js');

const TIMEOUT = { timeout: 120_000 };

test('Cancel stops an export, leaves no file and returns to the editor', TIMEOUT, async () => {
  const dir = H.tempDir();
  // Long and large enough that the export is still running when Cancel is pressed.
  const video = H.makeVideo(dir, { seconds: 240, size: '1280x720' });
  H.makeProject(dir, video, { media: { path: video, name: 'clip.mp4', duration: 240, hasVideo: true, hasAudio: true, width: 1280, height: 720 } });
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    await page.click('#btn-export');
    await page.click('#export-go');
    await page.locator('#overlay-cancel').waitFor();
    await page.click('#overlay-cancel');
    const t0 = Date.now();
    await H.until(async () => /Export cancelled/.test(await page.locator('#toast').textContent()), 'the cancel message', 10000);
    assert.ok(Date.now() - t0 < 2000, `back in ${Date.now() - t0} ms`);
    assert.equal(fs.existsSync(path.join(dir, 'export.mp4')), false, 'no half-written file');
    assert.equal(await page.locator('#overlay').isHidden(), true);
    assert.equal(await page.evaluate(() => window.cutlineState.busy), false);
    assert.equal(await page.locator('#btn-export').isEnabled(), true);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cancel stops a transcription and keeps the video open without a transcript', TIMEOUT, async () => {
  const dir = H.tempDir();
  // Pulsed sound, so the transcriber finds speech and goes on to download a model.
  const video = H.makeVideo(dir, { tone: 'pulsed' });
  const { app, page } = await H.launch(dir);
  try {
    // Make the speech-model download hang (until cancelled) instead of fetching 1 GB.
    await app.evaluate(() => {
      globalThis.fetch = (_url, opts = {}) => new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    await page.locator('#home').waitFor();
    await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('media:open-path', p), video);
    await page.locator('#engine-dialog').waitFor();
    await page.click('#engine-dialog [data-engine="fast"]');
    await page.click('#engine-go');
    await page.locator('#overlay-cancel').waitFor();
    await page.click('#overlay-cancel');
    await H.until(async () => /Transcription cancelled/.test(await page.locator('#toast').textContent()), 'the cancel message', 10000);
    assert.ok(await page.locator('#video').getAttribute('src'), 'the video stays open');
    assert.equal(await page.locator('#overlay').isHidden(), true);
    // The model's partial download is kept for next time (here it is empty, so nothing to keep).
    assert.equal(await page.locator('#transcript .w').count(), 0);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
