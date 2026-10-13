// Export, restore and erase in a real browser: the hosted/standalone web library (localStorage) and the desktop library (Cold's server + SQLite).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('./helpers/env');
const SKIP = env.browserAvailable() ? false : 'Chromium or playwright-core is not available';
const AXE = path.join(__dirname, '../node_modules/axe-core/axe.min.js');

let browser, mock, web, desk, deskDir;
before(async () => {
  if (SKIP) return;
  mock = await env.startMock(); web = await env.startColdServer({ mockUrl: mock.url });
  deskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-dp-'));
  desk = await env.startColdServer({ mockUrl: mock.url, env: { COLD_DB_FILE: path.join(deskDir, 'cold.db'), COLD_SETTINGS_FILE: path.join(deskDir, 's.json') } });
  browser = await env.launch();
});
after(async () => { if (SKIP) return; await browser.close(); web.stop(); desk.stop(); mock.server.close(); });

const E = (id, o = {}) => ({ id, createdAt: 1000, status: 'draft', mode: 'email', recipient: { name: `Person ${id}`, company: 'Co', email: `${id}@co.io` }, subject: 's', what: 'w', why: 'y', ask: 'a', note: '', ...o });
const SEED = { 'cold.products': [{ id: 'p1', name: 'Acme Flow', what: 'books jobs' }], 'cold.emails': [E('e1', { status: 'sent', sentAt: 2222, note: 'call Tue' }), E('e2', { status: 'replied', repliedAt: 3333 })], 'cold.leads': [{ id: 'l1', name: 'Lead One', company: 'Acme', email: 'l1@acme.io', list: 'Q4', createdAt: 5 }], 'cold.settings': { signature: 'Randy', apiKey: 'sk-SHOULD-NOT-EXPORT' } };

async function open(server, { seed, extraSeed = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, bypassCSP: true });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  if (seed) await page.addInitScript(s => { if (!sessionStorage.getItem('__s')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); sessionStorage.setItem('__s', '1'); } }, { ...seed, ...extraSeed });
  await page.goto(server.base + '/'); await page.waitForSelector('#genBtn', { state: 'attached' });
  await page.click('#nav-settings'); await page.waitForSelector('#exportBtn2');
  return { page, context, errors, close: () => context.close() };
}
const exportFile = async page => { const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn2')]); return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') }; };
const upload = (page, name, text) => page.setInputFiles('#restoreFile', { name, mimeType: 'application/json', buffer: Buffer.from(text) });

