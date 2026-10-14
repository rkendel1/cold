// One hosted library, used from the web app, the desktop app and the extension in turn: real server (this repository's, as the account authority), the real desktop local server
// and page, the real extension in Chromium, a mock model, and a STAND-IN for Google (so this proves Cold's own logic, not real Google sign-in, a packaged app or the Chrome Web Store).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const env = require('./helpers/env');
const { startGoogle } = require('./helpers/google-mock');
const SKIP = env.browserAvailable() ? false : 'Chromium or playwright-core is not available';
const SECRET = 'hosted-e2e-session-secret-0123456789abcdef';
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const CLEAN = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN', 'COLD_DB_FILE', 'COLD_SETTINGS_FILE', 'COLD_ACCOUNT_URL', 'COLD_DATA_DB_FILE'];

/** The account authority and hosted-library server: this repository's server in this process. Can be stopped and started again on the same port and files. */
async function authority(google, mock, { redirects, port, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-hosted-e2e-')) }) {
  for (const k of CLEAN) delete process.env[k];
  Object.assign(process.env, { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'mock-key', ANTHROPIC_BASE_URL: mock.url, COLD_RATE_LIMIT_PER_MIN: '100000', COLD_AUTH_GOOGLE_CLIENT_ID: google.clientId, COLD_AUTH_GOOGLE_CLIENT_SECRET: google.clientSecret, COLD_SESSION_SECRET: SECRET, COLD_AUTH_RATE_LIMIT_PER_MIN: '5000',
    COLD_ACCOUNTS_DB_FILE: path.join(dir, 'accounts.db'), COLD_DATA_DB_FILE: path.join(dir, 'hosted.db'), COLD_AUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/account/callback`, COLD_AUTH_NATIVE_REDIRECTS: redirects.join(','), ...google.urls });
  delete require.cache[require.resolve('../server')]; delete require.cache[require.resolve('../lib/auth')];
  const server = require('../server'); await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${port}`, dir, accounts: server.auth.accounts, hosted: server.hosted.store,
    snap: () => { const id = server.auth.accounts.sessionAccount; void id; const d = new (require('node:sqlite').DatabaseSync)(path.join(dir, 'hosted.db'), { readOnly: true }); const acc = d.prepare('SELECT account_id FROM libraries').all().map(r => r.account_id); d.close(); return acc.length === 1 ? server.hosted.store.snapshot(acc[0]) : null; },
    stop: () => new Promise(r => { if (!server.listening) return r(); server.closeAllConnections(); server.close(() => { try { server.auth.close(); server.hosted.close(); } catch { /* closed */ } r(); }); }) };
}

let browser, mock, google;
before(async () => { if (SKIP) return; mock = await env.startMock(); google = await startGoogle(); browser = await env.launch(); });
after(async () => { if (SKIP) return; await browser.close(); await google.close(); mock.server.close(); });

const LOCAL = { 'cold.products': [{ id: 'lp1', name: 'Local product', what: 'only on this device' }], 'cold.leads': [{ id: 'll1', name: 'Local Lead', company: 'LocalCo', email: 'l@local.io', list: 'Local', createdAt: 5 }],
  'cold.emails': [{ id: 'le1', createdAt: 1000, status: 'draft', mode: 'email', recipient: { name: 'Local Person', company: 'LocalCo' }, subject: 'local', what: 'w', why: 'y', ask: 'a', note: 'LOCAL-NOTE' }], 'cold.settings': { signature: 'Local sig' } };
const confirm = page => page.click('dialog[open] button[value=ok]');
const badge = page => page.textContent('#libraryBadge');
const settings = async page => { await page.click('#nav-settings'); await page.evaluate(() => document.querySelectorAll('details.set-group, details.x-discover').forEach(d => { d.open = true; })); await page.waitForSelector('#accountSection'); };

test('one hosted library across web, desktop and extension: created on the web, read and updated from the desktop app and the extension; local libraries never change', { skip: SKIP, timeout: 360000 }, async () => {
  const aport = await freePort(), dport = await freePort();
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-ext-hosted-')); fs.cpSync(path.join(__dirname, '../extension'), copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'dist/account.json'), JSON.stringify({ url: `http://127.0.0.1:${aport}` }));
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-ext-hosted-profile-'));
  const pw = require('playwright-core');
  const ctxExt = await pw.chromium.launchPersistentContext(path.join(pdir, 'profile'), { executablePath: env.chromiumPath ? env.chromiumPath() : process.env.CHROMIUM || undefined, headless: false, args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`, '--headless=new'] });
  let [sw] = ctxExt.serviceWorkers(); if (!sw) sw = await ctxExt.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  google.person = { sub: 'cross-1', name: 'Cross User', email: 'cross@example.com', email_verified: true }; google.mutate = null; google.deny = false;
  let auth = await authority(google, mock, { redirects: [`https://${extId}.chromiumapp.org/`, `http://127.0.0.1:${dport}/oauth/account/callback`], port: aport });
  const ddir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-desk-hosted-'));
  fs.writeFileSync(path.join(ddir, 's.json'), JSON.stringify({ provider: 'anthropic', followUp: { hour: 11 } }));
  const desk = await env.startColdServer({ mockUrl: mock.url, port: dport, env: { COLD_DB_FILE: path.join(ddir, 'cold.db'), COLD_SETTINGS_FILE: path.join(ddir, 's.json'), COLD_ACCOUNT_URL: auth.base,
    COLD_DATA_DB_FILE: '', COLD_AUTH_GOOGLE_CLIENT_ID: '', COLD_AUTH_GOOGLE_CLIENT_SECRET: '', COLD_SESSION_SECRET: '', COLD_ACCOUNTS_DB_FILE: '', COLD_AUTH_REDIRECT_URI: '', COLD_AUTH_NATIVE_REDIRECTS: '' } });   // a desktop app has none of the server's settings
  const ctxWeb = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const web = await ctxWeb.newPage(), webErrors = [];
  web.on('pageerror', e => webErrors.push(String(e)));
  try {
    // ================= WEB: local library seeded; sign in; nothing changes; create the hosted library; work in it =================
    await web.addInitScript(s => { if (!sessionStorage.getItem('__s')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); sessionStorage.setItem('__s', '1'); } }, LOCAL);
    await web.goto(auth.base + '/'); await web.waitForSelector('#genBtn', { state: 'attached' });
    const localKeys = () => web.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('cold.') && k !== 'cold.library.choice').sort().map(k => [k, localStorage.getItem(k)])));
    const webLocal0 = await localKeys();
    await settings(web); await web.click('#signInBtn'); await web.waitForSelector('#accountWho', { timeout: 30000 });
    assert.match(await web.textContent('#hostedLocalActive'), /Local library is open/); assert.equal(await badge(web), 'Local library', 'signing in did not switch libraries');
    assert.deepEqual(await localKeys(), webLocal0, 'signing in changed no local record or setting');
    assert.equal(auth.snap(), null, 'and uploaded nothing');
    await web.waitForSelector('#hostedCreate'); assert.match(await web.textContent('#hostedSection'), /Nothing from this device is uploaded, copied or merged/);
    await web.click('#hostedCreate'); assert.match(await web.textContent('dialog[open]'), /Nothing on this device is uploaded/); await confirm(web);
    await web.waitForSelector('#hostedActive'); assert.equal(await badge(web), 'Hosted library'); assert.match(await web.textContent('#dataLine'), /hosted/i);
    await web.click('#nav-leads'); await web.waitForSelector('#addLeadBtn'); assert.equal(await web.locator('text=Local Lead').count(), 0, 'the local leads are not shown, merged or mixed in');
    await web.click('#addLeadBtn'); await web.fill('#lf-name', 'Hosted Lead'); await web.fill('#lf-company', 'HostedCo'); await web.fill('#lf-email', 'h@hosted.io'); await web.click('#saveLead'); await web.waitForSelector('text=Lead added');
    await web.click('#nav-compose'); await web.fill('#rName', 'Sam Ortiz'); await web.fill('#rCompany', 'TrialCo'); await web.fill('#rWhy', 'Wrote that trial users stall before inviting a teammate');
    await web.fill('#pName', 'Acme Flow'); await web.fill('#pWhat', 'Acme Flow turns a signup into a first booked job for plumbers in a day.');
    await web.click('#genBtn'); await web.waitForSelector('#eSubject'); await web.click('#copyEmail');
    await web.waitForFunction(() => /Copied|copied/.test(document.body.textContent));
    const s1 = await (async () => { for (let i = 0; i < 40; i++) { const s = auth.snap(); if (s && s.emails.length && s.leads.length && s.emails[0].handoffs && s.emails[0].handoffs.length) return s; await web.waitForTimeout(150); } return auth.snap(); })();
    assert.deepEqual([s1.leads.map(l => l.name), s1.products.map(p => p.name), s1.emails.length], [['Hosted Lead'], ['Acme Flow'], 1], 'the hosted library holds what was created in it');
    assert.equal(s1.emails[0].recipient.name, 'Sam Ortiz'); assert.equal(s1.emails[0].handoffs[0].how, 'copy'); assert.ok(s1.emails[0].followUp && s1.emails[0].followUp.due, 'the follow-up was scheduled');
    assert.deepEqual(await localKeys(), webLocal0, 'creating and editing hosted records changed no local record or setting');
    const draftId = s1.emails[0].id;
    // ================= DESKTOP: sign in, open the same library, see the web's records, mark sent =================
    const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true }), dpage = await dctx.newPage(), derrors = []; dpage.on('pageerror', e => derrors.push(String(e)));
    const dapi = p => fetch(`${desk.base}/api/data${p}`).then(r => r.json());
    const put = (p, body) => fetch(`${desk.base}/api/data${p}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await put('/leads/dl1', { name: 'Desktop Local Lead', company: 'DeskCo', email: 'd@desk.io', list: 'D', createdAt: 5 });
    await put('/emails/de1', { createdAt: 1000, status: 'draft', mode: 'email', recipient: { name: 'Desk Person', company: 'DeskCo' }, subject: 'desk', what: 'w', why: 'y', ask: 'a', note: 'DESKTOP-LOCAL-NOTE' });
    await dpage.goto(desk.base + '/'); await dpage.waitForSelector('#genBtn', { state: 'attached' }); await settings(dpage);
    const desk0 = JSON.stringify(await dapi('')), deskSettings0 = fs.readFileSync(path.join(ddir, 's.json'), 'utf8');
    const [popup] = await Promise.all([dctx.waitForEvent('page'), dpage.click('#signInBtn')]); await dpage.waitForSelector('#accountWho', { timeout: 30000 }); await popup.close();
    assert.equal(await badge(dpage), 'Local library'); assert.equal(JSON.stringify(await dapi('')), desk0, 'desktop sign-in changed nothing locally');
    await dpage.waitForSelector('#hostedOpen'); assert.match(await dpage.textContent('#hostedSummary'), /1 lead, 1 draft, 1 product/);
    await dpage.click('#hostedOpen'); await confirm(dpage); await dpage.waitForSelector('#hostedActive'); assert.equal(await badge(dpage), 'Hosted library');
    await dpage.click('#nav-history'); await dpage.waitForSelector('.hrow', { timeout: 20000 }); assert.match(await dpage.textContent('#view-history'), /Sam Ortiz/); assert.equal(await dpage.locator('text=Desk Person').count(), 0, 'the desktop\'s local drafts are not mixed in');
    await dpage.click('#nav-leads'); await dpage.waitForSelector('text=Hosted Lead'); assert.equal(await dpage.locator('text=Desktop Local Lead').count(), 0);
    await dpage.click('#nav-history'); await dpage.locator('.hrow', { hasText: 'Sam Ortiz' }).locator('.hMarkSent').click();
    const s2 = await (async () => { for (let i = 0; i < 40; i++) { const s = auth.snap(); if (s.emails[0].status === 'sent') return s; await dpage.waitForTimeout(150); } return auth.snap(); })();
    assert.equal(s2.emails[0].status, 'sent', 'a desktop edit reached the hosted library'); assert.equal(s2.emails[0].id, draftId); assert.equal(s2.emails[0].recipient.name, 'Sam Ortiz'); assert.equal(s2.emails[0].handoffs[0].how, 'copy', 'earlier fields are preserved');
    assert.equal(JSON.stringify(await dapi('')), desk0, 'working in the hosted library left the desktop database untouched'); assert.equal(fs.readFileSync(path.join(ddir, 's.json'), 'utf8'), deskSettings0, 'and settings.json');
    // ================= EXTENSION: sign in, open the same library, see the desktop's change, record the reply =================
    const sw2 = sw; await sw2.evaluate(() => { chrome.identity.launchWebAuthFlow = async ({ url }) => { const r = await fetch(url + '&_mock=json'); return (await r.json()).location; }; });
    const panel = await ctxExt.newPage(), perrors = []; panel.on('pageerror', e => perrors.push(String(e)));
    await panel.goto(`chrome-extension://${extId}/panel.html`); await panel.waitForSelector('#genBtn', { state: 'attached' });
    await panel.evaluate(async () => { await chrome.storage.local.set({ 'cold.replica': { products: { xp: { id: 'xp', name: 'Ext local product', what: 'x' } }, emails: { xe: { id: 'xe', createdAt: 5, status: 'draft', recipient: { name: 'Ext Local Person' }, subject: 's', what: 'w', why: 'y', ask: 'a', note: 'EXT-LOCAL-NOTE' } }, leads: { xl: { id: 'xl', name: 'Ext Local Lead', company: 'X', createdAt: 1 } }, outbox: [], lastSync: 0 } }); });
    await panel.reload(); await panel.waitForSelector('#genBtn', { state: 'attached' });
    const extLocal = () => panel.evaluate(async () => { const all = await chrome.storage.local.get(null); delete all['cold.library.choice']; return JSON.stringify(all); });
    const ext0 = await extLocal(); await settings(panel); await panel.click('#signInBtn'); await panel.waitForSelector('#accountWho', { timeout: 30000 });
    assert.equal(await badge(panel), 'Local library'); assert.equal(await extLocal(), ext0, 'extension sign-in changed no local storage');
    await panel.waitForSelector('#hostedOpen'); await panel.click('#hostedOpen'); await confirm(panel); await panel.waitForSelector('#hostedActive'); assert.equal(await badge(panel), 'Hosted library');
    await panel.click('#nav-history'); await panel.waitForSelector('.hrow', { timeout: 20000 }); const row = panel.locator('.hrow', { hasText: 'Sam Ortiz' }); assert.equal(await panel.locator('text=Ext Local Person').count(), 0);
    await row.locator('.hRecordReply').waitFor({ timeout: 20000 });                      // it says "sent": the desktop's edit is visible here
    await row.locator('.hRecordReply').click();
    const s3 = await (async () => { for (let i = 0; i < 40; i++) { const s = auth.snap(); if (s.emails[0].status === 'replied') return s; await panel.waitForTimeout(150); } return auth.snap(); })();
    assert.equal(s3.emails[0].status, 'replied', 'an extension edit reached the hosted library'); assert.equal(s3.emails[0].id, draftId); assert.ok(s3.emails[0].repliedAt);
    assert.equal(await extLocal(), ext0, 'working in the hosted library changed no local extension storage');
    const session = await panel.evaluate(async () => JSON.stringify(await chrome.storage.session.get(null))); const token = JSON.parse(session)['cold.account.session'].token;
    assert.ok(!(await panel.content()).includes(token) && !(await extLocal()).includes(token), 'the token is not in the panel or in local storage');
    // ================= back to the web: the extension's reply is there; the hosted data persisted =================
    await web.reload(); await web.waitForSelector('#genBtn', { state: 'attached' });
    assert.equal(await badge(web), 'Hosted library', 'the web app remembers the choice made on this device');
    await web.click('#nav-history'); await web.waitForSelector('.hrow .hRecordReply, .hrow'); await web.waitForFunction(() => /replied|Replied/.test(document.querySelector('#view-history').textContent), null, { timeout: 20000 });
    // the server restarts: nothing is lost, nobody is signed out, every surface still sees the same record
    await auth.stop(); auth = await authority(google, mock, { redirects: [`https://${extId}.chromiumapp.org/`, `http://127.0.0.1:${dport}/oauth/account/callback`], port: aport, dir: auth.dir });
    assert.equal(auth.snap().emails[0].status, 'replied'); assert.equal(auth.snap().emails.length, 1);
    await web.reload(); await web.waitForSelector('#genBtn', { state: 'attached' }); await web.click('#nav-history'); await web.waitForFunction(() => /replied|Replied/.test(document.querySelector('#view-history').textContent), null, { timeout: 20000 });
    // ================= failure: the hosted service goes away =================
    await auth.stop();
    await dpage.click('#nav-leads'); await dpage.click('#addLeadBtn'); await dpage.fill('#lf-name', 'Offline Lead'); await dpage.click('#saveLead');
    await dpage.waitForSelector('text=/Couldn.t save/'); assert.equal((await dapi('/leads')).leads, undefined);
    assert.ok(!(await dapi('')).leads.some(l => l.name === 'Offline Lead'), 'a failed hosted write is not redirected to the local database'); assert.equal(JSON.stringify((await dapi('')).leads), JSON.stringify(JSON.parse(desk0).leads));
    await dpage.reload(); await dpage.waitForSelector('#genBtn', { state: 'attached' });
    assert.equal(await badge(dpage), 'Hosted library: unavailable', 'the choice is kept and the failure is shown; it does not quietly become the local library');
    await dpage.click('#nav-leads'); assert.equal(await dpage.locator('text=Desktop Local Lead').count(), 0); assert.equal(await dpage.locator('text=Hosted Lead').count(), 0);
    await settings(dpage); await dpage.waitForSelector('#hostedUnavailable'); await dpage.click('#useLocalBtn'); await confirm(dpage); await dpage.waitForSelector('#hostedLocalActive');
    assert.equal(await badge(dpage), 'Local library'); await dpage.click('#nav-leads'); await dpage.waitForSelector('text=Desktop Local Lead'); assert.equal(JSON.stringify(await dapi('')), desk0, 'the desktop library is exactly as it was');
    // the service returns: the same hosted data is there, and signing out later deletes nothing
    auth = await authority(google, mock, { redirects: [`https://${extId}.chromiumapp.org/`, `http://127.0.0.1:${dport}/oauth/account/callback`], port: aport, dir: auth.dir });
    await settings(panel); await panel.click('#signOutBtn'); await panel.waitForSelector('#signInBtn');
    assert.equal(await badge(panel), 'Local library', 'signing out while the hosted library was open returns to the local library'); assert.equal(await extLocal(), ext0, 'extension local data is exactly as it was');
    assert.equal(auth.snap().emails.length, 1, 'signing out deleted no hosted record'); assert.equal(auth.snap().emails[0].status, 'replied');
    await panel.reload(); await panel.waitForSelector('#genBtn', { state: 'attached' }); assert.equal(await badge(panel), 'Local library');
    assert.deepEqual([webErrors, derrors, perrors], [[], [], []]);
    await dctx.close();
  } finally { await ctxWeb.close(); await ctxExt.close(); desk.stop(); await auth.stop(); }
});
