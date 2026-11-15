// Code-mix-aware captions (3.1): text measured by how wide it looks in each script, English runs
// in the Latin font (and optionally their own colour), the same in the preview and the export.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const C = require('../src/renderer/captions.js');
const { prepareFontsDir } = require('../src/media.js');

const SAMPLES = {
  latin: ['en', 'the quick brown fox jumps over every lazy dog while people watch'],
  telu: ['te', 'నేను రేపు ఇంటికి వస్తాను మనం కలిసి భోజనం చేద్దాం అని అనుకుంటున్నాను'],
  deva: ['hi', 'मैं कल घर आऊंगा हम साथ में खाना खाएंगे ऐसा मैं सोच रहा हूं'],
  taml: ['ta', 'நான் நாளை வீட்டுக்கு வருவேன் நாம் சேர்ந்து சாப்பிடலாம் என்று நினைக்கிறேன்'],
  knda: ['kn', 'ನಾನು ನಾಳೆ ಮನೆಗೆ ಬರುತ್ತೇನೆ ನಾವು ಒಟ್ಟಿಗೆ ಊಟ ಮಾಡೋಣ ಎಂದು ಯೋಚಿಸುತ್ತಿದ್ದೇನೆ'],
  mlym: ['ml', 'ഞാൻ നാളെ വീട്ടിൽ വരും നമുക്ക് ഒരുമിച്ച് ഭക്ഷണം കഴിക്കാം എന്ന് കരുതുന്നു'],
  beng: ['bn', 'আমি কাল বাড়িতে আসব আমরা একসাথে খাবার খাব বলে আমি ভাবছি'],
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-codemix-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let fontsDir = null;
// Ink width of one line of text as libass draws it (no outline, no shadow).
async function inkWidth(text, language, extraStyle = {}) {
  fontsDir ??= await prepareFontsDir(path.join(dir, 'fonts'));
  const W = 4000;
  let ass = C.buildAss({ words: [{ text, start: 0, end: 1 }], deleted: new Set(), settings: { preset: 'subtitle', position: 'middle', style: { maxWords: 99, ...extraStyle } }, language, width: W, height: 400, toEdited: (t) => t });
  ass = ass.replace(/Dialogue: 0,[^,]+,[^,]+,/g, 'Dialogue: 0,0:00:00.00,0:00:05.00,').replace(/^(Style: Cap(?:,[^,]*){15}),[^,]*,[^,]*,/m, '$1,0,0,');
  const file = path.join(dir, 'w.ass');
  fs.writeFileSync(file, ass);
  const raw = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x400:d=1`, '-vf', `ass=filename=${file}:fontsdir=${fontsDir},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  let x0 = W;
  let x1 = 0;
  for (let y = 0; y < 400; y++) for (let x = 0; x < W; x++) if (raw[y * W + x] > 80) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  return x1 - x0;
}

// A script's letter width relative to English, with spaces counted as one English letter (as
// visualLength counts them): width = k × (letters × factor + spaces), k from the English sample.
async function measuredFactors() {
  const out = {};
  const [enLang, enText] = SAMPLES.latin;
  const k = (await inkWidth(enText, enLang)) / C.graphemes(enText).length;
  for (const [script, [lang, text]] of Object.entries(SAMPLES)) {
    const g = C.graphemes(text);
    const spaces = g.filter((x) => x === ' ').length;
    out[script] = ((await inkWidth(text, lang)) / k - spaces) / (g.length - spaces);
  }
  return out;
}

test('each script\'s letter width, measured again from the bundled fonts, matches SCRIPT_WIDTH', async () => {
  const f = await measuredFactors();
  for (const script of Object.keys(SAMPLES)) {
    assert.ok(Math.abs(f[script] - C.SCRIPT_WIDTH[script]) / C.SCRIPT_WIDTH[script] < 0.06, `${script}: measured ${f[script].toFixed(2)}, table ${C.SCRIPT_WIDTH[script]}`);
  }
});

test('lines of equal visible width count the same in every script (so they break at the same point)', async () => {
  const perUnit = {};
  for (const [script, [lang, text]] of Object.entries(SAMPLES)) perUnit[script] = (await inkWidth(text, lang)) / C.visualLength(text);
  for (const script of Object.keys(SAMPLES)) {
    assert.ok(Math.abs(perUnit[script] / perUnit.latin - 1) < 0.1, `${script}: ${(perUnit[script] / perUnit.latin).toFixed(2)} of English per counted unit`);
  }
  // Grouping uses it: a Telugu caption fills to about the same width as an English one.
  const words = (text) => text.split(' ').map((t, i) => ({ text: t, start: i * 0.3, end: i * 0.3 + 0.25 }));
  const firstLine = (lang, text) => C.groupWords(words(text), new Set(), 'subtitle')[0].map((i) => words(text)[i].text).join(' ');
  const en = await inkWidth(firstLine('en', SAMPLES.latin[1]), 'en');
  for (const script of ['telu', 'taml', 'mlym', 'deva']) {
    const [lang, text] = SAMPLES[script];
    const w = await inkWidth(firstLine(lang, text), lang);
    assert.ok(Math.abs(w / en - 1) < 0.25, `${script}: first caption ${w} px wide, English ${en} px`);
  }
});

test('graphemes keep vowel signs and viramas with their letter', () => {
  assert.deepEqual(C.graphemes('చేయడానికి'), ['చే', 'య', 'డా', 'ని', 'కి']);
  assert.equal(C.scriptOf('చ'), 'telu');
  assert.equal(C.scriptOf('a'), 'latin');
  assert.ok(Math.abs(C.visualLength('account చేయ') - (7 + 1 + 2 * C.SCRIPT_WIDTH.telu)) < 1e-9);
});

test('English runs: own font always, own colour when chosen, never on the spoken word', () => {
  const words = ['account', 'setup', 'చేయడానికి'].map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 }));
  // ("clean" holds all three words in one caption: 7 + 1 + 5 + 1 + 5 Telugu letters × 1.81.)
  const ass = C.buildAss({ words, deleted: new Set(), settings: { preset: 'clean', style: { latin: '#7CC7FF' } }, language: 'te', width: 1080, height: 1920, toEdited: (t) => t });
  const ev = ass.split('\n').filter((l) => l.startsWith('Dialogue'));
  assert.equal(ev.length, 3);
  // While "setup" is spoken: "account" in the English colour, "setup" in the highlight colour.
  assert.match(ev[1], /\{\\fnNoto Sans\\fs106\.3\\c&H00FFC77C\}account\{\\fnNoto Sans Telugu\\fs103\.5\\c&H00FFFFFF\}/);
  assert.match(ev[1], /\{\\c&H008BE35B\}\{\\fnNoto Sans\\fs106\.3\}setup\{\\fnNoto Sans Telugu\\fs103\.5\}\{\\c&H00FFFFFF\}/);
  assert.match(ev[1], / చేయడానికి$/);
  // Without the option, nothing changes from before.
  const plain = C.buildAss({ words, deleted: new Set(), settings: { preset: 'clean' }, language: 'te', width: 1080, height: 1920, toEdited: (t) => t });
  assert.doesNotMatch(plain, /\\fs106\.3\\c/);
  assert.deepEqual(C.latinRuns('Glassdoorలో', 'te'), [{ text: 'Glassdoor', latin: true }, { text: 'లో', latin: false }]);
  assert.deepEqual(C.latinRuns('hello', 'en'), [{ text: 'hello', latin: false }]);
  assert.equal(C.settingsOf({ style: { latin: '#00ff00' } }).style.latin, '#00FF00');
  assert.equal(C.styleOf({ preset: 'highlight' }).latin, null);
});
