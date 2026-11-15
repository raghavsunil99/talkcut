const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/renderer/captions.js');
const E = require('../src/renderer/edits.js');

const words = [
  { text: 'Glassdoor', start: 0.0, end: 0.5 },
  { text: 'లో', start: 0.5, end: 0.7 },
  { text: 'account', start: 0.7, end: 1.1 },
  { text: 'setup', start: 1.1, end: 1.5 },
  { text: 'చేయడానికి.', start: 1.5, end: 2.0 },
  { text: 'Y', start: 3.0, end: 3.2 },
  { text: 'Combinator', start: 3.2, end: 3.8 },
];

test('groupWords respects the character limit, sentence ends and pauses', () => {
  // highlight: at most 4 words / 24 characters; "Glassdoor లో account setup" is too long
  const groups = C.groupWords(words, new Set(), 'highlight');
  assert.deepEqual(groups, [[0, 1, 2], [3, 4], [5, 6]]);
});

test('groupWords respects the word limit', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ text: 'a', start: i * 0.2, end: i * 0.2 + 0.15 }));
  assert.deepEqual(C.groupWords(many, new Set(), 'highlight').map((g) => g.length), [4, 4, 1]);
});

test('groupWords skips cut words', () => {
  const groups = C.groupWords(words, new Set([1, 2]), 'highlight');
  assert.deepEqual(groups, [[0, 3], [4], [5, 6]]);
});

test('one word preset makes one group per word', () => {
  assert.equal(C.groupWords(words, new Set(), 'oneword').length, words.length);
});

test('activeAt finds the group and current word', () => {
  const spans = C.groupSpans(C.groupWords(words, new Set(), 'highlight'), words);
  assert.deepEqual(C.activeAt(spans, words, 0.8).current, 2);
  assert.equal(C.activeAt(spans, words, 2.9), null); // in the pause, after the hold time
  assert.equal(C.activeAt(spans, words, 3.5).current, 6);
});

test('buildAss writes a highlighted event per word in edited time', () => {
  const ass = C.buildAss({
    words, deleted: new Set(), settings: { enabled: true, preset: 'highlight' }, language: 'te',
    width: 1080, height: 1920, toEdited: (t) => t,
  });
  assert.match(ass, /PlayResX: 1080/);
  // 81 CSS px (7.5% of the 1080 px width) is 119.7 in libass units: see C.LINE_HEIGHT.
  assert.match(ass, /Style: Cap,Noto Sans Telugu,119\.7,/);
  const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(events.length, words.length);
  // English words inside a Telugu caption switch to Noto Sans for their letters (see withFontRuns).
  assert.match(events[2], /Dialogue: 0,0:00:00\.70,0:00:01\.10,.*\{\\c&H004DD8FF\}\{\\fnNoto Sans\\fs123\}account\{\\fnNoto Sans Telugu\\fs119\.7\}\{\\c&H00FFFFFF\}/);
});

test('buildAss shifts captions with cuts and the subtitle preset has one event per line', () => {
  const ass = C.buildAss({
    words, deleted: new Set(), settings: { enabled: true, preset: 'subtitle' }, language: 'en',
    width: 1920, height: 1080, toEdited: (t) => (t >= 3 ? t - 0.9 : t),
  });
  const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(events.length, 2);
  // starts at 3.0 - 0.9 and holds 0.6 s past the last word (3.8 + 0.6 - 0.9)
  assert.match(events[1], /^Dialogue: 0,0:00:02\.10,0:00:03\.50,/);
  assert.match(ass, /Style: Cap,Noto Sans,/);
});

test('assColor converts #RRGGBB to ASS &HAABBGGRR', () => {
  assert.equal(C.assColor('#FFD84D'), '&H004DD8FF');
});

