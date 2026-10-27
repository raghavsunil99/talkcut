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

function runFfmpeg(args, { onStderr, collectStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', collectStdout ? 'pipe' : 'ignore', 'pipe'] });
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
      if (code === 0) return resolve({ stderr, stdout: Buffer.concat(chunks) });
      const err = new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-800)}`);
      err.stderr = stderr;
      reject(err);
    });
  });
}

// ffmpeg -i with no output always exits non-zero, so parse its stderr directly.
// Shared with the Android app: square pixels, Studio Sound and the export recipe.
const { SQUARE, STUDIO_SOUND, buildRenderArgs } = require('./renderer/render-plan');

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
  return {
    duration,
    hasVideo: videoLine >= 0,
    hasAudio: /Stream #\d+:\d+.*: Audio:/.test(stderr),
    width,
    height,
  };
}

// whisper.cpp expects 16 kHz mono 16-bit WAV.
async function decodeToWav(filePath, wavPath) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath]);
}

// Small mono AAC file for uploading to a cloud speech service.
async function encodeForUpload(filePath, outPath) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', outPath]);
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

async function extractClip(wavPath, outPath, start, end) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', wavPath, '-c', 'copy', outPath]);
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

// The cleaned voice as its own audio file, for previewing Studio Sound.
async function enhanceAudio(filePath, outPath) {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', filePath, '-vn', '-af', `${STUDIO_SOUND},aresample=48000`, '-c:a', 'aac', '-b:a', '160k', outPath]);
}

// Quote a path for use as a filter option value.
function filterPath(p) {
  // Windows paths: forward slashes, with the drive colon escaped below.
  if (WIN) p = p.replace(/\\/g, '/');
  return `'${p.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;
}

// Render an edit (see renderer/render-plan.js for what goes into it).
async function renderEdit({ onProgress, ...options }) {
  const { args, total } = buildRenderArgs({ ...options, filterPath });
  await runFfmpeg(args, {
    onStderr: (text) => {
      const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) onProgress?.(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / total));
    },
  });
}

// libass only looks in the fonts folder it is given; link the macOS fonts that cover the
// caption scripts (Telugu, Devanagari, Bangla, Kannada, Tamil, Malayalam, Latin) into one.
const CAPTION_FONT_FILES = [
  '/System/Library/Fonts/KohinoorTelugu.ttc',
  '/System/Library/Fonts/Kohinoor.ttc',
  '/System/Library/Fonts/KohinoorBangla.ttc',
  '/System/Library/Fonts/NotoSansKannada.ttc',
  '/System/Library/Fonts/Supplemental/Tamil Sangam MN.ttc',
  '/System/Library/Fonts/Supplemental/Malayalam Sangam MN.ttc',
  '/System/Library/Fonts/Avenir Next.ttc',
];

// Windows: Nirmala UI covers Telugu and the other Indian scripts; Segoe UI the Latin text.
const WINDOWS_FONT_FILES = ['Nirmala.ttc', 'Nirmala.ttf', 'NirmalaB.ttf', 'NirmalaS.ttf', 'segoeui.ttf', 'segoeuib.ttf', 'seguisb.ttf']
  .map((f) => path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', f));

async function prepareFontsDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  for (const f of WIN ? WINDOWS_FONT_FILES : CAPTION_FONT_FILES) {
    const target = path.join(dir, path.basename(f).replace(/\s+/g, '-'));
    // Windows needs admin rights for symlinks, so it copies the font files instead.
    await (WIN ? fsp.copyFile(f, target) : fsp.symlink(f, target)).catch(() => {});
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
  probe, decodeToWav, encodeForUpload, enhanceAudio, STUDIO_SOUND, findSilences, extractClip, computePeaks, extractFrames, findFaces, thumbnail,
  prepareFontsDir, pixelAt, renderEdit,
};
