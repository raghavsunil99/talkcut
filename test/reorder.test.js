// The rearrangeable edit model: an ordered list of pieces of the recording, words that can be
// moved, and everything that maps between the recording and the edited timeline.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const E = require('../src/renderer/edits.js');
const C = require('../src/renderer/captions.js');
const T = require('../src/renderer/tracks.js');
const { buildRenderArgs } = require('../src/renderer/render-plan.js');
const { probe, pixelAt, renderEdit } = require('../src/media.js');
const { createProjects, upgrade } = require('../src/projects.js');

// Eight words, a 1.6 s pause after the fourth, in a 7 s recording:
//   one 0.2  two 0.8  three 1.4  four. 2.0 | pause | five 4.0  six 4.6  seven 5.2  eight. 5.8
const D = 7;
const WORDS = E.ensureIds([0.2, 0.8, 1.4, 2.0, 4.0, 4.6, 5.2, 5.8].map((start, i) => ({
  text: ['one', 'two', 'three', 'four.', 'five', 'six', 'seven', 'eight.'][i], start, end: start + 0.4,
})));
const none = new Set();
const texts = (words) => words.map((w) => w.text).join(' ');
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('with no order everything is as before: one piece, kept ranges in time order', () => {
  const deleted = new Set([1, 2]);
  const cuts = E.computeCuts(WORDS, deleted, D);
  assert.deepEqual(cuts, [[0.8, 2.0]]);
  assert.deepEqual(E.keptRanges(cuts, D, null), [[0, 0.8], [2.0, 7]]);
  assert.deepEqual(E.keptRanges(cuts, D, [[0, D]]), [[0, 0.8], [2.0, 7]]);
  assert.deepEqual(E.layout(WORDS, null, D).pieces, [{ start: 0, end: 7, from: 0, to: 7 }]);
});

