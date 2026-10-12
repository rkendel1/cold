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
  await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);
  await panel.waitForSelector('.x-status');
  return { ctx, panel };
}
const tab = (panel, name) => panel.click(`label:has-text("${name}")`);
const chipText = panel => panel.textContent('.x-status');
const until = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for condition: ' + fn); await new Promise(r => setTimeout(r, 150)); } };

test('extension works with the app closed, then syncs with it when it starts, survives it stopping, and syncs again', { skip: SKIP, timeout: 180000 }, async () => {
  const model = await mockModel(), ownModel = await mockModel();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-off-'));
  const app = await coldApp(model, dir);
  await app.stop();                                                // the app is NOT running at the start
  const { ctx, panel } = await launch(dir);
  try {
    assert.match(await panel.textContent('body'), /Choose a model to start/);
    // ---- give the extension its own model: no app, no keys file, nothing else
    await tab(panel, 'Settings');
    await panel.selectOption('#mProvider', 'custom');
    await panel.fill('#mUrl', `http://127.0.0.1:${ownModel.port}/v1`);
    await panel.selectOption('#mModel', '__other__'); await panel.fill('#mModelText', 'own-model');
    await panel.click('button:has-text("Save")');
    await until(async () => /own-model/.test(await chipText(panel)));
    assert.doesNotMatch(await panel.textContent('body'), /Choose a model to start/);
    // ---- add a product in the extension
    await tab(panel, 'Products'); await panel.click('#addProduct');
    await panel.fill('#pName', 'Offline Co'); await panel.fill('#pWhat', 'Offline Co writes software that works without a server.'); await panel.fill('#pX', 'offlineco');
    await panel.click('#saveProduct'); await panel.waitForSelector('text=Ready to write from');
    // ---- write an original tweet with the app closed
    await tab(panel, 'Write'); await panel.click('input[value=tweet]');
    await panel.fill('#xText', 'We just shipped offline mode'); await panel.click('text=Write the tweet'); await panel.waitForSelector('#xDraft');
    assert.equal(await panel.inputValue('#xDraft'), 'We just shipped scheduled jobs on edge servers.');
    assert.ok(ownModel.prompts.some(p => /Offline Co/.test(p) && /@offlineco/.test(p)), 'the tweet used the product and its handle');
    assert.equal(model.prompts.length, 0, 'the (closed) app\'s model was never involved');
    assert.equal(app.db.snapshot().emails.length, 0);

    // ---- the app starts and is paired: everything made offline reaches it
    await app.start();
    await tab(panel, 'Settings');
    await panel.fill('#cAddress', `127.0.0.1:${app.port}`); await panel.fill('#cCode', 'wrong-code'); await panel.click('button:has-text("Connect")');
    await panel.waitForSelector('text=rejected that pairing code');
    await panel.fill('#cCode', app.token); await panel.click('button:has-text("Connect")');
    await until(async () => /App connected/.test(await chipText(panel)));
    await until(() => app.db.snapshot().emails.length === 1 && app.db.snapshot().products.length === 1);
    const snap = app.db.snapshot();
    assert.deepEqual([snap.products[0].name, snap.products[0].xHandle, snap.emails[0].what], ['Offline Co', '@offlineco', 'We just shipped scheduled jobs on edge servers.']);

    // ---- the app goes away while the panel is open: nothing breaks
    await app.stop();
    await until(async () => /App not running/.test(await chipText(panel)));
    assert.match(await panel.textContent('body'), /The Cold app isn't running/);
    await tab(panel, 'Write'); await panel.fill('#xText', 'Second thought, written while the app is closed');
    await panel.click('text=Write the tweet'); await panel.waitForFunction(() => document.querySelectorAll('.x-recent li').length >= 2);
    assert.match(await chipText(panel), /Custom.*own-model/);
    assert.equal(app.db.snapshot().emails.length, 1);                      // not in the app yet

    // ---- the app comes back: the new draft syncs without any action
    await app.start();
    await until(() => app.db.snapshot().emails.length === 2);
    await until(async () => /App connected/.test(await chipText(panel)));
    // and a product edited in the app shows up in the extension
    app.db.put('products', 'p-from-app', { id: 'p-from-app', name: 'From the app', order: 5, what: 'x', proof: [], techFacts: [], approved: [], dontSay: [], updatedAt: Date.now() });
    await tab(panel, 'Products');
    await panel.waitForSelector('h2:has-text("From the app")', { timeout: 15000 });
  } finally { await ctx.close(); await app.stop().catch(() => {}); app.db.close(); await model.close(); await ownModel.close(); }
});

test('extension also talks to a local Ollama directly (which refuses extension origins unless the header is removed)', { skip: SKIP, timeout: 200000 }, async () => {
  let tags; try { tags = await (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) })).json(); } catch { return; }   // no Ollama here: nothing to check
  const small = (tags.models || []).map(m => m.name).find(n => /1\.5b|0\.5b|3b|llama3\.2|qwen2\.5/.test(n)) || (tags.models || [])[0]?.name;
  if (!small) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-oll-'));
  const { ctx, panel } = await launch(dir);
  try {
    await tab(panel, 'Settings');
    await panel.selectOption('#mProvider', 'ollama');
    await panel.click('button:has-text("Refresh models")');
    await panel.waitForFunction(() => /models available/.test(document.querySelector('#mModel').closest('.field').innerText));
    assert.ok((await panel.$$eval('#mModel option', o => o.map(x => x.value))).includes(small), 'the model list came from the real Ollama');
    await panel.selectOption('#mModel', small); await panel.click('button:has-text("Save")');
    await until(async () => (await chipText(panel)).includes(small));
    await tab(panel, 'Write'); await panel.click('input[value=tweet]');
    await panel.fill('#xText', 'Say hello to the world in one short sentence.');
    await panel.click('text=Write the tweet');
    await panel.waitForSelector('#xDraft', { timeout: 150000 });   // a real local model may need to load into memory first
    assert.ok((await panel.inputValue('#xDraft')).length > 3);
  } finally { await ctx.close(); }
});

