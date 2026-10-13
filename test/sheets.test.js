const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startSheetsMock } = require('./helpers/sheets-mock');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

async function setup(opts = {}) {
  const mock = await startSheetsMock();
  const { createSheetsApi } = await load('src/services/sheetsApi.js'), { createSheetsDb } = await load('src/services/sheetsDb.js'), M = await load('src/domain/sheetsMap.js');
  const api = createSheetsApi({ token: async () => 'good-token', base: mock.url, sleep: async () => {} });
  const made = await api.create('Cold', [{ title: M.TABS.leads, headers: M.headersFor('leads') }, { title: M.TABS.emails, headers: M.headersFor('emails') }]);
  const db = createSheetsDb({ api, spreadsheetId: made.spreadsheetId, poll: false, ...opts });
  await db.load();
  const book = () => mock.books.get(made.spreadsheetId);
  const tab = n => book().sheets.find(s => s.title === n).rows;
  const docs = n => { let out = []; db.collection(n).onSnapshot(s => { out = s.docs.map(d => ({ id: d.id, ...d.data() })); })(); return out; };
  return { mock, api, db, made, tab, docs, M, close: () => mock.close() };
}
const lead = (id, o = {}) => ({ id, name: `Lead ${id}`, company: 'Acme', email: `${id}@acme.io`, list: 'Q4', createdAt: 1700000000000, ...o });

test('sheet rows <-> leads: columns are read by heading in any order, unknown columns are extra fields, plain text is never a formula', async () => {
  const M = await load('src/domain/sheetsMap.js');
  const header = ['Company', 'id', 'Name', 'Favourite colour', 'profile url', 'Email'];
  const l = M.rowToLead(['Acme', 'l_1', 'Ana', 'green', 'linkedin.com/in/ana', 'ana@acme.io'], header);
  assert.deepEqual([l.id, l.name, l.company, l.email, l.custom], ['l_1', 'Ana', 'Acme', 'ana@acme.io', { 'Favourite colour': 'green' }]);
  assert.equal(M.rowToLead(['', '', 'Bo', '', '', ''], header).id.startsWith('l_'), true, 'a row typed in the sheet gets an id');
  const back = M.leadToRow({ id: 'l_2', name: '=1+1', company: 'X', custom: { 'Favourite colour': 'red' }, createdAt: 1700000000000 }, header);
  assert.deepEqual(back, ['X', 'l_2', '=1+1', 'red', '', '']);
  assert.deepEqual(M.missingExtras(header, { custom: { 'Favourite colour': 'x', Region: 'y' } }), ['Region']);
});

test('sheet rows <-> outreach: the saved record round-trips, and a change made in the sheet wins over the saved copy', async () => {
  const M = await load('src/domain/sheetsMap.js');
  const rec = { id: 'e1', createdAt: 1700000000000, status: 'draft', mode: 'email', goal: 'advice', productName: 'Acme', recipient: { name: 'Ada', company: 'PipeCo', email: 'ada@p.io', role: 'COO' }, subject: 'Hi', what: 'We do X.', why: 'You Y.', ask: 'Z?', note: 'n', followUp: { due: 1800000000000, count: 0, auto: true }, claims: [{ text: 'c' }], updatedAt: 5 };
  const header = M.headersFor('emails'), row = M.emailToRow(rec, header);
  assert.deepEqual(M.rowToEmail(row, header), rec, 'nothing is lost through the sheet');
  const edited = row.slice(); edited[header.indexOf('status')] = 'sent'; edited[header.indexOf('notes')] = 'called them'; edited[header.indexOf('follow_up')] = '2030-01-02T09:00:00.000Z'; edited[header.indexOf('email')] = 'new@p.io';
  const r = M.rowToEmail(edited, header);
  assert.deepEqual([r.status, r.note, r.followUp.due, r.followUp.auto, r.recipient.email, r.subject], ['sent', 'called them', Date.parse('2030-01-02T09:00:00.000Z'), false, 'new@p.io', 'Hi']);
  const typed = M.rowToEmail(['', '', 'replied', 'Bo', 'BoCo', 'bo@b.io', '', 'Hello', 'Short note', 'customer', '', '', '', '', '', ''], header);
  assert.deepEqual([typed.status, typed.recipient.name, typed.subject, typed.goal, typed.id.startsWith('e_')], ['replied', 'Bo', 'Hello', 'customer', true]);
  const huge = M.dataCell({ id: 'x', claims: 'c'.repeat(46000), subject: 's' });
  assert.ok(huge.length <= M.CELL_MAX, 'an oversized record drops its derived parts rather than failing');
});