test('ensureIds gives every word a lasting id and leaves complete lists alone', () => {
  assert.deepEqual(WORDS.map((w) => w.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(E.ensureIds(WORDS), WORDS);
  const mixed = E.ensureIds([{ text: 'a', id: 5 }, { text: 'b' }, { text: 'c', id: 5 }]);
  assert.deepEqual(mixed.map((w) => w.id), [5, 6, 7]);
});

test('moving the second sentence to the start reorders words, pieces and what plays', () => {
  const r = E.moveWords(WORDS, none, none, null, D, 4, 7, 0);
  assert.equal(texts(r.words), 'five six seven eight. one two three four.');
  assert.deepEqual(r.order, [[4.0, 7], [0, 4.0]]);
  assert.deepEqual([r.from, r.to], [0, 3]);
  assert.deepEqual(r.words.map((w) => w.id), [5, 6, 7, 8, 1, 2, 3, 4], 'ids travel with the words');
  const kept = E.keptRanges(E.computeCuts(r.words, r.deleted, D, r.cutGaps, [], r.order), D, r.order);
  assert.deepEqual(kept, [[4.0, 7], [0, 4.0]]);
  // "five" (4.0 s in the recording) now plays first; "one" (0.2 s) after the 3 s of the moved piece.
  assert.ok(near(E.toEdited(kept, 4.0), 0));
  assert.ok(near(E.toEdited(kept, 0.2), 3.2));
  assert.ok(near(E.toSource(kept, 0.5), 4.5));
  assert.ok(near(E.toSource(kept, 3.2), 0.2));
  assert.equal(E.totalLength(kept), 7);
});

test('a move in the middle takes the pause after the words, as a cut would', () => {
  // "two three" (0.8 up to "four" at 2.0) to the very end.
  const r = E.moveWords(WORDS, none, none, null, D, 1, 2, 8);
  assert.equal(texts(r.words), 'one four. five six seven eight. two three');
  assert.deepEqual(r.order, [[0, 0.8], [2.0, 7], [0.8, 2.0]]);
  // Moving them back gives the recording played straight through again.
  const back = E.moveWords(r.words, r.deleted, r.cutGaps, r.order, D, 6, 7, 1);
  assert.equal(texts(back.words), texts(WORDS));
  assert.deepEqual(back.order, [[0, 7]]);
  assert.ok(E.isIdentity(back.order, D));
});

test('moves that change nothing or cannot be made return null', () => {
  assert.equal(E.moveWords(WORDS, none, none, null, D, 2, 3, 2), null);
  assert.equal(E.moveWords(WORDS, none, none, null, D, 2, 3, 4), null, 'right after itself');
  assert.equal(E.moveWords(WORDS, none, none, null, D, 2, 3, 3), null, 'inside itself');
  assert.equal(E.moveWords(WORDS, none, none, null, D, 3, 2, 0), null);
  assert.equal(E.moveWords(WORDS, none, none, null, D, 0, 9, 0), null);
});

test('cut words and shortened pauses stay with their words when words move', () => {
  const deleted = new Set([5]); // "six"
  const cutGaps = new Set([3, -1]); // the pause after "four.", and the lead-in
  const r = E.moveWords(WORDS, deleted, cutGaps, null, D, 4, 7, 0);
  assert.deepEqual([...r.deleted], [1], '"six" is now the second word');
  assert.deepEqual([...r.cutGaps].sort((a, b) => a - b), [-1, 7], 'the pause follows "four.", now the last word');
  // The same pauses as before the move, found by the same words: after "eight." (the tail of
  // the recording) and after "four.". The 0.2 s lead-in is too short to count as a pause.
  const gaps = E.gaps(r.words, D, E.MIN_GAP, r.order);
  assert.deepEqual(gaps.map((g) => [g.i, g.start, g.end, Boolean(g.tail)]), [[3, 6.2, 7, true], [7, 2.4, 4.0, false]]);
  const cuts = E.computeCuts(r.words, r.deleted, D, r.cutGaps, [], r.order);
  // "six" 4.6–5.2 and the pause 2.5–3.9 (0.1 s kept each side).
  assert.deepEqual(cuts.map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]), [[2.5, 3.9], [4.6, 5.2]]);
  // A long lead-in keeps its key (-1) wherever the first words go.
  const late = E.ensureIds(WORDS.map((w) => ({ text: w.text, start: w.start + 1, end: w.end + 1 })));
  const m = E.moveWords(late, none, new Set([-1]), null, 8, 0, 3, 8);
  assert.deepEqual(m.order, [[5, 8], [0, 5]]);
  assert.deepEqual(E.gaps(m.words, 8, E.MIN_GAP, m.order).filter((g) => g.lead).map((g) => [g.i, g.start, g.end]), [[-1, 0, 1.2]]);
  const [leadStart, leadEnd] = E.computeCuts(m.words, none, 8, m.cutGaps, [], m.order)[0];
  assert.ok(leadStart === 0 && near(leadEnd, 1.1));
});

test('a run of cut words stops at a join instead of swallowing the next piece', () => {
  const r = E.moveWords(WORDS, none, none, null, D, 4, 7, 0);
  // Cut "eight." (last of the moved piece) and "one" (first of the next piece): two cuts.
  const cuts = E.computeCuts(r.words, new Set([3, 4]), D, none, [], r.order);
  assert.deepEqual(cuts, [[0, 0.8], [5.8, 7]]);
  const kept = E.keptRanges(cuts, D, r.order);
  assert.deepEqual(kept, [[4.0, 5.8], [0.8, 4.0]]);
});

