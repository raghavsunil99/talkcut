const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdates, parseVersion, isNewer } = require('../src/updates.js');

const URL_OK = 'https://github.com/raghavsunil99/talkcut/releases/tag/talkcut-1.0.4';

function setup({ current = '1.0.3', answer = { tag_name: 'talkcut-1.0.4', html_url: URL_OK }, status = 200, fail = false } = {}) {
  let settings = {};
  let clock = 1_000_000;
  const calls = [];
  const state = { answer, status, fail };
  const updates = createUpdates({
    currentVersion: current,
    now: () => clock,
    readSettings: async () => JSON.parse(JSON.stringify(settings)),
    writeSettings: async (s) => { settings = JSON.parse(JSON.stringify(s)); },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      if (state.fail) throw new TypeError('fetch failed');
      return { ok: state.status === 200, status: state.status, json: async () => state.answer };
    },
  });
  return { updates, calls, state, tick: (ms) => { clock += ms; }, settings: () => settings };
}

test('versions are read from tags and compared number by number', () => {
  assert.deepEqual(parseVersion('talkcut-1.0.4'), [1, 0, 4]);
  assert.deepEqual(parseVersion('v2.10.0'), [2, 10, 0]);
  assert.equal(parseVersion('nightly'), null);
  assert.equal(isNewer('talkcut-1.0.4', '1.0.3'), true);
  assert.equal(isNewer('1.0.10', '1.0.9'), true, 'ten is more than nine');
  assert.equal(isNewer('1.1.0', '1.0.9'), true);
  assert.equal(isNewer('2.0.0', '1.9.9'), true);
  assert.equal(isNewer('1.0.3', '1.0.3'), false);
  assert.equal(isNewer('1.0.2', '1.0.3'), false, 'a development copy ahead of the release is not told to update');
  assert.equal(isNewer('nightly', '1.0.3'), false);
  assert.equal(isNewer('1.0.4', 'dev'), false);
});

test('a newer release gives a notice with both versions and the link', async () => {
  const { updates } = setup();
  assert.deepEqual(await updates.check(), { version: '1.0.4', current: '1.0.3', url: URL_OK });
});

test('nothing is shown when the release is the same or older', async () => {
  assert.equal(await setup({ current: '1.0.4' }).updates.check(), null);
  assert.equal(await setup({ current: '1.0.5' }).updates.check(), null);
});

test('the request is a plain read that says only that it is Talkcut', async () => {
  const { updates, calls } = setup();
  await updates.check();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/raghavsunil99/talkcut/releases/latest');
  assert.deepEqual(Object.keys(calls[0].opts.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(calls[0].opts.headers['User-Agent'], 'Talkcut');
  assert.ok(calls[0].opts.signal, 'it times out');
});

test('offline, a rate limit or an odd answer are silent', async () => {
  assert.equal(await setup({ fail: true }).updates.check(), null);
  assert.equal(await setup({ status: 403 }).updates.check(), null);
  assert.equal(await setup({ status: 500 }).updates.check(), null);
  assert.equal(await setup({ answer: { tag_name: 'nightly', html_url: URL_OK } }).updates.check(), null);
  assert.equal(await setup({ answer: null }).updates.check(), null);
  assert.equal(await setup({ answer: {} }).updates.check(), null);
});

test('only links into this project are ever offered', async () => {
  for (const html_url of ['https://evil.example/talkcut', 'http://github.com/raghavsunil99/talkcut/releases', 'https://github.com/someone-else/talkcut/releases/tag/talkcut-1.0.4', 'javascript:alert(1)', 42]) {
    assert.equal(await setup({ answer: { tag_name: 'talkcut-1.0.4', html_url } }).updates.check(), null, String(html_url));
  }
});

test('GitHub is asked once a day; in between the saved answer is used', async () => {
  const { updates, calls, tick } = setup();
  assert.ok(await updates.check());
  assert.ok(await updates.check());
  tick(23 * 60 * 60 * 1000);
  assert.ok(await updates.check());
  assert.equal(calls.length, 1, 'no second request within the day');
  tick(2 * 60 * 60 * 1000);
  assert.ok(await updates.check());
  assert.equal(calls.length, 2, 'a new request after the day is up');
});

test('when asking fails, the last answer still shows and the next launch asks again', async () => {
  const { updates, calls, state, tick } = setup();
  assert.ok(await updates.check());
  tick(2 * 24 * 60 * 60 * 1000);
  state.fail = true;
  assert.deepEqual((await updates.check())?.version, '1.0.4', 'offline: the saved answer is used');
  assert.equal(calls.length, 2);
  state.fail = false;
  await updates.check();
  assert.equal(calls.length, 3, 'asked again, because the failed ask did not count as a check');
});

test('Later hides this version, and the next release shows again', async () => {
  const { updates, state, tick } = setup();
  assert.ok(await updates.check());
  await updates.dismiss('1.0.4');
  assert.equal(await updates.check(), null);
  tick(2 * 24 * 60 * 60 * 1000);
  assert.equal(await updates.check(), null, 'still hidden after a fresh check of the same version');
  state.answer = { tag_name: 'talkcut-1.0.5', html_url: URL_OK.replace('1.0.4', '1.0.5') };
  tick(2 * 24 * 60 * 60 * 1000);
  assert.equal((await updates.check())?.version, '1.0.5');
});

test('the update entry does not disturb the other settings', async () => {
  let settings = { keys: { elevenlabs: [{ id: 'k' }] }, recentProjects: [{ path: '/a' }] };
  const updates = createUpdates({
    currentVersion: '1.0.3', readSettings: async () => structuredClone(settings), writeSettings: async (s) => { settings = structuredClone(s); },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'talkcut-1.0.4', html_url: URL_OK }) }),
  });
  await updates.check();
  assert.deepEqual(settings.keys, { elevenlabs: [{ id: 'k' }] });
  assert.deepEqual(settings.recentProjects, [{ path: '/a' }]);
  assert.equal(settings.update.latest.version, '1.0.4');
});
