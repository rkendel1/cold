const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = rel => import(pathToFileURL(path.join(__dirname, '../src', rel)).href);

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-store-'));
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN']) process.env[k] = '';
  process.env.LLM_PROVIDER = 'ollama'; process.env.COLD_DB_FILE = path.join(dir, 'cold.db'); process.env.COLD_SETTINGS_FILE = path.join(dir, 's.json');
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let fail = false;
  const fetchImpl = (p, init) => (fail ? Promise.reject(new Error('offline')) : fetch(base + p, init));
  return { server, fetchImpl, db: server.db, setOffline: v => { fail = v; }, close: () => new Promise(r => { server.close(r); server.db.close(); }) };
}

test('first run copies browser data into SQLite once; the store works unchanged on top of it', async () => {
  const { createRemoteDb } = await load('services/sqliteDb.js');
  const { createStore } = await load('state/store.js');
  const t = await boot();
  const local = { products: [{ id: 'p1', name: 'Acme', what: 'Edge jobs', order: 0 }], emails: [{ id: 'e1', createdAt: 5, recipient: { name: 'Sam' }, what: 'hi' }], settings: { signature: 'R' }, compose: { name: 'Jim' } };
  try {
    const db = createRemoteDb({ fetchImpl: t.fetchImpl, readLocal: () => local, poll: false });
    await db.load();
    assert.deepEqual(t.db.snapshot().products.map(p => p.id), ['p1']);
    assert.deepEqual(db.initialCompose, { name: 'Jim' });

    const store = createStore({ storage: { getItem() { throw new Error('browser storage must not be used'); }, setItem() { throw new Error('browser storage must not be used'); } } });
    store.start({ db });
    const S = store.state;
    assert.deepEqual([S.backend, S.ready, S.products[0].name, S.emails[0].id, S.settings.signature, S.compose.name], ['sqlite', true, 'Acme', 'e1', 'R', 'Jim']);
    assert.equal(store.where(), 'on this computer');

    await store.saveProduct({ ...S.products[0], name: 'Acme 2' });
    assert.equal(S.products[0].name, 'Acme 2'); assert.equal(t.db.snapshot().products[0].name, 'Acme 2');
    await store.saveEmail({ id: 'e2', createdAt: 9, recipient: { name: 'Bo' }, what: 'yo' });
    assert.deepEqual(S.emails.map(e => e.id), ['e2', 'e1']);                                   // newest first
    await store.saveSettings({ signature: 'Randy' }); assert.equal(t.db.snapshot().settings.signature, 'Randy');
    await store.deleteEmail('e1'); assert.deepEqual(t.db.snapshot().emails.map(e => e.id), ['e2']);

    // a failed save is undone and reported, never shown as saved
    t.setOffline(true);
    await assert.rejects(store.saveProduct({ ...S.products[0], name: 'Lost' }), e => e.code === 'storage_unavailable');
    assert.equal(S.products[0].name, 'Acme 2');
    await assert.rejects(store.deleteProduct('p1'), e => e.code === 'storage_unavailable');
    assert.equal(S.products.length, 1);
    t.setOffline(false);

    // reopening a fresh client sees the same data and does not import again
    const db2 = createRemoteDb({ fetchImpl: t.fetchImpl, readLocal: () => { throw new Error('should not read browser data twice'); }, poll: false });
    await db2.load();
    const store2 = createStore({ storage: {} }); store2.start({ db: db2 });
    assert.deepEqual(store2.state.products.map(p => p.name), ['Acme 2']);
  } finally { await t.close(); }
});

test('changes made by another client (the extension) appear without a restart', async () => {
  const { createRemoteDb } = await load('services/sqliteDb.js');
  const { createStore } = await load('state/store.js');
  const t = await boot();
  try {
    const db = createRemoteDb({ fetchImpl: t.fetchImpl, readLocal: () => null, poll: false });
    await db.load();
    const store = createStore({ storage: {} }); store.start({ db });
    let emailsEvents = 0; store.subscribe(topic => { if (topic === 'emails') emailsEvents++; });
    t.db.put('emails', 'ext1', { createdAt: 50, recipient: { name: 'From extension' }, what: 'drafted in the browser' });
    assert.equal(store.state.emails.length, 0);                              // not yet seen
    await store.saveProduct({ id: 'p1', name: 'Mine', what: 'x' });          // our next write notices the gap and re-reads
    assert.deepEqual(store.state.emails.map(e => e.id), ['ext1']);
    assert.ok(emailsEvents > 0);
  } finally { await t.close(); }
});
