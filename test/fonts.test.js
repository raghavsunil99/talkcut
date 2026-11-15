// Caption fonts: the bundled Noto files are what the preview and the export use, and a missing
// font stops the export with a clear message.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const C = require('../src/renderer/captions.js');
const { prepareFontsDir } = require('../src/media.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-fonts-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('every language has a bundled font file, and the folder holds all of them', () => {
  const bundled = path.join(__dirname, '..', 'assets', 'fonts');
  for (const file of Object.keys(C.FONT_FILES)) assert.ok(fs.existsSync(path.join(bundled, file)), file);
  for (const language of ['te', 'ta', 'ml', 'kn', 'hi', 'mr', 'bn', 'en', 'es']) {
    assert.ok(Object.values(C.FONT_FILES).includes(C.fontFor(language)), `${language} -> ${C.fontFor(language)}`);
  }
  assert.equal(C.fontFor('te'), 'Noto Sans Telugu');
  assert.equal(C.fontFor('en'), 'Noto Sans');
  assert.equal(C.fontStack('te'), '"Noto Sans", "Noto Sans Telugu", sans-serif');
  assert.equal(C.fontStack('en'), '"Noto Sans", sans-serif');
});

test('Latin runs in a Telugu caption switch to Noto Sans at the size that matches, and Telugu stays in its own font', () => {
  const latin = `{\\fnNoto Sans\\fs${C.assSize('Noto Sans', 40)}}`;
  const back = `{\\fnNoto Sans Telugu\\fs${C.assSize('Noto Sans Telugu', 40)}}`;
  assert.equal(C.withFontRuns('account setup చేయడానికి, ok', 'te', 40), `${latin}account setup ${back}చేయడానికి, ${latin}ok${back}`);
  assert.equal(C.withFontRuns('plain English', 'en', 40), 'plain English', 'no switches when the font is already Noto Sans');
  assert.equal(C.withFontRuns('చేయడానికి', 'te', 40), 'చేయడానికి', 'pure Telugu is left alone');
  assert.match(C.withFontRuns('Vivo 2024', 'ta', 40), /^\{\\fnNoto Sans\\fs60\.8\}Vivo 2024\{\\fnNoto Sans Tamil\\fs49\.6\}$/);
});

// libass sizes a font by usWinAscent + usWinDescent of its OS/2 table; the factors in
// C.LINE_HEIGHT must match the files that ship.
test('the libass size factors match the bundled font files', () => {
  for (const [file, family] of Object.entries(C.FONT_FILES)) {
    const b = fs.readFileSync(path.join(__dirname, '..', 'assets', 'fonts', file));
    const count = b.readUInt16BE(4);
    const tables = {};
    for (let i = 0; i < count; i++) tables[b.toString('ascii', 12 + i * 16, 16 + i * 16)] = b.readUInt32BE(20 + i * 16);
    const upm = b.readUInt16BE(tables.head + 18);
    const win = (b.readUInt16BE(tables['OS/2'] + 74) + b.readUInt16BE(tables['OS/2'] + 76)) / upm;
    assert.ok(Math.abs(win - C.LINE_HEIGHT[family]) < 0.0006, `${family}: file says ${win}, table says ${C.LINE_HEIGHT[family]}`);
  }
});

test('a missing font file stops the export with a message naming it', async () => {
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  await assert.rejects(prepareFontsDir(path.join(dir, 'out-a'), { source: empty }), /caption font NotoSans-Regular\.ttf is missing.*Reinstall/);
  // One missing file among the rest is caught too.
  const almost = path.join(dir, 'almost');
  fs.mkdirSync(almost);
  for (const file of Object.keys(C.FONT_FILES)) if (file !== 'NotoSansTamil-Bold.ttf') fs.copyFileSync(path.join(__dirname, '..', 'assets', 'fonts', file), path.join(almost, file));
  await assert.rejects(prepareFontsDir(path.join(dir, 'out-b'), { source: almost }), /NotoSansTamil-Bold\.ttf is missing/);
});

// ---- the same pixels from the export as from the font files ----

