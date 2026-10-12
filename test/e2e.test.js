// Browser end-to-end tests (Chromium via playwright-core) against the real server and the real bundle.
// The model is a MOCK that returns canned JSON: these tests prove UI behaviour and plumbing, NOT output quality,
// and nothing here says anything about production availability or customer demand.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const env = require("./helpers/env");

const SKIP = env.browserAvailable() ? false : "Chromium or playwright-core is not available";
const AXE = path.join(__dirname, "../node_modules/axe-core/axe.min.js");

const EXT = { id: "pr1", claim: "Cut trial stall for one design partner", evidence: "Pilot, March", type: "Customer", strength: "High", external: true };
const INT = { id: "pr2", claim: "Internal revenue hit 48000 dollars in May", evidence: "Stripe export", type: "Revenue / growth", strength: "High", external: false };
const P1 = { id: "p1", name: "Acme Flow", order: 0, oneLiner: "Trials to jobs", what: "Acme Flow turns a signup into a first booked job for plumbers.", who: "Plumbing shops", problem: "Trials stall before a teammate is invited.", proof: [EXT, INT], techFacts: [], approved: [], dontSay: ['Never say "generic database".'], legacyExtra: "keep-me" };
const P2 = { id: "p2", name: "Beacon", order: 1, what: "Beacon watches job queues.", proof: [], techFacts: [], approved: [], dontSay: [] };
const EMAIL = (o = {}) => ({ id: "e1", createdAt: Date.now() - 86400000, status: "draft", recipient: { name: "Ada Park", role: "COO", company: "PipeCo", why: "Posted about onboarding" }, productId: "p1", productName: "Acme Flow", goal: "advice", subject: "onboarding", what: "Acme Flow turns a signup into a first booked job.", why: "You posted about onboarding.", ask: "Could I get your take?", score: 92, ...o });

let browser, mock, srv, locked;
before(async () => {
  if (SKIP) return;
  mock = await env.startMock(); srv = await env.startColdServer({ mockUrl: mock.url });
  locked = await env.startColdServer({ mockUrl: mock.url, env: { COLD_ACCESS_TOKEN: "pilot-code" } });
  browser = await env.launch();
});
after(async () => { if (SKIP) return; await browser.close(); srv.stop(); locked.stop(); mock.server.close(); });
beforeEach(() => { if (SKIP) return; mock.prompts.length = 0; mock.delayMs = 0; mock.failNext = 0; mock.final = { ...env.FINAL }; mock.claims = [{ text: "cut that stall", source: "P1" }]; });

async function open(opts = {}) {
  const { seed, viewport = { width: 1280, height: 900 }, colorScheme = "light", reducedMotion = "no-preference", server = srv, hash = "", bypassCSP = false } = opts;
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion, bypassCSP, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  if (seed) await page.addInitScript(s => { if (!sessionStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); sessionStorage.setItem("__seeded", "1"); } }, seed);
  await page.goto(server.base + "/" + hash);
  await page.waitForSelector("#genBtn", { state: "attached" });
  await page.waitForFunction(() => document.querySelector("#genHint").textContent.length > 0 && !/Connecting/.test(document.querySelector("#genHint").textContent));
  return { page, context, errors, close: () => context.close() };
}
const fillCompose = async (page, o = {}) => { await page.fill("#rName", o.name ?? "Sam Ortiz"); await page.fill("#rCompany", o.company ?? "TrialCo"); await page.fill("#rWhy", o.why ?? "Wrote that most trial users stall before inviting a teammate."); };
/** Click a primary-nav link and wait until that view is actually shown. */
const go = async (page, v) => { await page.click(`#nav-${v}`); await page.waitForSelector(`#view-${v}`, { state: "visible" }); };
const generate = async page => { await page.click("#genBtn"); await page.waitForSelector("#eSubject"); };
const ls = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem(k)), key);
const SEED = { "cold.products": [P1] };

test("Compose, Knowledge and History load and navigation works (links, back button, deep links, titles)", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  assert.equal(await page.textContent("h1:visible"), "Write an outreach draft");
  assert.equal(await page.getAttribute("#nav-compose", "aria-current"), "page");
  await go(page, "knowledge");
  await page.waitForURL(/#\/knowledge$/);
  assert.equal(await page.isVisible("#view-knowledge"), true); assert.equal(await page.isVisible("#view-compose"), false);
  assert.equal(await page.textContent("h1:visible"), "Product knowledge");
  assert.equal(await page.title(), "Knowledge · Cold");
  assert.equal(await page.getAttribute("#nav-knowledge", "aria-current"), "page");
  await go(page, "history");
  assert.equal(await page.textContent("h1:visible"), "History");
  await page.goBack(); await page.waitForSelector("#view-knowledge", { state: "visible" });
  await page.goBack(); await page.waitForSelector("#view-compose", { state: "visible" });
  const deep = await open({ hash: "#/history" });
  assert.equal(await deep.page.isVisible("#view-history"), true, "deep link to a view works without server routing");
  assert.deepEqual(t.errors.concat(deep.errors), []);
  await t.close(); await deep.close();
});

test("first use: no fabricated prospect, product, example email or default sign-off; first action is obvious", { skip: SKIP }, async () => {
  const t = await open(); const { page } = t;
  assert.equal(await page.inputValue("#rName"), ""); assert.equal(await page.inputValue("#rCompany"), "");
  const text = await page.textContent("body");
  for (const bad of ["Randy", "Sarah Chen", "Example", "Compute", "Load starter"]) assert.ok(!text.includes(bad), `unexpected "${bad}"`);
  assert.equal(await page.isVisible("#pName"), true, "a first-time user can name their product right here");
  assert.equal(await page.isVisible("#rProduct"), false);
  assert.match(text, /It never sends anything/); assert.match(text, /not backed up or synced/);
  assert.equal(await page.locator("#genBtn").isEnabled(), true);
  assert.deepEqual(t.errors, []); await t.close();
});

test("missing required inputs: one clear summary, per-field errors, focus handling, no model call", { skip: SKIP }, async () => {
  const t = await open(); const { page } = t;
  await page.click("#genBtn");
  const summary = page.locator("#errorSummary");
  await summary.waitFor();
  assert.match(await summary.textContent(), /Fix 5 things to generate/);
  assert.equal(await page.getAttribute("#rName", "aria-invalid"), "true");
  assert.match(await page.textContent("#rName ~ .field-error, #rName + .field-error"), /Enter their name/);
  assert.equal(await page.evaluate(() => document.activeElement.id), "errorSummary");
  assert.equal(await summary.getAttribute("role"), "alert");
  await summary.getByRole("button", { name: "Name", exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), "rName");
  assert.equal(mock.prompts.length, 0);
  await t.close();
});

test("generation: expected two-call API contract, editable draft, saved product and history record", { skip: SKIP }, async () => {
  const t = await open(); const { page } = t;
  await fillCompose(page); await page.fill("#pName", "Acme Flow"); await page.fill("#pWhat", "Acme Flow turns a signup into a first booked job for plumbers.");
  await generate(page);
  assert.equal(mock.prompts.length, 2);
  assert.match(mock.prompts[0], /You write cold emails/); assert.match(mock.prompts[0], /RECIPIENT: Sam Ortiz at TrialCo/); assert.match(mock.prompts[0], /\[WHAT\] What it does: Acme Flow turns/);
  assert.match(mock.prompts[1], /You are the editor/);
  assert.equal(await page.inputValue("#eSubject"), "trial drop-off");
  assert.equal((await page.locator("#eAsk").inputValue()).endsWith("?"), true);
  assert.equal(await page.isVisible("#rProduct"), true, "the product entered inline is now a saved product");
  assert.equal((await ls(page, "cold.products")).length, 1);
  const emails = await ls(page, "cold.emails");
  assert.equal(emails.length, 1); assert.equal(emails[0].status, "draft"); assert.equal(emails[0].recipient.name, "Sam Ortiz");
  assert.ok(await page.isVisible("text=Check before you send"));
  assert.match(await page.textContent("#out"), /Cold can't send, and can't see your inbox/);
  assert.deepEqual(t.errors, []); await t.close();
});

