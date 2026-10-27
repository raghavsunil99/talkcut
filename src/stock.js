// Stock videos and photos from Pexels (free API key: https://www.pexels.com/api/).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const API = 'https://api.pexels.com';

async function pexels(key, url) {
  const res = await fetch(url, { headers: { Authorization: key } });
  if (res.status === 401 || res.status === 403) throw new Error('Pexels rejected the API key. Check it in Media → Stock settings.');
  if (res.status === 429) throw new Error('Pexels rate limit reached. Try again in a little while.');
  if (!res.ok) throw new Error(`Pexels search failed (HTTP ${res.status}).`);
  return res.json();
}

// Pick the file closest to the project's long side without going far above it.
function pickVideoFile(files, target = 1920) {
  const usable = (files ?? []).filter((f) => f.link && /mp4/i.test(f.file_type ?? 'mp4') && f.width && f.height);
  if (!usable.length) return null;
  const long = (f) => Math.max(f.width, f.height);
  const fits = usable.filter((f) => long(f) <= target * 1.1).sort((a, b) => long(b) - long(a));
  return fits[0] ?? usable.sort((a, b) => long(a) - long(b))[0];
}

async function search(key, { query, kind = 'video', orientation, page = 1, targetSize = 1920 }) {
  const q = new URLSearchParams({ query, per_page: '24', page: String(page) });
  if (orientation) q.set('orientation', orientation);
  if (kind === 'image') {
    const data = await pexels(key, `${API}/v1/search?${q}`);
    return (data.photos ?? []).map((p) => ({
      id: `photo-${p.id}`,
      kind: 'image',
      thumb: p.src?.medium,
      download: p.src?.large2x ?? p.src?.original,
      width: p.width,
      height: p.height,
      duration: null,
      author: p.photographer,
      pageUrl: p.url,
    }));
  }
  const data = await pexels(key, `${API}/videos/search?${q}`);
  return (data.videos ?? []).map((v) => {
    const file = pickVideoFile(v.video_files, targetSize);
    return file && {
      id: `video-${v.id}`,
      kind: 'video',
      thumb: v.image,
      download: file.link,
      width: file.width,
      height: file.height,
      duration: v.duration,
      author: v.user?.name,
      pageUrl: v.url,
    };
  }).filter(Boolean);
}

async function verifyKey(key) {
  await pexels(key, `${API}/v1/search?query=nature&per_page=1`);
}

// Download once into the media cache; later inserts of the same item reuse the file.
async function download(item, cacheDir, onProgress) {
  if (!/^https:\/\/([a-z0-9-]+\.)*(pexels\.com|vimeo\.com|vimeocdn\.com)\//i.test(item.download ?? '')) {
    throw new Error('Unexpected download address for a stock item.');
  }
  await fsp.mkdir(cacheDir, { recursive: true });
  const ext = item.kind === 'image' ? '.jpg' : '.mp4';
  const target = path.join(cacheDir, `pexels-${item.id.replace(/[^a-z0-9-]/gi, '')}${ext}`);
  if (fs.existsSync(target)) return target;
  const res = await fetch(item.download);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const partial = `${target}.part`;
  const out = fs.createWriteStream(partial);
  let loaded = 0;
  try {
    for await (const chunk of res.body) {
      loaded += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (total) onProgress?.(loaded / total);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(partial, { force: true });
    throw err;
  }
  await fsp.rename(partial, target);
  return target;
}

module.exports = { search, verifyKey, download, pickVideoFile };
