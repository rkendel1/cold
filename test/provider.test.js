const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('providers keep credentials server-side and normalize responses', async () => {
  for (const provider of ['ai-gateway', 'anthropic']) {
    process.env.LLM_PROVIDER = provider;
    process.env.AI_GATEWAY_API_KEY = 'test-gateway';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
    delete require.cache[require.resolve('../server')];
    const server = require('../server');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const originalFetch = global.fetch;
    const request = (method, path, body) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method }, res => {
        let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    try {
      let status = 200;
      global.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.messages.at(-1).content, 'Hello');
        if (provider === 'ai-gateway') {
          assert.equal(url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
          assert.equal(options.headers.authorization, 'Bearer test-gateway');
          assert.equal(body.messages[0].role, 'system');
        } else assert.equal(options.headers['x-api-key'], 'test-anthropic');
        return { ok: status === 200, status, json: async () => provider === 'ai-gateway'
          ? { choices: [{ message: { content: 'Draft' }, finish_reason: 'length' }] }
          : { content: [{ type: 'text', text: 'Draft' }], stop_reason: 'max_tokens' } };
      };
      const config = await request('GET', '/api/config');
      assert.equal(config.body.provider, provider);
      assert.equal(config.body.ready, true);
      assert.ok(!JSON.stringify(config).includes('test-gateway'));
      const result = await request('POST', '/api/generate', { prompt: 'Hello' });
      assert.equal(result.body.text, 'Draft'); assert.equal(result.body.truncated, true);
      assert.equal((await request('POST', '/api/generate', { prompt: '' })).status, 400);
      status = 401;
      assert.equal((await request('POST', '/api/generate', { prompt: 'Hello' })).status, 502);
      if (provider === 'ai-gateway') {
        delete process.env.AI_GATEWAY_API_KEY;
        delete process.env.VERCEL_OIDC_TOKEN;
        assert.equal((await request('GET', '/api/config')).body.ready, false);
        process.env.VERCEL_OIDC_TOKEN = 'test-oidc';
        assert.equal((await request('GET', '/api/config')).body.ready, true);
      }
    } finally { global.fetch = originalFetch; await new Promise(resolve => server.close(resolve)); }
  }
});