test('toSource(toEdited(t)) is t for every kept time, whatever was moved and cut', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const words = E.ensureIds(Array.from({ length: 60 }, (_, i) => ({ text: `w${i}`, start: i * 0.5 + 0.1, end: i * 0.5 + 0.45 })));
  const duration = 30.5;
  for (let round = 0; round < 40; round++) {
    let state = { words, deleted: new Set(), cutGaps: new Set(), order: null };
    for (let m = 0; m < 6; m++) {
      const from = Math.floor(rnd() * 55);
      const to = from + Math.floor(rnd() * 5);
      const dest = Math.floor(rnd() * 61);
      const r = E.moveWords(state.words, state.deleted, state.cutGaps, state.order, duration, from, to, dest);
      if (r) state = r;
      if (rnd() < 0.5) state.deleted.add(Math.floor(rnd() * 60));
    }
    assert.equal(state.words.length, 60);
    assert.equal(new Set(state.words.map((w) => w.id)).size, 60, 'no word lost or doubled');
    const order = E.normalizeOrder(state.order, duration);
    assert.deepEqual(order, state.order ?? [[0, duration]], 'the order still tiles the recording');
    const cuts = E.computeCuts(state.words, state.deleted, duration, state.cutGaps, [], state.order);
    const kept = E.keptRanges(cuts, duration, state.order);
    let acc = 0;
    for (const [s, e] of kept) {
      for (const t of [s + 0.001, (s + e) / 2, e - 0.001]) {
        const x = E.toEdited(kept, t);
        assert.ok(near(x, acc + (t - s), 1e-6), `toEdited(${t})`);
        assert.ok(near(E.toSource(kept, x), t, 1e-6), `round trip at ${t}`);
      }
      acc += e - s;
    }
    // Kept words appear on the edited timeline in the order they are shown.
    let last = -1;
    state.words.forEach((w, i) => {
      if (state.deleted.has(i)) return;
      const x = E.toEdited(kept, w.start + 0.001);
      assert.ok(x > last, `word ${i} plays after the one before it`);
      last = x;
    });
  }
});

test('a time on a join or in a cut maps forward by default and back for an end', () => {
  const kept = [[4, 7], [0, 4]]; // second half first
  assert.equal(E.toEdited(kept, 4), 0, '4.0 is where the first piece starts');
  assert.equal(E.toEdited(kept, 4, true), 7, 'as an end, 4.0 is where the second piece stops');
  const cut = [[4, 7], [0, 1], [2, 4]]; // 1–2 cut
  assert.equal(E.toEdited(cut, 1.5), 4, 'inside the cut: where the cut was made');
  assert.equal(E.toEdited(cut, 1.5, true), 4);
  assert.equal(E.toEdited(cut, 9), 3, 'past the end of the recording: the end of its last piece');
});

test('playStep plays the pieces in order, jumping back when it has to', () => {
  const kept = [[4, 7], [0, 1], [2, 4]];
  // Simulate the player: 0.02 s ticks, seeks landing a frame early.
  let t = 4;
  let k = -1;
  const visited = [];
  for (let n = 0; n < 2000; n++) {
    const step = E.playStep(kept, t, k);
    k = step.k;
    if (step.stopAt != null) { t = step.stopAt; break; }
    if (step.seekTo != null) { visited.push([Math.round(t * 100) / 100, step.seekTo]); t = step.seekTo - 0.03; continue; }
    t += 0.02;
  }
  assert.equal(visited.length, 2);
  assert.ok(visited[0][0] >= 7 && near(visited[0][1], 0.01), 'from the end of the first piece back to the start');
  assert.ok(visited[1][0] >= 1 && visited[1][0] < 1.1 && near(visited[1][1], 2.01), 'over the cut');
  assert.ok(near(t, 3.99), `stops at the end of the last piece, not the end of the file (${t})`);
  // After a seek by the user (k unknown) into a cut, playback goes to what follows it.
  assert.deepEqual(E.playStep(kept, 1.5, -1), { k: 2, seekTo: 2.01 });
  assert.deepEqual(E.playStep(kept, 5, -1), { k: 0 });
  assert.deepEqual(E.playStep([], 1, -1), { k: -1, stopAt: 0 });
});

test('wordAt finds the spoken word by time after words have moved', () => {
  const r = E.moveWords(WORDS, none, none, null, D, 4, 7, 0);
  assert.equal(r.words[E.wordAt(r.words, 4.1)].text, 'five');
  assert.equal(r.words[E.wordAt(r.words, 0.9)].text, 'two');
  assert.equal(E.wordAt(r.words, 0.1), -1);
  assert.equal(WORDS[E.wordAt(WORDS, 4.1)].text, 'five');
});

