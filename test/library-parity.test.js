// One library contract, four adapters: the same operations must give the same results whether records live in browser storage
// (standalone store), the web replica, the extension replica, or the desktop app's SQLite behind the real server. Existing records
// are read and written in place (no migration), and unknown statuses and fields survive. Real persistence everywhere; no mocks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

const memLS = () => { const d = {}; return { d, getItem: k => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; };
const memChrome = () => { let v = null; return { get: async () => v && JSON.parse(JSON.stringify(v)), set: async x => { v = JSON.parse(JSON.stringify(x)); }, peek: () => v }; };

// Records exactly as older Cold versions stored them: no updatedAt, no status, an unknown status, unknown fields.
const SEED = [
  { id: 'legacy', createdAt: 100, recipient: { name: 'Lee' }, subject: 'old', what: 'w', why: 'y', ask: 'a?', note: 'kept' },
  { id: 'future', createdAt: 300, status: 'scheduled', sentAt: 77, futureField: { v: 2 }, recipient: { name: 'Fay', phone: '555' }, sentCopy: { subject: 's', text: 't', at: 77, sig: 'v2' }, subject: 'f', what: 'w', why: 'y', ask: 'a?' },
  { id: 'sentone', createdAt: 200, status: 'sent', sentAt: 5, sentCopy: { subject: 'orig', text: 'orig text', at: 5 }, recipient: { name: 'Sid' }, subject: 'orig', what: 'w', why: 'y', ask: 'a?' },
];

async function adapters() {
  const storeMod = await load('src/state/store.js'), repMod = await load('src/services/replica.js'), rsMod = await load('src/services/replicaStorage.js'), dbMod = await load('src/services/sqliteDb.js');
  const out = [];
  // 1. standalone store on browser storage
  { const ls = memLS(); ls.d['cold.emails'] = JSON.stringify(SEED);
    out.push({ name: 'browser-store', open: async () => { const s = storeMod.createStore({ storage: ls }); s.start({}); return s; }, raw: async () => JSON.parse(ls.d['cold.emails']), close: async () => {} }); }
  // 2. web replica over the same localStorage keys
  { const ls = memLS(); ls.d['cold.emails'] = JSON.stringify(SEED);
    out.push({ name: 'web-replica', open: async () => { const r = repMod.createReplica({ storage: rsMod.localReplicaStorage(ls) }); await r.load(); const s = storeMod.createStore({ storage: {} }); s.start({ db: r }); return s; }, raw: async () => JSON.parse(ls.d['cold.emails']), close: async () => {} }); }
  // 3. extension replica over chrome.storage-shaped storage
  { const st = memChrome(); await st.set({ products: {}, emails: Object.fromEntries(SEED.map(r => [r.id, r])), outbox: [], lastSync: 0 });
    out.push({ name: 'extension-replica', open: async () => { const r = repMod.createReplica({ storage: st }); await r.load(); const s = storeMod.createStore({ storage: {} }); s.start({ db: r }); return s; }, raw: async () => Object.values(st.peek().emails), close: async () => {} }); }
  // 4. desktop: the real server and SQLite file
  { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-parity-'));
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN']) process.env[k] = '';
    Object.assign(process.env, { LLM_PROVIDER: 'ollama', COLD_DB_FILE: path.join(dir, 'cold.db'), COLD_SETTINGS_FILE: path.join(dir, 's.json') });
    delete require.cache[require.resolve('../server')];
    const server = require('../server');
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    for (const r of SEED) server.db.put('emails', r.id, r);
    out.push({ name: 'desktop-sqlite', open: async () => { const db = dbMod.createRemoteDb({ fetchImpl: (p, i) => fetch(base + p, i), poll: false, migrate: false }); await db.load(); const s = storeMod.createStore({ storage: {} }); s.start({ db }); return s; },
      raw: async () => server.db.snapshot().emails, close: () => new Promise(r => { server.close(r); server.db.close(); }) }); }
  return out;
}

/** The same script on every adapter. Returns what an observer could see, with volatile values (versions) reduced to facts. */
async function run(a) {
  const { applyStatus, statusOf } = await load('src/domain/outreach.js');
  const trace = {};
  const s = await a.open(), stale = await a.open(), stale2 = await a.open();
  const get = (st, id) => st.state.emails.find(e => e.id === id);
  const raw = async id => (await a.raw()).find(r => r.id === id);
  trace.listOrder = s.state.emails.map(e => e.id);                                            // newest first
  trace.readBack = s.state.emails.map(e => [e.id, statusOf(e), e.status]);                   // missing status reads as draft; unknown stays
  // 1. edit a known field of a record with unknown status and unknown fields
  await s.saveEmail({ ...get(s, 'future'), note: 'called' });
  const f = await raw('future');
  trace.unknownKept = [f.status, f.sentAt, f.futureField, f.recipient.phone, f.sentCopy, f.note, Number.isFinite(f.updatedAt)];
  // 2. the outreach workflow: draft -> sent -> edit -> replied -> edit
  await s.saveEmail(applyStatus(get(s, 'legacy'), 'sent', { now: 50 }));
  await s.saveEmail({ ...get(s, 'legacy'), subject: 'rewritten', what: 'Totally different.' });
  await s.saveEmail(applyStatus(get(s, 'legacy'), 'replied', { now: 60 }));
  await s.saveEmail({ ...get(s, 'legacy'), note: 'they asked for pricing' });
  const l = await raw('legacy');
  trace.workflow = [l.status, l.sentAt, l.repliedAt, l.sentCopy && l.sentCopy.subject, l.sentCopy && l.sentCopy.at, l.note, l.subject];
  // 3. a stale client (holding the legacy copy from before step 2): a different field merges, the same field is refused
  await stale.saveEmail({ ...get(stale, 'legacy'), recipient: { ...get(stale, 'legacy').recipient, email: 'lee@x.co' } });
  const l2 = await raw('legacy');
  trace.staleMerge = [l2.status, l2.repliedAt, l2.note, l2.recipient.email];
  const before = JSON.stringify(await a.raw());
  const clash = await stale2.saveEmail({ ...get(stale2, 'legacy'), note: 'stale note' }).then(() => 'saved', e => `${e.code}:${e.conflicts}`);
  trace.staleClash = [clash, JSON.stringify(await a.raw()) === before];
  // 4. create and delete
  await s.saveEmail({ id: 'fresh', createdAt: 400, recipient: { name: 'New' }, subject: 'n', what: 'w', why: 'y', ask: 'a?' });
  await s.deleteEmail('sentone');
  trace.afterCrud = (await a.raw()).map(r => r.id).sort();
  trace.finalOrder = s.state.emails.map(e => e.id);
  trace.untouched = (await raw('future')).sentCopy;
  return trace;
}

test('the same operations give the same results on browser storage, the web replica, the extension replica and desktop SQLite', async () => {
  const results = {};
  for (const a of await adapters()) { try { results[a.name] = await run(a); } finally { await a.close(); } }
  const names = Object.keys(results);
  assert.equal(names.length, 4);
  const ref = results[names[0]];
  for (const n of names.slice(1)) assert.deepEqual(results[n], ref, `${n} behaves like ${names[0]}`);
  // and what they agree on is the intended behaviour, not just agreement
  assert.deepEqual(ref.listOrder, ['future', 'sentone', 'legacy']);
  assert.deepEqual(ref.readBack, [['future', 'unknown', 'scheduled'], ['sentone', 'sent', 'sent'], ['legacy', 'draft', 'draft']]);
  assert.deepEqual(ref.unknownKept, ['scheduled', 77, { v: 2 }, '555', { subject: 's', text: 't', at: 77, sig: 'v2' }, 'called', true]);
  assert.deepEqual(ref.workflow, ['replied', 50, 60, 'old', 50, 'they asked for pricing', 'rewritten']);
  assert.deepEqual(ref.staleMerge, ['replied', 60, 'they asked for pricing', 'lee@x.co']);
  assert.deepEqual(ref.staleClash, ['conflict:note', true]);
  assert.deepEqual(ref.afterCrud, ['fresh', 'future', 'legacy']);
  assert.deepEqual(ref.finalOrder, ['fresh', 'future', 'legacy']);
});

test('the desktop database stamps versions exactly as the shared contract does (its CommonJS copy of the rule cannot drift)', async () => {
  const { createDb } = require('../lib/db');
  const lib = await load('src/domain/library.js');
  const db = createDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cold-stamp-')), 'c.db'));
  try {
    db.put('emails', 'a', { id: 'a', updatedAt: 10 });
    for (let i = 0; i < 5; i++) {
      const before = db.snapshot().emails[0];
      const { updatedAt } = db.put('emails', 'a', { id: 'a', n: i }, { base: lib.versionOf(before) });
      assert.equal(updatedAt >= lib.nextVersion(before, 0), true);
      assert.equal(updatedAt > lib.versionOf(before), true, 'strictly newer, even within one millisecond');
    }
    // the stale/new rules agree with applySave
    const cur = db.snapshot().emails[0];
    assert.throws(() => db.put('emails', 'a', { id: 'a' }, { base: lib.versionOf(cur) - 1 }), e => e.code === 'conflict');
    assert.throws(() => db.put('emails', 'a', { id: 'a' }, { base: 'new' }), e => e.code === 'conflict');
    const stale = lib.versionOf(cur) - 1;
    assert.equal(lib.applySave({ id: 'a', mine: { id: 'a', n: 'clash' }, stored: cur, expected: stale }).ok, false, 'same field changed on both sides');
    assert.equal(lib.applySave({ id: 'a', mine: { id: 'a', note: 'x' }, stored: cur, expected: stale }).merged, true, 'different fields merge');
    assert.equal(lib.applySave({ id: 'a', mine: { id: 'a', n: 'clash' }, stored: cur, expected: null }).ok, false, 'a "new" record that already exists');
    assert.equal(lib.applySave({ id: 'a', mine: { id: 'a', note: 'x' }, stored: cur, expected: lib.versionOf(cur) }).ok, true);
  } finally { db.close(); }
});
