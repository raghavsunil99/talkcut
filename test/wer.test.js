const test = require('node:test');
const assert = require('node:assert/strict');
const { words, editDistance, wordErrors, wer } = require('../scripts/lib/wer.js');

test('identical text has no errors, case and punctuation ignored', () => {
  assert.deepEqual(wordErrors('Hello, World!', 'hello world'), { errors: 0, total: 2 });
});

test('English: one substitution, one deletion, one insertion', () => {
  // ref "the cat sat on the mat" vs hyp "the dog sat on mat today": cat->dog, the deleted, today added
  assert.deepEqual(wordErrors('the cat sat on the mat', 'the dog sat on mat today'), { errors: 3, total: 6 });
});

test('Telugu: one wrong word out of four is 25%', () => {
  const ref = 'నేను రేపు ఇంటికి వస్తాను';
  const hyp = 'నేను రేపు ఇంటికి వెళ్తాను';
  assert.equal(wer([[ref, hyp]]), 0.25);
});

test('vowel signs matter: ది and దే are different words', () => {
  // If normalize() stripped combining marks both would collapse to "ద" and score 0.
  assert.equal(words('ది')[0], 'ది');
  assert.deepEqual(wordErrors('ది దే', 'దే దే'), { errors: 1, total: 2 });
});

test('empty hypothesis is 100%, empty reference gives null', () => {
  assert.equal(wer([['a b c', '']]), 1);
  assert.equal(wer([['', 'x']]), null);
});

test('corpus WER pools words across clips', () => {
  // clip 1: 1 error in 1 word; clip 2: 0 errors in 3 words -> 1/4, not the mean of 100% and 0%
  assert.equal(wer([['a', 'b'], ['x y z', 'x y z']]), 0.25);
});

test('editDistance basics', () => {
  assert.equal(editDistance([], ['a', 'b']), 2);
  assert.equal(editDistance(['a', 'b'], []), 2);
  assert.equal(editDistance(['a', 'b', 'c'], ['a', 'c']), 1);
});