/** The OS email handoff is MOCKED in these tests: they prove what Cold asks for and how it recovers, not that this computer has a working email app. */
const mockDesktopMail = (page, reply = { ok: true }) => page.evaluate(r => { window.__mail = []; window.coldDesktop = { openMail: async u => { window.__mail.push(u); if (r === "throw") throw new Error("ipc down"); return r; } }; }, reply);
const mockBrowserMail = page => page.evaluate(() => { window.__mail = []; HTMLAnchorElement.prototype.click = function () { if (/^mailto:/i.test(this.href)) window.__mail.push(this.href); }; });
const mailed = page => page.evaluate(() => window.__mail);
const parseMail = url => { const q = url.indexOf("?"), p = new URLSearchParams(url.slice(q + 1)); return { to: decodeURIComponent(url.slice(7, q)), subject: p.get("subject"), body: p.get("body"), keys: [...p.keys()] }; };

test("open in email: uses the CURRENT edited draft, keeps Copy, never marks the draft sent, and the address persists", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await page.fill("#rEmail", "sam@trialco.com"); await generate(page);
  assert.equal(await page.inputValue("#eTo"), "sam@trialco.com");
  await mockDesktopMail(page);
  await page.fill("#eSubject", "Edited & subject = ok? ✓"); await page.fill("#eWhat", "Edited first sentence for Åsa — 日本語.");
  await page.click("#openEmail");
  await page.waitForFunction(() => window.__mail.length === 1);
  const m = parseMail((await mailed(page))[0]);
  assert.equal(m.to, "sam@trialco.com"); assert.equal(m.subject, "Edited & subject = ok? ✓"); assert.deepEqual(m.keys, ["subject", "body"]);
  assert.ok(m.body.startsWith("Edited first sentence for Åsa — 日本語."), "the body is the edited text, not the model's original");
  assert.ok(m.body.includes("\r\n\r\n"), "the ask is separated by a blank line, as in Copy");
  assert.match(await page.textContent("#handoffMsg"), /Review it and press Send there. Cold hasn't sent anything/);
  // nothing about the draft changed
  const rec = (await ls(page, "cold.emails"))[0];
  assert.deepEqual([rec.status, rec.sentAt, rec.repliedAt, rec.recipient.email], ["draft", undefined, undefined, "sam@trialco.com"]);
  assert.equal(await page.inputValue("#eSubject"), "Edited & subject = ok? ✓");
  // Copy is independent and still gives the same body
  await page.click("#copyEmail");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), m.body.replace(/\r\n/g, "\n"), "Copy and Open in email carry the same text (mailto uses CRLF line breaks)");
  // the address survives navigating away and reopening from History
  await go(page, "history"); await page.click('.hrow button[title="Reopen and edit this draft"]'); await page.waitForSelector("#eTo");
  assert.equal(await page.inputValue("#eTo"), "sam@trialco.com");
  assert.equal(await page.inputValue("#rEmail"), "sam@trialco.com");
  assert.deepEqual(t.errors, []); await t.close();
});

test("open in email without an address: nothing opens, the draft is untouched, and typing the address fixes it", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await generate(page);                                    // no email address entered
  await mockDesktopMail(page);
  const before = await page.inputValue("#eWhat");
  await page.click("#openEmail");
  assert.match(await page.textContent("#handoffMsg"), /Add the recipient's email address/);
  assert.deepEqual(await mailed(page), [], "no blank or misleading email window");
  assert.equal(await page.evaluate(() => document.activeElement.id), "eTo", "focus goes to the field that fixes it");
  assert.equal(await page.inputValue("#eWhat"), before);
  await page.click("#copyEmail");                                                    // Copy needs no address
  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).startsWith(before));
  // a typo is caught inline and still opens nothing
  await page.fill("#eTo", "sam@"); await page.click("#openEmail");
  assert.match(await page.textContent("#eToMsg"), /doesn't look like a valid email address/);
  assert.equal(await page.getAttribute("#eTo", "aria-invalid"), "true"); assert.deepEqual(await mailed(page), []);
  // the corrected address is saved with the draft and now works
  await page.fill("#eTo", "sam@trialco.com"); await page.click("#openEmail");
  await page.waitForFunction(() => window.__mail.length === 1);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.emails"))[0].recipient.email === "sam@trialco.com");
  assert.equal((await ls(page, "cold.emails"))[0].status, "draft");
  assert.deepEqual(t.errors, []); await t.close();
});

test("open in email: a typo in the compose form is caught before generating, and an empty address is fine", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await page.fill("#rEmail", "not-an-email"); await page.click("#genBtn");
  await page.waitForSelector("#errorSummary", { state: "visible" });
  assert.match(await page.textContent("#errorSummary"), /Email address/);
  assert.match(await page.textContent("#rEmail ~ .field-error, #rEmail-err"), /valid email address/);
  await page.fill("#rEmail", ""); await generate(page);                              // optional: no address, still generates
  assert.equal(await page.inputValue("#eTo"), "");
  await t.close();
});

test("open in email: a message that is too long is refused, not truncated, and Copy still has all of it", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await page.fill("#rEmail", "sam@trialco.com"); await generate(page);
  await mockDesktopMail(page);
  const long = "Long sentence number one. ".repeat(120);
  await page.fill("#eWhat", long);
  await page.click("#openEmail");
  assert.match(await page.textContent("#handoffMsg"), /too long to open reliably in an email app \(\d{4,} characters; the limit is 2000\)\. Nothing was shortened/);
  assert.deepEqual(await mailed(page), []);
  await page.click("#copyEmail");
  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes(long.trim()), "Copy has the full, unshortened text");
  assert.equal(await page.inputValue("#eWhat"), long);
  await t.close();
});

test("open in email: when the OS handoff fails, the draft is preserved and the message points to Copy", { skip: SKIP }, async () => {
  for (const reply of [{ ok: false, message: "no handler" }, "throw"]) {
    const t = await open({ seed: SEED }); const { page } = t;
    await fillCompose(page); await page.fill("#rEmail", "sam@trialco.com"); await generate(page);
    await mockDesktopMail(page, reply);
    const subject = await page.inputValue("#eSubject");
    await page.click("#openEmail");
    await page.waitForFunction(() => /Couldn't open your email app/.test(document.getElementById("handoffMsg").textContent));
    assert.match(await page.textContent("#handoffMsg"), /Use Copy email/);
    assert.equal(await page.inputValue("#eSubject"), subject);
    assert.equal(await page.locator("#copyEmail").isEnabled(), true);
    assert.equal((await ls(page, "cold.emails"))[0].status, "draft");
    await t.close();
  }
});

test("open in email (plain web, no desktop bridge): asks the browser for a mailto link and is honest that it cannot know the result", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await page.fill("#rEmail", "sam@trialco.com"); await generate(page);
  assert.equal(await page.evaluate(() => typeof window.coldDesktop), "undefined");
  await mockBrowserMail(page);
  await page.click("#openEmail");
  await page.waitForFunction(() => window.__mail.length === 1);
  const m = parseMail((await mailed(page))[0]); assert.equal(m.to, "sam@trialco.com");
  assert.match(await page.textContent("#handoffMsg"), /If nothing opened, this device may not have an email app set up: use Copy email/);
  assert.equal((await ls(page, "cold.emails"))[0].status, "draft");
  await t.close();
});

const stored = async (page, id) => (await ls(page, "cold.emails")).find(e => e.id === id);
const row = (page, text) => page.locator(".hrow", { hasText: text });

