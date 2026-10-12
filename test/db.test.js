const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDb } = require('../lib/db');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cold-db-')), 'cold.db');

test('documents round-trip and the searchable columns are real columns', () => {
  const file = tmp(), db = createDb(file);
  db.put('products', 'p1', { name: 'Acme', order: 1, what: 'Edge jobs', unknownField: { keep: true } });
  db.put('products', 'p0', { name: 'Zed', order: 0 });
  db.put('emails', 'e1', { createdAt: 100, status: 'sent', mode: 'email', productId: 'p1', recipient: { name: 'Sam', company: 'Acme' }, subject: 'hi', what: 'x' });
  db.put('emails', 'e2', { createdAt: 200, mode: 'reply', recipient: { name: 'Tweet reply' }, what: 'y' });
  db.putMeta('settings', { signature: 'Randy' }); db.putMeta('compose', { name: 'Jim' });
  const s = db.snapshot();
  assert.deepEqual(s.products.map(p => p.id), ['p0', 'p1']);                   // ordered by position
  assert.deepEqual(s.products[1].unknownField, { keep: true });                // unknown fields survive
  assert.deepEqual(s.emails.map(e => e.id), ['e2', 'e1']);                     // newest first
  assert.deepEqual([s.settings, s.compose], [{ signature: 'Randy' }, { name: 'Jim' }]);
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(file, { readOnly: true });                      // another tool can read the same file
  assert.deepEqual({ ...raw.prepare("SELECT recipient_name, status, product_id FROM emails WHERE id='e1'").get() }, { recipient_name: 'Sam', status: 'sent', product_id: 'p1' });
  raw.close();
  db.remove('emails', 'e1'); assert.equal(db.snapshot().emails.length, 1);
  const v = db.version; db.put('products', 'p1', { name: 'Acme 2', order: 1 }); assert.equal(db.version, v + 1);
  db.close();
  assert.equal(createDb(file).snapshot().products[1].name, 'Acme 2');          // persisted across reopen
});

test('bad input is rejected', () => {
  const db = createDb(tmp());
  assert.throws(() => db.put('nope', 'a', {}), /Unknown collection/);
  assert.throws(() => db.put('products', "a'; DROP TABLE products;--", {}), /Invalid id/);
  assert.throws(() => db.put('products', 'a', []), /object/);
  assert.throws(() => db.put('products', 'a', { big: 'x'.repeat(600 * 1024) }), /too large/);
  assert.throws(() => db.putMeta('extension_token', {}), /Unknown document/);
  assert.equal(db.snapshot().products.length, 0);
});

test('browser data imports exactly once, even if the database is later emptied', () => {
  const db = createDb(tmp());
  assert.equal(db.snapshot().migrated, false);
  const r = db.importOnce({ products: [{ id: 'p1', name: 'A' }, { name: 'no id' }], emails: [{ id: 'e1', createdAt: 5 }], settings: { signature: 's' } });
  assert.deepEqual(r, { imported: true, products: 1, emails: 1 });
  assert.equal(db.importOnce({ products: [{ id: 'p9', name: 'late' }] }).imported, false);
  db.remove('products', 'p1'); db.remove('emails', 'e1');
  assert.equal(db.importOnce({ products: [{ id: 'p9' }] }).imported, false);   // not resurrected
  assert.deepEqual([db.snapshot().products.length, db.snapshot().migrated], [0, true]);
});

test('extension token is stable until rotated', () => {
  const db = createDb(tmp());
  assert.equal(db.peekExtensionToken(), null);
  const t = db.extensionToken(); assert.ok(t.length >= 30);
  assert.equal(db.extensionToken(), t); assert.notEqual(db.extensionToken(true), t);
});
