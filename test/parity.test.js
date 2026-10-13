// Parity: one founder workflow, driven through the SAME steps on every surface, with the same expectations. Differences between
// surfaces are listed explicitly (EXPECT below) so they are intentional, not accidental. The model is a MOCK (canned JSON), and
// the email-app handoff is MOCKED: this proves behaviour and plumbing, not output quality or that an email app is installed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('./helpers/env');
const { createDb } = require('../lib/db');

let pw; try { pw = require('playwright-core'); } catch { pw = null; }
const chromium = process.env.CHROMIUM || (() => { for (const b of [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright'), '/opt/pw-browsers'].filter(Boolean)) { try { for (const d of fs.readdirSync(b).filter(x => /^chromium-\d+$/.test(x))) for (const sub of ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) { const p = path.join(b, d, sub); if (fs.existsSync(p)) return p; } } catch { /* next */ } } return null; })();
const SKIP = !pw || !chromium || !fs.existsSync(path.join(__dirname, '../extension/dist/panel.js')) ? 'Chromium, playwright-core or the built extension (npm run build:extension) is not available' : false;
const F = env.FINAL;
const SUBJECT = F.subject[0].toUpperCase() + F.subject.slice(1);   // generated subjects start with a capital

/** What each surface may and may not offer. Anything not listed here must be identical everywhere. */
const EXPECT = {
  web:       { settings: ['Model', 'Cold desktop app', 'Email app', 'Email lookup', 'Email sign-off', 'Follow-ups', 'Google Sheets', 'Your data'], keyField: false, pairing: false, hubForm: true,  readPage: false, insertTweet: false },
  desktop:   { settings: ['Model', 'Browser extension & web apps', 'Email app', 'Email lookup', 'Email sign-off', 'Follow-ups', 'Google Sheets', 'Your data'], keyField: true, pairing: true, hubForm: false, readPage: false, insertTweet: false },
  extension: { settings: ['Writing', 'Opportunity discovery', 'Integrations', 'Privacy and local models', 'About and diagnostics'], keyField: true, pairing: false, hubForm: true, readPage: true, insertTweet: true },
};

/** A mock OpenAI-style model for the extension's own connection; returns the same canned email the web mock does. */
function openaiMock() {
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method !== 'POST') return res.end('{"data":[]}');
      const prompt = JSON.parse(b).messages.at(-1).content;
      if (prompt.startsWith('Write one')) { res.end(JSON.stringify({ choices: [{ message: { content: '{"text":"Short tweet."}' }, finish_reason: 'stop' }] })); return; }
      const out = prompt.includes('You are the editor') ? { draft_failures: [], final: F, checks: [], proof_id: null, claims: [], could_improve: '' }
        : { relevance: { signal: 's', rank: 1, category: 'Direct shared problem', strength: 'strong' }, retrieved: [], proof_id: null, ...F };
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }] }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, close: () => new Promise(x => server.close(x)) })));
}

const BLOCK = 'Sam Founder\nAcme Flow\nhttps://acme.dev\nX: @acmeflow';
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + fn); await new Promise(r => setTimeout(r, 120)); } };
const go = async (page, v) => { await page.click(`#nav-${v}`); await page.evaluate(() => document.querySelectorAll('details.set-group').forEach(d => { d.open = true; })); };   // the extension's Settings groups are collapsible

