const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-api-'));
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN', 'OLLAMA_MODEL', 'OLLAMA_BASE_URL']) process.env[k] = '';
  process.env.LLM_PROVIDER = 'ollama'; process.env.COLD_DB_FILE = path.join(dir, 'cold.db'); process.env.COLD_SETTINGS_FILE = path.join(dir, 'settings.json');
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { let b = null; try { b = d ? JSON.parse(d) : null; } catch { b = d; } resolve({ status: res.statusCode, body: b, headers: res.headers }); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { server, call, db: server.db, close: () => new Promise(r => { server.close(r); server.db.close(); }) };
}
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

test('app data API: CRUD, versioning and one-time import', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('GET', '/api/config')).body.dbEnabled, true);
    const empty = (await t.call('GET', '/api/data')).body;
    assert.deepEqual([empty.products, empty.emails, empty.migrated], [[], [], false]);
    assert.equal((await t.call('PUT', '/api/data/products/p1', { name: 'Acme', order: 0, what: 'x' })).status, 200);
    assert.equal((await t.call('PUT', '/api/data/emails/e1', { createdAt: 1, recipient: { name: 'Sam' }, what: 'hi' })).status, 200);
    assert.equal((await t.call('PUT', '/api/data/settings', { signature: 'R' })).status, 200);
    const snap = (await t.call('GET', '/api/data')).body;
    assert.deepEqual([snap.products[0].name, snap.emails[0].id, snap.settings.signature], ['Acme', 'e1', 'R']);
    const v = (await t.call('GET', '/api/data/version')).body.version; assert.equal(v, snap.version);
    assert.equal((await t.call('DELETE', '/api/data/emails/e1')).status, 200);
    assert.equal((await t.call('GET', '/api/data/version')).body.version, v + 1);
    assert.equal((await t.call('PUT', '/api/data/emails/bad%20id', { a: 1 })).status, 400);
    assert.equal((await t.call('PUT', '/api/data/nope/x', { a: 1 })).status, 404);
    assert.equal((await t.call('PUT', '/api/data/products/p2', 'not json')).status, 400);
    assert.equal((await t.call('POST', '/api/data/import', { products: [{ id: 'z', name: 'late' }] })).body.imported, false);   // db already has data
  } finally { await t.close(); }
});

test('data API refuses other websites and rebinding hosts', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('GET', '/api/data', undefined, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await t.call('PUT', '/api/data/products/p1', { name: 'x' }, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await t.call('GET', '/api/data', undefined, { host: 'evil.test' })).status, 403);
    assert.equal(t.db.snapshot().products.length, 0);
  } finally { await t.close(); }
});

test('tokenless access is limited to the app\'s own pages (Sec-Fetch-Site), so other extensions and sites get nothing', async () => {
  const t = await boot();
  try {
    t.db.put('products', 'p1', { name: 'Secret product' });
    for (const p of ['/api/data', '/api/data/version', '/api/settings']) {
      assert.equal((await t.call('GET', p, undefined, { 'sec-fetch-site': 'cross-site' })).status, 403, p);
      assert.equal((await t.call('GET', p, undefined, { 'sec-fetch-site': 'same-site' })).status, 403, p);
      assert.equal((await t.call('GET', p, undefined, { 'sec-fetch-site': 'same-origin' })).status, 200, p);
    }
  } finally { await t.close(); }
});

test('extension: needs the pairing token, gets only data/generate/lookups, never settings', async () => {
  const t = await boot();
  try {
    const token = (await t.call('GET', '/api/settings/extension')).body.token;
    assert.ok(token.length >= 30);
    const auth = { origin: EXT, authorization: `Bearer ${token}` };
    // preflight is allowed for extension origins on permitted paths only
    const pre = await t.call('OPTIONS', '/api/data', undefined, { origin: EXT, 'access-control-request-method': 'PUT' });
    assert.equal(pre.status, 204); assert.equal(pre.headers['access-control-allow-origin'], EXT);
    assert.equal((await t.call('OPTIONS', '/api/settings', undefined, { origin: EXT })).headers['access-control-allow-origin'], undefined);
    assert.equal((await t.call('OPTIONS', '/api/data', undefined, { origin: 'https://evil.test' })).headers['access-control-allow-origin'], undefined);
    // without / with a wrong token: refused
    assert.equal((await t.call('GET', '/api/data', undefined, { origin: EXT })).status, 403);
    assert.equal((await t.call('GET', '/api/data', undefined, { origin: EXT, authorization: 'Bearer wrong' })).status, 403);
    assert.equal((await t.call('GET', '/api/data/ping', undefined, { authorization: 'Bearer wrong' })).status, 403);   // extensions send no Origin on GET
    assert.equal((await t.call('GET', '/api/data/ping', undefined, { authorization: `Bearer ${token}` })).status, 200);
    // with the token: data works and CORS headers are present
    const put = await t.call('PUT', '/api/data/emails/e9', { createdAt: 9, what: 'from extension' }, auth);
    assert.equal(put.status, 200); assert.equal(put.headers['access-control-allow-origin'], EXT);
    assert.equal((await t.call('GET', '/api/data/ping', undefined, auth)).body.ok, true);
    assert.equal(t.db.snapshot().emails[0].what, 'from extension');
    // keys, provider choice and the token itself stay out of reach
    for (const p of ['/api/settings', '/api/settings/extension', '/api/settings/models?provider=ollama']) assert.equal((await t.call('GET', p, undefined, auth)).status, 403, p);
    assert.equal((await t.call('PUT', '/api/settings', { active: 'openai' }, auth)).status, 403);
    // an ordinary website never gets CORS access, so it could not read a response even if it somehow had a token
    assert.equal((await t.call('GET', '/api/data', undefined, { origin: 'https://evil.test', authorization: `Bearer ${token}` })).headers['access-control-allow-origin'], undefined);
    // rotating invalidates the old token
    const next = (await t.call('POST', '/api/settings/extension')).body.token; assert.notEqual(next, token);
    assert.equal((await t.call('GET', '/api/data', undefined, auth)).status, 403);
  } finally { await t.close(); }
});