function frame(name, language, text, { fonts }) {
  const ass = C.buildAss({
    words: text.split(' ').map((t, i) => ({ text: t, start: i * 0.1, end: i * 0.1 + 0.1 })), deleted: new Set(),
    settings: { enabled: true, preset: 'subtitle', position: 'middle', size: 'large', scale: 3 }, language, width: 640, height: 200, toEdited: (t) => t,
  });
  const assPath = path.join(dir, `${name}.ass`);
  fs.writeFileSync(assPath, ass.replace(/Dialogue: 0,[^,]+,[^,]+,/g, 'Dialogue: 0,0:00:00.00,0:00:05.00,'));
  const png = path.join(dir, `${name}.png`);
  execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=0x202020:s=640x200:d=1', '-vf', `ass=filename=${assPath}:fontsdir=${fonts}`, '-frames:v', '1', png], { stdio: 'ignore' });
  const raw = execFileSync(ffmpeg, ['-hide_banner', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
  return raw;
}

test('the export draws English letters in Noto Sans even inside a Telugu caption', async () => {
  const fonts = await prepareFontsDir(path.join(dir, 'fonts-ok'));
  // The word alone, as an English caption and as a Telugu-language caption: the same pixels.
  const en = frame('en', 'en', 'account', { fonts });
  const te = frame('te', 'te', 'account', { fonts });
  assert.ok(en.some((v) => v > 200), 'something is drawn');
  assert.deepEqual(Buffer.compare(en, te), 0, 'English letters look the same in an English and a Telugu caption');
  // Telugu letters are drawn (not boxes or nothing), and differ from the English word.
  const telugu = frame('tel', 'te', 'చేయడానికి', { fonts });
  assert.ok(telugu.some((v) => v > 200));
  assert.notEqual(Buffer.compare(telugu, te), 0);
});

test('the export draws text as wide as the preview does at the same CSS size', async () => {
  const fonts = await prepareFontsDir(path.join(dir, 'fonts-size'));
  // 'account setup' in Noto Sans regular at a CSS size of 40 px measures 260.76 px of ink in
  // Chromium (canvas measureText with the same font file, measured while writing this test).
  // libass must draw it as wide, which only holds with the size factor in C.LINE_HEIGHT.
  const cssPx = 40;
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 200\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,Noto Sans,${C.assSize('Noto Sans', cssPx)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:05.00,Cap,,0,0,0,,account setup\n`;
  const assPath = path.join(dir, 'size.ass');
  fs.writeFileSync(assPath, ass);
  const raw = execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x200:d=1', '-vf', `ass=filename=${assPath}:fontsdir=${fonts},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
  let min = 640;
  let max = 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 640; x++) if (raw[y * 640 + x] > 100) { min = Math.min(min, x); max = Math.max(max, x); }
  const ink = max - min;
  assert.ok(Math.abs(ink - 260.76) / 260.76 < 0.02, `libass drew ${ink} px of ink, Chromium draws 260.76 px`);
});

test('bold text in the export is as wide as bold text in the preview', async () => {
  const fonts = await prepareFontsDir(path.join(dir, 'fonts-bold'));
  // Ink widths at a CSS size of 40 px in Chromium (canvas measureText, weight 700, measured while
  // writing this test): the libass export has to match, which needs the static Bold files.
  const cases = [['Noto Sans', 'account setup process', 442], ['Noto Sans Telugu', 'చేయడానికి చాలా ఉంటుంది', 456]];
  for (const [family, text, chromium] of cases) {
    const assPath = path.join(dir, 'bold.ass');
    fs.writeFileSync(assPath, `[Script Info]\nScriptType: v4.00+\nPlayResX: 900\nPlayResY: 120\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,${family},${C.assSize(family, 40)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:05.00,Cap,,0,0,0,,${text}\n`);
    const raw = execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=900x120:d=1', '-vf', `ass=filename=${assPath}:fontsdir=${fonts},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
    let min = 900;
    let max = 0;
    for (let y = 0; y < 120; y++) for (let x = 0; x < 900; x++) if (raw[y * 900 + x] > 100) { min = Math.min(min, x); max = Math.max(max, x); }
    assert.ok(Math.abs(max - min - chromium) / chromium < 0.02, `${family}: libass drew ${max - min} px, Chromium draws ${chromium} px`);
  }
});
