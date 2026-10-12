// Device-local data contract, tested at the network and log level: the library (products, drafts, notes, statuses, sent text)
// is stored on the device and does not travel to any server except (a) the model provider, for the prompt that is being
// generated, and (b) a desktop app the user has explicitly paired. Real servers and bundle, real browser; the model is a MOCK.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const env = require("./helpers/env");

const SKIP = env.browserAvailable() ? false : "Chromium or playwright-core is not available";
let browser, mock;
before(async () => { if (SKIP) return; mock = await env.startMock(); browser = await env.launch(); });
after(async () => { if (SKIP) return; await browser.close(); mock.server.close(); });
beforeEachReset();
function beforeEachReset() { require("node:test").beforeEach(() => { if (!SKIP) { mock.prompts.length = 0; mock.failNext = 0; } }); }

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cold-priv-"));

// Distinctive strings that must stay on the device unless they are needed for the draft being written.
const M = { otherProduct: "ZEBRAFACT-other-product-secret", note: "NOTE-private-negotiation-detail", email: "private.person@elsewhere.example", otherRecipient: "Quentin Hidden", sentText: "SENTTEXT-what-i-actually-sent", signature: "SIGNOFF-Randy-the-Sender", internalProof: "INTERNALONLY-48000-dollars" };
const PRODUCT = { id: "p1", name: "Acme Flow", order: 0, what: "Acme Flow turns a signup into a first booked job for plumbers.", who: "Plumbing shops", problem: "Trials stall before a teammate is invited.",
  proof: [{ id: "pr1", claim: "Cut trial stall for one design partner", evidence: "Pilot, March", type: "Customer", strength: "High", external: true }, { id: "pr2", claim: M.internalProof, evidence: "Stripe export", type: "Revenue / growth", strength: "High", external: false }], techFacts: [], approved: [], dontSay: [] };
const OTHER = { id: "p2", name: "Beacon", order: 1, what: M.otherProduct, proof: [], techFacts: [], approved: [], dontSay: [] };
const OLD = { id: "old1", createdAt: 5, status: "sent", sentAt: 9, note: M.note, productId: "p2", productName: "Beacon", recipient: { name: M.otherRecipient, company: "HiddenCo", email: M.email }, subject: "old subject", what: "old", why: "old", ask: "old?", sentCopy: { subject: "s", text: M.sentText, at: 9 } };
const SEED = { "cold.products": [PRODUCT, OTHER], "cold.emails": [OLD], "cold.settings": { signature: M.signature } };

async function open(base, { seed = SEED } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const requests = [], errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("request", r => { const u = new URL(r.url()); requests.push({ host: u.host, path: u.pathname, method: r.method(), body: r.postData() || "" }); });
  if (seed) await page.addInitScript(s => { if (!sessionStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); sessionStorage.setItem("__seeded", "1"); } }, seed);
  await page.goto(base + "/");
  await page.waitForSelector("#genBtn", { state: "attached" });
  await page.waitForFunction(() => document.querySelector("#genHint").textContent.length > 0 && !/Connecting/.test(document.querySelector("#genHint").textContent));
  return { page, context, requests, errors, close: () => context.close() };
}
const go = async (page, v) => { await page.click(`#nav-${v}`); await page.waitForSelector(`#view-${v}`, { state: "visible" }); };
const generate = async page => { await go(page, "compose"); await page.selectOption("#rProduct", "p1"); await page.fill("#rName", "Sam Ortiz"); await page.fill("#rCompany", "TrialCo"); await page.fill("#rWhy", "Wrote that most trial users stall before inviting a teammate."); await page.click("#genBtn"); await page.waitForSelector("#eSubject"); };