test('buildSubtitles writes SRT and VTT on the edited timeline', () => {
  const words = [
    { text: 'Hello', start: 0, end: 0.4 }, { text: 'there.', start: 0.5, end: 0.9 },
    { text: 'cut', start: 1, end: 1.4 },
    { text: 'Next', start: 3, end: 3.4 }, { text: 'line.', start: 3.5, end: 4 },
  ];
  const kept = [[0, 1], [1.5, 5]];
  const toEdited = (t) => E.toEdited(kept, t);
  const srt = C.buildSubtitles({ words, deleted: new Set([2]), settings: null, toEdited });
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,000\nHello there.\n\n2\n00:00:02,500 --> 00:00:04,100\nNext line.\n');
  const vtt = C.buildSubtitles({ words, deleted: new Set([2]), settings: null, toEdited, speed: 2, format: 'vtt' });
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.000 --> 00:00:00\.500\nHello there\.\n/);
});

test('captions dragged on the video export at their spot and size', () => {
  const words = [{ text: 'Hello', start: 0, end: 0.5 }, { text: 'there.', start: 0.6, end: 1 }];
  const base = { words, deleted: new Set(), language: 'en', width: 1080, height: 1920, toEdited: (t) => t };
  const custom = C.buildAss({ ...base, settings: { enabled: true, preset: 'subtitle', position: 'custom', x: 0.25, y: 0.3, scale: 2 } });
  assert.match(custom, /\{\\an5\\pos\(270,576\)\}Hello there\./);
  const normal = C.buildAss({ ...base, settings: { enabled: true, preset: 'subtitle' } });
  const size = (ass) => Number(/Style: Cap,[^,]+,(\d+)/.exec(ass)[1]);
  assert.equal(size(custom), size(normal) * 2);
  assert.ok(!/\\pos/.test(normal));
  assert.equal(C.settingsOf({ position: 'custom', scale: 9 }).scale, 3);
});

// ---------- custom styles (2.4) ----------
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const { prepareFontsDir } = require('../src/media.js');

const six = ['one', 'two', 'three', 'four', 'five', 'six'].map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 }));
const dialogues = (ass) => ass.split('\n').filter((l) => l.startsWith('Dialogue:'));

test('a style keeps only valid values and resolves on top of its preset', () => {
  const s = C.settingsOf({ preset: 'clean', style: { text: '#00ff66', hi: 'red', outlineW: 2, weight: 400, maxWords: 0, lines: 3, animation: 'spin', box: '#102030', extra: 1 } });
  assert.deepEqual(s.style, { text: '#00FF66', outlineW: 0.15, box: 'rgba(16,32,48,0.72)', weight: 400, maxWords: 1 });
  const p = C.styleOf(s);
  assert.equal(p.text, '#00FF66');
  assert.equal(p.hi, C.PRESETS.clean.hi, 'an invalid colour keeps the preset\'s');
  assert.equal(p.lines, 1);
  assert.equal(p.animation, 'none');
  assert.equal(C.settingsOf({ preset: 'clean', style: {} }).style, undefined, 'an empty style is no style');
  assert.ok(!C.isCustom(C.settingsOf({ preset: 'clean' })));
  assert.ok(C.isCustom(s));
});

test('built-in presets write exactly what they did before', () => {
  const plain = C.buildAss({ words, deleted: new Set(), settings: { preset: 'highlight' }, language: 'te', width: 1080, height: 1920, toEdited: (t) => t });
  const same = C.buildAss({ words, deleted: new Set(), settings: { preset: 'highlight', style: { lines: 1, animation: 'none' } }, language: 'te', width: 1080, height: 1920, toEdited: (t) => t });
  assert.equal(same, plain);
  assert.doesNotMatch(plain, /\\N|\\fsc|\\kf/);
});

