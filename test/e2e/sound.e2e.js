// Studio Sound v2 (2.9) in the real app: strength and loudness target in Properties, and the
// export coming out at the target loudness.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { measureLoudness } = require('../../src/media.js');
const H = require('./helpers.js');

const TIMEOUT = { timeout: 90_000 };
const clip = (page) => page.evaluate(() => window.cutlineState.clip);

test('Studio Sound strength and a -14 LUFS target reach the project and the export', TIMEOUT, async () => {
  const dir = H.tempDir();
  const file = H.makeProject(dir, H.makeVideo(dir, { tone: 'pulsed' }));
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    if (!(await page.locator('#prop-enhance').isVisible())) await page.click('.rail-btn[data-panel="properties"]');
    assert.deepEqual([(await clip(page)).enhanceEngine, (await clip(page)).enhanceStrength], ['rnnoise', 0.8]);
    await page.locator('#prop-enhance').check();
    // Both are offered: Classic goes back to its full strength, AI to 80%.
    await page.locator('#prop-engine button[data-value="classic"]').click();
    assert.deepEqual([(await clip(page)).enhanceEngine, (await clip(page)).enhanceStrength], ['classic', 1]);
    await page.locator('#prop-engine button[data-value="rnnoise"]').click();
    assert.deepEqual([(await clip(page)).enhanceEngine, (await clip(page)).enhanceStrength], ['rnnoise', 0.8]);
    await page.locator('#prop-strength-num').fill('60');
    await page.locator('#prop-strength-num').press('Enter');
    // Loudness is a project setting, in the Project panel.
    await page.click('.rail-btn[data-panel="project"]');
    await page.locator('#prop-loudness').selectOption('-14');
    const c = await clip(page);
    assert.deepEqual([c.enhance, c.enhanceEngine, c.enhanceStrength, c.loudness], [true, 'rnnoise', 0.6, -14]);
    await H.until(() => H.readProject(file).clip?.loudness === -14, 'the autosave');

    await page.click('#btn-export');
    await page.click('#export-go');
    await H.until(async () => /Exported/.test(await page.locator('#toast').textContent()), 'the export to finish', 60_000);
    const { lufs, peak } = await measureLoudness(path.join(dir, 'export.mp4'));
    assert.ok(Math.abs(lufs + 14) <= 1, `exported at ${lufs} LUFS`);
    assert.ok(peak <= -0.9, `true peak ${peak} dBTP`);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
