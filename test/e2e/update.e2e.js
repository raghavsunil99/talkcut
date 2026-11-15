// The "new version available" notice on the home screen. A local server stands in for GitHub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const H = require('./helpers.js');

const TIMEOUT = { timeout: 90_000 };
const LINK = (v) => `https://github.com/raghavsunil99/talkcut/releases/tag/talkcut-${v}`;

// Answers like GitHub's "latest release" call; `release.tag` and `release.url` can change between launches.
async function githubStub(release) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (release.status && release.status !== 200) { res.writeHead(release.status); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: release.tag, html_url: release.url ?? LINK(release.tag.replace('talkcut-', '')) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { hits, url: `http://127.0.0.1:${server.address().port}/latest`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

async function openHome(dir, url) {
  const { app, page } = await H.launch(dir, { env: { CUTLINE_UPDATE_URL: url } });
  await page.locator('#home').waitFor();
  return { app, page };
}

test('a newer release shows a notice, Download opens its page, and Later hides it for good', TIMEOUT, async () => {
  const dir = H.tempDir();
  const stub = await githubStub({ tag: 'talkcut-1.0.4' });
  let { app, page } = await openHome(dir, stub.url);
  try {
    const notice = page.locator('#update-notice');
    await notice.waitFor();
    const text = await page.locator('#update-text').textContent();
    assert.match(text, /Talkcut 1\.0\.4 is available \(you have 1\.0\.3\)/);

    // Download goes to the release page (opening a browser is stubbed out).
    await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; });
    await page.click('#update-get');
    await H.until(() => app.evaluate(() => globalThis.__opened.length === 1), 'the page to open');
    assert.deepEqual(await app.evaluate(() => globalThis.__opened), [LINK('1.0.4')]);

    await page.click('#update-later');
    assert.equal(await notice.isHidden(), true);
    await H.closeApp(app);

    // The same release stays quiet on the next launch, and no new request was needed (once a day).
    ({ app, page } = await openHome(dir, stub.url));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await page.locator('#update-notice').isHidden(), true);
    assert.equal(stub.hits.length, 1);
    await H.closeApp(app);
  } finally {
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing is shown when this is the latest version, or when GitHub cannot be reached', TIMEOUT, async () => {
  for (const release of [{ tag: 'talkcut-1.0.3' }, { tag: 'talkcut-1.0.2' }, { tag: 'talkcut-1.0.4', status: 403 }, { tag: 'talkcut-1.0.4', url: 'https://evil.example/download' }]) {
    const dir = H.tempDir();
    const stub = await githubStub(release);
    const { app, page } = await openHome(dir, stub.url);
    try {
      await H.until(() => stub.hits.length === 1, 'the check');
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(await page.locator('#update-notice').isHidden(), true, JSON.stringify(release));
      assert.equal(await page.locator('#toast').isHidden(), true, 'no error is shown');
    } finally {
      await H.closeApp(app);
      await stub.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Nothing listening at all: the connection is refused.
  const dir = H.tempDir();
  const { app, page } = await openHome(dir, 'http://127.0.0.1:9/latest');
  try {
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await page.locator('#update-notice').isHidden(), true);
    assert.equal(await page.locator('#toast').isHidden(), true);
    // The editor still opens its projects as usual.
    assert.equal(await page.locator('#home-new').isEnabled(), true);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('automated runs do not contact GitHub unless pointed at a test server', TIMEOUT, async () => {
  const dir = H.tempDir();
  const { app, page } = await H.launch(dir);
  try {
    await page.locator('#home').waitFor();
    assert.equal(await page.evaluate(() => window.cutline.checkUpdate()), null);
  } finally {
    await H.closeApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