test('custom colours, outline, box and weight reach the ASS style line', () => {
  const ass = C.buildAss({ words: six, deleted: new Set(), settings: { preset: 'highlight', style: { text: '#00FF66', hi: '#FF0000', outline: '#112233', outlineW: 0.09, weight: 400 } }, language: 'en', width: 1080, height: 1920, toEdited: (t) => t });
  const style = ass.split('\n').find((l) => l.startsWith('Style: Cap'));
  const f = style.split(',');
  assert.equal(f[3], '&H0066FF00', 'text colour (ASS is blue, green, red)');
  assert.equal(f[4], '&H000000FF');
  assert.equal(f[5], '&H00332211');
  assert.equal(f[7], '0', 'regular weight');
  assert.equal(Number(f[16]), Math.round(0.09 * 81 * 10) / 10, 'outline 9% of the 81 px font');
  const boxed = C.buildAss({ words: six, deleted: new Set(), settings: { preset: 'highlight', style: { box: '#2040C0' } }, language: 'en', width: 1080, height: 1920, toEdited: (t) => t });
  const b = boxed.split('\n').find((l) => l.startsWith('Style: Cap')).split(',');
  assert.equal(b[15], '3', 'opaque box');
  assert.equal(b[5], '&H47C04020', 'box colour with 72% opacity');
});

test('two lines: a group holds twice as much and breaks at the same balanced word everywhere', () => {
  const style = C.styleOf({ preset: 'subtitle', style: { lines: 2, maxWords: 3 } });
  assert.equal(C.breakAt(['one', 'two', 'three', 'four', 'five', 'six'], style), 3);
  assert.equal(C.breakAt(['a', 'b'], style), -1, 'fits on one line');
  assert.equal(C.breakAt(['supercalifragilistic', 'is', 'a', 'word'], { ...style, maxChars: 10 }), 1);
  const groups = C.groupWords(six, new Set(), { preset: 'subtitle', style: { lines: 2, maxWords: 3 } });
  assert.deepEqual(groups, [[0, 1, 2, 3, 4, 5]]);
  const ass = C.buildAss({ words: six, deleted: new Set(), settings: { preset: 'subtitle', style: { lines: 2, maxWords: 3 } }, language: 'en', width: 1080, height: 1920, toEdited: (t) => t });
  assert.match(dialogues(ass)[0], /one two three\\Nfour five six$/);
  const srt = C.buildSubtitles({ words: six, deleted: new Set(), settings: { preset: 'subtitle', style: { lines: 2, maxWords: 3 } }, toEdited: (t) => t });
  assert.match(srt, /one two three\nfour five six/);
});

test('karaoke: one event per group, each word filling until the next starts, in edited time', () => {
  const settings = { preset: 'highlight', style: { animation: 'karaoke', maxWords: 3 } };
  const ass = C.buildAss({ words: six, deleted: new Set(), settings, language: 'en', width: 1080, height: 1920, toEdited: (t) => t });
  const ev = dialogues(ass);
  assert.equal(ev.length, 2);
  assert.match(ev[0], /^Dialogue: 0,0:00:00\.00,0:00:01\.50,.*\{\\1c&H004DD8FF\\2c&H00FFFFFF\}\{\\kf50\}one \{\\kf50\}two \{\\kf40\}three$/);
  // Cutting 0.3 s out of the pause between "one" and "two" shortens the first fill.
  const cut = (t) => (t >= 0.5 ? t - 0.05 : Math.min(t, 0.45));
  const ev2 = dialogues(C.buildAss({ words: six, deleted: new Set(), settings, language: 'en', width: 1080, height: 1920, toEdited: cut }));
  assert.match(ev2[0], /\{\\kf45\}one \{\\kf50\}two/);
});

