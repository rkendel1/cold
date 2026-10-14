// Desktop (the real local server and page) and the real extension in Chromium, signing in against a real authority server and a STAND-IN for Google. They prove the client
// flows, that local data is untouched by signing in and out, and that no token reaches a page. They are not evidence about real Google or a packaged app.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const env = require('./helpers/env');
const { startGoogle } = require('./helpers/google-mock');
const SKIP = env.browserAvailable() ? false : 'Chromium or playwright-core is not available';
const SECRET = 'surfaces-test-session-secret-0123456789abcdef';
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const CLEAN = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN', 'COLD_DB_FILE', 'COLD_SETTINGS_FILE', 'COLD_ACCOUNT_URL'];

/** The account authority: this repository's server in this process, with sign-in configured for the given native redirects. */
async function authority(google, redirects, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-authority-'));
  for (const k of CLEAN) delete process.env[k];
  Object.assign(process.env, { LLM_PROVIDER: 'ollama', COLD_AUTH_GOOGLE_CLIENT_ID: google.clientId, COLD_AUTH_GOOGLE_CLIENT_SECRET: google.clientSecret, COLD_SESSION_SECRET: SECRET, COLD_AUTH_RATE_LIMIT_PER_MIN: '5000',
    COLD_ACCOUNTS_DB_FILE: path.join(dir, 'accounts.db'), COLD_AUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/account/callback`, COLD_AUTH_NATIVE_REDIRECTS: redirects.join(','), ...google.urls });
  delete require.cache[require.resolve('../server')]; delete require.cache[require.resolve('../lib/auth')];
  const server = require('../server'); await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${port}`, accounts: server.auth.accounts, dir, stop: () => new Promise(r => { server.closeAllConnections(); server.close(() => { try { server.auth.close(); } catch { /* closed */ } r(); }); }) };
}

let browser, mock, google;
before(async () => { if (SKIP) return; mock = await env.startMock(); google = await startGoogle(); browser = await env.launch(); });
after(async () => { if (SKIP) return; await browser.close(); await google.close(); mock.server.close(); });

const LEAD = { id: 'l1', name: 'Lead One', company: 'Acme', email: 'l1@acme.io', list: 'Q4', createdAt: 5 };
const EMAIL = { createdAt: 1000, status: 'sent', sentAt: 2222, mode: 'email', recipient: { name: 'Sam', company: 'Co' }, subject: 's', what: 'w', why: 'y', ask: 'a', note: 'call Tue', followUp: { due: 99999, count: 1 } };

test('desktop: sign in through the system browser, see the account, sign out; local data, settings and the database are untouched; local use works without the account service', { skip: SKIP, timeout: 120000 }, async () => {
  const dport = await freePort(), aport = await freePort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-desk-acct-'));
  google.person = { sub: 'desk-1', name: 'Desk User', email: 'desk@example.com', email_verified: true }; google.mutate = null; google.deny = false;
  let auth = await authority(google, [`http://127.0.0.1:${dport}/oauth/account/callback`], aport);
  const settingsFile = path.join(dir, 's.json'); fs.writeFileSync(settingsFile, JSON.stringify({ provider: 'anthropic', followUp: { hour: 11 } }));
  const desk = await env.startColdServer({ mockUrl: mock.url, port: dport, env: { COLD_DB_FILE: path.join(dir, 'cold.db'), COLD_SETTINGS_FILE: settingsFile, COLD_ACCOUNT_URL: auth.base } });
  const api = (p, init) => fetch(`${desk.base}/api/data${p}`, init);
  const snap = async () => (await api('')).json();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true }); const page = await context.newPage(); const errors = [], bodies = [];
  page.on('pageerror', e => errors.push(String(e))); page.on('response', async r => { try { if (r.url().startsWith(desk.base)) bodies.push(await r.text()); } catch { /* not readable */ } });
  try {
    await api('/leads/l1', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(LEAD) }); await api('/emails/e1', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(EMAIL) });
    await api('/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature: 'Randy' }) });
    await page.goto(desk.base + '/'); await page.waitForSelector('#genBtn', { state: 'attached' }); await page.click('#nav-settings'); await page.waitForSelector('#accountSection');
    const before = await snap(), settingsBefore = fs.readFileSync(settingsFile, 'utf8');   // after the page's first load (which marks the database as set up, as it always has)
    await page.waitForSelector('#signInBtn'); assert.match(await page.textContent('#accountLocal'), /stay in this app's database/);
    // the system browser: window.open goes to the person's own browser; here the popup stands in for it
    const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#signInBtn')]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForSelector('#accountWho', { timeout: 30000 }); assert.match(await page.textContent('#accountWho'), /Signed in as Desk User \(desk@example\.com\)/);
    assert.match(await popup.content().catch(() => ''), /Signed in to Cold/);
    await popup.close();
    // nothing local changed
    assert.deepEqual(await snap(), before, 'sign-in did not touch the library'); assert.equal(fs.readFileSync(settingsFile, 'utf8'), settingsBefore, 'settings.json is byte-for-byte unchanged');
    assert.equal(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }])), '[{},{}]', 'nothing in page storage');
    assert.ok(!bodies.some(b => /"token"|session|Bearer/i.test(b) && /"signedIn"|authUrl/.test(b) && /"token"/.test(b)), 'no response to the page carried a token');
    const meBody = await (await fetch(`${desk.base}/api/account/me`)).json(); assert.deepEqual(Object.keys(meBody), ['signedIn', 'account']);
    // other pages and the extension can't use the desktop account routes
    assert.equal((await fetch(`${desk.base}/api/account/me`, { headers: { authorization: 'Bearer x'.padEnd(30, 'x') } })).status, 403);
    assert.equal((await fetch(`${desk.base}/api/account/login`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    // the session is revoked at the service: noticed on return to the window, local data fine
    const raw = new (require('node:sqlite').DatabaseSync)(path.join(auth.dir, 'accounts.db')); raw.exec('DELETE FROM sessions'); raw.close();
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForSelector('#signInBtn'); assert.match(await page.textContent('#accountMessage'), /session ended/); assert.deepEqual(await snap(), before);
    // sign in again, then the account service goes away: local use is unaffected and says so
    const [p2] = await Promise.all([context.waitForEvent('page'), page.click('#signInBtn')]); await page.waitForSelector('#accountWho', { timeout: 30000 }); await p2.close();
    await page.click('#signOutBtn'); await page.waitForSelector('#signInBtn'); assert.match(await page.textContent('#accountMessage'), /signed out.*local data is unchanged/); assert.equal(auth.accounts.counts().sessions, 0, 'ended at the service too'); assert.deepEqual(await snap(), before, 'sign-out left local data as it was');
    const [p2b] = await Promise.all([context.waitForEvent('page'), page.click('#signInBtn')]); await page.waitForSelector('#accountWho', { timeout: 30000 }); await p2b.close();
    await auth.stop();
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForSelector('#accountMessage:has-text("Couldn\'t reach the Cold account service")');
    await page.click('#nav-leads'); await page.waitForSelector('#view-leads', { state: 'visible' });
    assert.equal((await api('/products/p9', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Made offline', what: 'x' }) })).status, 200, 'saving still works');
    assert.equal((await fetch(`${desk.base}/api/account/login`, { method: 'POST' })).status, 503);
    // a callback that this app didn't start (wrong state) signs nobody in
    auth = await authority(google, [`http://127.0.0.1:${dport}/oauth/account/callback`], aport);
    const forged = await fetch(`${desk.base}/oauth/account/callback?code=stolen&state=forged`); assert.equal(forged.status, 400); assert.match(await forged.text(), /didn.t start here|expired/);
    assert.equal((await fetch(`${desk.base}/api/account/me`)).status, 401); assert.equal(auth.accounts.counts().sessions, 0);
    assert.deepEqual(errors, []);
    const afterSnap = await snap(); assert.deepEqual({ ...afterSnap, products: [] , version: 0 }, { ...before, products: [], version: 0 }, 'leads, drafts, follow-ups and settings are as they were'); 
  } finally { await context.close(); desk.stop(); await auth.stop(); google.mutate = null; }
});

test('desktop: without COLD_ACCOUNT_URL there is no account section and nothing else changes', { skip: SKIP, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-desk-none-'));
  const desk = await env.startColdServer({ mockUrl: mock.url, env: { COLD_DB_FILE: path.join(dir, 'cold.db'), COLD_SETTINGS_FILE: path.join(dir, 's.json') } });
  const context = await browser.newContext({ bypassCSP: true }); const page = await context.newPage();
  try {
    assert.deepEqual((await (await fetch(`${desk.base}/api/config`)).json()).account, { enabled: false });
    await page.goto(desk.base + '/'); await page.waitForSelector('#genBtn', { state: 'attached' }); await page.click('#nav-settings'); await page.waitForSelector('#exportBtn2');
    assert.equal(await page.locator('#accountSection').count(), 0); assert.equal((await fetch(`${desk.base}/api/account/me`)).status, 404);
  } finally { await context.close(); desk.stop(); }
});

test('extension: sign in through the browser auth window, see the account in the panel, sign out; local storage is untouched; the token stays in session memory', { skip: SKIP, timeout: 180000 }, async () => {
  const pw = require('playwright-core'), aport = await freePort();
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-ext-acct-')); fs.cpSync(path.join(__dirname, '../extension'), copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'dist/account.json'), JSON.stringify({ url: `http://127.0.0.1:${aport}` }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-ext-acct-profile-'));
  const ctx = await pw.chromium.launchPersistentContext(path.join(dir, 'profile'), { executablePath: process.env.CHROMIUM || undefined, headless: false, args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`, '--headless=new'] }).catch(async () => pw.chromium.launchPersistentContext(path.join(dir, 'profile'), { executablePath: require('./helpers/env').findChromiumForTests?.(), headless: false, args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`, '--headless=new'] }));
  let auth;
  try {
    let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = new URL(sw.url()).host; const redirect = `https://${id}.chromiumapp.org/`;
    auth = await authority(google, [redirect], aport);
    google.person = { sub: 'ext-1', name: 'Ext User', email: 'ext@example.com', email_verified: true }; google.mutate = null; google.deny = false;
    // Chrome's auth window can't be driven headless: stand in for launchWebAuthFlow by asking the stand-in Google for where it would redirect
    const patch = () => sw.evaluate(() => { chrome.identity.launchWebAuthFlow = async ({ url }) => { const r = await fetch(url + '&_mock=json'); return (await r.json()).location; }; });
    await patch();
    const panel = await ctx.newPage(); const errors = []; panel.on('pageerror', e => errors.push(String(e)));
    await panel.goto(`chrome-extension://${id}/panel.html`); await panel.waitForSelector('#genBtn', { state: 'attached' });
    const lib = { products: { p1: { id: 'p1', name: 'Ext Co', what: 'x' } }, emails: { e1: { id: 'e1', createdAt: 5, status: 'sent', sentAt: 77, note: 'EXT-NOTE', recipient: { name: 'Own Person', company: 'OwnCo' }, subject: 's', what: 'w', why: 'y', ask: 'a?', followUp: { due: 9, count: 1 } } }, leads: { l1: { id: 'l1', name: 'Ext Lead', company: 'Acme', email: 'l@acme.io', list: 'Q4', createdAt: 1 } }, outbox: [], lastSync: 0 };
    await panel.evaluate(async lib => { await chrome.storage.local.set({ 'cold.replica': lib }); }, lib); await panel.reload(); await panel.waitForSelector('#genBtn', { state: 'attached' });
    const local = () => panel.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    const before = await local();
    await panel.click('#nav-settings'); await panel.evaluate(() => document.querySelectorAll('details.set-group').forEach(d => { d.open = true; })); await panel.waitForSelector('#accountSection');
    await panel.waitForSelector('#signInBtn'); assert.match(await panel.textContent('#accountLocal'), /stay in this extension's storage/);
    await panel.click('#signInBtn'); await panel.waitForSelector('#accountWho', { timeout: 30000 });
    assert.match(await panel.textContent('#accountWho'), /Signed in as Ext User \(ext@example\.com\)/);
    assert.equal(await local(), before, 'chrome.storage.local is byte-for-byte unchanged by signing in');
    const session = await panel.evaluate(async () => JSON.stringify(await chrome.storage.session.get(null)));
    assert.match(session, /cold\.account\.session/); assert.ok(!(await local()).includes('"token"'));
    assert.equal(auth.accounts.counts().accounts, 1); assert.equal(auth.accounts.counts().sessions, 1);
    // the panel, as the page sees it, never holds the token
    const token = JSON.parse(session)['cold.account.session'].token;
    assert.ok(!(await panel.content()).includes(token)); assert.ok(!(await local()).includes(token));
    // revoked at the service, noticed when the window regains focus
    const raw = new (require('node:sqlite').DatabaseSync)(path.join(auth.dir, 'accounts.db')); raw.exec('DELETE FROM sessions'); raw.close();
    await panel.evaluate(() => window.dispatchEvent(new Event('focus'))); await panel.waitForSelector('#signInBtn'); assert.match(await panel.textContent('#accountMessage'), /session ended/);
    assert.equal(await local(), before, 'still unchanged');
    // a bad ID token never signs in
    google.mutate = c => ({ ...c, nonce: 'wrong' }); await panel.click('#signInBtn'); await panel.waitForSelector('#accountMessage:has-text("didn\'t complete")'); assert.equal(await panel.locator('#accountWho').count(), 0); google.mutate = null;
    assert.equal(auth.accounts.counts().sessions, 0);
    // sign in, sign out
    await panel.click('#signInBtn'); await panel.waitForSelector('#accountWho', { timeout: 30000 }); await panel.click('#signOutBtn'); await panel.waitForSelector('#signInBtn');
    assert.match(await panel.textContent('#accountMessage'), /signed out/); assert.equal(auth.accounts.counts().sessions, 0, 'ended at the service too');
    assert.equal(await panel.evaluate(async () => JSON.stringify(await chrome.storage.session.get(null))), '{}'); assert.equal(await local(), before, 'sign-out left local data as it was');
    // the account service goes away: local use still works
    await panel.click('#signInBtn'); await panel.waitForSelector('#accountWho', { timeout: 30000 }); await auth.stop();
    await panel.evaluate(() => window.dispatchEvent(new Event('focus'))); await panel.waitForSelector('#accountMessage:has-text("Couldn\'t reach the Cold account service")');
    await panel.click('#nav-leads'); await panel.waitForSelector('#view-leads', { state: 'visible' });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); if (auth) await auth.stop(); }
});
