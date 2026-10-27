// Local speech-to-text with word timestamps, using whisper.cpp's CLI.
//
// Long recordings are split at pauses into short clips and transcribed in one whisper.cpp
// run. Whisper decodes each 30 s window conditioned on the last one, so on code-mixed or
// low-resource speech (Telugu with English, for example) one bad window loops and drags
// the rest of the file with it; short independent clips keep a mistake contained.
// Word times come from whisper.cpp's DTW token alignment, offset back to the original file.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { decodeToWav, extractClip } = require('./media');

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const MODELS = {
  fast: { file: 'ggml-large-v3-turbo-q5_0.bin', bytes: 574041195, dtw: 'large.v3.turbo', label: 'Fast' },
  accurate: { file: 'ggml-large-v3-q5_0.bin', bytes: 1081140203, dtw: 'large.v3', label: 'Accurate (slower)' },
};
// Turbo's pruned decoder guesses languages badly (Telugu came back as Tamil or Hindi), so
// detection always uses the full model.
const DETECT_MODEL = 'accurate';

const LANGUAGES = {
  auto: 'Auto-detect',
  en: 'English',
  te: 'Telugu',
  hi: 'Hindi',
  ta: 'Tamil',
  kn: 'Kannada',
  ml: 'Malayalam',
  mr: 'Marathi',
  bn: 'Bengali',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

// Whisper copies the writing style of its prompt. People speaking Indian languages mix in
// English words constantly; without a prompt Whisper spells those in the native script
// ("లేట్స్ రాంక్ దే బేస్ జాబ్" for "Let's rank the best job"). A short code-mixed example
// makes it keep English words in English letters, the way people write and Descript shows it.
// On a real Telugu recording this raised English-letter words from 14 to 54 with large-v3.
// The sentences are deliberately about everyday things unlikely to be said in a recording:
// on unclear audio Whisper sometimes copies its prompt, and dropPromptEcho removes any run of
// three or more prompt words that shows up in the transcript.
const STYLE_PROMPTS = {
  te: 'నిన్న మా ఊరిలో cricket match జరిగింది. Rain వల్ల match ని cancel చేశారు. తర్వాత అందరం tea తాగాం.',
  hi: 'कल हमारे गाँव में cricket match हुआ. Rain की वजह से match cancel हो गया. फिर सबने tea पी.',
  ta: 'நேற்று எங்க ஊர்ல cricket match நடந்துச்சு. Rain னால match ஐ cancel பண்ணிட்டாங்க. அப்புறம் எல்லாரும் tea குடிச்சோம்.',
  kn: 'ನಿನ್ನೆ ನಮ್ಮ ಊರಲ್ಲಿ cricket match ಆಯ್ತು. Rain ಇಂದ match cancel ಆಯ್ತು. ಆಮೇಲೆ ಎಲ್ಲರೂ tea ಕುಡಿದ್ವಿ.',
  ml: 'ഇന്നലെ ഞങ്ങളുടെ നാട്ടിൽ cricket match നടന്നു. Rain കാരണം match cancel ചെയ്തു. പിന്നെ എല്ലാവരും tea കുടിച്ചു.',
  mr: 'काल आमच्या गावात cricket match झाली. Rain मुळे match cancel झाली. मग सगळ्यांनी tea घेतला.',
  bn: 'গতকাল আমাদের গ্রামে cricket match হয়েছিল. Rain এর জন্য match cancel হয়ে গেল. তারপর সবাই tea খেলাম.',
};

const promptKey = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');

// Remove runs of three or more consecutive words that repeat the prompt.
function dropPromptEcho(words, prompt) {
  if (!prompt) return words;
  const p = prompt.split(/\s+/).map(promptKey).filter(Boolean);
  const keys = words.map((w) => promptKey(w.text));
  const drop = new Set();
  for (let i = 0; i < keys.length; i++) {
    for (let j = 0; j < p.length; j++) {
      let n = 0;
      while (i + n < keys.length && j + n < p.length && keys[i + n] && keys[i + n] === p[j + n]) n++;
      if (n >= 3) for (let k = 0; k < n; k++) drop.add(i + k);
    }
  }
  return words.filter((_, i) => !drop.has(i));
}

const CLIP_MAX = 8; // longest clip sent to Whisper, in seconds
const CLIP_MIN = 3; // never cut a clip shorter than this when splitting
const CLIP_PAD = 0.15; // keep word edges intact at clip boundaries

function whisperCliPath() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'whisper', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'),
    process.resourcesPath && path.join(process.resourcesPath, 'whisper-cli'),
    path.join(__dirname, '..', 'vendor', 'whisper.cpp', 'build', 'bin', 'whisper-cli'),
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('The whisper.cpp engine is not built yet. Run `npm run build:whisper` in the Talkcut folder, then try again.');
  return found;
}

