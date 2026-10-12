// End to end: the real extension in Chromium, the real Cold server + SQLite file, a MOCK model (canned JSON, so this proves
// plumbing, auth and data flow, not output quality), and fixture pages standing in for x.com and linkedin.com.
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

test('extension: pair, read a tweet, write a reply, read a profile, write an email, stay out of settings', { skip: SKIP, timeout: 120000 }, async () => {
  const model = await mockModel();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-ext-'));
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'COLD_ACCESS_TOKEN']) process.env[k] = '';
  Object.assign(process.env, { LLM_PROVIDER: 'ollama', OLLAMA_MODEL: 'mock-model', OLLAMA_BASE_URL: `http://127.0.0.1:${model.port}`, COLD_DB_FILE: path.join(dir, 'cold.db'), COLD_SETTINGS_FILE: path.join(dir, 's.json') });
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.db.put('products', 'p1', { id: 'p1', name: 'Acme Edge', order: 0, what: 'Acme Edge runs scheduled batch jobs on edge servers.', xHandle: '@acmeedge', website: 'https://acme.dev', proof: [], techFacts: [], approved: [], dontSay: [] });
  const token = server.db.extensionToken();

  const ext = path.join(__dirname, '../extension');
  const ctx = await pw.chromium.launchPersistentContext(path.join(dir, 'profile'), { executablePath: CHROMIUM, headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'] });
  try {
    await ctx.route('https://x.com/**', r => r.fulfill({ contentType: 'text/html', body: TWEET_PAGE }));
    await ctx.route('https://www.linkedin.com/**', r => r.fulfill({ contentType: 'text/html', body: PROFILE_PAGE }));
    let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = new URL(sw.url()).host;

    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${id}/panel.html`);
    // ---- pairing
    await panel.fill('#cAddress', `127.0.0.1:${port}`); await panel.fill('#cCode', 'not-the-code'); await panel.click('button[type=submit]');
    panel.on('console', m => process.env.DEBUG_EXT && console.log('PANEL:', m.text())); panel.on('pageerror', e => process.env.DEBUG_EXT && console.log('PAGEERR:', e.message));
    await panel.waitForTimeout(1500); if (process.env.DEBUG_EXT) console.log(await panel.evaluate(() => document.body.innerHTML.slice(0, 600)));
    await panel.waitForFunction(() => /rejected that pairing code/.test(document.querySelector('[role=status]').textContent));
    await panel.fill('#cCode', token); await panel.click('button[type=submit]');
    await panel.waitForSelector('.x-head');
    assert.match(await panel.textContent('.x-head'), /mock-model/);
    assert.equal(await panel.$$eval('#xProduct option', o => o.map(x => x.textContent).join()), 'No product,Acme Edge');
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
    // saved into the app's database, where the desktop app will show it
    const saved = server.db.snapshot().emails.find(e => e.mode === 'reply');
    assert.deepEqual([saved.what, saved.tweetAuthor, saved.productId], ['Scheduling is the hard part, not moving the data.', '@jacktest', 'p1']);
    // insert into the page's own box, without posting
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
    await panel.click('text=Write the email'); await panel.waitForSelector('text=Copy email');
    const email = server.db.snapshot().emails.find(e => e.mode !== 'reply');
    assert.deepEqual([email.recipient.name, email.subject, email.productId], ['Priya Nair', 'edge jobs', 'p1']);
    await liTab.close();

    // ---- the extension can never reach keys or settings, even with its token
    const status = await panel.evaluate(async ([origin, t]) => (await fetch(`${origin}/api/settings`, { headers: { authorization: `Bearer ${t}` } })).status, [`http://127.0.0.1:${port}`, token]);
    assert.equal(status, 403);
    // ---- disconnect
    await panel.click('text=Disconnect'); await panel.waitForSelector('#cCode');
  } finally { await ctx.close(); await new Promise(r => server.close(r)); server.db.close(); await model.close(); }
});
