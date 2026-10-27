// Speaker labels: which words each person said. Words carry a speaker id; names live in a
// separate map so renaming a speaker is one change.
(function (root) {
  // Keep speaker ids only when more than one person was heard, and name them in order of
  // first appearance ("Speaker 1", "Speaker 2", ...).
  function fromTranscript(words) {
    const order = [];
    for (const w of words) if (w.speaker != null && !order.includes(w.speaker)) order.push(w.speaker);
    if (order.length < 2) return { words: words.map(({ speaker, ...rest }) => rest), speakers: {} };
    const speakers = {};
    order.forEach((id, n) => { speakers[id] = `Speaker ${n + 1}`; });
    return { words, speakers };
  }

  // Words from..to (inclusive) said by `id`.
  function assign(words, from, to, id) {
    return words.map((w, i) => (i >= from && i <= to ? { ...w, speaker: id } : w));
  }

  // A fresh id not used yet.
  function newId(speakers) {
    let n = 1;
    while (speakers[`s${n}`]) n++;
    return `s${n}`;
  }

  // Remove names nobody uses any more.
  function prune(words, speakers) {
    const used = new Set(words.map((w) => w.speaker).filter((x) => x != null));
    return Object.fromEntries(Object.entries(speakers).filter(([id]) => used.has(id)));
  }

  const api = { fromTranscript, assign, newId, prune };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CutlineSpeakers = api;
})(typeof window !== 'undefined' ? window : globalThis);
