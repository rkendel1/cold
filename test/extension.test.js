// End to end: the real extension in Chromium, the real Cold server + SQLite file, a MOCK model (canned JSON, so this proves
// plumbing, auth, offline behaviour and data flow, not output quality), and fixture pages standing in for x.com and linkedin.com.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function chromiumPath() {
  const bases = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright'), '/opt/pw-browsers'].filter(Boolean);
  for (const base of bases) {
    try {
      for (const d of fs.readdirSync(base).filter(x => /^chromium-\d+$/.test(x))) {
        for (const sub of ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) { const p = path.join(base, d, sub); if (fs.existsSync(p)) return p; }
      }
    } catch { /* try next */ }
  }
  return null;
}
let pw; try { pw = require('playwright-core'); } catch { pw = null; }
const CHROMIUM = process.env.CHROMIUM || chromiumPath();
const SKIP = !pw || !CHROMIUM || !fs.existsSync(path.join(__dirname, '../extension/dist/panel.js')) ? 'Chromium, playwright-core or the built extension (npm run build:extension) is not available' : false;

const TWEET_PAGE = `<html><body><article data-testid="tweet"><div data-testid="User-Name">Jack Tester\n@jacktest</div><div data-testid="tweetText">Moving batch workloads between cloud and edge is still way harder than it should be.</div></article>
<div data-testid="tweetTextarea_0"><div contenteditable="true" id="box"></div></div></body></html>`;
const PROFILE_PAGE = `<html><head><title>Priya Nair | LinkedIn</title></head><body><main><h1>Priya Nair</h1><p>Head of Platform at Northwind Logistics</p><p>I write about moving batch workloads to the edge.</p></main></body></html>`;

/** A fake OpenAI-compatible model that answers by recognising which Cold prompt it was sent. */
function mockModel() {
  const prompts = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[],"models":[]}'); }   // model-list requests from Settings
      const prompt = JSON.parse(b).messages.at(-1).content; prompts.push(prompt);
      const answer = /Extract facts about one person/.test(prompt) ? { name: 'Priya Nair', role: 'Head of Platform', company: 'Northwind Logistics', notes: 'Writes about moving batch workloads to the edge.' }
        : /You help a sender decide why/.test(prompt) ? { who: 'Platform lead at Northwind.', suggestions: [{ why: 'They write about moving batch workloads to the edge.', basis: 'moving batch workloads to the edge', signal: 'shared technical domain' }] }
        : /You are the editor/.test(prompt) ? { final: { subject: 'edge jobs', what: 'Acme Edge runs batch jobs on edge servers.', why: 'You write about moving batch workloads to the edge.', ask: 'Could I get your take on scheduling?' }, checks: [], claims: [] }
        : /You write cold emails/.test(prompt) ? { relevance: { signal: 'shared domain', rank: 3, category: 'Shared technical domain', strength: 'strong' }, subject: 'edge jobs', what: 'Acme Edge runs batch jobs on edge servers.', why: 'You write about moving batch workloads to the edge.', ask: 'Could I get your take on scheduling?' }
        : { text: /reply to the supplied tweet/.test(prompt) ? 'Scheduling is the hard part, not moving the data.' : 'We just shipped scheduled jobs on edge servers.' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ prompts, port: server.address().port, close: () => new Promise(x => server.close(x)) })));
}

