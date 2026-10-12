// Standalone entry paths: each surface must be usable on its own, with no other Cold surface installed, running or paired.
// Real server, real bundle, real browser; the model is a MOCK (canned JSON), so this proves plumbing and independence, not output quality.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const env = require("./helpers/env");

const SKIP = env.browserAvailable() ? false : "Chromium or playwright-core is not available";
let browser, mock;
before(async () => { if (SKIP) return; mock = await env.startMock(); browser = await env.launch(); });
after(async () => { if (SKIP) return; await browser.close(); mock.server.close(); });

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cold-solo-"));
const NO_KEY = { ANTHROPIC_API_KEY: "" };

/** A fresh browser profile pointed at `server`. Records every request so a test can show nothing else was contacted. */
async function open(server, { seed } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [], hosts = new Set();
  page.on("pageerror", e => errors.push(String(e)));
  page.on("request", r => { try { hosts.add(new URL(r.url()).host); } catch { /* data: urls etc. */ } });
  if (seed) await page.addInitScript(s => { if (!sessionStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); sessionStorage.setItem("__seeded", "1"); } }, seed);
  await page.goto(server.base + "/");
  await page.waitForSelector("#genBtn", { state: "attached" });
  await page.waitForFunction(() => document.querySelector("#genHint").textContent.length > 0 && !/Connecting/.test(document.querySelector("#genHint").textContent));
  return { page, context, errors, hosts, close: () => context.close() };
}
const go = async (page, v) => { await page.click(`#nav-${v}`); await page.waitForSelector(`#view-${v}`, { state: "visible" }); };
const addProductInKnowledge = async (page, name = "Solo Co") => {
  await go(page, "knowledge"); await page.click("#emptyAdd");
  await page.fill("#kName", name); await page.fill("#kWhat", `${name} turns a signup into a first booked job for plumbers.`);
  await page.click("#kSave"); await page.waitForFunction(() => /Saved/.test(document.querySelector(".status")?.textContent || ""));
};
const draft = async page => {
  await go(page, "compose");
  await page.fill("#rName", "Sam Ortiz"); await page.fill("#rCompany", "TrialCo"); await page.fill("#rWhy", "Wrote that most trial users stall before inviting a teammate.");
  await page.click("#genBtn"); await page.waitForSelector("#eSubject");
};
const pageText = page => page.evaluate(() => document.body.innerText);
const NO_INSTALL_NAG = /install the (browser )?extension|download the (desktop|extension)|you need the (desktop|extension)/i;

test("web only: configure nothing locally, add product knowledge, draft, edit, reload, and the work is still there", { skip: SKIP, timeout: 90000 }, async () => {
  // a hosted-style deployment: a server-side provider and no database, no desktop app, no extension, no pairing
  const srv = await env.startColdServer({ mockUrl: mock.url });
  const t = await open(srv); const { page } = t;
  try {
    assert.doesNotMatch(await pageText(page), NO_INSTALL_NAG);
    await addProductInKnowledge(page);
    await draft(page);
    await page.fill("#eSubject", "my edited subject");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.emails") || "[]")[0]?.subject === "my edited subject");
    await go(page, "history"); assert.equal(await page.locator(".hrow").count(), 1);
    // close and reopen: products, draft and its edit are still there
    await page.reload(); await page.waitForSelector("#genBtn", { state: "attached" });
    await go(page, "history"); assert.equal(await page.locator(".hrow").count(), 1);
    assert.match(await page.textContent(".hrow"), /my edited subject/);
    await go(page, "knowledge"); assert.match(await page.textContent("#view-knowledge"), /Solo Co/);
    // Settings: keys stay on the server; the desktop app is offered as optional, never required
    await go(page, "settings");
    assert.equal(await page.locator("#setKey").count(), 0, "no provider key field in a hosted page");
    assert.match(await page.textContent("#view-settings"), /Optional\. Your products and drafts already work in this browser/);
    // nothing but this server was ever contacted
    assert.deepEqual([...t.hosts], [new URL(srv.base).host]);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); srv.stop(); }
});

test("web only, server without a provider: says who must add one, and everything except writing still works", { skip: SKIP, timeout: 90000 }, async () => {
  const srv = await env.startColdServer({ mockUrl: mock.url, env: NO_KEY });
  const t = await open(srv); const { page } = t;
  try {
    assert.match(await page.textContent("#genHint"), /whoever runs it adds a provider key on the server/);
    assert.equal(await page.isDisabled("#genBtn"), true);
    await addProductInKnowledge(page, "Offline Writer");
    await page.reload(); await page.waitForSelector("#genBtn", { state: "attached" });
    await go(page, "knowledge"); assert.match(await page.textContent("#view-knowledge"), /Offline Writer/);
    await go(page, "history"); assert.equal(await page.locator(".hrow").count(), 0);
    await go(page, "settings"); assert.match(await page.textContent("#view-settings"), /whoever runs this site adds a provider key on the server/);
    assert.match(await page.textContent("#view-settings"), /Products, drafts and History work without either/);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); srv.stop(); }
});

