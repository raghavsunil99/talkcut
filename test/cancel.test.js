// Cancelling long jobs, resuming the speech-model download, and plain messages for common
// ffmpeg failures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { runFfmpeg, renderEdit, friendlyFfmpegError } = require('../src/media.js');
const { ensureModel } = require('../src/transcribe.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-cancel-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a running ffmpeg job stops within a second of being cancelled', async () => {
  const job = new AbortController();
  // Ten minutes of generated video: far longer than the test waits.
  const run = runFfmpeg(['-hide_banner', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30', '-t', '600', '-f', 'null', '-'], { signal: job.signal });
  setTimeout(() => job.abort(), 300);
  const t0 = Date.now();
  await assert.rejects(run, (err) => err.code === 'CANCELLED' && err.message === 'CANCELLED');
  assert.ok(Date.now() - t0 < 1000, `stopped after ${Date.now() - t0} ms`);
});

test('a job cancelled before it starts never runs', async () => {
  const job = new AbortController();
  job.abort();
  await assert.rejects(renderEdit({ input: 'none.mp4', output: path.join(dir, 'x.m4a'), ranges: [[0, 1]], hasVideo: false, hasAudio: true, duration: 1, signal: job.signal }), { code: 'CANCELLED' });
});

test('common ffmpeg failures get a plain message', () => {
  assert.match(friendlyFfmpegError('av_interleaved_write_frame(): No space left on device'), /disk is full/);
  assert.match(friendlyFfmpegError('out.mp4: Permission denied'), /not allowed/);
  assert.match(friendlyFfmpegError('[mov,mp4] moov atom not found\nclip.mp4: Invalid data found when processing input'), /damaged/);
  assert.equal(friendlyFfmpegError('Unknown encoder'), null);
});

// A file server that supports byte ranges, like the model host, and can stall mid-file.
function modelServer(content) {
  const requests = [];
  let stallAt = null;
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    requests.push(req.headers.range ?? 'all');
    const from = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, { 'content-length': content.length - from });
    const body = content.subarray(from);
    if (stallAt == null) { res.end(body); return; }
    res.write(body.subarray(0, stallAt)); // then hang, like a dropped connection
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, requests, url: `http://127.0.0.1:${server.address().port}/`, stall: (n) => { stallAt = n; },
  })));
}

test('a cancelled model download keeps what it got and the next attempt resumes', async () => {
  const content = Buffer.alloc(300_000, 7);
  for (let i = 0; i < content.length; i++) content[i] = i % 251;
  const models = { tiny: { file: 'ggml-tiny.bin', bytes: content.length, label: 'Tiny' } };
  const srv = await modelServer(content);
  try {
    const modelDir = path.join(dir, 'models');
    srv.stall(100_000);
    const job = new AbortController();
    const first = ensureModel(modelDir, 'tiny', (p) => { if (p.progress > 0.3) job.abort(); }, { signal: job.signal, baseUrl: srv.url, models });
    await assert.rejects(first, { code: 'CANCELLED' });
    const partial = path.join(modelDir, 'ggml', 'ggml-tiny.bin.part');
    const kept = fs.statSync(partial).size;
    assert.ok(kept > 0 && kept < content.length, `kept ${kept} bytes`);

    srv.stall(null);
    const done = await ensureModel(modelDir, 'tiny', null, { baseUrl: srv.url, models });
    assert.deepEqual(fs.readFileSync(done), content);
    assert.equal(fs.existsSync(partial), false);
    assert.deepEqual(srv.requests, ['all', `bytes=${kept}-`]);
  } finally {
    srv.server.closeAllConnections();
    srv.server.close();
  }
});
