const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage } = require('electron');
const os = require('node:os');
const { probe, renderEdit, computePeaks, extractFrames, thumbnail, prepareFontsDir, enhanceAudio, STUDIO_SOUND, findFaces } = require('./media');
const crypto = require('node:crypto');
const { transcribe, LANGUAGES, MODELS, CLOUD_QUALITY } = require('./transcribe');
const { transcribeCloud, usage: elevenLabsUsage } = require('./cloud');
const stock = require('./stock');
const { createKeystore } = require('./keystore');
const { createProjects } = require('./projects');
const Captions = require('./renderer/captions');
const Edits = require('./renderer/edits');
const Frame = require('./renderer/frame');
const Text = require('./renderer/text');

const MEDIA_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aiff'];
const BROLL_VIDEO = ['mp4', 'mov', 'm4v', 'webm', 'mkv'];
const BROLL_IMAGE = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const AUDIO_FILES = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aiff'];
const PROJECT_EXTENSION = 'cutline';
const RENDERER_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).toString();

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1180,
    minHeight: 680,
    title: 'Cutline — built by Raghav',
    backgroundColor: '#16171a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Windows: keep the menu out of the way (Alt shows it).
    autoHideMenuBar: process.platform !== 'darwin',
    // Automated checks run the real UI in a window that never appears on screen.
    show: !process.env.CUTLINE_TEST,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !process.env.CUTLINE_TEST,
    },
  });
  mainWindow.loadURL(RENDERER_URL);

  // The editor is a single local page: never navigate away or open new windows inside the app.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', (event) => {
    if (!projectDirty) return;
    // Saved projects finish their last autosave, then the window closes.
    if (projectHasFile && !closingAfterSave) {
      event.preventDefault();
      closingAfterSave = true;
      mainWindow.webContents.send('app:before-close');
      setTimeout(() => { if (mainWindow) { projectDirty = false; mainWindow.close(); } }, 5000);
      return;
    }
    if (closingAfterSave) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Discard Changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Close the window and discard them?',
    });
    if (choice === 1) event.preventDefault();
    else projectDirty = false;
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

let projectDirty = false;
let projectHasFile = false;
let closingAfterSave = false;

// Only our own renderer page may call privileged handlers.
// Windows file URLs can differ in letter case and escaping (file:///C:/... vs file:///c:/...).
function sameUrl(a, b) {
  if (!a) return false;
  if (process.platform !== 'win32') return a === b;
  const norm = (u) => decodeURIComponent(u).replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!sameUrl(event.senderFrame?.url, RENDERER_URL)) throw new Error(`Rejected ${channel} from untrusted sender`);
    return fn(event, ...args);
  });
}

function send(channel, payload) {
  mainWindow?.webContents.send(channel, payload);
}

async function describeMedia(filePath) {
  const info = await probe(filePath);
  if (!info.hasAudio) throw new Error('This file has no audio track to transcribe.');
  return { path: filePath, url: pathToFileURL(filePath).toString(), name: path.basename(filePath), ...info };
}

handle('media:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open audio or video',
    properties: ['openFile'],
    filters: [{ name: 'Audio and video', extensions: MEDIA_EXTENSIONS }],
  });
  if (canceled || !filePaths[0]) return null;
  return describeMedia(filePaths[0]);
});

handle('project:set-dirty', (_event, dirty, hasFile) => {
  projectDirty = dirty === true;
  projectHasFile = hasFile === true;
});
handle('app:close-now', () => {
  projectDirty = false;
  mainWindow?.close();
});

handle('media:open-path', async (_event, filePath) => {
  const ext = path.extname(filePath ?? '').slice(1).toLowerCase();
  if (!MEDIA_EXTENSIONS.includes(ext)) throw new Error('Drop an audio or video file (for example .mp4, .mov, .mp3 or .wav).');
  return describeMedia(filePath);
});

