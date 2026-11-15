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

  // `set` is the filler words to look for (normalized); the English sounds by default.
  function fillerIndices(words, set = FILLERS) {
    const out = [];
    words.forEach((w, i) => { if (set.has(normalize(w.text))) out.push(i); });
    return out;
  }

  // ---------- play order ----------
  //
  // `order` is the list of pieces of the original media in the order they play: [[start, end]]
  // in source seconds, covering the whole recording exactly once. One piece, [[0, duration]],
  // is a recording played straight through; moving a sentence splits pieces and reorders them.
  // `words` is always kept in the order it is shown and played, so the words of a piece are
  // next to each other and in time order. Cuts stay in source time and apply inside each piece.

  function isIdentity(order, duration) {
    return !order || order.length === 0 || (order.length === 1 && order[0][0] <= 0 && order[0][1] >= duration - 1e-6);
  }

  // A usable order for a recording of this length: pieces sorted by time must tile [0, duration].
  // Anything else (a damaged file) falls back to playing straight through.
  function normalizeOrder(order, duration) {
    const whole = [[0, duration]];
    if (!Array.isArray(order) || !order.length) return whole;
    const pieces = order.map((p) => [Number(p[0]), Number(p[1])]);
    const sorted = pieces.slice().sort((x, y) => x[0] - y[0]);
    let at = 0;
    for (const [ps, pe] of sorted) {
      if (!(Math.abs(ps - at) < 1e-6) || !(pe > ps)) return whole;
      at = pe;
    }
    if (Math.abs(at - duration) > 0.05) return whole;
    sorted[0][0] = 0;
    sorted[sorted.length - 1][1] = duration;
    return joinPieces(pieces);
  }

  // Neighbouring pieces that continue each other in the recording become one.
  function joinPieces(pieces) {
    const out = [];
    for (const [ps, pe] of pieces) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[1] - ps) < 1e-9) last[1] = pe;
      else out.push([ps, pe]);
    }
    return out;
  }

  // Which piece each word is in. Returns { pieces: [{ start, end, from, to }], pieceOf } where
  // from..to are word indices (to < from for a piece with no words).
  function layout(words, order, duration) {
    const list = isIdentity(order, duration) ? [[0, duration]] : order;
    const pieces = list.map(([start, end]) => ({ start, end, from: 0, to: -1 }));
    const pieceOf = new Int32Array(words.length);
    let p = 0;
    for (let i = 0; i < words.length; i++) {
      const t = words[i].start;
      if (!(t >= pieces[p].start && t < pieces[p].end)) {
        for (let q = p + 1; q < pieces.length; q++) {
          if (t >= pieces[q].start && t < pieces[q].end) { p = q; break; }
        }
      }
      pieceOf[i] = p;
    }
    let i = 0;
    pieces.forEach((piece, n) => {
      piece.from = i;
      while (i < words.length && pieceOf[i] === n) i++;
      piece.to = i - 1;
    });
    return { pieces, pieceOf };
  }

  // For each word, where its piece ends (source seconds). Two words are in the same piece
  // exactly when these are equal. Captions use it to stop at a join.
  function pieceEnds(words, order, duration) {
    const { pieces, pieceOf } = layout(words, order, duration);
    return Float64Array.from(pieceOf, (p) => pieces[p].end);
  }

  // True when words from..to sit in one piece (so they are one stretch of the recording).
  function samePiece(words, order, duration, from, to) {
    if (isIdentity(order, duration)) return true;
    const { pieceOf } = layout(words, order, duration);
    return pieceOf[from] === pieceOf[to];
  }

  // Pauses between words. A gap is keyed by the index of the word before it. The lead-in before
  // the first word of the recording has a negative key (-1), which does not change when words move.
  function gaps(words, duration, minGap = MIN_GAP, order = null) {
    const out = [];
    if (!words.length) return out;
    for (const piece of layout(words, order, duration).pieces) {
      if (piece.to < piece.from) continue;
      const lead = words[piece.from].start - piece.start;
      if (lead >= minGap) out.push({ i: -1 - Math.round(piece.start * 1000), start: piece.start, end: words[piece.from].start, lead: true });
      for (let i = piece.from; i < piece.to; i++) {
        const start = words[i].end;
        const end = words[i + 1].start;
        if (end - start >= minGap) out.push({ i, start, end });
      }
      const last = words[piece.to].end;
      // Only the pause that ends the recording is a tail; a piece that ends at a later word's
      // start has an ordinary pause there.
      if (piece.end - last >= minGap) out.push({ i: piece.to, start: last, end: piece.end, tail: piece.end >= duration - 1e-6 });
    }
    return out;
  }

  // A cut pause is shortened to GAP_KEEP, split evenly around the words on either side.
  // The lead-in and tail have speech on one side only, so they lose everything but that.
  function gapCut(gap, keep = GAP_KEEP) {
    const half = keep / 2;
    if (gap.lead) return [gap.start, gap.end - half];
    if (gap.tail) return [gap.start + half, gap.end];
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
  // Runs stop at the end of a piece: the next word on screen is somewhere else in the recording.
  // The result is in source time, sorted.
  // `gapKeep` is how much silence a shortened pause keeps (GAP_KEEP unless the project changed it).
  function computeCuts(words, deleted, duration, cutGaps = new Set(), rangeCuts = [], order = null, gapKeep = GAP_KEEP) {
    const cuts = [];
    const { pieces, pieceOf } = layout(words, order, duration);
    let i = 0;
    while (i < words.length) {
      if (!deleted.has(i)) { i++; continue; }
      const runStart = i;
      const piece = pieces[pieceOf[i]];
      while (i <= piece.to && deleted.has(i)) i++;
      const start = runStart === piece.from ? Math.min(piece.start, words[runStart].start) : words[runStart].start;
      const end = i <= piece.to ? words[i].start : piece.end;
      cuts.push([start, end]);
    }
    if (cutGaps.size) {
      for (const gap of gaps(words, duration, MIN_GAP, order)) {
        if (cutGaps.has(gap.i)) cuts.push(gapCut(gap, gapKeep));
      }
    }
    for (const [a, b] of rangeCuts) cuts.push([Math.max(0, a), Math.min(duration, b)]);
    return mergeRanges(cuts);
  }

  // What plays, in play order: [[start, end]] in source seconds. With no reordering this is the
  // kept ranges in time order; with an order, each piece contributes its kept parts in turn.
  function keptRanges(cuts, duration, order = null) {
    const kept = [];
    let cursor = 0;
    for (const [start, end] of cuts) {
      if (start - cursor >= MIN_KEPT) kept.push([cursor, start]);
      cursor = Math.max(cursor, end);
    }
    if (duration - cursor >= MIN_KEPT) kept.push([cursor, duration]);
    if (isIdentity(order, duration)) return kept;
    const out = [];
    for (const [ps, pe] of order) {
      for (const [s, e] of kept) {
        if (e <= ps) continue;
        if (s >= pe) break;
        const a = Math.max(s, ps);
        const b = Math.min(e, pe);
        if (b - a >= MIN_KEPT) out.push([a, b]);
      }
    }
    return joinPieces(out);
  }

  // Move every range edge to the nearest video frame (fps frames per second). The export cuts
  // video on whole frames, so ranges that sit on frames make the edited timeline exact: without
  // this each cut adds a few milliseconds and captions drift early. Ranges shorter than a frame
  // go; ranges that touch after rounding join.
  function snapRanges(ranges, fps) {
    if (!(fps > 0)) return ranges;
    const frames = [];
    for (const [s, e] of ranges) {
      const a = Math.round(s * fps);
      const b = Math.round(e * fps);
      if (b <= a) continue;
      const last = frames[frames.length - 1];
      // Only a range that carries on from the one before joins it; a jump back stays a cut.
      if (last && a <= last[1] && a >= last[0]) last[1] = Math.max(last[1], b);
      else frames.push([a, b]);
    }
    return frames.map(([a, b]) => [a / fps, b / fps]);
  }

  // The play list sorted by source time, each range with where it starts on the edited
  // timeline. Built once per list (lists are replaced, never changed in place).
  const sortedCache = new WeakMap();
  function sortedRanges(kept) {
    let rows = sortedCache.get(kept);
    if (!rows) {
      let acc = 0;
      rows = kept.map(([s, e]) => { const row = [s, e, acc]; acc += e - s; return row; });
      rows.sort((x, y) => x[0] - y[0]);
      sortedCache.set(kept, rows);
    }
    return rows;
  }

  // Position on the edited timeline for a time in the original media. Times inside a cut
  // map to where the cut was made. `kept` is a play list, in any order.
  // A time exactly on a join, or inside a cut, belongs to two places once pieces are reordered.
  // By default it counts as the start of what follows it in the recording; with `end` true it
  // counts as the end of what came before it (use this for the end of a word or a caption).
  function toEdited(kept, t, end = false) {
    const rows = sortedRanges(kept);
    if (!rows.length) return 0;
    // r: the last range starting at or before t (strictly before, for an end).
    let lo = 0;
    let hi = rows.length - 1;
    let r = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (end ? rows[mid][0] < t : rows[mid][0] <= t) { r = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (r >= 0 && t <= rows[r][1]) return rows[r][2] + (t - rows[r][0]);
    if (end) return r >= 0 ? rows[r][2] + (rows[r][1] - rows[r][0]) : rows[0][2];
    if (r + 1 < rows.length) return rows[r + 1][2];
    return rows[r][2] + (rows[r][1] - rows[r][0]);
  }

  // toEdited for many times (words, caption groups): (t, end) => edited time.
  function editedMapper(kept) {
    return (t, end = false) => toEdited(kept, t, end);
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

  // The stretch of recording under edited times x0..x1, as [start, end] in source seconds.
  // With `single` (words have been moved) it stops at the end of the range x0 is in: what
  // follows on the edited timeline may be somewhere else in the recording.
  function sourceSpan(kept, x0, x1, single = false) {
    const a = toSource(kept, x0);
    const b = toSource(kept, x1);
    if (!single) return [a, b];
    let acc = 0;
    for (const [s, e] of kept) {
      if (x0 <= acc + (e - s)) return [a, x1 <= acc + (e - s) ? b : e];
      acc += e - s;
    }
    return [a, a];
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

  // Playback over a play list: what to do when the player is at source time t.
  // `k` is the range playback is in (-1 when unknown, as after a seek by the user). Returns
  // { k } to keep playing, { k, seekTo } to jump (forward over a cut, or anywhere when pieces
  // are reordered) or { k, stopAt } at the end of the edit.
  // Seeks land on frame boundaries, possibly a frame early, so a time within `slack` before the
  // range being played still counts as in it.
  function playStep(kept, t, k = -1, slack = 0.08) {
    if (!kept.length) return { k: -1, stopAt: 0 };
    if (k >= 0 && k < kept.length) {
      const [s, e] = kept[k];
      if (t >= s - slack && t < e) return { k };
      if (t >= e && t < e + 1) {
        const next = kept[k + 1];
        if (!next) return { k, stopAt: Math.max(s, e - 0.01) };
        if (Math.abs(next[0] - e) < 1e-6) return { k: k + 1 };
        return { k: k + 1, seekTo: next[0] + 0.01 };
      }
    }
    let found = -1;
    let after = -1; // the range that follows t in the recording
    let last = 0; // the range that ends latest in the recording
    for (let n = 0; n < kept.length; n++) {
      const [s, e] = kept[n];
      if (t >= s && t < e) { found = n; break; }
      if (s > t && (after < 0 || s < kept[after][0])) after = n;
      if (e > kept[last][1]) last = n;
    }
    if (found >= 0) return { k: found };
    if (after >= 0) {
      if (kept[after][0] - t <= slack) return { k: after };
      return { k: after, seekTo: kept[after][0] + 0.01 };
    }
    return { k: last, stopAt: Math.max(kept[last][0], kept[last][1] - 0.01) };
  }

  // ---------- word ids ----------

  // Every word gets an id that never changes, so a word can be found again after others are
  // moved, corrected or cut. Returns the same array when nothing was missing.
  function ensureIds(words) {
    let max = 0;
    let missing = false;
    const seen = new Set();
    for (const w of words) {
      if (Number.isInteger(w.id) && w.id > 0 && !seen.has(w.id)) { seen.add(w.id); if (w.id > max) max = w.id; } else missing = true;
    }
    if (!missing) return words;
    const used = new Set();
    return words.map((w) => {
      if (Number.isInteger(w.id) && w.id > 0 && !used.has(w.id)) { used.add(w.id); return w; }
      max += 1;
      used.add(max);
      return { ...w, id: max };
    });
  }

  function nextId(words) {
    let max = 0;
    for (const w of words) if (w.id > max) max = w.id;
    return max + 1;
  }

  // ---------- moving words ----------

  // Move words from..to (as shown) so they come before the word now at `dest` (words.length
  // puts them last). The stretch of recording under them moves with them: from the first
  // word's start up to the start of the word that followed, so the pause after goes along,
  // exactly as a cut would take it. Cut words and shortened pauses keep pointing at the same
  // words. Returns { words, deleted, cutGaps, order, from, to } (the new place of the moved
  // words), or null when the move changes nothing or cannot be made.
  function moveWords(words, deleted, cutGaps, order, duration, from, to, dest) {
    const n = words.length;
    if (!(from >= 0 && to >= from && to < n) || !(dest >= 0 && dest <= n)) return null;
    if (dest >= from && dest <= to + 1) return null;
    const { pieces } = layout(words, order, duration);
    // Make a piece start at word i (unless one already does).
    const splitBefore = (i) => {
      if (i <= 0 || i >= n) return true;
      const k = pieces.findIndex((p) => i >= p.from && i <= p.to);
      if (k < 0) return false;
      const p = pieces[k];
      if (i === p.from) return true;
      const t = words[i].start;
      if (!(t > p.start && t < p.end) || !(words[i - 1].start < t)) return false;
      pieces.splice(k, 1, { start: p.start, end: t, from: p.from, to: i - 1 }, { start: t, end: p.end, from: i, to: p.to });
      return true;
    };
    if (!splitBefore(from) || !splitBefore(to + 1) || !splitBefore(dest)) return null;
    const moved = pieces.filter((p) => p.to >= p.from && p.from >= from && p.to <= to);
    const rest = pieces.filter((p) => !moved.includes(p));
    let at = rest.findIndex((p) => p.to >= p.from && p.from === dest);
    if (at < 0) at = rest.length;
    const next = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
    const perm = []; // new index -> old index
    for (const p of next) for (let i = p.from; i <= p.to; i++) perm.push(i);
    if (perm.length !== n) return null;
    const newIndex = new Int32Array(n);
    perm.forEach((old, now) => { newIndex[old] = now; });
    const remap = (set) => new Set([...set].map((i) => (i >= 0 ? newIndex[i] : i)));
    return {
      words: perm.map((i) => words[i]),
      deleted: remap(deleted),
      cutGaps: remap(cutGaps),
      order: joinPieces(next.map((p) => [p.start, p.end])),
      from: newIndex[from],
      to: newIndex[to],
    };
  }

  // Correct the text of words from..to (inclusive) without touching the media: the new
  // words share the old time span in proportion to their length. Cut words and shortened
  // pauses after the range keep pointing at the same words. An empty text cuts the range.
  function replaceWords(words, deleted, cutGaps, from, to, text, limit = Infinity) {
    const tokens = String(text).trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) {
      const next = new Set(deleted);
      for (let i = from; i <= to; i++) next.add(i);
      return { words, deleted: next, cutGaps };
    }
    // `limit` is where the piece holding these words ends: new words never start past it.
    const start = words[from].start;
    const end = Math.min(Math.max(words[to].end, start + 0.05 * tokens.length), Math.max(limit, start + 0.001));
    let id = nextId(words);
    const total = tokens.reduce((n, t) => n + t.length, 0);
    let t = start;
    const fresh = tokens.map((tok) => {
      const len = ((end - start) * tok.length) / total;
      const w = { text: tok, start: t, end: t + len, id: id++ };
      if (words[from].speaker != null) w.speaker = words[from].speaker;
      t += len;
      return w;
    });
    const delta = fresh.length - (to - from + 1);
    const shift = (set) => new Set([...set].filter((i) => i < from || i > to).map((i) => (i > to ? i + delta : i)));
    return {
      words: [...words.slice(0, from), ...fresh, ...words.slice(to + 1)],
      deleted: shift(deleted),
      cutGaps: shift(cutGaps),
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

  // Bringing words back also removes any time cuts over them. The words may lie in several
  // stretches of the recording (after a move), so each stretch is cleared on its own.
  function restoreWords(words, deleted, rangeCuts, from, to) {
    const next = new Set(deleted);
    let cuts = rangeCuts;
    let i = from;
    while (i <= to) {
      const first = i;
      next.delete(i);
      while (i < to && words[i + 1].start >= words[i].start) { i++; next.delete(i); }
      const s = words[first].start;
      const e = Math.max(words[i].end, words[i].start);
      cuts = cuts.filter(([a, b]) => b <= s || a >= e);
      i++;
    }
    return { deleted: next, rangeCuts: cuts };
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

  // Index of the last word (in the recording) starting at or before t, or -1 before the first
  // word. Words are in play order, which after a move is not time order, so the search runs
  // over the words sorted by time (worked out once per word list).
  const byTimeCache = new WeakMap();
  function wordAt(words, t) {
    let byTime = byTimeCache.get(words);
    if (byTime === undefined) {
      let sorted = true;
      for (let i = 1; i < words.length && sorted; i++) sorted = words[i].start >= words[i - 1].start;
      byTime = sorted ? null : words.map((_, i) => i).sort((x, y) => words[x].start - words[y].start);
      byTimeCache.set(words, byTime);
    }
    let lo = 0;
    let hi = words.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const i = byTime ? byTime[mid] : mid;
      if (words[i].start <= t) { found = i; lo = mid + 1; } else hi = mid - 1;
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
  function replaceAll(words, deleted, cutGaps, phrase, replacement, ends = null) {
    let r = { words, deleted, cutGaps };
    // A phrase that runs across a join is two stretches of recording: it is left alone.
    // (`ends` is pieceEnds for these words, when words have been moved.)
    const found = findPhrase(words, deleted, phrase).filter(([from, to]) => !ends || ends[from] === ends[to]);
    for (const [from, to] of found.slice().reverse()) {
      const tail = /[^\p{L}\p{N}]+$/u.exec(r.words[to].text)?.[0] ?? '';
      const text = String(replacement).trim();
      const withTail = text && tail && !text.endsWith(tail) ? text + tail : text;
      r = replaceWords(r.words, r.deleted, r.cutGaps, from, to, withTail, ends ? ends[to] : Infinity);
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
      if (!cur || w.start - words[prev].end > pause || w.start < words[prev].start || /[.?!।]$/.test(words[prev].text.trim())) {
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
    normalize, fillerIndices, findRetakes, findPhrase, replaceAll, applyWordList, gaps, computeCuts, keptRanges, snapRanges, mergeRanges, toEdited, editedMapper, toSource, sourceSpan, cutAt, skipTarget, playStep, replaceWords, cutRange, restoreWords, segmentAt, wordAt, totalLength,
    isIdentity, normalizeOrder, layout, pieceEnds, samePiece, moveWords, ensureIds,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CutlineEdits = api;
})(typeof window !== 'undefined' ? window : globalThis);
