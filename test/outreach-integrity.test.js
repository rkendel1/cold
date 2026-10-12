// Outreach data integrity across surfaces: unknown statuses and fields survive, and a save based on an old copy can never
// silently replace a newer one. These tests use the real stores: localStorage semantics (two "tabs" on one storage), the real
// SQLite database behind the real server (two "windows" and raw HTTP), and the real replica syncing with that server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

const memStorage = () => { const d = {}; return { d, getItem: k => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; };
const saved = (ls, key = 'cold.emails') => JSON.parse(ls.d[key]);
const REC = (o = {}) => ({ id: 'e1', createdAt: 1000, status: 'draft', mode: 'email', recipient: { name: 'Sam', company: 'TrialCo', email: 'sam@trialco.com' }, subject: 'hello', what: 'We help.', why: 'You wrote it.', ask: 'Could I ask?', note: '', ...o });

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-integrity-'));
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN']) process.env[k] = '';
  Object.assign(process.env, { LLM_PROVIDER: 'ollama', COLD_DB_FILE: path.join(dir, 'cold.db'), COLD_SETTINGS_FILE: path.join(dir, 's.json') });
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`, token = server.db.extensionToken();
  const raw = (p, init = {}, auth = false) => fetch(base + p, { ...init, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) } });
  // the same shape the extension/web link uses, including the status and body of a refused write
  const link = { async call(p, init) { const r = await raw(p, init, true); const body = await r.json().catch(() => null); if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, body }); return body; },
    get(p) { return this.call(p); }, put(p, b) { return this.call(p, { method: 'PUT', body: JSON.stringify(b) }); }, del(p) { return this.call(p, { method: 'DELETE' }); } };
  return { db: server.db, raw, link, fetchImpl: (p, init) => fetch(base + p, init), close: () => new Promise(r => { server.close(r); server.db.close(); }) };
}
const windowOn = async (t, storeMod, dbMod) => {
  const db = dbMod.createRemoteDb({ fetchImpl: t.fetchImpl, poll: false, migrate: false }); await db.load();
  const store = storeMod.createStore({ storage: {} }); store.start({ db }); return { db, store };
};

// ---------------------------------------------------------------------------------------------------------------- domain
test('an unfamiliar status is "unknown", never "draft"; only a missing status defaults; only an explicit choice replaces it', async () => {
  const { statusOf, applyStatus, countByStatus, filterOutreach } = await load('src/domain/outreach.js');
  const { normalizeEmail } = await load('src/state/storage.js');
  assert.deepEqual(['draft', 'sent', 'replied'].map(s => statusOf({ status: s })), ['draft', 'sent', 'replied']);
  assert.deepEqual([statusOf({}), statusOf({ status: null }), statusOf({ status: '' }), statusOf(null)], ['draft', 'draft', 'draft', 'draft']);   // legacy default
  assert.deepEqual(['archived', 'Sent', 7, 'scheduled'].map(s => statusOf({ status: s })), ['unknown', 'unknown', 'unknown', 'unknown']);
  const odd = REC({ status: 'scheduled', note: 'keep' });
  assert.equal(normalizeEmail(odd).status, 'scheduled');                                                          // loading keeps it
  assert.equal(applyStatus(odd, 'scheduled'), odd, 'not a supported status: nothing happens');
  assert.equal(applyStatus(odd, 'bogus'), odd);
  const sent = applyStatus(odd, 'sent', { now: 5, signature: '' });                                              // a deliberate correction works
  assert.deepEqual([sent.status, sent.sentAt, sent.sentCopy.at], ['sent', 5, 5]);
  assert.equal(countByStatus([odd, REC()]).unknown, 1);
  assert.deepEqual(filterOutreach([odd, REC({ id: 'b' })], { status: 'draft' }).map(e => e.id), ['b']);
});

test('mergeRecords: independent fields merge, the same field conflicts, the sent snapshot is atomic', async () => {
  const { mergeRecords } = await load('src/domain/outreach.js');
  const base = REC({ sentCopy: { subject: 's', text: 't', at: 1 } });
  let m = mergeRecords(base, { ...base, note: 'mine' }, { ...base, status: 'replied', repliedAt: 9 });
  assert.deepEqual([m.conflicts, m.record.note, m.record.status, m.record.repliedAt], [[], 'mine', 'replied', 9]);
  m = mergeRecords(base, { ...base, note: 'mine' }, { ...base, note: 'theirs' });
  assert.deepEqual([m.conflicts, m.record.note], [['note'], 'theirs']);                                           // stored value kept
  m = mergeRecords(base, { ...base, status: 'sent' }, { ...base, status: 'replied' }); assert.deepEqual(m.conflicts, ['status']);
  m = mergeRecords(base, { ...base, note: 'x' }, { ...base, note: 'x' }); assert.deepEqual(m.conflicts, []);   // same change on both sides
  m = mergeRecords(base, { ...base, recipient: { ...base.recipient, email: 'a@b.co' } }, { ...base, recipient: { ...base.recipient, name: 'Samuel' } });
  assert.deepEqual([m.conflicts, m.record.recipient.email, m.record.recipient.name], [[], 'a@b.co', 'Samuel']);
  m = mergeRecords(base, { ...base, sentCopy: { ...base.sentCopy, text: 'A' } }, { ...base, sentCopy: { ...base.sentCopy, subject: 'B' } });
  assert.deepEqual(m.conflicts, ['sentCopy']);                                                                    // never a half-and-half snapshot
  m = mergeRecords(base, { ...base, futureField: { a: 1 } }, { ...base, status: 'replied' });
  assert.deepEqual([m.conflicts, m.record.futureField, m.record.status], [[], { a: 1 }, 'replied']);
});

// ----------------------------------------------------------------------------------------------------------- localStorage
test('local storage: unknown status and unfamiliar fields survive an unrelated edit, exactly as stored', async () => {
  const { createStore } = await load('src/state/store.js');
  const ls = memStorage();
  const stored = REC({ status: 'scheduled', sentAt: 77, repliedAt: 88, sentCopy: { subject: 's', text: 't', at: 77, sig: 'v2' }, recipient: { name: 'Sam', email: 'sam@trialco.com', phone: '555' }, futureScore: { v: 3 }, tags: ['a', 'b'] });
  ls.d['cold.emails'] = JSON.stringify([stored, REC({ id: 'e2', createdAt: 5, status: 'archived' })]);
  const store = createStore({ storage: ls }); store.start({});
  const cur = store.state.emails.find(e => e.id === 'e1');
  assert.equal(cur.status, 'scheduled');
  await store.saveEmail({ ...cur, note: 'called today' });
  const out = saved(ls);
  const e1 = out.find(e => e.id === 'e1');
  assert.deepEqual([e1.status, e1.sentAt, e1.repliedAt, e1.sentCopy, e1.futureScore, e1.tags, e1.recipient.phone, e1.recipient.email, e1.note],
    ['scheduled', 77, 88, { subject: 's', text: 't', at: 77, sig: 'v2' }, { v: 3 }, ['a', 'b'], '555', 'sam@trialco.com', 'called today']);
  assert.equal(out.find(e => e.id === 'e2').status, 'archived', 'a record that was not edited keeps its unfamiliar status');
});

test('local storage: a record with no status keeps the legacy default; defaults never overwrite present values', async () => {
  const { createStore } = await load('src/state/store.js');
  const ls = memStorage();
  ls.d['cold.emails'] = JSON.stringify([{ id: 'old', createdAt: 5, recipient: { name: 'Bo' }, subject: 's', what: 'w', why: 'y', ask: 'a', goal: 'intro', note: 'n', sentAt: 9 }]);
  const store = createStore({ storage: ls }); store.start({});
  await store.saveEmail({ ...store.state.emails[0], note: 'n2' });
  const e = saved(ls)[0];
  assert.deepEqual([e.status, e.goal, e.sentAt, e.createdAt, e.note], ['draft', 'intro', 9, 5, 'n2']);
});

test('local storage: two tabs. Different records both survive; a stale tab cannot erase the other tab\'s records', async () => {
  const { createStore } = await load('src/state/store.js');
  const ls = memStorage();
  ls.d['cold.emails'] = JSON.stringify([REC({ id: 'a' }), REC({ id: 'b', createdAt: 900 })]);
  const tab1 = createStore({ storage: ls }), tab2 = createStore({ storage: ls }); tab1.start({}); tab2.start({});
  await tab1.saveEmail({ ...tab1.state.emails.find(e => e.id === 'a'), note: 'note on A' });
  await tab2.saveEmail({ ...tab2.state.emails.find(e => e.id === 'b'), note: 'note on B' });           // tab2 never saw tab1's change
  await tab2.saveEmail({ ...REC({ id: 'c', createdAt: 2000 }) });                                         // a new record from the stale tab
  const out = Object.fromEntries(saved(ls).map(e => [e.id, e.note]));
  assert.deepEqual(out, { a: 'note on A', b: 'note on B', c: '' });
  // a product save from a stale tab does not put back its old copy of the drafts
  const tab3 = createStore({ storage: ls }); tab3.start({});
  await tab1.saveEmail({ ...tab1.state.emails.find(e => e.id === 'a'), note: 'newer note on A' });
  await tab3.saveProduct({ id: 'p1', name: 'P', what: 'w', order: 0 });
  assert.equal(saved(ls).find(e => e.id === 'a').note, 'newer note on A');
});

test('local storage: the same field changed in two tabs is a conflict; the stored record is kept and the edit is returned to the caller', async () => {
  const { createStore } = await load('src/state/store.js');
  const ls = memStorage();
  ls.d['cold.emails'] = JSON.stringify([REC()]);
  const tab1 = createStore({ storage: ls }), tab2 = createStore({ storage: ls }); tab1.start({}); tab2.start({});
  await tab1.saveEmail({ ...tab1.state.emails[0], note: 'from tab 1' });
  const before = ls.d['cold.emails'];
  await assert.rejects(tab2.saveEmail({ ...tab2.state.emails[0], note: 'from tab 2' }),
    e => e.code === 'conflict' && e.conflicts.includes('note') && e.mine.note === 'from tab 2' && e.current.note === 'from tab 1');
  assert.equal(ls.d['cold.emails'], before, 'a refused save writes nothing');
  assert.equal(tab2.state.emails[0].note, 'from tab 1', 'the refused tab now shows the stored version');
  // having seen it, saving again is a deliberate overwrite and works
  await tab2.saveEmail({ ...tab2.state.emails[0], note: 'from tab 2' });
  assert.equal(saved(ls)[0].note, 'from tab 2');
});

test('local storage: a stale copy cannot revert Replied to Draft or drop a newer sent snapshot', async () => {
  const { createStore } = await load('src/state/store.js');
  const { applyStatus } = await load('src/domain/outreach.js');
  const ls = memStorage();
  ls.d['cold.emails'] = JSON.stringify([REC()]);
  const stale = createStore({ storage: ls }), fresh = createStore({ storage: ls }); stale.start({}); fresh.start({});
  const staleCopy = stale.state.emails[0];                                                                  // a draft with no sent data
  const sent = applyStatus(fresh.state.emails[0], 'sent', { now: 50 }); await fresh.saveEmail(sent);
  await fresh.saveEmail(applyStatus(fresh.state.emails[0], 'replied', { now: 60 }));
  await stale.saveEmail({ ...staleCopy, note: 'typed while stale' });                                      // different field: merges, does not revert
  const r = saved(ls)[0];
  assert.deepEqual([r.status, r.sentAt, r.repliedAt, r.sentCopy.at, r.note], ['replied', 50, 60, 50, 'typed while stale']);
  // an explicit status change from a stale copy is a conflicting status transition: refused
  const stale2 = createStore({ storage: ls }); stale2.start({});
  await fresh.saveEmail({ ...fresh.state.emails[0], status: 'draft' });
  await assert.rejects(stale2.saveEmail(applyStatus(stale2.state.emails[0], 'sent', { now: 70 })), e => e.code === 'conflict' && e.conflicts.includes('status'));
  assert.equal(saved(ls)[0].status, 'draft');
});

test('local storage: editing after "sent" leaves the sent snapshot; editing a replied record keeps status and dates; a reply never invents a send', async () => {
  const { createStore } = await load('src/state/store.js');
  const { applyStatus } = await load('src/domain/outreach.js');
  const ls = memStorage();
  ls.d['cold.emails'] = JSON.stringify([REC()]);
  const store = createStore({ storage: ls }); store.start({});
  await store.saveEmail(applyStatus(store.state.emails[0], 'sent', { now: 50 }));
  const snap = saved(ls)[0].sentCopy;
  await store.saveEmail({ ...store.state.emails[0], subject: 'rewritten', what: 'Totally different.' });
  assert.deepEqual(saved(ls)[0].sentCopy, snap);
  await store.saveEmail(applyStatus(store.state.emails[0], 'replied', { now: 60 }));
  await store.saveEmail({ ...store.state.emails[0], note: 'they asked for pricing', recipient: { ...store.state.emails[0].recipient, email: 'new@trialco.com' } });
  const r = saved(ls)[0];
  assert.deepEqual([r.status, r.sentAt, r.repliedAt, r.sentCopy, r.note], ['replied', 50, 60, snap, 'they asked for pricing']);
  ls.d['cold.emails'] = JSON.stringify([REC({ id: 'x' })]); const s2 = createStore({ storage: ls }); s2.start({});
  await s2.saveEmail(applyStatus(s2.state.emails[0], 'replied', { now: 9 }));
  assert.deepEqual([saved(ls)[0].sentAt, saved(ls)[0].sentCopy, saved(ls)[0].repliedAt], [undefined, undefined, 9]);
});

test('local storage: entries this client cannot read are left in storage when another record is saved or deleted', async () => {
  const { createStore } = await load('src/state/store.js');
  const ls = memStorage();
  const junk = { nope: 1, whatever: 'from a newer version' };
  ls.d['cold.emails'] = JSON.stringify([REC(), junk]);
  const store = createStore({ storage: ls }); store.start({});
  assert.equal(store.state.emails.length, 1);
  await store.saveEmail({ ...store.state.emails[0], note: 'x' });
  assert.deepEqual(saved(ls)[1], junk);
  await store.deleteEmail('e1');
  assert.deepEqual(saved(ls), [junk]);
});

// --------------------------------------------------------------------------------------------------------------- SQLite
test('SQLite: unknown status and fields survive an unrelated edit through the real server; independent windows both keep their changes', async () => {
  const dbMod = await load('src/services/sqliteDb.js'), storeMod = await load('src/state/store.js');
  const t = await boot();
  try {
    t.db.put('emails', 'e1', REC({ status: 'scheduled', sentAt: 4, futureField: { x: 1 }, recipient: { name: 'Sam', email: 's@t.co', phone: '5' }, updatedAt: 10 }));
    t.db.put('emails', 'e2', REC({ id: 'e2', createdAt: 5, updatedAt: 10 }));
    const w1 = await windowOn(t, storeMod, dbMod), w2 = await windowOn(t, storeMod, dbMod);
    await w1.store.saveEmail({ ...w1.store.state.emails.find(e => e.id === 'e1'), note: 'window 1' });
    await w2.store.saveEmail({ ...w2.store.state.emails.find(e => e.id === 'e2'), note: 'window 2' });            // w2 is stale about e1 only
    const snap = Object.fromEntries(t.db.snapshot().emails.map(e => [e.id, e]));
    assert.deepEqual([snap.e1.status, snap.e1.sentAt, snap.e1.futureField, snap.e1.recipient.phone, snap.e1.note, snap.e2.note], ['scheduled', 4, { x: 1 }, '5', 'window 1', 'window 2']);
    assert.ok(snap.e1.updatedAt > 10, 'the server stamps a newer version');
  } finally { await t.close(); }
});

test('SQLite: a stale save merges different fields, refuses the same field, and a refusal leaves the stored record untouched', async () => {
  const dbMod = await load('src/services/sqliteDb.js'), storeMod = await load('src/state/store.js'), { applyStatus } = await load('src/domain/outreach.js');
  const t = await boot();
  try {
    t.db.put('emails', 'e1', REC({ updatedAt: 10 }));
    const w1 = await windowOn(t, storeMod, dbMod), w2 = await windowOn(t, storeMod, dbMod);
    const stale = w2.store.state.emails[0];
    await w1.store.saveEmail(applyStatus(w1.store.state.emails[0], 'sent', { now: 50 }));
    await w1.store.saveEmail(applyStatus(w1.store.state.emails[0], 'replied', { now: 60 }));
    await w2.store.saveEmail({ ...stale, note: 'stale window notes' });   // merged
    let r = t.db.snapshot().emails[0];
    assert.deepEqual([r.status, r.sentAt, r.repliedAt, r.sentCopy.at, r.note], ['replied', 50, 60, 50, 'stale window notes']);
    assert.equal(w2.store.state.emails[0].status, 'replied', 'the stale window now shows the merged record');
    // the same field changed in both
    const w1b = await windowOn(t, storeMod, dbMod), w3 = await windowOn(t, storeMod, dbMod);
    await w1b.store.saveEmail({ ...w1b.store.state.emails[0], note: 'window 1 again' });
    const before = JSON.stringify(t.db.snapshot().emails);
    await assert.rejects(w3.store.saveEmail({ ...w3.store.state.emails[0], note: 'window 3' }), e => e.code === 'conflict' && e.mine.note === 'window 3' && e.current.note === 'window 1 again' && e.conflicts[0] === 'note');
    assert.equal(JSON.stringify(t.db.snapshot().emails), before, 'nothing was written');
    assert.equal(w3.store.state.emails[0].note, 'window 1 again');
    // a stale status transition
    const w4 = await windowOn(t, storeMod, dbMod);
    await w1b.store.saveEmail({ ...w1b.store.state.emails[0], status: 'draft' });
    await assert.rejects(w4.store.saveEmail({ ...w4.store.state.emails[0], status: 'sent' }), e => e.code === 'conflict' && e.conflicts.includes('status'));
    assert.equal(t.db.snapshot().emails[0].status, 'draft');
  } finally { await t.close(); }
});

test('SQLite: the server itself refuses a write based on an old version (409 with the stored record) and a delete of a newer record', async () => {
  const t = await boot();
  try {
    t.db.put('emails', 'e1', REC({ updatedAt: 10 }));
    const v1 = t.db.put('emails', 'e1', REC({ note: 'newer', status: 'replied', repliedAt: 9 }), { base: 10 }).updatedAt;
    assert.ok(v1 > 10);
    const put = (q, body) => t.raw(`api/data/emails/e1${q}`, { method: 'PUT', body: JSON.stringify(body) }, true);
    let r = await put('?base=10', REC({ note: 'stale', status: 'draft' }));
    const body = await r.json();
    assert.deepEqual([r.status, body.error.code, body.current.status, body.current.note], [409, 'conflict', 'replied', 'newer']);
    assert.deepEqual([t.db.snapshot().emails[0].status, t.db.snapshot().emails[0].note], ['replied', 'newer']);
    r = await put('?base=new', REC()); assert.equal(r.status, 409);                                                 // "I think this is new" but it exists
    r = await put('?base=abc', REC()); assert.equal(r.status, 400);
    r = await t.raw('api/data/emails/e1?base=10', { method: 'DELETE' }, true); assert.equal(r.status, 409);
    assert.equal(t.db.snapshot().emails.length, 1);
    r = await put(`?base=${v1}`, REC({ note: 'based on current' })); assert.equal(r.status, 200);                   // the current version is accepted
    assert.ok((await r.json()).updatedAt > v1);
    r = await put('', REC({ note: 'older client, no version' })); assert.equal(r.status, 200);                        // unversioned writes still work (compatibility)
    r = await t.raw(`api/data/emails/e1?base=${t.db.snapshot().emails[0].updatedAt}`, { method: 'DELETE' }, true); assert.equal(r.status, 200);
    assert.equal(t.db.snapshot().emails.length, 0);
  } finally { await t.close(); }
});

// ----------------------------------------------------------------------------------------- extension / web sync (replica)
const memory = () => { let v = null; return { get: async () => v && JSON.parse(JSON.stringify(v)), set: async x => { v = JSON.parse(JSON.stringify(x)); } }; };

test('sync: unknown statuses and unfamiliar fields reach the extension and come back untouched; reading queues nothing', async () => {
  const { createReplica } = await load('src/services/replica.js'), { createStore } = await load('src/state/store.js');
  const t = await boot();
  try {
    t.db.put('emails', 'e1', REC({ status: 'scheduled', sentAt: 4, sentCopy: { subject: 's', text: 't', at: 4, sig: 'v2' }, futureField: [1, 2], recipient: { name: 'Sam', phone: '5' }, updatedAt: 10 }));
    const replica = createReplica({ storage: memory() }); await replica.load();
    const store = createStore({ storage: {} }); store.start({ db: replica });
    replica.attach(t.link); await replica.sync();
    assert.equal(replica.pending, 0);
    await store.saveEmail({ ...store.state.emails[0], note: 'from the extension' });                                // unrelated edit
    await replica.sync();
    const r = t.db.snapshot().emails[0];
    assert.deepEqual([r.status, r.sentAt, r.sentCopy, r.futureField, r.recipient.phone, r.note], ['scheduled', 4, { subject: 's', text: 't', at: 4, sig: 'v2' }, [1, 2], '5', 'from the extension']);
  } finally { await t.close(); }
});

test('sync: an offline edit in the extension merges with a different change made in the app; app changes show up in the extension', async () => {
  const { createReplica } = await load('src/services/replica.js'), { createStore } = await load('src/state/store.js'), { applyStatus } = await load('src/domain/outreach.js');
  const t = await boot();
  try {
    t.db.put('emails', 'e1', REC({ updatedAt: 10 })); t.db.put('emails', 'e2', REC({ id: 'e2', createdAt: 5, updatedAt: 10 }));
    const replica = createReplica({ storage: memory() }); await replica.load();
    const store = createStore({ storage: {} }); store.start({ db: replica });
    replica.attach(t.link); await replica.sync(); replica.attach(null);
    await store.saveEmail({ ...store.state.emails.find(e => e.id === 'e1'), note: 'offline note' });             // extension, offline
    const cur = t.db.snapshot().emails.find(e => e.id === 'e1');                                                  // meanwhile, in the app:
    t.db.put('emails', 'e1', applyStatus(applyStatus(cur, 'sent', { now: 50 }), 'replied', { now: 60 }), { base: cur.updatedAt });
    t.db.put('emails', 'e2', { ...t.db.snapshot().emails.find(e => e.id === 'e2'), note: 'app note on e2' }, { base: 10 });
    replica.attach(t.link); await replica.sync();
    const app = Object.fromEntries(t.db.snapshot().emails.map(e => [e.id, e]));
    assert.deepEqual([app.e1.note, app.e1.status, app.e1.sentAt, app.e1.repliedAt, app.e1.sentCopy.at, app.e2.note], ['offline note', 'replied', 50, 60, 50, 'app note on e2']);
    const ext = Object.fromEntries(store.state.emails.map(e => [e.id, e]));
    assert.deepEqual([ext.e1.note, ext.e1.status, ext.e2.note, replica.pending, replica.conflicts.length], ['offline note', 'replied', 'app note on e2', 0, 0]);
  } finally { await t.close(); }
});

test('sync: the same field changed offline and in the app keeps the app\'s record and sets the extension\'s edit aside, recoverably', async () => {
  const { createReplica } = await load('src/services/replica.js'), { createStore } = await load('src/state/store.js');
  const t = await boot();
  try {
    t.db.put('emails', 'e1', REC({ updatedAt: 10, status: 'replied', repliedAt: 9, sentAt: 5, sentCopy: { subject: 's', text: 't', at: 5 } }));
    const replica = createReplica({ storage: memory() }); await replica.load();
    const store = createStore({ storage: {} }); store.start({ db: replica });
    replica.attach(t.link); await replica.sync(); replica.attach(null);
    await store.saveEmail({ ...store.state.emails[0], note: 'extension note', status: 'draft', sentCopy: undefined });  // a stale-minded edit: tries to revert and drop the snapshot
    t.db.put('emails', 'e1', { ...t.db.snapshot().emails[0], note: 'app note' }, { base: 10 });
    replica.attach(t.link); await replica.sync();
    const app = t.db.snapshot().emails[0];
    assert.deepEqual([app.note, app.status, app.sentCopy.at], ['app note', 'replied', 5], 'the app\'s record is intact');
    assert.equal(store.state.emails[0].note, 'app note');
    assert.equal(replica.pending, 0);
    const [c] = replica.conflicts;
    assert.deepEqual([replica.conflicts.length, c.id, c.fields, c.mine.note, c.mine.status], [1, 'e1', ['note'], 'extension note', 'draft']);
    // restoring is a deliberate act that goes through the normal checks and then reaches the app
    await replica.resolveConflict('emails', 'e1', { restore: true }); await replica.sync();
    assert.deepEqual([replica.conflicts.length, t.db.snapshot().emails[0].note], [0, 'extension note']);
  } finally { await t.close(); }
});

test('sync: the extension never sends a stale copy over a newer app record, even if the hub moves between the read and the write', async () => {
  const { createReplica } = await load('src/services/replica.js'), { createStore } = await load('src/state/store.js'), { applyStatus } = await load('src/domain/outreach.js');
  const t = await boot();
  try {
    t.db.put('emails', 'e1', REC({ updatedAt: 10 }));
    const replica = createReplica({ storage: memory() }); await replica.load();
    const store = createStore({ storage: {} }); store.start({ db: replica });
    replica.attach(t.link); await replica.sync(); replica.attach(null);
    await store.saveEmail({ ...store.state.emails[0], note: 'offline' });
    // the app replies to the record in the middle of the sync: after the extension read the hub, before it writes
    let raced = false;
    replica.attach({ get: p => t.link.get(p), del: p => t.link.del(p), put: (p, b) => { if (!raced) { raced = true; const c = t.db.snapshot().emails[0]; t.db.put('emails', 'e1', applyStatus(c, 'replied', { now: 99 }), { base: c.updatedAt }); } return t.link.put(p, b); } });
    await replica.sync();
    const r = t.db.snapshot().emails[0];
    assert.deepEqual([r.status, r.repliedAt, r.note, replica.conflicts.length], ['replied', 99, 'offline', 0]);       // the refused write was merged and retried
    // a second extension copy that only has the old draft cannot push it back
    const old = createReplica({ storage: memory() }); await old.load();
    await old.doc('emails/e1').set(REC({ note: 'ancient', updatedAt: 10 }));
    old.attach(t.link); await old.sync();
    assert.equal(t.db.snapshot().emails[0].status, 'replied');
  } finally { await t.close(); }
});

test('sync: a delete made offline does not remove a record the app changed since; conflicts survive a restart', async () => {
  const { createReplica } = await load('src/services/replica.js');
  const t = await boot();
  try {
    t.db.put('emails', 'e1', REC({ updatedAt: 10 }));
    const storage = memory();
    const replica = createReplica({ storage }); await replica.load();
    replica.attach(t.link); await replica.sync(); replica.attach(null);
    await replica.doc('emails/e1').delete();
    t.db.put('emails', 'e1', REC({ note: 'app kept working on it' }), { base: 10 });
    replica.attach(t.link); await replica.sync();
    assert.equal(t.db.snapshot().emails.length, 1);
    assert.equal(replica.conflicts.length, 1);
    const again = createReplica({ storage }); await again.load();
    assert.equal(again.conflicts.length, 1, 'the set-aside edit is stored with the rest of the replica');
    again.attach(null);
  } finally { await t.close(); }
});

test('sync (web adapter): conflicts and unreadable entries are kept in the same localStorage keys', async () => {
  const { localReplicaStorage } = await load('src/services/replicaStorage.js'), { createReplica } = await load('src/services/replica.js');
  const ls = memStorage(); const junk = { nope: 1 };
  ls.d['cold.emails'] = JSON.stringify([REC({ status: 'archived', futureField: 1 }), junk]);
  const replica = createReplica({ storage: localReplicaStorage(ls) }); await replica.load();
  await replica.doc('emails/e1').set({ ...REC({ status: 'archived', futureField: 1 }), note: 'n' }, { expected: 0 });
  const out = saved(ls);
  assert.deepEqual([out[0].status, out[0].futureField, out[0].note, out[1]], ['archived', 1, 'n', junk]);
});
