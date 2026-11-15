// FFmpeg helpers: probing, decoding audio for transcription, timeline assets, and rendering edits.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

// The installed app ships ffmpeg next to its resources (resources/bin); in development
// ffmpeg-static's binary is used. (Inside app.asar it lives in app.asar.unpacked.)
const fs = require('node:fs');
const WIN = process.platform === 'win32';
const bundledFfmpeg = process.resourcesPath && path.join(process.resourcesPath, 'bin', WIN ? 'ffmpeg.exe' : 'ffmpeg');
const ffmpegPath = bundledFfmpeg && fs.existsSync(bundledFfmpeg)
  ? bundledFfmpeg
  : require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

// The error a cancelled job ends with; the page shows "cancelled" rather than a failure.
function cancelledError() {
  const err = new Error('CANCELLED');
  err.code = 'CANCELLED';
  return err;
}

// What the user can do about the common ffmpeg failures, or null for anything else.
function friendlyFfmpegError(stderr) {
  const text = String(stderr ?? '');
  if (/No space left on device/i.test(text)) return 'The disk is full. Free some space and try again.';
  if (/Permission denied|Operation not permitted/i.test(text)) return 'Talkcut is not allowed to read or write that file. Check the folder’s permissions, or choose another folder.';
  if (/moov atom not found|Invalid data found when processing input/i.test(text)) return 'This file can’t be read. It may be damaged, or still being copied.';
  return null;
}

function runFfmpeg(args, { onStderr, collectStdout = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelledError()); return; }
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', collectStdout ? 'pipe' : 'ignore', 'pipe'] });
    const kill = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', kill, { once: true });
    const chunks = [];
    let stderr = '';
    proc.stdout?.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => {
      const text = c.toString();
      stderr += text;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      onStderr?.(text);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(cancelledError());
      if (code === 0) return resolve({ stderr, stdout: Buffer.concat(chunks) });
      const err = new Error(friendlyFfmpegError(stderr) ?? `ffmpeg exited with code ${code}: ${stderr.slice(-800)}`);
      err.stderr = stderr;
      reject(err);
    });
  });
}

// ffmpeg -i with no output always exits non-zero, so parse its stderr directly.
// Shared with the Android app: square pixels, Studio Sound and the export recipe.
const { SQUARE, STUDIO_SOUND, buildRenderArgs, voiceChain } = require('./renderer/render-plan');

async function probe(filePath) {
  let stderr = '';
  try {
    ({ stderr } = await runFfmpeg(['-hide_banner', '-i', filePath]));
  } catch (err) {
    if (err.stderr == null) throw err;
    stderr = err.stderr;
  }
  const dur = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null;
  // Size as displayed: phones store portrait video as landscape plus a rotation tag, and
  // ffmpeg applies that rotation when decoding.
  const videoLine = stderr.split('\n').findIndex((l) => /Stream #\d+:\d+.*: Video:/.test(l) && !/attached pic/.test(l));
  let width = null;
  let height = null;
  if (videoLine >= 0) {
    const size = stderr.split('\n')[videoLine].match(/, (\d{2,5})x(\d{2,5})/);
    if (size) [width, height] = [Number(size[1]), Number(size[2])];
    const sar = stderr.split('\n')[videoLine].match(/\[SAR (\d+):(\d+)/);
    if (size && sar && Number(sar[1]) > 0 && Number(sar[2]) > 0) width = Math.trunc((width * Number(sar[1])) / Number(sar[2]) / 2) * 2; // same rounding as SQUARE
    const rot = stderr.match(/displaymatrix: rotation of (-?[\d.]+) degrees/);
    if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [width, height] = [height, width];
  }
  // Frames per second of the video ("29.97 fps"; "tbr" when ffmpeg reports no fps).
  let fps = null;
  if (videoLine >= 0) {
    const line = stderr.split('\n')[videoLine];
    const m = line.match(/, ([\d.]+) fps/) ?? line.match(/, ([\d.]+) tbr/);
    if (m && Number(m[1]) > 0) fps = Number(m[1]);
  }
  return {
    duration,
    fps,
    hasVideo: videoLine >= 0,
    hasAudio: /Stream #\d+:\d+.*: Audio:/.test(stderr),
    width,
    height,
  };
}

// whisper.cpp expects 16 kHz mono 16-bit WAV.
async function decodeToWav(filePath, wavPath, { signal } = {}) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath], { signal });
}

