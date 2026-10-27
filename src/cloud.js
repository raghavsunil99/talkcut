// Optional cloud transcription with ElevenLabs Scribe. On the user's Telugu clips it scored
// 3% word errors against Descript's transcript where local Whisper scored ~70%. The audio is
// uploaded to ElevenLabs, so it only runs when the user picks the Cloud quality setting.
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { encodeForUpload } = require('./media');

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
const MODEL = 'scribe_v2';

// ElevenLabs reports ISO 639-3 codes; the app uses ISO 639-1.
const ISO3 = { tel: 'te', hin: 'hi', tam: 'ta', kan: 'kn', mal: 'ml', mar: 'mr', ben: 'bn', eng: 'en', spa: 'es', fra: 'fr', deu: 'de' };

function toWords(json) {
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
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].end > words[i + 1].start) words[i].end = words[i + 1].start;
  }
  const code = String(json.language_code ?? '').toLowerCase();
  return { words, language: ISO3[code] ?? (code.length === 2 ? code : null) };
}

// An error that means the key has no credits left, so another key may work.
function quotaError(message) {
  const err = new Error(message);
  err.code = 'QUOTA';
  return err;
}

async function request(key, form) {
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'xi-api-key': key }, body: form });
  if (!res.ok) {
    let detail = {};
    try { detail = (await res.clone().json()).detail ?? {}; } catch {}
    const text = JSON.stringify(detail).toLowerCase();
    if (/quota|credit|insufficient|limit_reached|payment/.test(text) || res.status === 402) {
      throw quotaError('This ElevenLabs key has run out of credits.');
    }
  }
  if (res.status === 401 || res.status === 403) throw new Error('ElevenLabs rejected the API key. Check it in API keys (⇧⌘K).');
  if (res.status === 429) throw new Error('ElevenLabs is busy (too many requests). Try again in a moment.');
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify((await res.json()).detail ?? '').slice(0, 300); } catch {}
    throw new Error(`Cloud transcription failed (HTTP ${res.status}) ${detail}`);
  }
  return res.json();
}

async function transcribeCloud(filePath, { key, language = 'auto', onProgress }) {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutline-cloud-'));
  try {
    onProgress?.({ stage: 'decode', progress: 0 });
    const audio = path.join(work, 'audio.m4a');
    await encodeForUpload(filePath, audio);
    const form = new FormData();
    form.append('model_id', MODEL);
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    form.append('diarize', 'true'); // who is speaking, for speaker labels
    if (language && language !== 'auto') form.append('language_code', language);
    form.append('file', new Blob([await fsp.readFile(audio)], { type: 'audio/mp4' }), 'audio.m4a');
    onProgress?.({ stage: 'upload', progress: null });
    const { words, language: detected } = toWords(await request(key, form));
    return { words, language: language !== 'auto' ? language : detected ?? 'en' };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

// Credits used and left on the account behind a key, and when they reset.
async function usage(key) {
  const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key } });
  if (res.status === 401 || res.status === 403) {
    let detail = '';
    try { detail = JSON.stringify((await res.json()).detail ?? ''); } catch {}
    if (/permission|user_read/i.test(detail)) throw new Error('This key is not allowed to read account usage. Enable the "User: Read" permission for it on elevenlabs.io.');
    throw new Error('ElevenLabs rejected this key.');
  }
  if (!res.ok) throw new Error(`Could not read usage (HTTP ${res.status}).`);
  const s = await res.json();
  return {
    tier: s.tier ?? null,
    status: s.status ?? null,
    used: Number(s.character_count) || 0,
    limit: Number(s.character_limit) || 0,
    resetsAt: s.next_character_count_reset_unix ? s.next_character_count_reset_unix * 1000 : null,
  };
}

module.exports = { transcribeCloud, toWords, usage, ENDPOINT, MODEL };
