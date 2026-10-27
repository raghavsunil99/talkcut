/* global FFmpegWASM, Capacitor, CutlineCaptions, CutlineEdits, CutlineFrame, CutlineText, CutlineRenderPlan */
// Android version of the desktop app's back end. The editor (src/renderer) talks to
// `window.cutline`; on the desktop that is Electron's preload, on Android it is this file:
//   files       picked videos, kept in the app's storage (IndexedDB) so projects reopen
//   media info  read with <video>/<audio>/<img>; waveform with Web Audio; thumbnails on a canvas
//   transcribe  ElevenLabs Scribe, with the user's own key
//   export      ffmpeg.wasm running the same recipe as the desktop (renderer/render-plan.js);
//               the finished video opens the share sheet (Instagram, WhatsApp, Files, Photos)
//   projects    IndexedDB; keys in the app's local storage (this phone only)
(function () {
  const LANGUAGES = {
    auto: 'Auto-detect', en: 'English', te: 'Telugu', hi: 'Hindi', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam',
    mr: 'Marathi', bn: 'Bengali', es: 'Spanish', fr: 'French', de: 'German',
  };
  const ISO3 = { tel: 'te', hin: 'hi', tam: 'ta', kan: 'kn', mal: 'ml', mar: 'mr', ben: 'bn', eng: 'en', spa: 'es', fra: 'fr', deu: 'de' };
  const FONT_FILES = ['NotoSans.ttf', 'NotoSansTelugu.ttf', 'NotoSansTamil.ttf', 'NotoSansMalayalam.ttf', 'NotoSansKannada.ttf', 'NotoSansDevanagari.ttf', 'NotoSansBengali.ttf'];
  const plugins = () => window.Capacitor?.Plugins ?? {};

  // ---------- events ----------

  const listeners = new Map();
  const on = (name, cb) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(cb);
    return () => listeners.get(name).delete(cb);
  };
  const emit = (name, payload) => listeners.get(name)?.forEach((cb) => cb(payload));

  // ---------- storage (IndexedDB) ----------

  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('talkcut', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('media');
          req.result.createObjectStore('projects');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      navigator.storage?.persist?.().catch(() => {});
    }
    return dbPromise;
  }
  async function store(name, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(name, mode);
      const req = fn(tx.objectStore(name));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('The phone is out of space for Talkcut. Delete some projects and try again.'));
    });
  }
  const dbGet = (name, key) => store(name, 'readonly', (s) => s.get(key));
  const dbPut = (name, key, value) => store(name, 'readwrite', (s) => s.put(value, key));
  const dbDelete = (name, key) => store(name, 'readwrite', (s) => s.delete(key));
  const dbAll = (name) => store(name, 'readonly', (s) => s.getAll());

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  // ---------- files ----------

  const files = new Map(); // "media:<id>" -> File
  const urls = new Map(); // "media:<id>" -> blob: URL

  async function putFile(file) {
    const path = `media:${uid()}`;
    files.set(path, file);
    await dbPut('media', path, file);
    return path;
  }
  async function fileFor(path) {
    if (files.has(path)) return files.get(path);
    const file = await dbGet('media', path);
    if (file) files.set(path, file);
    return file ?? null;
  }
  function urlFor(path) {
    if (!urls.has(path) && files.has(path)) urls.set(path, URL.createObjectURL(files.get(path)));
    return urls.get(path) ?? '';
  }

  // The phone's file picker; resolves to [] when cancelled.
  function pickFiles({ accept, multiple = false }) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
      input.style.display = 'none';
      document.body.appendChild(input);
      let done = false;
      const finish = (list) => { if (done) return; done = true; input.remove(); resolve(list); };
      input.addEventListener('change', () => finish([...input.files]));
      input.addEventListener('cancel', () => finish([]));
      // Android's picker gives no cancel event in some versions: give up when the app comes back
      // with nothing picked.
      const back = () => setTimeout(() => { if (!input.files?.length) finish([]); }, 1500);
      window.addEventListener('focus', back, { once: true });
      input.click();
    });
  }

  const ext = (name) => (name.split('.').pop() || '').toLowerCase();
  const isImage = (file) => /^image\//.test(file.type) || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'].includes(ext(file.name));
  const isAudio = (file) => /^audio\//.test(file.type) || ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aiff'].includes(ext(file.name));

  // ---------- media info ----------

  function loadElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      if (isImage(file)) {
        const img = new Image();
        img.onload = () => resolve({ el: img, url, width: img.naturalWidth, height: img.naturalHeight, duration: null, hasVideo: true });
        img.onerror = () => reject(new Error(`Can't read the image “${file.name}”.`));
        img.src = url;
        return;
      }
      const el = document.createElement(isAudio(file) ? 'audio' : 'video');
      el.preload = 'auto';
      el.muted = true;
      el.playsInline = true;
      el.onloadedmetadata = () => resolve({
        el, url, width: el.videoWidth || null, height: el.videoHeight || null,
        duration: Number.isFinite(el.duration) ? el.duration : null, hasVideo: Boolean(el.videoWidth),
      });
      el.onerror = () => reject(new Error(`This phone can't play “${file.name}”. Try an MP4 (H.264) video.`));
      el.src = url;
    });
  }

  async function probe(file) {
    const info = await loadElement(file);
    URL.revokeObjectURL(info.url);
    return { duration: info.duration, hasVideo: info.hasVideo, hasAudio: !isImage(file), width: info.width, height: info.height };
  }

  // Seek and wait until that frame can be drawn (Android's WebView reports "seeked" before the
  // picture is decoded, which gave black thumbnails).
  // Android only loads a video's frames when it is on the page, so it is attached (invisibly)
  // while frames are read, and every wait has a time limit.
  const within = (ms, promise) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
  async function seek(el, t) {
    if (!el.isConnected) {
      el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
      document.body.appendChild(el);
    }
    if (el.readyState < 2) await within(4000, new Promise((resolve) => el.addEventListener('loadeddata', resolve, { once: true })));
    await within(3000, new Promise((resolve) => { el.onseeked = resolve; el.currentTime = t; }));
    if (el.requestVideoFrameCallback) {
      await Promise.race([new Promise((resolve) => el.requestVideoFrameCallback(() => resolve())), new Promise((resolve) => setTimeout(resolve, 300))]);
    }
  }

  // A frame of a video (or the image itself) as a small JPEG data URL.
  async function thumbnail(file, at = 0.5, height = 180) {
    const info = await loadElement(file);
    try {
      if (info.el.tagName === 'VIDEO') await seek(info.el, Math.min(at, Math.max(0, (info.duration || 1) - 0.05)));
      const canvas = document.createElement('canvas');
      canvas.height = height;
      canvas.width = Math.max(2, Math.round(((info.width || 16) / (info.height || 9)) * height));
      canvas.getContext('2d').drawImage(info.el, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.75);
    } finally {
      info.el.remove?.();
      URL.revokeObjectURL(info.url);
    }
  }

  async function describeMedia(path) {
    const file = await fileFor(path);
    if (!file) throw new Error('That video is no longer stored in Talkcut. Open it again.');
    if (isImage(file)) throw new Error('Open a video or audio file to start a project.');
    return { path, url: urlFor(path), name: file.name, ...(await probe(file)) };
  }

  async function describeBroll(path) {
    const file = await fileFor(path);
    const kind = isImage(file) ? 'image' : 'video';
    const info = await probe(file);
    if (!info.hasVideo) throw new Error('This file has no picture to use as B-roll.');
    return {
      path, url: urlFor(path), name: file.name, kind,
      duration: kind === 'video' ? info.duration : null, width: info.width, height: info.height,
      thumb: await thumbnail(file, kind === 'video' ? Math.min(1, (info.duration || 2) / 2) : 0, 120).catch(() => null),
    };
  }

  async function describeAudio(path) {
    const file = await fileFor(path);
    const info = await probe(file);
    return { path, url: urlFor(path), name: file.name, kind: 'audio', duration: info.duration };
  }

  // Waveform peaks (0..1, 50 per second) and filmstrip frames.
  async function timeline({ path, duration, hasVideo }) {
    const file = await fileFor(path);
    const perSecond = 50;
    let peaks = [];
    try {
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const audio = await ctx.decodeAudioData(await file.arrayBuffer());
      const ch = audio.getChannelData(0);
      const bucket = Math.max(1, Math.round(audio.sampleRate / perSecond));
      peaks = new Array(Math.ceil(ch.length / bucket));
      for (let b = 0; b < peaks.length; b++) {
        let max = 0;
        const end = Math.min(ch.length, (b + 1) * bucket);
        for (let i = b * bucket; i < end; i++) { const v = Math.abs(ch[i]); if (v > max) max = v; }
        peaks[b] = Math.round(max * 1000) / 1000;
      }
    } catch { /* no audio, or it can't be decoded here: no waveform */ }
    const frames = [];
    if (hasVideo && duration) {
      const info = await loadElement(file);
      try {
        const count = Math.min(60, Math.max(8, Math.round(duration / 2)));
        const interval = duration / count;
        const canvas = document.createElement('canvas');
        canvas.height = 96;
        canvas.width = Math.max(2, Math.round(((info.width || 16) / (info.height || 9)) * 96));
        const g = canvas.getContext('2d');
        for (let i = 0; i < count; i++) {
          const t = (i + 0.5) * interval;
          await seek(info.el, t);
          g.drawImage(info.el, 0, 0, canvas.width, canvas.height);
          frames.push({ t, src: canvas.toDataURL('image/jpeg', 0.7) });
        }
      } finally {
        info.el.remove?.();
        URL.revokeObjectURL(info.url);
      }
    }
    return { perSecond, peaks, frames };
  }

  // ---------- API keys (this phone only) ----------

  const KEYS = 'talkcut.keys';
  const readKeys = () => {
    try { return { elevenlabs: [], pexels: [], ...JSON.parse(localStorage.getItem(KEYS) || '{}') }; } catch { return { elevenlabs: [], pexels: [] }; }
  };
  const writeKeys = (k) => localStorage.setItem(KEYS, JSON.stringify(k));
  const activeEntry = (service, k = readKeys()) => {
    const list = k[service].filter((x) => x.enabled !== false);
    return list.find((x) => x.active) ?? list[0] ?? null;
  };
  const activeKey = (service) => activeEntry(service)?.key ?? null;
  function listKeys() {
    const k = readKeys();
    const out = {};
    for (const service of ['elevenlabs', 'pexels']) {
      const active = activeEntry(service, k);
      out[service] = k[service].map((x) => ({ id: x.id, label: x.label, last4: x.key.slice(-4), note: x.note ?? '', enabled: x.enabled !== false, active: x.id === active?.id }));
    }
    return out;
  }
  function changeKey(service, fn) {
    const k = readKeys();
    k[service] = fn(k[service]);
    writeKeys(k);
    return listKeys();
  }
  function addKey(service, label, key, note) {
    const value = String(key ?? '').trim();
    if (!value) throw new Error('Paste an API key first.');
    const k = readKeys();
    if (k[service].some((x) => x.key === value)) throw new Error('That key is already saved.');
    k[service] = k[service].map((x) => ({ ...x, active: false }));
    k[service].push({ id: uid(), label: String(label || `Key ${k[service].length + 1}`).slice(0, 40), key: value, note: String(note ?? '').slice(0, 200), enabled: true, active: true });
    writeKeys(k);
    return listKeys();
  }

  // ---------- ElevenLabs ----------

  async function transcribe(path, language, quality) {
    if (quality !== 'cloud') throw new Error('On Android, Talkcut transcribes with ElevenLabs. Choose ElevenLabs, or Skip for now.');
    const key = activeKey('elevenlabs');
    if (!key) throw new Error('Add an ElevenLabs API key first (key icon at the top).');
    const file = await fileFor(path);
    emit('transcribe:progress', { stage: 'upload', progress: null });
    const form = new FormData();
    form.append('model_id', 'scribe_v2');
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    form.append('diarize', 'true');
    if (language && language !== 'auto') form.append('language_code', language);
    form.append('file', file, file.name);
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form });
    if (res.status === 401 || res.status === 403) throw new Error('ElevenLabs rejected the API key. Check it under API keys.');
    if (res.status === 402) throw new Error('This ElevenLabs key has run out of credits.');
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify((await res.json()).detail ?? '').slice(0, 300); } catch {}
      if (/quota|credit/i.test(detail)) throw new Error('This ElevenLabs key has run out of credits.');
      throw new Error(`Cloud transcription failed (HTTP ${res.status}) ${detail}`);
    }
    const json = await res.json();
    const words = [];
    for (const w of json.words ?? []) {
      if (w.type !== 'word' || !Number.isFinite(w.start)) continue;
      const text = String(w.text ?? '').trim();
      if (!text) continue;
      const word = { text, start: w.start, end: Number.isFinite(w.end) ? Math.max(w.end, w.start) : w.start + 0.2 };
      if (w.speaker_id != null) word.speaker = String(w.speaker_id);
      words.push(word);
    }
    words.sort((a, b) => a.start - b.start);
    for (let i = 0; i < words.length - 1; i++) if (words[i].end > words[i + 1].start) words[i].end = words[i + 1].start;
    const code = String(json.language_code ?? '').toLowerCase();
    const detected = ISO3[code] ?? (code.length === 2 ? code : null);
    return { words, language: language !== 'auto' ? language : detected ?? 'en' };
  }

  async function keyUsage(service, id) {
    const entry = readKeys()[service].find((x) => x.id === id);
    if (!entry) throw new Error('That key is gone.');
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': entry.key } });
    if (res.status === 401 || res.status === 403) throw new Error('This key is not allowed to read account usage. Enable the "User: Read" permission for it on elevenlabs.io.');
    if (!res.ok) throw new Error(`Could not read usage (HTTP ${res.status}).`);
    const s = await res.json();
    return {
      tier: s.tier ?? null, status: s.status ?? null, used: Number(s.character_count) || 0, limit: Number(s.character_limit) || 0,
      resetsAt: s.next_character_count_reset_unix ? s.next_character_count_reset_unix * 1000 : null,
    };
  }

  // ---------- Pexels ----------

  async function pexels(url) {
    const key = activeKey('pexels');
    if (!key) throw new Error('Add a Pexels API key to search stock media.');
    const res = await fetch(url, { headers: { Authorization: key } });
    if (res.status === 401 || res.status === 403) throw new Error('Pexels rejected the API key.');
    if (!res.ok) throw new Error(`Pexels search failed (HTTP ${res.status}).`);
    return res.json();
  }
  async function searchStock(query, kind, orientation) {
    if (!String(query ?? '').trim()) return [];
    const q = new URLSearchParams({ query: String(query).slice(0, 100), per_page: '24' });
    if (orientation) q.set('orientation', orientation);
    if (kind === 'image') {
      const data = await pexels(`https://api.pexels.com/v1/search?${q}`);
      return (data.photos ?? []).map((p) => ({ id: `photo-${p.id}`, kind: 'image', thumb: p.src?.medium, download: p.src?.large2x ?? p.src?.original, width: p.width, height: p.height, duration: null, author: p.photographer, pageUrl: p.url }));
    }
    const data = await pexels(`https://api.pexels.com/videos/search?${q}`);
    return (data.videos ?? []).map((v) => {
      const list = (v.video_files ?? []).filter((f) => f.link && f.width && f.height && /mp4/i.test(f.file_type ?? 'mp4'));
      const long = (f) => Math.max(f.width, f.height);
      const pick = list.filter((f) => long(f) <= 1300).sort((a, b) => long(b) - long(a))[0] ?? list[0];
      return { id: `video-${v.id}`, kind: 'video', thumb: v.image, download: pick?.link, width: pick?.width, height: pick?.height, duration: v.duration, author: v.user?.name, pageUrl: v.url };
    }).filter((v) => v.download);
  }
  async function downloadStock(item) {
    emit('stock:progress', { id: item.id, progress: null });
    const res = await fetch(item.download);
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
    const blob = await res.blob();
    const file = new File([blob], `pexels-${item.id}.${item.kind === 'image' ? 'jpg' : 'mp4'}`, { type: blob.type || (item.kind === 'image' ? 'image/jpeg' : 'video/mp4') });
    return describeBroll(await putFile(file));
  }

  // ---------- ffmpeg.wasm ----------

  let ffmpegPromise = null;
  const abs = (p) => new URL(p, location.href).href;
  function ffmpeg() {
    if (!ffmpegPromise) {
      ffmpegPromise = (async () => {
        const ff = new FFmpegWASM.FFmpeg();
        await ff.load({
          coreURL: abs('vendor/ffmpeg/ffmpeg-core.js'),
          wasmURL: abs('vendor/ffmpeg/ffmpeg-core.wasm'),
          // No classWorkerURL: that makes a module worker, which can't load the core script.
        });
        await ff.createDir('/fonts');
        for (const f of FONT_FILES) await ff.writeFile(`/fonts/${f}`, new Uint8Array(await (await fetch(abs(`fonts/${f}`))).arrayBuffer()));
        return ff;
      })();
      ffmpegPromise.catch(() => { ffmpegPromise = null; });
    }
    return ffmpegPromise;
  }
  // One ffmpeg job at a time.
  let queue = Promise.resolve();
  function runFfmpeg(job) {
    const next = queue.then(job, job);
    queue = next.catch(() => {});
    return next;
  }
  const writeInput = async (ff, name, file) => ff.writeFile(name, new Uint8Array(await file.arrayBuffer()));

  let lastSavedTo = null;
  // Save a finished file in the app and open Android's share sheet for it.
  async function shareFile(bytes, name, mime) {
    const { Filesystem, Share } = plugins();
    if (!Filesystem || !Share) {
      // Running in a plain browser (testing): download instead.
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
      a.download = name;
      a.click();
      return name;
    }
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    const data = btoa(binary);
    // A copy in Documents/Talkcut (visible in the Files app), then the share sheet for
    // Instagram, WhatsApp, Photos and so on. The share sheet isn't waited for.
    let saved;
    try {
      saved = await Filesystem.writeFile({ path: `Talkcut/${name}`, data, directory: 'DOCUMENTS', recursive: true });
      lastSavedTo = `Documents/Talkcut/${name}`;
    } catch {
      saved = await Filesystem.writeFile({ path: `Talkcut/${name}`, data, directory: 'CACHE', recursive: true });
      lastSavedTo = null;
    }
    Share.share({ title: name, files: [saved.uri], dialogTitle: 'Share your video' }).catch(() => {});
    return lastSavedTo ?? name;
  }

  const EXPORT_PRESETS = {
    edited: { canvas: null, crf: 22, suffix: 'edited' },
    reels: { canvas: '9:16', crf: 23, suffix: 'reels' },
    youtube: { canvas: '16:9', crf: 22, suffix: 'youtube' },
    square: { canvas: '1:1', crf: 23, suffix: 'square' },
    audio: { audioOnly: true, suffix: 'audio' },
  };
  const QUALITY_CRF = { high: 20, standard: 23, small: 28 };

  async function exportMedia(media, ranges, { overlays = [], audio = [], captions = null, clip: editedClip = null, preset: presetId = 'edited', quality = null, subtitles = null } = {}) {
    const preset = EXPORT_PRESETS[presetId] ?? EXPORT_PRESETS.edited;
    const clip = preset.canvas ? { ...(editedClip || {}), canvas: preset.canvas } : editedClip;
    const crf = QUALITY_CRF[quality] ?? preset.crf;
    const withPicture = media.hasVideo && !preset.audioOnly;
    const base = media.name.replace(/\.[^.]+$/, '');
    const outName = `${base}-${preset.suffix}.${withPicture ? 'mp4' : 'm4a'}`;
    return runFfmpeg(async () => {
      emit('export:progress', { progress: 0 });
      const ff = await ffmpeg();
      const used = [];
      const put = async (name, file) => { await writeInput(ff, name, file); used.push(name); };
      const putText = async (name, text) => { await ff.writeFile(name, new TextEncoder().encode(text)); used.push(name); };
      try {
        const main = await fileFor(media.path);
        const input = `in.${ext(main.name) || 'mp4'}`;
        await put(input, main);
        const { frame } = CutlineFrame.layout(media.width || 1280, media.height || 720, clip);
        let assPath = null;
        let textAssPath = null;
        if (withPicture && captions?.settings?.enabled && captions.words?.length) {
          await putText('captions.ass', CutlineCaptions.buildAss({
            words: captions.words, deleted: new Set(captions.deleted ?? []), settings: captions.settings, language: captions.language,
            width: frame.w, height: frame.h, toEdited: (t) => CutlineEdits.toEdited(ranges, t),
          }));
          assPath = 'captions.ass';
        }
        const texts = withPicture ? overlays.filter((o) => o.kind === 'text' && String(o.text ?? '').trim()) : [];
        if (texts.length) {
          await putText('text.ass', CutlineText.buildAss(texts, { width: frame.w, height: frame.h, language: captions?.language }));
          textAssPath = 'text.ass';
        }
        const pictures = [];
        if (withPicture) {
          for (const [i, o] of overlays.entries()) {
            if (o.kind === 'text' || !o.path) continue;
            const f = await fileFor(o.path);
            if (!f) continue;
            const name = `o${i}.${ext(f.name) || 'mp4'}`;
            await put(name, f);
            pictures.push({ ...o, path: name, kind: isImage(f) ? 'image' : 'video', hasAudio: !isImage(f) && (o.volume ?? 0) > 0 });
          }
        }
        const sounds = [];
        for (const [i, a] of audio.entries()) {
          const f = await fileFor(a.path);
          if (!f) continue;
          const name = `a${i}.${ext(f.name) || 'm4a'}`;
          await put(name, f);
          sounds.push({ ...a, path: name, offset: a.offset ?? 0, volume: a.volume ?? 1, duck: a.duck !== false });
        }
        const output = withPicture ? 'out.mp4' : 'out.m4a';
        const { args, total } = CutlineRenderPlan.buildRenderArgs({
          input, output, ranges, hasVideo: withPicture, hasAudio: media.hasAudio, duration: media.duration, width: media.width, height: media.height,
          overlays: pictures, audio: media.hasAudio ? sounds : [], assPath, textAssPath, fontsDir: (assPath || textAssPath) ? '/fonts' : null,
          clip, crf, preset: 'ultrafast', filterPath: (p) => `'${p}'`,
        });
        const onLog = ({ message }) => {
          const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
          if (m) emit('export:progress', { progress: Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / total) });
        };
        ff.on('log', onLog);
        let code;
        try { code = await ff.exec(args.filter((a) => a !== '-nostdin')); } finally { ff.off('log', onLog); }
        if (code !== 0) throw new Error('The export failed on this phone. Try a shorter video, or use the desktop app.');
        const data = await ff.readFile(output);
        used.push(output);
        const where = await shareFile(data, outName, withPicture ? 'video/mp4' : 'audio/mp4');
        if (subtitles?.content) await shareFile(new TextEncoder().encode(subtitles.content), `${base}-${preset.suffix}.${subtitles.format}`, 'text/plain');
        return where;
      } finally {
        for (const name of used) await ff.deleteFile(name).catch(() => {});
      }
    });
  }

  const enhanced = new Map();
  function enhancedAudio(path) {
    if (!enhanced.has(path)) {
      enhanced.set(path, runFfmpeg(async () => {
        const ff = await ffmpeg();
        const file = await fileFor(path);
        const input = `sv.${ext(file.name) || 'mp4'}`;
        await writeInput(ff, input, file);
        try {
          const code = await ff.exec(['-i', input, '-vn', '-af', `${CutlineRenderPlan.STUDIO_SOUND},aresample=48000`, '-c:a', 'aac', '-b:a', '160k', 'sv.m4a']);
          if (code !== 0) throw new Error('Studio Sound could not process this file on the phone.');
          const data = await ff.readFile('sv.m4a');
          return URL.createObjectURL(new Blob([data.buffer], { type: 'audio/mp4' }));
        } finally {
          await ff.deleteFile(input).catch(() => {});
          await ff.deleteFile('sv.m4a').catch(() => {});
        }
      }));
      enhanced.get(path).catch(() => enhanced.delete(path));
    }
    return enhanced.get(path);
  }

  // ---------- projects ----------

  // "project:<id>/<name>.talkcut": the editor shows the last part as the project's name.
  const safe = (name) => String(name).replace(/[/\\]/g, ' ');
  const projectPath = (id, name) => `project:${id}/${safe(name)}.talkcut`;
  const projectId = (path) => String(path).replace(/^project:/, '').split('/')[0];

  async function recentProjects() {
    const all = await dbAll('projects');
    return all.sort((a, b) => b.updatedAt - a.updatedAt).map((p) => ({
      path: projectPath(p.id, p.name), name: p.name, updatedAt: p.updatedAt, mediaName: p.mediaName, duration: p.duration, thumb: p.thumb, thumbVersion: 2,
    }));
  }

  async function writeProject(id, name, project, old) {
    let thumb = old?.thumb ?? null;
    if (!thumb && project.media?.hasVideo) {
      const f = await fileFor(project.media.path);
      if (f) thumb = await thumbnail(f, Math.min(1, (project.media.duration || 2) / 2)).catch(() => null);
    }
    await dbPut('projects', id, { id, name, data: { version: 2, savedAt: Date.now(), ...project }, updatedAt: Date.now(), mediaName: project.media?.name, duration: project.media?.duration, thumb });
    return projectPath(id, name);
  }

  async function uniqueName(name) {
    const taken = new Set((await dbAll('projects')).map((p) => p.name));
    for (let n = 1; ; n++) { const c = n === 1 ? name : `${name} ${n}`; if (!taken.has(c)) return c; }
  }
  const createProject = async (project, name) => writeProject(uid(), await uniqueName(String(name || 'Untitled').slice(0, 80)), project);

  async function saveProject(project, filePath, saveAs = false) {
    if (!filePath || saveAs) return createProject(project, project.media?.name?.replace(/\.[^.]+$/, ''));
    const id = projectId(filePath);
    const old = await dbGet('projects', id);
    return writeProject(id, old?.name ?? 'Untitled', project, old);
  }

  // Open a saved project; if its video is no longer stored, ask for it again.
  async function openProject(filePath) {
    let rec;
    if (!filePath) {
      const [file] = await pickFiles({ accept: '.talkcut,.cutline,application/json' });
      if (!file) return null;
      let data;
      try { data = JSON.parse(await file.text()); } catch { throw new Error('This file is not a Talkcut project, or it is damaged.'); }
      if (!data?.media || !Array.isArray(data.words)) throw new Error('This is not a valid Talkcut project.');
      const id = uid();
      await writeProject(id, await uniqueName(file.name.replace(/\.(talkcut|cutline)$/i, '')), data);
      rec = await dbGet('projects', id);
    } else {
      rec = await dbGet('projects', projectId(filePath));
      if (!rec) throw new Error('That project is gone from this phone.');
    }
    const project = rec.data;
    if (!(await fileFor(project.media.path))) {
      if (!window.confirm(`Choose the video “${project.media.name}” for this project.`)) return null;
      const [file] = await pickFiles({ accept: 'video/*,audio/*' });
      if (!file) return null;
      project.media = { ...project.media, path: await putFile(file), name: file.name };
      await writeProject(rec.id, rec.name, project, rec);
    }
    for (const t of project.tracks ?? []) for (const i of t.items ?? []) if (i.path) await fileFor(i.path);
    await dbPut('projects', rec.id, { ...rec, updatedAt: Date.now() });
    return {
      filePath: projectPath(rec.id, rec.name), media: await describeMedia(project.media.path),
      words: project.words, deleted: project.deleted ?? [], cutGaps: project.cutGaps ?? [], language: project.language ?? null,
      captions: project.captions ?? null, clip: project.clip ?? null, splits: project.splits ?? [], rangeCuts: project.rangeCuts ?? [],
      tracks: project.tracks ?? null, speakers: project.speakers ?? null, extras: project.extras ?? null, broll: [],
    };
  }

  async function renameProject(filePath, name) {
    const rec = await dbGet('projects', projectId(filePath));
    const clean = String(name).trim().slice(0, 80);
    if (!clean) throw new Error('Type a name first.');
    if ((await dbAll('projects')).some((p) => p.name === clean && p.id !== rec.id)) throw new Error(`A project called “${clean}” already exists.`);
    await dbPut('projects', rec.id, { ...rec, name: clean });
    return projectPath(rec.id, clean);
  }
  async function duplicateProject(filePath) {
    const rec = await dbGet('projects', projectId(filePath));
    const id = uid();
    const name = await uniqueName(`${rec.name} copy`);
    await dbPut('projects', id, { ...rec, id, name, updatedAt: Date.now() });
    return projectPath(id, name);
  }

  // Android's back button: leave the editor for the projects list instead of closing the app.
  plugins().App?.addListener?.('backButton', () => emit('menu:command', 'home'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) emit('app:before-close'); });

  window.cutline = {
    platform: 'android',
    mediaUrl: (path) => urlFor(path),
    openMedia: async () => {
      const [file] = await pickFiles({ accept: 'video/*,audio/*' });
      return file ? describeMedia(await putFile(file)) : null;
    },
    openDroppedFile: async (file) => describeMedia(await putFile(file)),
    openPath: (path) => describeMedia(path),
    onOpenPath: (cb) => on('media:open-path', cb),
    options: async () => ({
      languages: Object.entries(LANGUAGES).map(([code, label]) => ({ code, label })),
      qualities: [{ code: 'cloud', label: 'ElevenLabs (cloud)' }],
    }),
    transcribe,
    timeline: (media) => timeline({ path: media.path, duration: media.duration, hasVideo: media.hasVideo }),
    exportMedia,
    saveCaptions: async (media, content, format) => shareFile(new TextEncoder().encode(content), `${media.name.replace(/\.[^.]+$/, '')}.${format}`, 'text/plain'),
    settings: async () => ({ hasPexelsKey: Boolean(activeKey('pexels')), hasElevenLabsKey: Boolean(activeKey('elevenlabs')) }),
    setPexelsKey: async (key) => { addKey('pexels', '', key, ''); return { hasPexelsKey: true }; },
    listKeys: async () => listKeys(),
    keyUsage,
    addKey: async (service, label, key, note) => addKey(service, label, key, note),
    enableKey: async (service, id, enabled) => changeKey(service, (list) => list.map((x) => (x.id === id ? { ...x, enabled } : x))),
    setKeyNote: async (service, id, note) => changeKey(service, (list) => list.map((x) => (x.id === id ? { ...x, note: String(note ?? '').slice(0, 200) } : x))),
    selectKey: async (service, id) => changeKey(service, (list) => list.map((x) => ({ ...x, active: x.id === id, enabled: x.id === id ? true : x.enabled }))),
    renameKey: async (service, id, label) => changeKey(service, (list) => list.map((x) => (x.id === id ? { ...x, label: String(label).slice(0, 40) } : x))),
    removeKey: async (service, id) => changeKey(service, (list) => list.filter((x) => x.id !== id)),
    openBroll: async () => Promise.all((await pickFiles({ accept: 'video/*,image/*', multiple: true })).map(async (f) => describeBroll(await putFile(f)))),
    describeBroll,
    openAudio: async () => Promise.all((await pickFiles({ accept: 'audio/*', multiple: true })).map(async (f) => describeAudio(await putFile(f)))),
    describeAudio,
    enhancedAudio,
    findFaces: async () => { throw new Error('Auto-frame is only in the Mac app.'); },
    searchStock,
    downloadStock,
    onStockProgress: (cb) => on('stock:progress', cb),
    openExternal: async (url) => { if (/^https:\/\/(www\.)?(pexels\.com|elevenlabs\.io)\//.test(url)) window.open(url, '_system'); },
    saveProject: (project, filePath, saveAs = false) => saveProject(project, filePath, saveAs),
    openProject,
    createProject,
    recentProjects,
    projectsDir: async () => 'this phone',
    renameProject,
    duplicateProject,
    trashProject: async (filePath) => dbDelete('projects', projectId(filePath)),
    revealProject: async () => {},
    onOpenProjectPath: (cb) => on('menu:open-project', cb),
    setDirty: async () => {},
    onBeforeClose: (cb) => on('app:before-close', cb),
    closeNow: async () => {},
    onTranscribeProgress: (cb) => on('transcribe:progress', cb),
    onExportProgress: (cb) => on('export:progress', cb),
    onMenuCommand: (cb) => on('menu:command', cb),
  };
})();
