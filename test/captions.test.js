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
  assert.match(ass, /Style: Cap,Kohinoor Telugu,81,/);
  const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(events.length, words.length);
  assert.match(events[2], /Dialogue: 0,0:00:00\.70,0:00:01\.10,.*\{\\c&H004DD8FF\}account\{\\c&H00FFFFFF\}/);
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
  assert.match(ass, /Style: Cap,Avenir Next,/);
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
