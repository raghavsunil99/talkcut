// Studio Sound benchmark: how close each voice-cleanup chain gets noisy speech back to clean.
//   node scripts/bench-sound.js [--models=<dir with sh.rnnn, and optionally cb.rnnn>]
// (cb.rnnn, the "conjoined-burgers" model from the same repository as sh.rnnn, is not shipped;
// put it in a folder with sh.rnnn and pass that folder to compare it too.)
//
// Clean speech is a few FLEURS clips (Google, CC BY 4.0: te, hi, en), fetched once into
// <tmp>/talkcut-bench-sound/ (the first ~4 MB of each test archive). Noise is made with ffmpeg:
// low rumble (a fan or traffic), hiss (a cheap phone mic), mains hum, and a babble of other
// voices (a room with people). Each clip is mixed with each noise at 5 and 10 dB signal to noise.
// Score: SI-SDR of the cleaned audio against the clean speech, in dB (higher is better; it
// punishes noise left in and speech damaged alike), and the noise left in the pauses.
// These are numbers on synthetic noise; they do not replace listening to real recordings.
// For that, one clip per noise is saved through each full chain in <tmp>/talkcut-bench-sound/listen.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const ffmpeg = require('ffmpeg-static');
const { voiceChain } = require('../src/renderer/render-plan.js');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const cache = path.join(os.tmpdir(), 'talkcut-bench-sound');
const modelDir = args.models ?? path.join(__dirname, '..', 'assets', 'rnnoise');
const RATE = 16000;
fs.mkdirSync(cache, { recursive: true });