test('extension paired with a running app: reads pages, uses the app\'s model, saves to its database, never reaches settings', { skip: SKIP, timeout: 120000 }, async () => {
  const model = await mockModel();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-ext-'));
  const app = await coldApp(model, dir);
  app.db.put('products', 'p1', { id: 'p1', name: 'Acme Edge', order: 0, what: 'Acme Edge runs scheduled batch jobs on edge servers.', xHandle: '@acmeedge', website: 'https://acme.dev', proof: [], techFacts: [], approved: [], dontSay: [] });
  const { ctx, panel } = await launch(dir);
  try {
    await tab(panel, 'Settings');
    await panel.fill('#cAddress', `127.0.0.1:${app.port}`); await panel.fill('#cCode', app.token); await panel.click('button:has-text("Connect")');
    await until(async () => /App connected/.test(await chipText(panel)));
    assert.match(await chipText(panel), /Cold app · app-model/);
    await tab(panel, 'Write');
    await panel.waitForFunction(() => [...document.querySelectorAll('#xProduct option')].some(o => o.textContent === 'Acme Edge'));
    const keep = async url => { const p = await ctx.newPage(); await p.goto(url); await panel.evaluate(async u => { const [t] = await chrome.tabs.query({ url: u }); await chrome.tabs.update(t.id, { active: true }); }, url); await panel.waitForTimeout(400); return p; };

    // ---- reply from a tweet page
    const tweetTab = await keep('https://x.com/jacktest/status/42');
    await panel.evaluate(() => document.querySelector('.x-page button').click());
    await panel.waitForFunction(() => /Read @jacktest/.test(document.querySelector('.x-page [role=status]').textContent));
    assert.match(await panel.inputValue('#xText'), /Moving batch workloads between cloud and edge/);
    await panel.fill('#xPoint', 'Disagree: scheduling is the hard part.');
    await panel.click('text=Write a reply'); await panel.waitForSelector('#xDraft');
    assert.equal(await panel.inputValue('#xDraft'), 'Scheduling is the hard part, not moving the data.');
    assert.match(await panel.textContent('.x-card'), /\d+ \/ 280 characters/);
    const replyPrompt = model.prompts.find(p => /reply to the supplied tweet/.test(p));
    assert.match(replyPrompt, /tweet by @jacktest/); assert.match(replyPrompt, /Disagree: scheduling is the hard part/); assert.match(replyPrompt, /@acmeedge/);
    await until(() => app.db.snapshot().emails.find(e => e.mode === 'reply'));
    const saved = app.db.snapshot().emails.find(e => e.mode === 'reply');
    assert.deepEqual([saved.what, saved.tweetAuthor, saved.productId], ['Scheduling is the hard part, not moving the data.', '@jacktest', 'p1']);
    await panel.evaluate(() => [...document.querySelectorAll('button')].find(b => /tweet box/.test(b.textContent)).click());
    await tweetTab.waitForFunction(() => document.getElementById('box').innerText.includes('Scheduling is the hard part'));
    await tweetTab.close();

    // ---- email from a LinkedIn profile
    const liTab = await keep('https://www.linkedin.com/in/priya-nair');
    await panel.evaluate(() => document.querySelector('.x-page button').click());
    await panel.waitForFunction(() => /Read their page/.test(document.querySelector('.x-page [role=status]').textContent));
    assert.deepEqual([await panel.inputValue('#xName'), await panel.inputValue('#xCompany'), await panel.inputValue('#xRole')], ['Priya Nair', 'Northwind Logistics', 'Head of Platform']);
    await panel.waitForSelector('text=Use this reason'); await panel.click('text=Use this reason');
    assert.match(await panel.inputValue('#xWhy'), /moving batch workloads to the edge/);
    await panel.fill('#xEmail', 'priya@northwind.example');
    await panel.click('text=Write the email'); await panel.waitForSelector('text=Copy email');
    await until(() => app.db.snapshot().emails.find(e => e.mode !== 'reply'));
    const email = app.db.snapshot().emails.find(e => e.mode !== 'reply');
    assert.deepEqual([email.recipient.name, email.subject, email.productId, email.recipient.email], ['Priya Nair', 'edge jobs', 'p1', 'priya@northwind.example']);
    // ---- Open in email (the browser's mailto handoff is MOCKED here: this proves what the extension asks for, not that an email app is installed)
    assert.equal(await panel.inputValue('#xTo'), 'priya@northwind.example');
    await panel.evaluate(() => { window.__mail = []; HTMLAnchorElement.prototype.click = function () { if (/^mailto:/i.test(this.href)) window.__mail.push(this.href); }; });
    await panel.fill('[aria-label=Subject], [aria-label="subject"]', 'Edited subject & more'); 
    await panel.click('button:has-text("Open in email")');
    await panel.waitForFunction(() => window.__mail.length === 1);
    const mailUrl = await panel.evaluate(() => window.__mail[0]);
    assert.match(mailUrl, /^mailto:priya@northwind\.example\?subject=Edited%20subject%20%26%20more&body=/);
    assert.match(decodeURIComponent(mailUrl.split('&body=')[1]), /Acme Edge runs batch jobs on edge servers\./);
    assert.match(await panel.textContent('#xHandoff'), /hasn't sent anything/);
    await panel.fill('#xTo', ''); await panel.click('button:has-text("Open in email")');
    assert.match(await panel.textContent('#xHandoff'), /Add the recipient's email address/);
    assert.equal(await panel.evaluate(() => window.__mail.length), 1, 'nothing opened without an address');
    await panel.fill('#xTo', 'priya@northwind.example');
    await until(() => app.db.snapshot().emails.find(e => e.mode !== 'reply' && e.subject === 'Edited subject & more' && e.recipient.email === 'priya@northwind.example'));
    assert.equal(app.db.snapshot().emails.find(e => e.mode !== 'reply').status, 'draft', 'opening an email never marks it sent');
    await liTab.close();

    // ---- the extension can never reach keys or settings, even with its code
    const status = await panel.evaluate(async ([origin, t]) => (await fetch(`${origin}/api/settings`, { headers: { authorization: `Bearer ${t}` } })).status, [`http://127.0.0.1:${app.port}`, app.token]);
    assert.equal(status, 403);
    // ---- disconnect: the extension keeps its copy and keeps working
    await tab(panel, 'Settings'); await panel.click('button:has-text("Disconnect")');
    await panel.waitForSelector('#cCode');
    assert.doesNotMatch(await chipText(panel), /App connected/);
  } finally { await ctx.close(); await app.stop().catch(() => {}); app.db.close(); await model.close(); }
});
