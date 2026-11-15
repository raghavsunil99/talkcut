const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/renderer/edits.js');
const S = require('../src/renderer/scenes.js');

const WORDS = E.ensureIds(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].map((text, i) => ({ text, start: i, end: i + 0.5 })));
const none = new Set();

test('scenes are word ranges in play order, with an opening part before the first', () => {
  assert.deepEqual(S.ranges(WORDS, []), []);
  let scenes = S.add(WORDS, [], 2);
  scenes = S.add(WORDS, scenes, 5, 'Outro');
  assert.deepEqual(scenes, [{ id: 3, title: 'Scene 1' }, { id: 6, title: 'Outro' }]);
  assert.deepEqual(S.ranges(WORDS, scenes).map((r) => [r.title, r.from, r.to]), [['', 0, 1], ['Scene 1', 2, 4], ['Outro', 5, 7]]);
  assert.equal(S.add(WORDS, scenes, 2), scenes, 'one scene per word');
  assert.deepEqual(S.ranges(WORDS, S.rename(scenes, 3, '  Setup ')).map((r) => r.title), ['', 'Setup', 'Outro']);
  assert.deepEqual(S.ranges(WORDS, S.remove(scenes, 3)).map((r) => [r.from, r.to]), [[0, 4], [5, 7]]);
});

test('moving a scene moves its words, and the scenes follow by word id', () => {
  const scenes = [{ id: 1, title: 'A' }, { id: 4, title: 'B' }, { id: 7, title: 'C' }];
  // C before A.
  const r = S.move(WORDS, none, none, null, 8, scenes, 2, 0);
  assert.equal(r.words.map((w) => w.text).join(' '), 'seven eight one two three four five six');
  assert.deepEqual(S.ranges(r.words, scenes).map((x) => [x.title, x.from, x.to]), [['C', 0, 1], ['A', 2, 4], ['B', 5, 7]]);
  // Then A to the end.
  const r2 = S.move(r.words, r.deleted, r.cutGaps, r.order, 8, scenes, 1, 3);
  assert.equal(r2.words.map((w) => w.text).join(' '), 'seven eight four five six one two three');
  assert.deepEqual(r2.order, [[6, 8], [3, 6], [0, 3]]);
  assert.equal(S.move(r.words, r.deleted, r.cutGaps, r.order, 8, scenes, 2, 3), null, 'B is already last');
  assert.equal(S.move(WORDS, none, none, null, 8, scenes, 1, 2), null, 'to where it already is');
  // Moving a scene above the untitled opening part names the opening, so its words stay apart.
  const late = [{ id: 5, title: 'End' }];
  const m = S.move(WORDS, none, none, null, 8, late, 1, 0);
  assert.equal(m.words.map((w) => w.text).join(' '), 'five six seven eight one two three four');
  assert.deepEqual(S.ranges(m.words, m.scenes).map((x) => [x.title, x.from, x.to]), [['End', 0, 3], ['Opening', 4, 7]]);
});

test('saved scenes keep only valid entries', () => {
  assert.deepEqual(S.normalize([{ id: 3, title: 'X' }, { id: 'a' }, null, { id: 4 }]), [{ id: 3, title: 'X' }, { id: 4, title: '' }]);
  assert.deepEqual(S.ranges(WORDS, [{ id: 99, title: 'gone' }]), []);
});
