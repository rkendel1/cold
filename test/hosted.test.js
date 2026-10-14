// The hosted library on the server (lib/hosted.js, lib/hostedDb.js): ownership, isolation, authentication on both session kinds, validation, integrity and persistence.
// Sign-in uses a STAND-IN for Google (test/helpers/google-mock.js); these tests prove Cold's own server logic, not real Google sign-in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { startGoogle, client } = require('./helpers/google-mock');
const SECRET = 'hosted-test-session-secret-0123456789abcdef-XYZ';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop', EXT_REDIRECT = `https://${EXT_ID}.chromiumapp.org/`, EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const DESKTOP = 'http://127.0.0.1:47999/oauth/account/callback';
const b64 = buf => Buffer.from(buf).toString('base64url');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const CLEAN = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN', 'COLD_DB_FILE', 'COLD_SETTINGS_FILE', 'COLD_ACCOUNT_URL', 'NODE_ENV', 'VERCEL_ENV', 'COLD_DATA_DB_FILE'];

async function boot(google, { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-hosted-')), hostedFile = true, port } = {}) {
  port = port || await freePort();
  for (const k of CLEAN) delete process.env[k];
  Object.assign(process.env, { LLM_PROVIDER: 'ollama', COLD_AUTH_GOOGLE_CLIENT_ID: google.clientId, COLD_AUTH_GOOGLE_CLIENT_SECRET: google.clientSecret, COLD_SESSION_SECRET: SECRET, COLD_AUTH_RATE_LIMIT_PER_MIN: '5000',
    COLD_ACCOUNTS_DB_FILE: path.join(dir, 'accounts.db'), COLD_AUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/account/callback`, COLD_AUTH_NATIVE_REDIRECTS: `${EXT_REDIRECT},${DESKTOP}`, ...google.urls });
  if (hostedFile) process.env.COLD_DATA_DB_FILE = path.join(dir, 'hosted.db');
  delete require.cache[require.resolve('../server')]; delete require.cache[require.resolve('../lib/auth')];
  const server = require('../server'); await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${port}`, port, dir, accounts: server.auth.accounts, store: server.hosted.store, web: () => client(`http://127.0.0.1:${port}`),
    close: () => new Promise(r => { if (!server.listening) return r(); server.closeAllConnections(); server.close(() => { try { server.auth.close(); server.hosted.close(); } catch { /* closed */ } r(); }); }) };
}
const call = (base, p, { method = 'GET', headers = {}, body } = {}) => fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
/** A signed-in browser: the cookie client plus a helper that sends the CSRF token on writes. */
async function webUser(t, g, person) {
  g.person = person; const c = t.web(); await c.signIn(); const me = await (await c.call('/api/account/me')).json();
  const h = r => r.then(async x => ({ status: x.status, body: await x.json().catch(() => null), headers: x.headers }));
  return { c, csrf: me.csrf, get: p => h(c.call(p)), write: (p, method, body, hdrs = {}) => h(c.call(p, { method, body, headers: { 'x-cold-csrf': me.csrf, ...hdrs } })) };
}
async function nativeUser(t, g, person, { kind = 'desktop' } = {}) {
  g.person = person; const proof = b64(crypto.randomBytes(32));
  const redirectUri = kind === 'desktop' ? DESKTOP : EXT_REDIRECT, origin = kind === 'extension' ? EXT_ORIGIN : undefined;
  const begin = await (await call(t.base, '/api/account/native/begin', { method: 'POST', headers: origin ? { origin } : {}, body: { client: kind, redirectUri, proof: b64(crypto.createHash('sha256').update(proof).digest()) } })).json();
  const back = new URL((await fetch(begin.authUrl, { redirect: 'manual' })).headers.get('location'));
  const done = await (await call(t.base, '/api/account/native/complete', { method: 'POST', headers: origin ? { origin } : {}, body: { state: begin.state, code: back.searchParams.get('code'), proof } })).json();
  const hdr = (extra = {}) => ({ authorization: `Bearer ${done.token}`, ...(origin ? { origin } : {}), ...extra });
  const h = r => r.then(async x => ({ status: x.status, body: await x.json().catch(() => null), headers: x.headers }));
  return { token: done.token, get: p => h(call(t.base, p, { headers: hdr() })), write: (p, method, body, hdrs = {}) => h(call(t.base, p, { method, body, headers: hdr(hdrs) })), raw: (p, o = {}) => call(t.base, p, { ...o, headers: hdr(o.headers) }) };
}
const A = { sub: 'acct-a', name: 'Alice', email: 'alice@example.com', email_verified: true }, B = { sub: 'acct-b', name: 'Bob', email: 'bob@example.com', email_verified: true };
const LEAD = (id, o = {}) => ({ id, name: `Lead ${id}`, company: 'Acme', email: `${id}@acme.io`, list: 'Q4', createdAt: 5, custom: { Region: 'EU' }, ...o });
const MAIL = (id, o = {}) => ({ createdAt: 1000, status: 'draft', mode: 'email', recipient: { name: 'Sam', company: 'Co', email: 'sam@co.io', leadId: 'l1' }, productId: 'p1', subject: 's', what: 'w', why: 'y', ask: 'a', note: 'n', futureField: { keep: 1 }, ...o });

test('config: the hosted data file must be its own file, persistent in production, and only with sign-in enabled', () => {
  const { readConfig } = require('../lib/auth');
  const good = { COLD_AUTH_GOOGLE_CLIENT_ID: 'id', COLD_AUTH_GOOGLE_CLIENT_SECRET: 's', COLD_SESSION_SECRET: SECRET, COLD_ACCOUNTS_DB_FILE: '/data/accounts.db', COLD_AUTH_REDIRECT_URI: 'https://cold.example.com/oauth/account/callback', NODE_ENV: 'production' };
  assert.equal(readConfig({ ...good, COLD_DATA_DB_FILE: '/data/hosted.db' }).dataFile, '/data/hosted.db'); assert.equal(readConfig(good).dataFile, '');
  for (const bad of ['/data/accounts.db', 'hosted.db', '/tmp/hosted.db', '/var/tmp/x/hosted.db', os.tmpdir() + '/hosted.db', ':memory:']) assert.throws(() => readConfig({ ...good, COLD_DATA_DB_FILE: bad }), /COLD_DATA_DB_FILE/, bad);
  assert.throws(() => readConfig({ ...good, COLD_ACCOUNTS_DB_FILE: 'relative.db' }), /COLD_ACCOUNTS_DB_FILE/);
  assert.equal(readConfig({ ...good, NODE_ENV: undefined, COLD_DATA_DB_FILE: '/tmp/dev-hosted.db' }).dataFile, '/tmp/dev-hosted.db', 'development may use any path');
  const run = env => spawnSync(process.execPath, ['-e', "require('./server');console.log('loaded');process.exit(0)"], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const noSignIn = run({ COLD_DATA_DB_FILE: '/tmp/x-hosted.db' }); assert.notEqual(noSignIn.status, 0); assert.match(noSignIn.stderr, /COLD_DATA_DB_FILE is set but Google sign-in is not enabled/);
  const unwritable = run({ COLD_AUTH_GOOGLE_CLIENT_ID: 'id', COLD_AUTH_GOOGLE_CLIENT_SECRET: 's', COLD_SESSION_SECRET: SECRET, COLD_ACCOUNTS_DB_FILE: path.join(os.tmpdir(), 'cold-a-' + process.pid + '.db'), COLD_AUTH_REDIRECT_URI: 'http://localhost:3000/oauth/account/callback', COLD_DATA_DB_FILE: '/dev/null/hosted.db' });
  assert.notEqual(unwritable.status, 0); assert.match(unwritable.stderr, /Couldn't open the hosted data file/);
  assert.equal(run({}).stdout.trim(), 'loaded', 'an unconfigured server starts');
});

test('every hosted route needs a valid session; without a data file the routes are off; sessions of the two kinds are not interchangeable', async () => {
  const g = await startGoogle(), off = await boot(g, { hostedFile: false });
  try {
    for (const [m, p] of [['GET', '/api/hosted/library'], ['POST', '/api/hosted/library'], ['GET', '/api/hosted/data']]) assert.equal((await call(off.base, p, { method: m })).status, 404);
    assert.equal((await (await call(off.base, '/api/hosted/library')).json()).error.code, 'hosted_disabled');
    assert.deepEqual((await (await fetch(`${off.base}/api/config`)).json()).account, { enabled: true, native: true, hosted: false });
  } finally { await off.close(); }
  const t = await boot(g);
  try {
    assert.deepEqual((await (await fetch(`${t.base}/api/config`)).json()).account, { enabled: true, native: true, hosted: true });
    const routes = [['GET', '/api/hosted/library'], ['POST', '/api/hosted/library', {}], ['GET', '/api/hosted/data'], ['GET', '/api/hosted/data/version'], ['PUT', '/api/hosted/data/leads/l1', LEAD('l1')], ['DELETE', '/api/hosted/data/leads/l1'], ['PUT', '/api/hosted/data/settings', {}]];
    for (const [method, p, body] of routes) {
      assert.equal((await call(t.base, p, { method, body })).status, 401, `${method} ${p} signed out`);
      assert.equal((await call(t.base, p, { method, body, headers: { authorization: 'Bearer ' + 'x'.repeat(43) } })).status, 401, 'garbage bearer');
      assert.equal((await call(t.base, p, { method, body, headers: { cookie: 'cold_session=' + 'x'.repeat(43) } })).status, 401, 'garbage cookie');
    }
    const u = await webUser(t, g, A); assert.equal((await u.get('/api/hosted/library')).status, 200);
    // a cookie session id is not a bearer token, and a bearer token is not a cookie
    assert.equal((await call(t.base, '/api/hosted/library', { headers: { authorization: `Bearer ${u.c.jar.cold_session}` } })).status, 401);
    const n = await nativeUser(t, g, A); const asCookie = client(t.base); asCookie.jar.cold_session = n.token; assert.equal((await asCookie.call('/api/hosted/library')).status, 401);
    // a request with a bad bearer does not fall back to a valid cookie
    assert.equal((await u.c.call('/api/hosted/library', { headers: { authorization: 'Bearer ' + 'y'.repeat(43) } })).status, 401);
    // expired and revoked sessions stop working at once
    const accId = t.accounts.sessionAccount(u.c.jar.cold_session).id, dead = t.accounts.createSession(accId, -1000), e = client(t.base); e.jar.cold_session = dead.id;
    assert.equal((await e.call('/api/hosted/library')).status, 401);
    t.accounts.destroySession(u.c.jar.cold_session); assert.equal((await u.get('/api/hosted/library')).status, 401, 'revoked');
    const raw = new (require('node:sqlite').DatabaseSync)(path.join(t.dir, 'accounts.db')); raw.exec('DELETE FROM sessions'); raw.close(); assert.equal((await n.get('/api/hosted/library')).status, 401, 'revoked bearer');
  } finally { await t.close(); await g.close(); }
});

test('create, read, update and delete: leads, drafts (with their lead and product references), products and settings; the library must be created explicitly', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const u = await webUser(t, g, A);
    assert.deepEqual((await u.get('/api/hosted/library')).body, { exists: false });
    assert.equal((await u.get('/api/hosted/data')).status, 404, 'no library yet'); assert.equal((await u.write('/api/hosted/data/leads/l1', 'PUT', LEAD('l1'))).body.error.code, 'no_library');
    const made = await u.write('/api/hosted/library', 'POST', {}); assert.equal(made.body.created, true); assert.deepEqual([made.body.leads, made.body.emails, made.body.products], [0, 0, 0]);
    assert.equal((await u.write('/api/hosted/library', 'POST', {})).body.created, false, 'creating twice changes nothing');
    const empty = (await u.get('/api/hosted/data')).body; assert.deepEqual([empty.leads, empty.emails, empty.products], [[], [], []]); assert.equal(empty.compose, null);
    assert.equal((await u.write('/api/hosted/data/products/p1', 'PUT', { name: 'Acme Flow', what: 'books jobs', order: 0 })).status, 200);
    assert.equal((await u.write('/api/hosted/data/leads/l1', 'PUT', LEAD('l1'))).status, 200);
    const saved = await u.write('/api/hosted/data/emails/e1', 'PUT', MAIL('e1')); assert.equal(saved.status, 200); assert.ok(Number.isFinite(saved.body.updatedAt));
    const snap = (await u.get('/api/hosted/data')).body;
    assert.deepEqual([snap.leads.length, snap.emails.length, snap.products.length], [1, 1, 1]);
    assert.deepEqual(snap.emails[0].recipient, MAIL('e1').recipient); assert.equal(snap.emails[0].recipient.leadId, 'l1'); assert.equal(snap.emails[0].productId, 'p1'); assert.deepEqual(snap.emails[0].futureField, { keep: 1 }, 'unknown fields are kept');
    assert.deepEqual(snap.leads[0].custom, { Region: 'EU' }); assert.equal(snap.emails[0].note, 'n');
    // outreach: sent, notes, follow-up, reply, history all travel in the record
    const rec = { ...MAIL('e1'), status: 'sent', sentAt: 2222, handoffs: [{ at: 1, how: 'copy' }], followUp: { due: 99999, count: 1, auto: true }, sentCopy: { subject: 's', text: 't', at: 2222 }, note: 'call Tue' };
    const upd = await u.write(`/api/hosted/data/emails/e1?base=${saved.body.updatedAt}`, 'PUT', rec); assert.equal(upd.status, 200); assert.ok(upd.body.updatedAt > saved.body.updatedAt);
    const after = (await u.get('/api/hosted/data')).body.emails[0]; assert.deepEqual([after.status, after.sentAt, after.followUp.due, after.handoffs.length, after.sentCopy.at, after.note], ['sent', 2222, 99999, 1, 2222, 'call Tue']);
    assert.equal((await u.write('/api/hosted/data/emails/e1', 'PUT', { ...rec, status: 'replied', repliedAt: 3333 })).status, 200);
    assert.equal((await u.get('/api/hosted/data')).body.emails[0].repliedAt, 3333);
    // stale and duplicate semantics
    const stale = await u.write(`/api/hosted/data/emails/e1?base=${saved.body.updatedAt}`, 'PUT', { ...rec, note: 'stale' }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'conflict'); assert.equal(stale.body.current.status, 'replied');
    assert.equal((await u.write('/api/hosted/data/emails/e1?base=new', 'PUT', rec)).status, 409, 'creating something that exists is refused explicitly');
    assert.equal((await u.write('/api/hosted/data/emails/e1', 'PUT', { ...rec, status: 'replied', repliedAt: 3333 })).status, 200); assert.equal((await u.get('/api/hosted/data')).body.emails.length, 1, 'retrying a PUT creates no duplicate');
    // settings: only the library's own settings are stored
    const v0 = (await u.get('/api/hosted/data/version')).body.version;
    await u.write('/api/hosted/data/settings', 'PUT', { signature: 'Randy', signoffProduct: false, followUp: { hour: 11 }, emailApp: 'gmail', gmailAccount: 'x@gmail.com', provider: 'p' });
    assert.deepEqual((await u.get('/api/hosted/data')).body.settings, { signature: 'Randy', signoffProduct: false, followUp: { hour: 11 } }); assert.ok((await u.get('/api/hosted/data/version')).body.version > v0);
    // delete (idempotent), and what the lead's removal does to drafts matches the app: nothing (the reference just no longer resolves)
    assert.equal((await u.write('/api/hosted/data/leads/l1', 'DELETE')).status, 200); assert.equal((await u.write('/api/hosted/data/leads/l1', 'DELETE')).status, 200);
    const end = (await u.get('/api/hosted/data')).body; assert.deepEqual([end.leads.length, end.emails.length], [0, 1]);
    assert.equal((await u.write('/api/hosted/data/emails/e1', 'DELETE')).status, 200); assert.equal((await u.get('/api/hosted/data')).body.emails.length, 0);
  } finally { await t.close(); await g.close(); }
});

test('isolation: two accounts cannot read, change or delete each other\'s records, whatever ids, bodies, queries, headers or cookies they send', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const a = await webUser(t, g, A), b = await webUser(t, g, B);
    const accA = t.accounts.sessionAccount(a.c.jar.cold_session).id, accB = t.accounts.sessionAccount(b.c.jar.cold_session).id; assert.notEqual(accA, accB);
    for (const u of [a, b]) await u.write('/api/hosted/library', 'POST', {});
    await a.write('/api/hosted/data/leads/shared-id', 'PUT', LEAD('shared-id', { company: 'A-ONLY-SECRET-CO' })); await a.write('/api/hosted/data/emails/mail-a', 'PUT', MAIL('mail-a', { note: 'A-PRIVATE-NOTE' })); await a.write('/api/hosted/data/products/pa', 'PUT', { name: 'A product', what: 'x' });
    const aSnap = JSON.stringify((await a.get('/api/hosted/data')).body);
    // B sees nothing of A's, in the snapshot or by id
    const bSnap = (await b.get('/api/hosted/data')).body; assert.deepEqual([bSnap.leads.length, bSnap.emails.length, bSnap.products.length], [0, 0, 0]); assert.ok(!JSON.stringify(bSnap).includes('A-PRIVATE'));
    // B writing under A's ids creates B's OWN records: A's are untouched
    assert.equal((await b.write('/api/hosted/data/leads/shared-id', 'PUT', LEAD('shared-id', { company: 'B-CO' }))).status, 200);
    assert.equal((await b.write('/api/hosted/data/emails/mail-a', 'PUT', MAIL('mail-a', { note: 'B-NOTE' }))).status, 200);
    assert.equal(JSON.stringify((await a.get('/api/hosted/data')).body), aSnap, 'A\'s whole library is byte-for-byte what it was');
    assert.equal((await a.get('/api/hosted/data')).body.leads[0].company, 'A-ONLY-SECRET-CO'); assert.equal((await a.get('/api/hosted/data')).body.emails[0].note, 'A-PRIVATE-NOTE');
    // a conditional write against A's version can't be used to learn A's record: B's id is B's
    const probe = await b.write(`/api/hosted/data/emails/mail-a?base=1`, 'PUT', MAIL('mail-a')); assert.ok(!JSON.stringify(probe.body).includes('A-PRIVATE'), 'a conflict never carries another account\'s record');
    // B deleting by A's ids deletes only B's
    await b.write('/api/hosted/data/leads/shared-id', 'DELETE'); await b.write('/api/hosted/data/emails/mail-a', 'DELETE'); await b.write('/api/hosted/data/products/pa', 'DELETE');
    const a2 = (await a.get('/api/hosted/data')).body; assert.deepEqual([a2.leads.length, a2.emails.length, a2.products.length], [1, 1, 1], 'A still has everything');
    // ownership can't be named by the client: in the body, the query, headers, cookies or the path
    for (const owner of [{ accountId: accA }, { account_id: accA }, { owner: accA }, { ownerId: accA }, { userId: accA }]) { const r = await b.write('/api/hosted/data/leads/x1', 'PUT', LEAD('x1', owner)); assert.equal(r.status, 400, JSON.stringify(owner)); assert.match(r.body.error.message, /owner/); }
    const q = await b.get(`/api/hosted/data?account=${accA}&accountId=${accA}&owner=${accA}`); assert.deepEqual(q.body.leads, []);
    const hdr = await b.c.call('/api/hosted/data', { headers: { 'x-account-id': accA, 'x-cold-account': accA } }); assert.deepEqual((await hdr.json()).leads, []);
    const forged = client(t.base); forged.jar.cold_session = accA; forged.jar.account_id = accA; assert.equal((await forged.call('/api/hosted/data')).status, 401);
    for (const p of [`/api/hosted/accounts/${accA}/data`, `/api/hosted/${accA}/data`, `/api/hosted/library/${accA}`, '/api/hosted/data/leads']) assert.ok([404, 405].includes((await b.c.call(p)).status), p);
    // the same holds for bearer sessions (desktop and extension) and across kinds: B's desktop token reaches B's library only
    const bd = await nativeUser(t, g, B), be = await nativeUser(t, g, B, { kind: 'extension' }), ad = await nativeUser(t, g, A);
    assert.equal((await bd.get('/api/hosted/data')).body.leads.length, 0); assert.equal((await be.get('/api/hosted/data')).body.leads.length, 0); assert.equal((await ad.get('/api/hosted/data')).body.leads.length, 1);
    assert.equal((await bd.write('/api/hosted/data/leads/shared-id', 'PUT', LEAD('shared-id', { accountId: accA }))).status, 400);
    assert.equal((await bd.raw(`/api/hosted/data?account=${accA}`, {})).status, 200); assert.equal((await ad.get('/api/hosted/data')).body.leads[0].company, 'A-ONLY-SECRET-CO');
    // raw rows: every row of both accounts carries its own owner, and none is ownerless
    const raw = new (require('node:sqlite').DatabaseSync)(path.join(t.dir, 'hosted.db'), { readOnly: true });
    assert.deepEqual(raw.prepare('SELECT account_id, COUNT(*) n FROM leads GROUP BY account_id ORDER BY account_id').all().map(r => r.account_id).sort(), [accA].sort()); raw.close();
  } finally { await t.close(); await g.close(); }
});