test('Sheets db: save, edit, delete and import leads; they are real rows in the Leads tab', async () => {
  const t = await setup();
  await t.db.doc('leads/l1').set(lead('l1'));
  assert.deepEqual(t.tab('Leads')[1].slice(0, 5), ['l1', 'Lead l1', 'Acme', '', 'l1@acme.io'].slice(0, 1).concat(['Lead l1', 'Acme', '', 'l1@acme.io']));
  await t.db.doc('leads/l1').set({ ...lead('l1'), company: 'Beta' });
  assert.equal(t.tab('Leads').length, 2, 'an edit rewrites the row, it does not add one'); assert.equal(t.tab('Leads')[1][2], 'Beta');
  await t.db.setMany('leads', [lead('l2'), lead('l3', { custom: { Region: 'EMEA' } })]);
  assert.equal(t.tab('Leads').length, 4); assert.ok(t.tab('Leads')[0].includes('Region'), 'an extra field becomes a column');
  assert.equal(t.tab('Leads')[3][t.tab('Leads')[0].indexOf('Region')], 'EMEA');
  assert.deepEqual(t.docs('leads').map(l => l.id).sort(), ['l1', 'l2', 'l3']);
  await t.db.deleteMany('leads', ['l2']);
  assert.deepEqual(t.tab('Leads').slice(1).map(r => r[0]), ['l1', 'l3']); assert.deepEqual(t.docs('leads').map(l => l.id).sort(), ['l1', 'l3']);
  await t.db.doc('leads/l1').delete(); assert.deepEqual(t.tab('Leads').slice(1).map(r => r[0]), ['l3']);
  assert.ok(t.mock.calls.every(c => !/\bvalueInputOption=USER/.test(c)), 'writes are plain text');
  await t.close();
});

test('Sheets db: changes made in Google Sheets show up; rows typed there get ids; a row someone inserted is not overwritten by a save', async () => {
  const t = await setup();
  await t.db.setMany('leads', [lead('l1'), lead('l2')]);
  // someone adds a row at the top of the data, shifting everything down, and types a new lead at the bottom
  const rows = t.tab('Leads'); rows.splice(1, 0, ['l_other', 'Inserted', 'Zed', '', '', '', '', '', '', '', '', '']); rows.push(['', 'Typed Person', 'TypedCo']);
  await t.db.refresh();
  const names = t.docs('leads').map(l => l.name).sort();
  assert.deepEqual(names, ['Inserted', 'Lead l1', 'Lead l2', 'Typed Person']);
  assert.ok(t.tab('Leads')[t.tab('Leads').length - 1][0].startsWith('l_'), 'the typed row was given an id in the sheet');
  await t.db.doc('leads/l2').set({ ...lead('l2'), notes: 'saved after the shift' });
  const byId = Object.fromEntries(t.tab('Leads').slice(1).map(r => [r[0], r]));
  assert.equal(byId.l2[10], 'saved after the shift'); assert.equal(byId.l_other[1], 'Inserted', 'the inserted row is untouched'); assert.equal(byId.l1[1], 'Lead l1');
  await t.close();
});

