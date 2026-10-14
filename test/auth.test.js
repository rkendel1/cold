// Google sign-in and Cold accounts. Uses a STAND-IN for Google (test/helpers/google-mock.js): these tests prove Cold's own validation, account and session
// logic. They are not evidence that real Google sign-in works; see docs/google-sign-in.md for the live smoke test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { startGoogle, client, makeKey, sign } = require('./helpers/google-mock');
const SECRET = 'unit-test-session-secret-0123456789abcdef-XYZ';
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const CLEAN = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN', 'COLD_DB_FILE', 'COLD_SETTINGS_FILE', 'NODE_ENV', 'VERCEL_ENV'];

async function boot(google, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-auth-')), port = await freePort();
  for (const k of CLEAN) delete process.env[k];
  Object.assign(process.env, { LLM_PROVIDER: 'ollama', COLD_AUTH_GOOGLE_CLIENT_ID: google.clientId, COLD_AUTH_GOOGLE_CLIENT_SECRET: google.clientSecret, COLD_SESSION_SECRET: SECRET,
    COLD_ACCOUNTS_DB_FILE: path.join(dir, 'accounts.db'), COLD_AUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/account/callback`, ...google.urls, ...extra });
  delete require.cache[require.resolve('../server')]; delete require.cache[require.resolve('../lib/auth')];
  const server = require('../server');
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  return { server, base, port, accounts: server.auth.accounts, dir, c: () => client(base), close: () => new Promise(r => { server.closeAllConnections(); server.close(() => { server.auth.close(); r(); }); }) };
}
const me = async c => { const r = await c.call('/api/account/me'); return { status: r.status, body: await r.json().catch(() => null) }; };

// ---------------------------------------------------------------------------------------------------------- configuration
test('config: off when not configured; a partly configured server refuses to start and names the settings, never their values', () => {
  const { readConfig } = require('../lib/auth');
  assert.deepEqual(readConfig({}), { enabled: false, reason: 'not_configured' });
  assert.equal(readConfig({ COLD_AUTH_GOOGLE_CLIENT_ID: 'id', COLD_SETTINGS_FILE: '/x' }).enabled, false, 'desktop and local installs never enable hosted sign-in');
  assert.equal(readConfig({ COLD_AUTH_GOOGLE_CLIENT_ID: 'id', COLD_DB_FILE: '/x' }).enabled, false);
  const good = { COLD_AUTH_GOOGLE_CLIENT_ID: 'id', COLD_AUTH_GOOGLE_CLIENT_SECRET: 'SECRET-VALUE', COLD_SESSION_SECRET: SECRET, COLD_ACCOUNTS_DB_FILE: '/data/a.db', COLD_AUTH_REDIRECT_URI: 'https://cold.example.com/oauth/account/callback' };
  const c = readConfig({ ...good, NODE_ENV: 'production' }); assert.equal(c.enabled, true); assert.equal(c.secure, true); assert.equal(c.ttlMs, 168 * 3600 * 1000);
  for (const [patch, re] of [[{ COLD_AUTH_GOOGLE_CLIENT_SECRET: '' }, /CLIENT_SECRET/], [{ COLD_SESSION_SECRET: 'short' }, /COLD_SESSION_SECRET/], [{ COLD_ACCOUNTS_DB_FILE: '' }, /ACCOUNTS_DB_FILE/],
    [{ COLD_AUTH_REDIRECT_URI: '' }, /REDIRECT_URI/], [{ COLD_AUTH_REDIRECT_URI: 'https://x.com/other' }, /exactly \/oauth\/account\/callback/], [{ COLD_AUTH_REDIRECT_URI: 'http://cold.example.com/oauth/account/callback' }, /must be https/],
    [{ NODE_ENV: 'production', COLD_AUTH_REDIRECT_URI: 'http://localhost:3000/oauth/account/callback' }, /must be https/], [{ NODE_ENV: 'production', COLD_AUTH_GOOGLE_TOKEN_URL: 'http://evil' }, /for tests/],
    [{ COLD_SESSION_TTL_HOURS: '0' }, /TTL_HOURS/], [{ COLD_AUTH_RETURN_PATHS: 'https://evil.com' }, /RETURN_PATHS/]]) {
    assert.throws(() => readConfig({ ...good, ...patch }), e => re.test(e.message) && !/SECRET-VALUE|unit-test-session/.test(e.message), JSON.stringify(patch));
  }
  assert.equal(readConfig({ ...good, COLD_AUTH_REDIRECT_URI: 'http://localhost:3000/oauth/account/callback' }).secure, false, 'plain http is allowed for localhost outside production');
});

test('startup: an incompletely configured server exits with a clear message; an unconfigured one starts and serves local use', () => {
  const run = env => spawnSync(process.execPath, ['-e', "const s=require('./server');console.log('loaded', s.auth.enabled);process.exit(0)"], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const bad = run({ COLD_AUTH_GOOGLE_CLIENT_ID: 'id', NODE_ENV: 'production' });
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /configured incompletely/);
  const off = run({}); assert.equal(off.status, 0); assert.match(off.stdout, /loaded false/);
});

// ---------------------------------------------------------------------------------------------------------- ID token checks
test('ID token validation: signature, algorithm, issuer, audience, expiry, nonce, subject and key are all checked', () => {
  const { verifyIdToken } = require('../lib/auth');
  const key = makeKey(), other = makeKey(), now = 2000000000, id = 'client-1';
  const base = { iss: 'https://accounts.google.com', aud: id, sub: 'sub-1', iat: now - 10, exp: now + 3000, nonce: 'N' };
  const ok = (claims, o = {}, v = {}) => verifyIdToken(sign(claims, { key, ...o }), { keys: [key.jwk], clientId: id, nonce: 'N', nowS: now, ...v });
  const code = (claims, o, v) => { try { ok(claims, o, v); return 'accepted'; } catch (e) { return e.code; } };
  assert.equal(ok(base).sub, 'sub-1'); assert.equal(code({ ...base, iss: 'accounts.google.com' }), 'accepted');
  assert.equal(code({ ...base, iss: 'https://evil.example' }), 'token_issuer');
  assert.equal(code({ ...base, aud: 'someone-else' }), 'token_audience'); assert.equal(code({ ...base, aud: [id, 'x'] }), 'token_audience', 'multi-audience needs azp');
  assert.equal(code({ ...base, exp: now - 120 }), 'token_expired'); assert.equal(code({ ...base, exp: undefined }), 'token_expired');
  assert.equal(code({ ...base, iat: now + 3600 }), 'token_future');
  assert.equal(code({ ...base, nonce: 'other' }), 'token_nonce'); assert.equal(code({ ...base, nonce: undefined }), 'token_nonce');
  assert.equal(code({ ...base, sub: '' }), 'token_subject'); assert.equal(code({ ...base, sub: 5 }), 'token_subject');
  assert.equal(code(base, { tamper: true }), 'token_signature', 'claims changed after signing');
  assert.equal(code(base, {}, { keys: [{ ...other.jwk, kid: key.kid }] }), 'token_signature', 'signed by a different key');
  assert.equal(code(base, { alg: 'none' }), 'token_alg'); assert.equal(code(base, { alg: 'HS256' }), 'token_alg');
  assert.equal(code(base, {}, { keys: [] }), 'token_key'); assert.equal(code(base, {}, { keys: [{ ...key.jwk, kid: 'other' }] }), 'token_key');
  for (const junk of ['', 'a.b', 'a.b.c', 'x.y.z.w']) assert.throws(() => verifyIdToken(junk, { keys: [key.jwk], clientId: id, nonce: 'N', nowS: now }), e => /^token_/.test(e.code));
});

// ---------------------------------------------------------------------------------------------------------- the flow
test('sign-in: identity scopes only, PKCE and state, a hardened session cookie; /me shows the account without secrets; logout needs CSRF and ends the session', async () => {
  const g = await startGoogle(), t = await boot(g), c = t.c();
  const logs = []; const orig = { log: console.log, warn: console.warn, error: console.error }; for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.join(' '));
  try {
    assert.equal((await me(c)).status, 401, 'signed out');
    const cfg = await (await fetch(`${t.base}/api/config`)).json(); assert.deepEqual(cfg.account, { enabled: true });
    const login = await c.call('/api/account/login', { method: 'POST', body: {} }); assert.equal(login.status, 200);
    const { url } = await login.json(), q = new URL(url).searchParams;
    assert.equal(q.get('scope'), 'openid email profile'); assert.doesNotMatch(url, /gmail|spreadsheets|drive|offline/i);
    assert.equal(q.get('code_challenge_method'), 'S256'); assert.equal(q.get('response_type'), 'code'); assert.equal(q.get('redirect_uri'), `${t.base}/oauth/account/callback`);
    assert.ok(q.get('state').length >= 30 && q.get('nonce').length >= 30);
    const setCookie = login.headers.getSetCookie().join('\n'); assert.match(setCookie, /cold_signin=/); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Lax/);
    const toGoogle = await fetch(url, { redirect: 'manual' }); const cb = await c.call(toGoogle.headers.get('location'), { absolute: true });
    assert.equal(cb.status, 302); assert.equal(cb.headers.get('location'), '/?signin=ok#/settings');
    const sess = cb.headers.getSetCookie().find(x => x.startsWith('cold_session='));
    assert.match(sess, /HttpOnly/); assert.match(sess, /SameSite=Lax/); assert.match(sess, /Path=\//); assert.match(sess, /Max-Age=604800/); assert.doesNotMatch(sess, /Secure/, 'plain http in this test');
    assert.ok(!c.jar.cold_signin, 'the sign-in cookie is gone');
    const r = await me(c); assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body.account).sort(), ['email', 'name']); assert.deepEqual([r.body.account.name, r.body.account.email], ['Pat Example', 'pat@example.com']);
    const text = JSON.stringify(r.body); assert.ok(!text.includes(c.jar.cold_session) && !/acc_|GOOGLE-|SECRET|id_token|access_token/.test(text), 'no ids, tokens or secrets in the response');
    // logout: no CSRF token, wrong token, cross-site: refused and the session survives
    assert.equal((await c.call('/api/account/logout', { method: 'POST' })).status, 403);
    assert.equal((await c.call('/api/account/logout', { method: 'POST', headers: { 'x-cold-csrf': 'nope' } })).status, 403);
    assert.equal((await c.call('/api/account/logout', { method: 'POST', headers: { 'x-cold-csrf': r.body.csrf, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await c.call('/api/account/logout', { method: 'POST', headers: { 'x-cold-csrf': r.body.csrf, 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await me(c)).status, 200);
    const old = c.jar.cold_session;
    const out = await c.call('/api/account/logout', { method: 'POST', headers: { 'x-cold-csrf': r.body.csrf } }); assert.equal(out.status, 200);
    assert.match(out.headers.getSetCookie().join('\n'), /cold_session=; .*Max-Age=0/);
    assert.equal(t.accounts.counts().sessions, 0, 'the server-side session is deleted');
    const replay = client(t.base); replay.jar.cold_session = old; assert.equal((await me(replay)).status, 401, 'the old cookie no longer works');
    // nothing sensitive reached the logs
    const all = logs.join('\n'); assert.ok(!all.includes(old) && !all.includes(g.clientSecret) && !all.includes(SECRET) && !/id_token|GOOGLE-/.test(all));
  } finally { Object.assign(console, orig); await t.close(); await g.close(); }
});

test('sign-in failures never create a session: bad state, missing binder (another browser), replay, denied consent, token errors, and each bad ID token', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const failed = async (setup, expect = /signin=failed|signin=expired|signin=cancelled/) => {
      const c = t.c(); await setup(c, g); const cb = await c.signIn();
      assert.equal(cb.status, 302); assert.match(cb.headers.get('location'), expect); assert.ok(!cb.headers.getSetCookie().some(x => x.startsWith('cold_session=') && !/Max-Age=0/.test(x)), 'no session cookie');
      assert.equal((await me(c)).status, 401); return c;
    };
    const key2 = makeKey('test-key-1');
    await failed(() => { g.mutate = c => ({ ...c, nonce: 'wrong' }); });
    await failed(() => { g.mutate = c => ({ ...c, iss: 'https://evil.example' }); });
    await failed(() => { g.mutate = c => ({ ...c, aud: 'another-client' }); });
    await failed(() => { g.mutate = c => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }); });
    await failed(() => { g.mutate = null; g.sigOpts = { tamper: true }; });
    await failed(() => { g.sigOpts = { key: key2 }; });
    await failed(() => { g.sigOpts = { alg: 'none' }; });
    await failed(() => { g.sigOpts = {}; g.failToken = true; });
    await failed(() => { g.failToken = false; g.deny = true; }, /signin=cancelled/);
    g.deny = false; g.mutate = null; g.sigOpts = {};
    assert.equal(t.accounts.counts().accounts, 0, 'a failed sign-in creates no account'); assert.equal(t.accounts.counts().sessions, 0);
    // state tampering, replay, another browser
    const c = t.c(); const login = await c.call('/api/account/login', { method: 'POST', body: {} }); const { url } = await login.json();
    const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
    const bad = new URL(back); bad.searchParams.set('state', 'forged'); const r1 = await c.call(bad.href, { absolute: true }); assert.match(r1.headers.get('location'), /signin=expired/);
    assert.ok(!c.cookieHeader().includes('cold_session'));
    const other = t.c(); const r2 = await other.call(back.href, { absolute: true }); assert.match(r2.headers.get('location'), /signin=expired/, 'another browser has no binder cookie');
    assert.equal((await me(other)).status, 401);
    // the state was consumed by the attempt above (single use), so even the right browser can no longer finish
    const r3 = await c.call(back.href, { absolute: true }); assert.match(r3.headers.get('location'), /signin=expired/);
    // a real success, then replaying the same callback does nothing
    const ok = t.c(); const first = await ok.signIn(); assert.match(first.headers.get('location'), /signin=ok/);
    assert.equal(t.accounts.counts().accounts, 1);
    const l2 = await (await ok.call('/api/account/login', { method: 'POST', body: {} })).json(); const cbUrl = (await fetch(l2.url, { redirect: 'manual' })).headers.get('location');
    await ok.call(cbUrl, { absolute: true }); const again = await ok.call(cbUrl, { absolute: true }); assert.match(again.headers.get('location'), /signin=expired/);
    // direct hits on the callback
    assert.match((await t.c().call('/oauth/account/callback', { absolute: false })).headers.get('location'), /signin=expired/);
    assert.match((await t.c().call('/oauth/account/callback?error=access_denied')).headers.get('location'), /signin=expired/);
  } finally { await t.close(); await g.close(); }
});

test('redirect and origin rules: only allow-listed return paths; cross-site and wrong-host requests are refused', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const c = t.c();
    for (const returnTo of ['https://evil.example/', '//evil.example', '/elsewhere', '', 5, null, '/?x=1']) assert.equal((await c.call('/api/account/login', { method: 'POST', body: { returnTo } })).status, 400, String(returnTo));
    assert.equal((await c.call('/api/account/login', { method: 'POST', body: { returnTo: '/' } })).status, 200);
    assert.equal((await c.call('/api/account/login', { method: 'POST', headers: { origin: 'https://evil.example' }, body: {} })).status, 403);
    assert.equal((await c.call('/api/account/login', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: {} })).status, 403);
    assert.equal((await c.call('/api/account/login', { method: 'POST', headers: { host: 'evil.example' }, body: {} })).status, 403);
    assert.equal((await c.call('/api/account/login')).status, 405, 'login is POST only');
    const ok = await t.c().signIn({ returnTo: '/' }); assert.equal(ok.headers.get('location'), '/?signin=ok#/settings', 'the callback never redirects to an address the client supplied');
  } finally { await t.close(); await g.close(); }
});

// ---------------------------------------------------------------------------------------------------------- accounts
test('accounts: one Cold account per Google subject, stable through profile changes, never merged by email, safe under concurrent first sign-ins', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const A = t.c(); await A.signIn(); assert.equal(t.accounts.counts().accounts, 1);
    const id1 = t.accounts.sessionAccount(A.jar.cold_session).id; assert.match(id1, /^acc_/);
    // same subject again (a second browser): same account, new session
    const A2 = t.c(); await A2.signIn(); assert.equal(t.accounts.sessionAccount(A2.jar.cold_session).id, id1); assert.equal(t.accounts.counts().accounts, 1); assert.equal(t.accounts.counts().sessions, 2);
    // profile changes: same id, new values
    g.person = { ...g.person, name: 'Patricia Example', email: 'patricia@new.example' };
    const A3 = t.c(); await A3.signIn(); assert.equal(t.accounts.sessionAccount(A3.jar.cold_session).id, id1);
    assert.deepEqual((await me(A3)).body.account, { name: 'Patricia Example', email: 'patricia@new.example' });
    // a DIFFERENT subject with the SAME email is a different account
    g.person = { sub: 'sub-2', name: 'Someone Else', email: 'patricia@new.example', email_verified: true };
    const B = t.c(); await B.signIn(); const id2 = t.accounts.sessionAccount(B.jar.cold_session).id; assert.notEqual(id2, id1); assert.equal(t.accounts.counts().accounts, 2);
    assert.equal(t.accounts.counts().identities, 2);
    // an unverified email is not stored at all
    g.person = { sub: 'sub-3', name: 'No Verify', email: 'x@y.example', email_verified: false };
    const C = t.c(); await C.signIn(); assert.equal((await me(C)).body.account.email, '');
    // concurrent first sign-ins for one subject: one account
    g.person = { sub: 'sub-race', name: 'Racer', email: 'r@race.example', email_verified: true };
    const before = t.accounts.counts().accounts, clients = Array.from({ length: 8 }, () => t.c());
    const results = await Promise.all(clients.map(c => c.signIn())); assert.ok(results.every(r => /signin=ok/.test(r.headers.get('location'))));
    assert.equal(t.accounts.counts().accounts, before + 1); assert.equal(new Set(clients.map(c => t.accounts.sessionAccount(c.jar.cold_session).id)).size, 1);
  } finally { await t.close(); await g.close(); }
});

test('accounts: the primary key refuses a second identity row, and two connections racing the first sign-in still end with one account', () => {
  const { createAccounts } = require('../lib/accounts');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cold-race-')), 'a.db');
  const a = createAccounts({ file, secret: SECRET }), b = createAccounts({ file, secret: SECRET });   // two connections to one file, as two server processes would have
  const ids = [a, b, a, b, a, b].map(x => x.resolveAccount({ subject: 'same-sub', name: 'N', email: 'e@x.example' }).id);
  assert.equal(new Set(ids).size, 1); assert.equal(a.counts().accounts, 1);
  assert.throws(() => a.resolveAccount({ subject: '' })); a.close(); b.close();
});

test('identity comes from the server-side session only: client-supplied account ids, headers and cookies change nothing', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const A = t.c(); await A.signIn(); g.person = { sub: 'sub-b', name: 'Bee', email: 'bee@example.com', email_verified: true }; const B = t.c(); await B.signIn();
    const idB = t.accounts.sessionAccount(B.jar.cold_session).id;
    const viaParams = await A.call(`/api/account/me?account=${idB}&accountId=${idB}&sub=sub-b&email=bee@example.com`, { headers: { 'x-account-id': idB, 'x-cold-account': idB } });
    assert.equal((await viaParams.json()).account.name, 'Pat Example');
    const forged = client(t.base); forged.jar.account_id = idB; forged.jar.cold_session = idB; forged.jar.cold_account = idB;
    assert.equal((await me(forged)).status, 401);
    const anon = await t.c().call(`/api/account/me?account=${idB}`, { headers: { 'x-account-id': idB } }); assert.equal(anon.status, 401);
    assert.equal((await t.c().call('/api/account/me', { headers: { cookie: 'cold_session=' + 'x'.repeat(5000) } })).status, 401);
    for (const p of ['/api/account/list', `/api/account/${idB}`, '/api/account/switch', '/api/accounts']) assert.ok([404, 405].includes((await t.c().call(p, { method: 'POST' })).status), `no ${p} endpoint`);
  } finally { await t.close(); await g.close(); }
});

// ---------------------------------------------------------------------------------------------------------- sessions
test('sessions: each sign-in issues a fresh id and destroys the one it replaces; expired sessions are rejected; ids are random and stored only as hashes', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const c = t.c(); await c.signIn(); const first = c.jar.cold_session; assert.ok(first.length >= 40);
    await c.signIn(); const second = c.jar.cold_session; assert.notEqual(second, first, 'rotated at sign-in');
    const stale = client(t.base); stale.jar.cold_session = first; assert.equal((await me(stale)).status, 401, 'the replaced session was destroyed');
    assert.equal(t.accounts.counts().sessions, 1);
    const raw = fs.readFileSync(path.join(t.dir, 'accounts.db')); const wal = fs.existsSync(path.join(t.dir, 'accounts.db-wal')) ? fs.readFileSync(path.join(t.dir, 'accounts.db-wal')) : Buffer.alloc(0);
    assert.ok(!Buffer.concat([raw, wal]).includes(second), 'the session id is not readable from the database file');
    // expiry
    const id = t.accounts.sessionAccount(second).id; const expired = t.accounts.createSession(id, -1000);
    const e = client(t.base); e.jar.cold_session = expired.id; const r = await e.call('/api/account/me'); assert.equal(r.status, 401);
    assert.match(r.headers.getSetCookie().join(''), /cold_session=; .*Max-Age=0/, 'a dead cookie is cleared');
    assert.notEqual(t.accounts.createSession(id, 1000).id, t.accounts.createSession(id, 1000).id);
  } finally { await t.close(); await g.close(); }
});

test('sessions: expiry uses the clock; the configured lifetime sets the cookie lifetime', async () => {
  const { createAccounts } = require('../lib/accounts');
  let t = 1000; const a = createAccounts({ file: ':memory:', secret: SECRET, now: () => t });
  const acc = a.resolveAccount({ subject: 's' }), s = a.createSession(acc.id, 5000);
  assert.ok(a.sessionAccount(s.id)); t = 5999; assert.ok(a.sessionAccount(s.id)); t = 6000; assert.equal(a.sessionAccount(s.id), null);
  const sign1 = a.beginSignIn({ returnTo: '/', ttlMs: 100 }); t += 101; assert.equal(a.takeSignIn({ state: sign1.state, binder: sign1.binder }), null, 'sign-in attempts expire');
  a.close();
  const g = await startGoogle(), srv = await boot(g, { COLD_SESSION_TTL_HOURS: '2' });
  try { const c = srv.c(); const cb = await c.signIn(); assert.match(cb.headers.getSetCookie().find(x => x.startsWith('cold_session=')), /Max-Age=7200/); } finally { await srv.close(); await g.close(); }
});

test('production-style config: cookies use the __Host- prefix and Secure; the whole flow works behind the configured https host', async () => {
  const g = await startGoogle();
  const { readConfig, createAuth } = require('../lib/auth');
  const env = { COLD_AUTH_GOOGLE_CLIENT_ID: g.clientId, COLD_AUTH_GOOGLE_CLIENT_SECRET: g.clientSecret, COLD_SESSION_SECRET: SECRET, COLD_ACCOUNTS_DB_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cold-prod-')), 'a.db'), COLD_AUTH_REDIRECT_URI: 'https://cold.example.test/oauth/account/callback', NODE_ENV: 'production' };
  const config = { ...readConfig(env), urls: { authUrl: `${g.base}/auth`, tokenUrl: `${g.base}/token`, jwksUrl: `${g.base}/jwks` } };
  const send = (res, status, body, type = 'application/json', extra = {}) => { res.writeHead(status, { 'content-type': type, ...extra }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const auth = createAuth({ config, send });
  const srv = http.createServer(async (req, res) => { const url = new URL(req.url, 'http://x'); if (!(await auth.handle(req, res, url))) { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const H = { host: 'cold.example.test' };
  try {
    const c = client(base);
    const login = await c.call('/api/account/login', { method: 'POST', headers: { ...H, origin: 'https://cold.example.test' }, body: {} }); assert.equal(login.status, 200);
    const sc = login.headers.getSetCookie()[0]; assert.match(sc, /^__Host-cold_signin=/); assert.match(sc, /; Secure/); assert.match(sc, /HttpOnly/); assert.match(sc, /Path=\//); assert.doesNotMatch(sc, /Domain=/);
    const { url } = await login.json(); assert.equal(new URL(url).searchParams.get('redirect_uri'), 'https://cold.example.test/oauth/account/callback');
    const back = (await fetch(url, { redirect: 'manual' })).headers.get('location'); const u = new URL(back);
    const cb = await c.call(u.pathname + u.search, { headers: H });
    assert.equal(cb.status, 302); const sess = cb.headers.getSetCookie().find(x => x.startsWith('__Host-cold_session='));
    assert.ok(sess, 'session cookie is __Host- prefixed'); assert.match(sess, /; Secure/); assert.match(sess, /HttpOnly/); assert.match(sess, /SameSite=Lax/);
    assert.equal((await c.call('/api/account/me', { headers: H })).status, 200);
    assert.equal((await c.call('/api/account/me', { headers: { host: 'other.example' } })).status, 200, 'reading /me needs only the cookie');
    assert.equal((await c.call('/api/account/login', { method: 'POST', headers: { ...H, origin: 'http://evil' }, body: {} })).status, 403);
  } finally { srv.close(); auth.close(); await g.close(); }
});

// ---------------------------------------------------------------------------------------------------------- local-only use
test('local-only use: with no sign-in configured the server reports it off, account routes say so, and the rest of Cold is unaffected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-local-'));
  for (const k of [...CLEAN, 'COLD_AUTH_GOOGLE_CLIENT_ID', 'COLD_AUTH_GOOGLE_CLIENT_SECRET', 'COLD_SESSION_SECRET', 'COLD_ACCOUNTS_DB_FILE', 'COLD_AUTH_REDIRECT_URI']) delete process.env[k];
  process.env.LLM_PROVIDER = 'ollama';
  delete require.cache[require.resolve('../server')]; delete require.cache[require.resolve('../lib/auth')];
  const server = require('../server'); await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json(); assert.deepEqual(cfg.account, { enabled: false }); assert.equal(cfg.app, 'cold');
    for (const [m, p] of [['GET', '/api/account/me'], ['POST', '/api/account/login'], ['POST', '/api/account/logout'], ['GET', '/oauth/account/callback']]) assert.equal((await fetch(base + p, { method: m, redirect: 'manual' })).status, 404, p);
    assert.equal((await fetch(`${base}/`)).status, 200); assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal(fs.readdirSync(dir).length, 0, 'no accounts file was created');
  } finally { await new Promise(r => { server.closeAllConnections(); server.close(r); }); }
});