test('cookie sessions need same-origin and the CSRF token for every change; bearer sessions need a registered origin; no CORS for anyone else', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const u = await webUser(t, g, A); await u.write('/api/hosted/library', 'POST', {});
    const bad = async (hdrs, csrf = u.csrf) => (await u.c.call('/api/hosted/data/leads/l1', { method: 'PUT', body: LEAD('l1'), headers: { ...(csrf ? { 'x-cold-csrf': csrf } : {}), ...hdrs } })).status;
    assert.equal(await bad({}, null), 403, 'no token'); assert.equal(await bad({}, 'wrong'), 403); assert.equal(await bad({ origin: 'https://evil.example' }), 403); assert.equal(await bad({ 'sec-fetch-site': 'cross-site' }), 403); assert.equal(await bad({ host: 'evil.example' }), 403);
    assert.equal((await u.c.call('/api/hosted/library', { method: 'POST', body: {}, headers: {} })).status, 403, 'POST without the token');
    assert.equal((await u.c.call('/api/hosted/data/leads/l1', { method: 'DELETE' })).status, 403);
    assert.equal((await u.c.call('/api/hosted/data', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'a cross-site read');
    assert.equal((await u.get('/api/hosted/data')).body.leads.length, 0, 'none of those refused writes landed');
    assert.equal((await u.write('/api/hosted/data/leads/l1', 'PUT', LEAD('l1'))).status, 200);
    // the CSRF token of one session is no good for another
    const o = await webUser(t, g, B); await o.write('/api/hosted/library', 'POST', {}); assert.equal((await o.c.call('/api/hosted/data/leads/l9', { method: 'PUT', body: LEAD('l9'), headers: { 'x-cold-csrf': u.csrf } })).status, 403);
    // bearer: a web page's origin is refused; the registered extension gets CORS; another extension doesn't
    const d = await nativeUser(t, g, A), e = await nativeUser(t, g, A, { kind: 'extension' });
    assert.equal((await d.write('/api/hosted/data/leads/l2', 'PUT', LEAD('l2'), { origin: 'https://evil.example' })).status, 403); assert.equal((await d.get('/api/hosted/data')).headers.get('access-control-allow-origin'), null);
    const ok = await e.write('/api/hosted/data/leads/l3', 'PUT', LEAD('l3')); assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), EXT_ORIGIN);
    assert.equal((await e.get('/api/hosted/data')).headers.get('access-control-allow-origin'), EXT_ORIGIN);
    assert.equal((await call(t.base, '/api/hosted/data', { headers: { authorization: `Bearer ${e.token}`, origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' } })).status, 403);
    const pre = await call(t.base, '/api/hosted/data/leads/l3', { method: 'OPTIONS', headers: { origin: EXT_ORIGIN, 'access-control-request-method': 'PUT' } }); assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), EXT_ORIGIN);
    assert.equal((await call(t.base, '/api/hosted/data', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal(ok.headers.get('access-control-allow-credentials'), null, 'CORS never allows cookies');
    // the bearer needs no CSRF token (it is not ambient) and the same data is reachable from all three kinds of client
    assert.deepEqual((await u.get('/api/hosted/data')).body.leads.map(l => l.id).sort(), ['l1', 'l3']);
  } finally { await t.close(); await g.close(); }
});

test('validation: malformed, oversized, credential-bearing and unsupported records are refused with clear, content-free errors; nothing is stored by a refusal', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const u = await webUser(t, g, A); await u.write('/api/hosted/library', 'POST', {});
    const put = (p, body, m = 'PUT') => u.write(p, m, body);
    const cases = [
      ['/api/hosted/data/leads/bad id!', LEAD('x'), 400], ['/api/hosted/data/leads/' + 'x'.repeat(101), LEAD('x'), 400], ['/api/hosted/data/leads/l1', LEAD('other-id', {}), 400], ['/api/hosted/data/leads/l1', { company: 'no name' }, 400],
      ['/api/hosted/data/leads/l1', LEAD('l1', { name: 5 }), 400], ['/api/hosted/data/leads/l1', LEAD('l1', { custom: [] }), 400], ['/api/hosted/data/products/p1', { what: 'no name' }, 400], ['/api/hosted/data/emails/e1', { subject: 'no recipient' }, 400],
      ['/api/hosted/data/emails/e1', MAIL('e1', { recipient: 'sam' }), 400], ['/api/hosted/data/emails/e1', MAIL('e1', { handoffs: {} }), 400], ['/api/hosted/data/emails/e1', MAIL('e1', { sentAt: 'yesterday' }), 400],
      ['/api/hosted/data/leads/l1', LEAD('l1', { apiKey: 'sk-SECRET' }), 400], ['/api/hosted/data/emails/e1', MAIL('e1', { facts: { token: 'x' } }), 400], ['/api/hosted/data/leads/l1', LEAD('l1', { custom: { Password: 'x' } }), 400],
      ['/api/hosted/data/leads/l1', JSON.parse('{"name":"x","__proto__":{"a":1}}'), 400], ['/api/hosted/data/widgets/w1', { name: 'x' }, 404], ['/api/hosted/data/compose', { name: 'Jim' }, 404], ['/api/hosted/data/other', {}, 404],
      ['/api/hosted/data/leads/l1', LEAD('l1', { notes: 'x'.repeat(520 * 1024) }), 413], ['/api/hosted/data/leads/l1?base=abc', LEAD('l1'), 400], ['/api/hosted/data/leads/l1?base=-1', LEAD('l1'), 400],
    ];
    for (const [p, body, status] of cases) { const r = await put(p, body); assert.equal(r.status, status, p + ' ' + JSON.stringify(body).slice(0, 60)); assert.ok(!JSON.stringify(r.body).includes('sk-SECRET'), 'a refusal never echoes the content'); }
    assert.equal((await put('/api/hosted/data/leads/l1', '{not json')).status, 400); assert.equal((await put('/api/hosted/data/leads/l1', '[]')).status, 400);
    assert.equal((await put('/api/hosted/data/leads/l1', 'x'.repeat(700 * 1024))).status, 413);
    const snap = (await u.get('/api/hosted/data')).body; assert.deepEqual([snap.leads.length, snap.emails.length, snap.products.length], [0, 0, 0], 'no refused write was stored');
    assert.equal((await u.get('/api/hosted/data/leads/%zz')).status, 400);
    assert.equal((await u.write('/api/hosted/data/leads/%zz', 'DELETE')).status, 400);
  } finally { await t.close(); await g.close(); }
});

test('integrity: a change that fails part-way is rolled back whole; storage errors are generic and never reported as saved; one read is one consistent moment', async () => {
  const g = await startGoogle(), t = await boot(g);
  try {
    const u = await webUser(t, g, A); await u.write('/api/hosted/library', 'POST', {});
    await u.write('/api/hosted/data/leads/l1', 'PUT', LEAD('l1')); await u.write('/api/hosted/data/settings', 'PUT', { signature: 'One' });
    const v = (await u.get('/api/hosted/data/version')).body.version, before = JSON.stringify((await u.get('/api/hosted/data')).body);
    // break storage underneath the server: the settings change would bump the version AND write the document
    const raw = new (require('node:sqlite').DatabaseSync)(path.join(t.dir, 'hosted.db')); raw.exec('PRAGMA foreign_keys = OFF'); raw.exec('ALTER TABLE meta RENAME TO meta_gone'); raw.close();
    const r = await u.write('/api/hosted/data/settings', 'PUT', { signature: 'Two' }); assert.equal(r.status, 500); assert.deepEqual(r.body.error, { code: 'storage_failed', message: "Couldn't save. Nothing was changed." });
    assert.ok(!/sqlite|no such table|meta/i.test(JSON.stringify(r.body)), 'no database detail in the response');
    const raw2 = new (require('node:sqlite').DatabaseSync)(path.join(t.dir, 'hosted.db')); assert.equal(raw2.prepare("SELECT version FROM libraries").get().version, v, 'the version did not move: the whole change was rolled back'); raw2.exec('ALTER TABLE meta_gone RENAME TO meta'); raw2.close();
    assert.equal(JSON.stringify((await u.get('/api/hosted/data')).body), before, 'nothing changed');
    assert.equal((await u.write('/api/hosted/data/settings', 'PUT', { signature: 'Two' })).status, 200);
    // writing into a library that does not exist leaves no rows
    const other = await webUser(t, g, B); assert.equal((await other.write('/api/hosted/data/leads/l1', 'PUT', LEAD('l1'))).status, 404);
    const raw3 = new (require('node:sqlite').DatabaseSync)(path.join(t.dir, 'hosted.db'), { readOnly: true }); assert.equal(raw3.prepare('SELECT COUNT(*) n FROM leads').get().n, 1); raw3.close();
    // a version mismatch is explicit, not silent
    assert.equal((await u.write('/api/hosted/data/leads/l1?base=1', 'PUT', LEAD('l1'))).status, 409);
  } finally { await t.close(); await g.close(); }
});

test('persistence: records survive a server restart, the schema upgrade is repeatable, a newer schema is refused untouched, and accounts and hosted data live in separate files', async () => {
  const g = await startGoogle(); let t = await boot(g); const dir = t.dir, port = t.port;
  try {
    const u = await webUser(t, g, A); await u.write('/api/hosted/library', 'POST', {});
    await u.write('/api/hosted/data/leads/l1', 'PUT', LEAD('l1')); await u.write('/api/hosted/data/emails/e1', 'PUT', MAIL('e1', { status: 'sent', sentAt: 5 })); await u.write('/api/hosted/data/products/p1', 'PUT', { name: 'P', what: 'w' });
    const cookie = u.c.jar.cold_session; const before = (await u.get('/api/hosted/data')).body;
    await t.close();                                                              // the server stops completely
    t = await boot(g, { dir, port });                                             // and starts again on the same files
    const again = client(t.base); again.jar.cold_session = cookie;                // the same signed-in browser (the session is in the accounts file too)
    const after = await (await again.call('/api/hosted/data')).json(); assert.deepEqual(after.leads, before.leads); assert.deepEqual(after.emails, before.emails); assert.deepEqual(after.products, before.products); assert.equal(after.version, before.version);
    // separate files
    const { DatabaseSync } = require('node:sqlite'), names = f => { const d = new DatabaseSync(path.join(dir, f), { readOnly: true }); const n = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name); d.close(); return n; };
    assert.ok(!names('accounts.db').some(n => ['leads', 'emails', 'products', 'libraries'].includes(n)), 'no hosted records in the accounts file'); assert.ok(!names('hosted.db').some(n => ['accounts', 'sessions', 'identities', 'sign_in'].includes(n)), 'no accounts or sessions in the hosted file');
    await t.close();
    // repeated initialisation leaves the data alone; two processes opening at once are safe
    const { openHostedDb } = require('../lib/hostedDb'), f = path.join(dir, 'hosted.db'); const x = openHostedDb(f), y = openHostedDb(f);
    const owner = (() => { const d = new DatabaseSync(f, { readOnly: true }); const id = d.prepare('SELECT account_id FROM libraries').get().account_id; d.close(); return id; })();
    const sn = x.summary(owner);
    assert.equal(sn.leads, 1); x.close(); y.close();
    // a file from a newer Cold is refused and left exactly as it was
    const d = new DatabaseSync(f); d.exec('PRAGMA user_version = 99'); d.close(); const bytes = fs.readFileSync(f);
    assert.throws(() => openHostedDb(f), /newer Cold/); assert.ok(fs.readFileSync(f).equals(bytes), 'nothing was changed');
    const d2 = new DatabaseSync(f); d2.exec('PRAGMA user_version = 1'); d2.close();
    // the accounts file from before hosted libraries existed is used unchanged
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-hosted-old-')); fs.copyFileSync(path.join(dir, 'accounts.db'), path.join(oldDir, 'accounts.db'));
    t = await boot(g, { dir: oldDir, hostedFile: true }); const w = await webUser(t, g, A); assert.equal((await w.get('/api/hosted/library')).body.exists, false, 'a fresh hosted file starts with no libraries'); assert.equal(t.accounts.counts().accounts >= 1, true);
  } finally { await t.close(); await g.close(); }
});

test('hosted code writes no logs and keeps nothing in process memory', () => {
  const code = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['lib/hosted.js', 'lib/hostedDb.js']) assert.ok(!/console\.(log|info|warn|error|debug)/.test(code(f)), `${f} logs nothing`);
  assert.ok(!/new Map\(|cache|memo/.test(code('lib/hostedDb.js')), 'hosted records are read from the file every time');
});