/** The founder's whole path. Identical on every surface; `s.read()` returns that surface's stored copy of the record. */
async function workflow(name, page, s) {
  const x = EXPECT[name];
  // same words everywhere
  assert.deepEqual(await page.$$eval('.primary-nav a', a => a.map(e => e.textContent)), ['Write', 'Knowledge', 'Leads', 'History', 'Settings'], `${name}: navigation`);
  await go(page, 'history');
  assert.deepEqual(await page.$$eval('.hfilters .btn', b => b.map(e => e.textContent.replace(/\s*\d+$/, '').trim())), ['All', 'Draft', 'Marked sent', 'Reply recorded'], `${name}: status words`);
  assert.match(await page.textContent('#view-history .lede'), /can't see your inbox/);
  await go(page, 'settings'); await page.waitForSelector('.set-section, .set-group');
  // The extension groups the same controls into collapsible sections (one compact screen); web and desktop keep their sections.
  assert.deepEqual(await page.$$eval('#view-settings .set-section h2, #view-settings .set-group > summary', h => h.map(e => e.textContent)), x.settings, `${name}: settings sections`);
  assert.equal(await page.locator('#setKey').count() > 0, x.keyField, `${name}: provider key field only where this surface stores keys`);
  assert.equal(await page.locator('#extCode').count() > 0, x.pairing, `${name}: pairing code only in the desktop app`);
  assert.equal(await page.locator('#hubConnect, #hubDisconnect').count() > 0, x.hubForm, `${name}: desktop-app connection only on web and extension`);
  assert.equal(await page.locator('#readPage').count() > 0, x.readPage, `${name}: page reading only in the extension`);

  // your sign-off name is set once, in Settings (the same screen everywhere)
  await page.fill('#signName', 'Sam Founder'); await page.click('#saveSignoff'); await page.waitForFunction(() => /Saved/.test(document.querySelector('#saveSignoff').closest('.form').innerText));
  // leads: import a small CSV through the same screen; the stored record has the same fields everywhere
  await go(page, 'leads'); await page.setInputFiles('#leadsFile', { name: 'l.csv', mimeType: 'text/csv', buffer: Buffer.from('name,company,role,email,why,goal,list\nJo Park,Acme,CTO,jo@acme.io,Wrote about trials,Advice,Q4\n') });
  await page.waitForSelector('#confirmImport'); await page.click('#confirmImport'); await page.waitForSelector('#leadsTable tbody tr');
  const lead = await until(async () => (await s.readLeads())[0]);
  assert.deepEqual([lead.name, lead.company, lead.role, lead.email, lead.why, lead.goal, lead.list, lead.source, typeof lead.id, typeof lead.createdAt, typeof lead.updatedAt], ['Jo Park', 'Acme', 'CTO', 'jo@acme.io', 'Wrote about trials', 'advice', 'Q4', 'csv', 'string', 'number', 'number'], `${name}: lead record`);
  assert.equal(await page.locator('#templateBtn, #exportBtn, #addLeadBtn, #importBtn').count(), 4, `${name}: lead tools`);
  // product, through the same Knowledge editor
  await go(page, 'knowledge'); await page.click('#emptyAdd');
  await page.fill('#kName', 'Acme Flow'); await page.fill('#kWhat', 'Acme Flow turns a signup into a first booked job for plumbers.'); await page.fill('#kWho', 'Plumbing shops'); await page.fill('#kProblem', 'Trials stall before a teammate is invited.');
  await page.click('summary:has-text("Links and social")'); await page.fill('#kWeb', 'https://acme.dev'); await page.fill('#kX', 'acmeflow'); await page.fill('#kLinks', 'LinkedIn: https://linkedin.com/company/acme');
  await page.uncheck('#signoffPick label:has-text("LinkedIn") input');                    // the product profile decides which links go in the sign-off
  await page.click('#kSave'); await page.waitForFunction(() => /Saved/.test(document.querySelector('#view-knowledge .status')?.textContent || ''));
  // compose a draft, through the same Write screen
  await go(page, 'compose'); await page.waitForFunction(() => document.querySelector('#rProduct'));
  await page.fill('#rName', 'Sam Ortiz'); await page.fill('#rCompany', 'TrialCo'); await page.fill('#rWhy', 'Wrote that most trial users stall before inviting a teammate.'); await page.fill('#rEmail', 'sam@trialco.com');
  await page.click('#genBtn'); await page.waitForSelector('#eSubject');
  assert.equal(await page.inputValue('#eSubject'), SUBJECT); assert.equal(await page.inputValue('#eWhat'), F.what);
  for (const id of ['#copyEmail', '#openEmail', '#markSent', '#eNote', '#eTo']) assert.ok(await page.isVisible(id), `${name}: draft card has ${id}`);
  // opening it in an email app (mocked) and copying never change the status
  await page.evaluate(() => { window.__mail = []; window.coldDesktop = { openMail: async u => { window.__mail.push(u); return { ok: true }; } }; });
  await page.click('#openEmail'); await page.waitForFunction(() => window.__mail.length === 1); await page.click('#copyEmail');
  assert.equal(await page.textContent('.signoff'), `Sign-off:\n${BLOCK}`, `${name}: sign-off preview`);
  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).endsWith(`\n\n${BLOCK}`), `${name}: Copy ends with the sign-off`);
  assert.ok(decodeURIComponent((await page.evaluate(() => window.__mail[0])).split('&body=')[1]).replace(/\r\n/g, '\n').endsWith(`\n\n${BLOCK}`), `${name}: Open in email ends with the sign-off`);
  assert.match(await page.evaluate(() => window.__mail[0]), /^mailto:sam@trialco\.com\?subject=Trial%20drop-off&body=/);
  let rec = await s.read(); assert.deepEqual([rec.status, rec.sentAt, rec.repliedAt, rec.sentCopy], ['draft', undefined, undefined, undefined], `${name}: new draft`);
  // the email app is chosen once, in the same Settings screen, and Open in email honours it (a Gmail compose link, not a mailto: link)
  await go(page, 'settings'); await page.selectOption('#emailApp', 'gmail'); await page.click('#saveEmailApp'); await page.waitForFunction(() => /Saved/.test(document.querySelector('#emailAppMsg').textContent));
  await go(page, 'compose'); await page.click('#openEmail'); await page.waitForFunction(() => window.__mail.length === 2);
  assert.match(await page.evaluate(() => window.__mail[1]), /^https:\/\/mail\.google\.com\/mail\/\?view=cm&fs=1&to=sam%40trialco\.com&su=Trial%20drop-off&body=/, `${name}: Gmail compose link`);
  assert.match(await page.textContent('#emailAppNote'), /Gmail/);
  await page.fill('#eNote', 'Good fit: wrote about trial stalls');
  await until(async () => (await s.read()).note === 'Good fit: wrote about trial stalls');
  // History: explicit actions only
  await go(page, 'history'); const row = page.locator('.hrow', { hasText: 'Sam Ortiz' });
  assert.match(await row.locator('.chip').textContent(), /Draft/);
  await row.locator('.hMarkSent').click(); await page.waitForFunction(() => /Marked sent/.test(document.querySelector('.hrow .chip').textContent));
  await row.locator('.hRecordReply').click(); await page.waitForFunction(() => /Reply recorded/.test(document.querySelector('.hrow .chip').textContent));
  await page.getByRole('button', { name: /^Reply recorded/ }).click(); assert.equal(await page.locator('.hrow').count(), 1);
  await page.fill('#histSearch', 'sam@trialco'); assert.equal(await page.locator('.hrow').count(), 1); await page.fill('#histSearch', '');
  rec = await until(async () => { const r = await s.read(); return r.status === 'replied' && r.sentCopy && r.note && r; });
  // a tweet: extension-only page actions exist in the extension and nowhere else
  await go(page, 'compose'); await page.check('#fmt-tweet'); await page.check('#tk-original'); await page.fill('#tweetContext', 'We shipped something');
  await page.click('#genBtn'); await page.waitForSelector('#tweetDraft');
  assert.equal(await page.locator('#insertTweet').count() > 0, x.insertTweet, `${name}: "put it in the tweet box" only in the extension`);
  assert.ok(await page.isVisible('button:has-text("Copy tweet")'), `${name}: Copy tweet`);
  return { status: rec.status, sentAt: typeof rec.sentAt, repliedAt: typeof rec.repliedAt, note: rec.note, sentCopySubject: rec.sentCopy.subject, sentCopyHasBody: rec.sentCopy.text.includes(F.what), sentCopyEndsWithSignoff: rec.sentCopy.text.endsWith(BLOCK), sentBodyHasNoSignoff: !rec.sentCopy.body.includes('acme.dev'), email: rec.recipient.email, subject: rec.subject, what: rec.what };
}