test("outreach workflow: draft -> open in email -> mark sent -> find later -> note -> record reply; only explicit actions change status", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page, { name: "Priya Nair", company: "Northwind" }); await page.fill("#rEmail", "priya@northwind.example"); await generate(page);
  const id = (await ls(page, "cold.emails"))[0].id;
  // a new draft starts as a draft, with no send or reply recorded
  let rec = await stored(page, id);
  assert.deepEqual([rec.status, rec.sentAt, rec.repliedAt, rec.sentCopy], ["draft", undefined, undefined, undefined]);
  // opening it in an email app (mocked), copying it, and editing it change nothing about the status
  await mockDesktopMail(page);
  await page.click("#openEmail"); await page.waitForFunction(() => window.__mail.length === 1);
  await page.click("#copyEmail");
  await page.fill("#eWhat", "A sentence the founder rewrote before sending.");
  await page.waitForFunction(i => JSON.parse(localStorage.getItem("cold.emails")).find(e => e.id === i).what?.startsWith("A sentence the founder"), id);
  rec = await stored(page, id);
  assert.deepEqual([rec.status, rec.sentAt, rec.repliedAt, rec.sentCopy], ["draft", undefined, undefined, undefined], "open, copy and edit never mark anything");
  // back in History it is plainly a draft
  await go(page, "history");
  assert.match(await row(page, "Priya Nair").locator(".chip").textContent(), /Draft/);
  assert.equal(await row(page, "Priya Nair").locator(".hMarkSent").count(), 1);
  assert.equal(await row(page, "Priya Nair").locator(".hRecordReply").count(), 0, "no reply can be recorded before it is marked sent");
  // the founder sends it themselves, then explicitly marks it sent
  await row(page, "Priya Nair").locator(".hMarkSent").click();
  await page.waitForFunction(i => JSON.parse(localStorage.getItem("cold.emails")).find(e => e.id === i).status === "sent", id);
  rec = await stored(page, id);
  assert.equal(typeof rec.sentAt, "number"); assert.equal(rec.repliedAt, undefined);
  assert.match(rec.sentCopy.text, /^A sentence the founder rewrote before sending\./);
  // it survives a reload, and the Sent filter finds that person later
  await page.reload(); await page.waitForSelector("#genBtn", { state: "attached" }); await go(page, "history");
  await page.getByRole("button", { name: /^Marked sent/ }).click();
  assert.equal(await page.locator(".hrow").count(), 1); assert.match(await page.locator(".hrow").textContent(), /Priya Nair/);
  assert.match(await page.locator(".hrow .chip").textContent(), /Marked sent/);
  await page.getByRole("button", { name: /^All/ }).click(); await page.fill("#histSearch", "priya@northwind");
  assert.equal(await page.locator(".hrow").count(), 1, "searchable by the address the user entered");
  await page.fill("#histSearch", "");
  // a note is optional, saved, and still there after navigating away and reloading
  const r1 = row(page, "Priya Nair");
  assert.equal(await r1.locator(".hNote").isHidden(), true);
  await r1.locator(".hToggle").click(); await r1.locator(".hNote").fill("Good fit: wrote about trials stalling. Follow up in a week.");
  await page.waitForFunction(i => JSON.parse(localStorage.getItem("cold.emails")).find(e => e.id === i).note?.startsWith("Good fit"), id);
  assert.equal((await stored(page, id)).status, "sent", "adding a note is not a status change");
  await go(page, "compose"); await go(page, "history");
  assert.match(await row(page, "Priya Nair").locator(".hnote").textContent(), /Follow up in a week/);
  await page.reload(); await page.waitForSelector("#genBtn", { state: "attached" }); await go(page, "history");
  await row(page, "Priya Nair").locator(".hToggle").click();
  assert.equal(await row(page, "Priya Nair").locator(".hNote").inputValue(), "Good fit: wrote about trials stalling. Follow up in a week.");
  // a reply arrives: the founder records it, without losing when it was sent or what was sent
  const sentAt = (await stored(page, id)).sentAt, sentCopy = (await stored(page, id)).sentCopy;
  await row(page, "Priya Nair").locator(".hRecordReply").click();
  await page.waitForFunction(i => JSON.parse(localStorage.getItem("cold.emails")).find(e => e.id === i).status === "replied", id);
  rec = await stored(page, id);
  assert.equal(typeof rec.repliedAt, "number"); assert.equal(rec.sentAt, sentAt); assert.deepEqual(rec.sentCopy, sentCopy);
  await page.getByRole("button", { name: /^Reply recorded/ }).click(); assert.equal(await page.locator(".hrow").count(), 1);
  // editing the record later does not rewrite what was sent, and does not fabricate any event
  await page.getByRole("button", { name: "Open", exact: true }).click(); await page.waitForURL(/#\/compose$/);
  await page.fill("#eSubject", "Edited long after sending");
  await page.waitForFunction(i => JSON.parse(localStorage.getItem("cold.emails")).find(e => e.id === i).subject === "Edited long after sending", id);
  rec = await stored(page, id);
  assert.deepEqual([rec.status, rec.sentAt, rec.sentCopy.subject, rec.sentCopy.text === sentCopy.text], ["replied", sentAt, sentCopy.subject, true]);
  assert.match(await page.textContent("#sentNote"), /You edited this after marking it sent/);
  assert.ok(await page.isVisible("summary:has-text('Text when you marked it sent')"));
  assert.equal(await page.inputValue("#eNote"), "Good fit: wrote about trials stalling. Follow up in a week.", "the note is also on the draft");
  assert.deepEqual(t.errors, []); await t.close();
});

