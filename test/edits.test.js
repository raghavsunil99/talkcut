const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/renderer/edits.js');

const words = [
  { text: 'Hello', start: 0.5, end: 0.8 },
  { text: 'um,', start: 1.0, end: 1.2 },
  { text: 'world', start: 1.5, end: 1.9 },
  { text: 'Uh', start: 2.5, end: 2.7 },
  { text: 'bye.', start: 3.0, end: 3.4 },
];

test('no cuts keeps everything', () => {
  const cuts = E.computeCuts(words, new Set(), 4);
  assert.deepEqual(cuts, []);
  assert.deepEqual(E.keptRanges(cuts, 4), [[0, 4]]);
});

test('cutting a middle word removes up to the next kept word', () => {
  const cuts = E.computeCuts(words, new Set([1]), 4);
  assert.deepEqual(cuts, [[1.0, 1.5]]);
  assert.deepEqual(E.keptRanges(cuts, 4), [[0, 1.0], [1.5, 4]]);
});

test('cutting the first word removes the lead-in', () => {
  assert.deepEqual(E.computeCuts(words, new Set([0, 1]), 4), [[0, 1.5]]);
});

test('cutting the last word removes the tail', () => {
  assert.deepEqual(E.computeCuts(words, new Set([4]), 4), [[3.0, 4]]);
});

test('cutting everything leaves nothing to export', () => {
  const cuts = E.computeCuts(words, new Set([0, 1, 2, 3, 4]), 4);
  assert.deepEqual(E.keptRanges(cuts, 4), []);
});

test('filler detection ignores case and punctuation', () => {
  assert.deepEqual(E.fillerIndices(words), [1, 3]);
});

test('gaps finds pauses including lead-in and tail', () => {
  const g = E.gaps(words, 4);
  assert.deepEqual(g.map((x) => x.i), [-1, 1, 2, 4]);
  assert.deepEqual(g.find((x) => x.i === 2), { i: 2, start: 1.9, end: 2.5 });
});

test('cutting a pause shortens it to GAP_KEEP', () => {
  const cuts = E.computeCuts(words, new Set(), 4, new Set([2]));
  assert.equal(cuts.length, 1);
  const [s, e] = cuts[0];
  assert.ok(Math.abs(s - 2.0) < 1e-9 && Math.abs(e - 2.4) < 1e-9, `${s}-${e}`);
  const kept = E.keptRanges(cuts, 4);
  assert.ok(Math.abs(E.totalLength(kept) - 3.6) < 1e-9);
});

test('cutting a pause and the word after it keeps GAP_KEEP of silence in total', () => {
  // world ends 1.9, Uh (cut) starts 2.5, bye starts 3.0
  const cuts = E.computeCuts(words, new Set([3]), 4, new Set([2]));
  const kept = E.keptRanges(cuts, 4);
  const silenceBeforeBye = (2.0 - 1.9) + (2.5 - 2.4);
  assert.ok(Math.abs(silenceBeforeBye - E.GAP_KEEP) < 1e-9);
  assert.ok(Math.abs(E.totalLength(kept) - (4 - 0.4 - 0.5)) < 1e-9, JSON.stringify(kept));
});

test('mergeRanges joins overlapping and touching ranges', () => {
  assert.deepEqual(E.mergeRanges([[2, 3], [0, 1], [1, 1.5], [2.5, 4]]), [[0, 1.5], [2, 4]]);
});

test('toEdited and toSource map across cuts', () => {
  const kept = [[0, 1], [2, 3]];
  assert.equal(E.toEdited(kept, 0.5), 0.5);
  assert.equal(E.toEdited(kept, 1.5), 1); // inside the cut: where it was made
  assert.equal(E.toEdited(kept, 2.5), 1.5);
  assert.equal(E.toSource(kept, 0.5), 0.5);
  assert.equal(E.toSource(kept, 1.5), 2.5);
  assert.equal(E.toSource(kept, 9), 3);
});

test('skipTarget jumps past a cut once and tolerates frame-snapped seeks', () => {
  const cuts = [[10.73, 11.29], [20, 30]];
  assert.equal(E.skipTarget(cuts, 10.5, 30), null);
  assert.ok(Math.abs(E.skipTarget(cuts, 10.8, 30).seekTo - 11.3) < 1e-9);
  // A seek to 11.30 on 24 fps video can land on 11.25 (frame 270): must not jump again.
  assert.equal(E.skipTarget(cuts, 11.25, 30), null);
  // A cut running to the end stops playback at its start.
  assert.deepEqual(E.skipTarget(cuts, 25, 30), { stopAt: 20 });
});

test('cutAt and wordAt lookups', () => {
  const cuts = [[1, 1.5], [2.5, 3]];
  assert.equal(E.cutAt(cuts, 0.9), -1);
  assert.equal(E.cutAt(cuts, 1.2), 0);
  assert.equal(E.cutAt(cuts, 1.5), -1);
  assert.equal(E.cutAt(cuts, 2.9), 1);
  assert.equal(E.wordAt(words, 0.1), -1);
  assert.equal(E.wordAt(words, 1.6), 2);
  assert.equal(E.wordAt(words, 10), 4);
});

