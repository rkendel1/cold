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
  await go(page, "history"); await page.click(".hrow button:has-text('Open')"); await page.waitForSelector("#eTo");
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
  await page.getByRole("button", { name: "Open" }).click();
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
