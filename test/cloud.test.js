const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const cloud = require('../src/cloud.js');

// Response shaped like ElevenLabs speech-to-text.
const response = {
  language_code: 'tel',
  text: 'GPT అస్త్ర car ని',
  words: [
    { text: 'GPT', type: 'word', start: 0.1, end: 0.5 },
    { text: ' ', type: 'spacing', start: 0.5, end: 0.55 },
    { text: 'అస్త్ర', type: 'word', start: 0.55, end: 1.0 },
    { text: '(music)', type: 'audio_event', start: 1.0, end: 1.2 },
    { text: 'car', type: 'word', start: 1.6, end: 2.0 },
    { text: 'ని', type: 'word', start: 1.9, end: 2.1 },
  ],
};

function withAudio(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-cloud-test-'));
    const audio = path.join(dir, 'a.wav');
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', audio]);
    const original = global.fetch;
    try { await fn(audio); } finally {
      global.fetch = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const fieldsOf = (body) => Object.fromEntries([...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `file:${v.size}`]));

test('toWords keeps only words, fixes overlaps and maps the language code', () => {
  const { words, language } = cloud.toWords(response);
  assert.deepEqual(words.map((w) => w.text), ['GPT', 'అస్త్ర', 'car', 'ని']);
  assert.equal(language, 'te');
  assert.equal(words[2].end, 1.9);
});

test('transcribeCloud uploads compressed audio with the right fields', withAudio(async (audio) => {
  let seen;
  global.fetch = async (url, opts) => {
    seen = { url, key: opts.headers['xi-api-key'], fields: fieldsOf(opts.body) };
    return new Response(JSON.stringify(response), { status: 200 });
  };
  const out = await cloud.transcribeCloud(audio, { key: 'K', language: 'te' });
  assert.equal(seen.url, cloud.ENDPOINT);
  assert.equal(seen.key, 'K');
  assert.equal(seen.fields.model_id, 'scribe_v2');
  assert.equal(seen.fields.language_code, 'te');
  assert.equal(seen.fields.timestamps_granularity, 'word');
  assert.match(seen.fields.file, /^file:\d+$/);
  assert.equal(out.words.length, 4);
}));

test('auto language sends no language code and uses the detected one', withAudio(async (audio) => {
  let fields;
  global.fetch = async (_url, opts) => {
    fields = fieldsOf(opts.body);
    return new Response(JSON.stringify(response), { status: 200 });
  };
  const out = await cloud.transcribeCloud(audio, { key: 'K', language: 'auto' });
  assert.equal(fields.language_code, undefined);
  assert.equal(out.language, 'te');
}));

test('a rejected key gives a clear message', withAudio(async (audio) => {
  global.fetch = async () => new Response('{}', { status: 401 });
  await assert.rejects(cloud.transcribeCloud(audio, { key: 'BAD' }), /rejected the API key/);
}));

test('usage reads credits used, limit and reset time', async () => {
  const original = global.fetch;
  let seen;
  global.fetch = async (url, opts) => {
    seen = { url, key: opts.headers['xi-api-key'] };
    return new Response(JSON.stringify({ tier: 'creator', status: 'active', character_count: 12345, character_limit: 100000, next_character_count_reset_unix: 1793000000 }), { status: 200 });
  };
  try {
    const u = await cloud.usage('K');
    assert.equal(seen.url, 'https://api.elevenlabs.io/v1/user/subscription');
    assert.equal(seen.key, 'K');
    assert.deepEqual(u, { tier: 'creator', status: 'active', used: 12345, limit: 100000, resetsAt: 1793000000000 });
  } finally { global.fetch = original; }
});

test('usage explains a key without the user_read permission', async () => {
  const original = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission user_read' } }), { status: 401 });
  try {
    await assert.rejects(cloud.usage('K'), /User: Read/);
  } finally { global.fetch = original; }
});

test('an out-of-credits response is reported as a quota error', withAudio(async (audio) => {
  global.fetch = async () => new Response(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000. You have 12 credits remaining.' } }), { status: 401 });
  await assert.rejects(cloud.transcribeCloud(audio, { key: 'K' }), (err) => err.code === 'QUOTA' && /run out of credits/.test(err.message));
}));
