// Desktop and extension sign-in against the account authority (lib/auth.js) and the two client implementations, with a STAND-IN for Google
// (test/helpers/google-mock.js). They prove Cold's own validation, session and client logic; they are not evidence about real Google sign-in or a packaged app.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { startGoogle, client, makeKey } = require('./helpers/google-mock');
const SECRET = 'native-test-session-secret-0123456789abcdef-XYZ';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop', EXT_REDIRECT = `https://${EXT_ID}.chromiumapp.org/`, EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const DESKTOP = 'http://127.0.0.1:47999/oauth/account/callback';
const b64 = buf => Buffer.from(buf).toString('base64url');
const hashProof = p => b64(crypto.createHash('sha256').update(p).digest());
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const CLEAN = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN', 'COLD_DB_FILE', 'COLD_SETTINGS_FILE', 'COLD_ACCOUNT_URL', 'NODE_ENV', 'VERCEL_ENV'];

async function boot(google, { redirects = [EXT_REDIRECT, DESKTOP], extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-native-')), port = await freePort();
  for (const k of CLEAN) delete process.env[k];
  Object.assign(process.env, { LLM_PROVIDER: 'ollama', COLD_AUTH_GOOGLE_CLIENT_ID: google.clientId, COLD_AUTH_GOOGLE_CLIENT_SECRET: google.clientSecret, COLD_SESSION_SECRET: SECRET,
    COLD_ACCOUNTS_DB_FILE: path.join(dir, 'accounts.db'), COLD_AUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/account/callback`, COLD_AUTH_NATIVE_REDIRECTS: redirects.join(','), COLD_AUTH_RATE_LIMIT_PER_MIN: '5000', ...google.urls, ...extra });
  delete require.cache[require.resolve('../server')]; delete require.cache[require.resolve('../lib/auth')];
  const server = require('../server');
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${port}`, accounts: server.auth.accounts, dir, web: () => client(`http://127.0.0.1:${port}`),
    close: () => new Promise(r => { if (!server.listening) return r(); server.closeAllConnections(); server.close(() => { try { server.auth.close(); } catch { /* closed already */ } r(); }); }) };
}
const call = (base, p, { method = 'GET', headers = {}, body } = {}) => fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
/** begin -> the person signs in at (mock) Google -> the redirect carries code and state. Returns everything a client holds. */
async function nativeStart(t, g, { redirectUri = DESKTOP, kind = 'desktop', origin } = {}) {
  const proof = b64(crypto.randomBytes(32));
  const r = await call(t.base, '/api/account/native/begin', { method: 'POST', headers: origin ? { origin } : {}, body: { client: kind, redirectUri, proof: hashProof(proof) } });
  if (r.status !== 200) return { r, proof };
  const { authUrl, state } = await r.json();
  const toGoogle = await fetch(authUrl, { redirect: 'manual' }), back = new URL(toGoogle.headers.get('location'));
  return { r, proof, authUrl, state, back, code: back.searchParams.get('code'), backState: back.searchParams.get('state'), backError: back.searchParams.get('error') };
}
const complete = (t, body, origin) => call(t.base, '/api/account/native/complete', { method: 'POST', headers: origin ? { origin } : {}, body });
const me = (t, token, headers = {}) => call(t.base, '/api/account/me', { headers: { authorization: `Bearer ${token}`, ...headers } });

test('native config: only exact, recognised redirect addresses are accepted', () => {
  const { readConfig } = require('../lib/auth');
  const good = { COLD_AUTH_GOOGLE_CLIENT_ID: 'id', COLD_AUTH_GOOGLE_CLIENT_SECRET: 's', COLD_SESSION_SECRET: SECRET, COLD_ACCOUNTS_DB_FILE: '/data/a.db', COLD_AUTH_REDIRECT_URI: 'https://cold.example.com/oauth/account/callback', NODE_ENV: 'production' };
  assert.deepEqual(readConfig({ ...good, COLD_AUTH_NATIVE_REDIRECTS: `${EXT_REDIRECT}, ${DESKTOP}` }).nativeRedirects, [EXT_REDIRECT, DESKTOP]);
  assert.deepEqual(readConfig(good).nativeRedirects, []);
  for (const bad of ['https://evil.example/', 'https://short.chromiumapp.org/', `${EXT_REDIRECT}?x=1`, 'http://evil.example:1/oauth/account/callback', 'http://127.0.0.1:47999/other', 'http://127.0.0.1/oauth/account/callback', 'myapp://callback', `https://${EXT_ID}.chromiumapp.org/path`])
    assert.throws(() => readConfig({ ...good, COLD_AUTH_NATIVE_REDIRECTS: bad }), /NATIVE_REDIRECTS/, bad);
  assert.throws(() => readConfig({ ...good, COLD_NATIVE_SESSION_HOURS: '0' }), /NATIVE_SESSION_HOURS/);
});

test('begin: only registered redirects for the matching client; identity scopes; PKCE; no secret; CORS only for the registered extension', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const ok = await nativeStart(t, g); assert.equal(ok.r.status, 200);
    const q = new URL(ok.authUrl).searchParams;
    assert.equal(q.get('scope'), 'openid email profile'); assert.doesNotMatch(ok.authUrl, /gmail|spreadsheets|drive|offline|secret/i);
    assert.equal(q.get('code_challenge_method'), 'S256'); assert.equal(q.get('redirect_uri'), DESKTOP); assert.equal(q.get('client_id'), g.clientId);
    // refused
    const bad = async (body, headers) => (await call(t.base, '/api/account/native/begin', { method: 'POST', headers, body })).status;
    const p = hashProof('x'.repeat(32));
    assert.equal(await bad({ client: 'desktop', redirectUri: 'http://127.0.0.1:1234/oauth/account/callback', proof: p }), 400, 'unregistered port');
    assert.equal(await bad({ client: 'desktop', redirectUri: 'https://evil.example/', proof: p }), 400);
    assert.equal(await bad({ client: 'extension', redirectUri: DESKTOP, proof: p }), 400, 'client kind must match the redirect');
    assert.equal(await bad({ client: 'desktop', redirectUri: DESKTOP, proof: 'short' }), 400);
    assert.equal(await bad({ client: 'desktop', redirectUri: DESKTOP, proof: p }, { origin: 'https://evil.example' }), 403, 'a web page cannot drive it');
    assert.equal(await bad({ client: 'extension', redirectUri: EXT_REDIRECT, proof: p }, { origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }), 403, 'another extension');
    assert.equal(await bad({ client: 'extension', redirectUri: EXT_REDIRECT, proof: p }), 403, 'an extension must identify itself');
    const viaExt = await call(t.base, '/api/account/native/begin', { method: 'POST', headers: { origin: EXT_ORIGIN }, body: { client: 'extension', redirectUri: EXT_REDIRECT, proof: p } });
    assert.equal(viaExt.status, 200); assert.equal(viaExt.headers.get('access-control-allow-origin'), EXT_ORIGIN);
    const pre = await call(t.base, '/api/account/native/begin', { method: 'OPTIONS', headers: { origin: EXT_ORIGIN, 'access-control-request-method': 'POST' } }); assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), EXT_ORIGIN);
    assert.equal((await call(t.base, '/api/account/native/begin', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal(ok.r.headers.get('access-control-allow-origin'), null, 'no CORS for the desktop shell');
    assert.equal(t.accounts.counts().sessions, 0);
  } finally { await t.close(); await g.close(); }
});

test('desktop and extension sign-in resolve to the SAME account as the web, with bearer sessions that are separate from cookie sessions', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    // the web first
    const web = t.web(); await web.signIn(); const webId = t.accounts.sessionAccount(web.jar.cold_session).id;
    // desktop
    const d = await nativeStart(t, g); assert.equal(d.backState, d.state);
    const done = await complete(t, { state: d.state, code: d.code, proof: d.proof }); assert.equal(done.status, 200);
    const dj = await done.json(); assert.deepEqual(Object.keys(dj).sort(), ['account', 'expiresAt', 'token']); assert.deepEqual(dj.account, { name: 'Pat Example', email: 'pat@example.com' });
    assert.equal(t.accounts.sessionAccount(dj.token, 'native').id, webId, 'same Google subject, same Cold account');
    // extension
    const e = await nativeStart(t, g, { redirectUri: EXT_REDIRECT, kind: 'extension', origin: EXT_ORIGIN });
    const ed = await (await complete(t, { state: e.state, code: e.code, proof: e.proof }, EXT_ORIGIN)).json();
    assert.equal(t.accounts.sessionAccount(ed.token, 'native').id, webId); assert.notEqual(ed.token, dj.token);
    assert.equal(t.accounts.counts().accounts, 1, 'one account across all three surfaces');
    // bearer me
    const r = await me(t, dj.token); assert.equal(r.status, 200);
    const body = await r.json(); assert.deepEqual(Object.keys(body.account).sort(), ['email', 'name']); assert.ok(!('csrf' in body) && !JSON.stringify(body).includes(dj.token));
    assert.equal((await me(t, ed.token, { origin: EXT_ORIGIN })).headers.get('access-control-allow-origin'), EXT_ORIGIN);
    assert.equal((await me(t, dj.token, { origin: 'https://evil.example' })).status, 403, 'a web page cannot use a token');
    // cookie and bearer sessions are not interchangeable
    assert.equal((await me(t, web.jar.cold_session)).status, 401, 'a cookie session id is not a bearer token');
    const asCookie = client(t.base); asCookie.jar.cold_session = dj.token; assert.equal((await asCookie.call('/api/account/me')).status, 401, 'a bearer token is not a cookie session');
    // a different Google subject is a different account
    g.person = { sub: 'sub-other', name: 'Other', email: 'pat@example.com', email_verified: true };
    const o = await nativeStart(t, g); const od = await (await complete(t, { state: o.state, code: o.code, proof: o.proof })).json();
    assert.notEqual(t.accounts.sessionAccount(od.token, 'native').id, webId); assert.equal(t.accounts.counts().accounts, 2);
  } finally { await t.close(); await g.close(); }
});

