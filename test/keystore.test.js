const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeystore } = require('../src/keystore.js');

// In-memory settings with a reversible stand-in for safeStorage.
function setup(initial = {}) {
  let settings = JSON.parse(JSON.stringify(initial));
  const store = createKeystore({
    read: async () => JSON.parse(JSON.stringify(settings)),
    write: async (s) => { settings = JSON.parse(JSON.stringify(s)); },
    encrypt: (v) => `enc:${Buffer.from(v).toString('base64')}`,
    decrypt: (v) => Buffer.from(v.replace(/^enc:/, ''), 'base64').toString(),
  });
  return { store, settings: () => settings };
}

test('add makes the new key active; list shows only labels and last four characters', async () => {
  const { store, settings } = setup();
  await store.add('elevenlabs', 'Personal', 'sk_aaaa1111');
  await store.add('elevenlabs', 'Office', 'sk_bbbb2222');
  assert.equal(await store.get('elevenlabs'), 'sk_bbbb2222');
  const { elevenlabs } = await store.list();
  assert.deepEqual(elevenlabs.map(({ label, last4, active }) => ({ label, last4, active })), [
    { label: 'Personal', last4: '1111', active: false },
    { label: 'Office', last4: '2222', active: true },
  ]);
  assert.ok(!JSON.stringify(await store.list()).includes('sk_'), 'list must not expose keys');
  assert.ok(!JSON.stringify(settings()).includes('sk_'), 'settings must hold keys encrypted');
});

test('select switches the active key and remove falls back to another', async () => {
  const { store } = setup();
  const a = await store.add('elevenlabs', 'A', 'key-a-0001');
  const b = await store.add('elevenlabs', 'B', 'key-b-0002');
  await store.select('elevenlabs', a);
  assert.equal(await store.get('elevenlabs'), 'key-a-0001');
  await store.remove('elevenlabs', a);
  assert.equal(await store.get('elevenlabs'), 'key-b-0002');
  await store.remove('elevenlabs', b);
  assert.equal(await store.get('elevenlabs'), null);
});

test('services are kept apart, duplicates and empty keys are refused, verify can reject', async () => {
  const { store } = setup();
  await store.add('pexels', '', 'px-1234');
  assert.equal(await store.get('pexels'), 'px-1234');
  assert.equal(await store.get('elevenlabs'), null);
  assert.equal((await store.list()).pexels[0].label, 'Key 1');
  await assert.rejects(store.add('pexels', 'again', 'px-1234'), /already saved/);
  await assert.rejects(store.add('pexels', 'x', '  '), /Paste an API key/);
  await assert.rejects(store.add('pexels', 'x', 'bad', async () => { throw new Error('rejected'); }), /rejected/);
  await assert.rejects(store.get('nope'), /Unknown service/);
});

test('a single key from an earlier version is migrated as the active key', async () => {
  const { store, settings } = setup({ elevenlabsKey: `enc:${Buffer.from('sk_old9999').toString('base64')}` });
  assert.equal(await store.get('elevenlabs'), 'sk_old9999');
  assert.deepEqual((await store.list()).elevenlabs.map((k) => [k.label, k.last4, k.active]), [['Key 1', '9999', true]]);
  assert.equal(settings().elevenlabsKey, undefined);
});

test('rename changes the label', async () => {
  const { store } = setup();
  const id = await store.add('elevenlabs', 'Old', 'k-1111');
  await store.rename('elevenlabs', id, 'Client');
  assert.equal((await store.list()).elevenlabs[0].label, 'Client');
});

test('notes are saved with a key, shown in the list and can be edited', async () => {
  const { store } = setup();
  const id = await store.add('elevenlabs', 'Personal', 'k-1234', null, '  raghav@gmail.com account  ');
  assert.equal((await store.list()).elevenlabs[0].note, 'raghav@gmail.com account');
  await store.setNote('elevenlabs', id, 'Office account (billing: team)');
  assert.equal((await store.list()).elevenlabs[0].note, 'Office account (billing: team)');
  await store.setNote('elevenlabs', id, '');
  assert.equal((await store.list()).elevenlabs[0].note, '');
  const old = await store.add('pexels', 'x', 'p-9999');
  assert.equal((await store.list()).pexels.find((k) => k.id === old).note, '');
});

test('disabled keys are skipped; fallbacks lists the other enabled keys', async () => {
  const { store } = setup();
  const a = await store.add('elevenlabs', 'A', 'key-a-0001');
  const b = await store.add('elevenlabs', 'B', 'key-b-0002');
  const c = await store.add('elevenlabs', 'C', 'key-c-0003');
  await store.select('elevenlabs', a);
  assert.deepEqual((await store.fallbacks('elevenlabs')).map((k) => k.label), ['B', 'C']);
  await store.setEnabled('elevenlabs', b, false);
  assert.deepEqual((await store.fallbacks('elevenlabs')).map((k) => k.label), ['C']);
  await store.setEnabled('elevenlabs', a, false); // the chosen key is off: the first enabled one is used
  assert.equal(await store.get('elevenlabs'), 'key-c-0003');
  assert.equal((await store.activeInfo('elevenlabs')).label, 'C');
  const listed = (await store.list()).elevenlabs;
  assert.deepEqual(listed.map((k) => [k.label, k.enabled, k.active]), [['A', false, false], ['B', false, false], ['C', true, true]]);
  await store.setEnabled('elevenlabs', c, false);
  assert.equal(await store.get('elevenlabs'), null);
  await store.select('elevenlabs', b); // choosing a key turns it back on
  assert.equal(await store.get('elevenlabs'), 'key-b-0002');
});
