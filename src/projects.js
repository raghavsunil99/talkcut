// Project files (.talkcut JSON; older ones are .cutline) and the recent-projects list shown
// on the home screen. Projects live in ~/Documents/Talkcut Projects by default; the video stays where it is and
// the project refers to it by path.
const fs = require('node:fs/promises');
const path = require('node:path');
const Edits = require('./renderer/edits.js');

const EXTENSION = 'talkcut';
const OLD_EXTENSIONS = ['cutline']; // projects saved before the app was renamed still open
const stripExt = (p) => path.basename(p).replace(/\.(talkcut|cutline)$/i, '');
const MAX_RECENT = 40;

function safeName(name) {
  return String(name ?? '').replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';
}

// What the editor gets back when a project is opened (everything the project file holds except
// the media and B-roll, which main.js checks on disk).
function openFields(project) {
  return {
    words: project.words,
    deleted: project.deleted ?? [],
    cutGaps: project.cutGaps ?? [],
    order: project.order ?? null,
    gapKeep: project.gapKeep ?? null,
    scenes: project.scenes ?? [],
    language: project.language ?? null,
    captions: project.captions ?? null,
    clip: project.clip ?? null,
    splits: project.splits ?? [],
    rangeCuts: project.rangeCuts ?? [],
    tracks: project.tracks ?? null,
    speakers: project.speakers ?? null,
    extras: project.extras ?? null,
  };
}

// Project file versions.
//   2: words in time order, cuts by word index.
//   3: every word has an id, and `order` lists the pieces of the recording in play order
//      ([[start, end]] in source seconds, or null for straight through), so words can be moved.
const VERSION = 3;

// A project from an older version in today's shape. Version 2 files are valid version 3 files
// once every word has an id; they play straight through, so `order` is null.
function upgrade(project) {
  if ((project.version ?? 1) >= VERSION) return project;
  return { ...project, version: VERSION, words: Edits.ensureIds(project.words), order: null };
}

// Files used by items on tracks that are no longer on disk, once per file.
async function missingTrackFiles(tracks, exists = (p) => fs.access(p).then(() => true, () => false)) {
  const seen = new Map();
  for (const track of tracks ?? []) {
    for (const item of track.items ?? []) {
      if (item.path && !seen.has(item.path)) seen.set(item.path, { path: item.path, name: item.name || path.basename(item.path) });
    }
  }
  const missing = [];
  for (const entry of seen.values()) if (!(await exists(entry.path))) missing.push(entry);
  return missing;
}

// The same tracks with every item that used `from` pointing at `to`.
function relinkTracks(tracks, from, to) {
  return (tracks ?? []).map((t) => ({ ...t, items: (t.items ?? []).map((i) => (i.path === from ? { ...i, path: to } : i)) }));
}

function createProjects({ dir, readSettings, writeSettings }) {
  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async function exists(p) {
    return fs.access(p).then(() => true, () => false);
  }

  // "Name.talkcut", or "Name 2.talkcut" and so on if taken.
  async function uniquePath(name, folder = dir) {
    const base = safeName(name);
    for (let n = 1; ; n++) {
      const candidate = path.join(folder, `${n === 1 ? base : `${base} ${n}`}.${EXTENSION}`);
      if (!(await exists(candidate))) return candidate;
    }
  }

  // Write to a temporary file first, then rename, so a crash never leaves half a project.
  async function save(filePath, project) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.saving`;
    await fs.writeFile(tmp, JSON.stringify({ ...project, words: Edits.ensureIds(project.words ?? []), order: project.order ?? null, version: VERSION, savedAt: Date.now() }, null, 2));
    await fs.rename(tmp, filePath);
    return filePath;
  }

  async function load(filePath) {
    let project;
    try {
      project = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      throw new Error('This file is not a Talkcut project, or it is damaged.');
    }
    if (!project?.media?.path || !Array.isArray(project.words)) throw new Error('This is not a valid Talkcut project.');
    return project;
  }

  // Open a project, bringing an older file up to date. The old file is first copied to
  // "<name>.talkcut.v2.bak" beside it (never overwriting an earlier backup), because versions
  // of the app before this one cannot read the new file correctly.
  async function open(filePath) {
    const project = await load(filePath);
    const from = project.version ?? 1;
    if (from >= VERSION) return project;
    const backup = `${filePath}.v${from}.bak`;
    if (!(await exists(backup))) await fs.copyFile(filePath, backup);
    const upgraded = upgrade(project);
    await save(filePath, upgraded);
    return upgraded;
  }

  async function readRecent() {
    const settings = await readSettings();
    return Array.isArray(settings.recentProjects) ? settings.recentProjects : [];
  }

  async function writeRecent(list) {
    const settings = await readSettings();
    settings.recentProjects = list.slice(0, MAX_RECENT);
    await writeSettings(settings);
  }

  return {
    EXTENSION,
    dir,
    ensureDir,
    uniquePath,
    save,
    load,
    open,

    // Most recent first; projects whose file is gone are left out.
    async recent() {
      const list = await readRecent();
      const present = [];
      for (const r of list) if (await exists(r.path)) present.push(r);
      if (present.length !== list.length) await writeRecent(present);
      return present;
    },

    // Record that a project was opened or saved, with what the home screen shows for it.
    async touch(filePath, meta = {}) {
      const list = await readRecent();
      const old = list.find((r) => r.path === filePath) ?? {};
      const entry = {
        ...old,
        ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null)),
        path: filePath,
        name: stripExt(filePath),
        updatedAt: Date.now(),
      };
      await writeRecent([entry, ...list.filter((r) => r.path !== filePath)]);
      return entry;
    },

    // Change what the home screen shows for a project without moving it up the list.
    async patch(filePath, meta) {
      const list = await readRecent();
      await writeRecent(list.map((r) => (r.path === filePath ? { ...r, ...meta } : r)));
    },

    async forget(filePath) {
      await writeRecent((await readRecent()).filter((r) => r.path !== filePath));
    },

    async rename(filePath, newName) {
      const target = path.join(path.dirname(filePath), `${safeName(newName)}.${EXTENSION}`);
      if (target === filePath) return filePath;
      if (await exists(target)) throw new Error(`A project called “${safeName(newName)}” already exists there.`);
      await fs.rename(filePath, target);
      const list = await readRecent();
      await writeRecent(list.map((r) => (r.path === filePath ? { ...r, path: target, name: stripExt(target) } : r)));
      return target;
    },

    async duplicate(filePath) {
      const project = await load(filePath);
      const target = await uniquePath(`${stripExt(filePath)} copy`, path.dirname(filePath));
      await save(target, project);
      const list = await readRecent();
      const meta = list.find((r) => r.path === filePath) ?? {};
      await writeRecent([{ ...meta, path: target, name: stripExt(target), updatedAt: Date.now() }, ...list]);
      return target;
    },
  };
}

module.exports = { createProjects, upgrade, VERSION, openFields, missingTrackFiles, relinkTracks, safeName, EXTENSION, OLD_EXTENSIONS };
