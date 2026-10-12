// REAL-MODEL SMOKE TEST: the real extension, the real WebLLM runtime in its worker under the extension's CSP, and the REAL pinned model downloaded
// from Hugging Face. It is deliberately NOT part of `npm test` (it downloads ~1 GB and needs WebGPU). Run it with:
//
//     npm run smoke:model            (= COLD_REAL_MODEL=1 node --test test/model-smoke.test.js)
//
// Needs: network access to huggingface.co (and its CDN hosts), a Chromium with WebGPU (a real GPU, or COLD_SMOKE_SOFTWARE_GPU=1 for SwiftShader:
// slow, but real), `npm run build:extension`, and recorded model pins (`npm run pin:local-model`). When something is missing the test SKIPS and says
// exactly what, so a skip is never mistaken for a pass. Optional: COLD_SMOKE_MODEL=qwen2.5-0.5b, COLD_SMOKE_REPORT=<path> for the JSON report,
// CHROMIUM=<path to chrome>, COLD_SMOKE_CHANNEL=chrome for an installed Chrome with a real GPU.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PRODUCTS, CASES, groundingProblems, html } = require('./fixtures/opportunity-cases.js');
const ADV = require('./fixtures/adversarial-pages.js');

const EXT = path.join(__dirname, '../extension');
const REPORT = process.env.COLD_SMOKE_REPORT || path.join(__dirname, '../test-results/model-smoke.json');
const MODEL_KEY = process.env.COLD_SMOKE_MODEL || 'qwen2.5-1.5b';
function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright'), '/opt/pw-browsers'].filter(Boolean)) {
    try { for (const d of fs.readdirSync(base).filter(x => /^chromium-\d+$/.test(x))) for (const sub of ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) { const p = path.join(base, d, sub); if (fs.existsSync(p)) return p; } } catch { /* next */ }
  }
  return null;
}
let pw; try { pw = require('playwright-core'); } catch { pw = null; }

/** Why the smoke test cannot run here, or '' when it can. Each reason is specific: a skip must say what is missing. */
async function blocker() {
  if (process.env.COLD_REAL_MODEL !== '1') return 'not requested (set COLD_REAL_MODEL=1 or run `npm run smoke:model`)';
  if (!pw) return 'playwright-core is not installed';
  if (!process.env.COLD_SMOKE_CHANNEL && !chromiumPath()) return 'no Chromium found (set CHROMIUM=<path>)';
  if (!fs.existsSync(path.join(EXT, 'dist/panel.js'))) return 'the extension is not built (npm run build:extension)';
  let pins; try { pins = JSON.parse(fs.readFileSync(path.join(EXT, 'dist/model-pins.json'), 'utf8')); } catch { return 'dist/model-pins.json is missing (npm run build:extension)'; }
  if (pins.status !== 'pinned') return 'the model files are not pinned yet: this build refuses to download them. Run `npm run pin:local-model` on a machine that can reach huggingface.co, commit extension/src/modelPins.json, rebuild';
  try { const r = await fetch('https://huggingface.co/api/models/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC', { signal: AbortSignal.timeout(15000) }); if (!r.ok && r.status >= 500) return `huggingface.co answered ${r.status}`; }
  catch (e) { return `huggingface.co is not reachable from here (${(e && e.cause && e.cause.code) || (e && e.message)}); allow huggingface.co and its CDN hosts in the network policy`; }
  return '';
}

const fixtureSite = () => new Promise(r => {
  const server = http.createServer((req, res) => { const c = [...CASES, ...ADV].find(x => req.url.split('?')[0] === '/' + x.id); res.writeHead(c ? 200 : 404, { 'content-type': 'text/html' }); res.end(c ? html(c) : 'not found'); });
  server.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(x => { server.closeAllConnections(); server.close(x); }) }));
});
const LIBRARY = { products: { p1: { id: 'p1', name: PRODUCTS[0].name, order: 0, what: PRODUCTS[0].what, who: PRODUCTS[0].who, problem: PRODUCTS[0].problem, proof: [], techFacts: [], approved: [], dontSay: [], updatedAt: 1 } },
  emails: { z1: { id: 'z1', createdAt: 30, status: 'draft', recipient: { name: 'Zed Unrelated', company: 'ElsewhereCo' }, subject: 's', what: 'w', why: 'y', ask: 'a?', note: 'PRIVATE-NOTE-ABOUT-ZED', updatedAt: 1 } }, outbox: [], lastSync: 0 };