test('parity: the same workflow gives the same records, words and gates on web, desktop and the extension', { skip: SKIP, timeout: 170000 }, async () => {
  const mock = await env.startMock(), own = await openaiMock();
  const hubDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-par-'));
  const web = await env.startColdServer({ mockUrl: mock.url });                                   // a hosted-style site: no database, no key editing
  const desk = await env.startColdServer({ mockUrl: mock.url, env: { COLD_DB_FILE: path.join(hubDirPath, 'cold.db'), COLD_SETTINGS_FILE: path.join(hubDirPath, 's.json') } });   // what the desktop app serves
  const browser = await pw.chromium.launch({ executablePath: chromium });
  const results = {};
  try {
    // ---- web
    { const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }), page = await ctx.newPage();
      await page.goto(web.base + '/'); await page.waitForSelector('#genBtn', { state: 'attached' });
      results.web = await workflow('web', page, { read: async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('cold.emails') || '[]')))[0] || {}, readLeads: async () => await page.evaluate(() => JSON.parse(localStorage.getItem('cold.leads') || '[]')) });
      await ctx.close(); }
    // ---- desktop UI (the page the Electron window shows), records in SQLite
    { const db = createDb(path.join(hubDirPath, 'cold.db'));
      const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }), page = await ctx.newPage();
      await page.goto(desk.base + '/'); await page.waitForSelector('#genBtn', { state: 'attached' });
      results.desktop = await workflow('desktop', page, { read: async () => db.snapshot().emails[0] || {}, readLeads: async () => db.snapshot().leads });
      await ctx.close(); db.close(); }
    // ---- extension, on its own model, records in extension storage
    { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-par-ext-'));
      const ext = path.join(__dirname, '../extension');
      const ctx = await pw.chromium.launchPersistentContext(path.join(dir, 'p'), { executablePath: chromium, headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'], permissions: ['clipboard-read', 'clipboard-write'] });
      let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
      const page = await ctx.newPage(); await page.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`); await page.waitForSelector('#genBtn', { state: 'attached' });
      await go(page, 'settings'); await page.waitForSelector('#setProvider');
      await page.selectOption('#setProvider', 'custom'); await page.fill('#setUrl', `http://127.0.0.1:${own.port}/v1`);
      await page.selectOption('#setModel', '__other__'); await page.fill('#setModelText', 'own-model'); await page.click('button:has-text("Save and use this provider")');
      await until(() => page.evaluate(() => !!__cold.platform.backend.describe()));
      results.extension = await workflow('extension', page, { read: async () => { const d = await page.evaluate(async () => (await chrome.storage.local.get('cold.replica'))['cold.replica']); return Object.values((d && d.emails) || {})[0] || {}; }, readLeads: async () => { const d = await page.evaluate(async () => (await chrome.storage.local.get('cold.replica'))['cold.replica']); return Object.values((d && d.leads) || {}); } });
      await ctx.close(); }
    // ---- the three records are the same, field for field, wherever they were made
    assert.deepEqual(results.desktop, results.web, 'desktop record matches web record');
    assert.deepEqual(results.extension, results.web, 'extension record matches web record');
    assert.deepEqual(results.web, { status: 'replied', sentAt: 'number', repliedAt: 'number', note: 'Good fit: wrote about trial stalls', sentCopySubject: SUBJECT, sentCopyHasBody: true, sentCopyEndsWithSignoff: true, sentBodyHasNoSignoff: true, email: 'sam@trialco.com', subject: SUBJECT, what: F.what });
  } finally { await browser.close(); web.stop(); desk.stop(); await mock.server.close(); await own.close(); }
});
