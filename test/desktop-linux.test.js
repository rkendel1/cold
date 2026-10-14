// The desktop shell on Linux: where the library lives, who can read it, what a normal quit and a restart do to it, and what happens when it
// can't be opened. These run the REAL Electron main process (desktop/main.js) with a throwaway home folder, under a display (xvfb in CI).
// They use synthetic records only, and prove nothing about a model, Google Sheets or the browser extension.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

let pw; try { pw = require('playwright-core'); } catch { pw = null; }
let electronPath = null; try { electronPath = require('electron'); } catch { /* not installed */ }
const NO_ELECTRON = !pw || !electronPath || !fs.existsSync(String(electronPath)) ? 'Electron or playwright-core is not available' : false;
const SKIP = NO_ELECTRON || (process.platform !== 'linux' ? 'Linux-specific paths and permissions' : false);
const MAIN = path.join(__dirname, '../desktop/main.js');
const mode = f => (fs.statSync(f).mode & 0o777).toString(8);
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// Chromium helper processes can still be writing a cache file for a moment after the main process has exited; cleaning up a temp folder is best-effort.
const rmHome = async d => { for (let i = 0; i < 40; i++) { try { fs.rmSync(d, { recursive: true, force: true }); return; } catch (e) { if (e.code !== 'ENOTEMPTY') return; await new Promise(r => setTimeout(r, 250)); } } };
const newHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cold-linux-'));
const envFor = (home, port, extra = {}) => { const e = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), COLD_PORT: String(port), ...extra }; delete e.ELECTRON_RUN_AS_NODE; return e; };
const api = (port, p, init) => fetch(`http://127.0.0.1:${port}${p}`, init).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const put = (port, p, doc) => api(port, p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) });
async function launch(home, port) {
  const app = await pw._electron.launch({ args: [MAIN], env: envFor(home, port), timeout: 60000 });
  await (await app.firstWindow()).waitForSelector('#genBtn', { state: 'attached', timeout: 30000 });
  return app;
}
const records = now => ({
  lead: { name: 'Test Lead', company: 'Example Co (synthetic)', email: 'lead@example.invalid', list: 'test', createdAt: now },
  email: { status: 'draft', mode: 'email', productId: '', recipient: { name: 'Test Lead', company: 'Example Co (synthetic)' }, subject: 'Synthetic draft', body: 'Not a real message.', createdAt: now, handoffs: [{ at: now, how: 'copy' }] },
});
/** Start the shell as a plain child process (so its exit and the error box can be observed) with the dialog recorder preloaded. */
function startRaw(home, port, dialogFile) {
  // --no-sandbox here (as Playwright does for the other tests): this runs Electron from node_modules, which has no SUID helper, and a root or AppArmor-restricted account can't start the sandbox
  // from there. The packaged app's sandbox is checked on the installed package by scripts/smoke-deb.cjs.
  const child = spawn(String(electronPath), ['--no-sandbox', MAIN], { env: envFor(home, port, { NODE_OPTIONS: `--require ${path.join(__dirname, 'helpers/electron-record-dialog.cjs')}`, COLD_TEST_DIALOG_FILE: dialogFile }), stdio: 'ignore' });
  const exit = new Promise(r => child.on('exit', (code, signal) => r({ code, signal })));
  return { child, exit };
}

test('linux: the library is created in ~/.config/Cold, private to the user, with no privileges needed', { skip: SKIP, timeout: 90000 }, async () => {
  const home = newHome(), port = await freePort();
  const data = path.join(home, '.config', 'Cold'), db = path.join(data, 'cold.db');
  const app = await launch(home, port);
  try {
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), data, 'Electron resolves the per-user data folder from XDG_CONFIG_HOME');
    assert.ok(fs.existsSync(db), 'cold.db is in that folder');
    assert.equal(mode(data), '700', 'the data folder is private to the user');
    assert.equal(mode(db), '600', 'the library is private to the user');
    assert.equal((await api(port, '/api/settings/extension')).body.dbFile, db, 'the app reports the same path (shown in Settings)');
    await put(port, '/api/data/leads/l1', records(Date.now()).lead);   // creates the -wal/-shm files
    for (const f of fs.readdirSync(data).filter(n => n.startsWith('cold.db-'))) assert.equal(mode(path.join(data, f)), '600', `${f} is private too`);
  } finally { await app.close(); }
  await rmHome(home);
});

test('linux: a normal quit closes the library, a restart finds every record, and the same database file is reused', { skip: SKIP, timeout: 120000 }, async () => {
  const home = newHome(), port = await freePort(), now = Date.now();
  const db = path.join(home, '.config', 'Cold', 'cold.db');
  let app = await launch(home, port);
  assert.equal((await put(port, '/api/data/leads/l1', records(now).lead)).status, 200);
  assert.equal((await put(port, '/api/data/emails/e1', records(now).email)).status, 200);
  const inode = fs.statSync(db).ino;
  await app.close();
  assert.deepEqual(fs.readdirSync(path.dirname(db)).filter(n => n.startsWith('cold.db')), ['cold.db'], 'quitting merged and removed the write-ahead files');
  app = await launch(home, port);
  try {
    const snap = (await api(port, '/api/data')).body;
    assert.deepEqual(snap.leads.map(l => l.id), ['l1']);
    assert.deepEqual(snap.emails.map(e => [e.id, e.handoffs[0].how]), [['e1', 'copy']], 'the outreach history survived');
    assert.equal(fs.statSync(db).ino, inode, 'the database was kept, not recreated');
  } finally { await app.close(); }
  await rmHome(home);
});