test('pop and grow follow one curve in the preview and the export', () => {
  const pop = C.styleOf({ preset: 'highlight', style: { animation: 'pop' } });
  assert.equal(C.lineScale(pop, 0, 2), 0.7);
  assert.ok(Math.abs(C.lineScale(pop, 0.12, 2) - 1.08) < 1e-9);
  assert.equal(C.lineScale(pop, 0.5, 2), 1);
  const ev = dialogues(C.buildAss({ words: six, deleted: new Set(), settings: { preset: 'highlight', style: { animation: 'pop' } }, language: 'en', width: 1080, height: 1920, toEdited: (t) => t }));
  assert.match(ev[0], /\{\\fscx70\\fscy70\\t\(0,120,\\fscx108\\fscy108\)\\t\(120,200,\\fscx100\\fscy100\)\}/);
  assert.doesNotMatch(ev[1], /\\fsc/, 'later words of the group are at full size');
  const grow = C.styleOf({ preset: 'subtitle', style: { animation: 'grow' } });
  assert.ok(Math.abs(C.lineScale(grow, 1, 2) - 1.04) < 1e-9);
});

// Ink bounds of a caption rendered by libass at time t (seconds).
function inkAt(ass, t, fontsDir, dir) {
  const file = path.join(dir, `pop-${t}.ass`);
  fs.writeFileSync(file, ass);
  const raw = execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=540x960:d=1:r=100', '-ss', String(t), '-vf', `ass=filename=${file}:fontsdir=${fontsDir},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
  let [x0, x1, y0, y1] = [540, 0, 960, 0];
  for (let y = 0; y < 960; y++) for (let x = 0; x < 540; x++) if (raw[y * 540 + x] > 60) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { w: x1 - x0, x: (x0 + x1) / 2, bottom: y1 };
}

test('the pop animation is in the exported picture, scaling around the bottom centre', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-pop-'));
  try {
    const fontsDir = await prepareFontsDir(path.join(dir, 'fonts'));
    const late = six.map((w) => ({ ...w, start: w.start + 0.5, end: w.end + 0.5 }));
    const ass = C.buildAss({ words: late, deleted: new Set(), settings: { preset: 'subtitle', style: { animation: 'pop' } }, language: 'en', width: 540, height: 960, toEdited: (t) => t });
    const start = inkAt(ass, 0.52, fontsDir, dir);
    const peak = inkAt(ass, 0.62, fontsDir, dir);
    const settled = inkAt(ass, 0.9, fontsDir, dir);
    assert.ok(start.w < settled.w * 0.85, `smaller as it appears: ${start.w} vs ${settled.w}`);
    assert.ok(peak.w > settled.w * 1.03, `overshoots: ${peak.w} vs ${settled.w}`);
    assert.ok(Math.abs(start.x - settled.x) < 3, 'stays centred');
    assert.ok(Math.abs(start.bottom - settled.bottom) < 4, `bottom stays put (${start.bottom} vs ${settled.bottom}), like the preview's transform-origin`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('karaoke fills in the exported picture: more of the line is highlighted as time goes on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-kf-'));
  try {
    const fontsDir = await prepareFontsDir(path.join(dir, 'fonts'));
    const ass = C.buildAss({ words: six.slice(0, 3), deleted: new Set(), settings: { preset: 'subtitle', style: { animation: 'karaoke', hi: '#FF0000', text: '#00FF00', outlineW: 0 } }, language: 'en', width: 540, height: 960, toEdited: (t) => t });
    const file = path.join(dir, 'kf.ass');
    fs.writeFileSync(file, ass.replace(/^(Style: Cap(?:,[^,]*){16}),[^,]*,/m, '$1,0,'));
    const redShare = (t) => {
      const raw = execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=540x960:d=2:r=100,format=rgb24', '-ss', String(t), '-vf', `ass=filename=${file}:fontsdir=${fontsDir}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
      let red = 0;
      let green = 0;
      for (let i = 0; i < raw.length; i += 3) { if (raw[i] > 150 && raw[i + 1] < 80) red++; else if (raw[i + 1] > 150 && raw[i] < 80) green++; }
      return red / Math.max(1, red + green);
    };
    const early = redShare(0.1);
    const mid = redShare(0.75);
    const late = redShare(1.35);
    assert.ok(early < mid && mid < late, `fill grows: ${early.toFixed(2)}, ${mid.toFixed(2)}, ${late.toFixed(2)}`);
    assert.ok(early < 0.25 && late > 0.9);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
