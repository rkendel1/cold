// First-run checklist (CX-001, the part that is automatable). It does NOT establish the "five unassisted users reach a first draft in 10 minutes" target:
// that is a human validation requirement (docs/audit/10-launch-readiness-plan.md, B1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const env = require('./helpers/env');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);
const SKIP = env.browserAvailable() ? false : 'Chromium or playwright-core is not available';
const AXE = path.join(__dirname, '../node_modules/axe-core/axe.min.js');

// ---- domain rules (no browser) ----
test('first-run rules: every step is derived from real state; nothing is stored as completed', async () => {
  const R = await load('src/domain/firstRun.js');
  const none = { products: [], emails: [], leads: [] };
  assert.deepEqual(R.firstRunSteps({ ...none, sampleState: 'noconfig' }).map(s => [s.id, s.done, s.optional]), [['model', false, false], ['product', false, false], ['draft', false, false], ['leads', false, true]]);
  assert.equal(R.firstRunSteps({ ...none, sampleState: 'ready' })[0].done, true);
  assert.equal(R.firstRunSteps({ ...none, sampleState: 'pending' })[0].checking, true);
  assert.equal(R.firstRunSteps({ products: [{ id: 'p', name: '  ' }] })[1].done, false, 'a nameless product is not "added"');
  assert.equal(R.firstRunSteps({ products: [{ id: 'p', name: 'Acme' }] })[1].done, true);
  const d = e => R.firstRunSteps({ emails: [e] })[2].done;
  assert.equal(d({ id: 'e', status: 'draft' }), false, 'a generated draft alone is not "copied"');
  assert.equal(d({ id: 'e', status: 'draft', handoffs: [{ at: 1, how: 'copy' }] }), true);
  assert.equal(d({ id: 'e', status: 'draft', handoffs: [{ at: 1, how: 'open' }] }), true);
  assert.equal(d({ id: 'e', status: 'sent' }), true);
  assert.equal(R.requiredDone(R.firstRunSteps({ products: [{ name: 'A' }], emails: [{ handoffs: [{ how: 'copy' }] }], sampleState: 'ready' })), true, 'leads are optional');
  assert.equal(R.requiredDone(R.firstRunSteps({ products: [{ name: 'A' }], emails: [{ handoffs: [{ how: 'copy' }] }], sampleState: 'noconfig' })), false);
});
test('first-run rules: shown for someone who has not used Cold yet; established installs, dismissal and not-yet-loaded never show it; nothing is written to decide', async () => {
  const R = await load('src/domain/firstRun.js');
  const steps = (o = {}) => R.firstRunSteps({ products: [], emails: [], leads: [], sampleState: 'ready', ...o });
  const show = (o = {}) => R.shouldShowFirstRun({ firstRun: '', ready: true, steps: steps(o.steps), established: false, sessionStarted: false, ...o, steps: steps(o.steps) });
  assert.equal(show(), true, 'empty install');
  assert.equal(show({ steps: { products: [{ name: 'A' }] } }), true, 'part-way (a product saved, nothing copied) still shows after a reload');
  assert.equal(show({ ready: false }), false, 'not before the library has loaded');
  assert.equal(show({ firstRun: 'dismissed' }), false, 'dismissal is permanent');
  assert.equal(show({ established: true }), false);
  const done = { products: [{ name: 'A' }], emails: [{ handoffs: [{ how: 'copy' }] }] };
  assert.equal(show({ steps: done }), false, 'all required steps done: gone after a reload');
  assert.equal(show({ steps: done, sessionStarted: true }), true, 'but the session that watched them get done sees "You\'re set up"');
  assert.equal(show({ steps: done, sessionStarted: true, firstRun: 'dismissed' }), false);
  const est = e => R.isEstablished({ emails: e });
  assert.equal(est([]), false); assert.equal(est([{ status: 'draft' }, { status: 'draft' }]), false);
  assert.equal(est([{ status: 'sent' }]), true); assert.equal(est([{ status: 'replied' }]), true); assert.equal(est([{}, {}, {}]), true, 'three or more drafts');
  assert.deepEqual(['dismissed', 'active', '', 'x', null, 5].map(R.normalizeFirstRun), ['dismissed', '', '', '', '', ''], 'only "dismissed" is a stored value');
});

// ---- browser ----
let browser, mock, hosted, noKey, desktopLike, withGoogle, settingsDir;
before(async () => {
  if (SKIP) return;
  mock = await env.startMock();
  hosted = await env.startColdServer({ mockUrl: mock.url });                       // a model is configured
  noKey = await env.startColdServer({ mockUrl: mock.url, env: { ANTHROPIC_API_KEY: '' } });   // hosted, no model
  settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-fr-'));
  desktopLike = await env.startColdServer({ mockUrl: mock.url, env: { ANTHROPIC_API_KEY: '', COLD_SETTINGS_FILE: path.join(settingsDir, 'settings.json') } });   // Settings exists, no model yet
  withGoogle = await env.startColdServer({ mockUrl: mock.url, env: { COLD_GOOGLE_CLIENT_ID: 'x' } });
  browser = await env.launch();
});
after(async () => { if (SKIP) return; await browser.close(); for (const s of [hosted, noKey, desktopLike, withGoogle]) s.stop(); mock.server.close(); });