handle('media:options', () => ({
  languages: Object.entries(LANGUAGES).map(([code, label]) => ({ code, label })),
  qualities: Object.entries({ ...MODELS, ...CLOUD_QUALITY }).map(([code, { label }]) => ({ code, label })),
}));

handle('media:timeline', async (_event, { filePath, duration, hasVideo }) => {
  const [waveform, frames] = await Promise.all([
    computePeaks(filePath),
    (async () => {
      if (!hasVideo || !duration) return [];
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cutline-frames-'));
      try {
        return await extractFrames(filePath, duration, dir);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    })(),
  ]);
  return { ...waveform, frames };
});

handle('media:transcribe', async (_event, { filePath, language, quality }) => {
  if (quality === 'cloud') {
    const key = await elevenLabsKey();
    if (!key) throw new Error('No enabled ElevenLabs key. Add or enable one in API keys (⇧⌘K).');
    if (!Object.hasOwn(LANGUAGES, language)) throw new Error(`Unsupported language: ${language}`);
    try {
      return await transcribeCloud(filePath, { key, language, onProgress: (p) => send('transcribe:progress', p) });
    } catch (err) {
      if (err.code !== 'QUOTA') throw err;
      // Tell the page which key ran out and which enabled key could take over; the page asks
      // the user before switching.
      const [current, next] = [await keys.activeInfo('elevenlabs'), (await keys.fallbacks('elevenlabs'))[0] ?? null];
      throw new Error(`QUOTA:${JSON.stringify({ current, next })}`);
    }
  }
  return transcribe(filePath, {
    language,
    quality,
    modelDir: path.join(app.getPath('userData'), 'models'),
    onProgress: (p) => send('transcribe:progress', p),
  });
});

// ---------- settings (Pexels key, encrypted with the macOS keychain) ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

async function readSettings() {
  try {
    return JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeSettings(settings) {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

// API keys are encrypted with the macOS keychain (safeStorage) and never sent to the page;
// the page only sees labels and the last four characters.
const keys = createKeystore({
  read: readSettings,
  write: writeSettings,
  encrypt: (value) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available, so the key cannot be saved.');
    return safeStorage.encryptString(value).toString('base64');
  },
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
});
const VERIFY = { pexels: stock.verifyKey };

const pexelsKey = () => keys.get('pexels');
const elevenLabsKey = () => keys.get('elevenlabs');

handle('settings:get', async () => ({
  hasPexelsKey: Boolean(await pexelsKey()),
  hasElevenLabsKey: Boolean(await elevenLabsKey()),
}));

handle('keys:list', () => keys.list());
handle('keys:usage', async (_event, { service, id }) => {
  if (service !== 'elevenlabs') throw new Error('Usage is only available for ElevenLabs keys.');
  return elevenLabsUsage(await keys.getById(service, id));
});
handle('keys:add', async (_event, { service, label, key, note }) => {
  await keys.add(service, label, key, VERIFY[service], note);
  return keys.list();
});
handle('keys:select', async (_event, { service, id }) => {
  await keys.select(service, id);
  return keys.list();
});
handle('keys:rename', async (_event, { service, id, label }) => {
  await keys.rename(service, id, label);
  return keys.list();
});
handle('keys:note', async (_event, { service, id, note }) => {
  await keys.setNote(service, id, note);
  return keys.list();
});
handle('keys:enable', async (_event, { service, id, enabled }) => {
  await keys.setEnabled(service, id, enabled);
  return keys.list();
});
handle('keys:remove', async (_event, { service, id }) => {
  await keys.remove(service, id);
  return keys.list();
});
handle('settings:set-pexels-key', async (_event, key) => {
  await keys.add('pexels', '', key, VERIFY.pexels);
  return { hasPexelsKey: true };
});

// ---------- B-roll ----------

const mediaCache = () => path.join(app.getPath('userData'), 'media');

async function describeBroll(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const kind = BROLL_IMAGE.includes(ext) ? 'image' : BROLL_VIDEO.includes(ext) ? 'video' : null;
  if (!kind) throw new Error('B-roll must be a video (mp4, mov, webm) or an image (jpg, png, webp).');
  const info = await probe(filePath);
  if (!info.hasVideo) throw new Error('This file has no picture to use as B-roll.');
  return {
    path: filePath,
    url: pathToFileURL(filePath).toString(),
    name: path.basename(filePath),
    kind,
    duration: kind === 'video' ? info.duration : null,
    width: info.width,
    height: info.height,
    thumb: await thumbnail(filePath, kind === 'video' ? Math.min(1, (info.duration || 2) / 2) : 0).catch(() => null),
  };
}

handle('broll:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Add B-roll',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Videos and images', extensions: [...BROLL_VIDEO, ...BROLL_IMAGE] }],
  });
  if (canceled) return [];
  return Promise.all(filePaths.map(describeBroll));
});