// Small mono AAC file for uploading to a cloud speech service.
async function encodeForUpload(filePath, outPath, { signal } = {}) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', outPath], { signal });
}

// Pauses as [start, end] seconds, plus total duration.
async function findSilences(filePath, { noise = '-32dB', minSeconds = 0.35 } = {}) {
  const { stderr } = await runFfmpeg(['-hide_banner', '-nostdin', '-i', filePath, '-af', `silencedetect=noise=${noise}:d=${minSeconds}`, '-f', 'null', '-']);
  const silences = [];
  let start = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end: ([\d.]+)/);
    if (e && start != null) {
      silences.push([start, Number(e[1])]);
      start = null;
    }
  }
  const dur = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  if (start != null) silences.push([start, duration]);
  return { silences, duration };
}

async function extractClip(wavPath, outPath, start, end, { signal } = {}) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', wavPath, '-c', 'copy', outPath], { signal });
}

// Waveform envelope: peak absolute amplitude (0..1) per 1/perSecond seconds.
async function computePeaks(filePath, perSecond = 50) {
  const rate = 8000;
  const { stdout } = await runFfmpeg(
    ['-hide_banner', '-nostdin', '-i', filePath, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'],
    { collectStdout: true },
  );
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
  const bucket = Math.round(rate / perSecond);
  const peaks = new Array(Math.ceil(samples.length / bucket));
  for (let b = 0; b < peaks.length; b++) {
    let max = 0;
    const end = Math.min(samples.length, (b + 1) * bucket);
    for (let i = b * bucket; i < end; i++) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    peaks[b] = Math.round((max / 32768) * 1000) / 1000;
  }
  return { perSecond, peaks };
}

// Small thumbnails spread over the video for the timeline filmstrip, as data URLs.
async function extractFrames(filePath, duration, outDir, { maxFrames = 400, height = 132 } = {}) {
  const interval = Math.max(0.5, duration / maxFrames);
  await runFfmpeg([
    '-hide_banner', '-nostdin', '-y', '-i', filePath, '-an',
    '-vf', `fps=1/${interval.toFixed(3)},${SQUARE},scale=-2:${height}`,
    '-q:v', '5', path.join(outDir, 'f%05d.jpg'),
  ]);
  const files = (await fsp.readdir(outDir)).filter((f) => /^f\d+\.jpg$/.test(f)).sort();
  return Promise.all(files.map(async (f, i) => ({
    // fps filter frames sit at the middle of each interval
    t: (i + 0.5) * interval,
    src: `data:image/jpeg;base64,${(await fsp.readFile(path.join(outDir, f))).toString('base64')}`,
  })));
}

// Faces across the video for auto-framing: `samples` evenly spaced frames go through the
// Vision face finder (vendor/facedetect). Returns [{ t, faces: [{ x, y, w, h }] }] with boxes
// as fractions of the displayed picture.
const FACEDETECT = [
  process.resourcesPath && path.join(process.resourcesPath, 'facedetect'), // installed app
  path.join(__dirname, '..', 'vendor', 'facedetect', 'facedetect'),
].find((p) => p && fs.existsSync(p)) ?? path.join(__dirname, '..', 'vendor', 'facedetect', 'facedetect');

async function findFaces(filePath, duration, workDir, { samples = 16 } = {}) {
  try { await fsp.access(FACEDETECT); } catch {
    throw new Error('Auto-framing is not available in this copy of Talkcut (it needs a Mac).');
  }
  const interval = Math.max(0.2, duration / samples);
  await runFfmpeg([
    '-hide_banner', '-nostdin', '-y', '-i', filePath, '-an',
    '-vf', `fps=1/${interval.toFixed(3)},${SQUARE},scale=480:-2`, '-frames:v', String(samples),
    '-q:v', '4', path.join(workDir, 'face%03d.jpg'),
  ]);
  const files = (await fsp.readdir(workDir)).filter((f) => /^face\d+\.jpg$/.test(f)).sort();
  const out = await new Promise((resolve, reject) => {
    const child = spawn(FACEDETECT, files.map((f) => path.join(workDir, f)));
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`Face finder failed (${code}).`))));
  });
  const byFile = new Map(out.split('\n').filter(Boolean).map((line) => { const j = JSON.parse(line); return [path.basename(j.file), j.faces]; }));
  return files.map((f, i) => ({ t: (i + 0.5) * interval, faces: byFile.get(f) ?? [] }));
}