/** The Cold app: a real server + SQLite file that can be stopped and started again on the same port. */
async function coldApp(model, dir) {
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN']) process.env[k] = '';
  Object.assign(process.env, { LLM_PROVIDER: 'ollama', OLLAMA_MODEL: 'app-model', OLLAMA_BASE_URL: `http://127.0.0.1:${model.port}`, COLD_DB_FILE: path.join(dir, 'cold.db'), COLD_SETTINGS_FILE: path.join(dir, 's.json') });
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    server, port, db: server.db, token: server.db.extensionToken(),
    stop: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
    start: () => new Promise(r => server.listen(port, '127.0.0.1', r)),
  };
}
async function launch(dir) {
  const ext = path.join(__dirname, '../extension');
  const ctx = await pw.chromium.launchPersistentContext(path.join(dir, 'profile'), { executablePath: CHROMIUM, headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'] });
  await ctx.route('https://x.com/**', r => r.fulfill({ contentType: 'text/html', body: TWEET_PAGE }));
  await ctx.route('https://www.linkedin.com/**', r => r.fulfill({ contentType: 'text/html', body: PROFILE_PAGE }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const panel = await ctx.newPage();
  const errors = []; panel.on('pageerror', e => errors.push(String(e)));
  await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);
  await panel.waitForSelector('#genBtn', { state: 'attached' });
  return { ctx, panel, errors };
}
const nav = (panel, v) => panel.click(`#nav-${v === 'write' ? 'compose' : v}`);
const until = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for condition: ' + fn); await new Promise(r => setTimeout(r, 150)); } };
const hubOnline = panel => panel.evaluate(() => __cold.platform.hub.link.state.online);
const model = panel => panel.evaluate(() => (__cold.platform.backend.describe() || {}).label || null);
const saveCustomModel = async (panel, port, name) => {
  await nav(panel, 'settings'); await panel.waitForSelector('#setProvider');
  await panel.selectOption('#setProvider', 'custom'); await panel.fill('#setUrl', `http://127.0.0.1:${port}/v1`);
  await panel.selectOption('#setModel', '__other__'); await panel.fill('#setModelText', name);
  await panel.click('button:has-text("Save and use this provider")');
  await until(async () => (await model(panel)) === `Custom (OpenAI-compatible) · ${name}`);
};

test('extension works with the app closed, then syncs with it when it starts, survives it stopping, and syncs again', { skip: SKIP, timeout: 180000 }, async () => {
  const model1 = await mockModel(), ownModel = await mockModel();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-off-'));
  const app = await coldApp(model1, dir);
  await app.stop();                                                // the app is NOT running at the start
  const { ctx, panel, errors } = await launch(dir);
  try {
    assert.match(await panel.textContent('#genHint'), /No provider is set up yet/);
    // ---- the extension's own model, set up in the SAME Settings screen the web and desktop apps have
    assert.deepEqual(await panel.$$eval('.primary-nav a', a => a.map(x => x.textContent)), ['Write', 'Knowledge', 'History', 'Settings']);
    await saveCustomModel(panel, ownModel.port, 'own-model');
    await nav(panel, 'write'); await until(async () => !/No provider is set up yet/.test(await panel.textContent('#genHint')));
    // ---- a product, through the SAME Knowledge editor
    await nav(panel, 'knowledge'); await panel.click('#emptyAdd');
    await panel.fill('#kName', 'Offline Co'); await panel.fill('#kWhat', 'Offline Co writes software that works without a server.');
    await panel.click('summary:has-text("Links and social")'); await panel.fill('#kX', 'offlineco');
    await panel.click('#kSave'); await panel.waitForFunction(() => /Saved/.test(document.querySelector('#kSave ~ .status, .status')?.textContent || ''));
    // ---- an original tweet with the app closed, through the SAME Write screen
    await nav(panel, 'write'); await panel.check('#fmt-tweet'); await panel.check('#tk-original');
    await panel.fill('#tweetContext', 'We just shipped offline mode'); await panel.click('#genBtn'); await panel.waitForSelector('#tweetDraft');
    assert.equal(await panel.inputValue('#tweetDraft'), 'We just shipped scheduled jobs on edge servers.');
    assert.ok(ownModel.prompts.some(p => /Offline Co/.test(p) && /@offlineco/.test(p)), 'the tweet used the product and its handle');
    assert.equal(model1.prompts.length, 0, "the (closed) app's model was never involved");
    assert.equal(app.db.snapshot().emails.length, 0);
    // ---- History and its status buttons work offline too
    await nav(panel, 'history'); await panel.waitForSelector('.hrow'); await panel.click('.hrow .hMarkSent');
    await panel.waitForFunction(() => /Marked sent/.test(document.querySelector('.hrow .chip').textContent));

    // ---- the app starts and is paired from the shared Settings screen: everything made offline reaches it
    await app.start();
    await nav(panel, 'settings');
    await panel.fill('#hubAddress', `127.0.0.1:${app.port}`); await panel.fill('#hubCode', 'wrong-code'); await panel.click('#hubConnect');
    await panel.waitForSelector('#hubMsg :text("rejected that pairing code")');
    await panel.fill('#hubCode', app.token); await panel.click('#hubConnect');
    await until(() => hubOnline(panel));
    // connecting alone sends nothing: the extension's own library (made while the app was closed) stays separate until the user copies it
    await new Promise(r => setTimeout(r, 1500));
    assert.deepEqual([app.db.snapshot().emails.length, app.db.snapshot().products.length], [0, 0]);
    await nav(panel, 'settings'); assert.match(await panel.textContent('#libraryLine'), /The Cold Desktop library/);
    await panel.click('#importStandalone');
    assert.match(await panel.textContent('dialog'), /1 product \(Offline Co\) and 1 draft/);
    await panel.click('dialog button[value="ok"]');
    await until(() => app.db.snapshot().emails.length === 1 && app.db.snapshot().products.length === 1);
    const snap = app.db.snapshot();
    assert.deepEqual([snap.products[0].name, snap.products[0].xHandle, snap.emails[0].what, snap.emails[0].status], ['Offline Co', '@offlineco', 'We just shipped scheduled jobs on edge servers.', 'sent']);
    assert.equal(typeof snap.emails[0].sentAt, 'number'); assert.equal(snap.emails[0].sentCopy.text, 'We just shipped scheduled jobs on edge servers.');

    // ---- the app goes away while the panel is open: nothing breaks
    await app.stop();
    await until(async () => !(await hubOnline(panel)));
    await nav(panel, 'settings'); assert.match(await panel.textContent('#view-settings'), /The Cold desktop app isn't running/);
    await nav(panel, 'write'); await panel.fill('#tweetContext', 'Second thought, written while the app is closed');
    await panel.click('#genBtn'); await panel.waitForFunction(() => document.getElementById('tweetDraft')?.value && !document.getElementById('genBtn').disabled);
    assert.match(await model(panel), /own-model/);
    await nav(panel, 'history'); await panel.waitForFunction(() => document.querySelectorAll('.hrow').length === 2);
    assert.equal(app.db.snapshot().emails.length, 1);                       // not in the app yet
    await panel.locator('.hrow', { hasText: 'Original tweet' }).first().locator('.hNote, .hToggle').first().click().catch(() => {});

    // ---- the app comes back: the new draft syncs without any action
    await app.start();
    await until(() => app.db.snapshot().emails.length === 2);
    await until(() => hubOnline(panel));
    // and a product edited in the app shows up in the extension
    app.db.put('products', 'p-from-app', { id: 'p-from-app', name: 'From the app', order: 5, what: 'x', proof: [], techFacts: [], approved: [], dontSay: [], updatedAt: Date.now() });
    await nav(panel, 'write'); await panel.waitForFunction(() => [...document.querySelectorAll('#rProduct option')].some(o => o.textContent === 'From the app'), null, { timeout: 15000 });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await app.stop().catch(() => {}); app.db.close(); await model1.close(); await ownModel.close(); }
});

test('extension also talks to a local Ollama directly (which refuses extension origins unless the header is removed)', { skip: SKIP, timeout: 200000 }, async () => {
  let tags; try { tags = await (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) })).json(); } catch { return; }   // no Ollama here: nothing to check
  const small = (tags.models || []).map(m => m.name).find(n => /1\.5b|0\.5b|3b|llama3\.2|qwen2\.5/.test(n)) || (tags.models || [])[0]?.name;
  if (!small) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-oll-'));
  const { ctx, panel } = await launch(dir);
  try {
    await nav(panel, 'settings'); await panel.waitForSelector('#setProvider');
    await panel.selectOption('#setProvider', 'ollama');
    await panel.waitForFunction(() => /models available/.test(document.querySelector('#setModelMsg').textContent), null, { timeout: 15000 });   // the list came from the real Ollama
    assert.ok((await panel.$$eval('#setModel option', o => o.map(x => x.value))).includes(small));
    await panel.selectOption('#setModel', small); await panel.click('button:has-text("Save and use this provider")');
    await until(async () => ((await model(panel)) || '').includes(small));
    await nav(panel, 'write'); await panel.check('#fmt-tweet'); await panel.check('#tk-original');
    await panel.fill('#tweetContext', 'Say hello to the world in one short sentence.');
    await panel.click('#genBtn');
    await panel.waitForSelector('#tweetDraft', { timeout: 150000 });   // a real local model may need to load into memory first (this test is slower when other tests run alongside)
    assert.ok((await panel.inputValue('#tweetDraft')).length > 3);
  } finally { await ctx.close(); }
});

test('extension paired with a running app: reads pages into the shared Write screen, uses the app\'s model, saves to its database, never reaches settings', { skip: SKIP, timeout: 150000 }, async () => {
  const model1 = await mockModel();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-ext-'));
  const app = await coldApp(model1, dir);
  app.db.put('products', 'p1', { id: 'p1', name: 'Acme Edge', order: 0, what: 'Acme Edge runs scheduled batch jobs on edge servers.', xHandle: '@acmeedge', website: 'https://acme.dev', proof: [], techFacts: [], approved: [], dontSay: [] });
  const { ctx, panel, errors } = await launch(dir);
  try {
    await nav(panel, 'settings');
    await panel.fill('#hubAddress', `127.0.0.1:${app.port}`); await panel.fill('#hubCode', app.token); await panel.click('#hubConnect');
    await until(() => hubOnline(panel));
    assert.equal(await model(panel), 'Cold desktop app · app-model');
    await nav(panel, 'write');
    await panel.waitForFunction(() => [...document.querySelectorAll('#rProduct option')].some(o => o.textContent === 'Acme Edge'));
    const keep = async url => { const p = await ctx.newPage(); await p.goto(url); await panel.evaluate(async u => { const [t] = await chrome.tabs.query({ url: u }); await chrome.tabs.update(t.id, { active: true }); }, url); await panel.waitForTimeout(400); return p; };

    // ---- reply from a tweet page
    const tweetTab = await keep('https://x.com/jacktest/status/42');
    await panel.evaluate(() => document.querySelector('#readPage').click());
    await panel.waitForFunction(() => /Read @jacktest/.test(document.querySelector('#pageStatus').textContent));
    assert.match(await panel.inputValue('#tweetContext'), /Moving batch workloads between cloud and edge/);
    await panel.fill('#tweetPoint', 'Disagree: scheduling is the hard part.');
    await panel.click('#genBtn'); await panel.waitForSelector('#tweetDraft');
    assert.equal(await panel.inputValue('#tweetDraft'), 'Scheduling is the hard part, not moving the data.');
    assert.match(await panel.textContent('#out'), /\d+ \/ 280 characters/);
    const replyPrompt = model1.prompts.find(p => /reply to the supplied tweet/.test(p));
    assert.match(replyPrompt, /tweet by @jacktest/); assert.match(replyPrompt, /Disagree: scheduling is the hard part/); assert.match(replyPrompt, /@acmeedge/);
    await until(() => app.db.snapshot().emails.find(e => e.mode === 'reply'));
    const saved = app.db.snapshot().emails.find(e => e.mode === 'reply');
    assert.deepEqual([saved.what, saved.tweetAuthor, saved.productId, saved.status], ['Scheduling is the hard part, not moving the data.', '@jacktest', 'p1', 'draft']);
    await panel.click('#insertTweet');                                  // extension-only action; the user still presses Post
    await tweetTab.waitForFunction(() => document.getElementById('box').innerText.includes('Scheduling is the hard part'));
    await tweetTab.close();

    // ---- email from a LinkedIn profile, then the SAME draft card, notes, email handoff and History as on web and desktop
    const liTab = await keep('https://www.linkedin.com/in/priya-nair');
    await panel.evaluate(() => document.querySelector('#readPage').click());
    await panel.waitForFunction(() => /Read their page/.test(document.querySelector('#pageStatus').textContent));
    assert.deepEqual([await panel.inputValue('#rName'), await panel.inputValue('#rCompany'), await panel.inputValue('#rRole')], ['Priya Nair', 'Northwind Logistics', 'Head of Platform']);
    await panel.waitForSelector('text=Use this reason'); await panel.click('text=Use this reason');
    assert.match(await panel.inputValue('#rWhy'), /moving batch workloads to the edge/);
    await panel.fill('#rEmail', 'priya@northwind.example');
    await panel.click('#genBtn'); await panel.waitForSelector('#eSubject');
    await until(() => app.db.snapshot().emails.find(e => e.mode !== 'reply'));
    const email = app.db.snapshot().emails.find(e => e.mode !== 'reply');
    assert.deepEqual([email.recipient.name, email.subject, email.productId, email.recipient.email], ['Priya Nair', 'edge jobs', 'p1', 'priya@northwind.example']);
    // Open in email (the browser's mailto handoff is MOCKED: this proves what the extension asks for, not that an email app is installed)
    await panel.evaluate(() => { window.__mail = []; HTMLAnchorElement.prototype.click = function () { if (/^mailto:/i.test(this.href)) window.__mail.push(this.href); }; });
    await panel.fill('#eSubject', 'Edited subject & more'); await panel.click('#openEmail');
    await panel.waitForFunction(() => window.__mail.length === 1);
    assert.match(await panel.evaluate(() => window.__mail[0]), /^mailto:priya@northwind\.example\?subject=Edited%20subject%20%26%20more&body=/);
    assert.match(await panel.textContent('#handoffMsg'), /hasn't sent anything/);
    assert.equal(app.db.snapshot().emails.find(e => e.id === email.id).status, 'draft', 'opening an email never marks it sent');
    // notes on the draft, then mark sent in History: the app's database sees the same status, note and sent copy
    await panel.fill('#eNote', 'Good fit: writes about batch workloads');
    await nav(panel, 'history'); await panel.locator('.hrow', { hasText: 'Priya Nair' }).locator('.hMarkSent').click();
    await until(() => { const e = app.db.snapshot().emails.find(x => x.id === email.id); return e.status === 'sent' && e.note?.startsWith('Good fit') && e.sentCopy?.text.includes('Acme Edge runs batch jobs'); });
    await liTab.close();

    // ---- the extension can never reach keys or settings, even with its code; the pairing code can't approve web pages
    for (const [method, p] of [['GET', '/api/settings'], ['GET', '/api/settings/extension'], ['PUT', '/api/settings/web-origins']]) {
      const status = await panel.evaluate(async ([origin, t, m, path]) => (await fetch(`${origin}${path}`, { method: m, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: m === 'PUT' ? '{"origins":[]}' : undefined })).status, [`http://127.0.0.1:${app.port}`, app.token, method, p]);
      assert.equal(status, 403, p);
    }
    // ---- disconnect: the extension goes back to its own library (which pairing never touched, so it is empty here); the desktop library is untouched
    const appEmails = app.db.snapshot().emails.length;
    await nav(panel, 'settings'); await panel.click('#hubDisconnect'); await panel.waitForSelector('#hubCode');
    await nav(panel, 'history'); assert.equal(await panel.locator('.hrow').count(), 0);
    assert.equal(app.db.snapshot().emails.length, appEmails);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await app.stop().catch(() => {}); app.db.close(); await model1.close(); }
});

test('extension paired to an app that then stops, with no model of its own: says so and what to do, and everything else keeps working; the app and its data are unaffected', { skip: SKIP, timeout: 180000 }, async () => {
  const appModel = await mockModel();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-pairgone-'));
  const app = await coldApp(appModel, dir);
  const { ctx, panel, errors } = await launch(dir);
  try {
    // never paired: the extension is a complete app on its own and offers (does not demand) the connection
    assert.match(await panel.textContent('#genHint'), /No provider is set up yet/);
    await nav(panel, 'settings'); assert.match(await panel.textContent('#view-settings'), /Optional\. Everything works without the app/);
    await panel.fill('#hubAddress', `127.0.0.1:${app.port}`); await panel.fill('#hubCode', app.token); await panel.click('#hubConnect');
    await until(() => hubOnline(panel));
    await nav(panel, 'write'); await until(async () => !/No provider is set up yet/.test(await panel.textContent('#genHint')));
    // the app goes away: the extension explains the situation instead of just disabling Write
    await app.stop();
    await until(async () => !(await hubOnline(panel)));
    await nav(panel, 'write');
    await until(async () => /app you paired isn't running/.test(await panel.textContent('#genHint')));
    assert.match(await panel.textContent('#genHint'), /Open the app to use its model, or open Settings and choose a model for this one/);
    assert.equal(await panel.isDisabled('#genBtn'), true);
    // products and history are unaffected by the missing connection
    await nav(panel, 'knowledge'); await panel.click('#emptyAdd');
    await panel.fill('#kName', 'Still Here'); await panel.fill('#kWhat', 'Still Here keeps working without the app.');
    await panel.click('#kSave'); await panel.waitForFunction(() => /Saved/.test(document.querySelector('.status')?.textContent || ''));
    await nav(panel, 'history'); await panel.waitForSelector('#view-history', { state: 'visible' });
    // the app comes back with its own data intact, and receives what was made meanwhile
    await app.start(); await until(() => hubOnline(panel));
    await until(() => app.db.snapshot().products.some(p => p.name === 'Still Here'));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await app.stop().catch(() => {}); app.db.close(); await appModel.close(); }
});

test('extension and desktop share one library: edits go both ways, offline edits wait and merge, and the extension\'s own library is never mixed in', { skip: SKIP, timeout: 180000 }, async () => {
  const appModel = await mockModel();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-extshare-'));
  const app = await coldApp(appModel, dir);
  const rec = (o = {}) => ({ id: 'e1', createdAt: 1000, status: 'draft', mode: 'email', productId: 'p1', productName: 'Acme', recipient: { name: 'Sam Ortiz', company: 'TrialCo' }, subject: 'hello', what: 'We help.', why: 'You wrote it.', ask: 'Could I ask?', note: '', ...o });
  app.db.put('products', 'p1', { id: 'p1', name: 'Acme', order: 0, what: 'Acme does things.', proof: [], techFacts: [], approved: [], dontSay: [], updatedAt: 5 });
  app.db.put('emails', 'e1', rec({ updatedAt: 5 }));
  const { ctx, panel, errors } = await launch(dir);
  try {
    // the extension's own library gets a record first; connecting must neither send it nor mix it in
    await panel.evaluate(() => chrome.storage.local.set({ 'cold.replica': { products: {}, emails: { own1: { id: 'own1', createdAt: 5, status: 'draft', recipient: { name: 'Own Person', company: 'OwnCo' }, subject: 's', what: 'w', why: 'y', ask: 'a?' } }, outbox: [], lastSync: 0 } }));
    await panel.reload(); await panel.waitForSelector('#genBtn', { state: 'attached' });
    await nav(panel, 'history'); await panel.waitForFunction(() => /Own Person/.test(document.body.innerText));
    await nav(panel, 'settings');
    await panel.fill('#hubAddress', `127.0.0.1:${app.port}`); await panel.fill('#hubCode', app.token); await panel.click('#hubConnect');
    await until(() => hubOnline(panel));
    await nav(panel, 'history'); await panel.waitForFunction(() => /Sam Ortiz/.test(document.body.innerText) && !/Own Person/.test(document.body.innerText));
    await new Promise(r => setTimeout(r, 1500));
    assert.deepEqual(app.db.snapshot().emails.map(e => e.id), ['e1'], 'the extension\'s own library did not reach the app');
    // an edit in the extension reaches the desktop database; a change in the desktop shows up in the extension
    const row = panel.locator('.hrow', { hasText: 'Sam Ortiz' });
    await row.locator('.hToggle').click(); await row.locator('.hNote').fill('note from the extension');
    await until(() => app.db.snapshot().emails.find(e => e.id === 'e1').note === 'note from the extension');
    const cur = app.db.snapshot().emails.find(e => e.id === 'e1');
    app.db.put('emails', 'e1', { ...cur, status: 'replied', repliedAt: 9, updatedAt: cur.updatedAt + 1 });
    await panel.waitForFunction(() => /Reply recorded/.test(document.querySelector('.hrow').textContent), null, { timeout: 25000 });
    // the app closes; the extension keeps working on its copy, and what it did waits for the app
    await app.stop(); await until(async () => !(await hubOnline(panel)));
    await panel.locator('.hrow', { hasText: 'Sam Ortiz' }).locator('.hNote').fill('written while the app was closed');
    await nav(panel, 'settings'); await panel.waitForFunction(() => /\d+ changes? waiting to sync/.test(document.querySelector('#syncLine').textContent));
    assert.equal(app.db.snapshot().emails.find(e => e.id === 'e1').note, 'note from the extension');
    await app.start(); await until(() => hubOnline(panel));
    await until(() => app.db.snapshot().emails.find(e => e.id === 'e1').note === 'written while the app was closed');
    assert.equal(app.db.snapshot().emails.find(e => e.id === 'e1').status, 'replied', 'the reply recorded in the app survived the extension\'s older copy');
    // switching to the extension's own library and back changes neither
    const own = () => panel.evaluate(async () => JSON.stringify((await chrome.storage.local.get('cold.replica'))['cold.replica'].emails));
    const ownBefore = await own();
    await nav(panel, 'settings'); await panel.click('#useStandalone'); await panel.click('dialog button[value="ok"]');
    await nav(panel, 'history'); await panel.waitForFunction(() => /Own Person/.test(document.body.innerText) && !/Sam Ortiz/.test(document.body.innerText));
    assert.equal(await own(), ownBefore);
    await nav(panel, 'settings'); await panel.click('#useShared'); await panel.click('dialog button[value="ok"]');
    await nav(panel, 'history'); await panel.waitForFunction(() => /Sam Ortiz/.test(document.body.innerText));
    assert.deepEqual(app.db.snapshot().emails.map(e => e.id), ['e1']);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await app.stop().catch(() => {}); app.db.close(); await appModel.close(); }
});
