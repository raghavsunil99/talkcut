// Named API keys per service (several ElevenLabs keys, for example), one of them active.
// Keys are kept encrypted inside the settings object; only labels and the last four
// characters ever leave this module for display.
const crypto = require('node:crypto');

const SERVICES = ['elevenlabs', 'pexels'];
// Single-key settings fields from earlier versions, migrated into the list on first read.
const LEGACY = { elevenlabs: 'elevenlabsKey', pexels: 'pexelsKey' };

const cleanNote = (note) => String(note ?? '').trim().slice(0, 200);

function createKeystore({ read, write, encrypt, decrypt }) {
  function check(service) {
    if (!SERVICES.includes(service)) throw new Error(`Unknown service: ${service}`);
  }

  async function load() {
    const settings = await read();
    settings.keys ??= {};
    settings.activeKey ??= {};
    let migrated = false;
    for (const service of SERVICES) {
      settings.keys[service] ??= [];
      const legacy = settings[LEGACY[service]];
      if (legacy) {
        let last4 = '????';
        try { last4 = decrypt(legacy).slice(-4); } catch {}
        const entry = { id: crypto.randomUUID(), label: 'Key 1', enc: legacy, last4 };
        settings.keys[service].push(entry);
        settings.activeKey[service] ??= entry.id;
        delete settings[LEGACY[service]];
        migrated = true;
      }
    }
    if (migrated) await write(settings);
    return settings;
  }

  const isEnabled = (k) => k.enabled !== false;

  // The key in use: the chosen one if it is enabled, otherwise the first enabled key.
  function activeEntry(settings, service) {
    const list = settings.keys[service];
    const chosen = list.find((k) => k.id === settings.activeKey[service]);
    if (chosen && isEnabled(chosen)) return chosen;
    return list.find(isEnabled) ?? null;
  }

  return {
    // Decrypted active key, or null.
    async get(service) {
      check(service);
      const entry = activeEntry(await load(), service);
      if (!entry) return null;
      try { return decrypt(entry.enc); } catch { return null; }
    },

    // What the UI may see: labels, last four characters, which one is active.
    async list() {
      const settings = await load();
      const out = {};
      for (const service of SERVICES) {
        const active = activeEntry(settings, service)?.id;
        out[service] = settings.keys[service].map((k) => ({ id: k.id, label: k.label, last4: k.last4, note: k.note ?? '', enabled: isEnabled(k), active: k.id === active }));
      }
      return out;
    },

    // Add a key and make it the active one. `verify` can reject a bad key first.
    async add(service, label, key, verify, note = '') {
      check(service);
      const value = String(key ?? '').trim();
      if (!value) throw new Error('Paste an API key first.');
      await verify?.(value);
      const settings = await load();
      const list = settings.keys[service];
      if (list.some((k) => { try { return decrypt(k.enc) === value; } catch { return false; } })) {
        throw new Error('That key is already saved.');
      }
      const entry = {
        id: crypto.randomUUID(),
        label: String(label ?? '').trim().slice(0, 40) || `Key ${list.length + 1}`,
        enc: encrypt(value),
        last4: value.slice(-4),
        note: cleanNote(note),
      };
      list.push(entry);
      settings.activeKey[service] = entry.id;
      await write(settings);
      return entry.id;
    },

    // Enabled keys other than the one in use, in list order: candidates to switch to when the
    // active key runs out of credits.
    async fallbacks(service) {
      check(service);
      const settings = await load();
      const active = activeEntry(settings, service)?.id;
      return settings.keys[service].filter((k) => isEnabled(k) && k.id !== active).map(({ id, label, last4, note }) => ({ id, label, last4, note: note ?? '' }));
    },

    // The key currently used, with its id (for failover messages).
    async activeInfo(service) {
      check(service);
      const e = activeEntry(await load(), service);
      return e ? { id: e.id, label: e.label, last4: e.last4, note: e.note ?? '' } : null;
    },

    async setEnabled(service, id, enabled) {
      check(service);
      const settings = await load();
      const entry = settings.keys[service].find((k) => k.id === id);
      if (!entry) throw new Error('That key no longer exists.');
      entry.enabled = Boolean(enabled);
      await write(settings);
    },

    // Decrypted key by id, for actions on a specific (not necessarily active) key.
    async getById(service, id) {
      check(service);
      const entry = (await load()).keys[service].find((k) => k.id === id);
      if (!entry) throw new Error('That key no longer exists.');
      return decrypt(entry.enc);
    },

    async select(service, id) {
      check(service);
      const settings = await load();
      const entry = settings.keys[service].find((k) => k.id === id);
      if (!entry) throw new Error('That key no longer exists.');
      entry.enabled = true;
      settings.activeKey[service] = id;
      await write(settings);
    },

    async rename(service, id, label) {
      check(service);
      const settings = await load();
      const entry = settings.keys[service].find((k) => k.id === id);
      if (!entry) throw new Error('That key no longer exists.');
      entry.label = String(label ?? '').trim().slice(0, 40) || entry.label;
      await write(settings);
    },

    // A free-form note, e.g. which account the key belongs to.
    async setNote(service, id, note) {
      check(service);
      const settings = await load();
      const entry = settings.keys[service].find((k) => k.id === id);
      if (!entry) throw new Error('That key no longer exists.');
      entry.note = cleanNote(note);
      await write(settings);
    },

    async remove(service, id) {
      check(service);
      const settings = await load();
      settings.keys[service] = settings.keys[service].filter((k) => k.id !== id);
      if (settings.activeKey[service] === id) settings.activeKey[service] = settings.keys[service][0]?.id ?? null;
      await write(settings);
    },
  };
}

module.exports = { createKeystore, SERVICES };
