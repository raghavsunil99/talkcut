// The preview draws captions and titles with the same bundled Noto fonts the export uses.
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

test('the preview loads the bundled fonts and draws a Telugu-English caption with them', TIMEOUT, async () => {
  const dir = H.tempDir();
  const words = ['Glassdoor', 'లో', 'account', 'setup', 'చేయడానికి', 'చాలా', 'process', 'ఉంటుంది'].map((text, i) => ({ text, start: 0.2 + i * 0.5, end: 0.6 + i * 0.5 }));
  H.makeProject(dir, H.makeVideo(dir), { words, language: 'te', captions: { enabled: true, preset: 'subtitle' } });
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    await page.evaluate(() => { document.getElementById('video').currentTime = 0.3; });
    await page.locator('#caption-layer:not([hidden]) .caption-line').waitFor();
    const result = await page.evaluate(async () => {
      const line = document.querySelector('#caption-layer .caption-line');
      // Wait for the font files to load, then ask the browser which faces it really has.
      await document.fonts.load('700 20px "Noto Sans"', 'a');
      await document.fonts.load('700 20px "Noto Sans Telugu"', 'చ');
      return {
        stack: getComputedStyle(line).fontFamily,
        latin: document.fonts.check('700 20px "Noto Sans"', 'a'),
        telugu: document.fonts.check('700 20px "Noto Sans Telugu"', 'చ'),
        loaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')).sort(),
      };
    });
    assert.match(result.stack, /^"?Noto Sans"?, "?Noto Sans Telugu"?/);
    assert.ok(result.latin && result.telugu);
    assert.ok(result.loaded.includes('Noto Sans') && result.loaded.includes('Noto Sans Telugu'), `loaded: ${result.loaded}`);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Telugu-English caption breaks lines and is as wide in the preview as in the export, regular and bold', TIMEOUT, async () => {
  const dir = H.tempDir();
  H.makeProject(dir, H.makeVideo(dir), { language: 'te' });
  const { app, page } = await H.launch(dir);
  try {
    await H.openFromHome(page);
    const fonts = await prepareFontsDir(path.join(dir, 'fonts'));
    const text = 'Glassdoor లో account setup చేయడానికి';
    const words = text.split(' ').map((t, i) => ({ text: t, start: i * 0.1, end: i * 0.1 + 0.1 }));
    // 'subtitle' draws regular and 'clean' bold, both without a box. At 1080 px wide the text is
    // a little longer than the 84% the captions may use, so it wraps: the widest line only matches
    // if both break at the same word (libass balances lines by default; WrapStyle 1 is greedy).
    for (const preset of ['subtitle', 'clean']) {
      const settings = { enabled: true, preset, position: 'middle' };
      // Export: libass at 1080x1920, the width of the ink.
      const ass = C.buildAss({ words, deleted: new Set(), settings, language: 'te', width: 1080, height: 1920, toEdited: (t) => t });
      const assPath = path.join(dir, `${preset}.ass`);
      fs.writeFileSync(assPath, ass.replace(/Dialogue: 0,[^,]+,[^,]+,/g, 'Dialogue: 0,0:00:00.00,0:00:05.00,'));
      const raw = execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:d=1', '-vf', `ass=filename=${assPath}:fontsdir=${fonts},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
      let min = 1080;
      let max = 0;
      for (let y = 0; y < 1920; y++) for (let x = 0; x < 1080; x++) if (raw[y * 1080 + x] > 100) { min = Math.min(min, x); max = Math.max(max, x); }
      // Preview: the real caption layer code at the same frame size.
      const preview = await page.evaluate(async ([t, id, px]) => {
        await document.fonts.load('400 40px "Noto Sans"', 'a');
        await document.fonts.load('700 40px "Noto Sans"', 'a');
        await document.fonts.load('400 40px "Noto Sans Telugu"', 'చ');
        await document.fonts.load('700 40px "Noto Sans Telugu"', 'చ');
        const stage = document.createElement('div');
        stage.style.cssText = 'position:fixed;left:0;top:0;width:1080px;height:1920px;visibility:hidden;display:flex;align-items:center;justify-content:center';
        document.body.appendChild(stage);
        const line = document.createElement('span');
        line.className = 'caption-line';
        stage.appendChild(line);
        window.CutlinePanels.styleLine(line, id, px, 'te');
        window.CutlinePanels.fillLine(line, t.split(' ').map((w, i) => ({ text: w, i })), id, -1);
        const range = document.createRange();
        range.selectNodeContents(line);
        const rects = [...range.getClientRects()];
        stage.remove();
        return { width: Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left)) };
      }, [text, preset, C.fontPx({ ...C.DEFAULTS, ...settings }, 1080, 1920)]);
      const exportWidth = max - min;
      assert.ok(Math.abs(exportWidth - preview.width) / preview.width < 0.03, `${preset}: export ${exportWidth} px, preview ${preview.width.toFixed(0)} px`);
    }
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