test('normalizeOrder accepts a tiling of the recording and falls back otherwise', () => {
  assert.deepEqual(E.normalizeOrder(null, 7), [[0, 7]]);
  assert.deepEqual(E.normalizeOrder([[4, 7], [0, 4]], 7), [[4, 7], [0, 4]]);
  assert.deepEqual(E.normalizeOrder([[0, 4], [4, 7]], 7), [[0, 7]], 'pieces that carry on are joined');
  assert.deepEqual(E.normalizeOrder([[4, 7], [0, 3]], 7), [[0, 7]], 'a hole');
  assert.deepEqual(E.normalizeOrder([[3, 7], [0, 4]], 7), [[0, 7]], 'an overlap');
  assert.deepEqual(E.normalizeOrder([[4, 9], [0, 4]], 7), [[0, 7]], 'longer than the recording');
});

test('correcting text keeps ids of other words, gives new words new ids and stays in its piece', () => {
  const r = E.moveWords(WORDS, none, none, null, D, 4, 7, 0);
  const ends = E.pieceEnds(r.words, r.order, D);
  assert.deepEqual([...ends], [7, 7, 7, 7, 4, 4, 4, 4]);
  const fixed = E.replaceWords(r.words, r.deleted, r.cutGaps, 3, 3, 'eight nine ten eleven twelve.', ends[3]);
  assert.equal(texts(fixed.words), 'five six seven eight nine ten eleven twelve. one two three four.');
  assert.ok(fixed.words.slice(3, 8).every((w) => w.start < 7 && w.id > 8));
  assert.deepEqual(fixed.words.slice(8).map((w) => w.id), [1, 2, 3, 4]);
  assert.deepEqual(E.layout(fixed.words, r.order, D).pieces.map((p) => [p.from, p.to]), [[0, 7], [8, 11]]);
  // Find and replace leaves a phrase that runs across the join alone.
  const all = E.replaceAll(r.words, r.deleted, r.cutGaps, 'eight one', 'x', ends);
  assert.equal(all.count, 0);
  assert.equal(E.replaceAll(r.words, r.deleted, r.cutGaps, 'one two', 'uno dos', ends).count, 1);
});

test('restoring words after a move clears time cuts under each stretch only', () => {
  const r = E.moveWords(WORDS, none, none, null, D, 4, 7, 0);
  // Time cuts over "eight." (5.8–6.2), over "one" (0.2–0.6) and over "three" (1.4–1.8).
  const rangeCuts = [[0.2, 0.6], [1.4, 1.8], [5.8, 6.2]];
  const back = E.restoreWords(r.words, new Set([3, 4]), rangeCuts, 3, 4);
  assert.deepEqual([...back.deleted], []);
  assert.deepEqual(back.rangeCuts, [[1.4, 1.8]]);
});

test('captions never run across a join and stay in step on the edited timeline', () => {
  const r = E.moveWords(WORDS, none, none, null, D, 1, 2, 8); // one four. five six seven eight. two three
  const ends = E.pieceEnds(r.words, r.order, D);
  const groups = C.groupWords(r.words, r.deleted, 'subtitle', ends);
  assert.deepEqual(groups.map((g) => g.map((i) => r.words[i].text).join(' ')), ['one', 'four.', 'five six seven eight.', 'two three']);
  const spans = C.groupSpans(groups, r.words, ends);
  assert.ok(spans[0].end <= 0.8 + 1e-9, 'the caption for "one" ends with its piece');
  const kept = E.keptRanges(E.computeCuts(r.words, r.deleted, D, r.cutGaps, [], r.order), D, r.order);
  const srt = C.buildSubtitles({ words: r.words, deleted: r.deleted, settings: { preset: 'subtitle' }, toEdited: (t, end) => E.toEdited(kept, t, end), ends });
  const starts = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) -->/g)].map((m) => Number(m[3]) + Number(m[4]) / 1000);
  // one 0.2 · four. 2.0-1.2 · five 4.0-1.2 · two: 5.8 s of the first two pieces, then 0.8 → 5.8
  assert.deepEqual(starts, [0.2, 0.8, 2.8, 5.8]);
  assert.match(srt, /two three/);
  // The preview finds the caption for a time in the recording, wherever it now plays.
  assert.equal(C.activeAt(spans, r.words, 0.9).span.words.map((i) => r.words[i].text).join(' '), 'two three');
  assert.equal(C.activeAt(spans, r.words, 4.7).current, 3);
});

