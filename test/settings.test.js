const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function boot(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-settings-'));
  const file = path.join(dir, 'settings.json');
  for (const k of ['LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN', 'OLLAMA_MODEL', 'OLLAMA_BASE_URL', 'OPENAI_MODEL']) process.env[k] = '';   // '' (not deleted) so a developer's .env can't leak in
  process.env.LLM_PROVIDER = 'ai-gateway';
  process.env.COLD_SETTINGS_FILE = file;
  Object.assign(process.env, extraEnv);
  delete require.cache[require.resolve('../server')]; delete require.cache[require.resolve('../lib/settings')];
  const server = require('../server');
  server.settings.setCodec({ encrypt: s => Buffer.from('ENC:' + s), decrypt: b => b.toString().replace(/^ENC:/, '') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  return { server, file, call, close: () => new Promise(r => server.close(r)) };
}

test('settings: keys are saved encrypted, never returned, and drive generation', async () => {
  const t = await boot();
  const realFetch = global.fetch; const seen = [];
  try {
    let cfg = (await t.call('GET', '/api/config')).body;
    assert.equal(cfg.settingsEnabled, true);
    assert.equal(cfg.ready, false);                       // default provider (AI Gateway) has no key yet

    const saved = await t.call('PUT', '/api/settings', { active: 'openai', providers: { openai: { apiKey: 'sk-secret-1234', model: 'gpt-test' } } });
    assert.equal(saved.status, 200);
    assert.ok(!JSON.stringify(saved.body).includes('sk-secret'));
    const o = saved.body.providers.find(p => p.id === 'openai');
    assert.deepEqual([o.hasKey, o.keyHint, o.model], [true, '1234', 'gpt-test']);
    assert.ok(!fs.readFileSync(t.file, 'utf8').includes('sk-secret'));                // encrypted on disk
    assert.equal((fs.statSync(t.file).mode & 0o777), 0o600);

    cfg = (await t.call('GET', '/api/config')).body;
    assert.deepEqual([cfg.provider, cfg.model, cfg.ready], ['openai', 'gpt-test', true]);

    global.fetch = async (url, o) => {
      if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, o);
      seen.push({ url, o });
      if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] }) };
    };
    const gen = await t.call('POST', '/api/generate', { prompt: 'Hi' });
    assert.equal(gen.body.text, '{"a":1}');
    assert.equal(seen[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(seen[0].o.headers.authorization, 'Bearer sk-secret-1234');
    assert.equal(JSON.parse(seen[0].o.body).model, 'gpt-test');
    assert.equal(JSON.parse(seen[0].o.body).response_format, undefined);

    const models = await t.call('GET', '/api/settings/models?provider=openai');
    assert.deepEqual(models.body.models.map(m => m.id), ['gpt-a', 'gpt-b']);

    // Other providers work too: Anthropic uses its own wire format, Custom takes a base URL and no key.
    await t.call('PUT', '/api/settings', { active: 'anthropic', providers: { anthropic: { apiKey: 'ak-1', model: 'claude-x' } } });
    global.fetch = async (url, o) => { if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, o); seen.push({ url, o }); return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }; };
    await t.call('POST', '/api/generate', { prompt: 'Hi' });
    assert.equal(seen.at(-1).url, 'https://api.anthropic.com/v1/messages');
    assert.equal(seen.at(-1).o.headers['x-api-key'], 'ak-1');

    await t.call('PUT', '/api/settings', { active: 'custom', providers: { custom: { baseUrl: 'http://localhost:1234/v1/', model: 'local-m' } } });
    await t.call('POST', '/api/generate', { prompt: 'Hi' });
    assert.equal(seen.at(-1).url, 'http://localhost:1234/v1/chat/completions');
    assert.equal(seen.at(-1).o.headers.authorization, undefined);

    // Clearing a key makes the provider unavailable again.
    await t.call('PUT', '/api/settings', { active: 'openai', providers: { openai: { apiKey: null } } });
    assert.equal((await t.call('GET', '/api/config')).body.ready, false);
  } finally { global.fetch = realFetch; await t.close(); process.env.COLD_SETTINGS_FILE = ''; }
});

test('settings: validation and cross-site protections', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('PUT', '/api/settings', { active: 'nope' })).status, 400);
    assert.equal((await t.call('PUT', '/api/settings', { providers: { openai: { baseUrl: 'javascript:alert(1)' } } })).status, 400);
    assert.equal((await t.call('PUT', '/api/settings', { providers: { openai: { model: 'a b' } } })).status, 400);
    assert.equal((await t.call('GET', '/api/settings', null, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await t.call('GET', '/api/settings', null, { host: 'evil.test' })).status, 403);   // DNS rebinding
    assert.equal((await t.call('GET', '/api/settings/models?provider=openai')).status, 400);          // no key saved yet
  } finally { await t.close(); process.env.COLD_SETTINGS_FILE = ''; }
});

test('settings API is off unless a settings file is configured', async () => {
  process.env.COLD_SETTINGS_FILE = ''; process.env.LLM_PROVIDER = 'anthropic'; process.env.ANTHROPIC_API_KEY = 'x';
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await new Promise(r => http.get({ port: server.address().port, host: '127.0.0.1', path: '/api/settings' }, x => { x.resume(); r(x.statusCode); }));
    assert.equal(res, 404);
  } finally { await new Promise(r => server.close(r)); delete process.env.LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; }
});