test('web: export downloads a named, versioned file with every record and no keys, and says so', { skip: SKIP }, async () => {
  const t = await open(web, { seed: SEED });
  try {
    const { name, text } = await exportFile(t.page);
    assert.match(name, /^cold-export-\d{4}-\d{2}-\d{2}\.json$/);
    const f = JSON.parse(text);
    assert.deepEqual([f.format, f.version, f.counts], ['cold-export', 1, { products: 1, emails: 2, leads: 1 }]);
    assert.equal(f.data.emails.find(e => e.id === 'e1').sentAt, 2222); assert.equal(f.data.emails.find(e => e.id === 'e2').repliedAt, 3333);
    assert.ok(!/SHOULD-NOT-EXPORT|sk-/.test(text));
    assert.match(await t.page.textContent('#exportMsg'), /Exported 1 product, 2 drafts, 1 lead/);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('web: exporting an empty library says there is nothing to export and downloads nothing', { skip: SKIP }, async () => {
  const t = await open(web);
  try {
    let downloaded = false; t.page.on('download', () => { downloaded = true; });
    await t.page.click('#exportBtn2'); await t.page.waitForTimeout(300);
    assert.match(await t.page.textContent('#exportMsg'), /nothing to export/i); assert.equal(downloaded, false);
  } finally { await t.close(); }
});

test('web: restore reviews first; a bad file changes nothing; add mode keeps what is here; replace needs confirmation and cancelling changes nothing', { skip: SKIP, timeout: 60000 }, async () => {
  const src = await open(web, { seed: SEED }); const { text } = await exportFile(src.page); await src.close();
  const t = await open(web, { seed: { 'cold.products': [{ id: 'p9', name: 'Mine' }], 'cold.emails': [E('e1', { note: 'my own note' })] } });
  const { page } = t; const emails = () => page.evaluate(() => JSON.parse(localStorage.getItem('cold.emails') || '[]'));
  try {
    for (const [bad, re] of [['not json at all', /valid JSON/], [text.slice(0, 120), /valid JSON/], [JSON.stringify({ ...JSON.parse(text), version: 9 }), /newer Cold/]]) {
      await upload(page, 'bad.json', bad); await page.waitForSelector('#restorePanel h3:has-text("Can\'t restore")');
      assert.match(await page.textContent('#restorePanel'), re); assert.match(await page.textContent('#restorePanel'), /Nothing was changed/);
      await page.click('#restoreClose');
    }
    assert.equal((await emails())[0].note, 'my own note');
    await upload(page, 'good.json', text); await page.waitForSelector('#restoreSummary');
    assert.match(await page.textContent('#restorePlan'), /1 kept your version/);
    await page.click('#restoreGo'); await page.waitForSelector('#restoreResult');
    assert.match(await page.textContent('#restoreResult'), /read back/);
    const after = await emails(); assert.equal(after.find(e => e.id === 'e1').note, 'my own note', 'never overwritten'); assert.equal(after.find(e => e.id === 'e2').repliedAt, 3333);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('cold.products')))).length, 2);
    // replace: cancel in the confirmation changes nothing
    await page.click('#restoreClose'); await upload(page, 'good.json', text); await page.waitForSelector('#restoreSummary');
    await page.check('input[name=restoreMode][value=replace]'); await page.waitForSelector('#restorePlan:has-text("delete")');
    await page.click('#restoreGo'); await page.waitForSelector('dialog[open]');
    assert.match(await page.textContent('dialog[open]'), /downloads a backup/);
    await page.click('dialog[open] button[value=cancel]'); await page.waitForTimeout(200);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('cold.products')))).length, 2, 'cancelled: nothing deleted');
    // confirm: a backup is downloaded first, then the library matches the file
    await page.click('#restoreGo'); await page.waitForSelector('dialog[open]');
    const [bk] = await Promise.all([page.waitForEvent('download'), page.click('dialog[open] button[value=ok]')]);
    assert.match(bk.suggestedFilename(), /^cold-backup-before-restore-/);
    await page.waitForSelector('#restoreResult:has-text("matches")');
    assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('cold.products')))).map(p => p.id), ['p1']);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('web: erase needs the typed word, can be cancelled, shows what goes and what stays, removes only Cold data, and leaves nothing behind', { skip: SKIP, timeout: 60000 }, async () => {
  const t = await open(web, { seed: SEED }); const { page } = t;
  try {
    await page.evaluate(() => localStorage.setItem('someone.elses.key', 'keep'));
    await page.click('#eraseBtn'); await page.waitForSelector('#eraseDialog');
    const dlg = await page.textContent('#eraseDialog');
    assert.match(dlg, /permanently deletes/); assert.match(dlg, /1 product, 2 drafts and 1 lead/); assert.match(dlg, /Google/); assert.match(dlg, /Exports and backups/);
    assert.equal(await page.isDisabled('#eraseConfirm'), true);
    await page.fill('#eraseWord', 'nope'); assert.equal(await page.isDisabled('#eraseConfirm'), true);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('cold.emails')))).length, 2, 'cancelled: nothing erased');
    await page.click('#eraseBtn'); await page.fill('#eraseWord', 'erase'); await page.click('#eraseConfirm');
    await page.waitForSelector('#eraseResult'); assert.match(await page.textContent('#eraseResult'), /Erased 1 product, 2 drafts, 1 lead/);
    await page.waitForTimeout(900);   // past the Write form's autosave delay
    const left = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('cold.')));
    assert.deepEqual(left, [], 'no Cold key was recreated');
    assert.equal(await page.evaluate(() => localStorage.getItem('someone.elses.key')), 'keep');
    await page.reload(); await page.waitForSelector('#genBtn', { state: 'attached' }); await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('cold.'))), [], 'still empty after reload');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('web: when erasing fails, the screen says so and does not claim success', { skip: SKIP }, async () => {
  const t = await open(web, { seed: SEED }); const { page } = t;
  try {
    await page.evaluate(() => { const rm = Storage.prototype.removeItem; Storage.prototype.removeItem = function (k) { if (String(k).startsWith('cold.')) throw new Error('blocked'); return rm.call(this, k); }; });
    await page.click('#eraseBtn'); await page.fill('#eraseWord', 'erase'); await page.click('#eraseConfirm');
    await page.waitForSelector('#eraseResult'); const msg = await page.textContent('#eraseResult');
    assert.match(msg, /Don't treat it as erased/); assert.doesNotMatch(msg, /^Erased/);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('cold.emails')))).length, 2);
  } finally { await t.close(); }
});

test('desktop: export, restore and erase work on the SQLite library through the page; pairing and keys are untouched', { skip: SKIP, timeout: 90000 }, async () => {
  const t = await open(desk, { seed: SEED }); const { page } = t;
  const rows = async () => (await (await fetch(`${desk.base}/api/data`)).json());
  try {
    for (let i = 0; i < 50 && (await rows()).emails.length !== 2; i++) await page.waitForTimeout(150);   // the first run copies the browser's data into SQLite
    assert.equal((await rows()).emails.length, 2);
    const { text } = await exportFile(page); assert.equal(JSON.parse(text).source, 'desktop'); assert.ok(!/sk-SHOULD/.test(text));
    await page.click('#eraseBtn'); await page.fill('#eraseWord', 'erase'); await page.click('#eraseConfirm');
    await page.waitForSelector('#eraseResult:has-text("Erased")');
    const after = await rows(); assert.deepEqual([after.products.length, after.emails.length, after.leads.length], [0, 0, 0]);
    await page.waitForTimeout(900); const again = await rows(); assert.equal(again.emails.length, 0, 'nothing recreated');
    // restore the export we took: the desktop library is rebuilt, ids and timestamps intact
    await page.reload(); await page.waitForSelector('#genBtn', { state: 'attached' }); await page.click('#nav-settings'); await page.waitForSelector('#restoreBtn');
    await upload(page, 'again.json', text); await page.waitForSelector('#restoreGo'); await page.click('#restoreGo'); await page.waitForSelector('#restoreResult:has-text("read back")');
    const back = await rows(); assert.deepEqual(back.emails.map(e => e.id).sort(), ['e1', 'e2']); assert.equal(back.emails.find(e => e.id === 'e1').sentAt, 2222);
  } finally { await t.close(); }
});

test('the data section has no automatically detectable accessibility violations (light and dark)', { skip: SKIP, timeout: 60000 }, async () => {
  const t = await open(web, { seed: SEED }); const { page } = t;
  try {
    await page.addScriptTag({ path: AXE });
    await upload(page, 'x.json', 'nope'); await page.waitForSelector('#restorePanel h3');
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      const res = await page.evaluate(() => axe.run('#dataPortability'));
      assert.deepEqual(res.violations.map(v => `${scheme} ${v.id}: ${v.nodes.length}`), []);
    }
    await page.click('#eraseBtn'); await page.waitForSelector('#eraseDialog');
    const dlg = await page.evaluate(() => axe.run('#eraseDialog')); assert.deepEqual(dlg.violations.map(v => v.id), []);
  } finally { await t.close(); }
});
