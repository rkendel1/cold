// The extension side panel at real side-panel widths: one navigation row that never wraps or scrolls, no horizontal page scroll, Ask Cold
// and Browse With Me configuration only in Settings, collapsible Knowledge/Settings sections, and the History product filter. Seeded
// library, no model: this proves layout and wiring, not output quality. Screenshots are written when COLD_SHOTS is a directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('./helpers/env');

let pw; try { pw = require('playwright-core'); } catch { pw = null; }
const CHROMIUM = process.env.CHROMIUM || (env.browserAvailable() && require('playwright-core').chromium.executablePath());
const SKIP = !pw || !CHROMIUM || !fs.existsSync(CHROMIUM) || !fs.existsSync(path.join(__dirname, '../extension/dist/panel.js')) ? 'Chromium, playwright-core or the built extension is not available' : false;
const EXT = path.join(__dirname, '../extension');
const WIDTHS = [320, 360, 400];

const long = 'Acme Edge runs scheduled batch jobs on edge servers so platform teams can move workloads without rewriting them.';
const LIB = {
  products: {
    p1: { id: 'p1', name: 'Acme Edge', order: 0, oneLiner: 'Batch jobs at the edge', what: long, who: 'Platform teams', problem: 'Batch jobs are slow to move.', proof: [{ id: 'a', claim: 'Two design partners', evidence: 'Pilot', type: 'Customer', strength: 'High', external: true }, { id: 'b', claim: 'Internal number', evidence: 'x', type: 'Revenue / growth', strength: 'Low', external: false }], techFacts: ['Runs on ARM'], approved: [], dontSay: ['"game changer"'], updatedAt: 1 },
    p2: { id: 'p2', name: 'Beacon', order: 1, what: 'Beacon watches job queues.', proof: [], techFacts: [], approved: [], dontSay: [], updatedAt: 1 },
  },
  emails: {
    e1: { id: 'e1', createdAt: 40, status: 'draft', productId: 'p1', productName: 'Acme Edge', recipient: { name: 'Priya Nair', company: 'Northwind Logistics', role: 'Head of Platform' }, subject: 'edge jobs', what: long, why: 'You write about moving batch workloads to the edge.', ask: 'Could I get your take?', updatedAt: 1 },
    e2: { id: 'e2', createdAt: 30, status: 'sent', sentAt: 35, productId: 'p2', productName: 'Beacon', recipient: { name: 'Sam Okafor', company: 'Okafor Labs' }, subject: 'queues', what: 'w', why: 'y', ask: 'a?', updatedAt: 1 },
    e3: { id: 'e3', createdAt: 20, status: 'draft', productId: 'gone', productName: 'Old Product', recipient: { name: 'Remy Cole' }, subject: 'old', what: 'w', why: 'y', ask: 'a?', updatedAt: 1 },
    e4: { id: 'e4', createdAt: 10, status: 'draft', recipient: { name: 'No Product Person' }, subject: 'none', what: 'w', why: 'y', ask: 'a?', updatedAt: 1 },
  },
  leads: { l1: { id: 'l1', name: 'Priya Nair', company: 'Northwind Logistics', role: 'Head of Platform', email: '', profileUrl: 'https://www.linkedin.com/in/priya-nair', why: 'x', product: '', goal: 'advice', list: 'Q4', notes: '', source: 'manual', createdAt: 1, updatedAt: 1 } },
  outbox: [], lastSync: 0,
};