handle('broll:describe', async (_event, filePath) => describeBroll(filePath));

// Music and sound effects for audio tracks.
async function describeAudio(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (![...AUDIO_FILES, ...BROLL_VIDEO].includes(ext)) throw new Error('Choose an audio file (mp3, wav, m4a, aac, flac, ogg).');
  const info = await probe(filePath);
  if (!info.hasAudio) throw new Error('This file has no sound.');
  return { path: filePath, url: pathToFileURL(filePath).toString(), name: path.basename(filePath), kind: 'audio', duration: info.duration };
}

handle('audio:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Add music or sound',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: AUDIO_FILES }],
  });
  if (canceled) return [];
  return Promise.all(filePaths.map(describeAudio));
});
handle('audio:describe', async (_event, filePath) => describeAudio(filePath));

// Studio Sound preview: the cleaned voice, made once per file (and per filter chain) and cached.
const enhancing = new Map();
handle('audio:enhanced', async (_event, filePath) => {
  const stat = await fs.stat(filePath);
  const key = crypto.createHash('sha1').update(`${filePath}|${stat.size}|${stat.mtimeMs}|${STUDIO_SOUND}`).digest('hex').slice(0, 16);
  const dir = path.join(app.getPath('userData'), 'cache');
  const out = path.join(dir, `studio-sound-${key}.m4a`);
  if (!(await fs.access(out).then(() => true, () => false))) {
    if (!enhancing.has(out)) {
      enhancing.set(out, (async () => {
        await fs.mkdir(dir, { recursive: true });
        const tmp = `${out}.part.m4a`;
        await enhanceAudio(filePath, tmp);
        await fs.rename(tmp, out);
      })().finally(() => enhancing.delete(out)));
    }
    await enhancing.get(out);
  }
  return pathToFileURL(out).toString();
});

