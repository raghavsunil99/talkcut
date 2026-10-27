/* global CutlineEdits */
// Extra timeline tracks above and below the main clip.
//   overlay tracks: videos, images and text drawn over the picture (later tracks on top)
//   audio tracks:   music and sound effects mixed with the voice
// Items are anchored to a time in the original media (`start`), so they stay with the words
// under them when other parts are cut; `length` is seconds of edited (output) time.
(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./edits.js') : root.CutlineEdits;

  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  let counter = 0;
  const newId = (prefix) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  function clampBox(b) {
    const box = { ...FULL, ...(b || {}) };
    box.w = Math.min(4, Math.max(0.02, Number(box.w) || 1));
    box.h = Math.min(4, Math.max(0.02, Number(box.h) || 1));
    box.x = Math.min(1, Math.max(-box.w + 0.02, Number(box.x) || 0));
    box.y = Math.min(1, Math.max(-box.h + 0.02, Number(box.y) || 0));
    return box;
  }

  function normalizeItem(item, type) {
    const it = { ...item };
    it.id = it.id || newId('i');
    it.start = Number(it.start) || 0;
    it.length = Math.max(0.1, Number(it.length) || 3);
    it.offset = Math.max(0, Number(it.offset) || 0);
    if (type === 'overlay') {
      it.box = clampBox(it.box);
      it.opacity = Math.min(1, Math.max(0, it.opacity ?? 1));
      it.volume = Math.min(2, Math.max(0, it.volume ?? 0)); // overlay videos are silent unless turned up
      it.fit = it.fit === 'contain' ? 'contain' : 'cover'; // fill the box (crop) or fit inside it
      it.fadeIn = Math.min(5, Math.max(0, Number(it.fadeIn) || 0));
      it.fadeOut = Math.min(5, Math.max(0, Number(it.fadeOut) || 0));
    } else {
      it.volume = Math.min(2, Math.max(0, it.volume ?? 1));
      it.duck = it.duck !== false; // music gets quieter while someone speaks
    }
    return it;
  }

  function makeTrack(type, name) {
    return { id: newId('t'), type, name, hidden: false, muted: false, items: [] };
  }

  function normalize(tracks) {
    return (Array.isArray(tracks) ? tracks : [])
      .filter((t) => t && (t.type === 'overlay' || t.type === 'audio'))
      .map((t) => ({
        id: t.id || newId('t'),
        type: t.type,
        name: String(t.name || (t.type === 'audio' ? 'Audio' : 'Overlay')).slice(0, 40),
        hidden: Boolean(t.hidden),
        muted: Boolean(t.muted),
        items: (t.items ?? []).map((i) => normalizeItem(i, t.type)),
      }));
  }

  // Projects from before tracks kept B-roll in a single list.
  function fromBroll(broll) {
    if (!broll?.length) return [];
    const t = makeTrack('overlay', 'B-roll');
    t.items = broll.map((b) => normalizeItem({ ...b, box: FULL }, 'overlay'));
    return [t];
  }

  // A default name that is not taken: "Overlay 2", "Audio 3"…
  function nextName(tracks, type) {
    const base = type === 'audio' ? 'Audio' : 'Overlay';
    for (let n = 1; ; n++) {
      const name = `${base} ${n}`;
      if (!tracks.some((t) => t.name === name)) return name;
    }
  }

  function addTrack(tracks, type) {
    return [...tracks, makeTrack(type, nextName(tracks, type))];
  }

  // Put an item on the first track of its type that is free at that time, adding a track
  // when every one is busy.
  function insert(tracks, type, item, kept, total) {
    const it = normalizeItem(item, type);
    const s = E.toEdited(kept, it.start);
    const busy = (t) => t.items.some((x) => {
      const xs = E.toEdited(kept, x.start);
      return s < xs + x.length && xs < s + it.length;
    });
    let list = tracks.map((t) => ({ ...t, items: [...t.items] }));
    let track = list.find((t) => t.type === type && !busy(t));
    if (!track) {
      list = addTrack(list, type);
      track = list[list.length - 1];
    }
    track.items.push(it);
    return { tracks: list, trackId: track.id, itemId: it.id };
  }

  function update(tracks, itemId, change) {
    return tracks.map((t) => (t.items.some((i) => i.id === itemId)
      ? { ...t, items: t.items.map((i) => (i.id === itemId ? normalizeItem({ ...i, ...change, box: change.box ? { ...i.box, ...change.box } : i.box }, t.type) : i)) }
      : t));
  }

  function remove(tracks, itemId) {
    return tracks.map((t) => ({ ...t, items: t.items.filter((i) => i.id !== itemId) }));
  }

  // Move an item to another track of the same type.
  function move(tracks, itemId, toTrackId) {
    const from = tracks.find((t) => t.items.some((i) => i.id === itemId));
    const to = tracks.find((t) => t.id === toTrackId);
    if (!from || !to || from.id === to.id || from.type !== to.type) return tracks;
    const item = from.items.find((i) => i.id === itemId);
    return tracks.map((t) => {
      if (t.id === from.id) return { ...t, items: t.items.filter((i) => i.id !== itemId) };
      if (t.id === to.id) return { ...t, items: [...t.items, item] };
      return t;
    });
  }

  function setTrack(tracks, trackId, change) {
    return tracks.map((t) => (t.id === trackId ? { ...t, ...change } : t));
  }

  function removeTrack(tracks, trackId) {
    return tracks.filter((t) => t.id !== trackId);
  }

  function find(tracks, itemId) {
    for (const t of tracks) {
      const item = t.items.find((i) => i.id === itemId);
      if (item) return { track: t, item };
    }
    return null;
  }

  // Items placed on the edited timeline (startE, length clamped to the edit's end).
  function placed(tracks, kept) {
    const total = E.totalLength(kept);
    return tracks.map((t) => ({
      ...t,
      items: t.items
        .map((i) => {
          const startE = E.toEdited(kept, i.start);
          return { ...i, startE, length: Math.max(0, Math.min(i.length, total - startE)) };
        })
        .filter((i) => i.length > 0.05),
    }));
  }

  // What the export draws and mixes, in edited seconds. Overlays bottom to top.
  function forExport(tracks, kept) {
    const out = { overlays: [], audio: [] };
    for (const t of placed(tracks, kept)) {
      if (t.type === 'overlay' && !t.hidden) {
        for (const i of t.items) {
          out.overlays.push({ path: i.path, kind: i.kind, text: i.text, style: i.style, start: i.startE, end: i.startE + i.length, offset: i.offset, box: i.box, opacity: i.opacity, volume: t.muted ? 0 : i.volume, fit: i.fit, fadeIn: i.fadeIn, fadeOut: i.fadeOut });
        }
      } else if (t.type === 'audio' && !t.muted) {
        for (const i of t.items) out.audio.push({ path: i.path, start: i.startE, end: i.startE + i.length, offset: i.offset, volume: i.volume, duck: i.duck });
      }
    }
    return out;
  }

  // Where an overlay goes for each placement choice (box as fractions of the frame).
  // `aspect` is the picture's width / height relative to the frame's.
  const PLACEMENTS = {
    full: { label: 'Full frame', box: () => ({ x: 0, y: 0, w: 1, h: 1 }), fit: 'cover' },
    'split-top': { label: 'Top half', box: () => ({ x: 0, y: 0, w: 1, h: 0.5 }), fit: 'cover' },
    'split-bottom': { label: 'Bottom half', box: () => ({ x: 0, y: 0.5, w: 1, h: 0.5 }), fit: 'cover' },
    'pip-tr': { label: 'Corner, top right', box: (a) => corner(a, 1, 0), fit: 'cover' },
    'pip-tl': { label: 'Corner, top left', box: (a) => corner(a, 0, 0), fit: 'cover' },
    'pip-br': { label: 'Corner, bottom right', box: (a) => corner(a, 1, 1), fit: 'cover' },
    'pip-bl': { label: 'Corner, bottom left', box: (a) => corner(a, 0, 1), fit: 'cover' },
    center: { label: 'Centre, fitted', box: () => ({ x: 0.1, y: 0.25, w: 0.8, h: 0.5 }), fit: 'contain' },
  };
  function corner(aspect, right, bottom) {
    const w = 0.42;
    const h = Math.min(0.6, w / (aspect || 1));
    const m = 0.04;
    return { x: right ? 1 - w - m : m, y: bottom ? 1 - h - m * 2.5 : m * 2.5, w, h };
  }
  function placement(name, aspect) {
    const p = PLACEMENTS[name] ?? PLACEMENTS.full;
    return { box: p.box(aspect), fit: p.fit };
  }

  // Opacity of an overlay at time `local` seconds into it, with its fades.
  function fadeAt(item, local) {
    let a = item.opacity ?? 1;
    if (item.fadeIn > 0 && local < item.fadeIn) a *= Math.max(0, local / item.fadeIn);
    if (item.fadeOut > 0 && local > item.length - item.fadeOut) a *= Math.max(0, (item.length - local) / item.fadeOut);
    return a;
  }

  // Everything active at edited time e, for the preview.
  function activeAt(tracks, kept, e) {
    const out = [];
    for (const t of placed(tracks, kept)) {
      for (const i of t.items) if (e >= i.startE && e < i.startE + i.length) out.push({ track: t, item: i });
    }
    return out;
  }

  const api = { FULL, newId, clampBox, normalize, normalizeItem, fromBroll, addTrack, insert, update, remove, move, setTrack, removeTrack, find, placed, forExport, activeAt, nextName, PLACEMENTS, placement, fadeAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CutlineTracks = api;
})(typeof window !== 'undefined' ? window : globalThis);