test("history: Open in email from a row never changes status; a missing address is recoverable; old and sparse records are fine", { skip: SKIP }, async () => {
  const seed = { "cold.products": [P1], "cold.emails": [
    EMAIL({ id: "withmail", recipient: { name: "Ada Park", company: "PipeCo", email: "ada@pipeco.example" }, updatedAt: 111 }),
    EMAIL({ id: "nomail", recipient: { name: "Bo Chen", company: "BoCo" }, status: "sent", sentAt: 1700000000000 }),          // saved before addresses, notes and sent copies existed
    { id: "sparse", createdAt: 5, recipient: {}, subject: "", what: "", why: "", ask: "" },                                     // nothing but an id
    { id: "oddstatus", createdAt: 6, status: "archived", recipient: null, subject: "x", what: "y", why: "", ask: "" },
  ] };
  const t = await open({ seed }); const { page } = t;
  await go(page, "history");
  assert.equal(await page.locator(".hrow").count(), 4);                                                                       // every record loads; none is dropped
  const counts = Object.fromEntries(await page.$$eval(".hfilters .btn", b => b.map(x => x.textContent.replace(/\s+/g, " ").trim().split(/ (?=\d+$)/))));
  assert.deepEqual(counts, { All: "4", Draft: "2", "Marked sent": "1", "Reply recorded": "0", "Unknown status": "1" });   // "archived" is shown as unknown, not as a draft
  const before = await ls(page, "cold.emails");
  await mockDesktopMail(page);
  // with an address: hands off, changes nothing, writes nothing
  await row(page, "Ada Park").locator(".hEmail").click();
  await page.waitForFunction(() => window.__mail.length === 1);
  assert.match((await mailed(page))[0], /^mailto:ada@pipeco\.example\?subject=onboarding&body=/);
  assert.match(await row(page, "Ada Park").locator(".hmsg").textContent(), /Cold hasn't sent anything/);
  // without one: nothing opens, the details open with the address field focused
  await row(page, "Bo Chen").locator(".hEmail").click();
  assert.equal((await mailed(page)).length, 1);
  assert.match(await row(page, "Bo Chen").locator(".hmsg").textContent(), /Add the recipient's email address/);
  assert.equal(await page.evaluate(() => document.activeElement.className), "hTo");
  // typing the address saves it, still without touching the status
  await page.fill(".hrow[data-id=nomail] .hTo", "bo@boco.example");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.emails")).find(e => e.id === "nomail").recipient.email === "bo@boco.example");
  const after = await ls(page, "cold.emails");
  const strip = e => ({ ...e, recipient: { ...e.recipient, email: undefined }, updatedAt: undefined });
  // (a MISSING status reads back as the legacy default "draft"; an unfamiliar one such as "archived" is kept as it was)
  const known = x => (x == null || x === "" ? "draft" : x);
  const byId = (x, y) => x[0].localeCompare(y[0]);
  assert.deepEqual(after.map(e => [e.id, e.status, e.sentAt ?? null, e.repliedAt ?? null]).sort(byId), before.map(e => [e.id, known(e.status), e.sentAt ?? null, e.repliedAt ?? null]).sort(byId), "no status or timestamp changed");
  assert.equal(after.find(e => e.id === "withmail").updatedAt, 111, "a handoff does not even re-save the record");
  // copy is also inert
  await row(page, "Ada Park").locator("button:text-is('Copy')").click();
  assert.deepEqual((await ls(page, "cold.emails")).map(e => e.status ?? null), after.map(e => e.status ?? null));
  assert.deepEqual(t.errors, []); await t.close();
});

test("history: the outreach status survives in the shared record that the extension and desktop app also read", { skip: SKIP }, async () => {
  const t = await open({ seed: { "cold.products": [P1], "cold.emails": [EMAIL()] } }); const { page } = t;
  await go(page, "history");
  await row(page, "Ada Park").locator(".hMarkSent").click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.emails"))[0].status === "sent");
  const rec = (await ls(page, "cold.emails"))[0];
  // the record keeps every earlier field (nothing is dropped) and gains only the new ones
  assert.deepEqual(Object.keys(EMAIL()).filter(k => !(k in rec)), []);
  assert.deepEqual([rec.recipient.why, rec.productName, rec.subject], ["Posted about onboarding", "Acme Flow", "onboarding"]);
  const added = Object.keys(rec).filter(k => !(k in EMAIL()));
  for (const k of ["sentAt", "sentCopy", "updatedAt"]) assert.ok(added.includes(k), `${k} is recorded`);
  assert.equal(rec.repliedAt, undefined, "marking sent does not imply a reply");
  await t.close();
});

/** The desktop app as its own process (own database file), so it can be stopped and started while the web page stays open. */
const hubDir = () => require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "cold-hub-"));
const startHub = (dir, port) => env.startColdServer({ mockUrl: mock.url, port, env: { COLD_DB_FILE: path.join(dir, "cold.db"), COLD_SETTINGS_FILE: path.join(dir, "settings.json") } });
const freePort = () => new Promise(r => { const s = require("node:net").createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const until = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timed out waiting for: " + fn); await new Promise(r => setTimeout(r, 150)); } };

test("web: works on its own; connecting shows the desktop library without touching its own; copying is explicit; keeps working when the app stops and catches up when it returns", { skip: SKIP, timeout: 120000 }, async () => {
  const { createDb } = require("../lib/db");
  const dir = hubDir(), port = await freePort();
  let hub = await startHub(dir, port);
  const hubDb = createDb(path.join(dir, "cold.db"));
  hubDb.put("products", "p-hub", { id: "p-hub", name: "Hub Product", order: 5, what: "Lives in the desktop app.", proof: [], techFacts: [], approved: [], dontSay: [], updatedAt: Date.now() });
  hubDb.put("emails", "e-hub", { id: "e-hub", createdAt: Date.now() - 1000, status: "sent", sentAt: Date.now() - 500, note: "from the desktop app", recipient: { name: "Hub Person", company: "HubCo" }, subject: "hub subject", what: "w", why: "y", ask: "a", updatedAt: Date.now() - 500 });
  const t = await open({ seed: { "cold.products": [P1], "cold.emails": [EMAIL({ id: "e-web", recipient: { name: "Web Person", company: "WebCo" } })] } }); const { page } = t;
  try {
    // ---- on its own: everything works, and Settings says the desktop app is optional
    await go(page, "history"); assert.equal(await page.locator(".hrow").count(), 1);
    await go(page, "settings");
    assert.deepEqual(await page.$$eval("#view-settings .set-section h2", h => h.map(x => x.textContent)), ["Model", "Cold desktop app", "Your data"]);
    assert.match(await page.textContent("#view-settings"), /This site writes with/);                    // a hosted web page shows what the server uses; keys are not editable here
    assert.equal(await page.locator("#setKey").count(), 0, "a hosted site has no key field: keys never reach the browser");
    // ---- a page the desktop app hasn't approved is told how to fix that
    const webOrigin = new URL(srv.base).origin;
    await page.fill("#hubAddress", `127.0.0.1:${port}`); await page.fill("#hubCode", hubDb.extensionToken()); await page.click("#hubConnect");
    await page.waitForSelector(`#hubMsg :text("allowed web apps")`);
    assert.match(await page.textContent("#view-settings"), new RegExp(webOrigin.replace(/[.:/]/g, "\\$&")));
    // ---- approved: a wrong code is refused, the right one connects
    hubDb.setWebOrigins([webOrigin]);
    await page.fill("#hubCode", "wrong"); await page.click("#hubConnect");
    await page.waitForSelector(`#hubMsg :text("rejected that pairing code")`);
    await page.fill("#hubCode", hubDb.extensionToken()); await page.click("#hubConnect");
    await page.waitForSelector("#hubDisconnect");
    // ---- connecting switches to the DESKTOP library; the browser's own library is neither merged nor pushed
    const standaloneBefore = await page.evaluate(() => [localStorage.getItem("cold.products"), localStorage.getItem("cold.emails")]);
    await go(page, "settings"); assert.match(await page.textContent("#libraryLine"), /The Cold Desktop library/);
    await go(page, "history"); await page.waitForFunction(() => document.querySelectorAll(".hrow").length === 1);
    const hubRow = row(page, "Hub Person");
    assert.match(await hubRow.locator(".chip").textContent(), /Marked sent/); assert.match(await hubRow.locator(".hnote").textContent(), /from the desktop app/);   // status and notes arrive intact
    await go(page, "compose"); const opts = await page.$$eval("#rProduct option", o => o.map(x => x.textContent));
    assert.ok(opts.includes("Hub Product") && !opts.includes("Acme Flow"), "the shared library shows the desktop's products only");
    await page.waitForTimeout(1500);
    assert.deepEqual([hubDb.snapshot().emails.some(e => e.id === "e-web"), hubDb.snapshot().products.some(p => p.id === "p1")], [false, false], "pairing alone sent nothing from the browser's own library");
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem("cold.products"), localStorage.getItem("cold.emails")]), standaloneBefore, "the browser's own library is untouched");
    // ---- copying is a deliberate act that shows what it will copy, and changes nothing until confirmed
    await go(page, "settings"); await page.click("#importStandalone");
    assert.match(await page.textContent("dialog"), /1 product \(Acme Flow\) and 1 draft \(Web Person\) will be copied/);
    await page.click('dialog button[value="cancel"]'); await page.waitForTimeout(500);
    assert.equal(hubDb.snapshot().emails.some(e => e.id === "e-web"), false);
    await page.click("#importStandalone"); await page.click('dialog button[value="ok"]');
    await until(() => hubDb.snapshot().emails.some(e => e.id === "e-web") && hubDb.snapshot().products.some(p => p.id === "p1"));
    await go(page, "history"); await page.waitForFunction(() => document.querySelectorAll(".hrow").length === 2);
    // ---- the desktop app closes mid-use: the web keeps working, and says so
    hub.stop(); await page.waitForTimeout(300);
    await go(page, "history"); await row(page, "Web Person").locator(".hMarkSent").click();
    await page.waitForFunction(k => JSON.parse(localStorage.getItem(k)).find(e => e.id === "e-web").status === "sent", `cold.shared.${encodeURIComponent(`http://127.0.0.1:${port}`)}.emails`);
    await go(page, "compose"); await fillCompose(page, { name: "Offline Person", company: "OffCo" }); await generate(page);
    await go(page, "settings"); await page.waitForSelector("text=The Cold desktop app isn't running", { timeout: 15000 });
    assert.match(await page.textContent("#syncLine"), /\d+ changes? waiting to sync/);
    assert.equal(hubDb.snapshot().emails.find(e => e.id === "e-web").status, "draft", "the closed app has not heard yet");
    // a page reload while it is closed still shows everything
    await page.reload(); await page.waitForSelector("#genBtn", { state: "attached" }); await go(page, "history");
    assert.equal(await page.locator(".hrow").count(), 3);
    // ---- the app returns: the changes made while it was closed arrive without any action
    hub = await startHub(dir, port);
    await until(() => { const e = hubDb.snapshot().emails; return e.find(x => x.id === "e-web")?.status === "sent" && e.some(x => x.recipient?.name === "Offline Person"); }, 25000);
    const synced = hubDb.snapshot().emails.find(e => e.id === "e-web");
    assert.equal(typeof synced.sentAt, "number"); assert.ok(synced.sentCopy && synced.sentCopy.text, "the sent copy travelled too");
    await go(page, "settings"); await page.waitForSelector("text=Connected.", { timeout: 15000 });
    assert.match(await page.textContent("#syncLine"), /Nothing waiting to sync/);
    // ---- disconnecting returns to the browser's own library, exactly as it was; the shared copy stays in storage, unchanged
    await page.click("#hubDisconnect"); await page.waitForSelector("#hubCode"); await go(page, "history");
    await page.waitForFunction(() => document.querySelectorAll(".hrow").length === 1);
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem("cold.products"), localStorage.getItem("cold.emails")]), standaloneBefore);
    assert.ok(await page.evaluate(k => JSON.parse(localStorage.getItem(k)).length === 3, `cold.shared.${encodeURIComponent(`http://127.0.0.1:${port}`)}.emails`));
    // the only console noise allowed is the network failures this test causes on purpose (unapproved page, app stopped)
    assert.deepEqual(t.errors.filter(e => !/ERR_CONNECTION_REFUSED|ERR_FAILED|CORS policy|status of 403/.test(e)), []);
  } finally { await t.close(); hub.stop(); hubDb.close(); }
});

