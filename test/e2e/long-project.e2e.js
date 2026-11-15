// A long transcript stays quick to edit: a cut redraws only its own paragraph, long speech
// without pauses is split into paragraphs, and the timeline builds blocks only near the view.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./helpers.js');

const TIMEOUT = { timeout: 120_000 };

test('a cut in a long transcript redraws only its paragraph, and undo puts it back', TIMEOUT, async () => {
  const dir = H.tempDir();
  // 600 s, 1500 words with no long pauses: one stretch of unbroken speech.
  const video = H.makeVideo(dir, { seconds: 600 });
  const words = Array.from({ length: 1500 }, (_, i) => ({ text: `w${i}${i % 12 === 11 ? '.' : ''}`, start: 0.2 + i * 0.4, end: 0.5 + i * 0.4 }));
  const file = H.makeProject(dir, video, { words, media: { path: video, name: 'clip.mp4', duration: 600, hasVideo: true, hasAudio: true, width: 320, height: 240 } });
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    // Split into paragraphs of at most 250 words, breaking at sentence ends where it can.
    const sizes = await page.evaluate(() => [...document.querySelectorAll('#transcript p')].map((p) => p.querySelectorAll('.w').length));
    assert.ok(sizes.length >= 6, `${sizes.length} paragraphs`);
    assert.ok(Math.max(...sizes) <= 250, `largest paragraph has ${Math.max(...sizes)} words`);
    assert.equal(sizes.reduce((a, b) => a + b, 0), 1500);

    await page.evaluate(() => { window.__far = document.querySelector('#transcript .w[data-i="10"]').closest('p'); });
    const w = page.locator('#transcript .w[data-i="1200"]');
    await w.scrollIntoViewIfNeeded();
    await w.click();
    await w.click({ modifiers: ['Shift'] });
    await page.keyboard.press('Backspace');
    await page.locator('#transcript .del[data-from="1200"][data-to="1200"]').waitFor();
    assert.equal(await page.evaluate(() => window.__far === document.querySelector('#transcript .w[data-i="10"]').closest('p')), true, 'a paragraph far from the cut is left as it was');
    assert.equal(await page.locator('#transcript .w').count(), 1499);
    await H.until(() => H.readProject(file).deleted.join() === '1200', 'the cut to be saved');

    await page.click('#btn-undo');
    await page.locator('#transcript .w[data-i="1200"]').waitFor();
    assert.equal(await page.locator('#transcript .del').count(), 0);
    assert.equal(await page.locator('#transcript .w').count(), 1500);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the timeline builds word blocks only near the view, and more as it scrolls', TIMEOUT, async () => {
  const dir = H.tempDir();
  const video = H.makeVideo(dir, { seconds: 600 });
  const words = Array.from({ length: 1500 }, (_, i) => ({ text: `w${i}`, start: 0.2 + i * 0.4, end: 0.5 + i * 0.4 }));
  H.makeProject(dir, video, { words, media: { path: video, name: 'clip.mp4', duration: 600, hasVideo: true, hasAudio: true, width: 320, height: 240 } });
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    const chips = () => page.evaluate(() => [...document.querySelectorAll('.tl-chip.word')].map((c) => Number(c.dataset.word)));
    const first = await chips();
    assert.ok(first.length > 0 && first.length < 1500, `${first.length} word blocks built`);
    assert.ok(first.includes(0));
    // Scroll to the end of the timeline: the blocks there get built.
    await page.evaluate(() => { const s = document.querySelector('.tl-scroll'); s.scrollLeft = s.scrollWidth; });
    await H.until(async () => (await chips()).includes(1499), 'the last word block');
    assert.ok(!(await chips()).includes(0), 'blocks far behind the view are gone');
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