test("web with a pairing to a desktop app that is not running: drafting, saving and history are unaffected, and the page says what is wrong", { skip: SKIP, timeout: 90000 }, async () => {
  const dead = await freePort();
  const seed = { "cold.hub": { origin: `http://127.0.0.1:${dead}`, token: "stale-code" } };
  const withModel = await env.startColdServer({ mockUrl: mock.url });
  const t = await open(withModel, { seed }); const { page } = t;
  try {
    await addProductInKnowledge(page);
    await draft(page);
    await go(page, "history"); assert.equal(await page.locator(".hrow").count(), 1);
    await go(page, "settings");
    await page.waitForFunction(() => /The Cold desktop app isn't running/.test(document.querySelector("#view-settings").innerText));
    assert.match(await page.textContent("#view-settings"), /Cold keeps working from the copy saved here/);
    assert.deepEqual(t.errors.filter(e => !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(e)), []);
  } finally { await t.close(); withModel.stop(); }
  // and when the web server has no model either, the page explains BOTH facts instead of staying silent
  const noModel = await env.startColdServer({ mockUrl: mock.url, env: NO_KEY });
  const t2 = await open(noModel, { seed }); 
  try {
    await t2.page.waitForFunction(() => /paired isn't running/.test(document.querySelector("#genHint").textContent), null, { timeout: 15000 });
    assert.match(await t2.page.textContent("#genHint"), /Open the app, or ask whoever runs this site to add a provider/);
    await addProductInKnowledge(t2.page, "Still Works");
    await go(t2.page, "knowledge"); assert.match(await t2.page.textContent("#view-knowledge"), /Still Works/);
  } finally { await t2.close(); noModel.stop(); }
});

test("desktop only: first run with no provider, set one up in Settings, add knowledge, draft, close and reopen, nothing lost; no extension involved", { skip: SKIP, timeout: 120000 }, async () => {
  const { createDb } = require("../lib/db");
  const dir = tmp(), port = await freePort();
  const start = () => env.startColdServer({ mockUrl: mock.url, port, env: { ...NO_KEY, COLD_DB_FILE: path.join(dir, "cold.db"), COLD_SETTINGS_FILE: path.join(dir, "settings.json") } });
  let hub = await start();
  let t = await open(hub); let page = t.page;
  try {
    // first run: no provider, and the page says where to fix that. Nothing mentions installing anything.
    assert.match(await page.textContent("#genHint"), /No provider is set up yet\. Open Settings/);
    assert.equal(await page.isDisabled("#genBtn"), true);
    await go(page, "settings"); await page.waitForSelector("#setProvider");
    assert.doesNotMatch(await pageText(page), NO_INSTALL_NAG);
    assert.match(await page.textContent("#view-settings"), /Optional: Cold works fully without the extension or any web app/);
    await page.selectOption("#setProvider", "anthropic"); await page.fill("#setKey", "mock-key");
    await page.click('button:has-text("Save and use this provider")');
    await page.waitForFunction(() => /Cold will write with/.test(document.querySelector("#setModelMsg ~ .hint, .hint[role=status]:last-of-type")?.textContent || document.body.innerText));
    await go(page, "compose");
    await page.waitForFunction(() => !document.getElementById("genBtn").disabled);
    // knowledge, draft, edit
    await addProductInKnowledge(page, "Desk Co");
    await draft(page);
    await page.fill("#eSubject", "desktop edit");
    const db = createDb(path.join(dir, "cold.db"));
    try {
      for (let i = 0; i < 50 && db.snapshot().emails[0]?.subject !== "desktop edit"; i++) await new Promise(r => setTimeout(r, 100));
      assert.deepEqual([db.snapshot().products.map(p => p.name), db.snapshot().emails.map(e => e.subject)], [["Desk Co"], ["desktop edit"]]);
    } finally { db.close(); }
    await go(page, "history"); await page.click(".hrow .hMarkSent");
    await page.waitForFunction(() => /Marked sent/.test(document.querySelector(".hrow .chip").textContent));
    assert.deepEqual(t.errors, []);
    // quit the app and start it again on the same data: provider, product, draft and status are all still there
    await t.close(); hub.stop(); await new Promise(r => setTimeout(r, 300));
    hub = await start(); t = await open(hub); page = t.page;
    assert.equal(await page.isDisabled("#genBtn"), false, "the saved provider survives a restart");
    await go(page, "knowledge"); assert.match(await page.textContent("#view-knowledge"), /Desk Co/);
    await go(page, "history"); assert.equal(await page.locator(".hrow").count(), 1);
    assert.match(await page.textContent(".hrow"), /desktop edit/); assert.match(await page.textContent(".hrow .chip"), /Marked sent/);
    // the pairing code exists but nothing needs it; no pairing is established and nothing nags about it
    assert.doesNotMatch(await pageText(page), NO_INSTALL_NAG);
  } finally { await t.close(); hub.stop(); }
});
