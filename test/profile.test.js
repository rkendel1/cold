const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseProfileUrl, extractProfileText, lookupProfile } = require('../lib/profile');

const LI_HTML = `<html><head><title>Sam Lee - CTO at Acme | LinkedIn</title>
<meta property="og:title" content="Sam Lee - CTO at Acme | LinkedIn">
<meta property="og:description" content="CTO at Acme &amp; builder of edge tools &#183; Writes about moving workloads."></head></html>`;
const X_SHELL = `<html><head><title>X</title><meta property="og:title" content="X"><meta property="og:description" content="Log in to X"></head></html>`;

test('only LinkedIn /in/ and X profile links are accepted', () => {
  assert.equal(parseProfileUrl('linkedin.com/in/sam-lee').url, 'https://www.linkedin.com/in/sam-lee');
  assert.equal(parseProfileUrl('https://uk.linkedin.com/in/sam-lee/').site, 'linkedin');
  assert.deepEqual([parseProfileUrl('twitter.com/samlee').site, parseProfileUrl('https://x.com/samlee').url], ['x', 'https://x.com/samlee']);
  assert.equal(parseProfileUrl('https://x.com/sam/status/1').url, 'https://x.com/sam');   // a tweet link resolves to its author
  for (const bad of ['https://evil.test/in/sam', 'https://linkedin.com.evil.test/in/sam', 'https://x.com/home', 'https://linkedin.com/company/acme', 'file:///etc/passwd', 'javascript:alert(1)', '', 'x.com/' + 'a'.repeat(40)])
    assert.equal(parseProfileUrl(bad), null, bad);
});

test('metadata is read into labelled text; empty shells carry nothing', () => {
  const t = extractProfileText(LI_HTML, 'linkedin');
  assert.match(t, /Sam Lee - CTO at Acme/);
  assert.match(t, /Acme & builder of edge tools · Writes about moving workloads/);
  assert.equal(extractProfileText(X_SHELL, 'x'), '');
});

test('lookup: success, login wall, redirect off-site, not found, network failure', async () => {
  const res = (status, body, url) => async () => ({ ok: status < 400, status, url, text: async () => body });
  const ok = await lookupProfile('linkedin.com/in/sam-lee', res(200, LI_HTML, 'https://www.linkedin.com/in/sam-lee'));
  assert.equal(ok.ok, true); assert.match(ok.text, /CTO at Acme/);
  assert.equal((await lookupProfile('x.com/samlee', res(200, X_SHELL, 'https://x.com/samlee'))).code, 'blocked');
  assert.equal((await lookupProfile('linkedin.com/in/sam-lee', res(200, LI_HTML, 'https://www.linkedin.com/authwall?trk=x'))).code, 'blocked');
  assert.equal((await lookupProfile('linkedin.com/in/sam-lee', res(999, '', 'https://www.linkedin.com/in/sam-lee'))).code, 'blocked');
  assert.equal((await lookupProfile('linkedin.com/in/sam-lee', res(200, LI_HTML, 'https://evil.test/in/sam-lee'))).code, 'blocked');
  assert.equal((await lookupProfile('linkedin.com/in/sam-lee', res(404, '', 'https://www.linkedin.com/in/sam-lee'))).code, 'not_found');
  assert.equal((await lookupProfile('linkedin.com/in/sam-lee', async () => { throw new Error('down'); })).code, 'unreachable');
  assert.equal((await lookupProfile('https://evil.test/in/sam', async () => { throw new Error('must not fetch'); })).code, 'unsupported');
});

test('/api/profile endpoint fetches only profile links and keeps the usual guards', async () => {
  process.env.COLD_SETTINGS_FILE = ''; process.env.LLM_PROVIDER = 'ollama';
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, real = global.fetch, fetched = [];
  const post = (body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/profile', method: 'POST', headers }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(d) })); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    global.fetch = async url => { fetched.push(String(url)); return { ok: true, status: 200, url: String(url), text: async () => LI_HTML }; };
    const good = await post({ url: 'linkedin.com/in/sam-lee' });
    assert.equal(good.body.ok, true); assert.deepEqual(fetched, ['https://www.linkedin.com/in/sam-lee']);
    assert.equal((await post({ url: 'http://169.254.169.254/latest/meta-data' })).body.code, 'unsupported');
    assert.equal((await post({ url: 'https://evil.test/in/x' })).body.code, 'unsupported');
    assert.equal((await post({ url: '' })).status, 400);
    assert.equal(fetched.length, 1);
    assert.equal((await post({ url: 'linkedin.com/in/sam-lee' }, { origin: 'https://evil.test' })).status, 403);
  } finally { global.fetch = real; await new Promise(r => server.close(r)); delete process.env.LLM_PROVIDER; }
});

test('tweet links: parsing and lookup through the fixed embed endpoint', async () => {
  const { parseTweetUrl, lookupTweet } = require('../lib/profile');
  assert.deepEqual(parseTweetUrl('https://x.com/jack/status/20'), { handle: 'jack', id: '20' });
  assert.equal(parseTweetUrl('twitter.com/jack/status/20?s=1').id, '20');
  for (const bad of ['https://x.com/jack', 'https://evil.test/jack/status/20', 'https://x.com/home/status/abc', '']) assert.equal(parseTweetUrl(bad), null, bad);

  const urls = [];
  const reply = body => async url => { urls.push(String(url)); return { ok: true, status: 200, json: async () => body }; };
  const good = await lookupTweet('https://x.com/jack/status/20', reply({ text: 'just setting up my twttr https://t.co/abc', entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/x' }] }, user: { name: 'jack', screen_name: 'jack' } }));
  assert.deepEqual([good.ok, good.text, good.handle], [true, 'just setting up my twttr https://example.com/x', 'jack']);
  assert.match(urls[0], /^https:\/\/cdn\.syndication\.twimg\.com\/tweet-result\?id=20&/);
  assert.equal((await lookupTweet('https://x.com/jack/status/20', reply({ __typename: 'TweetTombstone' }))).code, 'blocked');
  assert.equal((await lookupTweet('https://x.com/jack/status/20', async () => ({ ok: false, status: 404 }))).code, 'not_found');
  assert.equal((await lookupTweet('https://x.com/jack/status/20', async () => { throw new Error('down'); })).code, 'unreachable');
  assert.equal((await lookupTweet('https://evil.test/a/status/1', async () => { throw new Error('must not fetch'); })).code, 'unsupported');
});
