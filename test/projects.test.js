const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjects, safeName } = require('../src/projects.js');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-projects-'));
  let settings = {};
  const projects = createProjects({
    dir: path.join(root, 'Cutline Projects'),
    readSettings: async () => JSON.parse(JSON.stringify(settings)),
    writeSettings: async (s) => { settings = JSON.parse(JSON.stringify(s)); },
  });
  return { root, projects, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const sample = { media: { path: '/videos/clip.mov', name: 'clip.mov' }, words: [{ text: 'hi', start: 0, end: 0.3 }], deleted: [] };

test('uniquePath numbers names that are taken, and names are made file-safe', async () => {
  const { projects, cleanup } = setup();
  try {
    await projects.ensureDir();
    const a = await projects.uniquePath('My: Reel');
    assert.equal(path.basename(a), 'My Reel.cutline');
    await projects.save(a, sample);
    assert.equal(path.basename(await projects.uniquePath('My: Reel')), 'My Reel 2.cutline');
    assert.equal(safeName('  '), 'Untitled');
  } finally { cleanup(); }
});

test('save writes atomically and load validates', async () => {
  const { root, projects, cleanup } = setup();
  try {
    const p = path.join(root, 'a.cutline');
    await projects.save(p, sample);
    assert.ok(!fs.existsSync(`${p}.saving`));
    const back = await projects.load(p);
    assert.equal(back.version, 2);
    assert.equal(back.media.path, '/videos/clip.mov');
    fs.writeFileSync(path.join(root, 'bad.cutline'), '{nope');
    await assert.rejects(projects.load(path.join(root, 'bad.cutline')), /not a Cutline project/);
    fs.writeFileSync(path.join(root, 'empty.cutline'), '{}');
    await assert.rejects(projects.load(path.join(root, 'empty.cutline')), /not a valid/);
  } finally { cleanup(); }
});

test('recent list: newest first, drops missing files, follows rename and duplicate', async () => {
  const { root, projects, cleanup } = setup();
  try {
    const a = path.join(root, 'A.cutline');
    const b = path.join(root, 'B.cutline');
    await projects.save(a, sample);
    await projects.save(b, sample);
    await projects.touch(a, { mediaName: 'clip.mov', duration: 12 });
    await projects.touch(b, {});
    assert.deepEqual((await projects.recent()).map((r) => r.name), ['B', 'A']);
    assert.equal((await projects.recent())[1].duration, 12);

    const renamed = await projects.rename(a, 'Final cut');
    assert.equal(path.basename(renamed), 'Final cut.cutline');
    assert.ok(fs.existsSync(renamed) && !fs.existsSync(a));
    assert.deepEqual((await projects.recent()).map((r) => r.name), ['B', 'Final cut']);
    await assert.rejects(projects.rename(b, 'Final cut'), /already exists/);

    const copy = await projects.duplicate(renamed);
    assert.equal(path.basename(copy), 'Final cut copy.cutline');
    assert.equal((await projects.recent())[0].name, 'Final cut copy');
    assert.equal((await projects.recent())[0].duration, 12);

    fs.rmSync(b);
    assert.ok(!(await projects.recent()).some((r) => r.name === 'B'), 'missing project dropped');
  } finally { cleanup(); }
});