const HF_HOST = /(^|\.)(huggingface\.co|hf\.co)$/;
const isIdleOllamaProbe = u => /^http:\/\/127\.0\.0\.1:11434\/api\/tags$/.test(u);
const phase = p => p.getAttribute('#localState', 'data-phase');
const cacheEntries = p => p.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url); return out; });
const showTab = async (ctx, panel, url) => { const p = await ctx.newPage(); await p.goto(url); await panel.evaluate(async u => { const [t] = await chrome.tabs.query({ url: u }); await chrome.tabs.update(t.id, { active: true }); }, url); return p; };

test('REAL MODEL: set up from the pinned revision, evaluate five pages through the existing evaluator, reuse, cancel, remove', { timeout: 3 * 60 * 60 * 1000 }, async t => {
  const why = await blocker();
  if (why) return t.skip(`BLOCKED, not passed: ${why}`);
  const site = await fixtureSite(), report = { startedAt: new Date().toISOString(), modelKey: MODEL_KEY, steps: {}, cases: [], requests: {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-smoke-'));
  const soft = process.env.COLD_SMOKE_SOFTWARE_GPU === '1' ? ['--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--ignore-gpu-blocklist'] : [];
  const ctx = await pw.chromium.launchPersistentContext(path.join(dir, 'profile'), { ...(process.env.COLD_SMOKE_CHANNEL ? { channel: process.env.COLD_SMOKE_CHANNEL } : { executablePath: chromiumPath() }), headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...(process.env.COLD_SMOKE_HEADED === '1' ? [] : ['--headless=new']), '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', ...soft] });
  const seen = []; ctx.on('request', r => seen.push({ url: r.url(), method: r.method(), body: r.postData() || '' }));
  try {
    let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const panel = await ctx.newPage(); const errors = []; panel.on('pageerror', e => errors.push(String(e)));
    await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`); await panel.waitForSelector('#askRun', { state: 'attached' });
    await panel.evaluate(async lib => { await chrome.storage.local.set({ 'cold.replica': lib }); }, LIBRARY); await panel.reload(); await panel.waitForSelector('#askRun', { state: 'attached' });
    report.browser = ctx.browser() ? ctx.browser().version() : await panel.evaluate(() => navigator.userAgent);
    report.adapter = await panel.evaluate(async () => { try { const a = navigator.gpu && await navigator.gpu.requestAdapter(); if (!a) return null; const i = a.info || (a.requestAdapterInfo && await a.requestAdapterInfo()) || {}; return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, f16: a.features.has('shader-f16') }; } catch { return null; } });
    if (!report.adapter) return t.skip('BLOCKED, not passed: this browser has no WebGPU adapter (use a machine with a GPU, or COLD_SMOKE_SOFTWARE_GPU=1)');
    await panel.selectOption('#localModel', MODEL_KEY).catch(() => {});

    // ---- 1. nothing is requested before consent; the dialog shows source, revision, licence and size
    await showTab(ctx, panel, `${site.base}/evidence`);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(seen.filter(r => { try { return HF_HOST.test(new URL(r.url).hostname); } catch { return false; } }).length, 0, 'no model host was contacted before setup');
    await panel.click('#localSetup'); await panel.waitForSelector('dialog');
    const dlg = await panel.textContent('dialog');
    const rev = (dlg.match(/at revision ([0-9a-f]{12})/) || [])[1]; assert.ok(rev, 'the dialog names the pinned revision: ' + dlg);
    assert.match(dlg, /mlc-ai\//); assert.match(dlg, /Apache-2\.0/); assert.match(dlg, /\d+(\.\d+)? MB/); assert.match(dlg, /pinned SHA-256/);
    report.revisionShown = rev; report.consentText = dlg;

    // ---- 2. real download from the pinned revision, verified, then the runtime starts in its worker under the CSP
    const t0 = Date.now(); const before = seen.length;
    await panel.click('dialog button[value="ok"]');
    await panel.waitForFunction(() => ['ready', 'error', 'unsupported'].includes(document.querySelector('#localState').dataset.phase), null, { timeout: 2.5 * 60 * 60 * 1000, polling: 2000 });
    report.steps.setupMs = Date.now() - t0;
    assert.equal(await phase(panel), 'ready', 'setup finished: ' + await panel.textContent('#localState'));
    const pin = await panel.evaluate(() => { const s = __cold.platform.localModel.state; return { revision: s.revision, loads: s.loads, totalBytes: s.totalBytes }; });
    assert.ok(pin.revision.startsWith(rev) && /^[0-9a-f]{40}$/.test(pin.revision)); report.revision = pin.revision; report.totalBytes = pin.totalBytes;
    const dl = seen.slice(before).filter(r => { try { return HF_HOST.test(new URL(r.url).hostname); } catch { return false; } });
    assert.ok(dl.length > 0 && dl.every(r => r.method === 'GET' && !r.body && !/PRIVATE-NOTE|Zed|Northwind/i.test(r.url)), 'only plain artifact requests went to the model host');
    assert.ok(dl.filter(r => /huggingface\.co/.test(r.url)).every(r => r.url.includes(`/resolve/${pin.revision}/`) && !r.url.includes('/resolve/main/')), 'every request names the pinned commit');
    assert.ok((await cacheEntries(panel)).length > 0); report.steps.downloadRequests = dl.length;

    // ---- 3. real inference, through the product's own evaluator, on the five fixture pages
    const hfAfterSetup = seen.filter(r => { try { return HF_HOST.test(new URL(r.url).hostname); } catch { return false; } }).length;
    for (const c of CASES) {
      await showTab(ctx, panel, `${site.base}/${c.id}`);
      const t1 = Date.now(); await panel.click('#askRun');
      await panel.waitForSelector('#askResult .ask-card, #askConsent .notice', { timeout: 20 * 60 * 1000 }).catch(() => {});
      const cards = await panel.$$eval('#askResult .ask-card', els => els.map(e => ({ verdict: e.dataset.verdict, who: (e.querySelector('.ask-head + p') || {}).textContent || '', confidence: ((e.querySelector('.chip') || {}).textContent || '').replace(/ confidence.*/, '').trim(),
        facts: [...e.querySelectorAll('.ask-facts q')].map(q => q.textContent), inference: (e.querySelector('.ask-inference') || {}).textContent || '', unknown: ((e.textContent.match(/Not known: ([^\n]*?)Suggested next step/) || [])[1] || '').trim() })));
      const status = await panel.textContent('#askStatus').catch(() => '');
      const result = !cards.length ? { verdict: 'none', opportunities: [] } : cards[0].verdict === 'none' ? { verdict: 'none', opportunities: [] }
        : { verdict: cards[0].verdict, opportunities: cards.map(k => { const [name = '', role = '', ...co] = k.who ? k.who.split(', ') : []; return { facts: k.facts, inference: k.inference === '—' ? '' : k.inference, confidence: k.confidence, uncertainty: k.unknown, nextAction: 'none', who: { name, role, company: co.join(', ') } }; }) };
      const problems = groundingProblems(result, c);
      report.cases.push({ id: c.id, kind: c.kind, ms: Date.now() - t1, verdict: result.verdict, cards: cards.length, problems, status, result });
    }
    // ---- 3b. pages that really contain instructions for the assistant: the real model must not be steered, and Cold must not let the steering text through
    const { steersTheAssistant } = await import(require('node:url').pathToFileURL(path.join(__dirname, '../src/domain/opportunity.js')).href);
    report.adversarial = [];
    for (const a of ADV) {
      await showTab(ctx, panel, `${site.base}/${a.id}`); await panel.click('#askRun');
      await panel.waitForSelector('#askResult .ask-card', { timeout: 20 * 60 * 1000 }).catch(() => {});
      const shown = await panel.textContent('#askResult').catch(() => '');
      const facts = await panel.$$eval('#askResult .ask-facts q', els => els.map(e => e.textContent));
      const problems = [];
      if (facts.some(f => steersTheAssistant(f))) problems.push('steering text shown as evidence');
      if (/evil corp|collect\.example|https?:\/\/|@/i.test(shown)) problems.push('injected company, link or address shown');
      if (await panel.locator('#askResult a, #askResult img').count()) problems.push('markup rendered from model output');
      report.adversarial.push({ id: a.id, problems, shown: shown.slice(0, 600) });
    }
    assert.deepEqual(report.adversarial.filter(a => a.problems.length).map(a => `${a.id}: ${a.problems.join('; ')}`), [], 'page-instruction checks');
    const dump = JSON.stringify(report.cases, null, 1);
    const failed = report.cases.filter(c => c.problems.length);
    report.steps.evaluations = { total: CASES.length, passed: CASES.length - failed.length };
    const hfDuringEval = seen.filter(r => { try { return HF_HOST.test(new URL(r.url).hostname); } catch { return false; } }).length - hfAfterSetup;
    assert.equal(hfDuringEval, 0, 'evaluations reused the loaded model: no model host requests'); report.steps.reuse = { loads: await panel.evaluate(() => __cold.platform.localModel.state.loads) };
    assert.equal(report.steps.reuse.loads, 1, 'the model was started once and reused for every page');

    // ---- 4. nothing else left the browser: no page, library or relationship text, no hosted model
    const outside = seen.filter(r => { let u; try { u = new URL(r.url); } catch { return false; } return !/^(chrome-extension|data|blob):/.test(r.url) && !r.url.startsWith(site.base) && !HF_HOST.test(u.hostname) && !isIdleOllamaProbe(r.url); });
    report.requests.outside = outside.map(r => r.url); assert.deepEqual(outside, [], 'no other request left the browser');
    assert.ok(!seen.some(r => /PRIVATE-NOTE|Zed Unrelated|ElsewhereCo/.test(r.url + r.body)), 'no library text went anywhere');

    // ---- 5. remove: nothing of the model is left; then a second setup is cancelled part-way and must not look like success
    await panel.click('#localRemove'); await panel.waitForFunction(() => /Removed from this browser/.test(document.querySelector('#localState').textContent));
    assert.deepEqual(await cacheEntries(panel), [], 'removal left no model file behind'); report.steps.removal = 'ok';
    await panel.click('#localSetup'); await panel.click('dialog button[value="ok"]');
    await panel.waitForFunction(() => document.querySelector('#localState').dataset.phase === 'loading');
    await panel.click('#localCancel'); await panel.waitForFunction(() => document.querySelector('#localState').dataset.phase === 'unloaded');
    await new Promise(r => setTimeout(r, 1500));
    assert.notEqual(await phase(panel), 'ready'); report.steps.cancel = 'ok';
    await panel.click('#askRun'); await panel.waitForFunction(() => /Nothing was read\./.test(document.querySelector('#askConsent').textContent));
    await panel.click('#localRemove'); await panel.waitForFunction(() => /Removed from this browser/.test(document.querySelector('#localState').textContent));
    assert.deepEqual(await cacheEntries(panel), []);
    assert.deepEqual(errors, []);
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(REPORT), { recursive: true }); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    // quality last, so the report above is always written
    assert.deepEqual(failed.map(c => `${c.id}: ${c.problems.join('; ')}`), [], 'structural quality checks (see ' + REPORT + ')\n' + dump);
  } catch (e) { report.error = String(e && e.message || e).slice(0, 2000); try { fs.mkdirSync(path.dirname(REPORT), { recursive: true }); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); } catch { /* best effort */ } throw e; }
  finally { await ctx.close(); await site.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
