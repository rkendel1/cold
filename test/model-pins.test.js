// Model provenance: the pin rules, the downloader that verifies every byte before accepting it, the worker's lack of network, and the pin
// generator, run against a STAND-IN Hugging Face server that can be told to lie. None of this needs the real Hugging Face; it proves that
// Cold fails closed when something is wrong. (What the real repositories actually contain is checked by `npm run pin:local-model`, which
// needs network access to huggingface.co.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const gitBlob = b => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');

// ---------------------------------------------------------------------------------------------------------------- a stand-in Hugging Face
function standIn() {
  const state = { tamper: new Set(), mutate: new Set(), hits: [], revisions: new Map() };
  const content = (repo, rev, p) => {
    if (p === 'mlc-chat-config.json') return Buffer.from(JSON.stringify({ model_type: 'qwen2', tokenizer_files: ['tokenizer.json'], context_window_size: 4096 }));
    if (p === 'tensor-cache.json') return Buffer.from(JSON.stringify({ metadata: {}, records: [{ dataPath: 'params_shard_0.bin' }, { dataPath: 'params_shard_1.bin' }] }));
    if (p === 'tokenizer.json') return Buffer.from('{"version":"1.0"}');
    if (/^params_shard_\d+\.bin$/.test(p)) return crypto.createHash('sha256').update(`${repo}/${p}`).digest().subarray(0, 8).length ? Buffer.concat(Array.from({ length: 64 }, (_, i) => crypto.createHash('sha256').update(`${repo}/${p}/${i}`).digest())) : Buffer.alloc(0);
    if (p === 'README.md') return Buffer.from('# readme');
    return null;
  };
  const commit = repo => (state.revisions.get(repo) || crypto.createHash('sha1').update('commit:' + repo).digest('hex'));
  const FILES = ['README.md', 'mlc-chat-config.json', 'tensor-cache.json', 'tokenizer.json', 'params_shard_0.bin', 'params_shard_1.bin'];
  const isLfs = p => /\.bin$/.test(p);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); state.hits.push(req.method + ' ' + u.pathname + u.search);
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    let m;
    if ((m = /^\/api\/models\/(.+?)\/revision\/main$/.exec(u.pathname))) return send(200, JSON.stringify({ sha: commit(m[1]) }));
    if ((m = /^\/api\/models\/(.+?)\/tree\/([0-9a-f]{40})$/.exec(u.pathname))) {
      const repo = m[1];
      return send(200, JSON.stringify([{ type: 'directory', path: 'x' }, ...FILES.map(p => {
        const b = content(repo, m[2], p);
        return { type: 'file', path: p, size: b.length, oid: state.tamper.has('blob:' + p) ? 'f'.repeat(40) : gitBlob(b), ...(isLfs(p) ? { lfs: { oid: state.tamper.has('lfs:' + p) ? 'e'.repeat(64) : sha256(b), size: b.length } } : {}) };
      })]));
    }
    if ((m = /^\/(.+?)\/resolve\/([0-9a-f]{40})\/(.+)$/.exec(u.pathname))) {
      const [, repo, rev, p] = m;
      if (rev !== commit(repo)) return send(404, 'unknown revision', 'text/plain');
      const b = content(repo, rev, p);
      if (!b) return send(404, 'no such file', 'text/plain');
      return send(200, state.mutate.has(p) ? Buffer.concat([b.subarray(0, b.length - 1), Buffer.from([b[b.length - 1] ^ 1])]) : b, 'application/octet-stream');
    }
    send(404, 'nope', 'text/plain');
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ state, content, FILES, commit, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(x => { server.closeAllConnections(); server.close(x); }) })));
}
const runPin = (hf, file, args = [], env = {}) => new Promise(resolve => {
  const c = spawn('node', ['scripts/pin-local-model.cjs', ...args], { cwd: path.join(__dirname, '..'), env: { ...process.env, HF_ENDPOINT: hf.origin, COLD_PINS_FILE: file, ...env } });
  let out = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d); c.on('close', code => resolve({ code, out }));
});
const memCache = () => { const scopes = new Map(); return { scopes, open: async scope => { if (!scopes.has(scope)) scopes.set(scope, new Map()); const m = scopes.get(scope); return { match: async u => m.get(u), put: async (u, r) => { m.set(u, r); }, delete: async u => m.delete(u), keys: async () => [...m.keys()] }; } }; };