async function open(width) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-layout-'));
  const ctx = await pw.chromium.launchPersistentContext(path.join(dir, 'profile'), { executablePath: CHROMIUM, headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const panel = await ctx.newPage(); await panel.setViewportSize({ width, height: 800 });
  const errors = []; panel.on('pageerror', e => errors.push(String(e)));
  await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`); await panel.waitForSelector('#genBtn', { state: 'attached' });
  await panel.evaluate(async lib => { await chrome.storage.local.set({ 'cold.replica': lib }); }, LIB);
  await panel.reload(); await panel.waitForSelector('#genBtn', { state: 'attached' });
  return { ctx, panel, errors };
}
const shot = async (panel, name) => { if (process.env.COLD_SHOTS) { fs.mkdirSync(process.env.COLD_SHOTS, { recursive: true }); await panel.screenshot({ path: path.join(process.env.COLD_SHOTS, `${name}.png`), fullPage: true }); } };
const go = async (panel, v) => { await panel.click(`#nav-${v}`); await panel.waitForSelector(`#view-${v}`, { state: 'visible' }); };
const noHScroll = panel => panel.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('side panel: navigation is one row with a clear active state at 320, 360 and 400 px; nothing scrolls sideways on any tab', { skip: SKIP, timeout: 240000 }, async () => {
  for (const width of WIDTHS) {
    const { ctx, panel, errors } = await open(width);
    try {
      assert.deepEqual(await panel.$$eval('.primary-nav a', a => a.map(x => x.textContent)), ['Write', 'Knowledge', 'Leads', 'History', 'Settings']);
      assert.equal(await panel.locator('.brand').count(), 1, 'Cold is named once');
      for (const v of ['compose', 'knowledge', 'leads', 'history', 'settings']) {
        await go(panel, v);
        const tops = await panel.$$eval('.primary-nav a', a => [...new Set(a.map(x => Math.round(x.getBoundingClientRect().top)))]);
        assert.equal(tops.length, 1, `${width}px ${v}: all five items on one row`);
        const clipped = await panel.$eval('.primary-nav', n => n.scrollWidth > n.clientWidth + 1);
        assert.equal(clipped, false, `${width}px ${v}: the row does not scroll or clip`);
        assert.equal(await panel.getAttribute(`#nav-${v}`, 'aria-current'), 'page');
        assert.equal(await panel.locator('.primary-nav a[aria-current="page"]').count(), 1);
        assert.equal(await noHScroll(panel), true, `${width}px ${v}: no horizontal scroll`);
        // nothing pokes into the right-hand gutter either (a box wider than its column can hide there without causing a scrollbar)
        const poking = await panel.evaluate(() => { const limit = document.documentElement.clientWidth - 8; return [...document.querySelectorAll('body *')].filter(e => e.offsetParent && !e.closest('[hidden]') && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > limit + 0.5).slice(0, 5).map(e => `${e.tagName}#${e.id}.${e.className}`); });
        assert.deepEqual(poking, [], `${width}px ${v}: nothing extends into the gutter`);
        await shot(panel, `${width}-${v}`);
      }
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
});

test('side panel: Ask Cold and Browse With Me are set up only in Settings; Write keeps just the actions', { skip: SKIP, timeout: 120000 }, async () => {
  const { ctx, panel, errors } = await open(360);
  try {
    // Write: the action row is collapsed; the configuration controls are not on this screen at all
    assert.equal(await panel.locator('#view-compose #discover').count(), 1);
    assert.equal(await panel.$eval('#discover', d => d.open), false, 'Ask Cold is collapsed until wanted');
    for (const id of ['#askEngine', '#localSetup', '#localModel', '#localRemove', '#askRemoteOn']) assert.equal(await panel.locator(`#view-compose ${id}`).count(), 0, `${id} is not on Write`);
    assert.equal(await panel.locator('#view-compose #askRun').count(), 1); assert.equal(await panel.locator('#view-compose #bwmStart').count(), 1);
    assert.equal(await panel.isVisible('#bwmBar'), false, 'no session bar before a session exists');
    await panel.click('#discover > summary'); assert.equal(await panel.isVisible('#askRun'), true); await shot(panel, '360-write-ask-open');
    // Settings: grouped, one level, no duplicates, consents and local-only wording kept
    await go(panel, 'settings');
    assert.deepEqual(await panel.$$eval('#view-settings .set-group > summary', s => s.map(x => x.textContent)), ['Writing', 'Opportunity discovery', 'Integrations', 'Privacy and local models', 'About and diagnostics']);
    assert.equal(await panel.$$eval('#view-settings .set-group', g => g.filter(x => x.open).map(x => x.id).join()), 'grp-writing', 'only Writing starts open');
    assert.equal(await panel.locator('#view-settings .set-group .set-group').count(), 0, 'one level only');
    for (const id of ['askEngine', 'localSetup', 'localModel']) assert.equal(await panel.locator(`#view-settings [id="${id}"]`).count() <= 1, true, `no duplicate ${id}`);
    assert.equal(await panel.locator('#view-settings #discoverySettings').count(), 1); assert.equal(await panel.locator('#view-settings #localSetup').count(), 1);
    assert.equal(await panel.isVisible('#localSetup'), false, 'closed groups are collapsed');
    await panel.click('#grp-privacy > summary'); assert.equal(await panel.isVisible('#localSetup'), true);
    assert.match(await panel.textContent('#grp-discovery'), /checked on this device/);
    await panel.click('#grp-integrations > summary'); await panel.click('#grp-about > summary'); await panel.click('#grp-discovery > summary');
    assert.match(await panel.textContent('#aboutLine'), /Cold extension \d/);
    assert.equal(await noHScroll(panel), true); await shot(panel, '360-settings-all-open');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('side panel: Knowledge is a short summary with collapsible sections that reveal and keep their fields; saving is unchanged', { skip: SKIP, timeout: 120000 }, async () => {
  const { ctx, panel, errors } = await open(360);
  try {
    await go(panel, 'knowledge'); await panel.waitForSelector('#kForm');
    assert.match(await panel.textContent('#kSummary'), /2 proof points \(1 approved for drafts\) · 1 technical fact · 1 prohibited phrase/);
    assert.equal(await panel.$eval('#sec-about', d => d.open), true); assert.equal(await panel.$eval('#sec-proof', d => d.open), false); assert.equal(await panel.$eval('#sec-words', d => d.open), false);
    assert.equal(await panel.isVisible('#kTech'), false, 'collapsed');
    await panel.click('#sec-words > summary'); assert.equal(await panel.isVisible('#kTech'), true); assert.equal(await panel.inputValue('#kTech'), 'Runs on ARM');
    await shot(panel, '360-knowledge');
    await panel.click('#sec-words > summary'); assert.equal(await panel.isVisible('#kTech'), false);
    // "Go to field" from the readiness list opens whatever section holds the field
    const before = await panel.inputValue('#kName');
    await panel.fill('#kName', 'Acme Edge 2'); await panel.click('#kSave'); await panel.waitForFunction(() => /Saved/.test(document.querySelector('#kForm .status').textContent));
    const saved = await panel.evaluate(async () => (await chrome.storage.local.get('cold.replica'))['cold.replica'].products.p1);
    assert.equal(saved.name, 'Acme Edge 2'); assert.deepEqual(saved.techFacts, ['Runs on ARM'], 'collapsed fields are saved unchanged'); assert.equal(saved.proof.length, 2);
    assert.notEqual(before, saved.name);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('side panel: History filters by the stable product id, handles no-product and removed-product records, and never changes them', { skip: SKIP, timeout: 120000 }, async () => {
  const { ctx, panel, errors } = await open(360);
  try {
    await go(panel, 'history'); await panel.waitForSelector('.hrow');
    const rows = () => panel.$$eval('.hrow .who', r => r.map(x => x.textContent.trim().replace(/\s+/g, ' ')));
    assert.equal((await rows()).length, 4);
    assert.deepEqual(await panel.$$eval('#histProduct option', o => o.map(x => [x.value, x.textContent])), [['all', 'All products'], ['p1', 'Acme Edge'], ['p2', 'Beacon'], ['gone', 'Old Product (removed)'], ['none', 'No product']]);
    const snapshot = () => panel.evaluate(async () => JSON.stringify((await chrome.storage.local.get('cold.replica'))['cold.replica'].emails));
    const was = await snapshot();
    await panel.selectOption('#histProduct', 'p1'); assert.deepEqual(await rows(), ['Priya Nair Head of Platform, Northwind Logistics']);
    await panel.selectOption('#histProduct', 'gone'); assert.equal((await rows()).length, 1); assert.match((await rows())[0], /Remy Cole/);
    await panel.selectOption('#histProduct', 'none'); assert.match((await rows())[0], /No Product Person/);
    await panel.selectOption('#histProduct', 'p2'); await panel.click('.hfilters .btn:has-text("Draft")');
    assert.match(await panel.textContent('#view-history'), /No drafts match your search or filter/, 'empty state, not a blank list');
    await panel.click('.hfilters .btn:has-text("All")'); await panel.selectOption('#histProduct', 'all'); assert.equal((await rows()).length, 4);
    assert.equal(await snapshot(), was, 'filtering changes nothing that is saved');
    await shot(panel, '360-history');
    assert.equal(await noHScroll(panel), true); assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