// The RNNoise model Studio Sound uses (assets/rnnoise/README.md). In the installed app it sits in
// app.asar.unpacked, where ffmpeg can read it.
const RNNOISE_MODEL = path.join(__dirname, '..', 'assets', 'rnnoise', 'sh.rnnn').replace('app.asar', 'app.asar.unpacked');

// The Studio Sound filter chain for an engine ('rnnoise' or 'classic') and strength (0 to 1),
// as the export uses it.
function studioChain(strength = 0.8, engine = 'rnnoise') {
  return voiceChain({ engine: engine === 'classic' ? 'nlm' : 'rnnoise', strength, modelPath: RNNOISE_MODEL, filterPath });
}

// The cleaned voice as its own audio file, for previewing Studio Sound.
async function enhanceAudio(filePath, outPath, { strength = 0.8, engine = 'rnnoise' } = {}) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', filePath, '-vn', '-af', `${studioChain(strength, engine)},aresample=48000`, '-c:a', 'aac', '-b:a', '160k', outPath]);
}

// Integrated loudness (LUFS) and true peak (dBTP) of a file's sound, as EBU R128 measures it.
async function measureLoudness(filePath, { signal } = {}) {
  const { stderr } = await runFfmpeg(['-hide_banner', '-nostdin', '-i', filePath, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { signal });
  const json = JSON.parse(String(stderr).slice(String(stderr).lastIndexOf('{')));
  return { lufs: Number(json.input_i), peak: Number(json.input_tp) };
}

// Bring an exported file to a loudness target (social platforms play at about -14 LUFS, podcasts
// at -16). The sound is measured, turned up or down by the difference, with a limiter keeping
// peaks under -1 dBTP, and measured again; when the limiter has taken some of the gain (loud
// peaks in speech), the gain is raised by what is missing and the pass made again from the
// original, at most four times. The picture is copied untouched. Done after the export so the
// result is exact (a one-pass loudness filter drifts on short clips and lifts the hiss between
// words). Returns the loudness before and after.
async function matchLoudness(filePath, target, { signal, tolerance = 0.3 } = {}) {
  const before = await measureLoudness(filePath, { signal });
  if (!Number.isFinite(before.lufs) || before.lufs < -70) return { before, after: before };
  if (Math.abs(before.lufs - target) <= tolerance && before.peak <= -1) return { before, after: before };
  const ext = path.extname(filePath).toLowerCase();
  const tmp = `${filePath}.loud${ext}`;
  const codec = ext === '.wav' ? ['-c:a', 'pcm_s16le'] : ext === '.mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '192k'];
  let gain = target - before.lufs;
  let after = before;
  try {
    for (let tries = 0; tries < 4; tries++) {
      await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', filePath, '-map', '0', '-c:v', 'copy', '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=${(10 ** (-1.5 / 20)).toFixed(4)}:level=disabled`, ...codec, ...(/\.(mp4|mov|m4a)$/.test(ext) ? ['-movflags', '+faststart'] : []), tmp], { signal });
      after = await measureLoudness(tmp, { signal });
      if (Math.abs(after.lufs - target) <= tolerance) break;
      gain += target - after.lufs;
    }
    await fsp.rename(tmp, filePath);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
  return { before, after };
}

// Quote a path for use as a filter option value.
function filterPath(p) {
  // Windows paths: forward slashes, with the drive colon escaped below.
  if (WIN) p = p.replace(/\\/g, '/');
  return `'${p.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;
}

// Render an edit (see renderer/render-plan.js for what goes into it).
async function renderEdit({ onProgress, signal, ...options }) {
  const { args, total } = buildRenderArgs({ rnnoiseModel: fs.existsSync(RNNOISE_MODEL) ? RNNOISE_MODEL : null, ...options, filterPath });
  await runFfmpeg(args, {
    signal,
    onStderr: (text) => {
      const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) onProgress?.(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / total));
    },
  });
}

// The caption fonts (Noto Sans, SIL Open Font License) ship with the app in assets/fonts: the
// same files in the preview and here, so export never depends on fonts installed on the Mac.
// In the installed app they sit in app.asar.unpacked, where libass can read them.
const BUNDLED_FONTS = path.join(__dirname, '..', 'assets', 'fonts').replace('app.asar', 'app.asar.unpacked');
const FONT_FILES = Object.keys(require('./renderer/captions').FONT_FILES);

// libass only looks in the fonts folder it is given: link the bundled fonts into one. A missing
// font stops the export with a message instead of silently drawing captions in another font.
// `source` is for tests.
async function prepareFontsDir(dir, { source = BUNDLED_FONTS } = {}) {
  for (const f of FONT_FILES) {
    await fsp.access(path.join(source, f)).catch(() => {
      throw new Error(`The caption font ${f} is missing from this copy of Talkcut, so captions and titles cannot be drawn. Reinstall Talkcut.`);
    });
  }
  await fsp.mkdir(dir, { recursive: true });
  for (const f of FONT_FILES) {
    const target = path.join(dir, f);
    // Windows needs admin rights for symlinks, so it copies the font files instead.
    if (WIN) await fsp.copyFile(path.join(source, f), target);
    else await fsp.symlink(path.join(source, f), target).catch(() => fsp.copyFile(path.join(source, f), target));
  }
  return dir;
}

// One frame's RGB at a point, for tests and checks.
async function pixelAt(filePath, t, x, y) {
  const { stdout } = await runFfmpeg(
    // yuv420p needs even crop sizes; read the top-left pixel of a 2x2 block
    ['-hide_banner', '-nostdin', '-ss', String(t), '-i', filePath, '-frames:v', '1', '-vf', `crop=2:2:${x - (x % 2)}:${y - (y % 2)},format=rgb24`, '-f', 'rawvideo', 'pipe:1'],
    { collectStdout: true },
  );
  return [...stdout.subarray(0, 3)];
}

// A single thumbnail for a B-roll clip or image, as a data URL.
async function thumbnail(filePath, at = 0.5, height = 120) {
  const { stdout } = await runFfmpeg(
    ['-hide_banner', '-nostdin', '-ss', String(at), '-i', filePath, '-frames:v', '1', '-vf', `${SQUARE},scale=-2:${height}`, '-f', 'mjpeg', '-q:v', '6', 'pipe:1'],
    { collectStdout: true },
  ).catch(() => runFfmpeg(
    ['-hide_banner', '-nostdin', '-i', filePath, '-frames:v', '1', '-vf', `${SQUARE},scale=-2:${height}`, '-f', 'mjpeg', '-q:v', '6', 'pipe:1'],
    { collectStdout: true },
  ));
  return `data:image/jpeg;base64,${stdout.toString('base64')}`;
}

module.exports = {
  probe, decodeToWav, encodeForUpload, enhanceAudio, studioChain, measureLoudness, matchLoudness, RNNOISE_MODEL, STUDIO_SOUND, findSilences, extractClip, computePeaks, extractFrames, findFaces, thumbnail,
  prepareFontsDir, pixelAt, renderEdit, runFfmpeg, cancelledError, friendlyFfmpegError,
};