// ---------------------------------------------------------------------------------------------------------------------- the rules
test('a model is usable only with an exact commit and a SHA-256 and size for every required file; anything less is refused', async () => {
  const { pinProblem, pinFor, artifactUrl, modelBaseUrl, scopeOf, toSri, requiredFiles } = await load('extension/src/modelPins.js');
  const good = { repo: 'mlc-ai/M-MLC', revision: 'a'.repeat(40), files: { 'mlc-chat-config.json': { sha256: 'b'.repeat(64), size: 10 }, 'tensor-cache.json': { sha256: 'c'.repeat(64), size: 20 }, 'params_shard_0.bin': { sha256: 'd'.repeat(64), size: 30 } } };
  assert.equal(pinProblem(good), null);
  for (const [name, bad] of [['no entry', null], ['branch name', { ...good, revision: 'main' }], ['tag', { ...good, revision: 'v1.0' }], ['short sha', { ...good, revision: 'abc1234' }], ['uppercase/garbage', { ...good, revision: 'Z'.repeat(40) }],
    ['no files', { ...good, files: {} }], ['short digest', { ...good, files: { ...good.files, 'params_shard_0.bin': { sha256: 'd'.repeat(63), size: 1 } } }], ['md5 instead of sha256', { ...good, files: { ...good.files, 'params_shard_0.bin': { sha256: 'd'.repeat(32), size: 1 } } }],
    ['no size', { ...good, files: { ...good.files, 'params_shard_0.bin': { sha256: 'd'.repeat(64) } } }], ['path traversal', { ...good, files: { ...good.files, '../evil.bin': { sha256: 'd'.repeat(64), size: 1 } } }],
    ['config not pinned', { ...good, files: { 'tensor-cache.json': good.files['tensor-cache.json'] } }], ['tensor cache not pinned', { ...good, files: { 'mlc-chat-config.json': good.files['mlc-chat-config.json'] } }]]) assert.ok(pinProblem(bad), name);
  const src = { origin: 'https://huggingface.co' };
  assert.equal(artifactUrl(src, good, 'params_shard_0.bin'), `https://huggingface.co/mlc-ai/M-MLC/resolve/${'a'.repeat(40)}/params_shard_0.bin`, 'URLs name the commit, never "main"');
  assert.match(modelBaseUrl(src, good), /\/resolve\/a{40}\/$/);
  assert.deepEqual(['mlc-chat-config.json', 'tokenizer.json', 'tokenizer_config.json', 'tensor-cache.json', 'params_shard_3.bin'].map(scopeOf), ['webllm/config', 'webllm/model', 'webllm/model', 'webllm/model', 'webllm/model']);
  assert.equal(toSri('00'.repeat(32)), 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  assert.equal(requiredFiles(good).length, 3);
  assert.equal(pinFor({ models: { x: good } }, 'x'), good); assert.equal(pinFor({ models: {} }, 'x'), null);
});

test('the pins shipped in this repository are honest: either complete and immutable, or explicitly unpinned (and then every model is refused)', async () => {
  const { pinProblem, pinFor, parsePins } = await load('extension/src/modelPins.js'), { MODELS } = await load('extension/src/localModels.js');
  const pins = parsePins(JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/src/modelPins.json'), 'utf8')));
  const all = MODELS.flatMap(m => Object.values(m.variants).map(v => v.id));
  if (pins.status === 'pinned') for (const id of all) { assert.equal(pinProblem(pinFor(pins, id)), null, `${id} must be completely pinned`); assert.equal(pinFor(pins, id).repo, `mlc-ai/${id}`); }
  else { assert.equal(pins.status, 'unpinned'); assert.ok(pins.reason); for (const id of all) assert.ok(pinProblem(pinFor(pins, id)), `${id} must be refused while unpinned`); }
  // the build ships exactly this file
  const dist = path.join(__dirname, '../extension/dist/model-pins.json');
  if (fs.existsSync(dist)) assert.deepEqual(JSON.parse(fs.readFileSync(dist, 'utf8')), pins);
});

// ------------------------------------------------------------------------------------------------------------------- the downloader
async function pinnedFrom(hf, repo = 'mlc-ai/M-MLC') {
  const rev = hf.commit(repo), files = {};
  for (const p of hf.FILES.filter(f => f !== 'README.md')) { const b = hf.content(repo, rev, p); files[p] = { sha256: sha256(b), size: b.length }; }
  return { repo, revision: rev, files };
}
test('every file is checked before it is accepted: good files are cached under their pinned URL; wrong bytes, wrong size and bad responses are refused and cached nowhere', async () => {
  const hf = await standIn(); const { downloadPinned, isDownloaded, removePinned, artifactUrl, requiredFiles } = await load('extension/src/modelPins.js');
  try {
    const entry = await pinnedFrom(hf), source = { origin: hf.origin }, c = memCache();
    const progress = []; const r = await downloadPinned({ entry, source, openCache: c.open, onProgress: p => progress.push(p) });
    assert.deepEqual([r.fetched, r.reused, r.files], [5, 0, 5]);
    assert.ok(progress.at(-1).bytes === progress.at(-1).total && progress.at(-1).total === requiredFiles(entry).reduce((n, f) => n + f.size, 0));
    assert.ok(hf.state.hits.every(h => h.startsWith('GET /mlc-ai/M-MLC/resolve/' + entry.revision + '/')), 'every request names the pinned commit: ' + hf.state.hits.join(' '));
    assert.ok(!hf.state.hits.some(h => /README|main/.test(h)), 'nothing that is not pinned was requested');
    assert.equal(await isDownloaded({ entry, source, openCache: c.open }), true);
    // a second setup reuses what is verified and cached: no request at all
    hf.state.hits.length = 0; const again = await downloadPinned({ entry, source, openCache: c.open });
    assert.deepEqual([again.fetched, again.reused, hf.state.hits.length], [0, 5, 0]);
    // removal deletes every pinned file from every scope
    assert.equal(await removePinned({ entry, source, openCache: c.open }), 5);
    assert.deepEqual([...c.scopes.values()].map(m => m.size), [0, 0]); assert.equal(await isDownloaded({ entry, source, openCache: c.open }), false);

    // wrong bytes under the same commit: refused, named, not cached; the files before it are kept and a retry fetches only what is missing
    hf.state.mutate.add('params_shard_1.bin'); const c2 = memCache();
    await assert.rejects(downloadPinned({ entry, source, openCache: c2.open }), e => e.code === 'integrity_failed' && e.name === 'IntegrityError' && e.file === 'params_shard_1.bin' && /discarded/.test(e.message) && /Try again/.test(e.message));
    const cached = [...c2.scopes.values()].flatMap(m => [...m.keys()]);
    assert.ok(!cached.includes(artifactUrl(source, entry, 'params_shard_1.bin')), 'the bad file was never cached'); assert.ok(cached.length >= 3);
    hf.state.mutate.clear(); hf.state.hits.length = 0;
    const retry = await downloadPinned({ entry, source, openCache: c2.open });
    assert.equal(retry.fetched, 1, 'the retry fetched only the missing file'); assert.deepEqual(hf.state.hits.map(h => h.split('/').pop()), ['params_shard_1.bin']);

    // wrong size: too short and too long
    const shorter = { ...entry, files: { ...entry.files, 'tokenizer.json': { ...entry.files['tokenizer.json'], size: entry.files['tokenizer.json'].size + 5 } } }, longer = { ...entry, files: { ...entry.files, 'tokenizer.json': { ...entry.files['tokenizer.json'], size: 3 } } };
    for (const bad of [shorter, longer]) await assert.rejects(downloadPinned({ entry: bad, source, openCache: memCache().open }), e => e.code === 'integrity_failed' && /wrong size|too large/.test(e.message));
    // a host that answers an error, one that is unreachable
    await assert.rejects(downloadPinned({ entry: { ...entry, revision: 'f'.repeat(40) }, source, openCache: memCache().open }), e => e.code === 'download_failed' && /404/.test(e.message));
    await assert.rejects(downloadPinned({ entry, source, openCache: memCache().open, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), e => e.code === 'download_failed' && /nothing you were reading was sent/.test(e.message));
  } finally { await hf.close(); }
});

test('an unpinned or partly pinned model is never requested at all', async () => {
  const hf = await standIn(); const { downloadPinned } = await load('extension/src/modelPins.js');
  try {
    for (const entry of [null, { repo: 'mlc-ai/M-MLC', revision: 'main', files: {} }, { repo: 'mlc-ai/M-MLC', revision: hf.commit('mlc-ai/M-MLC'), files: { 'mlc-chat-config.json': { sha256: 'a'.repeat(64), size: 1 } } }])
      await assert.rejects(downloadPinned({ entry, source: { origin: hf.origin }, openCache: memCache().open }), e => e.code === 'unpinned_model');
    assert.deepEqual(hf.state.hits, []);
  } finally { await hf.close(); }
});

test('cancelling a download stops it, caches nothing half-read, and a later attempt completes', async () => {
  const hf = await standIn(); const { downloadPinned, artifactUrl } = await load('extension/src/modelPins.js');
  try {
    const entry = await pinnedFrom(hf), source = { origin: hf.origin }, c = memCache(), ctl = new AbortController();
    let n = 0;
    const slowFetch = async (url, init) => { const r = await fetch(url, init); if (++n < 3) return r; ctl.abort(); return new Response(new ReadableStream({ pull(controller) { if (init.signal.aborted) { controller.error(new DOMException('aborted', 'AbortError')); } else controller.enqueue(new Uint8Array(1)); } })); };
    await assert.rejects(downloadPinned({ entry, source, openCache: c.open, fetchImpl: slowFetch, signal: ctl.signal }), e => e.code === 'cancelled');
    const cached = [...c.scopes.values()].flatMap(m => [...m.keys()]);
    assert.ok(cached.length < 5 && !cached.includes(artifactUrl(source, entry, 'params_shard_1.bin')));
    const done = await downloadPinned({ entry, source, openCache: c.open });
    assert.equal(done.fetched + done.reused, 5);
  } finally { await hf.close(); }
});

// ------------------------------------------------------------------------------------------------------------------- the worker's network
test('the inference worker has no network: it can read extension files and nothing else', async () => {
  const { installNetworkGuard } = await load('extension/src/workerGuard.js');
  const calls = [];
  class FakeCache { async add(r) { calls.push('add ' + (r.url || r)); } async addAll(rs) { calls.push('addAll'); } }
  const scope = { location: { href: 'chrome-extension://abc/dist/llm-worker.js' }, fetch: async (i) => { calls.push('fetch ' + (i.url || i)); return 'real'; }, Cache: FakeCache, XMLHttpRequest: class {}, WebSocket: class {}, EventSource: class {}, importScripts: () => {} };
  installNetworkGuard(scope);
  assert.equal(await scope.fetch('chrome-extension://abc/dist/models/x.wasm'), 'real');
  for (const url of ['https://huggingface.co/x', 'http://127.0.0.1:11434/api', 'https://evil.example/page-text?q=secret', 'data:text/plain,hi', 'blob:abc']) await assert.rejects(scope.fetch(url), /no network access/, url);
  assert.deepEqual(calls, ['fetch chrome-extension://abc/dist/models/x.wasm'], 'only the extension file was fetched');
  await assert.rejects(new scope.Cache().add('https://huggingface.co/m.bin'), /no network access/);
  await assert.rejects(new scope.Cache().addAll(['https://a.example/x']), /no network access/);
  for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) assert.throws(() => new scope[name]('https://evil.example'), /no network access/, name);
});

// --------------------------------------------------------------------------------------------------------------------- the generator
test('the pin generator records an exact commit and digests only when the bytes AND Hugging Face\'s own metadata agree, and the result drives the real downloader', async () => {
  const hf = await standIn(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-pins-')), file = path.join(tmp, 'pins.json');
  try {
    const r = await runPin(hf, file, ['--only=Qwen2.5-1.5B-Instruct-q4f16_1-MLC']);
    assert.equal(r.code, 0, r.out);
    const pins = JSON.parse(fs.readFileSync(file, 'utf8')), entry = pins.models['Qwen2.5-1.5B-Instruct-q4f16_1-MLC'];
    assert.deepEqual([pins.status, entry.repo, entry.revision], ['pinned', 'mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC', hf.commit('mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC')]);
    assert.deepEqual(Object.keys(entry.files).sort(), ['mlc-chat-config.json', 'params_shard_0.bin', 'params_shard_1.bin', 'tensor-cache.json', 'tokenizer.json'], 'exactly the files the model needs (no README)');
    for (const [p, f] of Object.entries(entry.files)) assert.equal(f.sha256, sha256(hf.content(entry.repo, entry.revision, p)), p);   // independently computed here
    const { downloadPinned, pinProblem } = await load('extension/src/modelPins.js');
    assert.equal(pinProblem(entry), null);
    const out = await downloadPinned({ entry, source: { origin: hf.origin }, openCache: memCache().open });
    assert.equal(out.files, 5);
    // --verify: unchanged repository passes; the SAME commit serving different bytes (a mutable source) fails and names the file
    const ok = await runPin(hf, file, ['--verify', '--only=Qwen2.5-1.5B-Instruct-q4f16_1-MLC']); assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /ok .* 5 files/);
    hf.state.mutate.add('params_shard_0.bin');
    const bad = await runPin(hf, file, ['--verify', '--only=Qwen2.5-1.5B-Instruct-q4f16_1-MLC']); assert.equal(bad.code, 1); assert.match(bad.out, /params_shard_0\.bin/);
  } finally { await hf.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the pin generator refuses to write anything when the two sources disagree, or the repository is incomplete', async () => {
  for (const [what, setup, expect] of [
    ['LFS object id disagrees with the bytes', hf => hf.state.tamper.add('lfs:params_shard_1.bin'), /does not match Hugging Face's LFS object id/],
    ['git blob id disagrees with the bytes', hf => hf.state.tamper.add('blob:mlc-chat-config.json'), /git blob id/],
  ]) {
    const hf = await standIn(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-pins-')), file = path.join(tmp, 'pins.json');
    fs.writeFileSync(file, '{"schema":1,"status":"unpinned","models":{}}');
    try {
      setup(hf); const r = await runPin(hf, file, ['--only=Qwen2.5-0.5B-Instruct-q4f16_1-MLC']);
      assert.equal(r.code, 1, what); assert.match(r.out, expect, what); assert.match(r.out, /nothing was written/);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'unpinned', 'the existing file was left alone');
    } finally { await hf.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  }
});
