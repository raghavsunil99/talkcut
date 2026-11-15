// Speech-to-text benchmark: word error rate per engine and language.
//   node scripts/bench-stt.js [--clips=3] [--langs=te,ta,ml,kn,hi,en] [--engines=whisper-fast,...]
//
// Clips come from FLEURS (Google, CC BY 4.0, read speech with reference transcripts). Only the
// first ~4 MB of each language's test archive is downloaded (about 24 MB in all, not the 2.5 GB
// archives) into <tmp>/talkcut-bench-stt/. Results are also written there as JSON, one file
// per run, so two runs can be compared.
//
// Engines that are not available are skipped and the reason is printed:
//   (clips are loudness-normalised, see loadClips)
//   whisper-fast / whisper-accurate  need `npm run build:whisper` and the model in the models folder
//                                    (WHISPER_MODEL_DIR overrides the folder)
//   elevenlabs                       needs ELEVENLABS_API_KEY in the environment (never read from
//                                    the app's settings, never printed or written)
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const { wordErrors } = require('./lib/wer.js');
const transcribeLocal = require('../src/transcribe.js');
const { transcribeCloud } = require('../src/cloud.js');

const FLEURS = 'https://huggingface.co/datasets/google/fleurs/resolve/main/data';
const FLEURS_CONFIG = { te: 'te_in', ta: 'ta_in', ml: 'ml_in', kn: 'kn_in', hi: 'hi_in', en: 'en_us' };
const PREFIX_BYTES = 4_000_000;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const CLIPS = Number(args.clips ?? 3);
const LANGS = String(args.langs ?? 'te,ta,ml,kn,hi,en').split(',').filter((l) => FLEURS_CONFIG[l]);
const cacheDir = path.join(os.tmpdir(), 'talkcut-bench-stt');

// ---- corpus ----

