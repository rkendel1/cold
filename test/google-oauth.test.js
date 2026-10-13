const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleOAuth } = require('../lib/google');

const memSettings = () => { let rt = ''; return { integrationKey: n => (n === 'google' ? rt : ''), update: p => { const g = p.integrations && p.integrations.google; if (g) rt = g.apiKey || ''; }, get saved() { return rt; } }; };
const fakeGoogle = (script = []) => { const calls = []; const fetchImpl = async (url, init) => { const body = Object.fromEntries(new URLSearchParams(init.body)); calls.push({ url, body }); const r = script.shift() || { status: 200, body: {} }; return { ok: r.status < 300, status: r.status, json: async () => r.body }; }; return { fetchImpl, calls }; };

test('Google sign-in (desktop): PKCE, only the narrow scope, the refresh token is kept server-side and the page gets short-lived tokens', async () => {
  const settings = memSettings(), g = fakeGoogle([{ status: 200, body: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' } }, { status: 200, body: { access_token: 'AT2', expires_in: 3600 } }]);
  let t = 1000; const oauth = createGoogleOAuth({ clientId: 'cid', clientSecret: 'sec', settings, fetchImpl: g.fetchImpl, now: () => t });
  assert.deepEqual(oauth.status(), { configured: true, connected: false, error: '' });
  const { url } = oauth.start({ redirectUri: 'http://127.0.0.1:47821/oauth/google/callback' });
  const q = new URL(url).searchParams;
  assert.deepEqual([q.get('scope'), q.get('code_challenge_method'), q.get('access_type'), q.get('response_type'), q.get('redirect_uri')], ['https://www.googleapis.com/auth/drive.file', 'S256', 'offline', 'code', 'http://127.0.0.1:47821/oauth/google/callback']);
  assert.ok(q.get('code_challenge').length >= 40 && q.get('state').length >= 20);
  // a callback with a state we didn't issue is refused and exchanges nothing
  assert.equal((await oauth.callback({ code: 'c', state: 'forged' })).ok, false); assert.equal(g.calls.length, 0);
  const ok = await oauth.callback({ code: 'CODE', state: q.get('state') });
  assert.equal(ok.ok, true); assert.equal(settings.saved, 'RT1');
  assert.equal(g.calls[0].body.grant_type, 'authorization_code'); assert.ok(g.calls[0].body.code_verifier.length >= 43); assert.equal(g.calls[0].body.client_secret, 'sec');
  assert.equal((await oauth.callback({ code: 'CODE', state: q.get('state') })).ok, false, 'a state can be used once');
  assert.equal((await oauth.token()).accessToken, 'AT1', 'a fresh token is reused'); assert.equal(g.calls.length, 1);
  t += 3600 * 1000;
  assert.equal((await oauth.token()).accessToken, 'AT2'); assert.deepEqual([g.calls[1].body.grant_type, g.calls[1].body.refresh_token], ['refresh_token', 'RT1']);
  assert.equal(oauth.status().connected, true);
});

test('Google sign-in (desktop): refusals, missing scope, revoked tokens and disconnect', async () => {
  const settings = memSettings(), g = fakeGoogle([{ status: 200, body: { access_token: 'A', refresh_token: 'R', expires_in: 3600, scope: 'openid' } }]);
  const oauth = createGoogleOAuth({ clientId: 'cid', settings, fetchImpl: g.fetchImpl });
  assert.throws(() => createGoogleOAuth({ clientId: '', settings }).start({ redirectUri: 'x' }), e => e.code === 'google_not_configured');
  let s = new URL(oauth.start({ redirectUri: 'http://127.0.0.1:1/cb' }).url).searchParams.get('state');
  assert.match((await oauth.callback({ error: 'access_denied', state: s })).message, /chose not to/);
  s = new URL(oauth.start({ redirectUri: 'http://127.0.0.1:1/cb' }).url).searchParams.get('state');
  assert.match((await oauth.callback({ code: 'x', state: s })).message, /tick the box/); assert.equal(settings.saved, '', 'nothing is kept without the Drive scope');
  await assert.rejects(oauth.token(), e => e.code === 'google_auth' && e.status === 401);
  settings.update({ integrations: { google: { apiKey: 'OLD' } } });
  const g2 = fakeGoogle([{ status: 400, body: { error: 'invalid_grant' } }]); const o2 = createGoogleOAuth({ clientId: 'cid', settings, fetchImpl: g2.fetchImpl });
  await assert.rejects(o2.token(), e => e.code === 'google_auth'); assert.equal(settings.saved, '', 'a revoked sign-in is forgotten');
  settings.update({ integrations: { google: { apiKey: 'R2' } } });
  const g3 = fakeGoogle(); const o3 = createGoogleOAuth({ clientId: 'cid', settings, fetchImpl: g3.fetchImpl });
  await o3.disconnect(); assert.equal(settings.saved, ''); assert.match(g3.calls[0].url, /revoke/); assert.equal(g3.calls[0].body.token, 'R2');
});

test('desktop server: sign-in routes work end to end against a stand-in for Google, are guarded like Settings, and never hand out the refresh token', async () => {
  const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'); const env = require('./helpers/env');
  const seen = [];
  const google = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { const f = Object.fromEntries(new URLSearchParams(b)); seen.push(f);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(f.grant_type === 'authorization_code' ? { access_token: 'AT-1', refresh_token: 'RT-SECRET', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' } : { access_token: 'AT-2', expires_in: 3600 })); }); });
  await new Promise(r => google.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-g-')), model = await env.startMock();
  const srv = await env.startColdServer({ mockUrl: model.url, env: { COLD_SETTINGS_FILE: path.join(dir, 'settings.json'), COLD_DB_FILE: path.join(dir, 'cold.db'), COLD_GOOGLE_CLIENT_ID: 'cid', COLD_GOOGLE_CLIENT_SECRET: 'sec', COLD_GOOGLE_TOKEN_URL: `http://127.0.0.1:${google.address().port}/token`, COLD_GOOGLE_AUTH_URL: 'https://accounts.example/auth' } });
  try {
    const j = async (p, init) => { const r = await fetch(srv.base + p, init); return { status: r.status, body: await r.json().catch(() => null), text: null }; };
    const cfg = (await j('/api/config')).body.google;
    assert.deepEqual(cfg, { configured: true, mode: 'server' }, 'the page is told who signs in, and the client id is not needed there');
    assert.deepEqual((await j('/api/google/status')).body, { configured: true, connected: false, error: '' });
    assert.equal((await j('/api/google/token')).status, 401);
    // guarded like Settings: an extension (Authorization header) and a foreign page origin are refused
    assert.equal((await j('/api/google/status', { headers: { authorization: 'Bearer x' } })).status, 403);
    assert.equal((await j('/api/google/status', { headers: { origin: 'https://evil.example' } })).status, 403);
    const start = (await j('/api/google/connect', { method: 'POST' })).body;
    const u = new URL(start.url); assert.equal(u.origin, 'https://accounts.example'); assert.equal(u.searchParams.get('redirect_uri'), `${srv.base}/oauth/google/callback`);
    const bad = await fetch(`${srv.base}/oauth/google/callback?code=c&state=forged`); assert.equal(bad.status, 400);
    const cb = await fetch(`${srv.base}/oauth/google/callback?code=THE-CODE&state=${u.searchParams.get('state')}`);
    assert.equal(cb.status, 200); assert.match(await cb.text(), /Connected to Google/); assert.match(cb.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(seen[0].code, 'THE-CODE'); assert.equal(seen[0].client_secret, 'sec');
    assert.equal((await j('/api/google/status')).body.connected, true);
    const tok = (await j('/api/google/token')).body; assert.equal(tok.accessToken, 'AT-1'); assert.deepEqual(Object.keys(tok).sort(), ['accessToken', 'expiresAt']);
    const everything = JSON.stringify([(await j('/api/settings')).body, (await j('/api/config')).body, tok]);
    assert.ok(!everything.includes('RT-SECRET'), 'the refresh token is never sent to the page');
    assert.equal((await j('/api/google/token?refresh=1')).body.accessToken, 'AT-2');
    assert.equal((await j('/api/google/disconnect', { method: 'POST' })).body.connected, false);
    assert.equal((await j('/api/google/token')).status, 401);
    // the page may talk to Google only when a client id is configured; this server has one, a plain one does not
    const csp = (await fetch(srv.base + '/')).headers.get('content-security-policy');
    assert.ok(!csp.includes('accounts.google.com/gsi'), 'a desktop server signs in itself and loads no Google script into the page'); assert.match(csp, /connect-src[^;]*sheets\.googleapis\.com/);
    const plain = await env.startColdServer({ mockUrl: model.url });
    try { assert.ok(!/google/.test((await fetch(plain.base + '/')).headers.get('content-security-policy')), 'with no Google client id, the page may not reach Google at all'); assert.deepEqual((await (await fetch(plain.base + '/api/config')).json()).google, { configured: false }); } finally { plain.stop(); }
  } finally { srv.stop(); model.server.close(); google.close(); }
});
