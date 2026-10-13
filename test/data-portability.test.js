// Export, restore and erase: format and policy (pure), the store paths on web-style storage and on the real SQLite server, and the secrets rule.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

const mem = () => { const d = {}; return { d, getItem: k => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; };
const E = (id, o = {}) => ({ id, createdAt: 1000, status: 'draft', mode: 'email', recipient: { name: `R ${id}`, company: 'Co', email: `${id}@co.io` }, subject: 's', what: 'w', why: 'y', ask: 'a', note: '', ...o });
const P = (id, o = {}) => ({ id, name: `Product ${id}`, what: 'does things', order: 0, ...o });
const L = (id, o = {}) => ({ id, name: `Lead ${id}`, company: 'Acme', email: `${id}@acme.io`, list: 'Q4', createdAt: 5, ...o });
const NOW = new Date(2026, 9, 14, 12);
const lib = (o = {}) => ({ products: [], emails: [], leads: [], settings: {}, ...o });

async function webStore(seed = {}) {
  const { createStore } = await load('src/state/store.js');
  const storage = mem();
  for (const [k, v] of Object.entries(seed)) storage.setItem(`cold.${k}`, JSON.stringify(v));
  const store = createStore({ storage }); store.start({ db: null });
  return { store, storage };
}

// ---------------------------------------------------------------------------------------------------------- format
test('export: versioned, named for people, round-trips every field, and excludes anything credential-like', async () => {
  const x = await load('src/domain/dataExport.js');
  const sent = E('e1', { status: 'sent', sentAt: 2000, note: 'call Tue', sentCopy: { subject: 's', text: 't', at: 2000 }, followUp: { due: 9000, count: 1 }, handoffs: [{ at: 1, how: 'copy' }], futureField: { keep: [1, 2] }, apiKey: 'sk-SECRET', nested: { token: 'tok-SECRET', ok: 1 } });
  const replied = E('e2', { status: 'replied', repliedAt: 3000 });
  const file = x.buildExport(lib({ products: [P('p1', { extra: 'x' })], emails: [sent, replied], leads: [L('l1', { custom: { Region: 'EU' } })], settings: { signature: 'R', followUp: { max: 2 }, apiKey: 'sk-SECRET', googleRefreshToken: 'r-SECRET', provider: 'x' } }), { now: NOW });
  const text = x.exportText(file);
  assert.equal(file.format, 'cold-export'); assert.equal(file.version, 1); assert.deepEqual(file.counts, { products: 1, emails: 2, leads: 1 });
  assert.equal(x.exportFilename(NOW), 'cold-export-2026-10-14.json');
  assert.ok(!/SECRET/.test(text), 'no credential value in the export');
  assert.deepEqual(Object.keys(file.data.settings).sort(), ['followUp', 'signature']);
  const back = x.parseExport(text); assert.ok(back.ok);
  const e1 = back.file.data.emails.find(e => e.id === 'e1');
  assert.deepEqual([e1.status, e1.sentAt, e1.note, e1.sentCopy.at, e1.followUp.due, e1.futureField.keep, e1.nested.ok, e1.handoffs.length], ['sent', 2000, 'call Tue', 2000, 9000, [1, 2], 1, 1]);
  assert.equal(back.file.data.emails.find(e => e.id === 'e2').repliedAt, 3000);
  assert.equal(back.file.data.leads[0].custom.Region, 'EU'); assert.equal(back.file.data.products[0].extra, 'x');
});

test('export: an empty library exports an empty, valid file; a large one validates quickly', async () => {
  const x = await load('src/domain/dataExport.js');
  const empty = x.buildExport(lib(), { now: NOW }); assert.equal(x.totalRecords(empty.counts), 0); assert.ok(x.parseExport(x.exportText(empty)).ok);
  const leads = Array.from({ length: 20000 }, (_, i) => L(`l${i}`, { email: `l${i}@x.io` }));
  const t = Date.now(); const big = x.buildExport(lib({ leads }), { now: NOW }); const r = x.parseExport(x.exportText(big));
  assert.ok(r.ok && r.counts.leads === 20000); assert.ok(Date.now() - t < 10000);
});

test('validation: invalid JSON, wrong format, unsupported version, truncated or malformed files are rejected with messages that hold no content', async () => {
  const x = await load('src/domain/dataExport.js');
  const good = x.exportText(x.buildExport(lib({ products: [P('p1')], emails: [E('e1')], leads: [L('l1')] }), { now: NOW }));
  const bad = (text, re) => { const r = x.parseExport(text); assert.equal(r.ok, false, text.slice(0, 40)); assert.match(r.errors.join(' '), re); assert.ok(!/Lead l1|Acme|R e1/.test(r.errors.join(' ')), 'messages never echo record content'); };
  bad('', /empty/); bad('   ', /empty/); bad('not json', /valid JSON/); bad(good.slice(0, good.length - 40), /valid JSON/);
  bad('[]', /isn't a Cold export/); bad('{"format":"other"}', /isn't a Cold export/);
  const f = JSON.parse(good);
  bad(JSON.stringify({ ...f, version: 2 }), /newer Cold/); bad(JSON.stringify({ ...f, version: 'x' }), /no version/); bad(JSON.stringify({ ...f, version: 0 }), /isn't supported/);
  bad(JSON.stringify({ ...f, data: { ...f.data, leads: undefined } }), /"leads" list is missing/);
  bad(JSON.stringify({ ...f, data: { ...f.data, leads: [{ name: 'no id' }] } }), /invalid id/);
  bad(JSON.stringify({ ...f, data: { ...f.data, leads: [L('a'), L('a')] }, counts: undefined }), /repeats the id/);
  bad(JSON.stringify({ ...f, data: { ...f.data, products: [{ id: 'p', name: '' }] }, counts: undefined }), /no name/);
  bad(JSON.stringify({ ...f, data: { ...f.data, emails: [{ id: 'e', recipient: 'x' }] }, counts: undefined }), /recipient should be an object/);
  bad(JSON.stringify({ ...f, data: { ...f.data, emails: [E('e1'), E('e2')] } }), /may be truncated/);
  bad(JSON.stringify({ ...f, data: { ...f.data, emails: [E('../etc')] }, counts: undefined }), /invalid id/);
  bad(JSON.stringify({ ...f, data: { ...f.data, leads: [L('x', { name: 5 })] }, counts: undefined }), /no name/);
  assert.equal(x.parseExport('x'.repeat(10), { size: x.MAX_FILE_BYTES + 1 }).ok, false);
  const warned = x.parseExport(JSON.stringify({ ...f, data: { ...f.data, settings: { apiKey: 'sk-1' } } })); assert.ok(warned.ok); assert.match(warned.warnings[0], /ignored and never stored/);
});

test('plan: add mode keeps everything, skips identical records, lists conflicts and duplicate people, and never overwrites', async () => {
  const x = await load('src/domain/dataExport.js'); const { leadKey } = await load('src/domain/leads.js');
  const file = x.buildExport(lib({ products: [P('p1'), P('p2')], emails: [E('e1'), E('e2', { note: 'file note' })], leads: [L('l1'), L('l9', { email: 'same@person.io' }), L('l3')] }), { now: NOW });
  const existing = lib({ products: [P('p1')], emails: [E('e2', { note: 'local note', updatedAt: 5 }), E('e1', { updatedAt: 77 })], leads: [L('l5', { email: 'same@person.io' })] });
  const plan = x.planRestore(file, existing, { mode: 'add', leadKey });
  assert.deepEqual(plan.counts.add, { products: 1, emails: 0, leads: 2 }); assert.deepEqual(plan.counts.same, { products: 1, emails: 1, leads: 0 });
  assert.deepEqual(plan.conflicts.map(c => c.id), ['e2']); assert.deepEqual(plan.duplicatePeople.map(d => [d.id, d.sameAs]), [['l9', 'l5']]);
  assert.deepEqual(plan.remove, { products: [], emails: [], leads: [] }); assert.equal(plan.settings, null);
});

test('plan: replace mode makes the library equal to the file, and says what it will delete', async () => {
  const x = await load('src/domain/dataExport.js');
  const file = x.buildExport(lib({ products: [P('p1')], emails: [E('e1', { note: 'from file' })], settings: { signature: 'Sig' } }), { now: NOW });
  const plan = x.planRestore(file, lib({ products: [P('p1'), P('p2')], emails: [E('e1'), E('e3')], leads: [L('l1')] }), { mode: 'replace' });
  assert.deepEqual(plan.counts.remove, { products: 1, emails: 1, leads: 1 }); assert.deepEqual(plan.counts.add.emails, 1);
  assert.equal(plan.settings.signature, 'Sig'); assert.throws(() => x.planRestore(file, lib(), { mode: 'merge' }));
});

// ---------------------------------------------------------------------------------------------------------- store: web storage
test('restore on web storage: round trip into a clean library reproduces ids, notes, status, timestamps and extra fields', async () => {
  const x = await load('src/domain/dataExport.js'); const dl = await load('src/services/dataLifecycle.js');
  const a = await webStore({ products: [P('p1')], emails: [E('e1', { status: 'sent', sentAt: 2222, note: 'n', sentCopy: { subject: 's', text: 't', at: 2222 }, futureField: 7 }), E('e2', { status: 'replied', repliedAt: 3333 })], leads: [L('l1', { custom: { Region: 'EU' } })] });
  const { text, filename, counts } = dl.makeExport(a.store, NOW);
  assert.equal(filename, 'cold-export-2026-10-14.json'); assert.deepEqual(counts, { products: 1, emails: 2, leads: 1 });
  const b = await webStore();
  const review = dl.reviewFile(b.store, text, { mode: 'add' }); assert.ok(review.ok);
  const done = await dl.applyRestore(b.store, review.plan); assert.equal(done.ok, true);
  const got = Object.fromEntries(b.store.state.emails.map(e => [e.id, e]));
  assert.deepEqual([got.e1.status, got.e1.sentAt, got.e1.note, got.e1.sentCopy.at, got.e1.futureField, got.e2.repliedAt], ['sent', 2222, 'n', 2222, 7, 3333]);
  assert.deepEqual([b.store.state.products[0].id, b.store.state.leads[0].id, b.store.state.leads[0].custom.Region], ['p1', 'l1', 'EU']);
  // restoring the same file again changes nothing and says so
  const again = dl.reviewFile(b.store, text, { mode: 'add' }); assert.equal(again.plan.changes, 0);
  assert.equal((await dl.applyRestore(b.store, again.plan)).ok, true); assert.equal(b.store.state.emails.length, 2);
  void x;
});

test('restore: a conflicting record is reported and the existing one is kept; a malformed file touches nothing', async () => {
  const dl = await load('src/services/dataLifecycle.js');
  const a = await webStore({ emails: [E('e1', { note: 'file version' })] }); const { text } = dl.makeExport(a.store, NOW);
  const b = await webStore({ emails: [E('e1', { note: 'my version' })], products: [P('p9')] });
  const before = JSON.stringify(b.storage.d);
  const r = dl.reviewFile(b.store, text, { mode: 'add' }); assert.equal(r.plan.conflicts.length, 1);
  const done = await dl.applyRestore(b.store, r.plan); assert.equal(done.conflicts, 1);
  assert.equal(b.store.state.emails[0].note, 'my version'); assert.equal(JSON.stringify(b.storage.d), before, 'nothing was written');
  const broken = dl.reviewFile(b.store, text.slice(0, 200)); assert.equal(broken.ok, false); assert.equal(JSON.stringify(b.storage.d), before);
});

test('restore: replace deletes what the file lacks, keeps unrelated settings, and a failure part-way is rolled back and verified', async () => {
  const dl = await load('src/services/dataLifecycle.js');
  const src = await webStore({ products: [P('p1')], emails: [E('e1')] }); const { text } = dl.makeExport(src.store, NOW);
  const t = await webStore({ products: [P('p1'), P('p2')], emails: [E('e1', { note: 'mine' }), E('e5')], leads: [L('l1')], settings: { signature: 'old', firstRun: { dismissed: true } } });
  const keepFirstRun = JSON.stringify(t.store.state.settings.firstRun);
  const plan = dl.reviewFile(t.store, text, { mode: 'replace' }).plan;
  assert.deepEqual(plan.counts.remove, { products: 1, emails: 1, leads: 1 });
  const orig = t.store.deleteRecords.bind(t.store); let calls = 0;
  t.store.deleteRecords = async (...a) => { if (++calls === 2) throw new Error('disk full'); return orig(...a); };
  const snap = JSON.stringify({ p: t.store.state.products, e: t.store.state.emails, l: t.store.state.leads });
  await assert.rejects(dl.applyRestore(t.store, plan), e => e.code === 'restore_failed' && e.rolledBack === true && !/disk/.test(e.message));
  const noStamp = j => JSON.stringify(JSON.parse(j), (k, v) => (k === 'updatedAt' ? undefined : v));
  assert.equal(noStamp(JSON.stringify({ p: t.store.state.products, e: t.store.state.emails, l: t.store.state.leads })), noStamp(snap), 'library is back as it was');
  t.store.deleteRecords = orig;
  assert.equal((await dl.applyRestore(t.store, dl.reviewFile(t.store, text, { mode: 'replace' }).plan)).ok, true);
  assert.deepEqual([t.store.state.products.map(p => p.id), t.store.state.emails.map(e => e.id), t.store.state.leads.length], [['p1'], ['e1'], 0]);
  assert.equal(JSON.stringify(t.store.state.settings.firstRun), keepFirstRun, 'settings a file never holds are untouched');
});

test('restore: replace is refused on a paired or Sheets library', async () => {
  const dl = await load('src/services/dataLifecycle.js'); const a = await webStore({ products: [P('p1')] }); const { text } = dl.makeExport(a.store, NOW);
  const b = await webStore(); b.store.state.paired = true;
  await assert.rejects(dl.applyRestore(b.store, dl.reviewFile(b.store, text, { mode: 'replace' }).plan), e => e.code === 'not_supported');
  b.store.state.paired = false; b.store.state.storage = 'sheets';
  await assert.rejects(dl.applyRestore(b.store, dl.reviewFile(b.store, text, { mode: 'replace' }).plan), e => e.code === 'not_supported');
});

test('export fails visibly instead of producing a bad file', async () => {
  const dl = await load('src/services/dataLifecycle.js'); const a = await webStore();
  a.store.state.leads.push({ id: '', name: 'x' });
  assert.throws(() => dl.makeExport(a.store, NOW), e => e.code === 'export_invalid');
});

// ---------------------------------------------------------------------------------------------------------- erase
test('erase on web storage removes Cold keys only, blocks autosave and stale saves, and reports honestly', async () => {
  const a = await webStore({ products: [P('p1')], emails: [E('e1')], leads: [L('l1')], settings: { signature: 'S' } });
  a.storage.setItem('unrelated.site', 'keep me'); a.storage.setItem('cold.otherlib.products', '[]');
  a.store.saveCompose({ name: 'draft in progress' });
  const removed = await a.store.eraseLocalData(); assert.deepEqual(removed, { products: 1, emails: 1, leads: 1 });
  assert.deepEqual(a.store.state.emails, []); assert.equal(a.storage.getItem('unrelated.site'), 'keep me');
  await assert.rejects(a.store.saveEmail(E('late')), e => e.code === 'erased' || /erased/.test(e.message || ''));
  a.store.saveCompose({ name: 'x' }); await new Promise(r => setTimeout(r, 700));
  assert.deepEqual(Object.keys(a.storage.d).filter(k => k.startsWith('cold.') && !k.includes('otherlib')), [], 'nothing was recreated');
  // a storage that refuses to delete is reported, not hidden
  const b = await webStore({ emails: [E('e1')] }); const rm = b.storage.removeItem; b.storage.removeItem = () => { throw new Error('locked'); };
  await assert.rejects(b.store.eraseLocalData(), e => e.code === 'erase_failed'); b.storage.removeItem = rm;
  assert.equal(b.store.state.emails.length, 1, 'state still shows what is really there');
  await b.store.saveEmail(E('e2')); assert.equal(b.store.state.emails.length, 2, 'unlocked after a failed erase');
  const c = await webStore({ emails: [E('e1')] }); c.storage.removeItem = () => {};
  await assert.rejects(c.store.eraseLocalData(), e => e.code === 'erase_incomplete' && e.remaining.emails === 1);
});

test('erase is refused for a paired library and for Google Sheets storage, with the reason', async () => {
  const a = await webStore({ emails: [E('e1')] }); a.store.state.paired = true;
  await assert.rejects(a.store.eraseLocalData(), e => e.code === 'not_supported' && /desktop/.test(e.message)); assert.equal(a.store.state.emails.length, 1);
  a.store.state.paired = false; a.store.state.storage = 'sheets';
  await assert.rejects(a.store.eraseLocalData(), e => e.code === 'not_supported' && /Google/.test(e.message));
});

test('erase does not run at startup, on import validation or when settings change', async () => {
  const dl = await load('src/services/dataLifecycle.js'); const a = await webStore({ emails: [E('e1')], products: [P('p1')] });
  dl.reviewFile(a.store, 'garbage'); dl.reviewFile(a.store, '{}'); await a.store.saveSettings({ signature: 'new' });
  assert.deepEqual([a.store.state.emails.length, a.store.state.products.length], [1, 1]);
});

// ---------------------------------------------------------------------------------------------------------- desktop (real SQLite server)
async function bootDesktop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-portability-'));
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN']) process.env[k] = '';
  Object.assign(process.env, { LLM_PROVIDER: 'ollama', COLD_DB_FILE: path.join(dir, 'cold.db'), COLD_SETTINGS_FILE: path.join(dir, 's.json') });
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  return { dir, server, base, db: server.db, fetchImpl: (p, init) => fetch(base + p, init), close: () => new Promise(r => { server.close(r); server.db.close(); }) };
}

test('desktop: export and restore go through SQLite; erase removes the content from the database file and WAL, and keeps pairing and settings.json', async () => {
  const { createRemoteDb } = await load('src/services/sqliteDb.js'); const { createStore } = await load('src/state/store.js'); const dl = await load('src/services/dataLifecycle.js');
  const t = await bootDesktop();
  try {
    fs.writeFileSync(path.join(t.dir, 's.json'), JSON.stringify({ provider: 'x', apiKey: 'sk-KEEP-IN-SETTINGS' }));
    const token = t.db.extensionToken();
    const db = createRemoteDb({ fetchImpl: t.fetchImpl, readLocal: () => null, poll: false }); await db.load();
    const store = createStore({ storage: mem() }); store.start({ db });
    await dl.applyRestore(store, dl.reviewFile(store, dl.makeExport((await webStore({ products: [P('p1')], emails: [E('e1', { note: 'UNIQUE-NOTE-MARKER-123', sentAt: 5, status: 'sent' })], leads: [L('l1', { name: 'UNIQUE-LEAD-MARKER-456' })] })).store, NOW).text).plan);
    assert.deepEqual(t.db.snapshot().emails.map(e => [e.id, e.status, e.sentAt]), [['e1', 'sent', 5]]);
    const out = dl.makeExport(store, NOW); assert.equal(out.counts.leads, 1); assert.ok(!/KEEP-IN-SETTINGS|sk-/.test(out.text));
    // the erase endpoint is not reachable by the extension/web token, and needs the exact confirmation
    const raw = (body, auth) => fetch(`${t.base}api/data/erase`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await raw({ confirm: 'erase-my-cold-data' }, true)).status, 403);
    const http = require('node:http');
    const cross = (headers) => new Promise(res => { const r = http.request(`${t.base}api/data/erase`, { method: 'POST', headers: { 'content-type': 'text/plain', ...headers } }, x => { x.resume(); res(x.statusCode); }); r.end(JSON.stringify({ confirm: 'erase-my-cold-data' })); });
    assert.equal(await cross({ 'sec-fetch-site': 'cross-site' }), 403, 'another website cannot erase');
    assert.equal(await cross({ origin: 'https://evil.example' }), 403);
    assert.equal((await raw({})).status, 400); assert.equal((await raw({ confirm: 'yes' })).status, 400);
    assert.equal(t.db.snapshot().emails.length, 1, 'refused requests deleted nothing');
    const left = await store.eraseLocalData(); assert.deepEqual(left, { products: 1, emails: 1, leads: 1 });
    assert.deepEqual(t.db.snapshot(), { ...t.db.snapshot(), products: [], emails: [], leads: [] });
    assert.equal(t.db.extensionToken(), token, 'pairing is not touched');
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 's.json'), 'utf8')).apiKey, 'sk-KEEP-IN-SETTINGS', 'provider keys are not Cold records and stay');
    await assert.rejects(store.saveEmail(E('late')), e => e.code === 'erased');
    const bytes = fs.readdirSync(t.dir).filter(f => f.startsWith('cold.db')).map(f => fs.readFileSync(path.join(t.dir, f), 'latin1')).join('');
    for (const m of ['UNIQUE-NOTE-MARKER-123', 'UNIQUE-LEAD-MARKER-456']) assert.ok(!bytes.includes(m), `${m} is gone from cold.db and its WAL`);
  } finally { await t.close(); }
});
