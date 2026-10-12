// Sharing one local library through Cold Desktop: the web app and the desktop app read and write the same records, nothing is merged or
// overwritten behind the user's back, and every surface still works with the desktop app absent. Real servers, SQLite and browser;
// the model is a MOCK. (The extension has its own shared-library test in extension.test.js.)
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
const until = async (fn, ms = 25000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timed out waiting for: " + fn); await new Promise(r => setTimeout(r, 150)); } };
const P1 = { id: "p1", name: "Acme Flow", order: 0, what: "Acme Flow turns a signup into a first booked job for plumbers.", proof: [], techFacts: [], approved: [], dontSay: [] };
const REC = (o = {}) => ({ id: "e1", createdAt: 1000, status: "draft", mode: "email", productId: "p1", productName: "Acme Flow", recipient: { name: "Sam Ortiz", company: "TrialCo" }, subject: "hello", what: "We help.", why: "You wrote it.", ask: "Could I ask?", note: "", ...o });

/** A "desktop app": a real Cold server with a database, plus direct access the way the desktop window itself would write. */
async function desktop() {
  const { createDb } = require("../lib/db");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-shared-")), port = await freePort();
  const start = () => env.startColdServer({ mockUrl: mock.url, port, env: { COLD_DB_FILE: path.join(dir, "cold.db"), COLD_SETTINGS_FILE: path.join(dir, "settings.json") } });
  let server = await start();
  const db = createDb(path.join(dir, "cold.db")), token = db.extensionToken(), origin = `http://127.0.0.1:${port}`;
  const call = async (p, init = {}) => { const r = await fetch(origin + p, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}` } }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return {
    dir, port, origin, token, db, get server() { return server; },
    stop: () => server.stop(), restart: async () => { server.stop(); await new Promise(r => setTimeout(r, 300)); server = await start(); },
    /** What the desktop window does: a version-checked write through the app's own API. */
    save: async (kind, rec) => { const cur = db.snapshot()[kind].find(x => x.id === rec.id); const r = await call(`/api/data/${kind}/${rec.id}?base=${cur ? (cur.updatedAt || 0) : "new"}`, { method: "PUT", body: JSON.stringify(rec) }); assert.equal(r.status, 200, JSON.stringify(r.body)); },
    remove: async (kind, id) => { const cur = db.snapshot()[kind].find(x => x.id === id); const r = await call(`/api/data/${kind}/${id}?base=${cur.updatedAt || 0}`, { method: "DELETE" }); assert.equal(r.status, 200); },
    snap: () => db.snapshot(), close() { server.stop(); db.close(); },
  };
}
async function openWeb(server, desk, { seed } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  if (seed) await page.addInitScript(s => { if (!sessionStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); sessionStorage.setItem("__seeded", "1"); } }, seed);
  await page.goto(server.base + "/");
  await page.waitForSelector("#genBtn", { state: "attached" });
  await page.waitForFunction(() => document.querySelector("#genHint").textContent.length > 0 && !/Connecting/.test(document.querySelector("#genHint").textContent));
  return { page, context, errors, close: () => context.close() };
}
const go = async (page, v) => { await page.click(`#nav-${v}`); await page.waitForSelector(`#view-${v}`, { state: "visible" }); };
const connect = async (page, desk) => { await go(page, "settings"); await page.fill("#hubAddress", `127.0.0.1:${desk.port}`); await page.fill("#hubCode", desk.token); await page.click("#hubConnect"); await page.waitForSelector("#hubDisconnect"); };
const rowsText = page => page.$$eval(".hrow", r => r.map(x => x.textContent));
const sharedKey = (desk, what) => `cold.shared.${encodeURIComponent(desk.origin)}.${what}`;
const lsGet = (page, k) => page.evaluate(x => localStorage.getItem(x), k);

test("web connected to desktop reads and writes the same records: edits, status, notes and deletes go both ways", { skip: SKIP, timeout: 120000 }, async () => {
  const desk = await desktop(), web = await env.startColdServer({ mockUrl: mock.url });
  desk.db.setWebOrigins([new URL(web.base).origin]);
  desk.db.put("products", "p1", { ...P1, updatedAt: 5 }); desk.db.put("emails", "e1", REC({ note: "desktop note", updatedAt: 5 })); desk.db.put("emails", "e2", REC({ id: "e2", createdAt: 900, recipient: { name: "Bo Chen", company: "BoCo" }, updatedAt: 5 }));
  const t = await openWeb(web, desk); const { page } = t;
  try {
    await connect(page, desk);
    await go(page, "history"); await page.waitForFunction(() => document.querySelectorAll(".hrow").length === 2);
    assert.match((await rowsText(page)).join(" "), /Sam Ortiz.*desktop note|desktop note.*Sam Ortiz|Bo Chen/s);
    // a note typed in the web app reaches the desktop database
    await page.locator(".hrow", { hasText: "Sam Ortiz" }).locator(".hToggle").click();
    await page.locator(".hrow", { hasText: "Sam Ortiz" }).locator(".hNote").fill("web note");
    await until(() => desk.snap().emails.find(e => e.id === "e1").note === "web note");
    // marking sent in the web app: status, timestamp and sent snapshot reach the desktop database intact
    await page.locator(".hrow", { hasText: "Bo Chen" }).locator(".hMarkSent").click();
    await until(() => { const e = desk.snap().emails.find(x => x.id === "e2"); return e.status === "sent" && typeof e.sentAt === "number" && e.sentCopy && e.sentCopy.text; });
    // a change made in the desktop app shows up in the web app without any action
    await desk.save("emails", { ...desk.snap().emails.find(e => e.id === "e1"), status: "replied", repliedAt: 77 });
    await page.waitForFunction(() => /Reply recorded/.test(document.querySelector(".hrow").textContent + [...document.querySelectorAll(".hrow")].map(r => r.textContent).join("")), null, { timeout: 25000 });
    // a draft created in the web app is a record in the desktop library
    await go(page, "compose"); await page.selectOption("#rProduct", "p1"); await page.fill("#rName", "Web Made"); await page.fill("#rCompany", "WebCo"); await page.fill("#rWhy", "Wrote about plumbing trials.");
    await page.click("#genBtn"); await page.waitForSelector("#eSubject");
    await until(() => desk.snap().emails.some(e => e.recipient && e.recipient.name === "Web Made"));
    // deletes go both ways
    await go(page, "history"); await page.locator(".hrow", { hasText: "Web Made" }).locator("button:has-text('Delete')").click(); await page.click("button:has-text('Delete draft')");
    await until(() => !desk.snap().emails.some(e => e.recipient && e.recipient.name === "Web Made"));
    await desk.remove("emails", "e2");
    await page.waitForFunction(() => !/Bo Chen/.test(document.body.innerText), null, { timeout: 25000 });
    // the record the user cares about kept every field through all of that
    const e1 = desk.snap().emails.find(e => e.id === "e1");
    assert.deepEqual([e1.status, e1.repliedAt, e1.note], ["replied", 77, "web note"]);
    assert.deepEqual(t.errors.filter(e => !/ERR_CONNECTION_REFUSED|ERR_FAILED/.test(e)), []);
  } finally { await t.close(); desk.close(); web.stop(); }
});

test("desktop offline: the page still starts, shows its last copy, drafts and edits; reconnecting merges different fields, keeps the desktop's version on a clash, and never overwrites newer records", { skip: SKIP, timeout: 150000 }, async () => {
  const desk = await desktop(), web = await env.startColdServer({ mockUrl: mock.url });
  desk.db.setWebOrigins([new URL(web.base).origin]);
  desk.db.put("products", "p1", { ...P1, updatedAt: 5 }); desk.db.put("emails", "e1", REC({ updatedAt: 5 })); desk.db.put("emails", "e2", REC({ id: "e2", createdAt: 900, recipient: { name: "Bo Chen", company: "BoCo" }, updatedAt: 5 }));
  const t = await openWeb(web, desk); const { page } = t;
  try {
    await connect(page, desk);
    await go(page, "history"); await page.waitForFunction(() => document.querySelectorAll(".hrow").length === 2);
    desk.stop(); await new Promise(r => setTimeout(r, 500));
    // reload with the desktop app closed: startup is not blocked, the last-known shared copy is there, the page says where it stands
    await page.reload(); await page.waitForSelector("#genBtn", { state: "attached" });
    await go(page, "history"); assert.equal(await page.locator(".hrow").count(), 2);
    await go(page, "settings"); await page.waitForSelector("text=The Cold desktop app isn't running", { timeout: 20000 });
    assert.match(await page.textContent("#libraryLine"), /The Cold Desktop library.*working copy/s);
    // offline edits: a note on e1 (a field the desktop will not touch), a note on e2 (a field it WILL change), a brand-new draft
    await go(page, "history");
    for (const [who, note] of [["Sam Ortiz", "offline note on e1"], ["Bo Chen", "offline note on e2"]]) { const r = page.locator(".hrow", { hasText: who }); await r.locator(".hToggle").click(); await r.locator(".hNote").fill(note); }
    await page.waitForFunction(k => /offline note on e2/.test(localStorage.getItem(k)), sharedKey(desk, "emails"));
    await go(page, "compose"); await page.selectOption("#rProduct", "p1"); await page.fill("#rName", "Offline Made"); await page.fill("#rCompany", "OffCo"); await page.fill("#rWhy", "Wrote about plumbing trials.");
    await page.click("#genBtn"); await page.waitForSelector("#eSubject");
    // meanwhile the desktop app is used directly: status on e1 (different field), a different note on e2 (same field), and a record only it has
    desk.db.put("emails", "e1", { ...desk.snap().emails.find(e => e.id === "e1"), status: "replied", repliedAt: 88, updatedAt: 500 });
    desk.db.put("emails", "e2", { ...desk.snap().emails.find(e => e.id === "e2"), note: "desktop note on e2", updatedAt: 500 });
    desk.db.put("emails", "e3", REC({ id: "e3", createdAt: 50, recipient: { name: "Desk Only", company: "DeskCo" }, updatedAt: 500 }));
    await desk.restart();
    await until(() => desk.snap().emails.some(e => e.recipient && e.recipient.name === "Offline Made"), 40000);
    const s = Object.fromEntries(desk.snap().emails.map(e => [e.id, e]));
    assert.deepEqual([s.e1.status, s.e1.repliedAt, s.e1.note], ["replied", 88, "offline note on e1"], "different fields from both sides are both kept");
    assert.deepEqual([s.e2.note], ["desktop note on e2"], "on a clash the desktop's version stays");
    assert.ok(s.e3, "a record the browser never had is untouched");
    // the browser's edit was not thrown away: it is set aside where the user can see and restore it
    await go(page, "settings"); await page.waitForSelector("#syncConflicts", { timeout: 20000 });
    assert.match(await page.textContent("#syncConflicts"), /Bo Chen/);
    assert.match(await page.textContent("#notices"), /couldn't be merged/);
    await page.click("#syncConflicts button:has-text('Use my version')");
    await until(() => desk.snap().emails.find(e => e.id === "e2").note === "offline note on e2");
    assert.deepEqual(t.errors.filter(e => !/ERR_CONNECTION_REFUSED|ERR_FAILED/.test(e)), []);
  } finally { await t.close(); desk.close(); web.stop(); }
});

test("switching libraries never merges or destroys: each keeps exactly its own records; copying is previewed, explicit and never overwrites", { skip: SKIP, timeout: 120000 }, async () => {
  const desk = await desktop(), web = await env.startColdServer({ mockUrl: mock.url });
  desk.db.setWebOrigins([new URL(web.base).origin]);
  desk.db.put("products", "p1", { ...P1, name: "Desktop Acme", updatedAt: 5 });                                   // same id as the standalone p1, different content
  desk.db.put("emails", "d1", REC({ id: "d1", recipient: { name: "Desk Person", company: "DeskCo" }, updatedAt: 5 }));
  const standalone = { "cold.products": [P1, { ...P1, id: "p9", name: "Only Here", order: 1 }], "cold.emails": [REC({ id: "s1", recipient: { name: "Stand Person", company: "StandCo" } })] };
  const t = await openWeb(web, desk, { seed: standalone }); const { page } = t;
  try {
    const before = await page.evaluate(() => [localStorage.getItem("cold.products"), localStorage.getItem("cold.emails")]);
    await go(page, "history"); assert.match((await rowsText(page)).join(" "), /Stand Person/);
    await connect(page, desk);
    await go(page, "history"); await page.waitForFunction(() => /Desk Person/.test(document.body.innerText) && !/Stand Person/.test(document.body.innerText));
    await page.waitForTimeout(1500);
    assert.deepEqual([desk.snap().emails.map(e => e.id), desk.snap().products.map(p => p.name)], [["d1"], ["Desktop Acme"]], "connecting sent nothing");
    // import: a preview that names what will be copied and what will be left alone; cancel changes nothing
    await go(page, "settings"); await page.click("#importStandalone");
    const text = await page.textContent("dialog");
    assert.match(text, /1 product \(Only Here\) and 1 draft \(Stand Person\) will be copied/); assert.match(text, /1 item is already in the shared library and will not be touched/);
    await page.click('dialog button[value="cancel"]'); await page.waitForTimeout(800);
    assert.deepEqual(desk.snap().emails.map(e => e.id), ["d1"]);
    await page.click("#importStandalone"); await page.click('dialog button[value="ok"]');
    await until(() => desk.snap().emails.some(e => e.id === "s1") && desk.snap().products.some(p => p.name === "Only Here"));
    assert.equal(desk.snap().products.find(p => p.id === "p1").name, "Desktop Acme", "an item that was already there is never overwritten");
    // a second copy finds nothing to do and duplicates nothing
    await page.click("#importStandalone"); await page.waitForTimeout(500);
    assert.equal(await page.locator("dialog").count(), 0);
    assert.equal(desk.snap().emails.length, 2);
    // switch to the browser's own library and back: each shows exactly its own, and neither is changed by being switched away from
    await page.click("#useStandalone"); await page.click('dialog button[value="ok"]');
    await go(page, "history"); await page.waitForFunction(() => /Stand Person/.test(document.body.innerText) && !/Desk Person/.test(document.body.innerText));
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem("cold.products"), localStorage.getItem("cold.emails")]), before, "the standalone library is byte-for-byte what it was");
    await go(page, "settings"); assert.match(await page.textContent("#libraryLine"), /not shared/);
    assert.match(await page.textContent("#syncLine"), /Syncing is off/);
    // while on the own library, an edit stays there and does not reach the desktop
    await go(page, "history"); await page.locator(".hrow").first().locator(".hToggle").click(); await page.locator(".hrow").first().locator(".hNote").fill("private to this browser");
    await page.waitForFunction(() => /private to this browser/.test(localStorage.getItem("cold.emails")));
    await page.waitForTimeout(1500);
    assert.ok(!JSON.stringify(desk.snap()).includes("private to this browser"));
    await go(page, "settings"); await page.click("#useShared"); await page.click('dialog button[value="ok"]');
    await go(page, "history"); await page.waitForFunction(() => /Desk Person/.test(document.body.innerText));
    assert.equal(desk.snap().emails.length, 2);
    assert.deepEqual(t.errors.filter(e => !/ERR_CONNECTION_REFUSED|ERR_FAILED/.test(e)), []);
  } finally { await t.close(); desk.close(); web.stop(); }
});

test("a pairing made before shared libraries existed keeps working as it did; an unpaired page stays standalone", { skip: SKIP, timeout: 90000 }, async () => {
  const desk = await desktop(), web = await env.startColdServer({ mockUrl: mock.url });
  desk.db.setWebOrigins([new URL(web.base).origin]);
  desk.db.put("emails", "d1", REC({ id: "d1", recipient: { name: "Desk Person", company: "DeskCo" }, updatedAt: 5 }));
  const seed = { "cold.products": [P1], "cold.emails": [REC({ id: "s1", recipient: { name: "Stand Person", company: "StandCo" } })], "cold.hub": { origin: desk.origin, token: desk.token } };
  const t = await openWeb(web, desk, { seed }); const { page } = t;
  try {
    await go(page, "settings"); await page.waitForSelector("text=Connected.", { timeout: 20000 });
    assert.match(await page.textContent("#libraryLine"), /kept in sync with the Cold Desktop app/);
    await until(() => desk.snap().emails.some(e => e.id === "s1"));                                                 // as before: the old pairing synced the library
    await go(page, "history"); await page.waitForFunction(() => document.querySelectorAll(".hrow").length === 2);
  } finally { await t.close(); }
  const fresh = await openWeb(web, desk);
  try {
    await go(fresh.page, "settings");
    assert.match(await fresh.page.textContent("#view-settings"), /Connecting makes the Cold Desktop library the one you work in/);
    assert.equal(await fresh.page.locator("#libraryLine").count(), 0);
    await go(fresh.page, "history"); assert.equal(await fresh.page.locator(".hrow").count(), 0);
  } finally { await fresh.close(); desk.close(); web.stop(); }
});

test("security: the database file is never served, library responses carry no provider keys, origins and codes are enforced", { skip: SKIP, timeout: 90000 }, async () => {
  const desk = await desktop(), web = await env.startColdServer({ mockUrl: mock.url });
  desk.db.put("emails", "e1", REC({ updatedAt: 5 }));
  const t = await openWeb(web, desk); const { page } = t;
  try {
    // the SQLite file is not reachable over HTTP by any path
    for (const p of ["/cold.db", "/cold.db-wal", `/${path.basename(desk.db.file)}`, "/api/data/cold.db", "/../cold.db", "/settings.json"]) {
      const r = await fetch(desk.origin + p, { headers: { authorization: `Bearer ${desk.token}` } });
      const body = await r.text();
      assert.ok(r.status !== 200 || !body.startsWith("SQLite format 3"), `the database file is not served at ${p}`);
    }
    // the library snapshot has records, settings (signature) and compose scratch only: never provider configuration
    const snap = await (await fetch(desk.origin + "/api/data", { headers: { authorization: `Bearer ${desk.token}` } })).text();
    assert.ok(!/mock-key|apiKey|ANTHROPIC/.test(snap), "no provider key in library responses");
    // without the right code, or from a page the app has not approved, the library is refused
    assert.equal((await fetch(desk.origin + "/api/data", { headers: { authorization: "Bearer wrong" } })).status, 403);
    const pre = await fetch(desk.origin + "/api/data", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "PUT" } });
    assert.ok(!pre.headers.get("access-control-allow-origin"), "an unapproved page gets no CORS permission");
    // a connected page's stored copy holds records only
    desk.db.setWebOrigins([new URL(web.base).origin]);
    await connect(page, desk);
    await go(page, "history"); await page.waitForFunction(() => document.querySelectorAll(".hrow").length === 1);
    const dump = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))));
    assert.ok(!dump.includes("mock-key"), "no provider key reached the page's storage");
  } finally { await t.close(); desk.close(); web.stop(); }
});