test('track items follow the recording they were put on', () => {
  const tracks = T.normalize([{ type: 'overlay', name: 'B-roll', items: [{ id: 'a', start: 4.5, length: 1 }] }]);
  const moved = [[4, 7], [0, 4]];
  assert.ok(near(T.placed(tracks, [[0, 7]])[0].items[0].startE, 4.5));
  assert.ok(near(T.placed(tracks, moved)[0].items[0].startE, 0.5), 'over the same words, now near the start');
});

test('a time range dragged on the timeline stops at a join', () => {
  const kept = [[4, 7], [0, 4]];
  assert.deepEqual(E.sourceSpan(kept, 1, 2, true), [5, 6]);
  assert.deepEqual(E.sourceSpan(kept, 2, 5, true), [6, 7], 'not 6 back to 2');
  assert.deepEqual(E.sourceSpan([[0, 1], [2, 7]], 0.5, 3), [0.5, 4], 'in time order it may span a cut, as before');
});

test('snapRanges keeps a jump back as a cut', () => {
  assert.deepEqual(E.snapRanges([[4, 7], [0, 4]], 30), [[4, 7], [0, 4]]);
  assert.deepEqual(E.snapRanges([[0, 2], [2, 4]], 30), [[0, 4]]);
});

test('the export reads a moved piece through its own seek', () => {
  const { args } = buildRenderArgs({ input: 'in.mp4', output: 'out.mp4', ranges: [[4, 7], [0, 1], [2, 4]], hasVideo: true, hasAudio: true, duration: 7, width: 320, height: 240, fps: 30, filterPath: (p) => p });
  assert.equal(args.filter((a) => a === 'in.mp4').length, 2, 'one input for the moved piece, one for the rest');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3/);
  assert.match(graph, /\[s1_0\]trim=start=0\.000000:end=1\.000000/);
});

test('exported video plays the moved piece first, picture and length exact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-reorder-'));
  try {
    // 2 s red then 2 s blue.
    const src = path.join(dir, 'two.mp4');
    execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=30:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-pix_fmt', 'yuv420p', '-g', '15', src], { stdio: 'ignore' });
    const out = path.join(dir, 'out.mp4');
    await renderEdit({ input: src, output: out, ranges: [[2, 4], [0, 2]], hasVideo: true, hasAudio: true, duration: 4, width: 160, height: 120, fps: 30 });
    const info = await probe(out);
    assert.ok(Math.abs(info.duration - 4) < 0.06, `duration ${info.duration}`);
    const isBlue = ([r, , b]) => b > 150 && r < 100;
    const isRed = ([r, , b]) => r > 150 && b < 100;
    assert.ok(isBlue(await pixelAt(out, 0.1, 80, 60)), 'blue first');
    assert.ok(isBlue(await pixelAt(out, 1.9, 80, 60)));
    assert.ok(isRed(await pixelAt(out, 2.1, 80, 60)), 'then red');
    assert.ok(isRed(await pixelAt(out, 3.9, 80, 60)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a version 2 project is upgraded on open and the old file is kept as a backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-v3-'));
  try {
    const projects = createProjects({ dir, readSettings: async () => ({}), writeSettings: async () => {} });
    const file = path.join(dir, 'Old.talkcut');
    const v2 = { version: 2, media: { path: '/videos/clip.mp4', duration: 7 }, words: WORDS.map(({ id, ...w }) => w), deleted: [1], cutGaps: [3] };
    fs.writeFileSync(file, JSON.stringify(v2));
    const opened = await projects.open(file);
    assert.equal(opened.version, 3);
    assert.equal(opened.order, null);
    assert.deepEqual(opened.words.map((w) => w.id), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(opened.deleted, [1]);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.v2.bak`, 'utf8')), v2, 'the backup is the old file, untouched');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.version, 3);
    assert.equal(onDisk.words[0].id, 1);
    // Opening again changes nothing and does not touch the backup.
    fs.writeFileSync(`${file}.v2.bak`, 'keep me');
    assert.equal((await projects.open(file)).version, 3);
    assert.equal(fs.readFileSync(`${file}.v2.bak`, 'utf8'), 'keep me');
    assert.equal(upgrade(opened), opened);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
