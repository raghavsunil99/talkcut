const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/renderer/tracks.js');

const kept = [[0, 10], [12, 20]]; // 18 s of edit, 2 s cut at 10-12

test('insert puts items on a free track and adds a track when all are busy', () => {
  let r = T.insert([], 'overlay', { path: '/a.mp4', kind: 'video', start: 2, length: 4 }, kept);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.tracks[0].name, 'Overlay 1');
  r = T.insert(r.tracks, 'overlay', { path: '/b.png', kind: 'image', start: 3, length: 3 }, kept); // overlaps
  assert.equal(r.tracks.length, 2);
  assert.equal(r.tracks[1].name, 'Overlay 2');
  r = T.insert(r.tracks, 'overlay', { path: '/c.png', kind: 'image', start: 8, length: 1 }, kept); // free on track 1
  assert.equal(r.tracks[0].items.length, 2);
  r = T.insert(r.tracks, 'audio', { path: '/m.mp3', start: 0, length: 18 }, kept);
  assert.equal(r.tracks.at(-1).type, 'audio');
  assert.equal(r.tracks.at(-1).items[0].duck, true);
});

test('items default sensibly and are clamped', () => {
  const o = T.normalizeItem({ box: { w: 9, x: -9 }, opacity: 3 }, 'overlay');
  assert.deepEqual([o.box.w, o.opacity, o.volume], [4, 1, 0]);
  assert.ok(o.box.x >= -o.box.w);
  const a = T.normalizeItem({ volume: 5, duck: false }, 'audio');
  assert.deepEqual([a.volume, a.duck], [2, false]);
});

test('update, move, remove and track settings', () => {
  let { tracks, itemId } = T.insert([], 'overlay', { path: '/a.mp4', kind: 'video', start: 1, length: 2 }, kept);
  tracks = T.addTrack(tracks, 'overlay');
  tracks = T.update(tracks, itemId, { box: { x: 0.5, w: 0.4 }, opacity: 0.5 });
  const found = T.find(tracks, itemId);
  assert.deepEqual([found.item.box.x, found.item.box.w, found.item.box.h, found.item.opacity], [0.5, 0.4, 1, 0.5]);
  tracks = T.move(tracks, itemId, tracks[1].id);
  assert.equal(T.find(tracks, itemId).track.id, tracks[1].id);
  tracks = T.setTrack(tracks, tracks[1].id, { hidden: true });
  assert.equal(T.forExport(tracks, kept).overlays.length, 0, 'hidden tracks are not exported');
  tracks = T.remove(tracks, itemId);
  assert.equal(T.find(tracks, itemId), null);
});

test('placement follows cuts and export lists overlays bottom to top', () => {
  let r = T.insert([], 'overlay', { path: '/low.mp4', kind: 'video', start: 13, length: 3 }, kept);
  r = T.insert(r.tracks, 'overlay', { path: '/high.png', kind: 'image', start: 13, length: 3 }, kept);
  r = T.insert(r.tracks, 'audio', { path: '/m.mp3', start: 19, length: 5 }, kept);
  const out = T.forExport(r.tracks, kept);
  assert.deepEqual(out.overlays.map((o) => o.path), ['/low.mp4', '/high.png']);
  assert.equal(out.overlays[0].start, 11); // source 13 is edited 11 after the 2 s cut
  assert.equal(out.audio[0].end - out.audio[0].start, 1); // starts at edited 17 s, clamped to the 18 s edit
  assert.equal(T.activeAt(r.tracks, kept, 12).length, 2);
});

test('old single-list B-roll becomes one overlay track at full frame', () => {
  const tracks = T.fromBroll([{ id: 'b1', path: '/x.mp4', kind: 'video', start: 2, length: 3, offset: 1 }]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].name, 'B-roll');
  assert.deepEqual(tracks[0].items[0].box, T.FULL);
  assert.equal(tracks[0].items[0].offset, 1);
});

test('placements, fit and fades', () => {
  const pip = T.placement('pip-br', 16 / 9 / (9 / 16));
  assert.ok(pip.box.x > 0.5 && pip.box.y > 0.5 && pip.box.w < 0.5);
  assert.deepEqual(T.placement('split-top').box, { x: 0, y: 0, w: 1, h: 0.5 });
  const it = T.normalizeItem({ fit: 'weird', fadeIn: 9, fadeOut: 0.5, length: 4 }, 'overlay');
  assert.equal(it.fit, 'cover');
  assert.equal(it.fadeIn, 5);
  assert.equal(T.fadeAt({ opacity: 1, fadeIn: 1, fadeOut: 1, length: 4 }, 0.5), 0.5);
  assert.equal(T.fadeAt({ opacity: 0.8, fadeIn: 1, fadeOut: 1, length: 4 }, 2), 0.8);
  assert.equal(T.fadeAt({ opacity: 1, fadeIn: 0, fadeOut: 1, length: 4 }, 3.75), 0.25);
});
