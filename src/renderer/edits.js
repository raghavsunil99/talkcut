// Pure editing logic shared by the renderer and the tests: no DOM access here.
(function (root) {
  const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'mhm']);
  const MIN_KEPT = 0.04; // seconds; shorter slivers between cuts are dropped
  const MIN_GAP = 0.3; // pauses at least this long show up as their own item
  const GAP_KEEP = 0.2; // a cut pause keeps this much silence so speech does not run together

  // Lower-case, without punctuation. Keeps combining marks: in Telugu, Tamil, Malayalam and
  // other Indian scripts the vowel signs are marks, and dropping them merges different words.
  function normalize(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}']/gu, '');
  }

  function fillerIndices(words) {
    const out = [];
    words.forEach((w, i) => { if (FILLERS.has(normalize(w.text))) out.push(i); });
    return out;
  }

  // Pauses between words. A gap is keyed by the index of the word before it: -1 is the
  // lead-in before the first word, words.length - 1 the tail after the last.
  function gaps(words, duration, minGap = MIN_GAP) {
    const out = [];
    if (!words.length) return out;
    const lead = words[0].start;
    if (lead >= minGap) out.push({ i: -1, start: 0, end: lead });
    for (let i = 0; i < words.length - 1; i++) {
      const start = words[i].end;
      const end = words[i + 1].start;
      if (end - start >= minGap) out.push({ i, start, end });
    }
    const last = words[words.length - 1].end;
    if (duration - last >= minGap) out.push({ i: words.length - 1, start: last, end: duration });
    return out;
  }

  // A cut pause is shortened to GAP_KEEP, split evenly around the words on either side.
  // The lead-in and tail have speech on one side only, so they lose everything but that.
  function gapCut(gap, wordCount) {
    const half = GAP_KEEP / 2;
    if (gap.i === -1) return [gap.start, gap.end - half];
    if (gap.i === wordCount - 1) return [gap.start + half, gap.end];
    return [gap.start + half, gap.end - half];
  }

  function mergeRanges(ranges) {
    const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [s, e] of sorted) {
      const last = out[out.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    return out;
  }

  // A run of cut words removes everything from its first word's start up to the next kept
  // word's start, so the pause after a cut goes with it. A run at the very beginning also
  // removes the lead-in before the first word. Cut pauses are shortened, not removed.
  function computeCuts(words, deleted, duration, cutGaps = new Set(), rangeCuts = []) {
    const cuts = [];
    let i = 0;
    while (i < words.length) {
      if (!deleted.has(i)) { i++; continue; }
      const runStart = i;
      while (i < words.length && deleted.has(i)) i++;
      const start = runStart === 0 ? 0 : words[runStart].start;
      const end = i < words.length ? words[i].start : duration;
      cuts.push([start, end]);
    }
    if (cutGaps.size) {
      for (const gap of gaps(words, duration)) {
        if (cutGaps.has(gap.i)) cuts.push(gapCut(gap, words.length));
      }
    }
    for (const [a, b] of rangeCuts) cuts.push([Math.max(0, a), Math.min(duration, b)]);
    return mergeRanges(cuts);
  }

  function keptRanges(cuts, duration) {
    const kept = [];
    let cursor = 0;
    for (const [start, end] of cuts) {
      if (start - cursor >= MIN_KEPT) kept.push([cursor, start]);
      cursor = Math.max(cursor, end);
    }
    if (duration - cursor >= MIN_KEPT) kept.push([cursor, duration]);
    return kept;
  }

  // Position on the edited timeline for a time in the original media. Times inside a cut
  // map to where the cut was made.
  function toEdited(kept, t) {
    let acc = 0;
    for (const [s, e] of kept) {
      if (t < s) return acc;
      if (t <= e) return acc + (t - s);
      acc += e - s;
    }
    return acc;
  }

  // Time in the original media for a position on the edited timeline.
  function toSource(kept, x) {
    let acc = 0;
    for (const [s, e] of kept) {
      const len = e - s;
      if (x <= acc + len) return s + Math.max(0, x - acc);
      acc += len;
    }
    return kept.length ? kept[kept.length - 1][1] : 0;
  }

  // Index of the cut containing t, or -1. Cuts are sorted and non-overlapping.
  function cutAt(cuts, t) {
    let lo = 0;
    let hi = cuts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < cuts[mid][0]) hi = mid - 1;
      else if (t >= cuts[mid][1]) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  // Where playback should jump when it reaches time t, or null to keep playing.
  // Video seeks land on frame boundaries, possibly a frame before the requested time, so the
  // jump aims just past the cut and anything within `slack` of a cut's end counts as out of it;
  // otherwise playback would land back inside the cut and keep re-seeking.
  function skipTarget(cuts, t, duration, slack = 0.08) {
    const c = cutAt(cuts, t);
    if (c < 0 || t >= cuts[c][1] - slack) return null;
    const end = cuts[c][1];
    if (end >= duration - 0.01) return { stopAt: cuts[c][0] };
    return { seekTo: end + 0.01 };
  }

  // Correct the text of words from..to (inclusive) without touching the media: the new
  // words share the old time span in proportion to their length. Cut words and shortened
  // pauses after the range keep pointing at the same words. An empty text cuts the range.
  function replaceWords(words, deleted, cutGaps, from, to, text) {
    const tokens = String(text).trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) {
      const next = new Set(deleted);
      for (let i = from; i <= to; i++) next.add(i);
      return { words, deleted: next, cutGaps };
    }
    const start = words[from].start;
    const end = Math.max(words[to].end, start + 0.05 * tokens.length);
    const total = tokens.reduce((n, t) => n + t.length, 0);
    let t = start;
    const fresh = tokens.map((tok) => {
      const len = ((end - start) * tok.length) / total;
      const w = { text: tok, start: t, end: t + len };
      if (words[from].speaker != null) w.speaker = words[from].speaker;
      t += len;
      return w;
    });
    const delta = fresh.length - (to - from + 1);
    const shift = (set, min) => new Set([...set].filter((i) => i < from || i > to).map((i) => (i > to ? i + delta : i)).filter((i) => i >= min));
    return {
      words: [...words.slice(0, from), ...fresh, ...words.slice(to + 1)],
      deleted: shift(deleted, 0),
      cutGaps: shift(cutGaps, -1),
    };
  }

  // Cut an exact stretch of time (Range or Blade tool), in source seconds. Words mostly inside
  // it count as cut so the transcript matches; the stretch itself is cut to the frame even
  // when it starts or ends inside a word.
  function cutRange(words, deleted, rangeCuts, a, b) {
    const [s, e] = a < b ? [a, b] : [b, a];
    const next = new Set(deleted);
    words.forEach((w, i) => {
      const mid = (w.start + Math.max(w.end, w.start)) / 2;
      if (mid >= s && mid <= e) next.add(i);
    });
    return { deleted: next, rangeCuts: mergeRanges([...rangeCuts.map((r) => [...r]), [s, e]]) };
  }

  // Bringing words back also removes any time cuts over them.
  function restoreWords(words, deleted, rangeCuts, from, to) {
    const next = new Set(deleted);
    for (let i = from; i <= to; i++) next.delete(i);
    const s = words[from].start;
    const e = Math.max(words[to].end, words[to].start);
    return { deleted: next, rangeCuts: rangeCuts.filter(([a, b]) => b <= s || a >= e) };
  }

  // The stretch between the blade splits around time t, within [0, duration].
  function segmentAt(splits, t, duration) {
    let a = 0;
    let b = duration;
    for (const x of splits) {
      if (x <= t && x > a) a = x;
      if (x > t && x < b) b = x;
    }
    return [a, b];
  }

  // Index of the last word starting at or before t, or -1 before the first word.
  function wordAt(words, t) {
    let lo = 0;
    let hi = words.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  // ---------- find and replace ----------

  // Where a phrase occurs among the kept words, ignoring case and punctuation: [[from, to]].
  function findPhrase(words, deleted, phrase) {
    const want = String(phrase).trim().split(/\s+/).map(normalize).filter(Boolean);
    if (!want.length) return [];
    const kept = [];
    words.forEach((w, i) => { if (!deleted.has(i) && normalize(w.text)) kept.push(i); });
    const out = [];
    for (let k = 0; k + want.length <= kept.length; k++) {
      let ok = true;
      for (let j = 0; j < want.length && ok; j++) ok = normalize(words[kept[k + j]].text) === want[j];
      if (ok) {
        out.push([kept[k], kept[k + want.length - 1]]);
        k += want.length - 1;
      }
    }
    return out;
  }

  // Replace every occurrence, keeping the punctuation that ended the original ("Vivo," → "Veo,").
  function replaceAll(words, deleted, cutGaps, phrase, replacement) {
    let r = { words, deleted, cutGaps };
    const found = findPhrase(words, deleted, phrase);
    for (const [from, to] of found.slice().reverse()) {
      const tail = /[^\p{L}\p{N}]+$/u.exec(r.words[to].text)?.[0] ?? '';
      const text = String(replacement).trim();
      const withTail = text && tail && !text.endsWith(tail) ? text + tail : text;
      r = replaceWords(r.words, r.deleted, r.cutGaps, from, to, withTail);
    }
    return { ...r, count: found.length };
  }

  // A personal word list ([[wrong, right], ...]) applied to a fresh transcript.
  function applyWordList(words, list) {
    let r = { words, deleted: new Set(), cutGaps: new Set() };
    for (const [from, to] of list ?? []) if (from && to) r = replaceAll(r.words, r.deleted, r.cutGaps, from, to);
    return r.words;
  }

  // ---------- retakes ----------

  // Two spoken words count as the same when they are equal or nearly so (transcripts of a
  // repeated word often differ by a letter, especially in Telugu).
  function sameWord(a, b) {
    if (a === b) return true;
    if (Math.min(a.length, b.length) < 3) return false;
    const d = [];
    for (let i = 0; i <= a.length; i++) d[i] = [i];
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length] / Math.max(a.length, b.length) <= 0.25;
  }

  // Longest common subsequence of two token lists.
  function lcs(a, b) {
    const row = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      let prev = 0;
      for (let j = 1; j <= b.length; j++) {
        const keep = row[j];
        row[j] = sameWord(a[i - 1], b[j - 1]) ? prev + 1 : Math.max(row[j], row[j - 1]);
        prev = keep;
      }
    }
    return row[b.length];
  }

  // Kept words grouped into phrases: a new phrase starts after a pause or a sentence end.
  function phrases(words, deleted, pause = 0.5) {
    const out = [];
    let cur = null;
    words.forEach((w, i) => {
      if (deleted.has(i)) return;
      const prev = cur?.idx.at(-1);
      if (!cur || w.start - words[prev].end > pause || /[.?!।]$/.test(words[prev].text.trim())) {
        cur = { idx: [], tokens: [] };
        out.push(cur);
      }
      cur.idx.push(i);
      const t = normalize(w.text);
      if (t) cur.tokens.push(t);
    });
    return out;
  }

  // Earlier takes of something said again: a phrase whose words are mostly repeated at the
  // start of one of the next two phrases, or words repeated back to back inside a phrase
  // ("I went to the, I went to the market"). The last take is kept.
  // Returns [{ idx: [word indices to cut], text }].
  function findRetakes(words, deleted = new Set()) {
    const list = phrases(words, deleted);
    const cut = new Set();
    const takes = [];
    const take = (idx) => {
      const fresh = idx.filter((i) => !cut.has(i));
      if (!fresh.length) return;
      fresh.forEach((i) => cut.add(i));
      takes.push({ idx: fresh, text: fresh.map((i) => words[i].text.trim()).join(' ') });
    };
    list.forEach((p, n) => {
      const a = p.tokens;
      if (!a.length) return;
      for (let k = n + 1; k <= Math.min(n + 2, list.length - 1); k++) {
        const b = list[k].tokens;
        // Anything between the two takes ("sorry", "once more") goes too, if it is short.
        const between = list.slice(n + 1, k);
        if (between.some((x) => x.tokens.length > 3)) break;
        const start = b.slice(0, a.length + 2);
        const restart = sameWord(a[0], b[0]) || (b[1] && sameWord(a[0], b[1]));
        const similar = a.length === 1 ? b.length >= 3 && sameWord(a[0], b[0]) : lcs(a, start) / a.length >= 0.6;
        if (restart && similar && b.length >= Math.min(a.length, 3)) {
          take([...p.idx, ...between.flatMap((x) => x.idx)]);
          return;
        }
      }
      // Back-to-back repeat inside the phrase: keep the second run.
      for (let k = 0; k < a.length; k++) {
        for (let m = Math.min(8, Math.floor((a.length - k) / 2)); m >= 2; m--) {
          let same = true;
          for (let j = 0; j < m && same; j++) same = sameWord(a[k + j], a[k + m + j]);
          if (same) {
            // tokens skip punctuation-only words, so map token positions back to word indices
            const tokenIdx = p.idx.filter((i) => normalize(words[i].text));
            take(tokenIdx.slice(k, k + m));
            k += 2 * m - 1;
            break;
          }
        }
      }
    });
    return takes;
  }

  function totalLength(ranges) {
    return ranges.reduce((sum, [s, e]) => sum + (e - s), 0);
  }

  const api = {
    FILLERS, MIN_GAP, GAP_KEEP,
    normalize, fillerIndices, findRetakes, findPhrase, replaceAll, applyWordList, gaps, computeCuts, keptRanges, mergeRanges, toEdited, toSource, cutAt, skipTarget, replaceWords, cutRange, restoreWords, segmentAt, wordAt, totalLength,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CutlineEdits = api;
})(typeof window !== 'undefined' ? window : globalThis);