test("sentence boxes always show all their text, including after the window is resized or the view was hidden", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await generate(page);
  const clipped = () => page.evaluate(() => ["eWhat", "eWhy", "eAsk"].filter(id => { const x = document.getElementById(id); return x.clientHeight < 30 || x.scrollHeight > x.clientHeight + 1; }));
  assert.deepEqual(await clipped(), []);
  await page.setViewportSize({ width: 380, height: 900 }); await page.waitForTimeout(250);
  assert.deepEqual(await clipped(), [], "narrower window: text re-wraps and the boxes grow");
  await page.setViewportSize({ width: 1300, height: 900 }); await page.waitForTimeout(250);
  assert.deepEqual(await clipped(), [], "wider window");
  // a box sized while its view is hidden (measures as 0 tall) must fix itself when the view is shown
  await go(page, "history");
  await page.evaluate(() => { const x = document.getElementById("eWhy"); x.style.height = "0px"; x.value += " and a bit more so that it needs another line to be shown in full"; x.dispatchEvent(new Event("input", { bubbles: true })); });
  await go(page, "compose"); await page.waitForTimeout(250);
  assert.deepEqual(await clipped(), []);
  await t.close();
});

test("loading state: progress with Stop, button disabled, duplicate submission prevented", { skip: SKIP }, async () => {
  mock.delayMs = 600;
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page);
  await page.click("#genBtn");
  await page.waitForSelector(".progress");
  assert.equal(await page.locator("#genBtn").isDisabled(), true);
  assert.equal(await page.textContent("#genBtn"), "Generating…");
  assert.equal(await page.getAttribute(".progress", "aria-busy"), "true");
  assert.equal(await page.isVisible("text=Stop"), true);
  await page.evaluate(() => document.querySelector("#composeForm").requestSubmit());   // a second submit while busy
  await page.keyboard.press("Enter");
  await page.waitForSelector("#eSubject");
  assert.equal(mock.prompts.length, 2, "exactly one draft + one editor call");
  assert.equal((await ls(page, "cold.emails")).length, 1);
  await t.close();
});

test("failure keeps inputs and offers a nontechnical retry that works", { skip: SKIP }, async () => {
  mock.failNext = 1;
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page, { name: "Pat Lee" });
  await page.click("#genBtn");
  const err = page.locator("#genError");
  await err.waitFor();
  assert.match(await err.textContent(), /overloaded or unavailable|Try again/);
  assert.match(await err.textContent(), /inputs are kept/);
  assert.equal(await err.getAttribute("role"), "alert");
  assert.equal(await page.inputValue("#rName"), "Pat Lee");
  assert.deepEqual((await ls(page, "cold.emails")) || [], [], "a failed generation saves nothing");
  await err.getByRole("button", { name: "Try again" }).click();
  await page.waitForSelector("#eSubject");
  assert.equal(await page.locator("#genError").count(), 0);
  await t.close();
});

test("editing is preserved and saved; copy is accurate; regenerate never silently replaces edits", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await generate(page);
  await page.fill("#eWhat", "My own edited opener about stalls.");
  await page.waitForFunction(() => { const e = JSON.parse(localStorage.getItem("cold.emails"))[0]; return e.what === "My own edited opener about stalls." && e.edited === true; });
  await page.getByRole("button", { name: "Set sign-off" }).click();
  await page.fill("#dlg-input", "Pat"); await page.getByRole("button", { name: "Save" }).click();
  await page.click("#copyEmail");
  await page.waitForSelector(".toast:has-text('copied to clipboard')");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /^My own edited opener about stalls\. You wrote that/); assert.ok(clip.endsWith("\n\nPat"));
  const before = mock.prompts.length;
  await page.getByRole("button", { name: "Regenerate" }).click();
  await page.waitForSelector("dialog[open]");
  await page.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await page.inputValue("#eWhat"), "My own edited opener about stalls.");
  assert.equal(mock.prompts.length, before, "cancelled regeneration makes no model call");
  await t.close();
});

test("copy failure is reported honestly", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } }); document.execCommand = () => false; });
  await page.reload(); await page.waitForSelector("#genBtn");
  await fillCompose(page); await generate(page);
  await page.click("#copyEmail");
  await page.waitForSelector(".toast:has-text(\"Couldn't copy automatically\")");
  await t.close();
});

test("improve rewrites the current text and can be undone", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await generate(page);
  const original = await page.inputValue("#eAsk");
  mock.final = { ...env.FINAL, ask: "Would you tell me where trials stall for you?" };
  await page.getByText("Ask for a change").click();
  await page.fill("#focusIn", "sharper ask"); await page.getByRole("button", { name: "Improve" }).click();
  await page.waitForFunction(() => document.querySelector("#eAsk")?.value.startsWith("Would you tell me"));
  assert.match(mock.prompts.at(-1), /"sharper ask"/);
  await page.getByRole("button", { name: "Undo last improvement" }).click();
  await page.waitForFunction(o => document.querySelector("#eAsk")?.value === o, original);
  await t.close();
});

test("internal-only proof is never sent to the model and is flagged if a draft reuses it", { skip: SKIP }, async () => {
  mock.final = { ...env.FINAL, why: "We grew 48000 dollars and serve 500 plumbers in Texas." };
  mock.claims = [{ text: "serves 500 plumbers", source: "P1" }];
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await generate(page);
  for (const p of mock.prompts) {      // the editor prompt also quotes the mock's draft, so inspect the KNOWLEDGE section only
    const k = p.slice(p.indexOf("KNOWLEDGE\n"), p.indexOf("RECIPIENT:"));
    assert.ok(k.includes("PRODUCT: Acme Flow") && k.includes("Cut trial stall"));
    assert.ok(!k.includes("48000")); assert.ok(!k.includes("Stripe export")); assert.ok(!/internal/i.test(k));
  }
  const review = await page.locator("section[aria-label='Review before sending']").textContent();
  assert.match(review, /Review before sending/); assert.match(review, /internal-only proof/); assert.match(review, /“500”/); assert.match(review, /“Texas”/);
  await t.close();
});

