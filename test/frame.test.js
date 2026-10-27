const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/renderer/frame.js');

test('defaults keep the source as it is', () => {
  const l = F.layout(1080, 1920, null);
  assert.deepEqual(l.frame, { w: 1080, h: 1920 });
  assert.deepEqual(l.draw, { w: 1080, h: 1920, x: 0, y: 0 });
  assert.deepEqual(l.crop, { x: 0, y: 0, w: 1080, h: 1920 });
  assert.ok(F.isDefault({}));
});

test('a portrait clip in a square frame fits and is centred', () => {
  const l = F.layout(1080, 1920, { canvas: '1:1' });
  assert.deepEqual(l.frame, { w: 1080, h: 1080 });
  assert.equal(l.draw.h, 1080);
  assert.equal(l.draw.w, 608);
  assert.equal(l.draw.x, 236);
});

test('crop, scale and position move the picture', () => {
  const l = F.layout(1920, 1080, { canvas: '9:16', crop: { l: 0.25, r: 0.25 }, scale: 1, y: 0.1 });
  assert.deepEqual(l.crop, { x: 480, y: 0, w: 960, h: 1080 });
  assert.equal(l.draw.w, 1080);
  assert.equal(l.draw.h, 1216);
  assert.equal(l.draw.y, Math.round((1920 - 1216) / 2 + 192));
  const bigger = F.layout(1920, 1080, { canvas: '9:16', scale: 2 });
  assert.ok(bigger.draw.w > 1080 && bigger.draw.x < 0, 'zoomed in past the frame edges');
});

test('rotation by 90 swaps the picture shape', () => {
  const l = F.layout(1920, 1080, { rotate: 90 });
  assert.deepEqual(l.frame, { w: 1080, h: 1920 });
});

test('values are clamped and atempo chains past its 0.5..2 range', () => {
  const p = F.normalize({ speed: 9, volume: -1, rotate: 45, crop: { l: 0.9 }, canvas: 'nope', background: 'red' });
  assert.deepEqual([p.speed, p.volume, p.rotate, p.crop.l, p.canvas, p.background], [4, 0, 0, 0.9, 'original', '#000000']);
  assert.equal(F.atempoChain(1.5), 'atempo=1.5000');
  assert.equal(F.atempoChain(3), 'atempo=2,atempo=1.5000');
  assert.equal(F.atempoChain(0.25), 'atempo=0.5,atempo=0.5000');
});

test('autoFrame fills 9:16 and moves a wide picture so the face is centred', () => {
  // 1920x1080 source, face on the right third
  const p = F.autoFrame(1920, 1080, null, { x: 0.7, y: 0.4 });
  assert.equal(p.canvas, '9:16');
  const L = F.layout(1920, 1080, p);
  assert.ok(L.draw.h >= L.frame.h - 2 && L.draw.w >= L.frame.w, 'picture covers the frame');
  const faceX = L.draw.x + 0.7 * L.draw.w;
  assert.ok(Math.abs(faceX - L.frame.w / 2) < 4, `face centred, at ${faceX}`);
  // A face at the far edge is clamped: the picture never leaves a gap.
  const edge = F.layout(1920, 1080, F.autoFrame(1920, 1080, null, { x: 0.99, y: 0.5 }));
  assert.ok(edge.draw.x + edge.draw.w >= edge.frame.w - 2 && edge.draw.x <= 0);
});

test('faceCentre takes the median of the biggest face per frame', () => {
  const frames = [
    { faces: [{ x: 0.4, y: 0.2, w: 0.2, h: 0.2 }, { x: 0, y: 0, w: 0.05, h: 0.05 }] },
    { faces: [{ x: 0.42, y: 0.22, w: 0.2, h: 0.2 }] },
    { faces: [] },
    { faces: [{ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }] },
  ];
  const c = F.faceCentre(frames);
  assert.equal(c.found, 3);
  assert.ok(Math.abs(c.x - 0.52) < 1e-9 && Math.abs(c.y - 0.32) < 1e-9, JSON.stringify(c));
  assert.equal(F.faceCentre([{ faces: [] }, { faces: [] }, { faces: [] }]), null);
});

test('custom canvas sizes are even and clamped; flips and blur are kept', () => {
  const L = F.layout(1920, 1080, { canvas: 'custom', customW: 1001, customH: 99999 });
  assert.deepEqual(L.frame, { w: 1002, h: 4096 });
  const p = F.normalize({ flipH: 1, bgMode: 'blur', canvas: '4:3' });
  assert.equal(p.flipH, true);
  assert.equal(p.bgMode, 'blur');
  assert.deepEqual(F.layout(1920, 1080, p).frame, { w: 1440, h: 1080 });
  assert.equal(F.normalize({ bgMode: 'stripes' }).bgMode, 'color');
});

test('crop boxes convert between the source and the turned, flipped picture', () => {
  const crop = { l: 0.1, t: 0.2, r: 0.3, b: 0.05 };
  for (const rotate of [0, 90, 180, 270]) {
    for (const flipH of [false, true]) {
      const t = { rotate, flipH, flipV: rotate === 90 };
      const back = F.displayToCrop(F.cropToDisplay(crop, t), t);
      for (const k of ['l', 't', 'r', 'b']) assert.ok(Math.abs(back[k] - crop[k]) < 1e-3, `${rotate} ${flipH} ${k}: ${back[k]}`);
    }
  }
  // turned right, the source's left edge is at the top
  const d = F.cropToDisplay({ l: 0.5, t: 0, r: 0, b: 0 }, { rotate: 90 });
  assert.deepEqual(d, { x: 0, y: 0.5, w: 1, h: 0.5 });
  assert.equal(F.normalize({ crop: { l: 0.7, r: 0.7 } }).crop.r.toFixed(2), '0.25');
});