async function open(server, { seed, viewport = { width: 1280, height: 900 }, bypassCSP = false } = {}) {
  const context = await browser.newContext({ viewport, bypassCSP, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  if (seed) await page.addInitScript(s => { if (!sessionStorage.getItem('__s')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); sessionStorage.setItem('__s', '1'); } }, seed);
  await page.goto(server.base + '/'); await page.waitForSelector('#genBtn', { state: 'attached' });
  await page.waitForFunction(() => document.querySelector('#genHint').textContent.length > 0 && !/Connecting/.test(document.querySelector('#genHint').textContent));
  return { page, context, errors, close: () => context.close() };
}
const ls = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem(k)), key);
const steps = page => page.$$eval('#firstRun li', li => li.map(l => [l.dataset.step, l.dataset.done, l.querySelector('.chip').textContent.replace(/^[✓!•✕]/, '').trim()]));

test('first use: a genuinely empty install shows the checklist with real state, no sample data, and remembers only that it started', { skip: SKIP }, async () => {
  const t = await open(hosted); const { page } = t;
  try {
    await page.waitForSelector('#firstRun', { state: 'visible' });
    assert.deepEqual(await steps(page), [['model', 'true', 'Done'], ['product', 'false', 'To do'], ['draft', 'false', 'To do'], ['leads', 'false', 'Optional']]);
    assert.equal(await page.getAttribute('#firstRun', 'aria-labelledby'), 'firstRun-title');
    assert.equal(await page.locator('#firstRun ol').count(), 1);
    // honest: nothing fabricated
    for (const k of ['cold.products', 'cold.emails', 'cold.leads']) assert.deepEqual((await ls(page, k)) || [], [], `${k} is still empty`);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => localStorage.getItem('cold.settings')), null, 'merely loading the page wrote nothing (a settings write can rewrite every stored list)');
    assert.equal(await page.evaluate(() => localStorage.getItem('cold.products')), null);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('progress: steps complete only when the real action happened (a failed generation completes nothing); copying records the handoff; then "You\'re set up"', { skip: SKIP, timeout: 60000 }, async () => {
  mock.failNext = 1;
  const t = await open(hosted); const { page } = t;
  try {
    await page.waitForSelector('#firstRun', { state: 'visible' });
    const prod = async () => (await steps(page)).find(s => s[0] === 'product')[1];
    await page.fill('#rName', 'Sam Ortiz'); await page.fill('#rCompany', 'TrialCo'); await page.fill('#rWhy', 'Wrote that trial users stall before inviting a teammate');
    await page.fill('#pName', 'Acme Flow'); await page.fill('#pWhat', 'Acme Flow turns a signup into a first booked job for plumbers.');
    await page.click('#genBtn'); await page.locator('#genError').waitFor();
    assert.equal((await steps(page)).find(s => s[0] === 'draft')[1], 'false', 'a failed generation completes nothing');
    assert.deepEqual((await ls(page, 'cold.emails')) || [], []);
    await page.locator('#genError').getByRole('button', { name: 'Try again' }).click(); await page.waitForSelector('#eSubject');
    assert.equal((await steps(page)).find(s => s[0] === 'draft')[1], 'false', 'a generated draft is not yet "copied"');
    await page.waitForFunction(() => document.querySelector('#firstRun li[data-step=product]').dataset.done === 'true');
    await page.click('#copyEmail');
    await page.waitForFunction(() => document.querySelector('#firstRun li[data-step=draft]').dataset.done === 'true');
    assert.match(await page.textContent('#firstRun-title'), /You're set up/);
    assert.equal((await ls(page, 'cold.emails'))[0].handoffs[0].how, 'copy', 'derived from the recorded handoff');
    assert.equal(await page.evaluate(() => localStorage.getItem('cold.settings')), null, 'completing steps wrote no checklist state at all: they are derived');
    assert.equal((await steps(page)).find(s => s[0] === 'leads')[1], 'false', 'leads stay optional and un-done');
    // a new page session after everything required is done: nothing left to show, and nothing was ever stored about it
    await page.reload(); await page.waitForSelector('#genBtn', { state: 'attached' }); await page.waitForTimeout(400);
    assert.equal(await page.locator('#firstRun').isVisible(), false);
  } finally { await t.close(); }
});

test('dismissal: Hide removes it, returns focus to the page, and it never comes back (even with more data or after reload)', { skip: SKIP }, async () => {
  const t = await open(hosted); const { page } = t;
  try {
    await page.waitForSelector('#firstRun', { state: 'visible' });
    await page.click('#firstRunDismiss');
    assert.equal(await page.locator('#firstRun').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'compose-title', 'focus moves somewhere sensible, not to a removed button');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('cold.settings')).firstRun === 'dismissed');
    await page.reload(); await page.waitForSelector('#genBtn', { state: 'attached' }); await page.waitForTimeout(400);
    assert.equal(await page.locator('#firstRun').isVisible(), false, 'not shown again after reload');
    await page.click('#nav-knowledge'); await page.waitForSelector('#emptyAdd'); await page.click('#nav-compose'); await page.waitForTimeout(200);
    assert.equal(await page.locator('#firstRun').isVisible(), false);
  } finally { await t.close(); }
});

