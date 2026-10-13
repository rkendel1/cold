// Google Sheets as the place leads and outreach live: the whole setup flow and everyday use in a real browser, against a stand-in for
// the Sheets API. (Google's own sign-in window can't run offline, so the page's Google sign-in library is replaced by a fake that
// answers like the real one. What is verified is Cold's behaviour, not Google's.)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('./helpers/env');
const { startSheetsMock } = require('./helpers/sheets-mock');
const SKIP = !env.browserAvailable() && 'no browser';

let browser, model, sheets, srv, off;
before(async () => {
  if (SKIP) return;
  sheets = await startSheetsMock(); model = await env.startMock();
  srv = await env.startColdServer({ mockUrl: model.url, env: { COLD_GOOGLE_CLIENT_ID: 'test-client', COLD_GOOGLE_SHEETS_BASE: sheets.url } });
  off = await env.startColdServer({ mockUrl: model.url });   // a server with no Google client id
  browser = await env.launch();
});
after(async () => { if (SKIP) return; await browser.close(); srv.stop(); off.stop(); model.server.close(); await sheets.close(); });

const FAKE_GIS = () => {
  window.__gis = { requests: [] };
  window.google = { accounts: { oauth2: {
    initTokenClient: cfg => ({ requestAccessToken: o => { window.__gis.requests.push(o && o.prompt); setTimeout(() => cfg.callback({ access_token: window.__gisToken || 'good-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' }), 5); } }),
    revoke() {} } } };
};
const LEAD = (id, name) => ({ id, name, company: 'Acme', email: `${id}@acme.io`, list: 'Q4', source: 'manual', createdAt: Date.now() });
const EMAIL = { id: 'e1', createdAt: Date.now() - 1000, status: 'draft', mode: 'email', goal: 'advice', recipient: { name: 'Ada Park', company: 'PipeCo', email: 'ada@p.io' }, subject: 'onboarding', what: 'We do X.', why: 'You Y.', ask: 'Z?', productName: 'Acme' };

async function open(server, { seed } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(FAKE_GIS);
  if (seed) await page.addInitScript(s => { if (!sessionStorage.getItem('__seeded')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); sessionStorage.setItem('__seeded', '1'); } }, seed);
  await page.goto(server.base + '/'); await page.waitForSelector('#genBtn', { state: 'attached' });
  return { page, context, errors };
}
const go = async (page, v) => { await page.click(`#nav-${v}`); await page.waitForSelector(`#view-${v}`, { state: 'visible' }); };
const rowsOf = (book, tab) => book.sheets.find(s => s.title === tab).rows;