async function ensureModel(modelDir, key, onProgress) {
  const { file, bytes, label } = MODELS[key];
  const dir = path.join(modelDir, 'ggml');
  const target = path.join(dir, file);
  const existing = await fsp.stat(target).catch(() => null);
  if (existing?.size === bytes) return target;

  await fsp.mkdir(dir, { recursive: true });
  const partial = `${target}.part`;
  const res = await fetch(MODEL_BASE_URL + file);
  if (!res.ok || !res.body) throw new Error(`Could not download the speech model (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || bytes;
  const out = fs.createWriteStream(partial);
  let loaded = 0;
  try {
    for await (const chunk of res.body) {
      loaded += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress?.({ stage: 'model', progress: loaded / total, model: label, megabytes: Math.round(bytes / 1e6) });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(partial, { force: true });
    throw err;
  }
  if ((await fsp.stat(partial)).size !== bytes) {
    await fsp.rm(partial, { force: true });
    throw new Error('The speech model download was incomplete. Check your connection and try again.');
  }
  await fsp.rename(partial, target);
  return target;
}

async function modelReady(modelDir, key) {
  const stat = await fsp.stat(path.join(modelDir, 'ggml', MODELS[key].file)).catch(() => null);
  return stat?.size === MODELS[key].bytes;
}

function runWhisper(args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(whisperCliPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let buffer = '';
    const onData = (c) => {
      const text = c.toString();
      tail = (tail + text).slice(-20_000);
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach((line) => onLine?.(line));
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (buffer) onLine?.(buffer);
      if (code === 0) resolve(tail);
      else reject(new Error(`Transcription failed (whisper.cpp exit code ${code}): ${tail.slice(-600)}`));
    });
  });
}

function threads() {
  return String(Math.max(2, Math.min(8, os.availableParallelism?.() ?? 4)));
}

// Loudness per 20 ms frame of a 16 kHz mono 16-bit WAV.
const FRAME = 0.02;
async function readEnergy(wavPath) {
  const buf = await fsp.readFile(wavPath);
  // Find the "data" chunk; ffmpeg may write extra chunks before it.
  let pos = 12;
  while (pos + 8 <= buf.length && buf.toString('ascii', pos, pos + 4) !== 'data') pos += 8 + buf.readUInt32LE(pos + 4);
  const start = pos + 8;
  const samples = new Int16Array(buf.buffer, buf.byteOffset + start, Math.floor((buf.length - start) / 2));
  const per = Math.round(16000 * FRAME);
  const rms = new Float32Array(Math.ceil(samples.length / per));
  for (let f = 0; f < rms.length; f++) {
    let sum = 0;
    const end = Math.min(samples.length, (f + 1) * per);
    for (let i = f * per; i < end; i++) sum += (samples[i] / 32768) ** 2;
    rms[f] = Math.sqrt(sum / Math.max(1, end - f * per));
  }
  return rms;
}

function smooth(rms, radius) {
  const out = new Float32Array(rms.length);
  for (let i = 0; i < rms.length; i++) {
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(rms.length - 1, i + radius); k++) { s += rms[k]; n++; }
    out[i] = s / n;
  }
  return out;
}

// Loudness that counts as speech, relative to the recording's own noise floor.
function speechThreshold(rms) {
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const loud = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  return Math.max(0.004, floor * 2.5, loud * 0.08);
}

// Cut the recording into clips of at most CLIP_MAX seconds, each ending at the quietest
// moment available, so a cut lands between words and Whisper sees short, complete phrases.
// Whisper skips or merges repeated sentences and drops speech late in long windows; short
// clips avoid both. Clips with no speech-level sound are left out.
function planClips(rms, duration) {
  const quiet = smooth(rms, 5);
  const threshold = speechThreshold(rms);
  const maxF = Math.round(CLIP_MAX / FRAME);
  const minF = Math.round(CLIP_MIN / FRAME);
  const clips = [];
  let start = 0;
  while (start < rms.length) {
    let end = rms.length;
    if (rms.length - start > maxF) {
      let best = Infinity;
      for (let f = start + minF; f < start + maxF; f++) {
        if (quiet[f] < best) { best = quiet[f]; end = f; }
      }
    }
    let peak = 0;
    for (let f = start; f < end; f++) if (rms[f] > peak) peak = rms[f];
    if (peak >= threshold) clips.push([start * FRAME, Math.min(duration, end * FRAME)]);
    start = end;
  }
  return clips.map(([a, b]) => [Math.max(0, a - CLIP_PAD), Math.min(duration, b + CLIP_PAD)]);
}

// Stretches with speech-level sound (short dips inside words and phrases bridged).
function speechRegions(rms) {
  const threshold = speechThreshold(rms);
  const quiet = smooth(rms, 2);
  const regions = [];
  let open = -1;
  let lastLoud = -1;
  for (let f = 0; f < quiet.length; f++) {
    if (quiet[f] >= threshold) {
      if (open < 0) open = f;
      lastLoud = f;
    } else if (open >= 0 && f - lastLoud > 15) {
      regions.push([open * FRAME, (lastLoud + 1) * FRAME]);
      open = -1;
    }
  }
  if (open >= 0) regions.push([open * FRAME, (lastLoud + 1) * FRAME]);
  return regions;
}

// Fit each word to the sound around it: a start that falls in silence moves forward to where
// the sound begins, and the end comes back to shortly after the sound stops. Pauses then
// appear only where the recording is actually quiet.
function trimToSound(words, rms) {
  const threshold = speechThreshold(rms);
  const loud = (f) => f >= 0 && f < rms.length && rms[f] >= threshold;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const f0 = Math.max(0, Math.floor(w.start / FRAME));
    const f1 = Math.min(rms.length - 1, Math.ceil(w.end / FRAME));
    if (!loud(f0) && !loud(f0 + 1) && !loud(f0 + 2)) {
      let f = f0;
      while (f <= f1 && !loud(f)) f++;
      if (f <= f1) w.start = Math.max(w.start, f * FRAME - 0.03);
    }
    // End at the first silence of a quarter second or more after the word's sound.
    let quietRun = 0;
    let lastLoud = -1;
    for (let f = Math.floor(w.start / FRAME); f <= f1; f++) {
      if (loud(f)) { lastLoud = f; quietRun = 0; continue; }
      if (lastLoud >= 0 && ++quietRun >= 12) break;
    }
    if (lastLoud >= 0) w.end = Math.min(w.end, (lastLoud + 1) * FRAME + 0.08);
    w.end = Math.max(w.end, w.start + 0.05);
    const next = words[i + 1];
    if (next && w.end > next.start) w.end = Math.max(w.start, next.start);
  }
  return words;
}

// Parts of the speech with no transcribed word in them, long enough to hold a phrase.
function uncovered(regions, words, minGap = 1.2) {
  const starts = words.map((w) => w.start).sort((a, b) => a - b);
  const holes = [];
  for (const [a, b] of regions) {
    let cursor = a;
    for (const t of starts) {
      if (t < a - 0.2 || t > b + 0.2) continue;
      if (t - cursor >= minGap) holes.push([cursor, t]);
      cursor = Math.max(cursor, t + 0.3);
    }
    if (b - cursor >= minGap) holes.push([cursor, b]);
  }
  return holes;
}

// Vote over a spread of clips. English-only clips are common inside code-mixed speech,
// so any other language that shows up in a fair share of clips wins.
async function detectLanguage(clipFiles, modelPath) {
  const step = Math.max(1, Math.floor(clipFiles.length / 8));
  const sample = clipFiles.filter((_, i) => i % step === 0).slice(0, 8);
  const votes = {};
  await runWhisper(
    ['-m', modelPath, '-l', 'auto', '-dl', '-t', threads(), ...sample.flatMap((f) => ['-f', f])],
    {
      onLine: (line) => {
        const m = line.match(/auto-detected language: (\w+) \(p = ([\d.]+)\)/);
        if (m) votes[m[1]] = (votes[m[1]] ?? 0) + Number(m[2]);
      },
    },
  );
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const other = ranked.find(([lang]) => lang !== 'en');
  const total = ranked.reduce((sum, [, v]) => sum + v, 0);
  if (other && other[1] >= total * 0.3) return other[0];
  return ranked[0]?.[0] ?? 'en';
}

const NON_SPEECH = /^[[(*♪].*[\])*♪]$/; // [BLANK_AUDIO], (music), *laughs*, ♪
const HAS_WORD = /[\p{L}\p{N}]/u;

// Turn whisper.cpp's one-word-per-segment JSON into [{ text, start, end }] in seconds,
// shifted by `offset` (where the clip starts in the original file).
function parseWords(json, offset = 0, clipEnd = Infinity) {
  const words = [];
  for (const seg of json.transcription ?? []) {
    // Telugu and other scripts span several byte-level tokens; a broken run decodes to U+FFFD.
    // A decoder loop inside one word ("జిప్రిక్రిక్రిక్రి…") collapses to a single repeat.
    const text = seg.text.replace(/�/g, '').replace(/(.{2,6}?)\1{2,}/gu, '$1').trim();
    if (!text || NON_SPEECH.test(text)) continue;
    const dtw = (seg.tokens ?? [])
      .filter((t) => !/^\[_/.test(t.text))
      .map((t) => t.t_dtw)
      .filter((t) => Number.isFinite(t) && t >= 0);
    const start = offset + (dtw.length ? Math.min(...dtw) / 100 : seg.offsets.from / 1000);
    if (!HAS_WORD.test(text)) {
      // Stand-alone punctuation such as "-" belongs to the word before it.
      if (words.length) words[words.length - 1].text += text;
      continue;
    }
    words.push({ text, start: Math.min(start, clipEnd), end: Math.min(offset + seg.offsets.to / 1000, clipEnd) });
  }
  return words;
}

// Order words and let each run until the next one starts. Whisper's own word end times are
// unreliable next to the DTW start times (often earlier than the start), so ends are derived
// from the next word and then trimmed back to the sound by trimToSound.
function finalizeWords(words) {
  words.sort((a, b) => a.start - b.start);
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    words[i].end = next ? Math.max(words[i].start, next.start) : Math.max(words[i].end, words[i].start + 0.4);
  }
  return words;
}

// Transcribe a list of [start, end] clips of the WAV in one whisper.cpp run (the model loads
// once) and return their words on the original timeline.
async function transcribeClips(wav, clips, work, tag, { modelPath, quality, lang, prompt, onClipDone }) {
  const files = [];
  for (let i = 0; i < clips.length; i++) {
    const f = path.join(work, `${tag}${String(i).padStart(4, '0')}.wav`);
    await extractClip(wav, f, clips[i][0], clips[i][1]);
    files.push(f);
  }
  if (!files.length) return [];
  await runWhisper(
    [
      '-m', modelPath,
      '-l', lang,
      '-t', threads(),
      '-ml', '1', '-sow', // one word per segment
      '--dtw', MODELS[quality].dtw, // accurate token timestamps
      ...(prompt ? ['--prompt', prompt] : []),
      '-ojf', '-np',
      ...files.flatMap((f) => ['-f', f]),
    ],
    { onLine: (line) => { if (/output_json: saving output/.test(line)) onClipDone?.(); } },
  );
  const words = [];
  for (let i = 0; i < files.length; i++) {
    // whisper.cpp can split a multi-byte character across tokens; decoding as UTF-8 with
    // replacement keeps JSON.parse working and parseWords strips the replacement marks.
    const raw = await fsp.readFile(`${files[i]}.json`).catch(() => null);
    if (raw) words.push(...parseWords(JSON.parse(raw.toString('utf8')), clips[i][0], clips[i][1]));
  }
  return words;
}

// Returns { words: [{ text, start, end }], language } with times in seconds.
async function transcribe(filePath, { modelDir, language = 'auto', quality = 'fast', stylePrompt, onProgress } = {}) {
  if (!Object.hasOwn(LANGUAGES, language)) throw new Error(`Unsupported language: ${language}`);
  if (!Object.hasOwn(MODELS, quality)) throw new Error(`Unsupported quality: ${quality}`);

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutline-'));
  try {
    onProgress?.({ stage: 'decode', progress: 0 });
    const wav = path.join(work, 'audio.wav');
    await decodeToWav(filePath, wav);
    const rms = await readEnergy(wav);
    const duration = rms.length * FRAME;
    const clips = planClips(rms, duration);
    if (!clips.length) return { words: [], language: language === 'auto' ? 'en' : language };

    let lang = language;
    if (lang === 'auto') {
      const detectModel = await ensureModel(modelDir, DETECT_MODEL, onProgress);
      onProgress?.({ stage: 'detect', progress: 0 });
      const sampleFiles = [];
      const step = Math.max(1, Math.floor(clips.length / 8));
      for (let i = 0; i < clips.length && sampleFiles.length < 8; i += step) {
        const f = path.join(work, `detect${i}.wav`);
        await extractClip(wav, f, clips[i][0], clips[i][1]);
        sampleFiles.push(f);
      }
      lang = await detectLanguage(sampleFiles, detectModel);
    }

    const modelPath = await ensureModel(modelDir, quality, onProgress);
    const prompt = stylePrompt === undefined ? STYLE_PROMPTS[lang] : stylePrompt || null;
    onProgress?.({ stage: 'transcribe', progress: 0, language: lang });
    let done = 0;
    const words = await transcribeClips(wav, clips, work, 'clip', {
      modelPath, quality, lang, prompt,
      onClipDone: () => onProgress?.({ stage: 'transcribe', progress: (++done / clips.length) * 0.9, language: lang }),
    });

    // Second pass: speech the first pass left without words (a repeated take, a phrase lost
    // at a clip edge) is transcribed again on its own, padded a little on both sides. This
    // pass runs without the style prompt: now and then the prompt makes Whisper return
    // nothing for a clip, and a plain retry recovers it.
    // Only words that start inside the hole itself are kept; the padding is there for context.
    // Fast (turbo) sometimes returns nothing at all for a stretch of Telugu; whatever it still
    // leaves empty goes to the Accurate model, which is already downloaded whenever language
    // detection has run.
    const regions = speechRegions(rms);
    const fillHoles = async (path_, q, tag) => {
      const holes = uncovered(regions, words);
      if (!holes.length) return;
      const padded = holes.map(([a, b]) => [Math.max(0, a - 0.3), Math.min(duration, b + 0.3)]);
      const extra = await transcribeClips(wav, padded, work, tag, { modelPath: path_, quality: q, lang, prompt: null });
      for (const w of extra) {
        if (holes.some(([a, b]) => w.start >= a - 0.05 && w.start < b)) words.push(w);
      }
    };
    await fillHoles(modelPath, quality, 'hole');
    if (quality !== 'accurate' && uncovered(regions, words).length && (await modelReady(modelDir, 'accurate'))) {
      await fillHoles(await ensureModel(modelDir, 'accurate'), 'accurate', 'hole2');
    }
    onProgress?.({ stage: 'transcribe', progress: 1, language: lang });
    return { words: trimToSound(finalizeWords(dropPromptEcho(words, prompt)), rms), language: lang };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

// Offered next to the local models; handled by cloud.js, not whisper.cpp.
const CLOUD_QUALITY = { cloud: { label: 'Cloud · ElevenLabs (best)' } };

module.exports = { CLOUD_QUALITY, transcribe, dropPromptEcho, parseWords, finalizeWords, trimToSound, planClips, speechRegions, uncovered, readEnergy, LANGUAGES, MODELS, STYLE_PROMPTS };
