// What the backup instructions in docs/getting-started.md and docs/troubleshooting.md rest on, tested on the real database layer (lib/db.js, SQLite WAL).
// This does NOT test a real Electron quit on each operating system: it tests the SQLite files that exist while the app runs and after a process exits
// WITHOUT closing the database (the desktop app never calls db.close(): see desktop/main.js and server.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createDb } = require('../lib/db');
const dir0 = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cold-backup-'));
const count = file => { const d = createDb(file); try { return d.snapshot().leads.length; } finally { d.close(); } };
const writeFive = file => { const d = createDb(file); for (let i = 0; i < 5; i++) d.put('leads', `l${i}`, { name: `Lead ${i}`, createdAt: i }); return d; };
const copySet = (from, to) => { fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(from).filter(f => f === 'cold.db' || f === 'cold.db-wal' || f === 'cold.db-shm')) fs.copyFileSync(path.join(from, f), path.join(to, f)); return fs.readdirSync(to).sort(); };

test('while the app runs, recent data is in cold.db-wal: copying cold.db ALONE loses it, so a live copy is not a backup', () => {
  const dir = dir0(), file = path.join(dir, 'cold.db'), db = writeFive(file);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['cold.db', 'cold.db-shm', 'cold.db-wal'], 'WAL mode: three files');
  assert.ok(fs.statSync(path.join(dir, 'cold.db-wal')).size > 0, 'the write-ahead log holds the recent changes');
  fs.copyFileSync(file, path.join(dir, 'main-only.db'));
  assert.equal(count(path.join(dir, 'main-only.db')), 0, 'a copy of cold.db alone, taken while open, contains none of the 5 records');
  db.close();
});

test('after a process exits WITHOUT closing the database (what quitting the app does today), the data is still in cold.db-wal and cold.db-shm: copy all three, together', () => {
  const dir = dir0(), file = path.join(dir, 'cold.db');
  const r = spawnSync(process.execPath, ['-e', `const {createDb}=require(${JSON.stringify(path.join(__dirname, '../lib/db'))});const d=createDb(${JSON.stringify(file)});for(let i=0;i<5;i++)d.put('leads','l'+i,{name:'L'+i,createdAt:i});process.exit(0)`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['cold.db', 'cold.db-shm', 'cold.db-wal'], 'the WAL files remain after the process is gone');
  fs.copyFileSync(file, path.join(dir, 'main-only.db'));
  assert.equal(count(path.join(dir, 'main-only.db')), 0, 'cold.db alone is NOT enough');
  const set = path.join(dir, 'backup');
  assert.deepEqual(copySet(dir, set), ['cold.db', 'cold.db-shm', 'cold.db-wal']);
  assert.equal(count(path.join(set, 'cold.db')), 5, 'the three files together restore everything (opening them recovers the log)');
});

test('after the database is closed cleanly, cold.db alone holds everything', () => {
  const dir = dir0(), file = path.join(dir, 'cold.db'), db = writeFive(file); db.close();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['cold.db'], 'a clean close checkpoints and removes the WAL files');
  fs.copyFileSync(file, path.join(dir, 'copy.db'));
  assert.equal(count(path.join(dir, 'copy.db')), 5);
});

test('restore: a saved set of files, put in place of the current ones, opens with its records; the files it replaced are untouched where they were moved', () => {
  const dir = dir0(), file = path.join(dir, 'cold.db');
  const d = writeFive(file); d.close();
  const saved = path.join(dir, 'saved'); copySet(dir, saved);
  const live = path.join(dir, 'live'); fs.mkdirSync(live); const d2 = createDb(path.join(live, 'cold.db')); d2.put('leads', 'x', { name: 'Newer', createdAt: 9 }); d2.close();
  const aside = path.join(dir, 'moved-aside'); fs.mkdirSync(aside); for (const f of fs.readdirSync(live)) fs.renameSync(path.join(live, f), path.join(aside, f));
  copySet(saved, live);
  assert.equal(count(path.join(live, 'cold.db')), 5, 'the restored library');
  assert.equal(count(path.join(aside, 'cold.db')), 1, 'what was replaced was moved aside, not deleted');
});

test('the SQL used in docs/troubleshooting.md finds the unreadable rows (SQLite json_valid) without changing them', () => {
  const dir = dir0(), file = path.join(dir, 'cold.db'), db = createDb(file);
  db.put('emails', 'good', { createdAt: 1, status: 'draft', recipient: { name: 'A' } });
  const { DatabaseSync } = require('node:sqlite'); const c = new DatabaseSync(file);
  c.prepare("INSERT INTO emails(id, created_at, status, mode, product_id, recipient_name, recipient_company, subject, data, updated_at) VALUES('bad',1,'draft','email','','','','',?,0)").run('{broken');
  const ids = t => c.prepare(`SELECT id FROM ${t} WHERE NOT json_valid(data)`).all().map(r => r.id);
  assert.deepEqual(ids('emails'), ['bad']); assert.deepEqual(ids('leads'), []); assert.deepEqual(ids('products'), []);
  assert.deepEqual(c.prepare("SELECT id FROM emails ORDER BY id").all().map(r => r.id), ['bad', 'good']);
  c.close(); db.close();
});
