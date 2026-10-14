// The sign-in UI in a real browser against the real server and a STAND-IN for Google (not evidence about real Google).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const env = require('./helpers/env');
const { startGoogle } = require('./helpers/google-mock');
const SKIP = env.browserAvailable() ? false : 'Chromium or playwright-core is not available';
const AXE = path.join(__dirname, '../node_modules/axe-core/axe.min.js');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

let browser, mock, google, srv, off;
before(async () => {
  if (SKIP) return;
  mock = await env.startMock(); google = await startGoogle();
  const port = await freePort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-auth-e2e-'));
  srv = await env.startColdServer({ mockUrl: mock.url, port, env: { COLD_AUTH_GOOGLE_CLIENT_ID: google.clientId, COLD_AUTH_GOOGLE_CLIENT_SECRET: google.clientSecret, COLD_SESSION_SECRET: 'e2e-session-secret-0123456789abcdef-0123', COLD_ACCOUNTS_DB_FILE: path.join(dir, 'a.db'), COLD_AUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/account/callback`, ...google.urls } });
  off = await env.startColdServer({ mockUrl: mock.url });
  browser = await env.launch();
});
after(async () => { if (SKIP) return; await browser.close(); srv.stop(); off.stop(); await google.close(); mock.server.close(); });

async function open(server) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true }); const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.base + '/'); await page.waitForSelector('#genBtn', { state: 'attached' });
  return { page, context, errors, close: () => context.close() };
}
const toSettings = async page => { await page.click('#nav-settings'); await page.waitForSelector('#accountSection'); };

test('web: signed out, sign in with Google, see the account, survive a reload, sign out; no token or session in browser storage', { skip: SKIP, timeout: 60000 }, async () => {
  google.person = { sub: 'e2e-1', name: 'Pat Example', email: 'pat@example.com', email_verified: true }; google.mutate = null; google.sigOpts = {}; google.deny = false;
  const t = await open(srv); const { page } = t;
  try {
    await page.evaluate(() => localStorage.setItem('cold.products', JSON.stringify([{ id: 'p1', name: 'Local product', what: 'x' }])));
    await page.reload(); await page.waitForSelector('#genBtn', { state: 'attached' }); await toSettings(page);
    await page.waitForSelector('#signInBtn'); assert.match(await page.textContent('#accountSection'), /not for Gmail or Google Sheets/); assert.match(await page.textContent('#accountLocal'), /don't need an account/);
    await page.click('#signInBtn'); await page.waitForSelector('#accountWho'); 
    assert.match(await page.textContent('#accountWho'), /Signed in as Pat Example \(pat@example\.com\)/);
    assert.match(page.url(), /#\/settings$/); assert.doesNotMatch(page.url(), /signin=/, 'the result is taken out of the address bar');
    assert.equal(await page.evaluate(() => document.cookie), '', 'the session cookie is HttpOnly');
    const stores = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    assert.doesNotMatch(stores, /GOOGLE-|id_token|cold_session|session|csrf|token/i);
    assert.ok(google.authRequests.at(-1).scope === 'openid email profile');
    await page.reload(); await page.waitForSelector('#genBtn', { state: 'attached' }); await toSettings(page); await page.waitForSelector('#accountWho');
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('cold.products')))[0].name, 'Local product', 'local data untouched by sign-in');
    await page.addScriptTag({ path: AXE }); const res = await page.evaluate(() => axe.run('#accountSection')); assert.deepEqual(res.violations.map(v => v.id), []);
    await page.click('#signOutBtn'); await page.waitForSelector('#signInBtn'); assert.match(await page.textContent('#accountMessage'), /signed out/);
    await page.reload(); await page.waitForSelector('#genBtn', { state: 'attached' }); await toSettings(page); await page.waitForSelector('#signInBtn');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('web: a failed or cancelled sign-in says so, leaves the person signed out, and Cold keeps working', { skip: SKIP, timeout: 60000 }, async () => {
  const t = await open(srv); const { page } = t;
  try {
    google.mutate = c => ({ ...c, nonce: 'wrong' }); await toSettings(page); await page.click('#signInBtn');
    await page.waitForSelector('#accountMessage'); assert.match(await page.textContent('#accountMessage'), /didn't complete, so you're not signed in/); await page.waitForSelector('#signInBtn');
    google.mutate = null; google.deny = true; await page.click('#signInBtn'); await page.waitForSelector('#accountMessage:has-text("chose not to")'); await page.waitForSelector('#signInBtn');
    google.deny = false; await page.click('#nav-compose'); await page.waitForSelector('#genBtn', { state: 'visible' });
  } finally { google.mutate = null; google.deny = false; await t.close(); }
});

test('web: a session that ends is reported clearly', { skip: SKIP, timeout: 60000 }, async () => {
  const t = await open(srv); const { page } = t;
  try {
    await toSettings(page); await page.click('#signInBtn'); await page.waitForSelector('#accountWho');
    await page.context().clearCookies(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForSelector('#signInBtn'); assert.match(await page.textContent('#accountMessage'), /session ended/);
    assert.equal(await page.isVisible('#accountWho'), false);
  } finally { await t.close(); }
});

test('a server without sign-in configured shows no account section and Settings still works', { skip: SKIP }, async () => {
  const t = await open(off); const { page } = t;
  try { await page.click('#nav-settings'); await page.waitForSelector('#exportBtn2'); assert.equal(await page.locator('#accountSection').count(), 0); assert.deepEqual(t.errors, []); } finally { await t.close(); }
});
