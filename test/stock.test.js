const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stock = require('../src/stock.js');

// Responses shaped like the Pexels API, served by a stubbed fetch.
const videoResponse = {
  videos: [{
    id: 123,
    image: 'https://images.pexels.com/videos/123/thumb.jpg',
    duration: 12,
    url: 'https://www.pexels.com/video/123/',
    user: { name: 'Asha' },
    video_files: [
      { link: 'https://videos.pexels.com/video-files/123/uhd.mp4', file_type: 'video/mp4', width: 3840, height: 2160 },
      { link: 'https://videos.pexels.com/video-files/123/hd.mp4', file_type: 'video/mp4', width: 1920, height: 1080 },
      { link: 'https://videos.pexels.com/video-files/123/sd.mp4', file_type: 'video/mp4', width: 960, height: 540 },
    ],
  }],
};
const photoResponse = {
  photos: [{ id: 9, width: 4000, height: 3000, url: 'https://www.pexels.com/photo/9/', photographer: 'Ravi', src: { medium: 'https://images.pexels.com/photos/9/m.jpg', large2x: 'https://images.pexels.com/photos/9/l.jpg' } }],
};

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

test('search normalizes videos and picks the HD file, sending the key', async () => {
  let seen;
  const restore = stubFetch(async (url, opts) => {
    seen = { url: String(url), auth: opts?.headers?.Authorization };
    return new Response(JSON.stringify(videoResponse), { status: 200 });
  });
  try {
    const results = await stock.search('KEY', { query: 'city night', kind: 'video', orientation: 'portrait' });
    assert.match(seen.url, /^https:\/\/api\.pexels\.com\/videos\/search\?query=city\+night&per_page=24&page=1&orientation=portrait$/);
    assert.equal(seen.auth, 'KEY');
    assert.equal(results.length, 1);
    assert.deepEqual(
      { kind: results[0].kind, download: results[0].download, author: results[0].author, duration: results[0].duration },
      { kind: 'video', download: 'https://videos.pexels.com/video-files/123/hd.mp4', author: 'Asha', duration: 12 },
    );
  } finally { restore(); }
});

test('search normalizes photos', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify(photoResponse), { status: 200 }));
  try {
    const [p] = await stock.search('KEY', { query: 'tea', kind: 'image' });
    assert.equal(p.kind, 'image');
    assert.equal(p.download, 'https://images.pexels.com/photos/9/l.jpg');
    assert.equal(p.author, 'Ravi');
  } finally { restore(); }
});

test('a rejected key gives a clear message', async () => {
  const restore = stubFetch(async () => new Response('{}', { status: 401 }));
  try {
    await assert.rejects(stock.verifyKey('BAD'), /rejected the API key/);
  } finally { restore(); }
});

test('download refuses addresses outside Pexels and caches files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-stock-'));
  try {
    await assert.rejects(stock.download({ id: 'video-1', kind: 'video', download: 'https://evil.example.com/x.mp4' }, dir), /Unexpected download address/);
    let calls = 0;
    const restore = stubFetch(async () => { calls++; return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-length': '4' } }); });
    try {
      const item = { id: 'video-123', kind: 'video', download: 'https://videos.pexels.com/video-files/123/hd.mp4' };
      const first = await stock.download(item, dir);
      const second = await stock.download(item, dir);
      assert.equal(first, second);
      assert.equal(calls, 1);
      assert.equal(fs.readFileSync(first).length, 4);
    } finally { restore(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickVideoFile prefers the largest file that fits the target size', () => {
  const f = stock.pickVideoFile(videoResponse.videos[0].video_files, 1280);
  assert.equal(f.width, 960);
});
