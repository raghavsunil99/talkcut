const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjects, safeName, openFields, missingTrackFiles, relinkTracks } = require('../src/projects.js');

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
    assert.equal(path.basename(a), 'My Reel.talkcut');
    await projects.save(a, sample);
    assert.equal(path.basename(await projects.uniquePath('My: Reel')), 'My Reel 2.talkcut');
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
    assert.equal(back.version, 3);
    assert.equal(back.media.path, '/videos/clip.mov');
    fs.writeFileSync(path.join(root, 'bad.cutline'), '{nope');
    await assert.rejects(projects.load(path.join(root, 'bad.cutline')), /not a Talkcut project/);
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
    assert.equal(path.basename(renamed), 'Final cut.talkcut');
    assert.ok(fs.existsSync(renamed) && !fs.existsSync(a));
    assert.deepEqual((await projects.recent()).map((r) => r.name), ['B', 'Final cut']);
    await assert.rejects(projects.rename(b, 'Final cut'), /already exists/);

    const copy = await projects.duplicate(renamed);
    assert.equal(path.basename(copy), 'Final cut copy.talkcut');
    assert.equal((await projects.recent())[0].name, 'Final cut copy');
    assert.equal((await projects.recent())[0].duration, 12);

    fs.rmSync(b);
    assert.ok(!(await projects.recent()).some((r) => r.name === 'B'), 'missing project dropped');
  } finally { cleanup(); }
});

test('a reopened project keeps its speaker names and everything else the editor saved', () => {
  const saved = {
    ...sample, language: 'te', speakers: { s1: 'Raghav', s2: 'Guest' }, cutGaps: [0], splits: [1.5], rangeCuts: [[2, 3]],
    captions: { enabled: true }, clip: { speed: 1.5 }, tracks: [{ id: 't1', type: 'audio', items: [] }], extras: { a: 1 },
  };
  const fields = openFields(saved);
  assert.deepEqual(fields.speakers, { s1: 'Raghav', s2: 'Guest' });
  for (const key of ['language', 'cutGaps', 'splits', 'rangeCuts', 'captions', 'clip', 'tracks', 'extras', 'words']) assert.deepEqual(fields[key], saved[key], key);
  // Older projects without these fields still open.
  const old = openFields(sample);
  assert.equal(old.speakers, null);
  assert.deepEqual(old.deleted, []);
  assert.deepEqual(old.splits, []);
});

test('files used on tracks that are gone are found once each, and can be relinked', async () => {
  const tracks = [
    { id: 't1', type: 'overlay', items: [{ id: 'a', path: '/m/broll.mp4', name: 'broll.mp4' }, { id: 'b', kind: 'text', text: 'Hi' }, { id: 'c', path: '/m/here.png' }] },
    { id: 't2', type: 'audio', items: [{ id: 'd', path: '/m/broll.mp4', name: 'broll.mp4' }, { id: 'e', path: '/m/music.mp3' }] },
  ];
  const present = new Set(['/m/here.png']);
  const missing = await missingTrackFiles(tracks, async (p) => present.has(p));
  assert.deepEqual(missing.map((m) => m.path), ['/m/broll.mp4', '/m/music.mp3']);
  assert.equal(missing[0].name, 'broll.mp4');
  const fixed = relinkTracks(tracks, '/m/broll.mp4', '/new/clip.mp4');
  assert.deepEqual(fixed.flatMap((t) => t.items).map((i) => i.path), ['/new/clip.mp4', undefined, '/m/here.png', '/new/clip.mp4', '/m/music.mp3']);
  assert.equal(tracks[0].items[0].path, '/m/broll.mp4', 'the original is not changed');
  assert.deepEqual(await missingTrackFiles(null), []);
});