test("unsupported claims are never shown as verified", { skip: SKIP }, async () => {
  mock.claims = [{ text: "serves 500 plumbers", source: "P1" }, { text: "ships in a day", source: "P7" }, { text: "cut that stall", source: "P1" }];
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await generate(page);
  await page.getByText(/Claims the model cited/).click();
  const panel = page.locator("details[data-id='claims']");
  const chips = await panel.locator(".chip").allTextContents();
  assert.ok(chips.some(c => /Needs review/.test(c)) && chips.some(c => /No such record/.test(c)) && chips.some(c => /Matches your text/.test(c)));
  assert.equal(await page.locator(".chip", { hasText: /verified/i }).count(), 0);
  assert.match(await panel.textContent(), /word overlap/);
  const review = await page.locator("section[aria-label='Review before sending']").textContent();
  assert.match(review, /no such record exists|doesn't match that record/);
  await t.close();
});

test("a clean draft says what the check does NOT prove", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await generate(page);
  const review = await page.locator("section[aria-label='Review before sending']").textContent();
  assert.match(review, /No unmatched numbers, names or cited claims found/); assert.match(review, /cannot tell whether a statement is true/);
  await page.getByText(/Style checklist/).click();
  const checklist = await page.locator("details[data-id='checklist']").textContent();
  assert.match(checklist, /not a prediction of replies/); assert.match(checklist, /Model's own report|model's own report/i);
  await t.close();
});

