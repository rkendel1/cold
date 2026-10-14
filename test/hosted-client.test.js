// The page-side hosted library (src/services/hostedLibrary.js) and the extension worker's hosted op, with fakes: no network, no browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);
const res = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

test('the hosted library opens only when it exists and the person is signed in; every failure is explicit and none falls back to local data', async () => {
  const { createHostedLibrary, hostedReason } = await load('src/services/hostedLibrary.js');
  let ended = 0;
  const lib = t => createHostedLibrary({ transport: t, onSessionEnded: () => { ended++; } });
  await assert.rejects(lib(async () => res(401, { error: { code: 'not_signed_in', message: 'signed out' } })).open(), e => e.code === 'session_expired'); assert.equal(ended, 1);
  await assert.rejects(lib(async () => res(200, { exists: false })).open(), e => e.code === 'no_library');
  await assert.rejects(lib(async () => { throw new Error('offline'); }).open(), e => e.code === 'storage_unavailable' && /Nothing was saved/.test(e.message));
  await assert.rejects(lib(async () => res(404, { error: { code: 'hosted_disabled', message: 'off' } })).open(), e => e.code === 'hosted_disabled');
  await assert.rejects(lib(async () => res(500, { error: { code: 'storage_failed', message: "Couldn't save." } })).summary(), e => e.code === 'storage_failed');
  assert.match(hostedReason('session_expired'), /signed out/); assert.match(hostedReason('storage_unavailable'), /can't be reached/); assert.match(hostedReason('nonsense'), /can't be reached/);
  // a good open: paths are moved from /api/data to /api/hosted/data, nothing else changes
  const seen = [];
  const t = async (p, init = {}) => { seen.push(`${init.method || 'GET'} ${p}`); if (p === 'api/hosted/library') return res(200, { exists: true, leads: 1, emails: 0, products: 0 });
    if (p === 'api/hosted/data') return res(200, { version: 3, migrated: true, products: [], emails: [], leads: [{ id: 'l1', name: 'Lead' }], settings: {}, compose: null, unreadable: {} });
    return res(200, { ok: true, version: 4, updatedAt: 9 }); };
  const db = await lib(t).open();
  assert.equal(db.kind, 'hosted'); assert.deepEqual(seen, ['GET api/hosted/library', 'GET api/hosted/data']); assert.equal(db.initialCompose, null);
  let leads = []; db.collection('leads').onSnapshot(s => { leads = s.docs.map(d => d.id); })(); assert.deepEqual(leads, ['l1']);
  await db.doc('leads/l2').set({ name: 'Two' }); assert.ok(seen.some(x => x === 'PUT api/hosted/data/leads/l2'), 'writes go to the hosted path'); assert.ok(!seen.some(x => /api\/data/.test(x)));
  db.saveCompose({ name: 'half typed' }); assert.ok(!seen.some(x => /compose/.test(x)), 'the Write form is never sent');
  db.stop();
});

test('a hosted library that was chosen but cannot be used shows nothing and refuses every write, with the reason', async () => {
  const { unavailableDb } = await load('src/services/hostedLibrary.js');
  const db = unavailableDb({ code: 'session_expired', message: 'Sign in to open it.' });
  assert.equal(db.kind, 'hosted'); assert.equal(db.unavailable.code, 'session_expired');
  for (const name of ['products', 'emails', 'leads']) { let docs = ['x']; db.collection(name).orderBy('createdAt', 'desc').limit(5).onSnapshot(s => { docs = s.docs; })(); assert.deepEqual(docs, [], `${name} is empty, never someone else's data`); }
  await assert.rejects(db.doc('leads/l1').set({ name: 'x' }), e => e.code === 'session_expired' && /Sign in/.test(e.message));
  await assert.rejects(db.doc('emails/e1').delete(), e => e.code === 'session_expired'); await assert.rejects(db.setMany('leads', []), e => e.code === 'session_expired');
  const down = unavailableDb({ code: 'storage_unavailable', message: 'unreachable' }); await assert.rejects(down.doc('leads/l1').set({}), e => e.code === 'storage_unavailable');
});

