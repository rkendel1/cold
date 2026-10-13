// DATA-008: a row the database holds but can't be read must be PRESERVED, COUNTED and SHOWN (as a count, never as content), and valid rows must keep working.
// Uses the real SQLite layer (lib/db.js on a real file) and a deliberately corrupted row, written with a second connection like a hand edit or a failed write.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createDb } = require('../lib/db');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cold-unread-')), 'cold.db');
const raw = file => { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(file); };
const SECRET = 'SECRET-CONTENT-sk-live-123';

function seeded() {
  const file = tmp(), db = createDb(file);
  db.put('products', 'p1', { name: 'Acme', order: 0 });
  db.put('emails', 'e1', { createdAt: 2, status: 'draft', recipient: { name: 'Ada' }, subject: 's' });
  db.put('leads', 'l1', { name: 'Lee', company: 'Co', email: 'lee@co.io', createdAt: 3 });
  const c = raw(file);
  c.prepare("INSERT INTO emails(id, created_at, status, mode, product_id, recipient_name, recipient_company, subject, data, updated_at) VALUES('bad-e', 1, 'draft', 'email', '', '', '', '', ?, 0)").run(`{not json ${SECRET}`);
  c.prepare("INSERT INTO leads(id, name, company, email, list, created_at, data, updated_at) VALUES('bad-l', 'x', '', '', '', 0, ?, 0)").run('"just a string"');           // valid JSON, not a record
  c.prepare("INSERT INTO products(id, name, position, data, updated_at) VALUES('bad-p', '', 0, ?, 0)").run('[1,2]');                                                   // valid JSON, an array
  return { file, db, c };
}

test('unreadable rows are counted, left out of the snapshot, and the valid rows are intact', () => {
  const { db, c } = seeded();
  const s = db.snapshot();
  assert.deepEqual(s.unreadable, { products: 1, emails: 1, leads: 1 });
  assert.deepEqual([s.products.map(p => p.id), s.emails.map(e => e.id), s.leads.map(l => l.id)], [['p1'], ['e1'], ['l1']], 'only readable records are returned');
  assert.ok(!JSON.stringify(s).includes(SECRET), 'row contents never appear in what the app receives');
  c.close(); db.close();
});

test('the unreadable rows are PRESERVED byte for byte: reading, saving other records and deleting others never delete or rewrite them', () => {
  const { file, db, c } = seeded();
  const before = c.prepare("SELECT 'e' k, id, data FROM emails WHERE id='bad-e' UNION ALL SELECT 'l', id, data FROM leads WHERE id='bad-l' UNION ALL SELECT 'p', id, data FROM products WHERE id='bad-p' ORDER BY 1").all().map(r => ({ ...r }));
  db.snapshot(); db.put('emails', 'e2', { createdAt: 5, status: 'draft', recipient: { name: 'B' } }); db.put('leads', 'l2', { name: 'Two', createdAt: 6 }); db.remove('emails', 'e1'); db.snapshot();
  const after = c.prepare("SELECT 'e' k, id, data FROM emails WHERE id='bad-e' UNION ALL SELECT 'l', id, data FROM leads WHERE id='bad-l' UNION ALL SELECT 'p', id, data FROM products WHERE id='bad-p' ORDER BY 1").all().map(r => ({ ...r }));
  assert.deepEqual(after, before);
  assert.equal(before.length, 3);
  c.close(); db.close(); assert.ok(fs.existsSync(file));
});

test('fixing the row clears the count; a clean database reports zero', () => {
  const { db, c } = seeded();
  c.prepare("UPDATE emails SET data = ? WHERE id='bad-e'").run(JSON.stringify({ id: 'bad-e', createdAt: 1, status: 'draft', recipient: { name: 'Fixed' } }));
  c.prepare("DELETE FROM leads WHERE id='bad-l'").run(); c.prepare("DELETE FROM products WHERE id='bad-p'").run();
  const s = db.snapshot();
  assert.deepEqual(s.unreadable, { products: 0, emails: 0, leads: 0 });
  assert.deepEqual(s.emails.map(e => e.id).sort(), ['bad-e', 'e1']);
  c.close(); db.close();
});

test('the app-side database reports a count-only notice that names no content, and clears with the condition', async () => {
  const { db, c } = seeded();
  const { createRemoteDb } = await load('src/services/sqliteDb.js');
  let snap = db.snapshot();
  const remote = createRemoteDb({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => snap }), poll: false, migrate: false });
  await remote.load();
  const [msg] = remote.warnings;
  assert.match(msg, /^3 saved items were unreadable and left out of this view \(1 draft, 1 lead, 1 product\)\./);
  assert.match(msg, /still in the database file and nothing was deleted/); assert.match(msg, /docs\/troubleshooting\.md/);
  assert.ok(!msg.includes(SECRET) && !/bad-e|bad-l|bad-p|cold\.db|sqlite/i.test(msg), 'no row content, ids or database internals in the notice');
  c.prepare("DELETE FROM emails WHERE id='bad-e'").run(); c.prepare("DELETE FROM leads WHERE id='bad-l'").run(); c.prepare("DELETE FROM products WHERE id='bad-p'").run();
  snap = db.snapshot(); await remote.load();
  assert.deepEqual(remote.warnings, []);
  const one = { ...snap, unreadable: { products: 0, emails: 1, leads: 0 } }; snap = one; await remote.load();
  assert.match(remote.warnings[0], /^1 saved item was unreadable .*\(1 draft\)\. It is still in the database file/);
  c.close(); db.close();
});

test('the store keeps the notice in step with the database: shown while rows are unreadable, gone when they are not, valid data still usable', async () => {
  const { createStore } = await load('src/state/store.js');
  const listeners = { products: new Set(), emails: new Set(), leads: new Set(), 'settings/me': new Set() };
  const data = { products: [{ id: 'p1', name: 'Acme', order: 0 }], emails: [], leads: [{ id: 'l1', name: 'Lee', createdAt: 1 }] };
  let unreadable = 2;
  const col = n => ({ orderBy() { return this; }, limit() { return this; }, onSnapshot(cb) { const fire = () => cb({ docs: data[n].map(d => ({ id: d.id, data: () => d })) }); listeners[n].add(fire); fire(); return () => listeners[n].delete(fire); } });
  const db = { kind: 'sqlite', collection: col, doc: () => ({ onSnapshot(cb) { cb({ exists: false }); return () => {}; } }), get warnings() { return unreadable ? [`${unreadable} saved items were unreadable and left out of this view (2 drafts).`] : []; } };
  const store = createStore({ storage: { getItem: () => null, setItem() {}, removeItem() {} } }); const topics = [];
  store.subscribe(t => topics.push(t)); store.start({ db });
  assert.deepEqual(store.state.warnings, ['2 saved items were unreadable and left out of this view (2 drafts).']);
  assert.deepEqual([store.state.products.length, store.state.leads.length], [1, 1], 'valid records remain usable');
  unreadable = 0; listeners.emails.forEach(f => f());                  // the database changed and the rows are readable now
  assert.deepEqual(store.state.warnings, []); assert.ok(topics.includes('notice'), 'the notice area is told to redraw');
});
