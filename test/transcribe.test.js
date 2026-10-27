const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseWords, finalizeWords, trimToSound, planClips, speechRegions, uncovered, dropPromptEcho, transcribe, MODELS } = require('../src/transcribe.js');

// Trimmed whisper.cpp -ojf output (-ml 1 -sow --dtw) from a real recording.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'whisper-output.json'), 'utf8'));

test('parseWords uses DTW times, not drifting segment offsets', () => {
  const words = parseWords(fixture);
  assert.equal(words[0].text, "Let's");
  // The segment offset says 0.00 s; speech actually starts near 3.85 s and DTW says 4.00 s.
  assert.equal(words[0].start, 4);
});

test('parseWords shifts times by the clip offset and clamps to the clip end', () => {
  const words = parseWords(fixture, 100, 105);
  assert.equal(words[0].start, 104);
  assert.ok(words.every((w) => w.start <= 105 && w.end <= 105));
});

test('parseWords drops empty segments and folds stand-alone punctuation into the previous word', () => {
  const words = parseWords(fixture);
  assert.ok(words.every((w) => /[\p{L}\p{N}]/u.test(w.text)), JSON.stringify(words.map((w) => w.text)));
  assert.ok(!words.some((w) => w.text === '-'));
});

test('finalizeWords returns ordered, non-overlapping words', () => {
  const words = finalizeWords(parseWords(fixture));
  for (let i = 0; i < words.length; i++) {
    assert.ok(words[i].end >= words[i].start, `word ${i} ends before it starts`);
    if (i > 0) assert.ok(words[i].start >= words[i - 1].start, `word ${i} out of order`);
    if (i < words.length - 1) assert.ok(words[i].end <= words[i + 1].start, `word ${i} overlaps the next`);
  }
});

test('parseWords skips non-speech markers, broken characters and decoder loops', () => {
  const seg = (text, from, dtw) => ({ text, offsets: { from, to: from + 500 }, tokens: dtw == null ? [] : [{ text, t_dtw: dtw }] });
  const words = parseWords({
    transcription: [
      seg(' [BLANK_AUDIO]', 0),
      seg(' (music)', 1000),
      seg(' Hello', 2000, 210),
      seg(' �', 2500, 260),
      seg(' జిప్రిక్రిక్రిక్రిక్రిక్రి', 3000, 300),
      seg(' రిక్రిక్రిక్రిటర్', 3500, 350),
      seg(' committee', 4000, 400),
    ],
  });
  assert.deepEqual(words.map((w) => w.text), ['Hello', 'జిప్రిక్రి', 'రిక్రిటర్', 'committee']);
  assert.equal(words[0].start, 2.1);
});

// Loudness frames (20 ms): speech is 0.2, pauses are 0.001.
function frames(spec) {
  const out = [];
  for (const [seconds, level] of spec) for (let k = 0; k < Math.round(seconds / 0.02); k++) out.push(level);
  return Float32Array.from(out);
}

test('planClips cuts long speech into clips of at most 8 s at the quietest points', () => {
  // 0-1 silence, 1-20 speech with short dips at 6 and 13.5, 20-22 silence, 22-24 speech
  const rms = frames([[1, 0.001], [5, 0.2], [0.3, 0.01], [7.2, 0.2], [0.3, 0.01], [6.2, 0.2], [2, 0.001], [2, 0.2]]);
  const duration = rms.length * 0.02;
  const clips = planClips(rms, duration);
  for (const [a, b] of clips) assert.ok(b - a <= 8 + 0.31, `clip ${a.toFixed(2)}-${b.toFixed(2)} too long`);
  for (const t of [1.5, 5.9, 6.5, 13.4, 14, 19.9, 23]) {
    assert.ok(clips.some(([a, b]) => t >= a && t <= b), `t=${t} not covered`);
  }
  // cuts land in the dips, not mid-speech
  const cutPoints = clips.slice(1).map(([a]) => a + 0.15);
  assert.ok(cutPoints.some((t) => Math.abs(t - 6.15) < 0.2), JSON.stringify(cutPoints));
});

