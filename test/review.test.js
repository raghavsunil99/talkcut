// Review before cutting (2.5): filler lists per language, sounds with no word, the proposals
// list and applying it, and the adjustable silence kept in shortened pauses.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/renderer/edits.js');
const R = require('../src/renderer/review.js');

const tel = (list) => E.ensureIds(list.map(([text, start]) => ({ text, start, end: start + 0.4 })));
// నేను ఊ అంటే రేపు వస్తాను, with a 1.5 s pause after రేపు.
const WORDS = tel([['నేను', 0.2], ['ఊ', 0.8], ['అంటే', 1.4], ['రేపు', 2.0], ['వస్తాను', 3.9]]);
const none = new Set();

test('filler lists: sounds are on, words that are sometimes real are off until chosen', () => {
  const set = R.fillerSet('te');
  assert.ok(set.has('ఊ') && set.has('um'), 'Telugu and English sounds');
  assert.ok(!set.has('అంటే'), 'అంటే is a real word too: not by default');
  assert.deepEqual(E.fillerIndices(WORDS, set), [1]);
  const chosen = R.fillerSet('te', { te: { on: ['అంటే'], off: ['ఊ'], extra: ['ఏదో'] } });
  assert.ok(chosen.has('అంటే') && chosen.has('ఏదో') && !chosen.has('ఊ'));
  assert.deepEqual(E.fillerIndices(WORDS, chosen), [2]);
  assert.ok(!R.fillerSet('hi').has('मतलब'));
  assert.ok(R.fillerSet('hi', { hi: { on: ['मतलब'] } }).has('मतलब'));
  for (const lang of ['te', 'hi', 'ta', 'kn', 'ml']) {
    for (const w of R.FILLER_WORDS[lang].sounds) assert.equal(E.normalize(w), w, `${lang} ${w} survives normalize (vowel signs kept)`);
  }
});

test('proposals list fillers, retakes and pauses with context, and one apply cuts the ticked ones', () => {
  const items = R.proposals({ words: WORDS, deleted: none, cutGaps: none, duration: 5, kinds: ['filler', 'pause'], fillers: R.fillerSet('te', { te: { on: ['అంటే'] } }), minPause: 1 });
  assert.deepEqual(items.map((it) => [it.kind, it.text]), [['filler', 'ఊ'], ['filler', 'అంటే'], ['pause', 'pause 1.5 s']]);
  assert.equal(items[0].before, 'నేను');
  assert.equal(items[0].after, 'అంటే రేపు వస్తాను');
  assert.ok(Math.abs(items[2].saves - 1.3) < 1e-9, 'a 1.5 s pause keeping 0.2 s saves 1.3 s');
  items[1].checked = false; // keep అంటే
  const r = R.apply(items, { deleted: none, cutGaps: none, rangeCuts: [] });
  assert.deepEqual([...r.deleted], [1]);
  assert.deepEqual([...r.cutGaps], [3]);
  // Already cut or already shortened: not proposed again.
  assert.equal(R.proposals({ words: WORDS, deleted: new Set([1]), cutGaps: new Set([3]), duration: 5, kinds: ['filler', 'pause'], fillers: R.fillerSet('te'), minPause: 1 }).length, 0);
});

test('a word in a proposed retake is not listed again as a filler', () => {
  const words = tel([['I', 0], ['went', 0.5], ['um', 1.0], ['to', 1.5], ['the', 2.0], ['I', 3.0], ['went', 3.5], ['to', 4.0], ['the', 4.5], ['market', 5.0]]);
  const items = R.proposals({ words, deleted: none, cutGaps: none, duration: 6, kinds: ['retake', 'filler'], fillers: R.fillerSet('en') });
  assert.deepEqual(items.map((it) => it.kind), ['retake']);
  assert.ok(items[0].idx.includes(2));
});

test('sounds with no word: found between words, not at word edges, not too long, not already cut', () => {
  const perSecond = 50;
  const peaks = new Array(8 * perSecond).fill(0.005);
  const loud = (a, b, v = 0.4) => { for (let f = Math.round(a * perSecond); f < Math.round(b * perSecond); f++) peaks[f] = v; };
  const words = tel([['one', 0.2], ['two', 2.0]]); // 0.2–0.6 and 2.0–2.4
  loud(0.2, 0.68); // the word, and a tail running 0.08 s past its end (within the margin)
  loud(2.0, 2.4);
  loud(1.0, 1.3); // an "aa" with no word
  loud(3.0, 4.6); // 1.6 s of sound with no word: too long to be a filler (missed speech)
  loud(5.0, 5.4); // another, but this stretch is already cut
  loud(6.5, 6.53); // a click: too short
  const found = R.wordlessSounds({ words, peaks, perSecond, duration: 8, cuts: [[4.9, 5.5]] });
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.ok(found[0][0] > 0.9 && found[0][0] < 1.0 && found[0][1] > 1.3 && found[0][1] < 1.4, JSON.stringify(found));
  assert.deepEqual(R.wordlessSounds({ words, peaks: null, perSecond, duration: 8 }), [], 'no waveform yet');
  // Sounds become time cuts.
  const items = R.proposals({ words, deleted: none, cutGaps: none, duration: 8, kinds: ['sound'], sounds: found });
  assert.equal(items[0].before, 'one');
  assert.equal(items[0].after, 'two');
  const r = R.apply(items, { deleted: none, cutGaps: none, rangeCuts: [[7, 7.5]] });
  assert.deepEqual(r.rangeCuts, [found[0], [7, 7.5]]);
});

test('the silence kept in a shortened pause can be changed; the default is as before', () => {
  const cut = (keep) => E.computeCuts(WORDS, none, 5, new Set([3]), [], null, keep);
  assert.deepEqual(cut(undefined), E.computeCuts(WORDS, none, 5, new Set([3])));
  const [a, b] = cut(undefined)[0];
  assert.ok(Math.abs(b - a - 1.3) < 1e-9, 'keeps 0.2 s by default');
  const [c, d] = cut(0.5)[0];
  assert.ok(Math.abs(d - c - 1.0) < 1e-9, 'keeps 0.5 s');
  assert.ok(Math.abs(c - 2.65) < 1e-9, 'split evenly either side');
});