test('native sign-in failures create no session: wrong proof, wrong or reused state, expired transaction, desktop/extension mix-ups, and every bad ID token', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    let sessions = 0;
    const refused = async (setup, doComplete) => {
      g.mutate = null; g.sigOpts = {}; g.failToken = false; g.deny = false; await setup();
      const s = await nativeStart(t, g); const r = await doComplete(s); assert.equal(r.status, 400, 'refused'); assert.equal((await r.json()).error.code, 'signin_failed');
      assert.equal(t.accounts.counts().sessions, sessions, 'no session'); return s;
    };
    const ok = s => ({ state: s.state, code: s.code, proof: s.proof });
    await refused(() => {}, s => complete(t, { ...ok(s), proof: b64(crypto.randomBytes(32)) }));               // wrong proof (a stolen redirect)
    await refused(() => {}, s => complete(t, { ...ok(s), state: 'forged' }));
    await refused(() => {}, s => complete(t, { ...ok(s), proof: undefined }));
    await refused(() => {}, s => complete(t, { ...ok(s), code: '' }));
    const s1 = await refused(() => {}, s => complete(t, { ...ok(s), proof: 'x'.repeat(40) }));
    assert.equal((await complete(t, ok(s1))).status, 400, 'the state is used up by the failed attempt, even with the right proof');
    const s2 = await nativeStart(t, g); assert.equal((await complete(t, ok(s2))).status, 200); sessions = 1; assert.equal((await complete(t, ok(s2))).status, 400, 'replay');
    await refused(() => { g.mutate = c => ({ ...c, nonce: 'wrong' }); }, s => complete(t, ok(s)));
    await refused(() => { g.mutate = c => ({ ...c, iss: 'https://evil.example' }); }, s => complete(t, ok(s)));
    await refused(() => { g.mutate = c => ({ ...c, aud: 'another-client' }); }, s => complete(t, ok(s)));
    await refused(() => { g.mutate = c => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }); }, s => complete(t, ok(s)));
    await refused(() => { g.sigOpts = { tamper: true }; }, s => complete(t, ok(s)));
    await refused(() => { g.sigOpts = { key: makeKey('test-key-1') }; }, s => complete(t, ok(s)));
    await refused(() => { g.sigOpts = { alg: 'none' }; }, s => complete(t, ok(s)));
    await refused(() => { g.failToken = true; }, s => complete(t, ok(s)));
    // the browser cookie callback can't finish a native sign-in, and the native completion can't finish a web one
    g.mutate = null; g.sigOpts = {}; g.failToken = false;
    const n = await nativeStart(t, g); const cb = new URL(`/oauth/account/callback?code=${n.code}&state=${n.state}`, t.base);
    const viaWeb = await t.web().call(cb.pathname + cb.search); assert.match(viaWeb.headers.get('location'), /signin=expired/);
    const w = t.web(); const login = await (await w.call('/api/account/login', { method: 'POST', body: {} })).json(); const back = new URL((await fetch(login.url, { redirect: 'manual' })).headers.get('location'));
    assert.equal((await complete(t, { state: back.searchParams.get('state'), code: back.searchParams.get('code'), proof: b64(crypto.randomBytes(32)) })).status, 400);
    assert.equal(t.accounts.counts().sessions, sessions); assert.equal(t.accounts.counts().accounts, 1, 'only the one successful sign-in made an account');
  } finally { await t.close(); await g.close(); }
});

