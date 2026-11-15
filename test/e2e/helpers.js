// End-to-end helpers: fixture media and projects made with ffmpeg, and the real app driven with
// Playwright. Every run gets its own temporary folder for settings, projects and exports, so the
// user's own Talkcut data is never touched (see the CUTLINE_* switches in src/main.js).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..', '..');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'talkcut-e2e-'));
}

// A 7-second test-pattern video. `tone` gives it a sine-wave voice; without it the sound track
// is silent, which the transcriber reports as "no speech". A steady tone also counts as no
// speech (it is all at the noise floor); `tone: 'pulsed'` switches it on and off like speech.
function makeVideo(dir, { name = 'clip.mp4', tone = true, seconds = 7, size = '320x240' } = {}) {
  const out = path.join(dir, name);
  const audio = tone === 'pulsed'
    ? 'aevalsrc=if(lt(mod(t\\,1)\\,0.6)\\,0.5*sin(2*PI*300*t)\\,0):s=48000'
    : tone ? 'sine=frequency=300:sample_rate=48000' : 'anullsrc=r=48000:cl=mono';
  execFileSync(ffmpeg, [
    '-hide_banner', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30`, '-f', 'lavfi', '-i', audio,
    '-t', String(seconds), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', out,
  ], { stdio: 'ignore' });
  return out;
}

function makeImage(dir, name = 'photo.png') {
  const out = path.join(dir, name);
  execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x120', '-frames:v', '1', out], { stdio: 'ignore' });
  return out;
}

// Eight words with a 1.6 s pause after the fourth:
//   one 0.2  two 0.8  three 1.4  four 2.0 | pause 2.4–4.0 | five 4.0  six 4.6  seven 5.2  eight 5.8
const WORDS = [0.2, 0.8, 1.4, 2.0, 4.0, 4.6, 5.2, 5.8].map((start, i) => ({
  text: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][i],
  start,
  end: start + 0.4,
}));

// A saved project for `video`, listed on the home screen of a fresh settings folder.
function makeProject(dir, video, extra = {}) {
  const projectsDir = path.join(dir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const file = path.join(projectsDir, 'Demo.talkcut');
  fs.writeFileSync(file, JSON.stringify({
    version: 2,
    media: { path: video, name: path.basename(video), duration: 7, hasVideo: true, hasAudio: true, width: 320, height: 240 },
    language: 'en',
    words: WORDS,
    deleted: [],
    ...extra,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ recentProjects: [{ path: file, name: 'Demo', updatedAt: Date.now() }] }));
  return file;
}

const readProject = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function launch(dir, { args = [] } = {}) {
  const app = await _electron.launch({
    args: [ROOT, ...args],
    cwd: ROOT,
    env: {
      ...process.env,
      CUTLINE_TEST: '1',
      CUTLINE_USER_DATA: dir,
      CUTLINE_PROJECTS_DIR: path.join(dir, 'projects'),
      CUTLINE_TEST_EXPORT: path.join(dir, 'export.mp4'),
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

// Quit the app. A quit that never finishes fails the test instead of hanging the run.
async function closeApp(app, ms = 20000) {
  let timer;
  const hung = new Promise((_, reject) => {
    timer = setTimeout(() => { app.process().kill('SIGKILL'); reject(new Error(`The app did not quit within ${ms / 1000} s`)); }, ms);
  });
  try { await Promise.race([app.close(), hung]); } finally { clearTimeout(timer); }
}

// Open the first project on the home screen and wait for its transcript.
async function openFromHome(page) {
  await page.locator('.project-card').first().click();
  await page.locator('#transcript .w').first().waitFor();
}

// Select words from..to in the transcript (click, then Shift-click).
async function selectWords(page, from, to) {
  await page.locator(`#transcript .w[data-i="${from}"]`).click();
  await page.locator(`#transcript .w[data-i="${to}"]`).click({ modifiers: ['Shift'] });
}

// Poll until fn() is truthy (fn may be async), or fail with `what`.
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

module.exports = { ROOT, WORDS, tempDir, makeVideo, makeImage, makeProject, readProject, launch, closeApp, openFromHome, selectWords, until };
