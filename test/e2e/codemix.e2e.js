// Code-mix captions (3.1) in the real app: English words in the Latin font and Telugu in the
// Telugu font, optionally in their own colour, and lines spaced as libass spaces them: the same
// in the preview and the export.
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
const rgb = (file) => execFileSync(ffmpeg, ['-hide_banner', '-i', file, '-vf', `scale=${W}:${HGT}:flags=neighbor,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });

// Bounds of the pixels near a colour, and of all ink.
function bounds(raw, color) {
  const out = { x0: W, x1: 0, y0: HGT, y1: 0, n: 0 };
  for (let i = 0; i < W * HGT; i++) {
    const [r, g, b] = [raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]];
    const hit = color ? Math.abs(r - color[0]) + Math.abs(g - color[1]) + Math.abs(b - color[2]) < 90 : r + g + b > 120;
    if (!hit) continue;
    const x = i % W;
    const y = Math.floor(i / W);
    out.n++;
    out.x0 = Math.min(out.x0, x); out.x1 = Math.max(out.x1, x); out.y0 = Math.min(out.y0, y); out.y1 = Math.max(out.y1, y);
  }
  return out;
}

async function renderBoth(page, dir, name, text, settings) {
  const fonts = await prepareFontsDir(path.join(dir, 'fonts'));
  const words = text.split(' ').map((t, i) => ({ text: t, start: i * 0.1, end: i * 0.1 + 0.1 }));
  let ass = C.buildAss({ words, deleted: new Set(), settings, language: 'te', width: W, height: HGT, toEdited: (t) => t });
  ass = ass.replace(/Dialogue: 0,[^,]+,[^,]+,/g, 'Dialogue: 0,0:00:00.00,0:00:05.00,').replace(/^(Style: Cap(?:,[^,]*){16}),[^,]*,/m, '$1,0,');
  const assPath = path.join(dir, `${name}.ass`);
  fs.writeFileSync(assPath, ass);
  const exported = path.join(dir, `${name}-export.png`);
  execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${HGT}:d=1`, '-vf', `format=rgb24,ass=filename=${assPath}:fontsdir=${fonts}`, '-frames:v', '1', exported], { stdio: 'ignore' });
  const box = await page.evaluate(async ([s, px, t]) => {
    for (const f of ['400 30px "Noto Sans"', '700 30px "Noto Sans"', '400 30px "Noto Sans Telugu"', '700 30px "Noto Sans Telugu"']) await document.fonts.load(f, f.includes('Telugu') ? 'చ' : 'a');
    document.getElementById('golden')?.remove();
    const stage = document.createElement('div');
    stage.id = 'golden';
    stage.style.cssText = 'position:fixed;left:0;top:0;width:360px;height:640px;background:#000;z-index:99999;display:flex;align-items:center;justify-content:center';
    document.body.appendChild(stage);
    const line = document.createElement('span');
    line.className = 'caption-line';
    stage.appendChild(line);
    const style = { ...window.CutlineCaptions.styleOf(s), shadow: 0 };
    window.CutlinePanels.styleLine(line, style, px, 'te');
    // Only the last word is "spoken" (highlighted), as in the export's last event.
    const ws = t.split(' ').map((w, i) => ({ text: w, i }));
    window.CutlinePanels.fillLine(line, ws, style, -1, null, 'te');
    const r = stage.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, [settings, C.fontPx(C.settingsOf(settings), W, HGT), text]);
  const shot = path.join(dir, `${name}-preview.png`);
  await page.screenshot({ path: shot, clip: box });
  await page.evaluate(() => document.getElementById('golden').remove());
  return { exported: rgb(exported), preview: rgb(shot) };
}

test('"account setup చేయడానికి": English in the Latin font, Telugu in the Telugu font, same in preview and export', TIMEOUT, async () => {
  const dir = H.tempDir();
  H.makeProject(dir, H.makeVideo(dir), { language: 'te' });
  const { app, page } = await H.launch(dir, { args: ['--force-color-profile=srgb'] });
  try {
    await H.openFromHome(page);
    // Subtitle style (one line, no highlight), English words in blue, the rest white.
    const settings = { enabled: true, preset: 'subtitle', position: 'middle', style: { latin: '#3399FF', outlineW: 0 } };
    const { exported, preview } = await renderBoth(page, dir, 'mix', 'account setup చేయడానికి', settings);
    const blue = [51, 153, 255];
    const white = [255, 255, 255];
    for (const [what, color] of [['all ink', null], ['English words', blue], ['Telugu word', white]]) {
      const a = bounds(exported, color);
      const b = bounds(preview, color);
      assert.ok(a.n > 50 && b.n > 50, `${what}: drawn in both`);
      const wa = a.x1 - a.x0;
      const wb = b.x1 - b.x0;
      assert.ok(Math.abs(wa - wb) / wa < 0.05, `${what}: export ${wa} px wide, preview ${wb} px`);
      assert.ok(Math.abs(a.x0 - b.x0) <= 4, `${what}: starts at ${a.x0} in the export, ${b.x0} in the preview`);
    }
    // The English words come first and the Telugu after them, in both.
    assert.ok(bounds(exported, blue).x1 < bounds(exported, white).x0 + 2);
    assert.ok(bounds(preview, blue).x1 < bounds(preview, white).x0 + 2);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two-line Telugu captions are spaced like the export', TIMEOUT, async () => {
  const dir = H.tempDir();
  H.makeProject(dir, H.makeVideo(dir), { language: 'te' });
  const { app, page } = await H.launch(dir, { args: ['--force-color-profile=srgb'] });
  try {
    await H.openFromHome(page);
    const settings = { enabled: true, preset: 'subtitle', position: 'middle', style: { lines: 2, maxWords: 3, outlineW: 0 } };
    const { exported, preview } = await renderBoth(page, dir, 'two', 'నేను రేపు ఇంటికి వస్తాను మనం కలిసి', settings);
    const a = bounds(exported, null);
    const b = bounds(preview, null);
    const ha = a.y1 - a.y0;
    const hb = b.y1 - b.y0;
    assert.ok(Math.abs(ha - hb) / ha < 0.06, `two lines: ${ha} px tall in the export, ${hb} px in the preview`);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
