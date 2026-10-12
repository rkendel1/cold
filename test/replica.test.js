const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

const memory = () => { let v = null; return { get: async () => v && JSON.parse(JSON.stringify(v)), set: async x => { v = JSON.parse(JSON.stringify(x)); } }; };

async function appOn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-rep-'));
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'COLD_ACCESS_TOKEN']) process.env[k] = '';
  Object.assign(process.env, { LLM_PROVIDER: 'ollama', COLD_DB_FILE: path.join(dir, 'cold.db'), COLD_SETTINGS_FILE: path.join(dir, 's.json') });
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`, token = server.db.extensionToken();
  const call = async (p, init = {}) => { const r = await fetch(base + p, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
  return { db: server.db, link: { get: p => call(p), put: (p, b) => call(p, { method: 'PUT', body: JSON.stringify(b) }), del: p => call(p, { method: 'DELETE' }) }, close: () => new Promise(r => { server.close(r); server.db.close(); }) };
}

test('works with no app, then catches the app up when it appears', async () => {
  const { createReplica } = await load('extension/src/replica.js');
  const { createStore } = await load('src/state/store.js');
  const a = await appOn();
  try {
    a.db.put('products', 'p-app', { name: 'From app', order: 0, updatedAt: 100 });
    const storage = memory();
    const replica = createReplica({ storage }); await replica.load();
    const store = createStore({ storage: {} }); store.start({ db: replica });
    // offline: create a product and a draft locally
    await store.saveProduct({ id: 'p-ext', name: 'Made offline', what: 'x', order: 1, updatedAt: 200 });
    await store.saveEmail({ id: 'e-ext', createdAt: 300, mode: 'tweet', what: 'drafted offline', recipient: { name: 'Original tweet' } });
    assert.deepEqual([store.state.products.map(p => p.id), store.state.emails.map(e => e.id), replica.pending], [['p-ext'], ['e-ext'], 2]);
    assert.equal(a.db.snapshot().emails.length, 0);                              // the app has not heard yet

    replica.attach(a.link); await replica.sync();                                  // the app comes online
    assert.deepEqual(a.db.snapshot().emails.map(e => e.id), ['e-ext']);            // drafts reach the app
    assert.deepEqual(a.db.snapshot().products.map(p => p.id).sort(), ['p-app', 'p-ext']);
    assert.deepEqual(store.state.products.map(p => p.id).sort(), ['p-app', 'p-ext']);   // and the app's products reach us
    assert.equal(replica.pending, 0);

    // a fresh browser session still has everything with the app off again
    replica.attach(null);
    const again = createReplica({ storage }); await again.load();
    const s2 = createStore({ storage: {} }); s2.start({ db: again });
    assert.deepEqual([s2.state.products.length, s2.state.emails.length], [2, 1]);
  } finally { await a.close(); }
});

test('conflicts: a newer change in the app is never overwritten; deletions in the app propagate', async () => {
  const { createReplica } = await load('extension/src/replica.js');
  const a = await appOn();
  try {
    a.db.put('products', 'p1', { name: 'Original', order: 0, updatedAt: 100 });
    a.db.put('products', 'p2', { name: 'To be deleted', order: 1, updatedAt: 100 });
    const replica = createReplica({ storage: memory() }); await replica.load();
    replica.attach(a.link); await replica.sync();
    // offline edit in the extension, based on updatedAt 100
    replica.attach(null);
    await replica.doc('products/p1').set({ id: 'p1', name: 'Edited in extension', order: 0, updatedAt: 150 });
    // meanwhile the app edits the same product later, and deletes p2
    a.db.put('products', 'p1', { name: 'Edited in app', order: 0, updatedAt: 400 });
    a.db.remove('products', 'p2');
    replica.attach(a.link); await replica.sync();
    assert.equal(a.db.snapshot().products.find(p => p.id === 'p1').name, 'Edited in app');   // the newer app edit survived
    const names = []; replica.collection('products').onSnapshot(s => { names.length = 0; names.push(...s.docs.map(d => d.data().name)); });
    assert.deepEqual(names, ['Edited in app']);                                               // we adopted it; p2 is gone
    assert.equal(replica.pending, 0);
  } finally { await a.close(); }
});

test('a failed push is kept and retried; edits to the same draft collapse to one change', async () => {
  const { createReplica } = await load('extension/src/replica.js');
  const a = await appOn();
  try {
    const replica = createReplica({ storage: memory() }); await replica.load();
    await replica.doc('emails/e1').set({ id: 'e1', createdAt: 1, what: 'v1' });
    await replica.doc('emails/e1').set({ id: 'e1', createdAt: 1, what: 'v2', updatedAt: 5 });
    assert.equal(replica.pending, 1);
    let fail = true;
    replica.attach({ get: p => (fail ? Promise.reject(new Error('down')) : a.link.get(p)), put: a.link.put, del: a.link.del });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(replica.pending, 1);                                                          // still waiting
    fail = false; await replica.sync();
    assert.deepEqual([replica.pending, a.db.snapshot().emails[0].what], [0, 'v2']);
  } finally { await a.close(); }
});

test('outreach records marked in the app reach the extension intact, and the extension never alters them', async () => {
  const { createReplica } = await load('extension/src/replica.js');
  const { createStore } = await load('src/state/store.js');
  const a = await appOn();
  try {
    a.db.put('emails', 'e1', { id: 'e1', createdAt: 1, status: 'sent', sentAt: 50, note: 'Asked for pricing', sentCopy: { subject: 's', text: 'body', at: 50 }, recipient: { name: 'Sam', email: 'sam@trialco.com' }, subject: 's', what: 'w', why: 'y', ask: 'a', updatedAt: 60 });
    a.db.put('emails', 'e0', { id: 'e0', createdAt: 0, recipient: { name: 'Legacy' }, subject: 'old', what: 'w', why: '', ask: '' });   // an old record with no status at all
    const replica = createReplica({ storage: memory() }); await replica.load();
    const store = createStore({ storage: {} }); store.start({ db: replica });
    replica.attach(a.link); await replica.sync();
    const sent = store.state.emails.find(e => e.id === 'e1'), old = store.state.emails.find(e => e.id === 'e0');
    assert.deepEqual([sent.status, sent.sentAt, sent.note, sent.sentCopy.text, sent.recipient.email], ['sent', 50, 'Asked for pricing', 'body', 'sam@trialco.com']);
    assert.deepEqual([old.status, old.sentAt, old.note], ['draft', undefined, '']);
    assert.equal(replica.pending, 0, 'merely reading records queues nothing to send back');
    assert.equal(a.db.snapshot().emails.find(e => e.id === 'e1').status, 'sent');
  } finally { await a.close(); }
});