// Where the face usually is, for auto-framing (cached per file).
const faceCache = new Map();
handle('media:faces', async (_event, { filePath, duration }) => {
  const stat = await fs.stat(filePath);
  const key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
  if (!faceCache.has(key)) {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cutline-faces-'));
    try {
      faceCache.set(key, Frame.faceCentre(await findFaces(filePath, duration, work)));
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }
  return faceCache.get(key);
});

handle('stock:search', async (_event, { query, kind, orientation }) => {
  const key = await pexelsKey();
  if (!key) throw new Error('Add a Pexels API key to search stock media.');
  if (!String(query ?? '').trim()) return [];
  return stock.search(key, { query: String(query).slice(0, 100), kind: kind === 'image' ? 'image' : 'video', orientation });
});

handle('stock:download', async (_event, item) => {
  const file = await stock.download(item, mediaCache(), (progress) => send('stock:progress', { id: item.id, progress }));
  return describeBroll(file);
});

handle('app:open-external', async (_event, url) => {
  if (/^https:\/\/(www\.)?(pexels\.com|elevenlabs\.io)\//.test(url)) await shell.openExternal(url);
});

// Export presets: frame shape and quality. 'edited' keeps the frame chosen in Properties.
const EXPORT_PRESETS = {
  edited: { canvas: null, crf: 18, suffix: 'edited' },
  reels: { canvas: '9:16', crf: 19, suffix: 'reels' },
  youtube: { canvas: '16:9', crf: 18, suffix: 'youtube' },
  square: { canvas: '1:1', crf: 19, suffix: 'square' },
  audio: { audioOnly: true, suffix: 'audio' },
};
const QUALITY_CRF = { high: 17, standard: 21, small: 26 };

handle('media:export', async (_event, { media, ranges, overlays = [], audio = [], captions = null, clip: editedClip = null, preset: presetId = 'edited', quality = null, subtitles = null }) => {
  const preset = EXPORT_PRESETS[presetId] ?? EXPORT_PRESETS.edited;
  const clip = preset.canvas ? { ...(editedClip || {}), canvas: preset.canvas } : editedClip;
  const crf = QUALITY_CRF[quality] ?? preset.crf ?? 18;
  const ext = media.hasVideo && !preset.audioOnly ? 'mp4' : 'm4a';
  const base = path.basename(media.path, path.extname(media.path));
  // Automated checks export without a dialog, and never write next to the user's media.
  if (process.env.CUTLINE_TEST && !process.env.CUTLINE_TEST_EXPORT) throw new Error('Test mode: set CUTLINE_TEST_EXPORT to export.');
  const { canceled, filePath } = process.env.CUTLINE_TEST && process.env.CUTLINE_TEST_EXPORT
    ? { canceled: false, filePath: process.env.CUTLINE_TEST_EXPORT }
    : await dialog.showSaveDialog(mainWindow, {
    title: 'Export edited media',
    defaultPath: path.join(path.dirname(media.path), `${base}-${preset.suffix}.${ext}`),
    filters: media.hasVideo && !preset.audioOnly
      ? [{ name: 'MP4 video', extensions: ['mp4'] }, { name: 'QuickTime movie', extensions: ['mov'] }]
      : [{ name: 'AAC audio', extensions: ['m4a'] }, { name: 'WAV audio', extensions: ['wav'] }, { name: 'MP3 audio', extensions: ['mp3'] }],
  });
  if (canceled || !filePath) return null;
  if (path.resolve(filePath) === path.resolve(media.path)) throw new Error('Choose a different file name; exporting over the original is not allowed.');

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cutline-export-'));
  try {
    const info = await probe(media.path);
    const withPicture = media.hasVideo && !preset.audioOnly && !/\.(m4a|wav|mp3)$/i.test(filePath);
    const { frame } = Frame.layout(info.width || 1280, info.height || 720, clip);
    let assPath = null;
    let fontsDir = null;
    if (withPicture && captions?.settings?.enabled && captions.words?.length) {
      assPath = path.join(work, 'captions.ass');
      await fs.writeFile(assPath, Captions.buildAss({
        words: captions.words,
        deleted: new Set(captions.deleted ?? []),
        settings: captions.settings,
        language: captions.language,
        width: frame.w,
        height: frame.h,
        toEdited: (t) => Edits.toEdited(ranges, t),
      }));
      fontsDir = await prepareFontsDir(path.join(work, 'fonts'));
    }
    let textAssPath = null;
    const texts = withPicture ? overlays.filter((o) => o.kind === 'text' && String(o.text ?? '').trim()) : [];
    if (texts.length) {
      textAssPath = path.join(work, 'text.ass');
      await fs.writeFile(textAssPath, Text.buildAss(texts, { width: frame.w, height: frame.h, language: captions?.language }));
      fontsDir = fontsDir ?? await prepareFontsDir(path.join(work, 'fonts'));
    }
    const checked = [];
    if (withPicture) {
      for (const o of overlays) {
        const ext = path.extname(o.path ?? '').slice(1).toLowerCase();
        if (![...BROLL_VIDEO, ...BROLL_IMAGE].includes(ext)) continue;
        await fs.access(o.path);
        const kind = BROLL_IMAGE.includes(ext) ? 'image' : 'video';
        const hasAudio = kind === 'video' && (o.volume ?? 0) > 0 ? (await probe(o.path)).hasAudio : false;
        checked.push({ path: o.path, kind, start: o.start, end: o.end, offset: o.offset ?? 0, box: o.box, opacity: o.opacity, volume: o.volume, hasAudio, fit: o.fit, fadeIn: o.fadeIn ?? 0, fadeOut: o.fadeOut ?? 0 });
      }
    }
    const sounds = [];
    for (const a of audio) {
      const ext = path.extname(a.path ?? '').slice(1).toLowerCase();
      if (![...AUDIO_FILES, ...BROLL_VIDEO].includes(ext)) continue;
      await fs.access(a.path);
      sounds.push({ path: a.path, start: a.start, end: a.end, offset: a.offset ?? 0, volume: a.volume ?? 1, duck: a.duck !== false });
    }
    await renderEdit({
      input: media.path,
      output: filePath,
      ranges,
      hasVideo: withPicture,
      hasAudio: media.hasAudio,
      duration: media.duration,
      width: info.width,
      height: info.height,
      overlays: checked,
      audio: media.hasAudio ? sounds : [],
      assPath,
      textAssPath,
      fontsDir,
      clip,
      crf,
      onProgress: (progress) => send('export:progress', { progress }),
    });
    // Captions as a separate file next to the video, for YouTube and other uploads.
    if (subtitles?.content && /^(srt|vtt)$/.test(subtitles.format)) {
      await fs.writeFile(filePath.replace(/\.[^./]+$/, `.${subtitles.format}`), subtitles.content);
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
  return filePath;
});

// Captions only, as an .srt or .vtt file.
handle('captions:save', async (_event, { media, content, format }) => {
  if (!/^(srt|vtt)$/.test(format) || typeof content !== 'string') throw new Error('Unknown captions format.');
  const base = path.basename(media.path, path.extname(media.path));
  if (process.env.CUTLINE_TEST && !process.env.CUTLINE_TEST_EXPORT) throw new Error('Test mode: set CUTLINE_TEST_EXPORT to export.');
  const { canceled, filePath } = process.env.CUTLINE_TEST
    ? { canceled: false, filePath: process.env.CUTLINE_TEST_EXPORT.replace(/\.[^./]+$/, `.${format}`) }
    : await dialog.showSaveDialog(mainWindow, {
      title: 'Save captions',
      defaultPath: path.join(path.dirname(media.path), `${base}.${format}`),
      filters: [format === 'srt' ? { name: 'SubRip captions', extensions: ['srt'] } : { name: 'WebVTT captions', extensions: ['vtt'] }],
    });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, content);
  return filePath;
});

// ---------- projects ----------

const projects = createProjects({
  // Automated checks keep their projects out of the user's folder.
  dir: (process.env.CUTLINE_TEST && process.env.CUTLINE_PROJECTS_DIR) || path.join(app.getPath('documents'), 'Cutline Projects'),
  readSettings,
  writeSettings,
});

// What the home screen shows for a project; the thumbnail is made once per project.
// Thumbnails made before version 2 ignored non-square pixels and look stretched.
const THUMB_VERSION = 2;
async function projectMeta(filePath, project) {
  const known = (await projects.recent()).find((r) => r.path === filePath);
  let thumb = known?.thumbVersion === THUMB_VERSION ? known.thumb : null;
  if (!thumb && project.media?.hasVideo) {
    thumb = await thumbnail(project.media.path, Math.min(1, (project.media.duration || 2) / 2), 180).catch(() => null);
  }
  return { mediaName: project.media?.name, duration: project.media?.duration, thumb, thumbVersion: thumb ? THUMB_VERSION : null };
}

async function remember(filePath, project) {
  await projects.touch(filePath, await projectMeta(filePath, project));
  buildMenu();
}

handle('projects:recent', async () => {
  const list = await projects.recent();
  // Remake old thumbnails once.
  for (const r of list) {
    if (!r.thumb || r.thumbVersion === THUMB_VERSION) continue;
    try {
      const project = await projects.load(r.path);
      if (!project.media?.hasVideo) continue;
      const thumb = await thumbnail(project.media.path, Math.min(1, (project.media.duration || 2) / 2), 180);
      await projects.patch(r.path, { thumb, thumbVersion: THUMB_VERSION });
      Object.assign(r, { thumb, thumbVersion: THUMB_VERSION });
    } catch { /* media moved: keep the old picture */ }
  }
  return list;
});
handle('projects:dir', () => projects.dir);

// A new project gets a file in the projects folder right away, so autosave can keep it.
handle('project:create', async (_event, { project, name }) => {
  await projects.ensureDir();
  const filePath = await projects.uniquePath(name);
  await projects.save(filePath, project);
  await remember(filePath, project);
  return filePath;
});

handle('project:save', async (_event, { project, filePath, saveAs, quiet }) => {
  let target = saveAs ? null : filePath;
  if (!target) {
    await projects.ensureDir();
    const base = path.basename(project.media.path, path.extname(project.media.path));
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save project',
      defaultPath: await projects.uniquePath(base),
      filters: [{ name: 'Cutline project', extensions: [projects.EXTENSION] }],
    });
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
  }
  await projects.save(target, project);
  if (!quiet) await remember(target, project);
  else await projects.touch(target, {});
  return target;
});

async function openPayload(filePath, project) {
  const media = await describeMedia(project.media.path);
  return {
    filePath,
    media,
    words: project.words,
    deleted: project.deleted ?? [],
    cutGaps: project.cutGaps ?? [],
    language: project.language ?? null,
    captions: project.captions ?? null,
    clip: project.clip ?? null,
    splits: project.splits ?? [],
    rangeCuts: project.rangeCuts ?? [],
    tracks: project.tracks ?? null,
    extras: project.extras ?? null,
    // B-roll whose file has gone missing is dropped rather than failing the whole project.
    broll: (await Promise.all((project.broll ?? []).map(async (b) => {
      try {
        return { ...b, media: await describeBroll(b.path) };
      } catch {
        return null;
      }
    }))).filter(Boolean),
  };
}

// Open a project; if its video was moved or renamed, ask the user to find it.
handle('project:open', async (_event, { filePath } = {}) => {
  let target = filePath;
  if (!target) {
    await projects.ensureDir();
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Open project',
      defaultPath: projects.dir,
      properties: ['openFile'],
      filters: [{ name: 'Cutline project', extensions: [projects.EXTENSION] }],
    });
    if (canceled || !filePaths[0]) return null;
    target = filePaths[0];
  }
  const project = await projects.load(target);
  const present = await fs.access(project.media.path).then(() => true, () => false);
  if (!present) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Locate…', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Can’t find the video “${path.basename(project.media.path)}”.`,
      detail: `It may have been moved or renamed. It was at:\n${project.media.path}`,
    });
    if (response !== 0) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: `Locate ${path.basename(project.media.path)}`,
      defaultPath: path.dirname(project.media.path),
      properties: ['openFile'],
      filters: [{ name: 'Audio and video', extensions: MEDIA_EXTENSIONS }],
    });
    if (canceled || !filePaths[0]) return null;
    project.media = { ...project.media, path: filePaths[0], name: path.basename(filePaths[0]) };
    await projects.save(target, project);
  }
  await remember(target, project);
  return openPayload(target, project);
});

