// Review before cutting (2.5) in the real app, on a Telugu project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./helpers.js');

const TIMEOUT = { timeout: 90_000 };
const state = (page, expr) => page.evaluate(`(() => { const s = window.cutlineState; return ${expr}; })()`);
const rows = (page) => page.locator('#review-list .review-row .review-text b').allTextContents();

test('Telugu fillers and wordless sounds: listed with previews, an unticked one is kept, one undo restores all', TIMEOUT, async () => {
  const dir = H.tempDir();
  // A tone that is on for 0.6 s of every second, like speech. Words sit on some of the bursts;
  // the bursts at 4 s and 6 s have no word: sounds the transcriber left out.
  const video = H.makeVideo(dir, { tone: 'pulsed' });
  const words = [['నేను', 0], ['ఊ', 1], ['అంటే', 2], ['రేపు', 3], ['వస్తాను', 5]].map(([text, start]) => ({ text, start, end: start + 0.6 }));
  const file = H.makeProject(dir, video, { words, language: 'te' });
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    // The transcript marks ఊ as a filler; అంటే is a real word too, so it is not marked.
    await page.locator('#transcript .w.filler[data-i="1"]').waitFor();
    assert.equal(await page.locator('#transcript .w.filler').count(), 1);
    await H.until(() => page.evaluate(() => window.cutlineTest.waveformReady()), 'the waveform');

    await page.click('.rail-btn[data-panel="ai"]');
    await page.click('#btn-fillers');
    await page.locator('#review-dialog:not([hidden])').waitFor();
    assert.deepEqual(await rows(page), ['ఊ']);

    // Opt in to అంటే, and add the sounds with no word.
    await page.locator('#review-filler-words .chip[data-word="అంటే"]').click();
    await page.locator('#review-kinds button[data-kind="sound"]').click();
    assert.deepEqual(await rows(page), ['ఊ', 'అంటే', '(sound, no word)', '(sound, no word)']);
    assert.equal(await page.locator('#review-list .review-play').count(), 4, 'each row can be played');
    assert.equal(await page.locator('#transcript .w.filler').count(), 2, 'the transcript marks the chosen words too');

    // Play the first row: from 0.6 s before ఊ to 0.6 s after, then it stops.
    await page.locator('#review-list .review-row').nth(0).locator('.review-play').click();
    await H.until(() => page.evaluate(() => { const v = document.getElementById('video'); return !v.paused && v.currentTime > 0.4 && v.currentTime < 2.2; }), 'the preview to play');
    await H.until(() => page.evaluate(() => document.getElementById('video').paused), 'the preview to stop', 10_000);
    const stopped = await page.evaluate(() => document.getElementById('video').currentTime);
    assert.ok(stopped >= 2.15 && stopped < 2.4, `stopped at ${stopped}`);
    // Keys in the dialog do not reach the editor (Backspace would cut, Space would play).
    await page.locator('#review-list .review-row').nth(1).locator('input').focus();
    await page.keyboard.press('Backspace');
    assert.deepEqual(await state(page, '[...s.deleted]'), []);

    // Keep అంటే; cut the rest in one go.
    await page.locator('#review-list .review-row').nth(1).locator('input').uncheck();
    assert.match(await page.locator('#review-summary').textContent(), /3 of 4 selected/);
    await page.click('#review-apply');
    await page.locator('#review-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await state(page, '[...s.deleted]'), [1]);
    const cuts = await state(page, 's.rangeCuts');
    assert.equal(cuts.length, 2);
    assert.ok(cuts[0][0] > 3.6 && cuts[0][0] < 4.1 && cuts[0][1] > 4.55 && cuts[0][1] < 4.75, JSON.stringify(cuts));
    assert.ok(cuts[1][0] > 5.6 && cuts[1][0] < 6.1 && cuts[1][1] > 6.55, JSON.stringify(cuts));
    await H.until(() => H.readProject(file).deleted?.join() === '1', 'the autosave');

    // One undo brings back everything the review cut.
    await page.click('#btn-undo');
    assert.deepEqual(await state(page, '[...s.deleted]'), []);
    assert.deepEqual(await state(page, 's.rangeCuts'), []);

    // Pauses: the kept silence is a project setting, saved with it.
    await page.click('#btn-pauses');
    await page.locator('#review-min').fill('1');
    assert.deepEqual(await rows(page), ['pause 1.4 s', 'pause 1.4 s'], 'after రేపు, and the end');
    await page.locator('#review-keep').fill('0.3');
    await page.click('#review-apply');
    assert.equal(await state(page, 's.gapKeep'), 0.3);
    assert.equal(await state(page, 's.cutGaps.size'), 2);
    await H.until(() => H.readProject(file).gapKeep === 0.3, 'the kept silence to be saved');
    await page.click('#btn-undo');
    assert.equal(await state(page, 's.gapKeep'), 0.2);
    assert.equal(await state(page, 's.cutGaps.size'), 0);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
