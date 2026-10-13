const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createDb } = require('../lib/db');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cold-leads-')), 'cold.db');
const L = (id, o = {}) => ({ id, name: `Lead ${id}`, company: 'Acme', email: `${id}@acme.io`, list: 'Q4', createdAt: Number(id.replace(/\D/g, '')) || 1, ...o });

test('SQLite: leads have their own table with real columns, an existing database upgrades in place, and nothing else is touched', () => {
  const file = tmp();
  // a database made before leads existed: schema version 1, with real data in it
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0, data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE emails (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', mode TEXT NOT NULL DEFAULT 'email', product_id TEXT NOT NULL DEFAULT '', recipient_name TEXT NOT NULL DEFAULT '', recipient_company TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO products(id, name, data) VALUES('p1', 'Old product', '{"id":"p1","name":"Old product"}');
    INSERT INTO emails(id, status, data) VALUES('e1', 'sent', '{"id":"e1","status":"sent","sentAt":5}');
    PRAGMA user_version = 1;`);
  old.close();
  const db = createDb(file);
  const s0 = db.snapshot();
  assert.deepEqual([s0.products.map(p => p.name), s0.emails.map(e => e.status), s0.leads], [['Old product'], ['sent'], []]);
  db.put('leads', 'l1', L('l1', { why: 'wrote about edge', profileUrl: 'https://www.linkedin.com/in/x' }));
  db.put('leads', 'l2', L('l2'));
  db.close();
  const raw = new DatabaseSync(file, { readOnly: true });
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual({ ...raw.prepare("SELECT name, company, email, list FROM leads WHERE id='l1'").get() }, { name: 'Lead l1', company: 'Acme', email: 'l1@acme.io', list: 'Q4' });   // plain columns anyone can query
  raw.close();
  const again = createDb(file);                                                   // reopening an up-to-date database changes nothing
  assert.deepEqual(again.snapshot().leads.map(l => l.id), ['l1', 'l2']);
  assert.equal(again.snapshot().leads[0].why, 'wrote about edge');
  again.remove('leads', 'l1'); assert.deepEqual(again.snapshot().leads.map(l => l.id), ['l2']);
  again.close();
});

test('SQLite: a value fixed with another SQLite tool is what Cold shows; other fields keep coming from the record', () => {
  const file = tmp(), db = createDb(file);
  db.put('leads', 'l1', L('l1', { why: 'kept' }));
  db.close();
  const { DatabaseSync } = require('node:sqlite');
  const w = new DatabaseSync(file); w.exec("UPDATE leads SET company='Fixed Co', email='fixed@acme.io', list='Spring' WHERE id='l1'"); w.close();
  const lead = createDb(file).snapshot().leads[0];
  assert.deepEqual([lead.company, lead.email, lead.list, lead.why, lead.name], ['Fixed Co', 'fixed@acme.io', 'Spring', 'kept', 'Lead l1']);
});

test('SQLite: leads are listed in the order they were added; the first-run import carries leads too', () => {
  const db = createDb(tmp());
  db.put('leads', 'l3', L('l3', { createdAt: 300 })); db.put('leads', 'l1', L('l1', { createdAt: 100 })); db.put('leads', 'l2', L('l2', { createdAt: 200 }));
  assert.deepEqual(db.snapshot().leads.map(l => l.id), ['l1', 'l2', 'l3']);
  const fresh = createDb(tmp());
  assert.deepEqual(fresh.importOnce({ products: [], emails: [], leads: [L('a1'), { name: 'no id' }] }), { imported: true, products: 0, emails: 0, leads: 1 });
  assert.equal(fresh.snapshot().leads.length, 1);
  assert.throws(() => db.put('leads', 'bad id!', {}), /Invalid id/);
});

test('the data API stores leads like any record: versioned writes, refusal of stale ones, deletes, and nothing for strangers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-leads-api-'));
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'COLD_ACCESS_TOKEN']) process.env[k] = '';
  Object.assign(process.env, { LLM_PROVIDER: 'ollama', COLD_DB_FILE: path.join(dir, 'cold.db'), COLD_SETTINGS_FILE: path.join(dir, 's.json') });
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    assert.equal((await call('PUT', '/api/data/leads/l1', L('l1', { updatedAt: 10 }))).status, 200);
    assert.deepEqual((await call('GET', '/api/data')).body.leads.map(l => l.id), ['l1']);
    const stale = await call('PUT', '/api/data/leads/l1?base=5', L('l1', { name: 'Stale edit' }));
    assert.deepEqual([stale.status, stale.body.current.name], [409, 'Lead l1']);
    assert.equal((await call('PUT', '/api/data/leads/l1?base=10', L('l1', { name: 'Fresh edit' }))).status, 200);
    assert.equal((await call('GET', '/api/data')).body.leads[0].name, 'Fresh edit');
    assert.equal((await call('DELETE', '/api/data/leads/l1')).status, 200);
    assert.equal((await call('GET', '/api/data')).body.leads.length, 0);
    assert.equal((await call('GET', '/api/data', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403, 'other sites and extensions get no leads without the pairing code');
    assert.equal((await call('PUT', '/api/data/leads/x', L('x'), { origin: 'https://evil.test' })).status, 403);
  } finally { await new Promise(r => server.close(r)); server.db.close(); }
});

test('the desktop client and the replica save a whole import in one go, and both keep it after a reload', async () => {
  const { createRemoteDb } = await load('src/services/sqliteDb.js');
  const { createStore } = await load('src/state/store.js');
  const { createReplica } = await load('src/services/replica.js');
  const many = Array.from({ length: 300 }, (_, i) => L(`n${i}`, { createdAt: 1000 + i }));

  // replica: one storage write for 300 leads, not 300
  let writes = 0; let saved = null;
  const storage = { get: async () => saved && JSON.parse(JSON.stringify(saved)), set: async d => { writes++; saved = JSON.parse(JSON.stringify(d)); } };
  const replica = createReplica({ storage }); await replica.load();
  const store = createStore({ storage: {} }); store.start({ db: replica });
  await store.saveLeads(many);
  assert.equal(writes, 1); assert.equal(store.state.leads.length, 300); assert.equal(replica.pending, 300);
  assert.equal(store.state.leads[0].id, 'n0');                                         // the file's own order
  await store.deleteLeads(['n0', 'n1']); assert.equal(store.state.leads.length, 298); assert.equal(writes, 2);
  const r2 = createReplica({ storage }); await r2.load(); const s2 = createStore({ storage: {} }); s2.start({ db: r2 });
  assert.equal(s2.state.leads.length, 298);

  // desktop client against a real database
  const db = createDb(tmp());
  const base = db; const fetchImpl = async (p, init = {}) => {
    const u = new URL(p, 'http://x/'), parts = u.pathname.split('/').filter(Boolean).slice(2), body = init.body ? JSON.parse(init.body) : undefined;
    const send = (status, b) => ({ ok: status < 400, status, json: async () => b });
    if (!parts.length) return send(200, { ...base.snapshot(), migrated: true });
    if (parts[0] === 'version') return send(200, { version: base.version });
    if (init.method === 'DELETE') { base.remove(parts[0], decodeURIComponent(parts[1])); return send(200, { ok: true, version: base.version }); }
    const r = base.put(parts[0], decodeURIComponent(parts[1]), body); return send(200, { ok: true, version: base.version, ...r });
  };
  const remote = createRemoteDb({ fetchImpl, poll: false }); await remote.load();
  const st = createStore({ storage: {} }); st.start({ db: remote });
  await st.saveLeads(many);
  assert.equal(base.snapshot().leads.length, 300); assert.equal(st.state.leads.length, 300);
  await st.saveLead({ ...st.state.leads[5], company: 'Edited Co' });
  assert.equal(base.snapshot().leads.find(l => l.id === 'n5').company, 'Edited Co');
  await st.deleteLeads(['n5', 'n6']); assert.equal(base.snapshot().leads.length, 298);
});

test('leads sync both ways between a replica and the desktop app, including edits made while it was closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-leads-sync-'));
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'COLD_ACCESS_TOKEN']) process.env[k] = '';
  Object.assign(process.env, { LLM_PROVIDER: 'ollama', COLD_DB_FILE: path.join(dir, 'cold.db'), COLD_SETTINGS_FILE: path.join(dir, 's.json') });
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`, token = server.db.extensionToken();
  const call = async (p, init = {}) => { const r = await fetch(base + p, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }); const body = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, body }); return body; };
  const hub = { get: p => call(p), put: (p, b) => call(p, { method: 'PUT', body: JSON.stringify(b) }), del: p => call(p, { method: 'DELETE' }) };
  const { createReplica } = await load('src/services/replica.js');
  let saved = null; const storage = { get: async () => saved && JSON.parse(JSON.stringify(saved)), set: async d => { saved = JSON.parse(JSON.stringify(d)); } };
  try {
    server.db.put('leads', 'from-app', L('from-app', { updatedAt: 100 }));
    const replica = createReplica({ storage, pushLocalFirst: false }); await replica.load();
    await replica.doc('leads/made-offline').set(L('made-offline', { updatedAt: 200 }));      // made while the app is "closed"
    replica.attach(hub); await replica.sync();
    assert.deepEqual(server.db.snapshot().leads.map(l => l.id).sort(), ['from-app', 'made-offline']);
    const read0 = () => { let o = []; replica.collection('leads').onSnapshot(s => { o = s.docs.map(d => d.id); })(); return o; };
    assert.deepEqual(read0().sort(), ['from-app', 'made-offline']);
    // an edit at the app reaches the replica; a delete at the app is copied; an edit here reaches the app
    server.db.put('leads', 'from-app', L('from-app', { company: 'Changed at app', updatedAt: 300 }));
    await replica.sync();
    const read = () => { let o = []; replica.collection('leads').onSnapshot(s => { o = s.docs.map(d => d.data()); })(); return o; };
    assert.equal(read().find(l => l.id === 'from-app').company, 'Changed at app');
    await replica.doc('leads/made-offline').set({ ...L('made-offline'), company: 'Changed here', updatedAt: 400 });
    await replica.sync(); assert.equal(server.db.snapshot().leads.find(l => l.id === 'made-offline').company, 'Changed here');
    server.db.remove('leads', 'from-app'); await replica.sync();
    assert.deepEqual(read().map(l => l.id), ['made-offline']);
  } finally { await new Promise(r => server.close(r)); server.db.close(); }
});

test('the web storage keeps leads under their own key, and an unreadable entry is left in place', async () => {
  const { localReplicaStorage } = await load('src/services/replicaStorage.js');
  const { createReplica } = await load('src/services/replica.js');
  const ls = {}; const st = { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } };
  ls['cold.leads'] = JSON.stringify([L('a1'), 'junk', { name: 'no id' }]);
  const replica = createReplica({ storage: localReplicaStorage(st) }); await replica.load();
  await replica.doc('leads/b2').set(L('b2'));
  const stored = JSON.parse(ls['cold.leads']);
  assert.deepEqual(stored.filter(x => x && x.id).map(x => x.id).sort(), ['a1', 'b2']);
  assert.ok(stored.includes('junk') && stored.some(x => x && x.name === 'no id' && !x.id), 'entries this version can\'t read are kept, not dropped');
});
