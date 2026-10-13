const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);
const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

test('web sign-in: one narrow scope, a click-driven consent, silent renewal, and no silent sign-in for someone who never connected', async () => {
  const { browserAuth, GOOGLE_SCOPE } = await load('src/services/googleAuth.js');
  const prompts = []; let n = 0, mode = 'ok';
  globalThis.google = { accounts: { oauth2: { initTokenClient: cfg => ({ requestAccessToken: o => { prompts.push(o.prompt); setTimeout(() => (mode === 'ok' ? cfg.callback({ access_token: `T${++n}`, expires_in: 3600, scope: GOOGLE_SCOPE }) : mode === 'closed' ? cfg.error_callback({}) : cfg.callback({ access_token: 'X', expires_in: 3600, scope: 'openid' })), 1); } }), revoke: () => {} } } };
  let t = 0; const a = browserAuth({ clientId: 'cid', storage: mem(), now: () => t });
  assert.equal(GOOGLE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(a.connected(), false); await assert.rejects(a.token(), e => e.code === 'google_auth'); assert.deepEqual(prompts, [], 'no sign-in window without a click');
  await a.connect(); assert.deepEqual(prompts, ['consent']); assert.equal(a.connected(), true); assert.equal(await a.token(), 'T1'); assert.equal(prompts.length, 1, 'a fresh token is reused');
  t += 3600 * 1000; assert.equal(await a.token(), 'T2'); assert.equal(prompts[1], '', 'renewal is silent');
  assert.equal(await a.token(true), 'T3', 'a refused token is replaced on request');
  mode = 'closed'; t += 3600 * 1000; await assert.rejects(a.token(), e => e.code === 'google_auth');
  mode = 'noscope'; await assert.rejects(a.connect(), e => /tick the box/.test(e.message));
  mode = 'ok'; await a.disconnect(); assert.equal(a.connected(), false); await assert.rejects(a.token(), e => e.code === 'google_auth');
  delete globalThis.google;
});

test('extension sign-in: Chrome\'s own window, interactive only when asked, and a denied or short-scope grant is an error', async () => {
  const { extensionAuth } = await load('src/services/googleAuth.js');
  const urls = []; let reply = 'https://x.chromiumapp.org/#access_token=A1&expires_in=3600&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file';
  const identity = { getRedirectURL: () => 'https://x.chromiumapp.org/', launchWebAuthFlow: ({ url, interactive }, cb) => { urls.push({ url, interactive }); cb(reply); } };
  const store = {}; const storage = { get: async k => ({ [k]: store[k] }), set: async o => Object.assign(store, o), remove: async k => { delete store[k]; } };
  let t = 0; const a = extensionAuth({ clientId: 'cid', identity, storage, now: () => t });
  assert.equal(a.configured, true); assert.equal(extensionAuth({ clientId: '', identity, storage }).configured, false);
  await a.refreshState(); assert.equal(a.connected(), false); await assert.rejects(a.token(), e => e.code === 'google_auth'); assert.equal(urls.length, 0);
  await a.connect(); const q = new URL(urls[0].url).searchParams;
  assert.deepEqual([urls[0].interactive, q.get('response_type'), q.get('scope'), q.get('client_id'), q.get('redirect_uri')], [true, 'token', 'https://www.googleapis.com/auth/drive.file', 'cid', 'https://x.chromiumapp.org/']);
  assert.equal(await a.token(), 'A1'); assert.equal(urls.length, 1);
  t += 3600 * 1000; reply = 'https://x.chromiumapp.org/#access_token=A2&expires_in=3600'; assert.equal(await a.token(), 'A2'); assert.equal(urls[1].interactive, false, 'renewal never opens a window');
  reply = undefined; t += 3600 * 1000; await assert.rejects(a.token(), e => e.code === 'google_auth');
  reply = 'https://x.chromiumapp.org/#access_token=B&scope=openid'; await assert.rejects(a.connect(), e => /tick the box/.test(e.message));
  await a.disconnect(); assert.equal(a.connected(), false);
});

test('desktop sign-in from the page: asks the local server, shows the address if no window opened, waits, and reports a failed sign-in', async () => {
  const { serverAuth } = await load('src/services/googleAuth.js');
  const calls = []; let polls = 0, connected = false, err = '';
  const call = async (p, init) => { calls.push(`${(init && init.method) || 'GET'} ${p}`); if (p === 'api/google/connect') return { url: 'https://accounts.example/auth?x=1' }; if (p === 'api/google/status') { polls++; return { connected: connected || polls >= 3, error: err }; } if (p.startsWith('api/google/token')) { if (!connected && polls < 3) throw { code: 'google_auth', message: 'no' }; return { accessToken: 'S1' }; } return { connected: false }; };
  const opened = []; const a = serverAuth({ call, sleep: async () => {}, open: u => opened.push(u) });
  assert.equal(await a.refreshState(), false);
  let shown = ''; await a.connect({ onUrl: u => { shown = u; } });
  assert.deepEqual([shown, opened], ['https://accounts.example/auth?x=1', ['https://accounts.example/auth?x=1']]); assert.equal(a.connected(), true);
  assert.equal(await a.token(), 'S1'); assert.ok(calls.includes('GET api/google/token'));
  polls = 0; err = 'You chose not to give Cold access.'; await assert.rejects(a.connect(), e => /chose not/.test(e.message));
  await a.disconnect(); assert.equal(a.connected(), false);
});

test('connector: link parsing, a remembered choice, setup, copying without overwriting, and stopping', async () => {
  const { parseSpreadsheetId, createSheetsConnector, webLinkStore } = await load('src/services/sheetsConnector.js');
  const { startSheetsMock } = require('./helpers/sheets-mock');
  assert.equal(parseSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC_dEf-GhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0'), '1AbC_dEf-GhIjKlMnOpQrStUvWxYz0123456789');
  assert.equal(parseSpreadsheetId('1AbC_dEf-GhIjKlMnOpQrStUvWxYz0123456789'), '1AbC_dEf-GhIjKlMnOpQrStUvWxYz0123456789');
  assert.deepEqual(['', 'hello', 'https://example.com/x', null].map(parseSpreadsheetId), ['', '', '', '']);
  const mock = await startSheetsMock(); const ls = mem();
  const auth = { configured: true, connected: () => true, token: async () => 'good-token', connect: async () => {}, disconnect: async () => {} };
  const c = createSheetsConnector({ auth, linkStore: webLinkStore(ls), sheetsBase: mock.url });
  try {
    assert.equal(c.available, true); assert.equal(await c.init(), null);
    await assert.rejects(c.useSheet('nonsense'), e => e.code === 'bad_link');
    const link = await c.createSheet(); assert.equal(link.title, 'Cold: leads and outreach'); assert.match(link.url, /docs\.google\.com/);
    const primary = { kind: 'sqlite', collection: () => ({ onSnapshot() {} }), doc: () => ({}) };
    const db = await c.open(primary, { strict: true, poll: false });
    const r = await c.copyInto(db.sheets, { leads: [{ id: 'l1', name: 'A' }, { id: 'l2', name: 'B' }], emails: [{ id: 'e1', createdAt: 1, status: 'draft', recipient: { name: 'X' }, subject: 's' }] });
    assert.deepEqual([r.leads, r.emails, r.skipped], [2, 1, 0]);
    const again = await c.copyInto(db.sheets, { leads: [{ id: 'l1', name: 'CHANGED' }, { id: 'l3', name: 'C' }], emails: [] });
    assert.deepEqual([again.leads, again.skipped], [1, 1], 'what is already in the sheet is left as it is');
    assert.equal(db.sheets.snapshot().leads.find(l => l.id === 'l1').name, 'A');
    await c.save(); assert.equal((await webLinkStore(ls).get()).spreadsheetId, link.spreadsheetId);
    const other = createSheetsConnector({ auth, linkStore: webLinkStore(ls), sheetsBase: mock.url }); assert.equal((await other.init()).title, 'Cold: leads and outreach');
    assert.equal((await other.useSheet(link.url)).spreadsheetId, link.spreadsheetId);
    await assert.rejects(other.useSheet('https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit'), e => e.code === 'google_missing');
    await c.unlink(); assert.equal(await webLinkStore(ls).get(), null); assert.equal(c.link, null);
    const failed = createSheetsConnector({ auth: { ...auth, token: async () => { throw { message: 'x' }; } }, linkStore: webLinkStore(mem()), sheetsBase: mock.url });
    await failed.createSheet().then(() => assert.fail('should not create'), e => assert.equal(e.code, 'google_auth'));
  } finally { await mock.close(); }
});
