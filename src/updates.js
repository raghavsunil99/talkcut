// "Is there a newer Talkcut?" Talkcut is not signed with an Apple developer certificate, so macOS
// cannot update it in place; instead the home screen tells people when a newer release exists on
// GitHub and sends them to its download page.
//
// One public, unauthenticated read of the latest release, at most once a day. It sends no
// information about the user: just a plain request with the name "Talkcut". Every failure
// (offline, rate limit, odd answer) is silent: no notice, no error.
const RELEASES = 'https://api.github.com/repos/raghavsunil99/talkcut/releases/latest';
// Only links into this project's releases are ever offered to open.
const PROJECT_LINK = /^https:\/\/github\.com\/raghavsunil99\/talkcut\//;
const DAY = 24 * 60 * 60 * 1000;

// [major, minor, patch] from a tag or version such as "talkcut-1.0.4", "v1.0.4" or "1.0.4".
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// True when `latest` is a higher version than `current`. An unreadable version is never newer.
function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function createUpdates({ currentVersion, fetch, readSettings, writeSettings, now = Date.now, url = RELEASES, timeoutMs = 8000 }) {
  // The settings entry: { checkedAt, latest: { version, url }, dismissed }.
  const load = async () => (await readSettings()).update ?? {};
  async function save(change) {
    const settings = await readSettings();
    settings.update = { ...(settings.update ?? {}), ...change };
    await writeSettings(settings);
  }

  async function fetchLatest() {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Talkcut' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const json = await res.json();
    const version = parseVersion(json.tag_name)?.join('.');
    if (!version || typeof json.html_url !== 'string' || !PROJECT_LINK.test(json.html_url)) return null;
    return { version, url: json.html_url };
  }

  return {
    // The newer release to tell the user about, or null: { version, current, url }.
    async check() {
      try {
        const saved = await load();
        let latest = saved.latest ?? null;
        // Ask again only once a day. A failed ask keeps the last answer and is retried next launch.
        if (!saved.checkedAt || now() - saved.checkedAt >= DAY || !latest) {
          const fresh = await fetchLatest().catch(() => null);
          if (fresh) {
            latest = fresh;
            await save({ checkedAt: now(), latest });
          }
        }
        if (!latest || !isNewer(latest.version, currentVersion) || saved.dismissed === latest.version) return null;
        return { version: latest.version, current: currentVersion, url: latest.url };
      } catch {
        return null;
      }
    },

    // "Later": stay quiet about this version (the next release shows the notice again).
    async dismiss(version) {
      await save({ dismissed: String(version ?? '') });
    },
  };
}

module.exports = { createUpdates, parseVersion, isNewer, RELEASES, PROJECT_LINK };