test('native sessions: expire, can be revoked, are ended by logout, and a client-supplied account id changes nothing', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const sign = async () => { const s = await nativeStart(t, g); return (await (await complete(t, { state: s.state, code: s.code, proof: s.proof })).json()); };
    const a = await sign(); g.person = { sub: 'sub-b', name: 'Bee', email: 'bee@example.com', email_verified: true }; const b = await sign();
    const idB = t.accounts.sessionAccount(b.token, 'native').id;
    const spoof = await call(t.base, `/api/account/me?account=${idB}&accountId=${idB}&sub=sub-b`, { headers: { authorization: `Bearer ${a.token}`, 'x-account-id': idB, 'x-cold-account': idB } });
    assert.equal((await spoof.json()).account.name, 'Pat Example', 'the account comes from the token');
    assert.equal((await me(t, 'x'.repeat(50))).status, 401); assert.equal((await call(t.base, '/api/account/me', { headers: { authorization: `Bearer ${idB}` } })).status, 401, 'an account id is not a credential');
    assert.equal((await call(t.base, '/api/account/me', { headers: { authorization: 'Basic abc' } })).status, 401);
    // expiry
    const accId = t.accounts.sessionAccount(a.token, 'native').id; const dead = t.accounts.createSession(accId, -1000, 'native'); assert.equal((await me(t, dead.id)).status, 401);
    // revocation at the server
    t.accounts.destroySession(b.token); assert.equal((await me(t, b.token)).status, 401); assert.equal((await me(t, a.token)).status, 200, 'other sessions are unaffected');
    // logout
    assert.equal((await call(t.base, '/api/account/logout', { method: 'POST', headers: { authorization: `Bearer ${a.token}`, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await me(t, a.token)).status, 200, 'a cross-site logout did nothing');
    assert.equal((await call(t.base, '/api/account/logout', { method: 'POST', headers: { authorization: `Bearer ${a.token}` } })).status, 200); assert.equal((await me(t, a.token)).status, 401);
    // the web cookie flow is untouched by all of this
    const w = t.web(); await w.signIn(); assert.equal((await w.call('/api/account/me')).status, 200);
    const out = await w.call('/api/account/logout', { method: 'POST', headers: { 'x-cold-csrf': (await (await w.call('/api/account/me')).json()).csrf } }); assert.equal(out.status, 200);
  } finally { await t.close(); await g.close(); }
});

test('without native redirects configured the native routes are off and the web sign-in is unaffected', async () => {
  const g = await startGoogle(), t = await boot(g, { redirects: [] });
  try {
    assert.equal((await call(t.base, '/api/account/native/begin', { method: 'POST', body: { client: 'desktop', redirectUri: DESKTOP, proof: hashProof('x'.repeat(32)) } })).status, 404);
    assert.equal((await call(t.base, '/api/account/me', { headers: { authorization: 'Bearer ' + 'a'.repeat(40) } })).status, 404);
    const w = t.web(); await w.signIn(); assert.equal((await w.call('/api/account/me')).status, 200);
    assert.deepEqual((await (await fetch(`${t.base}/api/config`)).json()).account, { enabled: true, native: false, hosted: false });
  } finally { await t.close(); await g.close(); }
});

// ---------------------------------------------------------------------------------------------------------- desktop client
test('desktop client: state transitions, memory-only session, unreachable and revoked services, mismatched callbacks', async () => {
  const { createAccountClient, normalizeAuthority } = require('../lib/accountClient');
  assert.equal(normalizeAuthority('https://cold.example.com/'), 'https://cold.example.com'); assert.equal(normalizeAuthority('http://localhost:3000'), 'http://localhost:3000');
  for (const bad of ['http://cold.example.com', 'ftp://x', 'https://u:p@x.com', 'https://x.com/path', 'https://x.com?a=1', '']) assert.equal(normalizeAuthority(bad), '', bad);
  assert.equal(createAccountClient({ authority: 'http://evil.example' }).configured, false);
  const g = await startGoogle(), t = await boot(g);
  try {
    const c = createAccountClient({ authority: t.base });
    assert.deepEqual(await c.status(), { state: 'signedOut' });
    const start = await c.begin({ redirectUri: DESKTOP });
    const back = new URL((await fetch(start.url, { redirect: 'manual' })).headers.get('location'));
    // a callback that doesn't match what this app started is ignored, and consumes the attempt
    assert.equal((await c.complete({ code: back.searchParams.get('code'), state: 'forged' })).ok, false); assert.deepEqual(await c.status(), { state: 'signedOut' });
    assert.equal((await c.complete({ code: back.searchParams.get('code'), state: back.searchParams.get('state') })).ok, false, 'the attempt was used up');
    // a full successful sign-in
    const s2 = await c.begin({ redirectUri: DESKTOP }); const b2 = new URL((await fetch(s2.url, { redirect: 'manual' })).headers.get('location'));
    const r = await c.complete({ code: b2.searchParams.get('code'), state: b2.searchParams.get('state') }); assert.equal(r.ok, true);
    const st = await c.status(); assert.deepEqual([st.state, st.account], ['signedIn', { name: 'Pat Example', email: 'pat@example.com' }]);
    const shown = JSON.stringify(st) + JSON.stringify(r); assert.ok(!/token|proof|verifier/i.test(shown), 'what the page can see holds no credential');
    // replaying the callback does nothing
    assert.equal((await c.complete({ code: b2.searchParams.get('code'), state: b2.searchParams.get('state') })).ok, false);
    // consent denied
    g.deny = true; const s3 = await c.begin({ redirectUri: DESKTOP }); const b3 = new URL((await fetch(s3.url, { redirect: 'manual' })).headers.get('location'));
    const denied = await c.complete({ error: b3.searchParams.get('error'), state: b3.searchParams.get('state') }); assert.equal(denied.ok, false); assert.match(denied.message, /chose not to/); g.deny = false;
    assert.equal((await c.status()).state, 'signedIn', 'a failed attempt does not sign out an existing session');
    // sign out, server confirms
    const out = await c.signOut(); assert.equal(out.serverConfirmed, true); assert.deepEqual(await c.status(), { state: 'signedOut' });
  } finally { await t.close(); await g.close(); }
});

test('desktop client: an unreachable account service is reported as unavailable and sign-out still forgets the session', async () => {
  const { createAccountClient } = require('../lib/accountClient');
  const g = await startGoogle(), t = await boot(g);
  const c = createAccountClient({ authority: t.base });
  const s = await c.begin({ redirectUri: DESKTOP }); const b = new URL((await fetch(s.url, { redirect: 'manual' })).headers.get('location'));
  assert.equal((await c.complete({ code: b.searchParams.get('code'), state: b.searchParams.get('state') })).ok, true);
  const base = t.base; await t.close(); await g.close();                                     // the account service goes away
  const st = await c.status(); assert.equal(st.state, 'unavailable'); assert.equal(st.account.email, 'pat@example.com');
  await assert.rejects(c.begin({ redirectUri: DESKTOP }), e => e.code === 'account_unavailable');
  const out = await c.signOut(); assert.equal(out.serverConfirmed, false); assert.deepEqual(await c.status(), { state: 'signedOut' });
  void base;
  const none = createAccountClient({ authority: '' }); await assert.rejects(none.begin({ redirectUri: DESKTOP }), e => e.code === 'account_not_configured');
});

test('desktop client: a session revoked or expired at the service is reported as expired', async () => {
  const { createAccountClient } = require('../lib/accountClient');
  const g = await startGoogle(), t = await boot(g);
  try {
    const c = createAccountClient({ authority: t.base });
    const s = await c.begin({ redirectUri: DESKTOP }); const b = new URL((await fetch(s.url, { redirect: 'manual' })).headers.get('location'));
    await c.complete({ code: b.searchParams.get('code'), state: b.searchParams.get('state') });
    assert.equal((await c.status()).state, 'signedIn');
    const raw = new (require('node:sqlite').DatabaseSync)(path.join(t.dir, 'accounts.db')); raw.exec('DELETE FROM sessions'); raw.close();   // the operator revokes every session
    assert.equal((await c.status()).state, 'expired'); assert.equal((await c.status()).state, 'signedOut');
  } finally { await t.close(); await g.close(); }
});

// ---------------------------------------------------------------------------------------------------------- extension worker
test('extension worker: states, callback mismatch, memory-only token, and messages from content scripts or other pages are refused', async () => {
  const { createAccountWorker, normalizeAuthority } = await import(pathToFileURL(path.join(__dirname, '../extension/src/account.js')).href);
  assert.equal(normalizeAuthority('https://cold.example.com'), 'https://cold.example.com'); assert.equal(normalizeAuthority('http://cold.example.com'), '');
  const g = await startGoogle(), t = await boot(g);
  try {
    const mem = { session: {}, local: {} };
    const area = o => ({ get: async k => ({ [k]: o[k] }), set: async v => Object.assign(o, v), remove: async k => { delete o[k]; } });
    let launch = async ({ url }) => { const loc = (await fetch(url, { redirect: 'manual' })).headers.get('location'); return loc; };
    const chrome = { runtime: { id: EXT_ID, getURL: p => `chrome-extension://${EXT_ID}/${p}` }, storage: { session: area(mem.session), local: area(mem.local) }, identity: { getRedirectURL: () => EXT_REDIRECT, launchWebAuthFlow: o => launch(o) } };
    // the worker's fetch carries the extension's Origin, as Chrome does
    const fetchImpl = (u, init = {}) => /account\.json$/.test(String(u)) ? Promise.resolve({ ok: true, json: async () => ({ url: t.base }) }) : fetch(u, { ...init, headers: { ...(init.headers || {}), origin: EXT_ORIGIN } });
    const w = createAccountWorker({ chrome, fetchImpl });
    assert.deepEqual(await w.ops.config(), { enabled: true }); assert.deepEqual(await w.ops.status(), { state: 'signedOut' });
    // closed window, mismatched state, denied consent: not signed in
    launch = async () => { throw new Error('The user did not approve access.'); }; assert.equal((await w.ops.signin()).error, 'cancelled');
    launch = async ({ url }) => { const l = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')); l.searchParams.set('state', 'forged'); return l.href; }; assert.equal((await w.ops.signin()).error, 'failed');
    g.deny = true; launch = async ({ url }) => (await fetch(url, { redirect: 'manual' })).headers.get('location'); assert.equal((await w.ops.signin()).error, 'cancelled'); g.deny = false;
    g.mutate = c => ({ ...c, nonce: 'wrong' }); assert.equal((await w.ops.signin()).error, 'failed'); g.mutate = null;
    assert.deepEqual(await w.ops.status(), { state: 'signedOut' }); assert.deepEqual(mem.session, {}); assert.equal(t.accounts.counts().sessions, 0);
    // success
    const ok = await w.ops.signin(); assert.deepEqual([ok.state, ok.account], ['signedIn', { name: 'Pat Example', email: 'pat@example.com' }]);
    assert.ok(!JSON.stringify(ok).includes(mem.session['cold.account.session'].token), 'the panel never gets the token');
    assert.deepEqual(mem.local, {}, 'nothing was written to local storage'); assert.equal((await w.ops.status()).state, 'signedIn');
    // revoked at the server, then the account service goes away
    const raw = new (require('node:sqlite').DatabaseSync)(path.join(t.dir, 'accounts.db')); raw.exec('DELETE FROM sessions'); raw.close();
    assert.equal((await w.ops.status()).state, 'expired'); assert.deepEqual(mem.session, {});
    await w.ops.signin(); const base = t.base; assert.equal((await w.ops.signout()).serverConfirmed, true); assert.deepEqual(mem.session, {});
    await w.ops.signin(); await t.close(); const down = await w.ops.status(); assert.equal(down.state, 'unavailable'); assert.equal(down.account.email, 'pat@example.com');
    assert.equal((await w.ops.signin()).error, 'account_unavailable'); assert.deepEqual(await w.ops.signout(), { ok: true, serverConfirmed: false }); assert.deepEqual(mem.session, {}); void base;
    // who may ask
    const answers = [];
    const ask = (sender, msg = { cold: 'account', op: 'status' }) => new Promise(r => { const keep = w.onMessage(msg, sender, a => { answers.push(a); r(a); }); if (!keep) r(answers.at(-1)); });
    const panel = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/panel.html` };
    assert.notEqual((await ask(panel)).error, 'refused');
    assert.equal((await ask({ id: EXT_ID, url: 'https://x.com/page', tab: { id: 1 } })).error, 'refused', 'a content script');
    assert.equal((await ask({ id: EXT_ID, url: 'https://evil.example/chrome-extension://' + EXT_ID + '/panel.html', tab: { id: 1 } })).error, 'refused', 'a page URL that merely contains the extension URL');
    assert.equal((await ask({ id: EXT_ID, url: `chrome-extension://${EXT_ID}.evil.example/panel.html` })).error, 'refused');
    assert.notEqual((await ask({ id: EXT_ID, url: `chrome-extension://${EXT_ID}/panel.html`, tab: { id: 1 } })).error, 'refused', 'an extension page open in a tab');
    assert.equal((await ask({ id: 'someoneelse', url: 'chrome-extension://someoneelse/p.html' })).error, 'refused');
    assert.equal((await ask(undefined)).error, 'refused'); assert.equal((await ask(panel, { cold: 'account', op: 'constructor' })).error, 'refused'); assert.equal((await ask(panel, { cold: 'account', op: '__proto__' })).error, 'refused');
    assert.equal(w.onMessage({ cold: 'other' }, panel, () => {}), false);
  } finally { await g.close(); try { await t.close(); } catch { /* already closed */ } }
});

test('rate limit applies to native sign-in, and an accounts file made before native sign-in existed is upgraded in place', async () => {
  const g = await startGoogle(), t = await boot(g, { extra: { COLD_AUTH_RATE_LIMIT_PER_MIN: '4' } });
  try {
    const r = []; for (let i = 0; i < 6; i++) r.push((await call(t.base, '/api/account/native/begin', { method: 'POST', body: { client: 'desktop', redirectUri: DESKTOP, proof: hashProof('x'.repeat(32)) } })).status);
    assert.deepEqual(r.slice(0, 4), [200, 200, 200, 200]); assert.deepEqual(r.slice(4), [429, 429]);
  } finally { await t.close(); await g.close(); }
  // the schema from the first sign-in release: no kind/client columns
  const { DatabaseSync } = require('node:sqlite'); const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cold-old-')), 'a.db'); const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, display_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
    CREATE TABLE identities (provider TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject));
    CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE sign_in (state_hash TEXT PRIMARY KEY, binder_hash TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
  const mac = (k, v) => crypto.createHmac('sha256', SECRET).update(`${k}:${v}`).digest('hex');
  old.prepare("INSERT INTO accounts VALUES ('acc_old', 1, 'Old', 'old@x.example', 1)").run(); old.prepare("INSERT INTO identities VALUES ('google', 'sub-old', 'acc_old', 1)").run();
  old.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(mac('session', 'oldsession'), 'acc_old', 1, Date.now() + 3600000); old.close();
  const { createAccounts } = require('../lib/accounts'); const a = createAccounts({ file, secret: SECRET }); const b = createAccounts({ file, secret: SECRET });   // twice: repeatable
  assert.equal(a.sessionAccount('oldsession').id, 'acc_old', 'an existing web session still works'); assert.equal(a.sessionAccount('oldsession', 'native'), null);
  assert.equal(b.resolveAccount({ subject: 'sub-old' }).id, 'acc_old'); a.close(); b.close();
});

test('no client secret, session secret or account token appears in renderer code, extension pages, content scripts, URLs or logs', () => {
  const code = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // comments may name what the code avoids
  const app = code('public/app.js'), panel = code('extension/dist/panel.js');
  for (const [name, text] of [['public/app.js', app], ['extension/dist/panel.js', panel]]) assert.ok(!/COLD_AUTH_GOOGLE_CLIENT_SECRET|COLD_SESSION_SECRET|client_secret|cold\.account\.session/.test(text), `${name} holds no secret or session key name`);
  assert.ok(!/storage\.session/.test(panel), 'the panel never reads session storage: only the worker does');
  assert.ok(!/native\/(begin|complete)/.test(app) && !/native\/(begin|complete)/.test(panel), 'the page and the panel never run the token exchange: the desktop app and the worker do');
  assert.ok(!/client_secret/.test(code('extension/dist/account-worker.js')), 'the extension holds no OAuth client secret');
  // code the extension injects into web pages has nothing to do with accounts
  for (const f of ['extension/src/page.js', 'extension/src/pageCard.js', 'extension/src/askCold.js']) assert.ok(!/cold\.account|storage\.session|launchWebAuthFlow|native\/(begin|complete)|op:\s*["']signin/.test(code(f)), `${f} has no account code`);
  for (const f of ['lib/accountClient.js', 'extension/src/account.js', 'lib/auth.js', 'lib/accounts.js']) assert.ok(!/console\.(log|info|warn|error|debug)/.test(code(f)), `${f} writes no logs`);
  assert.ok(!/require\("node:fs"\)|writeFile|settings\.update|appendFile/.test(code('lib/accountClient.js')), 'the desktop client persists nothing');
  assert.ok(!/localStorage|storage\.local|storage\.sync/.test(code('extension/src/account.js')), 'the extension worker writes no persistent storage');
  const dist = path.join(__dirname, '../extension/dist/account.json'); if (fs.existsSync(dist)) assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(dist, 'utf8'))), ['url'], 'the build writes only an address');
  assert.ok(!/secret|token/i.test(fs.readFileSync(path.join(__dirname, '../desktop/account.example.json'), 'utf8')), 'the desktop config template has no secret field');
});
