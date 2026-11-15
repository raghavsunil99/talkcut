// Review before cutting: what Remove fillers, Remove retakes and Shorten pauses would cut,
// as a list the user checks before anything changes. Pure logic, shared with the tests.
(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./edits.js') : root.CutlineEdits;

  // Filler words per language, in two tiers:
  //   sounds  hesitation noises that are never real words; proposed unless the user turns one off
  //   words   real words that are often used as fillers (అంటే "that is", मतलब "meaning"); only
  //           proposed when the user ticks them, because cutting them blindly changes meaning
  // English sounds are always included: Indian speech mixes them in.
  const FILLER_WORDS = {
    en: { sounds: ['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'mhm'], words: ['like', 'basically', 'actually', 'so', 'right', 'okay'] },
    te: { sounds: ['ఊ', 'ఉమ్', 'హ్మ్', 'మ్మ్', 'అమ్'], words: ['అంటే', 'ఏంటంటే', 'అది', 'ఆ', 'ఇక', 'సో', 'కదా'] },
    hi: { sounds: ['अं', 'उम्म', 'उम', 'हम्म', 'उं', 'ऊं'], words: ['मतलब', 'यानी', 'तो', 'अच्छा', 'बस', 'आ', 'ना'] },
    ta: { sounds: ['ம்ம்', 'உம்', 'ஹ்ம்'], words: ['அதாவது', 'வந்து', 'அப்போ', 'ஆ', 'சரி'] },
    kn: { sounds: ['ಹ್ಮ್', 'ಉಂ', 'ಮ್ಮ್'], words: ['ಅಂದರೆ', 'ಅದು', 'ಹಾಗೆ', 'ಆ', 'ಸರಿ'] },
    ml: { sounds: ['ഹ്മ്', 'മ്മ്'], words: ['അതായത്', 'പിന്നെ', 'അപ്പോ', 'ആ', 'ശരി'] },
  };

  // The user's choices, per language: { off: [sounds turned off], on: [words turned on],
  // extra: [words they added] }. Kept per Mac, not in the project.
  function fillerSet(language, prefs = {}) {
    const p = prefs[language] ?? {};
    const off = new Set((p.off ?? []).map(E.normalize));
    const set = new Set();
    for (const lang of new Set(['en', language])) {
      for (const w of FILLER_WORDS[lang]?.sounds ?? []) if (!off.has(E.normalize(w))) set.add(E.normalize(w));
    }
    for (const w of [...(p.on ?? []), ...(p.extra ?? [])]) if (E.normalize(w)) set.add(E.normalize(w));
    return set;
  }

  // Stretches of sound with no word on them: an "aa" or a breath-laugh the transcriber left out.
  // `peaks` is the waveform (peak level per 1/perSecond s, the timeline's, with every recording
  // at its offset). A sound counts when it is loud like speech, at least `margin` away from any
  // word (word edges are not exact), between minLen and maxLen long, and not already cut.
  function wordlessSounds({ words, peaks, perSecond, duration, cuts = [], minLen = 0.15, maxLen = 1.2, margin = 0.12 }) {
    if (!peaks?.length || !perSecond) return [];
    const sorted = Array.from(peaks).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
    const loud = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    const threshold = Math.max(0.02, floor * 2.5, loud * 0.15);
    const spans = words.map((w) => [w.start, Math.max(w.end, w.start)]).sort((a, b) => a[0] - b[0]);
    // The quiet stretches between words (and before the first, after the last).
    const holes = [];
    let cursor = 0;
    for (const [s, e] of spans) {
      if (s - margin > cursor + margin) holes.push([cursor === 0 ? 0 : cursor + margin, s - margin]);
      cursor = Math.max(cursor, e);
    }
    if (duration - cursor > margin) holes.push([cursor + margin, duration]);
    const bridge = Math.round(0.06 * perSecond); // short dips inside one sound
    const found = [];
    for (const [a, b] of holes) {
      const f0 = Math.max(0, Math.ceil(a * perSecond));
      const f1 = Math.min(peaks.length, Math.floor(b * perSecond));
      let open = -1;
      let last = -1;
      const close = () => {
        const s = open / perSecond;
        const e = (last + 1) / perSecond;
        if (e - s >= minLen && e - s <= maxLen) found.push([Math.max(a, s - 0.04), Math.min(b, e + 0.04)]);
        open = -1;
      };
      for (let f = f0; f < f1; f++) {
        if (peaks[f] >= threshold) { if (open < 0) open = f; last = f; } else if (open >= 0 && f - last > bridge) close();
      }
      if (open >= 0) close();
    }
    // Already cut (words, pauses or time cuts): nothing to propose there.
    return found.filter(([s, e]) => !cuts.some(([cs, ce]) => cs <= s + 0.02 && ce >= e - 0.02));
  }

  // A few words either side of words from..to, for the list.
  function context(words, deleted, from, to, n = 3) {
    const pick = (a, b) => words.slice(Math.max(0, a), Math.max(0, b)).filter((_, k) => !deleted.has(Math.max(0, a) + k)).map((w) => w.text).join(' ');
    return { before: pick(from - n, from), text: words.slice(from, to + 1).map((w) => w.text).join(' '), after: pick(to + 1, to + 1 + n) };
  }

  // Everything the cleanup tools would cut, as review items:
  //   { id, kind: 'filler'|'sound'|'retake'|'pause', start, end (source s), from, to (words),
  //     gap (pause key), saves (seconds), before, text, after, checked }
  // `kinds` limits which tools run. Words in a proposed retake are not also listed as fillers.
  function proposals({ words, deleted, cutGaps, duration, order = null, kinds, fillers, sounds = [], minPause = 1, gapKeep = E.GAP_KEEP }) {
    const items = [];
    const want = new Set(kinds);
    const inRetake = new Set();
    if (want.has('retake')) {
      for (const take of E.findRetakes(words, deleted)) {
        const from = take.idx[0];
        const to = take.idx[take.idx.length - 1];
        take.idx.forEach((i) => inRetake.add(i));
        items.push({ id: `retake:${words[from].id ?? from}`, pos: from, kind: 'retake', idx: take.idx, from, to, start: words[from].start, end: Math.max(words[to].end, words[to].start), saves: take.idx.reduce((n, i) => n + Math.max(0, words[i].end - words[i].start), 0), ...context(words, deleted, from, to), checked: true });
      }
    }
    if (want.has('filler')) {
      for (const i of E.fillerIndices(words, fillers)) {
        if (deleted.has(i) || inRetake.has(i)) continue;
        items.push({ id: `filler:${words[i].id ?? i}`, pos: i, kind: 'filler', idx: [i], from: i, to: i, start: words[i].start, end: Math.max(words[i].end, words[i].start), saves: Math.max(0, words[i].end - words[i].start), ...context(words, deleted, i, i), checked: true });
      }
    }
    if (want.has('sound')) {
      for (const [s, e] of sounds) {
        // The word spoken just before the sound (in the recording) and the one after it.
        const before = E.wordAt(words, s);
        const after = before + 1 < words.length ? before + 1 : -1;
        items.push({ id: `sound:${s.toFixed(2)}`, pos: before + 0.5, kind: 'sound', start: s, end: e, saves: e - s, before: before >= 0 ? words.slice(Math.max(0, before - 2), before + 1).map((w) => w.text).join(' ') : '', text: '(sound, no word)', after: after >= 0 ? words.slice(after, after + 3).map((w) => w.text).join(' ') : '', checked: true });
      }
    }
    if (want.has('pause')) {
      for (const g of E.gaps(words, duration, minPause, order)) {
        if (cutGaps.has(g.i)) continue;
        const prev = g.lead ? -1 : g.i;
        // A pause next to a cut word goes with the cut already.
        if ((prev >= 0 && deleted.has(prev)) || (prev + 1 < words.length && deleted.has(prev + 1) && !g.tail)) continue;
        items.push({ id: `pause:${g.i}`, pos: g.lead ? -0.5 : prev + 0.5, kind: 'pause', gap: g.i, start: g.start, end: g.end, saves: Math.max(0, g.end - g.start - gapKeep), before: prev >= 0 ? words.slice(Math.max(0, prev - 2), prev + 1).map((w) => w.text).join(' ') : '', text: `pause ${(g.end - g.start).toFixed(1)} s`, after: g.tail ? '' : words.slice(prev + 1, prev + 4).map((w) => w.text).join(' '), checked: true });
      }
    }
    // In the order they play (words are in play order, so their index is the position).
    items.sort((a, b) => a.pos - b.pos);
    return items;
  }

  // The edit that the ticked items make: { deleted, cutGaps, rangeCuts }.
  function apply(items, { deleted, cutGaps, rangeCuts }) {
    const d = new Set(deleted);
    const g = new Set(cutGaps);
    let r = rangeCuts.map((x) => [...x]);
    for (const it of items) {
      if (!it.checked) continue;
      if (it.idx) it.idx.forEach((i) => d.add(i));
      else if (it.kind === 'pause') g.add(it.gap);
      else if (it.kind === 'sound') r.push([it.start, it.end]);
    }
    r = E.mergeRanges(r);
    return { deleted: d, cutGaps: g, rangeCuts: r };
  }

  const api = { FILLER_WORDS, fillerSet, wordlessSounds, proposals, apply, context };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CutlineReview = api;
})(typeof window !== 'undefined' ? window : globalThis);