test("malformed localStorage does not break the app, shows a notice, and deletes nothing", { skip: SKIP }, async () => {
  const t = await open({ seed: { "cold.products": '{"a":1}', "cold.emails": '"x"', "cold.settings": "[1]", "cold.compose": "{nope" } }); const { page } = t;
  assert.deepEqual(t.errors, []);
  assert.match(await page.textContent("#notices"), /Some saved data couldn't be read/);
  await go(page, "history"); assert.ok(await page.isVisible("text=No drafts yet"));
  await go(page, "knowledge"); assert.ok(await page.isVisible("#emptyAdd"));
  assert.equal(await page.evaluate(() => localStorage.getItem("cold.products")), '{"a":1}');
  const mixed = await open({ seed: { "cold.products": [null, P2, 5], "cold.emails": [null, EMAIL(), { nope: 1 }] } });
  assert.deepEqual(mixed.errors, []);
  assert.equal(await mixed.page.locator("#rProduct option").count(), 2, "valid product kept (plus the add option)");
  await mixed.page.click("#nav-history"); assert.equal(await mixed.page.locator(".hrow").count(), 1);
  await t.close(); await mixed.close();
});

test("data written by the previous version survives: products, drafts, statuses, sign-off, unknown fields", { skip: SKIP }, async () => {
  const legacy = [EMAIL({ id: "e1", status: "draft" }), EMAIL({ id: "e2", status: "sent", sentAt: Date.now() - 5000, recipient: { name: "Bo Chen", role: "", company: "BoCo", why: "x" } }), EMAIL({ id: "e3", status: "replied", sentAt: Date.now() - 9000, recipient: { name: "Cy Diaz", role: "", company: "CyCo", why: "x" } }), { id: "e4", createdAt: Date.now(), status: "draft", mode: "reply", recipient: { name: "Tweet reply", why: "t" }, productId: "p1", productName: "Acme Flow", goal: "advice", subject: "Tweet reply", what: "A short reply.", why: "", ask: "", score: 100 }];
  const t = await open({ seed: { "cold.products": [P1, P2], "cold.emails": legacy, "cold.settings": { signature: "Randy" }, "cold.compose": { name: "Restored Name", company: "RC", why: "restored why", goal: "customer", productId: "p2" } } });
  const { page } = t;
  assert.equal(await page.inputValue("#rName"), "Restored Name"); assert.equal(await page.inputValue("#rProduct"), "p2"); assert.ok(await page.isChecked("#goal-customer"));
  await go(page, "knowledge");
  assert.deepEqual(await page.locator("#kProduct option").allTextContents(), ["Acme Flow", "Beacon", "Add a new product…"]);
  assert.equal(await page.inputValue("#kProduct"), "p1");
  assert.match(await page.inputValue("#kWhat"), /turns a signup into a first booked job/);
  await page.fill("#kWho", "Plumbing shops and HVAC"); await page.click("#kSave");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.products")).find(p => p.id === "p1").who.includes("HVAC"));
  const saved = (await ls(page, "cold.products")).find(p => p.id === "p1");
  assert.equal(saved.legacyExtra, "keep-me"); assert.equal(saved.proof.length, 2);
  await go(page, "history");
  assert.equal(await page.locator(".hrow").count(), 4);
  const rows = await page.locator(".hrow").evaluateAll(rs => rs.map(r => [r.querySelector(".who").textContent.trim().split(" ")[0], r.querySelector(".chip").textContent]));
  const byName = Object.fromEntries(rows);
  assert.match(byName.Ada, /Draft$/); assert.match(byName.Bo, /Marked sent$/); assert.match(byName.Cy, /Reply recorded$/); assert.match(byName.Tweet, /Draft$/);
  assert.equal(await page.locator(".hrow", { hasText: "Ada Park" }).locator("select.hStatus").inputValue(), "draft");
  assert.equal(await page.locator(".hrow", { hasText: "Cy Diaz" }).locator("select.hStatus").inputValue(), "replied");
  await t.close();
});

test("history: statuses are the user's own record, filters and counts are accurate, Open restores the draft", { skip: SKIP }, async () => {
  const t = await open({ seed: { "cold.products": [P1], "cold.emails": [EMAIL()] } }); const { page } = t;
  await go(page, "history");
  assert.match(await page.textContent("#view-history .lede"), /can't see your inbox/);
  const row = page.locator(".hrow");
  await row.locator("select.hStatus").selectOption("sent");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.emails"))[0].status === "sent");
  assert.ok((await ls(page, "cold.emails"))[0].sentAt);
  assert.match(await row.locator(".chip").textContent(), /Marked sent/); assert.match(await row.textContent(), /marked sent/);
  assert.ok(!/reply recorded/i.test(await row.locator(".sub").nth(1).textContent()), "no reply is implied");
  await row.locator("select.hStatus").selectOption("replied");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.emails"))[0].repliedAt);
  assert.match(await row.locator(".chip").textContent(), /Reply recorded/);
  await page.getByRole("button", { name: /^Draft/ }).click();
  assert.ok(await page.isVisible("text=Nothing is marked “Draft” yet"));
  await page.getByRole("button", { name: /^Reply recorded/ }).click();
  assert.equal(await page.locator(".hrow").count(), 1);
  await page.fill("#histSearch", "zzz"); assert.ok(await page.isVisible("text=No drafts match your search"));
  await page.fill("#histSearch", "pipeco"); assert.equal(await page.locator(".hrow").count(), 1);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.waitForURL(/#\/compose$/);
  assert.equal(await page.inputValue("#rName"), "Ada Park"); assert.equal(await page.inputValue("#eSubject"), "onboarding");
  await go(page, "history");
  await page.getByRole("button", { name: "Delete" }).click(); await page.getByRole("button", { name: "Delete draft" }).click();
  await page.waitForSelector("text=No drafts yet");
  await t.close();
});

test("Knowledge: product dropdown, readiness, internal vs external proof, unsaved edits survive navigation", { skip: SKIP }, async () => {
  const t = await open({ seed: { "cold.products": [P1, P2, { id: "p3", name: "Gamma", proof: [], techFacts: [], approved: [], dontSay: [] }] } }); const { page } = t;
  await go(page, "knowledge");
  assert.equal(await page.locator("select#kProduct").count(), 1, "products are chosen from a dropdown");
  assert.deepEqual(await page.locator("#kProduct option").allTextContents(), ["Acme Flow", "Beacon", "Gamma", "Add a new product…"]);
  assert.match(await page.textContent("#pickerStatus"), /Ready to draft\. Nothing is missing/);
  await page.selectOption("#kProduct", "p2");
  assert.match(await page.textContent("#pickerStatus"), /Ready to draft\. \d+ suggestions?/);
  await page.selectOption("#kProduct", "p3");
  assert.match(await page.textContent("#pickerStatus"), /Needs what it does before Cold can draft/);
  assert.ok(await page.locator("#view-knowledge .chip", { hasText: "Needed" }).first().isVisible());
  await page.selectOption("#kProduct", "p1");
  const ext = page.locator(".proof-group").nth(0), int = page.locator(".proof-group").nth(1);
  assert.match(await ext.locator("h3").textContent(), /Approved for external use/); assert.match(await int.locator("h3").textContent(), /Internal only/);
  assert.deepEqual(await ext.locator(".pClaim").evaluateAll(els => els.map(e => e.value)), ["Cut trial stall for one design partner"]);
  assert.deepEqual(await int.locator(".pClaim").evaluateAll(els => els.map(e => e.value)), ["Internal revenue hit 48000 dollars in May"]);
  assert.match(await int.textContent(), /Never sent to the model/);
  // move the external proof to internal-only
  await ext.locator(".proof").first().locator("select.pVis").selectOption("internal");
  assert.equal(await int.locator(".pClaim").count(), 2, "the moved proof now sits in the internal-only group");
  assert.equal(await ext.locator(".pClaim").count(), 0);
  // unsaved edits survive tab navigation
  await page.fill("#kName", "Acme Flow 2");
  await go(page, "history"); await go(page, "knowledge");
  assert.equal(await page.inputValue("#kName"), "Acme Flow 2");
  assert.equal(await page.textContent(".savebar .status"), "Unsaved changes");
  // dropdown guards unsaved edits
  await page.selectOption("#kProduct", "p2");
  await page.waitForSelector("dialog[open]");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForFunction(() => document.querySelector("#kProduct").value === "p1");   // dropdown snaps back after Cancel
  assert.equal(await page.inputValue("#kName"), "Acme Flow 2");
  await page.click("#kSave");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.products"))[0].name === "Acme Flow 2");
  const saved = (await ls(page, "cold.products"))[0];
  assert.equal(saved.proof.find(p => p.id === "pr1").external, false);
  assert.equal(saved.proof.find(p => p.id === "pr2").external, false);
  await page.selectOption("#kProduct", "p2");
  assert.equal(await page.inputValue("#kName"), "Beacon");
  await t.close();
});

test("Knowledge and Compose share the product list: Add-another goes to a blank editor; 'Write an email with this' selects the product", { skip: SKIP }, async () => {
  const t = await open({ seed: { "cold.products": [P1, P2] } }); const { page } = t;
  await page.selectOption("#rProduct", "__new");
  await page.waitForURL(/#\/knowledge$/);
  assert.equal(await page.inputValue("#kName"), "");
  assert.equal(await page.textContent(".savebar .status"), "Not saved yet");
  await page.fill("#kName", "Delta"); await page.fill("#kWhat", "Delta does a thing."); await page.click("#kSave");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.products")).length === 3);
  await page.selectOption("#kProduct", "p2");
  await page.click("#kCompose"); await page.waitForURL(/#\/compose$/);
  assert.equal(await page.inputValue("#rProduct"), "p2");
  assert.equal(await page.locator("#rProduct option").count(), 4);
  await t.close();
});

test("saving fails loudly when browser storage is full, and nothing is reported as saved", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await go(page, "knowledge");
  await page.evaluate(() => { Storage.prototype.setItem = () => { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; }; });
  await page.fill("#kName", "Renamed"); await page.click("#kSave");
  await page.waitForFunction(() => /storage is full/.test(document.querySelector(".savebar .status").textContent));
  assert.equal(await page.locator(".toast:has-text('saved')").count(), 0);
  assert.equal(await page.textContent("#kProduct option:checked"), "Acme Flow");
  await t.close();
});

test("tweet mode: validation, generation, counter and copy", { skip: SKIP }, async () => {
  mock.tweet = "Nice point. Moving workloads is the hard part.";
  const t = await open({ seed: SEED }); const { page } = t;
  await page.check("#fmt-tweet"); await page.check("#tk-reply");
  assert.equal(await page.isVisible("#emailGroup"), false);
  await page.fill("#tweetUrl", "https://example.com/nope"); await page.fill("#tweetContext", "Moving workloads is hard");
  await page.click("#genBtn");
  assert.match(await page.textContent("#tweetUrl-err"), /valid x\.com or twitter\.com status link/);
  await page.fill("#tweetUrl", "");
  await page.click("#genBtn"); await page.waitForSelector("#tweetDraft");
  assert.equal(await page.inputValue("#tweetDraft"), mock.tweet);
  assert.match(await page.textContent("#out"), /\d+ \/ 280 characters/);
  await page.getByRole("button", { name: "Copy tweet" }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), mock.tweet);
  await page.fill("#tweetDraft", "x".repeat(300));
  assert.equal(await page.getByRole("button", { name: "Copy tweet" }).isDisabled(), true);
  await t.close();
});

test("optional server access code: required field appears, missing code is explained, entering it works", { skip: SKIP }, async () => {
  const t = await open({ server: locked, seed: SEED }); const { page } = t;
  await page.getByText("Connection and model").click();
  assert.ok(await page.isVisible("#accessCode"));
  await fillCompose(page); await page.click("#genBtn");
  await page.waitForSelector("#genError");
  assert.match(await page.textContent("#genError"), /access code/);
  assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0);
  await page.fill("#accessCode", "pilot-code"); await page.press("#accessCode", "Tab");
  await page.click("#genBtn"); await page.waitForSelector("#eSubject");
  const open2 = await open({ seed: SEED }); await open2.page.getByText("Connection and model").click();
  assert.match(await open2.page.textContent("#connectionPanel"), /no access code/i);
  await t.close(); await open2.close();
});

for (const [w, h] of [[375, 700], [768, 900], [1280, 800]]) {
  test(`responsive ${w}px: no horizontal overflow on any view; primary workflow completes`, { skip: SKIP }, async () => {
    const t = await open({ viewport: { width: w, height: h }, seed: { "cold.products": [P1, P2], "cold.emails": [EMAIL(), EMAIL({ id: "e2", status: "sent" })] } }); const { page } = t;
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    for (const v of ["compose", "knowledge", "history"]) { await page.click(`#nav-${v}`); assert.ok((await overflow()) <= 0, `${v} overflows at ${w}px`); }
    await go(page, "compose");
    if (w <= 640) { const box = await page.locator(".primary-nav").boundingBox(); assert.ok(Math.abs(box.y + box.height - h) < 2, "primary nav is a bottom bar on phones"); }
    await fillCompose(page); await page.click("#genBtn"); await page.waitForSelector("#eSubject");
    await page.locator("#copyEmail").scrollIntoViewIfNeeded();
    assert.ok(await page.locator("#copyEmail").isVisible());
    await page.click("#copyEmail"); await page.waitForSelector(".toast:has-text('copied')");
    assert.ok((await overflow()) <= 0, `draft view overflows at ${w}px`);
    assert.deepEqual(t.errors, []); await t.close();
  });
}

for (const scheme of ["light", "dark"]) {
  test(`accessibility (${scheme}): axe finds no WCAG A/AA violations on any view or state`, { skip: SKIP }, async () => {
    const t = await open({ colorScheme: scheme, bypassCSP: true, seed: { "cold.products": [P1, P2], "cold.emails": [EMAIL(), EMAIL({ id: "e2", status: "replied" })] } }); const { page } = t;
    const scan = async label => {
      await page.addScriptTag({ path: AXE });
      const r = await page.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }));
      assert.deepEqual(r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(" | ")}`), [], `axe violations in ${label}`);
    };
    await scan("compose (empty)");
    await page.click("#genBtn"); await scan("compose (validation errors)");
    await fillCompose(page); await generate(page);
    await page.locator("details.panel > summary").evaluateAll(els => els.forEach(e => e.parentElement.open = true));
    await scan("compose (draft, all panels open)");
    await go(page, "knowledge"); await scan("knowledge");
    await page.evaluate(() => document.querySelectorAll("#view-knowledge details").forEach(d => d.open = true)); await scan("knowledge (all open)");
    await go(page, "history"); await scan("history");
    await t.close();
  });
}

test("keyboard: skip link, nav, form submit with Enter, visible focus, reduced motion", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED, reducedMotion: "reduce" }); const { page } = t;
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.className), "skip");
  let id = "";
  for (let i = 0; i < 6 && !id.startsWith("nav-"); i++) { await page.keyboard.press("Tab"); id = await page.evaluate(() => document.activeElement.id); }
  assert.equal(id, "nav-compose");
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, parseFloat(s.outlineWidth)]; });
  assert.ok(ring[0] !== "none" && ring[1] >= 2, "focused control must show an outline");
  await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
  await page.waitForURL(/#\/history$/);
  await go(page, "compose");
  await fillCompose(page); mock.delayMs = 300;
  await page.focus("#rName"); await page.keyboard.press("Enter");
  await page.waitForSelector(".progress");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".progress li.on .dot")).animationName), "none", "no animation under reduced motion");
  await page.waitForSelector("#eSubject");
  assert.equal(mock.prompts.length, 2);
  await t.close();
});

test("a note typed on the draft is not lost when the user marks it sent from History straight away", { skip: SKIP }, async () => {
  const t = await open({ seed: SEED }); const { page } = t;
  await fillCompose(page); await generate(page);
  const id = (await ls(page, "cold.emails"))[0].id;
  await page.fill("#eNote", "Typed just before leaving");
  await go(page, "history");                                                        // well inside the 700 ms save delay
  await row(page, "Sam Ortiz").locator(".hMarkSent").click();
  await page.waitForFunction(i => { const e = JSON.parse(localStorage.getItem("cold.emails")).find(x => x.id === i); return e.status === "sent" && e.note === "Typed just before leaving"; }, id, { timeout: 8000 });
  const rec = await stored(page, id);
  assert.deepEqual([rec.status, rec.note, typeof rec.sentCopy.text], ["sent", "Typed just before leaving", "string"]);
  await t.close();
});

test("desktop UI: the hub's Settings shows the model form, the pairing code, and lets the user choose which web pages may sync", { skip: SKIP }, async () => {
  const { createDb } = require("../lib/db");
  const dir = hubDir(), port = await freePort(), hub = await startHub(dir, port);
  const db = createDb(path.join(dir, "cold.db"));
  const t = await open({ server: hub }); const { page } = t;
  try {
    await go(page, "settings"); await page.waitForSelector("#extCode");
    assert.deepEqual(await page.$$eval("#view-settings .set-section h2", h => h.map(x => x.textContent)), ["Model", "Browser extension & web apps", "Your data"]);
    assert.ok(await page.isVisible("#setProvider") && await page.locator("#setKey").count() === 1, "the desktop app owns provider keys, so it offers them");
    assert.equal(await page.inputValue("#extCode"), db.extensionToken());
    assert.equal(await page.locator("#hubConnect").count(), 0, "the hub does not connect to itself");
    // approving pages: invalid entries are refused with a reason; valid ones take effect on the hub immediately
    await page.fill("#webOrigins", "https://*.example.com"); await page.click("#saveOrigins");
    await page.waitForFunction(() => /web address|Each entry/.test(document.querySelector("#saveOrigins").closest(".field").innerText));
    assert.deepEqual(db.webOrigins(), []);
    await page.fill("#webOrigins", "https://cold.example.com/\nhttp://127.0.0.1:3000"); await page.click("#saveOrigins");
    await page.waitForFunction(() => /2 allowed/.test(document.querySelector("#saveOrigins").closest(".field").innerText));
    assert.deepEqual(db.webOrigins(), ["https://cold.example.com", "http://127.0.0.1:3000"]);
    assert.equal(await page.inputValue("#webOrigins"), "https://cold.example.com\nhttp://127.0.0.1:3000");
    // the code can be replaced, which cuts every paired surface off until it is re-entered
    const old = db.extensionToken();
    await page.click("text=Create a new code"); await page.click("button:has-text('Create new code')");
    await page.waitForFunction(o => { const el = document.querySelector("#extCode"); return !!el && el.value !== o; }, old);   // the section repaints, so the field is briefly absent
    assert.notEqual(db.extensionToken(), old);
  } finally { await t.close(); hub.stop(); db.close(); }
});

test("history: an unfamiliar status is shown as Unknown, offers no Draft-only action, survives a note, and changes only by a deliberate choice", { skip: SKIP }, async () => {
  const seed = { "cold.products": [P1], "cold.emails": [EMAIL({ id: "odd", status: "scheduled", sentAt: 77, futureField: { keep: true }, recipient: { name: "Ola Odd", company: "OddCo", phone: "555" } })] };
  const t = await open({ seed }); const { page } = t;
  await go(page, "history");
  const r = row(page, "Ola Odd");
  assert.match(await r.locator(".ctl .chip").first().textContent(), /Unknown status/);
  assert.equal(await r.locator(".hMarkSent").count() + await r.locator(".hRecordReply").count(), 0, "no Draft-only or sent-only action is offered");
  assert.match(await page.locator(".hfilters .btn", { hasText: "Unknown status" }).textContent(), /1/);
  // an unrelated edit keeps the stored status and the fields this version doesn't know
  await r.locator(".hToggle").click(); await r.locator(".hNote").fill("called, no answer");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.emails"))[0].note === "called, no answer");
  const kept = (await ls(page, "cold.emails"))[0];
  assert.deepEqual([kept.status, kept.sentAt, kept.futureField, kept.recipient.phone], ["scheduled", 77, { keep: true }, "555"]);
  // choosing the "Unknown status" entry again does nothing; choosing a supported status is the explicit correction
  await r.locator("select.hStatus").selectOption("unknown");
  assert.equal((await ls(page, "cold.emails"))[0].status, "scheduled");
  await r.locator("select.hStatus").selectOption("replied");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.emails"))[0].status === "replied");
  await page.evaluate(() => document.activeElement.blur());   // History waits to redraw while a note box has focus
  await page.waitForFunction(() => !document.querySelector("select.hStatus option[value=unknown]"));   // once corrected, Unknown is no longer offered
  await t.close();
});

test("history: a note typed and left within the save delay is saved when the box loses focus, not discarded", { skip: SKIP }, async () => {
  const seed = { "cold.products": [P1], "cold.emails": [EMAIL({ id: "a", recipient: { name: "Alpha Person", company: "A" } }), EMAIL({ id: "b", recipient: { name: "Bravo Person", company: "B" } })] };
  const t = await open({ seed }); const { page } = t;
  await go(page, "history");
  const a = row(page, "Alpha Person"); await a.locator(".hToggle").click(); await a.locator(".hNote").fill("typed, then focus moved on");
  await row(page, "Bravo Person").locator(".hToggle").click();            // focus leaves the note box well inside the 600 ms pause
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("cold.emails")).find(e => e.id === "a").note === "typed, then focus moved on");
  assert.deepEqual(t.errors, []); await t.close();
});
