// Caption styles v2 in the real app: a custom style looks the same in the preview and the
// export, animations reach the preview, and saved styles are there in every project.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const C = require('../../src/renderer/captions.js');
const { prepareFontsDir } = require('../../src/media.js');
const H = require('./helpers.js');

const TIMEOUT = { timeout: 90_000 };
const W = 360;
const HGT = 640;

// RGB pixels of an image file (PNG or anything ffmpeg reads) at W x HGT.
function rgb(file) {
  return execFileSync(ffmpeg, ['-hide_banner', '-i', file, '-vf', `scale=${W}:${HGT}:flags=neighbor,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
}

// What the caption looks like: ink width and how many pixels are near each colour.
function measure(raw, colours) {
  let x0 = W;
  let x1 = 0;
  const counts = Object.fromEntries(Object.keys(colours).map((k) => [k, 0]));
  for (let i = 0; i < W * HGT; i++) {
    const [r, g, b] = [raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]];
    if (r + g + b < 90) continue;
    const x = i % W;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    for (const [k, [cr, cg, cb]] of Object.entries(colours)) if (Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb) < 90) counts[k]++;
  }
  return { width: x1 - x0, ...counts };
}

const CASES = [
  // The outline's area counts edge pixels near pure magenta; where the line sits within a pixel
  // (it moved when line spacing began to follow libass in 3.1) shifts that count by about 20%
  // while the width stays within 4%, so the outline area is compared more loosely.
  { name: 'outline', style: { text: '#00FF66', outline: '#FF00FF', outlineW: 0.09, weight: 800 }, colours: { fill: [0, 255, 102], outline: [255, 0, 255] }, loose: { outline: 0.3 } },
  { name: 'box', style: { text: '#FFEE00', box: '#2040C0', weight: 400 }, colours: { fill: [255, 238, 0], box: [26, 47, 140] } },
  // Karaoke, fully filled: the highlight colour fills the letters and the outline stays round them.
  // libass blends a karaoke fill into the outline differently at the letter edges, so fewer edge
  // pixels count as pure outline colour (the outline geometry is the same as in the case above:
  // 1168 px there against 935 here, from the same font and thickness); the fill is compared tightly.
  { name: 'karaoke', style: { text: '#FFFFFF', hi: '#00FF66', outline: '#FF00FF', outlineW: 0.09, weight: 800, animation: 'karaoke' }, colours: { fill: [0, 255, 102], outline: [255, 0, 255] }, filled: true, loose: { outline: 0.4 } },
];

test('a custom style looks the same in the preview and the export (golden frame)', TIMEOUT, async () => {
  const dir = H.tempDir();
  H.makeProject(dir, H.makeVideo(dir));
  // Screenshots come back in the display's colour space (Display P3 on most Macs); sRGB makes
  // the preview's pixels comparable with the export's.
  const { app, page } = await H.launch(dir, { args: ['--force-color-profile=srgb'] });
  try {
    await H.openFromHome(page);
    const fonts = await prepareFontsDir(path.join(dir, 'fonts'));
    const words = 'Talkcut captions match'.split(' ').map((t, i) => ({ text: t, start: i * 0.1, end: i * 0.1 + 0.1 }));
    for (const c of CASES) {
      const settings = { enabled: true, preset: 'subtitle', position: 'middle', style: c.style };
      const ass = C.buildAss({ words, deleted: new Set(), settings, language: 'en', width: W, height: HGT, toEdited: (t) => t });
      const assPath = path.join(dir, `${c.name}.ass`);
      // No shadow, so only the style's own colours are drawn.
      // (Karaoke is drawn after its last word has filled.)
      fs.writeFileSync(assPath, ass.replace(/Dialogue: 0,[^,]+,[^,]+,/g, 'Dialogue: 0,0:00:00.00,0:00:05.00,').replace(/^(Style: Cap(?:,[^,]*){16}),[^,]*,/m, '$1,0,'));
      // Drawn on an RGB frame: a YUV one would blur the colours at the letter edges.
      const exported = path.join(dir, `${c.name}-export.png`);
      execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${HGT}:d=5:r=10`, '-ss', '4', '-vf', `format=rgb24,ass=filename=${assPath}:fontsdir=${fonts}`, '-frames:v', '1', exported], { stdio: 'ignore' });

      // The preview: the app's own caption styling, on a black frame of the same size.
      const box = await page.evaluate(async ([s, px, filled]) => {
        await document.fonts.load('400 30px "Noto Sans"', 'a');
        await document.fonts.load('700 30px "Noto Sans"', 'a');
        document.getElementById('golden')?.remove();
        const stage = document.createElement('div');
        stage.id = 'golden';
        stage.style.cssText = 'position:fixed;left:0;top:0;width:360px;height:640px;background:#000;z-index:99999;display:flex;align-items:center;justify-content:center';
        document.body.appendChild(stage);
        const line = document.createElement('span');
        line.className = 'caption-line';
        stage.appendChild(line);
        const style = { ...window.CutlineCaptions.styleOf(s), shadow: 0 };
        window.CutlinePanels.styleLine(line, style, px, 'en');
        window.CutlinePanels.fillLine(line, 'Talkcut captions match'.split(' ').map((w, i) => ({ text: w, i })), style, -1, filled ? () => 1 : null);
        const r = stage.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, [settings, C.fontPx(C.settingsOf(settings), W, HGT), Boolean(c.filled)]);
      const shot = path.join(dir, `${c.name}-preview.png`);
      await page.screenshot({ path: shot, clip: box });
      await page.evaluate(() => document.getElementById('golden').remove());

      const a = measure(rgb(exported), c.colours);
      const b = measure(rgb(shot), c.colours);
      assert.ok(Math.abs(a.width - b.width) / a.width < 0.04, `${c.name}: export ${a.width} px wide, preview ${b.width} px`);
      for (const k of Object.keys(c.colours)) {
        assert.ok(a[k] > 100 && b[k] > 100, `${c.name}: ${k} colour drawn in both (${a[k]}, ${b[k]})`);
        assert.ok(Math.abs(a[k] - b[k]) / a[k] < (c.loose?.[k] ?? 0.2), `${c.name}: ${k} area export ${a[k]} px, preview ${b[k]} px`);
      }
    }
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a saved style is listed in another project and applies there; animations reach the preview', TIMEOUT, async () => {
  const dir = H.tempDir();
  const first = H.makeProject(dir, H.makeVideo(dir));
  // A second project in the same folder, listed on the home screen too.
  const second = path.join(path.dirname(first), 'Other.talkcut');
  fs.writeFileSync(second, fs.readFileSync(first));
  const settingsFile = path.join(dir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.recentProjects.push({ path: second, name: 'Other', updatedAt: Date.now() - 1000 });
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    if (!(await page.locator('#cap-enabled').isVisible())) await page.click('.rail-btn[data-panel="captions"]');
    await page.locator('#cap-enabled').check();
    await page.locator('#cap-custom summary').click();
    await page.locator('#cap-animation button[data-value="pop"]').click();
    await page.locator('#cap-lines button[data-value="2"]').click();
    await page.locator('#cap-weight button[data-value="400"]').click();
    const style = await page.evaluate(() => window.cutlineState.captions.style);
    assert.deepEqual(style, { animation: 'pop', lines: 2, weight: 400 });
    assert.match(await page.locator('#cap-style-name').textContent(), /changed/);

    // The pop is visible in the preview: just after a caption appears the line is scaled down.
    await page.evaluate(() => { document.getElementById('video').currentTime = 0.22; });
    await H.until(() => page.evaluate(() => /scale\(0\.[0-9]+\)/.test(document.querySelector('#caption-layer .caption-line')?.style.transform ?? '')), 'the line to be scaled');
    await page.evaluate(() => { document.getElementById('video').currentTime = 1.0; });
    await H.until(() => page.evaluate(() => (document.querySelector('#caption-layer .caption-line')?.style.transform ?? 'x') === ''), 'the line at full size');

    // Save it under a name.
    await page.fill('#cap-save-name', 'My Reel style');
    await page.click('#cap-save-style');
    await page.locator('#cap-saved .preset-name', { hasText: 'My Reel style' }).waitFor();
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).captionStyles[0].name, 'My Reel style');

    // Undo takes the style back one step (the weight) — the saved style is unaffected.
    await page.click('#btn-undo');
    assert.deepEqual(await page.evaluate(() => window.cutlineState.captions.style), { animation: 'pop', lines: 2 });

    // Another project: the saved style is listed and applies.
    await page.evaluate((p) => window.cutlineTest.openProject(p), second);
    await H.until(() => page.evaluate(() => /Other\.talkcut$/.test(window.cutlineState.projectPath ?? '')), 'the other project to open');
    await page.locator('#transcript .w').first().waitFor();
    if (!(await page.locator('#cap-saved').isVisible())) await page.click('.rail-btn[data-panel="captions"]');
    assert.equal(await page.evaluate(() => window.cutlineState.captions.style ?? null), null);
    await page.locator('#cap-saved .preset', { hasText: 'My Reel style' }).click();
    assert.deepEqual(await page.evaluate(() => window.cutlineState.captions.style), { animation: 'pop', lines: 2, weight: 400 });
    await H.until(() => H.readProject(second).captions?.style?.animation === 'pop', 'the project to save the style itself');

    // Deleting the saved style leaves the project's look alone.
    page.once('dialog', (d) => d.accept());
    await page.click('#cap-saved .saved-del');
    await H.until(async () => (await page.locator('#cap-saved .preset').count()) === 0, 'the saved style to go');
    assert.equal(await page.evaluate(() => window.cutlineState.captions.style.animation), 'pop');
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