test('replaceWords corrects text, keeps timing and shifts later cuts', () => {
  const r = E.replaceWords(words, new Set([4]), new Set([2, 4]), 1, 2, 'hmm big world');
  assert.deepEqual(r.words.map((w) => w.text), ['Hello', 'hmm', 'big', 'world', 'Uh', 'bye.']);
  assert.equal(r.words[1].start, 1.0);
  assert.ok(Math.abs(r.words[3].end - 1.9) < 1e-9);
  assert.deepEqual([...r.deleted], [5]); // 'bye.' moved from 4 to 5
  assert.deepEqual([...r.cutGaps], [5]); // gap 2 was inside the range and is dropped
});

test('replaceWords with empty text cuts the range', () => {
  const r = E.replaceWords(words, new Set(), new Set(), 1, 2, '   ');
  assert.equal(r.words, words);
  assert.deepEqual([...r.deleted], [1, 2]);
});

test('cutRange cuts exact time and marks words mostly inside it', () => {
  // words: Hello 0.5-0.8, um 1.0-1.2, world 1.5-1.9, Uh 2.5-2.7, bye 3.0-3.4
  const r = E.cutRange(words, new Set(), [], 1.6, 0.9); // reversed drag
  assert.deepEqual([...r.deleted].sort(), [1]); // "um" (mid 1.1) is inside; "world" (mid 1.7) is not
  assert.deepEqual(r.rangeCuts, [[0.9, 1.6]]);
  const cuts = E.computeCuts(words, r.deleted, 4, new Set(), r.rangeCuts);
  assert.deepEqual(cuts, [[0.9, 1.6]]);
});

test('restoreWords removes time cuts over the restored words', () => {
  const r = E.cutRange(words, new Set(), [], 0.9, 1.6);
  const back = E.restoreWords(words, r.deleted, r.rangeCuts, 1, 1);
  assert.equal(back.deleted.size, 0);
  assert.deepEqual(back.rangeCuts, []);
});

test('segmentAt finds the stretch between blade splits', () => {
  assert.deepEqual(E.segmentAt([2, 5], 3, 10), [2, 5]);
  assert.deepEqual(E.segmentAt([2, 5], 1, 10), [0, 2]);
  assert.deepEqual(E.segmentAt([2, 5], 7, 10), [5, 10]);
  assert.deepEqual(E.segmentAt([], 7, 10), [0, 10]);
});

test('findRetakes cuts earlier takes and keeps the last one', () => {
  let t = 0;
  const w = (text, pause = 0) => { t += pause; const word = { text, start: t, end: t + 0.3 }; t += 0.35; return word; };
  const words = [
    w('Hello'), w('everyone,'), w('welcome'), w('back.'),
    w('Today'), w('we'), w('will'), // false start, then a pause
    w('sorry,', 0.8),
    w('Today', 0.8), w('we'), w('will'), w('talk'), w('about'), w('ration'), w('cards.'),
    w('I'), w('went'), w('to'), w('I'), w('went'), w('to'), w('the'), w('office.'),
    w('Then', 1), w('it'), w('was'), w('done.'),
  ];
  const takes = E.findRetakes(words);
  assert.deepEqual(takes.map((x) => x.text), ['Today we will sorry,', 'I went to']);
  assert.deepEqual(takes[1].idx, [15, 16, 17]);
  // Deleted words are ignored, and a second run finds nothing new.
  const deleted = new Set(takes.flatMap((x) => x.idx));
  assert.deepEqual(E.findRetakes(words, deleted), []);
});

test('findRetakes leaves different sentences alone', () => {
  let t = 0;
  const w = (text, pause = 0) => { t += pause; const word = { text, start: t, end: t + 0.3 }; t += 0.35; return word; };
  const words = [w('The'), w('card'), w('is'), w('ready.'), w('The', 1), w('office'), w('opens'), w('at'), w('ten.'), w('very'), w('very'), w('good.')];
  assert.deepEqual(E.findRetakes(words), []);
});

test('find and replace corrects every occurrence and keeps timing and punctuation', () => {
  const words = [
    { text: 'Vivo', start: 0, end: 0.4, speaker: 'a' }, { text: '3.1', start: 0.5, end: 0.8 },
    { text: 'or', start: 1, end: 1.2 }, { text: 'vivo,', start: 1.3, end: 1.6 }, { text: 'model', start: 1.7, end: 2 },
    { text: 'Vivo', start: 3, end: 3.3 },
  ];
  assert.deepEqual(E.findPhrase(words, new Set([5]), 'vivo'), [[0, 0], [3, 3]]);
  const r = E.replaceAll(words, new Set([5]), new Set(), 'vivo', 'Veo');
  assert.equal(r.count, 2);
  assert.deepEqual(r.words.map((w) => w.text), ['Veo', '3.1', 'or', 'Veo,', 'model', 'Vivo']);
  assert.equal(r.words[3].start, 1.3);
  assert.equal(r.words[0].speaker, 'a');
  assert.deepEqual([...r.deleted], [5]);
  const multi = E.replaceAll(words, new Set(), new Set(), 'Vivo 3.1', 'Veo 3.1');
  assert.equal(multi.words[0].text, 'Veo');
  assert.deepEqual(E.applyWordList(words, [['vivo', 'Veo']]).map((w) => w.text)[5], 'Veo');
});