test('linux: SIGTERM (end of a desktop session) quits cleanly: the process exits and the library is closed', { skip: SKIP, timeout: 90000 }, async () => {
  const home = newHome(), port = await freePort();
  const data = path.join(home, '.config', 'Cold');
  const { child, exit } = startRaw(home, port, path.join(home, 'dialog.json'));
  for (let i = 0; i < 100 && !(await api(port, '/api/data/ping').then(r => r.status === 200, () => false)); i++) await new Promise(r => setTimeout(r, 200));
  assert.equal((await put(port, '/api/data/leads/l1', records(Date.now()).lead)).status, 200);
  child.kill('SIGTERM');
  const r = await Promise.race([exit, new Promise(res => setTimeout(() => res('timeout'), 20000))]);
  if (r === 'timeout') { child.kill('SIGKILL'); assert.fail('the app did not exit after SIGTERM'); }
  assert.deepEqual(fs.readdirSync(data).filter(n => n.startsWith('cold.db')), ['cold.db']);
  await rmHome(home);
});

test('linux: an existing library is used as it is: records kept, permissions not rewritten, nothing created elsewhere', { skip: SKIP, timeout: 90000 }, async () => {
  const home = newHome(), port = await freePort(), now = Date.now();
  const data = path.join(home, '.config', 'Cold'), db = path.join(data, 'cold.db');
  fs.mkdirSync(data, { recursive: true, mode: 0o755 });
  const { createDb } = require('../lib/db.js');
  const old = createDb(db); old.put('leads', 'old1', records(now).lead); old.close();
  fs.chmodSync(db, 0o644); fs.chmodSync(data, 0o755);
  const bytes = fs.readFileSync(db).length;
  const app = await launch(home, port);
  try {
    assert.deepEqual((await api(port, '/api/data')).body.leads.map(l => l.id), ['old1']);
    assert.equal(mode(db), '644', 'an existing library keeps its permissions (Cold only sets them on files and folders it creates)');
    assert.equal(mode(data), '755');
    assert.ok(fs.statSync(db).size >= bytes);
    const found = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/^cold\.db/.test(e.name)) found.push(f); } };
    walk(home);
    assert.deepEqual(found.sort(), [db, `${db}-shm`, `${db}-wal`].filter(f => fs.existsSync(f)).sort(), 'no second library appeared anywhere under the home folder');
  } finally { await app.close(); }
  await rmHome(home);
});

test('linux: a library that can not be opened is reported with its place and reason, the app does not start, and nothing is replaced', { skip: SKIP, timeout: 120000 }, async () => {
  for (const [label, make, reason] of [
    ['a file that is not a database', db => fs.writeFileSync(db, 'this is not a sqlite file, but it is somebody\'s data\n'), /damaged/],
    ['a folder where the file should be', db => fs.mkdirSync(db), /unable to open database file|EISDIR|Problem:/],
  ]) {
    const home = newHome(), port = await freePort(), dialogFile = path.join(home, 'dialog.json');
    const data = path.join(home, '.config', 'Cold'), db = path.join(data, 'cold.db');
    fs.mkdirSync(data, { recursive: true });
    make(db);
    const before = fs.statSync(db).isDirectory() ? 'dir' : fs.readFileSync(db, 'utf8');
    const { exit } = startRaw(home, port, dialogFile);
    const r = await Promise.race([exit, new Promise(res => setTimeout(() => res('timeout'), 30000))]);
    assert.notEqual(r, 'timeout', `${label}: the app must stop, not hang`);
    assert.equal(r.code, 1, `${label}: exits with an error`);
    const shown = JSON.parse(fs.readFileSync(dialogFile, 'utf8'));
    assert.match(shown.title, /can't open its library/, label);
    assert.ok(shown.message.includes(data), `${label}: says where the library is`);
    assert.match(shown.message, reason, label);
    assert.match(shown.message, /Nothing that was already there was changed/);
    assert.ok(!shown.message.includes('somebody'), 'file contents are never put in the message');
    assert.equal(fs.statSync(db).isDirectory() ? 'dir' : fs.readFileSync(db, 'utf8'), before, `${label}: left exactly as it was`);
    assert.deepEqual(fs.readdirSync(data).filter(n => /^cold\.db/.test(n)), ['cold.db'], `${label}: no replacement or side file was created`);
    await assert.rejects(api(port, '/api/data/ping'), `${label}: no server is listening`);
    await rmHome(home);
  }
});

test('linux: an unwritable data folder is reported the same way (skipped for root, which ignores permissions)', { skip: SKIP || (process.getuid && process.getuid() === 0 ? 'root ignores file permissions' : false), timeout: 60000 }, async () => {
  const home = newHome(), port = await freePort(), dialogFile = path.join(home, 'dialog.json');
  const data = path.join(home, '.config', 'Cold');
  fs.mkdirSync(data, { recursive: true }); fs.chmodSync(data, 0o500);
  try {
    const r = await startRaw(home, port, dialogFile).exit;
    assert.equal(r.code, 1);
    assert.match(JSON.parse(fs.readFileSync(dialogFile, 'utf8')).message, /permission/);
  } finally { fs.chmodSync(data, 0o700); await rmHome(home); }
});