test('no model on a hosted site: the model step says so and who can fix it, offers no control, and the checklist never pretends the model is ready', { skip: SKIP }, async () => {
  const t = await open(noKey, { viewport: { width: 375, height: 700 } }); const { page } = t;
  try {
    await page.waitForSelector('#firstRun', { state: 'visible' });
    const model = page.locator('#firstRun li[data-step=model]');
    assert.equal(await model.getAttribute('data-done'), 'false'); assert.match(await model.textContent(), /This site has no model connected\. Only whoever runs it can add one\. You can use the Cold desktop app instead\./);
    assert.equal(await model.locator('button').count(), 0, 'a hosted visitor gets no control for a server-owned setting');
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal overflow at 375 px');
    assert.deepEqual(t.errors.filter(e => !/Failed to load resource/.test(e)), []);
  } finally { await t.close(); }
});

test('where Settings exists (desktop, local install): the model step offers Open Settings and it goes there', { skip: SKIP }, async () => {
  const t = await open(desktopLike); const { page } = t;
  try {
    await page.waitForSelector('#firstRun', { state: 'visible' });
    const model = page.locator('#firstRun li[data-step=model]');
    assert.match(await model.textContent(), /Choose a provider \(or a model on your computer\) in Settings/);
    await model.getByRole('button', { name: 'Open Settings' }).click(); await page.waitForSelector('#view-settings', { state: 'visible' });
  } finally { await t.close(); }
});

test('part-way progress survives a reload (derived from the saved product); an established install never gets the checklist; Google Sheets is never part of it', { skip: SKIP }, async () => {
  const P = { id: 'p1', name: 'Acme', order: 0, what: 'x', audience: '', problem: '', proofs: [], facts: [], approved: [], banned: [] };
  const E = (o = {}) => ({ id: 'e' + Math.random().toString(36).slice(2, 6), createdAt: 1, status: 'draft', mode: 'email', recipient: { name: 'A' }, subject: 's', what: 'w', why: 'y', ask: 'a', ...o });
  const part = await open(hosted, { seed: { 'cold.products': [P] } });
  try {
    await part.page.waitForSelector('#firstRun', { state: 'visible' });
    assert.deepEqual((await steps(part.page)).map(s => s[2]), ['Done', 'Done', 'To do', 'Optional'], 'a saved product is Done; the rest is still to do');
    assert.equal(await part.page.evaluate(() => localStorage.getItem('cold.settings')), null, 'and nothing was written to remember it');
  } finally { await part.close(); }
  for (const emails of [[E({ status: 'sent' })], [E(), E(), E()]]) {
    const est = await open(hosted, { seed: { 'cold.products': [P], 'cold.emails': emails } });
    try { await est.page.waitForTimeout(500); assert.equal(await est.page.locator('#firstRun').isVisible(), false, `established (${emails.length} draft(s), first is ${emails[0].status})`); } finally { await est.close(); }
  }
  const g = await open(withGoogle);   // Google Sheets is configured on this server
  try {
    await g.page.waitForSelector('#firstRun', { state: 'visible' });
    assert.doesNotMatch(await g.page.textContent('#firstRun'), /google|sheets/i, 'the optional integration is not a step');
    assert.equal(await g.page.locator('#firstRun li').count(), 4);
  } finally { await g.close(); }
});

test('accessibility: axe finds no WCAG A/AA violations on the checklist (light and dark; no-model and ready states), steps read as words not colour', { skip: SKIP, timeout: 60000 }, async () => {
  for (const [server, scheme] of [[hosted, 'light'], [noKey, 'dark']]) {
    const context = await browser.newContext({ colorScheme: scheme, bypassCSP: true }); const page = await context.newPage();
    await page.goto(server.base + '/'); await page.waitForSelector('#firstRun', { state: 'visible' });
    await page.addScriptTag({ path: AXE });
    const r = await page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }));
    assert.deepEqual(r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(' | ')}`), [], `axe (${scheme}, ${server === hosted ? 'model ready' : 'no model'})`);
    for (const li of await page.$$('#firstRun li')) assert.match((await (await li.$('.chip')).textContent()).replace(/^[✓!•✕]/, ''), /^(Done|To do|Optional)$/);
    await context.close();
  }
});
