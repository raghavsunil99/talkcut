// Project files (.talkcut JSON; older ones are .cutline) and the recent-projects list shown
// on the home screen. Projects live in ~/Documents/Talkcut Projects by default; the video stays where it is and
// the project refers to it by path.
const fs = require('node:fs/promises');
const path = require('node:path');

const EXTENSION = 'talkcut';
const OLD_EXTENSIONS = ['cutline']; // projects saved before the app was renamed still open
const stripExt = (p) => path.basename(p).replace(/\.(talkcut|cutline)$/i, '');
const MAX_RECENT = 40;

function safeName(name) {
  return String(name ?? '').replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';
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
    await fs.writeFile(tmp, JSON.stringify({ version: 2, savedAt: Date.now(), ...project }, null, 2));
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

module.exports = { createProjects, safeName, EXTENSION, OLD_EXTENSIONS };
