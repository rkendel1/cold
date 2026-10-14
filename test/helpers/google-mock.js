// A STAND-IN for Google's OpenID Connect endpoints (authorize, token, keys): deterministic, signs ID tokens with a throwaway RSA key.
// Passing tests against it prove Cold's own validation logic. They are NOT evidence that real Google sign-in works.
const http = require('node:http');
const crypto = require('node:crypto');

const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function makeKey(kid = 'test-key-1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}
function sign(claims, { key, header = {}, alg = 'RS256', tamper = false } = {}) {
  const h = b64({ alg, typ: 'JWT', kid: key.kid, ...header }), p = b64(claims);
  const sig = alg === 'none' ? '' : crypto.createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.privateKey).toString('base64url');
  return tamper ? `${h}.${b64({ ...claims, sub: 'attacker' })}.${sig}` : `${h}.${p}.${sig}`;
}

/**
 * `person` is who signs in; `mutate(claims, ctx)` may change the claims (wrong issuer, expired, ...); `sig` options go to sign().
 * Records what the server sent (scope, PKCE) so tests can assert on it.
 */
async function startGoogle({ clientId = 'test-client.apps.googleusercontent.com', clientSecret = 'test-client-secret' } = {}) {
  const key = makeKey(), g = { key, clientId, clientSecret, person: { sub: 'sub-1', name: 'Pat Example', email: 'pat@example.com', email_verified: true }, mutate: null, sigOpts: {}, codes: new Map(), authRequests: [], tokenRequests: 0, now: () => Math.floor(Date.now() / 1000), failToken: false, deny: false };
  g.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/auth') {
      const q = Object.fromEntries(url.searchParams); g.authRequests.push(q);
      const back = new URL(q.redirect_uri);
      const reply = loc => { if (q._mock === 'json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ location: loc })); } else { res.writeHead(302, { location: loc }); res.end(); } };   // _mock=json: for a test that can't follow the redirect itself
      if (g.deny) { back.searchParams.set('error', 'access_denied'); back.searchParams.set('state', q.state); return reply(back.href); }
      const code = `code-${crypto.randomBytes(8).toString('hex')}`;
      g.codes.set(code, { nonce: q.nonce, challenge: q.code_challenge, redirect: q.redirect_uri, person: { ...g.person } });
      back.searchParams.set('code', code); back.searchParams.set('state', q.state);
      return reply(back.href);
    }
    if (url.pathname === '/jwks') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ keys: [g.key.jwk] })); }
    if (url.pathname === '/token' && req.method === 'POST') {
      let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
        g.tokenRequests++;
        const f = Object.fromEntries(new URLSearchParams(b)), c = g.codes.get(f.code); g.codes.delete(f.code);
        const bad = status => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":"invalid_grant"}'); };
        if (g.failToken || !c || f.client_id !== g.clientId || f.client_secret !== g.clientSecret || f.redirect_uri !== c.redirect) return bad(400);
        if (crypto.createHash('sha256').update(f.code_verifier || '').digest('base64url') !== c.challenge) return bad(400);   // PKCE is enforced
        const t = g.now();
        let claims = { iss: 'https://accounts.google.com', aud: g.clientId, azp: g.clientId, sub: c.person.sub, name: c.person.name, email: c.person.email, email_verified: c.person.email_verified, iat: t, exp: t + 3600, nonce: c.nonce };
        if (g.mutate) claims = g.mutate(claims, c) || claims;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'GOOGLE-ACCESS-TOKEN-SHOULD-NOT-BE-KEPT', refresh_token: 'GOOGLE-REFRESH-SHOULD-NOT-BE-KEPT', expires_in: 3600, token_type: 'Bearer', scope: 'openid email profile', id_token: sign(claims, { key: g.key, ...g.sigOpts }) }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => g.server.listen(0, '127.0.0.1', r));
  g.base = `http://127.0.0.1:${g.server.address().port}`;
  g.urls = { COLD_AUTH_GOOGLE_AUTH_URL: `${g.base}/auth`, COLD_AUTH_GOOGLE_TOKEN_URL: `${g.base}/token`, COLD_AUTH_GOOGLE_JWKS_URL: `${g.base}/jwks` };
  g.close = () => new Promise(r => { g.server.closeAllConnections(); g.server.close(r); });
  return g;
}

/** node:http rather than fetch, because fetch refuses to send a chosen Host header and several tests need one. */
function raw(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, headers, agent: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: { get: k => { const v = res.headers[k.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v === undefined ? null : v; }, getSetCookie: () => res.headers['set-cookie'] || [] }, json: async () => JSON.parse(buf.toString('utf8')), text: async () => buf.toString('utf8') }); });
    });
    r.on('error', reject); if (body !== undefined) r.write(body); r.end();
  });
}

/** A tiny cookie jar + manual-redirect client, so tests can inspect every hop. */
function client(base) {
  const jar = {};
  const u = new URL(base);
  const absorb = res => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const n = kv.slice(0, i), v = kv.slice(i + 1); if (/Max-Age=0/i.test(c) || v === '') delete jar[n]; else jar[n] = v; } };
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  async function call(path, { method = 'GET', headers = {}, body, origin = true, absolute = false } = {}) {
    const url = absolute ? path : base + path;
    const h = { ...(cookieHeader() ? { cookie: cookieHeader() } : {}), ...(method === 'POST' && origin ? { origin: u.origin, 'content-type': 'application/json' } : {}), ...headers };
    const res = await raw(url, method, h, body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    if (!absolute || new URL(url).host === u.host) absorb(res);
    return res;
  }
  /** The whole browser round trip: POST login -> Google (mock) -> callback. Returns the callback response. */
  async function signIn({ returnTo } = {}) {
    const r = await call('/api/account/login', { method: 'POST', body: returnTo === undefined ? {} : { returnTo } });
    if (r.status !== 200) return r;
    const { url } = await r.json();
    const toGoogle = await fetch(url, { redirect: 'manual' });
    return call(toGoogle.headers.get('location'), { absolute: true });
  }
  return { jar, call, signIn, cookieHeader, absorb };
}

module.exports = { startGoogle, client, makeKey, sign };