// ---- clean speech ----
function untarPartial(gz) {
  const tar = zlib.gunzipSync(gz, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const files = new Map();
  for (let pos = 0; pos + 512 <= tar.length;) {
    const name = tar.toString('utf8', pos, pos + 100).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.toString('ascii', pos + 124, pos + 136).replace(/\0.*$/, '').trim(), 8) || 0;
    if (pos + 512 + size > tar.length) break;
    if (size > 0) files.set(path.basename(name), tar.subarray(pos + 512, pos + 512 + size));
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
async function cleanClips() {
  const out = [];
  for (const [lang, cfg] of [['te', 'te_in'], ['hi', 'hi_in'], ['en', 'en_us']]) {
    const dir = path.join(cache, 'clean', lang);
    if (!fs.existsSync(dir)) {
      const res = await fetch(`https://huggingface.co/datasets/google/fleurs/resolve/main/data/${cfg}/audio/test.tar.gz`, { headers: { Range: 'bytes=0-3999999' } });
      const files = untarPartial(Buffer.from(await res.arrayBuffer()));
      fs.mkdirSync(dir, { recursive: true });
      let n = 0;
      for (const [name, data] of files) {
        if (n++ >= 2) break;
        const raw = path.join(dir, `raw-${name}`);
        fs.writeFileSync(raw, data);
        execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-af', 'loudnorm=I=-23:TP=-2', '-ar', String(RATE), '-ac', '1', path.join(dir, name)]);
        fs.rmSync(raw);
      }
    }
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.wav'))) out.push({ lang, file: path.join(dir, f) });
  }
  return out;
}

// ---- audio helpers ----
const readPcm = (file, filter = null) => {
  const buf = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, ...(filter ? ['-af', filter] : []), '-ar', String(RATE), '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const writeWav = (file, pcm) => {
  const raw = `${file}.f32`;
  fs.writeFileSync(raw, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', raw, file]);
  fs.rmSync(raw);
};
const power = (x) => { let s = 0; for (const v of x) s += v * v; return s / Math.max(1, x.length); };

function makeNoise(kind, seconds, others) {
  const file = path.join(cache, `noise-${kind}-${seconds.toFixed(2)}.wav`);
  if (kind === 'babble') {
    // Four other voices at once, from the other clean clips.
    const n = Math.round(seconds * RATE);
    const mix = new Float32Array(n);
    others.slice(0, 4).forEach((o, k) => { const x = readPcm(o.file); for (let i = 0; i < n; i++) mix[i] += x[(i + k * 7919) % x.length] * 0.5; });
    return mix;
  }
  const src = {
    rumble: `anoisesrc=color=brown:sample_rate=${RATE}:amplitude=0.5,lowpass=f=300`,
    hiss: `anoisesrc=color=white:sample_rate=${RATE}:amplitude=0.3,highpass=f=2000`,
    hum: `sine=frequency=50:sample_rate=${RATE},volume=0.6[a];sine=frequency=150:sample_rate=${RATE},volume=0.3[b];sine=frequency=250:sample_rate=${RATE},volume=0.15[c];[a][b][c]amix=inputs=3:normalize=0`,
  }[kind];
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-t', seconds.toFixed(3), '-ac', '1', file]);
  return readPcm(file);
}

// SI-SDR after finding the best delay (filters can shift the signal a few ms).
function siSdr(clean, test) {
  let best = -Infinity;
  for (let d = -480; d <= 480; d += 16) {
    let dot = 0;
    let cc = 0;
    for (let i = Math.max(0, -d); i < clean.length && i + d < test.length; i++) { dot += clean[i] * test[i + d]; cc += clean[i] * clean[i]; }
    const a = dot / (cc || 1);
    let num = 0;
    let den = 0;
    for (let i = Math.max(0, -d); i < clean.length && i + d < test.length; i++) { const s = a * clean[i]; const e = test[i + d] - s; num += s * s; den += e * e; }
    best = Math.max(best, 10 * Math.log10(num / (den || 1e-12)));
  }
  return best;
}

// Level of what is left where the clean speech is quiet, in dB relative to the speech.
function residual(clean, test) {
  const frame = RATE / 50;
  const levels = [];
  for (let i = 0; i + frame <= clean.length; i += frame) levels.push(power(clean.subarray(i, i + frame)));
  const sorted = levels.slice().sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.15)];
  let q = 0;
  let n = 0;
  levels.forEach((l, k) => { if (l <= quiet) { q += power(test.subarray(k * frame, (k + 1) * frame)); n++; } });
  return 10 * Math.log10((q / Math.max(1, n)) / power(clean));
}

async function main() {
  const clips = await cleanClips();
  // The chains are scored on their noise-removal stage: the equaliser, compressor and limiter
  // after it change the speech's shape on purpose, which SI-SDR would count as damage.
  const denoise = (chain) => chain.split(',').filter((f) => !/^(equalizer|acompressor|alimiter)=/.test(f)).join(',');
  const sh = path.join(modelDir, 'sh.rnnn');
  const cb = path.join(modelDir, 'cb.rnnn');
  const chains = {
    noisy: null,
    'highpass only (baseline)': 'highpass=f=75',
    'current (anlmdn + gate)': denoise(voiceChain({ engine: 'nlm', strength: 1 })),
    ...(fs.existsSync(cb) ? { 'RNNoise recording model': denoise(voiceChain({ engine: 'rnnoise', strength: 1, modelPath: cb })) } : {}),
    'new: RNNoise 100% + gate': denoise(voiceChain({ engine: 'rnnoise', strength: 1, modelPath: sh })),
    'new: RNNoise 80% + gate': denoise(voiceChain({ engine: 'rnnoise', strength: 0.8, modelPath: sh })),
    'new: RNNoise 50% + gate': denoise(voiceChain({ engine: 'rnnoise', strength: 0.5, modelPath: sh })),
  };
  const listenDir = path.join(cache, 'listen');
  const rows = {};
  for (const kind of ['rumble', 'hiss', 'hum', 'babble']) {
    for (const snr of [5, 10]) {
      for (const c of clips) {
        const clean = readPcm(c.file);
        const cleanHp = readPcm(c.file, 'highpass=f=75');
        const noise = makeNoise(kind, clean.length / RATE, clips.filter((o) => o !== c));
        const g = Math.sqrt(power(clean) / (power(noise) * 10 ** (snr / 10)));
        const noisy = clean.map((v, i) => v + g * noise[i]);
        const noisyFile = path.join(cache, `mix-${kind}-${snr}-${path.basename(c.file)}`);
        writeWav(noisyFile, noisy);
        for (const [name, chain] of Object.entries(chains)) {
          const out = chain ? readPcm(noisyFile, `${chain},aresample=${RATE}`) : noisy;
          // Every chain starts with the same 75 Hz high-pass, whose phase shift SI-SDR would
          // count as damage: the reference goes through it too.
          const ref = chain ? cleanHp : clean;
          // One clip per noise is saved to listen to: the same 5 dB mix through each full chain.
          if (snr === 5 && c === clips[0]) {
            fs.mkdirSync(listenDir, { recursive: true });
            const full = { noisy: null, 'current (anlmdn + gate)': voiceChain({ engine: 'nlm', strength: 1 }), 'new: RNNoise 80% + gate': voiceChain({ engine: 'rnnoise', strength: 0.8, modelPath: sh }) }[name];
            if (full !== undefined) execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', noisyFile, ...(full ? ['-af', full] : []), path.join(listenDir, `${kind} - ${name.replace(/[:()%+]/g, '').replace(/\s+/g, ' ').trim()}.wav`)]);
          }
          const key = `${name}|${kind}`;
          rows[key] ??= { name, kind, sdr: [], res: [] };
          rows[key].sdr.push(siSdr(ref, out));
          rows[key].res.push(residual(ref, out));
        }
      }
    }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  console.log(`\n${clips.length} clips (te, hi, en) x 2 noise levels per noise\n`);
  console.log('Chain                        Noise    SI-SDR dB   noise left in pauses dB');
  for (const r of Object.values(rows)) console.log(`${r.name.padEnd(28)} ${r.kind.padEnd(8)} ${mean(r.sdr).toFixed(1).padStart(8)}   ${mean(r.res).toFixed(1).padStart(10)}`);
  const overall = {};
  for (const r of Object.values(rows)) (overall[r.name] ??= []).push(...r.sdr);
  console.log('\nAll noises:');
  for (const [name, v] of Object.entries(overall)) console.log(`  ${name.padEnd(28)} ${mean(v).toFixed(1)} dB`);
  const out = path.join(cache, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify(Object.values(rows), null, 2));
  console.log(`\nResults written to ${out}`);
  console.log(`To listen: the same noisy clip through each chain is in ${listenDir}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
