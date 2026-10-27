const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../src/renderer/text.js');

const item = (over = {}) => ({ kind: 'text', text: 'Hello', style: { preset: 'title' }, box: { x: 0.1, y: 0.4, w: 0.8, h: 0.1 }, start: 1, end: 3, ...over });

test('styles combine the preset with the item overrides', () => {
  const s = X.styleOf(item({ style: { preset: 'callout', color: '#FF0000' } }));
  assert.equal(s.color, '#FF0000');
  assert.equal(s.bg, X.PRESETS.callout.bg);
  assert.deepEqual(X.linesOf(item({ text: 'a\nb', style: { preset: 'callout' } })), ['A', 'B']);
});

test('font size follows the box height and the number of lines', () => {
  assert.ok(X.fontPx(item(), 100) > X.fontPx(item({ text: 'a\nb' }), 100));
  assert.ok(X.fontPx(item(), 200) > X.fontPx(item(), 100));
});

test('ASS colour tags are BGR with a separate alpha', () => {
  assert.deepEqual(X.tagColor('#112233'), { color: '&H332211&', alpha: '&H00&' });
  assert.deepEqual(X.tagColor('rgba(0,0,0,0.5)'), { color: '&H000000&', alpha: '&H80&' });
});

test('buildAss places each text in its box, with a drawn box when the style has one', () => {
  const ass = X.buildAss([item(), item({ text: 'Name\nRole', style: { preset: 'lower' }, box: { x: 0.05, y: 0.7, w: 0.6, h: 0.1 } })], { width: 1080, height: 1920, language: 'en' });
  assert.match(ass, /PlayResX: 1080/);
  const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(lines.length, 3, 'title text, lower-third box and lower-third text');
  assert.match(lines[0], /\\an5\\pos\(540,864\)/);
  assert.match(lines[0], /0:00:01\.00,0:00:03\.00/);
  assert.match(lines[1], /\\p1}m /);
  assert.match(lines[2], /\\an4/);
  assert.match(lines[2], /Name\\N\{\\fs\d+/);
  assert.ok(!/[{}]/.test('Hello'.replace(/./g, '')));
});

test('braces in text cannot inject ASS tags', () => {
  const ass = X.buildAss([item({ text: 'a{\\pos(0,0)}b' })], { width: 100, height: 100 });
  const line = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
  assert.ok(line.endsWith('a(＼pos(0,0))b'), line);
});

test('text shrinks to fit the width of its box', () => {
  const long = { kind: 'text', text: 'Top 5 job portals for freshers', style: { preset: 'callout' } };
  assert.ok(X.fontPx(long, 100, 400) < X.fontPx(long, 100), 'narrow box gives smaller text');
  assert.ok(X.fontPx({ ...long, text: 'Hi' }, 100, 400) === X.fontPx({ ...long, text: 'Hi' }, 100), 'short text keeps the height-based size');
});
