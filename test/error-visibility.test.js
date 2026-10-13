// Failures must stay observable (QUALITY-005). A blanket layer once replaced store.set with a version that swallowed exceptions and returned null, and
// showed a false "System error" when an error was merely CLEARED (QUALITY-001). These tests pin the opposite: failed state updates and rejected
// persistence surface to their callers, clearing an error is not a failure, and the global handler only logs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);
const mem = (over = {}) => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), ...over }; };

test('a failed state update is observable: a throwing subscriber makes store.set throw (nothing swallows it or returns null)', async () => {
  const { createStore } = await load('src/state/store.js');
  const store = createStore({ storage: mem() });
  const boom = new Error('subscriber failed');
  const unsub = store.subscribe(topic => { if (topic === 'busy') throw boom; });
  assert.throws(() => store.set({ busy: true }, 'busy'), e => e === boom, 'the exception reaches the caller');
  unsub();
  assert.equal(store.set({ busy: false }, 'busy'), undefined, 'set returns nothing on success; it never reports success by returning a value on failure');
});

test('nothing in src replaces or wraps store.set', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const offenders = walk(path.join(__dirname, '../src')).filter(f => f.endsWith('.js')).filter(f => /\bstore\.set\s*=[^=]|originalSet/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'a store.set monkey-patch hides failures from the code that should report them');
});

test('a rejected persistence operation stays observable with a usable reason (storage full, storage unavailable, database failure)', async () => {
  const { createStore } = await load('src/state/store.js');
  const rec = { id: 'e1', createdAt: 1, status: 'draft', recipient: { name: 'A' }, subject: 's', what: 'w', why: 'y', ask: 'a' };
  const full = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
  // local storage: a full browser rejects the save, and the draft is NOT reported as saved
  const s1 = createStore({ storage: mem({ setItem: () => { throw full; } }) });
  await assert.rejects(s1.saveEmail(rec), e => e.code === 'quota_exceeded');
  assert.equal(s1.state.emails.length, 0, 'a failed save leaves nothing behind as if saved');
  const s2 = createStore({ storage: mem({ setItem: () => { throw new Error('denied'); } }) });
  await assert.rejects(s2.saveEmail(rec), e => e.code === 'storage_unavailable');
  await assert.rejects(s2.saveLead({ id: 'l1', name: 'A' }), e => e.code === 'storage_unavailable');
  await assert.rejects(s2.saveProduct({ id: 'p1', name: 'P' }), e => e.code === 'storage_unavailable');
  // a database (desktop / paired): its rejection reaches the caller
  const dbDown = { kind: 'sqlite', collection: () => ({ orderBy() { return this; }, limit() { return this; }, onSnapshot() { return () => {}; } }), doc: () => ({ onSnapshot() { return () => {}; }, set: () => Promise.reject({ code: 'storage_unavailable', message: 'Couldn\'t save.' }) }) };
  const s3 = createStore({ storage: mem() }); s3.start({ db: dbDown });
  await assert.rejects(s3.saveEmail(rec), e => e.code === 'storage_unavailable');
  await assert.rejects(s3.saveLead({ id: 'l1', name: 'A' }), e => e.code === 'storage_unavailable');
  // and a failed save does not wedge the queue: the next save is still attempted
  let calls = 0; const flaky = { ...dbDown, doc: () => ({ onSnapshot() { return () => {}; }, set: () => (++calls === 1 ? Promise.reject({ code: 'storage_unavailable' }) : Promise.resolve({ updatedAt: 5 })) }) };
  const s4 = createStore({ storage: mem() }); s4.start({ db: flaky });
  await assert.rejects(s4.saveEmail(rec)); await s4.saveEmail(rec); assert.equal(calls, 2);
});

test('clearing an error is not a failure: the store reports "error" with null and no failure is recorded', async () => {
  const { createStore } = await load('src/state/store.js');
  const store = createStore({ storage: mem() });
  const seen = [];
  store.subscribe((topic, state) => { if (topic === 'error') seen.push(state.error); });
  store.set({ error: { message: 'Provider unavailable', retryable: true } }, 'error');
  store.set({ error: null }, 'error');            // what every Generate does first
  assert.deepEqual(seen.map(e => (e ? e.message : null)), ['Provider unavailable', null]);
  assert.equal(store.state.error, null);
});

test('global error logging only logs: benign browser notices are ignored, real faults and rejections are logged with their cause, nothing is suppressed', async () => {
  const { installGlobalErrorLogging, isBenignBrowserNotice } = await load('src/components/global-errors.js');
  assert.equal(isBenignBrowserNotice('ResizeObserver loop completed with undelivered notifications.'), true);
  assert.equal(isBenignBrowserNotice('ResizeObserver loop limit exceeded'), true);
  assert.equal(isBenignBrowserNotice('ResizeObserver is not defined'), false, 'a real ResizeObserver fault is not hidden');
  assert.equal(isBenignBrowserNotice('TypeError: x is undefined'), false);
  const handlers = {}, logged = [], target = { addEventListener: (n, fn) => { handlers[n] = fn; } };
  installGlobalErrorLogging(target, { error: (...a) => logged.push(a) });
  handlers.error({ message: 'ResizeObserver loop completed with undelivered notifications.' });
  assert.deepEqual(logged, [], 'the benign notice is not logged as a failure');
  const fault = new TypeError('real bug');
  handlers.error({ message: 'TypeError: real bug', error: fault, filename: 'app.js', lineno: 7 });
  let prevented = false; handlers.unhandledrejection({ reason: { code: 'storage_unavailable' }, preventDefault() { prevented = true; } });
  assert.equal(logged.length, 2); assert.equal(logged[0][1], fault); assert.match(logged[0][2], /app\.js:7/); assert.deepEqual(logged[1][1], { code: 'storage_unavailable' });
  assert.equal(prevented, false, 'the rejection is not suppressed');
});