test('Sheets db: outreach keeps the full record, edits in the sheet win, and a stale save is merged or refused', async () => {
  const t = await setup();
  const rec = { createdAt: 1700000000000, status: 'draft', mode: 'email', goal: 'advice', recipient: { name: 'Ada', company: 'PipeCo' }, subject: 'Hi', what: 'W.', why: 'Y.', ask: 'A?', note: '' };
  const r1 = await t.db.doc('emails/e1').set(rec, { expected: null, base: null });
  assert.ok(r1.updatedAt > 0);
  const stored = () => t.docs('emails').find(e => e.id === 'e1');
  assert.equal(stored().updatedAt, r1.updatedAt);
  // two edits from the same base: different fields merge, the same field is a conflict
  const r2 = await t.db.doc('emails/e1').set({ ...stored(), note: 'mine' }, { expected: r1.updatedAt, base: stored() });
  await t.db.doc('emails/e1').set({ ...stored(), subject: 'Hello' }, { expected: r1.updatedAt, base: { ...rec, id: 'e1', updatedAt: r1.updatedAt } });
  assert.deepEqual([stored().note, stored().subject], ['mine', 'Hello'], 'edits to different fields from an old version are merged');
  await assert.rejects(t.db.doc('emails/e1').set({ ...stored(), note: 'theirs' }, { expected: r1.updatedAt, base: { ...rec, id: 'e1', updatedAt: r1.updatedAt } }), e => e.code === 'conflict' && e.conflicts.includes('note'));
  // the sheet is edited by hand: the status column
  const row = t.tab('Outreach')[1], h = t.tab('Outreach')[0]; row[h.indexOf('status')] = 'replied'; row[h.indexOf('notes')] = 'typed in the sheet';
  await t.db.refresh();
  assert.deepEqual([stored().status, stored().note, stored().what], ['replied', 'typed in the sheet', 'W.']);
  await t.close();
});

test('Sheets db: errors are named, the tab is rebuilt if it was deleted, and the status says what is wrong', async () => {
  const t = await setup();
  t.mock.token = 'expired';
  await assert.rejects(t.db.doc('leads/l1').set(lead('l1')), e => e.code === 'google_auth');
  assert.equal(t.db.status.state, 'error'); assert.equal(t.db.status.code, 'google_auth');
  t.mock.token = 'good-token';
  await t.db.doc('leads/l1').set(lead('l1')); assert.equal(t.db.status.state, 'ok');
  t.mock.failNext = 1; t.mock.status = 429;
  await t.db.doc('leads/l2').set(lead('l2')); assert.equal(t.tab('Leads').length, 3, 'a busy Google is retried');
  // the Outreach tab is deleted in Sheets: loading adds it back
  const book = t.mock.books.get(t.made.spreadsheetId); book.sheets = book.sheets.filter(s => s.title !== 'Outreach');
  const { createSheetsDb } = await load('src/services/sheetsDb.js');
  const again = createSheetsDb({ api: t.api, spreadsheetId: t.made.spreadsheetId, poll: false }); await again.load();
  assert.ok(book.sheets.some(s => s.title === 'Outreach'));
  const { createSheetsApi } = await load('src/services/sheetsApi.js');
  const gone = createSheetsDb({ api: createSheetsApi({ token: async () => 'good-token', base: t.mock.url, sleep: async () => {} }), spreadsheetId: 'nope', poll: false });
  await assert.rejects(gone.load(), e => e.code === 'google_missing');
  await t.close();
});

test('split database: leads and outreach go to the sheet, everything else stays where it was', async () => {
  const t = await setup(); const { splitDb } = await load('src/services/sheetsDb.js');
  const calls = []; const primary = { kind: 'sqlite', collection: n => { calls.push(['collection', n]); return { onSnapshot() {} }; }, doc: p => ({ set: async d => { calls.push(['set', p]); } }), initialCompose: { a: 1 } };
  const db = splitDb(primary, t.db);
  assert.equal(db.kind, 'sqlite'); assert.deepEqual(db.initialCompose, { a: 1 });
  await db.doc('products/p1').set({ name: 'P' }); await db.doc('leads/l1').set(lead('l1')); db.collection('products');
  assert.deepEqual(calls, [['set', 'products/p1'], ['collection', 'products']]); assert.equal(t.tab('Leads').length, 2);
  await t.close();
});