// Reads complete files out of a (possibly cut-off) gzipped tar.
function untarPartial(gz) {
  const tar = zlib.gunzipSync(gz, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const files = new Map();
  for (let pos = 0; pos + 512 <= tar.length;) {
    const name = tar.toString('utf8', pos, pos + 100).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.toString('ascii', pos + 124, pos + 136).replace(/\0.*$/, '').trim(), 8) || 0;
    const end = pos + 512 + size;
    if (end > tar.length) break; // cut off mid-file
    if (size > 0) files.set(path.basename(name), tar.subarray(pos + 512, end));
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function get(url, headers) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadClips(lang) {
  const dir = path.join(cacheDir, 'fleurs-loud', lang);
  const index = path.join(dir, 'clips.json');
  if (fs.existsSync(index)) {
    const saved = JSON.parse(await fsp.readFile(index, 'utf8'));
    if (saved.length >= CLIPS) return saved.slice(0, CLIPS);
  }
  await fsp.mkdir(dir, { recursive: true });
  const cfg = FLEURS_CONFIG[lang];
  const tsv = (await get(`${FLEURS}/${cfg}/test.tsv`)).toString('utf8');
  const refs = new Map();
  for (const line of tsv.split('\n')) {
    const c = line.split('\t'); // id, file, raw transcription, normalised transcription, ...
    if (c.length > 3) refs.set(c[1], c[2]);
  }
  const files = untarPartial(await get(`${FLEURS}/${cfg}/audio/test.tar.gz`, { Range: `bytes=0-${PREFIX_BYTES - 1}` }));
  const clips = [];
  for (const [file, data] of files) {
    if (!refs.has(file) || clips.length >= Math.max(CLIPS, 3)) continue;
    // Some FLEURS clips are very quiet (peak below the app's speech floor, so Talkcut treats
    // them as silence). Normalise loudness for every engine alike; this is not engine tuning.
    const raw = path.join(dir, `raw-${file}`);
    await fsp.writeFile(raw, data);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-af', 'loudnorm=I=-20:TP=-2', '-ar', '16000', '-ac', '1', path.join(dir, file)]);
    await fsp.rm(raw);
    clips.push({ file: path.join(dir, file), reference: refs.get(file) });
  }
  if (!clips.length) throw new Error(`no clips found for ${lang}`);
  await fsp.writeFile(index, JSON.stringify(clips));
  return clips.slice(0, CLIPS);
}

// ---- engines ----

function whisperEngine(quality) {
  const modelDir = process.env.WHISPER_MODEL_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'cutline', 'models');
  return {
    id: `whisper-${quality}`,
    label: `whisper.cpp ${transcribeLocal.MODELS[quality].label}`,
    available() {
      const bin = path.join(__dirname, '..', 'vendor', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
      if (!fs.existsSync(bin)) return 'whisper.cpp is not built (run `npm run build:whisper`)';
      const model = path.join(modelDir, 'ggml', transcribeLocal.MODELS[quality].file);
      if (!fs.existsSync(model)) return `model ${transcribeLocal.MODELS[quality].file} not found in ${modelDir}`;
      return null;
    },
    async run(file, lang) {
      return (await transcribeLocal.transcribe(file, { modelDir, language: lang, quality })).words;
    },
  };
}

const elevenlabs = {
  id: 'elevenlabs',
  label: 'ElevenLabs Scribe',
  available: () => (process.env.ELEVENLABS_API_KEY ? null : 'ELEVENLABS_API_KEY is not set'),
  async run(file, lang) {
    return (await transcribeCloud(file, { key: process.env.ELEVENLABS_API_KEY, language: lang })).words;
  },
};

// TASK 2.2: add the Sarvam engine here ({ id, label, available(), run(file, lang) -> words[] }).
// It reads its key from SARVAM_API_KEY, the same way as ElevenLabs above.
const ENGINES = [whisperEngine('fast'), whisperEngine('accurate'), elevenlabs];

// ---- run ----

const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);

async function main() {
  const wanted = args.engines ? String(args.engines).split(',') : null;
  const engines = ENGINES.filter((e) => !wanted || wanted.includes(e.id));
  const skipped = [];
  const active = [];
  for (const e of engines) {
    const why = e.available();
    if (why) skipped.push(`${e.label}: ${why}`); else active.push(e);
  }

  console.log(`Fetching FLEURS clips (CC BY 4.0) into ${cacheDir} …`);
  const corpus = {};
  for (const lang of LANGS) {
    try { corpus[lang] = await loadClips(lang); } catch (err) { skipped.push(`FLEURS ${lang}: ${err.message}`); }
  }

  const rows = [];
  for (const e of active) {
    for (const lang of Object.keys(corpus)) {
      let errors = 0;
      let total = 0;
      let done = 0;
      const failures = [];
      for (const clip of corpus[lang]) {
        try {
          const words = await e.run(clip.file, lang);
          const r = wordErrors(clip.reference, words.map((w) => w.text).join(' '));
          errors += r.errors;
          total += r.total;
          done++;
        } catch (err) {
          failures.push(String(err.message).slice(0, 120));
        }
      }
      rows.push({ engine: e.label, language: lang, clips: done, failedClips: failures.length, wer: total ? errors / total : null, words: total, timingError: null, latinShare: null });
      if (failures.length) skipped.push(`${e.label} ${lang}: ${failures.length} clip(s) failed (${failures[0]})`);
    }
  }

  console.log('\nEngine                       Lang  Clips  Words   WER      Start-time error  English in Latin');
  for (const r of rows) {
    console.log(`${r.engine.padEnd(28)} ${r.language.padEnd(5)} ${String(r.clips).padStart(5)}  ${String(r.words).padStart(5)}  ${pct(r.wer).padStart(7)}  ${'n/a'.padStart(16)}  ${'n/a'.padStart(16)}`);
  }
  if (!rows.length) console.log('(no engine was available, so there are no rows)');
  console.log('\nNotes:');
  console.log('- Start-time error: n/a. FLEURS has sentence transcripts but no word times, so none are invented.');
  console.log('- English in Latin letters: n/a. There is no public code-mixed reference and the repo has no demo clip.');
  console.log('- FLEURS is read speech; real phone recordings will score worse for every engine.');
  if (skipped.length) {
    console.log('\nSkipped:');
    for (const s of skipped) console.log(`- ${s}`);
  }

  const out = path.join(cacheDir, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(out, JSON.stringify({ date: new Date().toISOString(), clipsPerLanguage: CLIPS, rows, skipped }, null, 2));
  console.log(`\nResults written to ${out}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
