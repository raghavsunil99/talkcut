// Scenes: named parts of the script, like chapters. A scene starts at a word (kept by the word's
// id, so it survives moves and corrections) and runs to the next scene's start. Reordering scenes
// moves their words with Edits.moveWords. Pure logic, shared with the tests.
(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./edits.js') : root.CutlineEdits;

  // The project's scenes as word ranges in play order: [{ id, title, from, to }]. Words before the
  // first scene form an untitled opening part (id null). No scenes: an empty list.
  function ranges(words, scenes) {
    if (!scenes?.length || !words.length) return [];
    const index = new Map(words.map((w, i) => [w.id, i]));
    const starts = scenes
      .map((s) => ({ id: s.id, title: String(s.title ?? ''), from: index.get(s.id) }))
      .filter((s) => s.from != null)
      .sort((a, b) => a.from - b.from)
      .filter((s, k, list) => k === 0 || s.from !== list[k - 1].from);
    if (!starts.length) return [];
    if (starts[0].from > 0) starts.unshift({ id: null, title: '', from: 0 });
    return starts.map((s, k) => ({ ...s, to: (starts[k + 1]?.from ?? words.length) - 1 }));
  }

  // A scene that starts at word i. Its default title is "Scene N" (N after the existing ones).
  function add(words, scenes, i, title = null) {
    const id = words[i]?.id;
    if (id == null || scenes.some((s) => s.id === id)) return scenes;
    const n = scenes.length + 1;
    return [...scenes, { id, title: title ?? `Scene ${n}` }];
  }

  function remove(scenes, id) {
    return scenes.filter((s) => s.id !== id);
  }

  function rename(scenes, id, title) {
    return scenes.map((s) => (s.id === id ? { ...s, title: String(title).trim().slice(0, 80) } : s));
  }

  // Move scene k so it comes before scene j (j = the number of scenes: to the end). Returns
  // Edits.moveWords's result plus the scenes, or null when nothing moves. The untitled opening
  // part becomes a scene called "Opening" when it is moved or something moves before it;
  // otherwise its words would join whatever scene ends up before them.
  function move(words, deleted, cutGaps, order, duration, scenes, k, j) {
    const list = ranges(words, scenes);
    const s = list[k];
    if (!s || j === k || j === k + 1) return null;
    const dest = j >= list.length ? words.length : list[j].from;
    const r = E.moveWords(words, deleted, cutGaps, order, duration, s.from, s.to, dest);
    if (!r) return null;
    const opening = list[0].id == null && (k === 0 || j === 0);
    return { ...r, scenes: opening ? add(words, scenes, 0, 'Opening') : scenes };
  }

  // Word ids are kept as they are; anything else in a saved project is dropped.
  function normalize(scenes) {
    return (Array.isArray(scenes) ? scenes : [])
      .filter((s) => s && Number.isInteger(s.id))
      .map((s) => ({ id: s.id, title: String(s.title ?? '').slice(0, 80) }));
  }

  const api = { ranges, add, remove, rename, move, normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CutlineScenes = api;
})(typeof window !== 'undefined' ? window : globalThis);
