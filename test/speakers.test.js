const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/renderer/speakers.js');
const cloud = require('../src/cloud.js');

test('cloud words keep the speaker id', () => {
  const { words } = cloud.toWords({ words: [{ type: 'word', text: 'hi', start: 0, end: 0.3, speaker_id: 'speaker_1' }] });
  assert.equal(words[0].speaker, 'speaker_1');
});

test('speakers are named in order of appearance, and dropped when only one is heard', () => {
  const words = [{ text: 'a', speaker: 'speaker_1' }, { text: 'b', speaker: 'speaker_0' }, { text: 'c', speaker: 'speaker_1' }];
  assert.deepEqual(S.fromTranscript(words).speakers, { speaker_1: 'Speaker 1', speaker_0: 'Speaker 2' });
  const one = S.fromTranscript([{ text: 'a', speaker: 'x' }, { text: 'b', speaker: 'x' }]);
  assert.deepEqual(one.speakers, {});
  assert.equal(one.words[0].speaker, undefined);
});

test('assign, newId and prune', () => {
  const words = S.assign([{ text: 'a' }, { text: 'b' }, { text: 'c' }], 1, 2, 's1');
  assert.deepEqual(words.map((w) => w.speaker), [undefined, 's1', 's1']);
  assert.equal(S.newId({ s1: 'A', s2: 'B' }), 's3');
  assert.deepEqual(S.prune(words, { s1: 'Raghav', s2: 'Guest' }), { s1: 'Raghav' });
});