test("web: saving, editing, deleting and reopening the library sends nothing to any server and needs no account", { skip: SKIP, timeout: 90000 }, async () => {
  const srv = await env.startColdServer({ mockUrl: mock.url });
  const t = await open(srv.base); const { page } = t;
  try {
    // create, edit, annotate, change status, delete: every kind of write the library supports
    await go(page, "knowledge"); await page.selectOption("#kProduct", "p2"); await page.fill("#kWhat", M.otherProduct + " edited");
    await page.click("#kSave"); await page.waitForFunction(() => /Saved/.test(document.querySelector(".status")?.textContent || ""));
    await go(page, "history"); await page.click(".hrow .hToggle"); await page.fill(".hNote", M.note + " v2");
    await page.waitForFunction(n => JSON.parse(localStorage.getItem("cold.emails"))[0].note === n, M.note + " v2");
    await page.locator(".hrow select.hStatus").selectOption("replied");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.emails"))[0].status === "replied");
    await page.reload(); await page.waitForSelector("#genBtn", { state: "attached" }); await go(page, "history");
    assert.match(await page.textContent(".hrow"), /Replied|Reply recorded/);
    await page.click(".hrow button:has-text('Delete')"); await page.click("button:has-text('Delete draft')");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.emails")).length === 0);
    // the only requests ever made: the page's own static files and the server's config. No write, no library content.
    const own = new URL(srv.base).host;
    assert.ok(t.requests.every(r => r.host === own), "no other host was contacted: " + [...new Set(t.requests.map(r => r.host))]);
    assert.deepEqual(t.requests.filter(r => r.method !== "GET"), [], "no request wrote anything to a server");
    assert.deepEqual([...new Set(t.requests.map(r => r.path))].filter(p => p.startsWith("/api/")).sort(), ["/api/config"]);
    // a hosted server cannot even be asked to keep a library: there is no database behind it
    for (const method of ["GET", "PUT", "POST"]) {
      const r = await fetch(`${srv.base}/api/data${method === "PUT" ? "/emails/x" : ""}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      assert.equal(r.status, 404, `${method} /api/data on a database-less server`);
    }
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); srv.stop(); }
});

test("hosted web generation: only /api/generate carries content, and only what this draft needs", { skip: SKIP, timeout: 90000 }, async () => {
  const srv = await env.startColdServer({ mockUrl: mock.url });
  const t = await open(srv.base); const { page } = t;
  try {
    await generate(page);
    const own = new URL(srv.base).host;
    const posts = t.requests.filter(r => r.method === "POST");
    assert.ok(posts.length >= 2 && posts.every(r => r.host === own && r.path === "/api/generate"), "generation is the only write, and it goes through this server (which holds the provider key)");
    for (const r of posts) assert.deepEqual(Object.keys(JSON.parse(r.body)).sort().filter(k => k !== "model"), ["prompt"], "the body is just the prompt (and an optional model id)");
    // what the provider sees: the product and recipient for THIS draft...
    const seen = mock.prompts.join("\n");
    assert.match(seen, /Acme Flow turns a signup/); assert.match(seen, /Sam Ortiz/); assert.match(seen, /TrialCo/);
    // ...and nothing else from the library
    for (const [name, secret] of Object.entries(M)) assert.ok(!seen.includes(secret), `the provider never received: ${name}`);
    // the rest of the library still never left the page: no non-generate request carries any of it
    for (const r of t.requests.filter(r => r.path !== "/api/generate")) for (const secret of Object.values(M)) assert.ok(!r.body.includes(secret));
    // the app says so in plain words: stored here, but the prompt goes through this site's server to the provider
    await go(page, "settings");
    assert.match(await page.textContent("#dataLine"), /saved in this browser only/);
    assert.match(await page.textContent("#modelFlowLine"), /goes through this site's server to .*doesn't keep it.*Your other products, drafts and notes are not sent/);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); srv.stop(); }
});

test("server logs and errors never contain prompts or library content, even when the provider fails", { skip: SKIP, timeout: 90000 }, async () => {
  const port = await freePort(), dir = tmp();
  let log = "";
  const child = spawn("node", ["server.js"], { cwd: env.ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "mock-key", ANTHROPIC_BASE_URL: mock.url, PORT: String(port), HOST: "127.0.0.1", COLD_ACCESS_TOKEN: "", COLD_RATE_LIMIT_PER_MIN: "100000", HOME: dir } });
  child.stdout.on("data", d => { log += d; }); child.stderr.on("data", d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/config"); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const t = await open(base); const { page } = t;
  try {
    await generate(page);                                                   // a normal generation
    mock.failNext = 5;                                                      // then provider failures
    await go(page, "compose"); await page.click("#genBtn");
    await page.waitForSelector(".notice, [role=alert], .err, #errorBox", { timeout: 15000 }).catch(() => {});
    // malformed and oversized requests are rejected without being echoed or recorded
    for (const body of ["not json " + M.note, JSON.stringify({ prompt: M.note.repeat(200000) })]) {
      const r = await fetch(base + "/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body });
      assert.ok(r.status >= 400); assert.ok(!(await r.text()).includes(M.note), "error responses do not echo the request");
    }
    await new Promise(r => setTimeout(r, 300));
    assert.ok(mock.prompts.length >= 2);
    for (const secret of [...Object.values(M), "Sam Ortiz", "TrialCo", "Acme Flow turns"]) assert.ok(!log.includes(secret), `server output never contains: ${secret}`);
    assert.match(log, /Cold is running/);                                   // the only output is the startup banner
    assert.ok(log.split("\n").filter(Boolean).length <= 3, "no per-request logging: " + log);
    // and it wrote nothing to disk: the throwaway HOME is empty
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { await t.close(); child.kill(); }
});

test("pairing is the only cross-surface path: before it, the paired app receives nothing; after it, only that app does", { skip: SKIP, timeout: 120000 }, async () => {
  const { createDb } = require("../lib/db");
  const dir = tmp(), hubPort = await freePort();
  const hub = await env.startColdServer({ mockUrl: mock.url, port: hubPort, env: { COLD_DB_FILE: path.join(dir, "cold.db"), COLD_SETTINGS_FILE: path.join(dir, "settings.json") } });
  const hubDb = createDb(path.join(dir, "cold.db"));
  const web = await env.startColdServer({ mockUrl: mock.url });
  const t = await open(web.base); const { page } = t;
  try {
    await go(page, "knowledge"); await page.selectOption("#kProduct", "p2"); await page.fill("#kWhat", M.otherProduct + " pre-pairing");
    await page.click("#kSave"); await page.waitForFunction(() => /Saved/.test(document.querySelector(".status")?.textContent || ""));
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(t.requests.filter(r => r.host.endsWith(`:${hubPort}`)).length, 0, "an unpaired page never contacts the desktop app, even though it is running");
    assert.deepEqual([hubDb.snapshot().products.length, hubDb.snapshot().emails.length], [0, 0]);
    // explicit pairing: the user must supply the app's address and its code, and the app must allow this page
    hubDb.setWebOrigins([new URL(web.base).origin]);
    await go(page, "settings");
    await page.fill("#hubAddress", `127.0.0.1:${hubPort}`); await page.fill("#hubCode", hubDb.extensionToken()); await page.click("#hubConnect");
    await page.waitForFunction(() => /Connected/.test(document.querySelector("#view-settings").innerText), null, { timeout: 20000 });
    for (let i = 0; i < 100 && hubDb.snapshot().products.length < 2; i++) await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(hubDb.snapshot().products.map(p => p.id).sort(), ["p1", "p2"]);
    // after pairing, library traffic goes to the paired app and nowhere else; the web server still sees no library writes
    const hosts = new Set(t.requests.map(r => r.host));
    assert.deepEqual([...hosts].sort(), [new URL(web.base).host, `127.0.0.1:${hubPort}`].sort());
    assert.deepEqual(t.requests.filter(r => r.host === new URL(web.base).host && r.method !== "GET"), []);
    // disconnecting stops it
    const before = t.requests.length;
    await page.click("#hubDisconnect"); await new Promise(r => setTimeout(r, 300));
    const mark = t.requests.length;
    await go(page, "knowledge"); await page.fill("#kWhat", M.otherProduct + " after disconnect"); await page.click("#kSave");
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(t.requests.slice(mark).filter(r => r.host.endsWith(`:${hubPort}`)).length, 0);
    assert.ok(before <= mark);
  } finally { await t.close(); hubDb.close(); hub.stop(); web.stop(); }
});

test("desktop: the library lives in one local SQLite file; the only outbound request is the model call, with just the draft's context", { skip: SKIP, timeout: 120000 }, async () => {
  const { createDb } = require("../lib/db");
  const dir = tmp(), port = await freePort();
  const hub = await env.startColdServer({ mockUrl: mock.url, port, env: { COLD_DB_FILE: path.join(dir, "cold.db"), COLD_SETTINGS_FILE: path.join(dir, "settings.json") } });
  const t = await open(hub.base, { seed: null }); const { page } = t;
  const db = createDb(path.join(dir, "cold.db"));
  try {
    db.put("products", "p1", { ...PRODUCT, updatedAt: 1 }); db.put("products", "p2", { ...OTHER, updatedAt: 1 }); db.put("emails", "old1", { ...OLD, updatedAt: 1 });
    await page.reload(); await page.waitForSelector("#genBtn", { state: "attached" });
    await generate(page);
    const seen = mock.prompts.join("\n");
    for (const [name, secret] of Object.entries(M)) if (name !== "signature") assert.ok(!seen.includes(secret), `the provider never received: ${name}`);
    for (let i = 0; i < 50 && db.snapshot().emails.length < 2; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(db.snapshot().emails.length, 2);
    assert.ok(t.requests.every(r => r.host === new URL(hub.base).host), "the page talks only to the local app");
    assert.deepEqual(fs.readdirSync(dir).filter(f => !/^cold\.db(-wal|-shm)?$|^settings\.json$/.test(f)), [], "the app's data folder holds only the database and settings");
    // provider credentials are in settings, not in the library file
    await go(page, "settings"); await page.waitForSelector("#modelFlowLine");
    assert.match(await page.textContent("#modelFlowLine"), /is sent from this computer to /);
    const dbText = fs.readFileSync(path.join(dir, "cold.db")).toString("latin1") + (fs.existsSync(path.join(dir, "cold.db-wal")) ? fs.readFileSync(path.join(dir, "cold.db-wal")).toString("latin1") : "");
    assert.ok(!dbText.includes("mock-key"));
  } finally { await t.close(); db.close(); hub.stop(); }
});