test('Google Sheets: not offered as a working option when this copy has no Google sign-in set up', { skip: SKIP }, async () => {
  const { page, context } = await open(off); await go(page, 'settings'); await page.waitForSelector('#sheetsSetup');
  assert.match(await page.textContent('#sheetsSetup'), /isn't available in this copy of Cold/); assert.equal(await page.locator('#sheetsStart').count(), 0);
  await context.close();
});

test('Google Sheets: guided setup, existing data moves in, everyday use is in the sheet, edits there show up, and leaving copies everything back', { skip: SKIP, timeout: 90000 }, async () => {
  const { page, context, errors } = await open(srv, { seed: { 'cold.leads': [LEAD('l_a', 'Ana Ruiz'), LEAD('l_b', 'Bo Lee')], 'cold.emails': [EMAIL] } });
  await go(page, 'settings'); await page.waitForSelector('#sheetsStart');
  assert.match(await page.textContent('#sheetsSetup'), /files that Cold itself creates/);
  assert.equal(await page.locator('#sheetsStart').count(), 1);
  // 1 connect (a click: Google opens its own window) -> 2 choose -> 3 move -> done
  await page.click('#sheetsStart'); await page.waitForSelector('#sheetsConnect'); await page.click('#sheetsConnect');
  await page.waitForSelector('#sheetsNext'); assert.equal(await page.evaluate(() => window.__gis.requests[0]), 'consent');
  await page.click('#sheetsNext'); await page.waitForSelector('#sheetsFinish');
  assert.match(await page.textContent('#sheetsSetup'), /Copy my 2 leads and 1 draft into the sheet/);
  await page.click('#sheetsFinish'); await page.waitForSelector('#sheetsDone');
  const book = [...sheets.books.values()].pop();
  assert.deepEqual([...rowsOf(book, 'Leads').slice(1)].map(r => r[1]).sort(), ['Ana Ruiz', 'Bo Lee']);
  assert.equal(rowsOf(book, 'Outreach')[1][3], 'Ada Park');
  assert.ok(JSON.parse(await page.evaluate(() => localStorage.getItem('cold.sheets'))).spreadsheetId);
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('cold.leads'))).map(l => l.name), ['Ana Ruiz', 'Bo Lee'], 'the copies stay here as a backup');
  // after the restart, leads come from the sheet; adding one writes a row
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#sheetsDone')]); await page.waitForSelector('#genBtn', { state: 'attached' });
  await go(page, 'leads'); await page.waitForSelector('#leadsTable');
  assert.equal(await page.locator('#leadsTable tbody tr').count(), 2);
  await page.click('#addLeadBtn'); await page.fill('#lf-name', 'Cy Dunn'); await page.fill('#lf-email', 'cy@dunn.io'); await page.click('#saveLead');
  await page.waitForFunction(() => document.querySelectorAll('#leadsTable tbody tr').length === 3);
  assert.deepEqual(rowsOf(book, 'Leads').slice(1).map(r => r[1]).sort(), ['Ana Ruiz', 'Bo Lee', 'Cy Dunn']);
  // someone edits the sheet; "Refresh from the sheet" brings it in
  const hdr = rowsOf(book, 'Leads')[0]; rowsOf(book, 'Leads').push(['', 'Typed In Sheets', 'SheetCo'].concat(Array(hdr.length).fill('')).slice(0, hdr.length));
  await go(page, 'settings'); await page.waitForSelector('#sheetsRefresh'); assert.match(await page.textContent('#sheetsLine'), /Cold: leads and outreach/);
  await page.click('#sheetsRefresh'); await go(page, 'leads');
  await page.waitForFunction(() => /Typed In Sheets/.test(document.getElementById('leadsTable').textContent));
  assert.ok(rowsOf(book, 'Leads').slice(1).every(r => r[0]), 'every row has an id now');
  // history comes from the Outreach tab, and a status typed in the sheet shows up
  await go(page, 'history'); assert.match(await page.textContent('#view-history'), /Ada Park/);
  rowsOf(book, 'Outreach')[1][rowsOf(book, 'Outreach')[0].indexOf('status')] = 'replied';
  await go(page, 'settings'); await page.click('#sheetsRefresh'); await go(page, 'history');
  await page.waitForFunction(() => /Reply recorded/.test(document.getElementById('view-history').textContent));
  // the sign-in expires: a clear problem and a way back, and nothing is lost
  sheets.token = 'rotated'; await page.evaluate(() => { window.__gisToken = 'good-token'; });
  await go(page, 'settings'); await page.click('#sheetsRefresh');
  await page.waitForSelector('#sheetsProblem'); assert.match(await page.textContent('#sheetsProblem'), /sign in again/); assert.equal(await page.locator('#sheetsReconnect').count(), 1);
  sheets.token = 'good-token'; await page.click('#sheetsReconnect'); await page.waitForSelector('#sheetsOk');
  // leaving: everything in the sheet is copied back, the spreadsheet is untouched
  const before = rowsOf(book, 'Leads').length;
  await page.click('#sheetsStop'); await page.waitForSelector('dialog[open]');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('dialog button[value="ok"]')]);
  await page.waitForSelector('#genBtn', { state: 'attached' });
  assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('cold.leads')).map(l => l.name))).sort(), ['Ana Ruiz', 'Bo Lee', 'Cy Dunn', 'Typed In Sheets']);
  assert.equal(await page.evaluate(() => localStorage.getItem('cold.sheets')), null); assert.equal(rowsOf(book, 'Leads').length, before);
  await go(page, 'leads'); assert.equal(await page.locator('#leadsTable tbody tr').count(), 4);
  assert.deepEqual(errors.filter(e => !/Failed to load resource/.test(e)), []);
  await context.close();
});