test('the library choice is remembered on this device only, and the web transport adds the CSRF token to writes but never to reads', async () => {
  const { localChoice, webTransport, hostedOffered } = await load('src/services/hostedLibrary.js');
  const mem = (() => { const d = {}; return { d, getItem: k => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; })();
  const c = localChoice(mem); assert.equal(await c.get(), false); await c.set(true); assert.equal(await c.get(), true); assert.deepEqual(Object.keys(mem.d), ['cold.library.choice']); await c.set(false); assert.equal(await c.get(), false); assert.deepEqual(mem.d, {});
  assert.equal(await localChoice({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }).get(), false, 'blocked storage means local');
  const calls = []; const t = webTransport({ fetchImpl: async (p, init = {}) => { calls.push([p, init]); return p === 'api/account/me' ? res(200, { csrf: 'CSRF1' }) : res(200, {}); } });
  await t('api/hosted/data'); await t('api/hosted/data/leads/l1', { method: 'PUT', body: '{}' });
  const get = calls.find(([p, i]) => p === 'api/hosted/data' && !i.method)[1], put = calls.find(([p]) => p === 'api/hosted/data/leads/l1')[1];
  assert.equal(get.headers['x-cold-csrf'], undefined); assert.equal(put.headers['x-cold-csrf'], 'CSRF1');
  assert.equal(hostedOffered(null), false); assert.equal(hostedOffered({ account: { enabled: false } }), false); assert.equal(hostedOffered({ account: { enabled: true, hosted: true } }), true);
  assert.equal(hostedOffered({ account: { enabled: true, mode: 'native' } }), true); assert.equal(hostedOffered({ account: { enabled: true } }), false);
});

test('the extension worker forwards hosted requests only to the hosted paths, only for its own pages, and never returns the token', async () => {
  const { createAccountWorker } = await import(pathToFileURL(path.join(__dirname, '../extension/src/account.js')).href);
  const ID = 'abcdefghijklmnopabcdefghijklmnop', sent = [];
  const mem = { 'cold.account.session': { token: 'SECRET-TOKEN-VALUE-0123456789', expiresAt: 0, account: { name: 'A', email: 'a@x.io' } } };
  const area = { get: async k => ({ [k]: mem[k] }), set: async v => Object.assign(mem, v), remove: async k => { delete mem[k]; } };
  const chrome = { runtime: { id: ID, getURL: p => `chrome-extension://${ID}/${p}` }, storage: { session: area, local: { get: async () => { throw new Error('not used'); }, set: async () => { throw new Error('not used'); } } }, identity: {} };
  let status = 200;
  const fetchImpl = async (u, init = {}) => { if (/account\.json$/.test(u)) return { ok: true, json: async () => ({ url: 'https://cold.example.com' }) }; sent.push({ u, method: init.method, auth: init.headers.authorization, creds: init.credentials, body: init.body }); return { status, ok: status < 300, json: async () => ({ ok: true, leads: [] }) }; };
  const w = createAccountWorker({ chrome, fetchImpl });
  const good = await w.ops.hosted({ method: 'GET', path: '/api/hosted/data' }); assert.equal(good.status, 200); assert.ok(!JSON.stringify(good).includes('SECRET-TOKEN'), 'the reply holds no token');
  assert.deepEqual([sent[0].u, sent[0].auth, sent[0].creds], ['https://cold.example.com/api/hosted/data', 'Bearer SECRET-TOKEN-VALUE-0123456789', 'omit']);
  for (const p of ['/api/hosted/data/leads/l1', '/api/hosted/data/leads/l1?base=new', '/api/hosted/data/leads/l1?base=123', '/api/hosted/library', '/api/hosted/data/version']) assert.equal((await w.ops.hosted({ method: p.includes('base') ? 'PUT' : 'GET', path: p, body: {} })).status, 200, p);
  const before = sent.length;
  for (const p of ['/api/account/logout', '/api/account/me', '/api/hosted/../account/me', '/api/hosted/data/../../x', 'https://evil.example/api/hosted/data', '//evil.example/api/hosted/data', '/api/hosted/data?x=1', '/api/hosted/data/a/b/c', '/api/data', '', 5, null, '/api/hosted/library#x'])
    assert.equal((await w.ops.hosted({ method: 'GET', path: p })).status, 400, String(p));
  assert.equal((await w.ops.hosted({ method: 'PATCH', path: '/api/hosted/data' })).status, 400); assert.equal(sent.length, before, 'none of those reached the network');
  status = 401; assert.equal((await w.ops.hosted({ method: 'GET', path: '/api/hosted/data' })).status, 401); assert.deepEqual(mem, {}, 'a 401 forgets the session');
  assert.equal((await w.ops.hosted({ method: 'GET', path: '/api/hosted/data' })).status, 401, 'signed out: refused without a network call');
  // who may ask
  mem['cold.account.session'] = { token: 'SECRET-TOKEN-VALUE-0123456789', expiresAt: 0, account: {} }; status = 200;
  const ask = sender => new Promise(r => { const keep = w.onMessage({ cold: 'account', op: 'hosted', method: 'GET', path: '/api/hosted/data' }, sender, r); if (!keep) void 0; });
  assert.equal((await ask({ id: ID, url: 'https://x.com/page', tab: { id: 1 } })).error, 'refused', 'a content script cannot use the hosted library through the worker');
  assert.equal((await ask({ id: ID, url: `chrome-extension://${ID}/panel.html` })).status, 200);
});
