// Run axe-core (WCAG 2.0/2.1 A + AA) on screens added after test/e2e.test.js's accessibility test was written (Leads mapper and extra fields, follow-up panel and settings, Google Sheets setup), light and dark. Automated checks only. Usage: node scripts/audit-axe.cjs
const fs = require('node:fs'); const env = require('../test/helpers/env'); const { startSheetsMock } = require('../test/helpers/sheets-mock');
const AXE = fs.readFileSync(require('node:path').join(__dirname, '../node_modules/axe-core/axe.min.js'), 'utf8');
const FAKE = () => { window.google = { accounts: { oauth2: { initTokenClient: c => ({ requestAccessToken: () => setTimeout(() => c.callback({ access_token: 'good-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' }), 5) }), revoke() {} } } }; };
const P1 = { id: 'p1', name: 'Acme Flow', order: 1, what: 'x', audience: 'y', problem: 'z', proofs: [], facts: [], approved: [], banned: [] };
const E1 = { id: 'e1', createdAt: Date.now() - 4e8, status: 'draft', mode: 'email', goal: 'advice', productId: 'p1', productName: 'Acme Flow', recipient: { name: 'Ana', company: 'N', email: 'a@n.io' }, subject: 's', what: 'w', why: 'y', ask: 'a?', followUp: { due: Date.now() - 1000, count: 0, auto: true } };
(async () => {
  const model = await env.startMock(), sheets = await startSheetsMock();
  const srv = await env.startColdServer({ mockUrl: model.url, env: { COLD_GOOGLE_CLIENT_ID: 'c', COLD_GOOGLE_SHEETS_BASE: sheets.url } }); const browser = await env.launch();
  const results = [];
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } }), page = await ctx.newPage();
    await page.addInitScript(FAKE); await page.addInitScript(s => { if (!sessionStorage.getItem('x')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); sessionStorage.setItem('x', '1'); } }, { 'cold.products': [P1], 'cold.emails': [E1] });
    await page.goto(srv.base + '/'); await page.waitForSelector('#genBtn', { state: 'attached' }); await page.evaluate(AXE);
    const scan = async label => { const r = await page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })); results.push([scheme + ' ' + label, r.violations.map(v => v.id + ': ' + v.nodes.slice(0, 2).map(n => n.target.join(' ')).join(' | ')), r.passes.length]); };
    await page.click('#nav-leads'); await page.waitForSelector('#importBtn');
    await page.setInputFiles('#leadsFile', { name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from('Who,Employer,Mail\r\nAna,Acme,a@a.io\r\n') }); await page.waitForSelector('#mapper'); await scan('leads: mapper with no name column');
    await page.selectOption('#mapperTable tbody tr:nth-child(1) select', 'name'); await page.waitForSelector('#importSummary'); await scan('leads: import review + mapper');
    await page.click('#cancelImport'); await page.click('#addLeadBtn'); await page.waitForSelector('#addExtra'); await page.click('#addExtra'); await scan('leads: edit lead with extra fields');
    await page.click('#nav-history'); await page.waitForSelector('.hrow'); await page.click('.hrow .hToggle'); await scan('history: due follow-up panel');
    await page.click('#nav-settings'); await page.waitForSelector('#followUpSettings'); await scan('settings: follow-up settings');
    await page.click('#sheetsStart'); await scan('settings: sheets step 0'); await page.click('#sheetsConnect'); await page.waitForSelector('#sheetsNext'); await scan('settings: sheets step 1 choose'); await page.check('input[value=existing]'); await scan('settings: sheets step 1 existing'); await ctx.close();
  }
  await browser.close(); srv.stop(); model.server.close(); await sheets.close();
  for (const [l, v, p] of results) console.log((v.length ? 'VIOLATIONS ' : 'clean      ') + l + (v.length ? '\n   ' + v.join('\n   ') : ''));
})().catch(e => { console.error(e); process.exit(1); });