handle('projects:rename', async (_event, { filePath, name }) => {
  const renamed = await projects.rename(filePath, name);
  buildMenu();
  return renamed;
});

handle('projects:duplicate', async (_event, { filePath }) => {
  const copy = await projects.duplicate(filePath);
  buildMenu();
  return copy;
});

handle('projects:trash', async (_event, { filePath }) => {
  await shell.trashItem(filePath);
  await projects.forget(filePath);
  buildMenu();
  return projects.recent();
});

handle('projects:reveal', async (_event, { filePath }) => {
  shell.showItemInFolder(filePath);
});

let recentMenu = [];
async function buildMenu() {
  const command = (name) => () => send('menu:command', name);
  try {
    recentMenu = (await projects.recent()).slice(0, 12).map((r) => ({ label: r.name, click: () => send('menu:open-project', r.path) }));
  } catch {
    recentMenu = [];
  }
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: command('new-project') },
        { label: 'Projects Home', accelerator: 'CmdOrCtrl+Shift+H', click: command('home') },
        { type: 'separator' },
        { label: 'Open Media…', accelerator: 'CmdOrCtrl+O', click: command('open-media') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+Shift+O', click: command('open-project') },
        { label: 'Open Recent', submenu: recentMenu.length ? recentMenu : [{ label: 'No recent projects', enabled: false }] },
        { label: 'Duplicate Project', click: command('duplicate-project') },
        { type: 'separator' },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: command('save') },
        { label: 'Save Project As…', accelerator: 'CmdOrCtrl+Shift+S', click: command('save-as') },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: command('export') },
        { type: 'separator' },
        { label: 'API Keys…', accelerator: 'CmdOrCtrl+Shift+K', click: command('api-keys') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: command('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: command('redo') },
        { type: 'separator' },
        { label: 'Cut Selection', accelerator: 'Backspace', registerAccelerator: false, click: command('delete') },
        { label: 'Restore Selection', accelerator: 'CmdOrCtrl+Backspace', click: command('restore') },
        { label: 'Find and Replace…', accelerator: 'CmdOrCtrl+F', click: command('find') },
        { label: 'Remove Filler Words', accelerator: 'CmdOrCtrl+Shift+F', click: command('remove-fillers') },
        { label: 'Remove Retakes', accelerator: 'CmdOrCtrl+Shift+R', click: command('remove-retakes') },
        { label: 'Shorten Pauses', accelerator: 'CmdOrCtrl+Shift+P', click: command('shorten-pauses') },
        { type: 'separator' },
        { role: 'copy' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: command('select-all') },
      ],
    },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play / Pause', accelerator: 'Space', registerAccelerator: false, click: command('toggle-play') },
        { label: 'Back 5 Seconds', accelerator: 'Left', registerAccelerator: false, click: command('seek-back') },
        { label: 'Forward 5 Seconds', accelerator: 'Right', registerAccelerator: false, click: command('seek-forward') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Studio Workspace', accelerator: 'CmdOrCtrl+1', registerAccelerator: false, click: command('workspace-studio') },
        { label: 'Video First Workspace', accelerator: 'CmdOrCtrl+2', registerAccelerator: false, click: command('workspace-video') },
        { label: 'Script First Workspace', accelerator: 'CmdOrCtrl+3', registerAccelerator: false, click: command('workspace-script') },
        { label: 'Reels Workspace', accelerator: 'CmdOrCtrl+4', registerAccelerator: false, click: command('workspace-reels') },
        { type: 'separator' },
        { label: 'Show or Hide Transcript', click: command('toggle-transcript') },
        { label: 'Show or Hide Timeline', click: command('toggle-timeline') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: command('settings') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Files passed on the command line (npm start -- clip.mp4) or dropped on the Dock icon.
let pendingOpenPath = process.argv.slice(app.isPackaged ? 1 : 2).find((arg) => !arg.startsWith('-')) ?? null;

function openPathInWindow(filePath) {
  if (mainWindow && !mainWindow.webContents.isLoading()) send('media:open-path', path.resolve(filePath));
  else pendingOpenPath = filePath;
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openPathInWindow(filePath);
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingOpenPath) openPathInWindow(pendingOpenPath);
    pendingOpenPath = null;
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
