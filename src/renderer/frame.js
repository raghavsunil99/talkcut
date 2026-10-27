// Clip properties (speed, volume, crop, frame size, scale, position, rotation) and the frame
// layout they produce. Shared by the preview (renderer) and the export (main) so both agree.
(function (root) {
  // Output frame shapes. "original" keeps the cropped, rotated source shape.
  const CANVASES = {
    original: { label: 'Original' },
    '9:16': { label: '9:16', hint: 'Reels, Shorts, TikTok', w: 1080, h: 1920 },
    '1:1': { label: '1:1', hint: 'Square post', w: 1080, h: 1080 },
    '4:5': { label: '4:5', hint: 'Instagram portrait', w: 1080, h: 1350 },
    '16:9': { label: '16:9', hint: 'YouTube', w: 1920, h: 1080 },
    '4:3': { label: '4:3', hint: 'Classic', w: 1440, h: 1080 },
    '3:4': { label: '3:4', hint: 'Tall', w: 1080, h: 1440 },
    '21:9': { label: '21:9', hint: 'Cinema', w: 2520, h: 1080 },
    custom: { label: 'Custom', hint: 'Your own size' },
  };

  const DEFAULTS = {
    speed: 1,
    volume: 1, // 0..2
    muted: false,
    enhance: false, // Studio Sound: voice cleanup
    canvas: 'original',
    scale: 1, // 1 = fit inside the frame
    x: 0, // offset as a fraction of the frame width
    y: 0, // offset as a fraction of the frame height
    rotate: 0, // 0, 90, 180, 270
    crop: { l: 0, t: 0, r: 0, b: 0 }, // fractions trimmed from each side of the source
    background: '#000000',
    bgMode: 'color', // 'color' or 'blur' (a blurred, zoomed copy of the video fills the frame)
    flipH: false,
    flipV: false,
    customW: 1080,
    customH: 1920,
  };

  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  function normalize(p) {
    const s = { ...DEFAULTS, ...(p || {}), crop: { ...DEFAULTS.crop, ...(p?.crop || {}) } };
    s.speed = clamp(s.speed, 0.25, 4, 1);
    s.volume = clamp(s.volume, 0, 2, 1);
    s.muted = Boolean(s.muted);
    s.enhance = Boolean(s.enhance);
    if (!CANVASES[s.canvas]) s.canvas = 'original';
    s.scale = clamp(s.scale, 0.1, 4, 1);
    s.x = clamp(s.x, -1, 1, 0);
    s.y = clamp(s.y, -1, 1, 0);
    s.rotate = [0, 90, 180, 270].includes(Number(s.rotate)) ? Number(s.rotate) : 0;
    for (const k of ['l', 't', 'r', 'b']) s.crop[k] = clamp(s.crop[k], 0, 0.9, 0);
    // keep at least 5% of the picture each way
    if (s.crop.l + s.crop.r > 0.95) s.crop.r = 0.95 - s.crop.l;
    if (s.crop.t + s.crop.b > 0.95) s.crop.b = 0.95 - s.crop.t;
    if (!/^#[0-9a-f]{6}$/i.test(s.background)) s.background = '#000000';
    s.bgMode = s.bgMode === 'blur' ? 'blur' : 'color';
    s.flipH = Boolean(s.flipH);
    s.flipV = Boolean(s.flipV);
    s.customW = even(clamp(s.customW, 240, 4096, 1080));
    s.customH = even(clamp(s.customH, 240, 4096, 1920));
    return s;
  }

  function isDefault(p) {
    return JSON.stringify(normalize(p)) === JSON.stringify(normalize(null));
  }

  // Where everything goes, in output pixels.
  //   crop: the part of the source kept      frame: output size
  //   draw: where the (cropped, rotated, scaled) picture sits inside the frame
  function layout(srcW, srcH, props) {
    const p = normalize(props);
    const crop = {
      x: Math.round(srcW * p.crop.l),
      y: Math.round(srcH * p.crop.t),
      w: even(srcW * (1 - p.crop.l - p.crop.r)),
      h: even(srcH * (1 - p.crop.t - p.crop.b)),
    };
    const turned = p.rotate % 180 === 90;
    const picW = turned ? crop.h : crop.w;
    const picH = turned ? crop.w : crop.h;
    const c = p.canvas === 'custom' ? { w: p.customW, h: p.customH } : CANVASES[p.canvas];
    const frameW = c.w ?? picW;
    const frameH = c.h ?? picH;
    const fit = Math.min(frameW / picW, frameH / picH) * p.scale;
    const drawW = even(picW * fit);
    const drawH = even(picH * fit);
    return {
      props: p,
      crop,
      rotate: p.rotate,
      frame: { w: even(frameW), h: even(frameH) },
      draw: {
        w: drawW,
        h: drawH,
        x: Math.round((frameW - drawW) / 2 + p.x * frameW),
        y: Math.round((frameH - drawH) / 2 + p.y * frameH),
      },
    };
  }

  // Frame a talking head: fill the chosen frame shape and slide the picture so the face is
  // centred across and sits a little above the middle (`face` is its centre as fractions of
  // the source picture, before crop and rotation). The picture always covers the frame.
  function autoFrame(srcW, srcH, props, face, canvas = '9:16') {
    const p = normalize({ ...props, canvas, x: 0, y: 0, scale: 1 });
    // face position in the cropped, rotated picture
    let fx = (face.x - p.crop.l) / (1 - p.crop.l - p.crop.r);
    let fy = (face.y - p.crop.t) / (1 - p.crop.t - p.crop.b);
    if (p.rotate === 90) [fx, fy] = [1 - fy, fx];
    if (p.rotate === 180) [fx, fy] = [1 - fx, 1 - fy];
    if (p.rotate === 270) [fx, fy] = [fy, 1 - fx];
    const base = layout(srcW, srcH, p);
    const picW = base.draw.w;
    const picH = base.draw.h;
    const W = base.frame.w;
    const H = base.frame.h;
    const scale = Math.max(W / picW, H / picH);
    const drawW = picW * scale;
    const drawH = picH * scale;
    const slack = (len, frame) => Math.max(0, (len - frame) / 2) / frame;
    const x = Math.max(-slack(drawW, W), Math.min(slack(drawW, W), (drawW * (0.5 - fx)) / W));
    const y = Math.max(-slack(drawH, H), Math.min(slack(drawH, H), (H * 0.4 - fy * drawH - (H - drawH) / 2) / H));
    return normalize({ ...p, scale, x, y });
  }

  // Typical face position from detections across the video: the median centre of the
  // biggest face in each frame. Returns null when too few frames have a face.
  function faceCentre(frames) {
    const centres = frames
      .map((f) => (f.faces ?? []).slice().sort((a, b) => b.w * b.h - a.w * a.h)[0])
      .filter(Boolean)
      .map((f) => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 }));
    if (!frames.length || centres.length < Math.max(1, frames.length * 0.3)) return null;
    const median = (v) => { const s = v.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    return { x: median(centres.map((c) => c.x)), y: median(centres.map((c) => c.y)), found: centres.length, frames: frames.length };
  }

  // Crop as seen on screen. Crop values are stored on the source picture (before rotation
  // and flips); the crop box is drawn on the turned, flipped picture. Points are fractions.
  function toDisplayPoint([u, v], rotate, flipH, flipV) {
    let [x, y] = rotate === 90 ? [1 - v, u] : rotate === 180 ? [1 - u, 1 - v] : rotate === 270 ? [v, 1 - u] : [u, v];
    if (flipH) x = 1 - x;
    if (flipV) y = 1 - y;
    return [x, y];
  }
  function toSourcePoint([x, y], rotate, flipH, flipV) {
    if (flipH) x = 1 - x;
    if (flipV) y = 1 - y;
    return rotate === 90 ? [y, 1 - x] : rotate === 180 ? [1 - x, 1 - y] : rotate === 270 ? [1 - y, x] : [x, y];
  }
  function cropToDisplay(crop, { rotate = 0, flipH = false, flipV = false } = {}) {
    const a = toDisplayPoint([crop.l, crop.t], rotate, flipH, flipV);
    const b = toDisplayPoint([1 - crop.r, 1 - crop.b], rotate, flipH, flipV);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
  }
  function displayToCrop(rect, { rotate = 0, flipH = false, flipV = false } = {}) {
    const a = toSourcePoint([rect.x, rect.y], rotate, flipH, flipV);
    const b = toSourcePoint([rect.x + rect.w, rect.y + rect.h], rotate, flipH, flipV);
    const r4 = (v) => Math.round(Math.max(0, v) * 10000) / 10000;
    return { l: r4(Math.min(a[0], b[0])), t: r4(Math.min(a[1], b[1])), r: r4(1 - Math.max(a[0], b[0])), b: r4(1 - Math.max(a[1], b[1])) };
  }

  // atempo accepts 0.5..2 per stage, so larger changes chain several stages.
  function atempoChain(speed) {
    const parts = [];
    let s = speed;
    while (s > 2) { parts.push('atempo=2'); s /= 2; }
    while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
    parts.push(`atempo=${s.toFixed(4)}`);
    return parts.join(',');
  }

  const api = { CANVASES, DEFAULTS, normalize, isDefault, layout, atempoChain, autoFrame, faceCentre, cropToDisplay, displayToCrop };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CutlineFrame = api;
})(typeof window !== 'undefined' ? window : globalThis);