test('speechRegions and uncovered find speech with no words', () => {
  const rms = frames([[1, 0.001], [3, 0.2], [1, 0.001], [3, 0.2], [1, 0.001]]);
  const regions = speechRegions(rms);
  assert.equal(regions.length, 2);
  const words = [1.1, 1.6, 2.2, 2.8, 3.5].map((t) => ({ start: t }));
  const holes = uncovered(regions, words);
  assert.equal(holes.length, 1);
  assert.ok(Math.abs(holes[0][0] - 5) < 0.1 && Math.abs(holes[0][1] - 8) < 0.1, JSON.stringify(holes));
});

test('dropPromptEcho removes copied prompt phrases but keeps short overlaps', () => {
  const prompt = 'నిన్న మా ఊరిలో cricket match జరిగింది. Rain వల్ల match ని cancel చేశారు.';
  const words = ['GPT', 'cricket', 'match', 'జరిగింది.', 'Rain', 'వల్ల', 'అయింది', 'match', 'ని', 'చూశాం'].map((text) => ({ text }));
  assert.deepEqual(dropPromptEcho(words, prompt).map((w) => w.text), ['GPT', 'అయింది', 'match', 'ని', 'చూశాం']);
});

test('words fit the sound: no slivers, no words over silence, pauses only where it is quiet', () => {
  // speech 1-2 s, silence 2-3.5 s, speech 3.5-5 s
  const rms = frames([[1, 0.001], [1, 0.2], [1.5, 0.001], [1.5, 0.2], [1, 0.001]]);
  // Whisper-style output: ends earlier than starts; the third word starts in the silence.
  const raw = [
    { text: 'a', start: 1.0, end: 0.9 },
    { text: 'b', start: 1.5, end: 1.4 },
    { text: 'c', start: 3.2, end: 3.0 },
    { text: 'd', start: 4.2, end: 4.0 },
  ];
  const words = trimToSound(finalizeWords(raw), rms);
  assert.ok(words.every((w) => w.end - w.start >= 0.3), JSON.stringify(words));
  assert.ok(words[1].end < 2.2, `b should end with the sound, got ${words[1].end}`);
  assert.ok(words[2].start >= 3.4, `c should start where the sound starts, got ${words[2].start}`);
  assert.equal(words[0].end, words[1].start); // continuous speech has no gap between words
});

// End-to-end check with the real engine; skipped when whisper.cpp or the model is not set up.
const modelDir = path.join(os.homedir(), 'Library', 'Application Support', 'cutline', 'models');
const cli = path.join(__dirname, '..', 'vendor', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const model = path.join(modelDir, 'ggml', MODELS.fast.file);
const ready = fs.existsSync(cli) && fs.existsSync(model) && fs.existsSync('/usr/bin/say');

test('transcribes speech with accurate word times', { skip: !ready && 'whisper.cpp or the fast model not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-speech-'));
  try {
    // Two seconds of silence first, then two sentences with a pause, so drift and clip offsets show up.
    const speech = path.join(dir, 'speech.aiff');
    execFileSync('/usr/bin/say', ['-o', speech, '[[slnc 2000]] Hello and welcome to the show. [[slnc 1500]] Today we talk about editing.']);
    const { words, language } = await transcribe(speech, { modelDir, language: 'en', quality: 'fast' });
    assert.equal(language, 'en');
    const text = words.map((w) => w.text.toLowerCase().replace(/[^a-z]/g, ''));
    assert.ok(text.includes('hello') && text.includes('welcome') && text.includes('editing'), text.join(' '));
    assert.ok(words[0].start > 1.6 && words[0].start < 2.6, `first word at ${words[0].start}`);
    const today = words.find((w) => /today/i.test(w.text));
    const show = words.find((w) => /show/i.test(w.text));
    assert.ok(today.start - show.end > 1.0, `pause between sentences: ${show.end} -> ${today.start}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
