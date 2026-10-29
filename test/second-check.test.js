// The "Second check" panel on a draft, in a real browser against the real server and a MOCK model (canned answers). Proves the plumbing
// and wording, not the quality of any model's judgement.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const env = require("./helpers/env");
const SKIP = env.browserAvailable() ? false : "Chromium or playwright-core is not available";
const P1 = { id: "p1", name: "Acme Flow", order: 0, what: "Acme Flow turns a signup into a first booked job for plumbers.", who: "Plumbing shops", problem: "Trials stall.", proof: [], techFacts: [], approved: [], dontSay: [] };
const EMAIL = { id: "e1", createdAt: Date.now() - 1000, status: "draft", mode: "email", goal: "advice", productId: "p1", productName: "Acme Flow", recipient: { name: "Ada Park", role: "COO", company: "PipeCo", why: "Posted about onboarding" }, subject: "trial drop-off", what: "Acme Flow turns a signup into a first booked job for plumbers.", why: "You wrote that most trial users stall before inviting a teammate.", ask: "Could I get your take on how you handle that?", checks: [], claims: [], updatedAt: 1 };
const GOOD = { opens_with_problem: { a: "yes", c: "high" }, subject_matches: { a: "yes", c: "high" }, reason_specific: { a: "specific", c: "high" }, invented_fact: { a: "no", c: "high" }, commonality: { a: "no", c: "high" }, proof_count: { a: "none", c: "medium" }, ask_kind: { a: "advice", c: "high" }, jargon: { a: "no", c: "high" } };

let browser, mock, srv;
before(async () => { if (SKIP) return; mock = await env.startMock(); srv = await env.startColdServer({ mockUrl: mock.url }); browser = await env.launch(); });
after(async () => { if (SKIP) return; await browser.close(); srv.stop(); mock.server.close(); });

async function openDraft() {
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } }); const page = await context.newPage();
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  await page.addInitScript(d => { if (!sessionStorage.getItem("__s")) { localStorage.setItem("cold.products", JSON.stringify(d.p)); localStorage.setItem("cold.emails", JSON.stringify(d.e)); sessionStorage.setItem("__s", "1"); } }, { p: [P1], e: [EMAIL] });
  await page.goto(srv.base + "/#/history"); await page.waitForSelector(".hrow");
  await page.click(".hrow button:text-is('Open')"); await page.waitForSelector("#secondRun");
  return { page, context, errors };
}

test("Second check: runs only on request, shows each answer with its meaning, goes stale when the draft is edited, and changes nothing", { skip: SKIP }, async () => {
  mock.decide = { answers: { ...GOOD, invented_fact: { a: "yes", c: "high", q: "Acme Flow turns a signup into a first booked job" }, reason_specific: { a: "generic", c: "low" } } };
  const { page, context, errors } = await openDraft();
  const draftBefore = await page.inputValue("#eWhat");
  assert.equal(mock.prompts.filter(p => p.includes('Return ONLY JSON: {"answers"')).length, 0, "nothing is asked until the button is pressed");
  assert.match(await page.textContent("#secondCheck"), /independent second opinion.*doesn't change the score/s);
  await page.click("#secondRun"); await page.waitForSelector("#secondSummary");
  assert.equal(mock.prompts.filter(p => p.includes('Return ONLY JSON: {"answers"')).length, 1, "one call for all eight questions");
  assert.match(await page.textContent("#secondSummary"), /1 thing worth a look/);
  const st = await page.$$eval("#secondResult li", li => Object.fromEntries(li.map(x => [x.dataset.rule, x.dataset.status])));
  assert.deepEqual(st, { 1: "ok", 11: "unchecked", 15: "concern", 12: "ok", 20: "ok", 13: "ok", 17: "ok", 8: "ok" });
  assert.match(await page.textContent('#secondResult li[data-rule="15"]'), /Look at: “Acme Flow turns a signup into a first booked job”/);
  assert.match(await page.textContent('#secondResult li[data-rule="11"]'), /wasn't sure/);
  assert.equal(await page.isVisible("#secondStale"), false);
  await page.fill("#eAsk", "Could I get your take on how you handle trial stalls?"); await page.waitForFunction(() => !document.querySelector("#secondStale").hidden);
  assert.equal(await page.inputValue("#eWhat"), draftBefore);
  assert.deepEqual(errors, []); await context.close();
});

test("Second check: a model that can't answer says so; the draft and the page keep working", { skip: SKIP }, async () => {
  mock.decide = { nonsense: true };
  const { page, context } = await openDraft();
  await page.click("#secondRun"); await page.waitForSelector("#secondSummary");
  assert.equal(await page.locator("#secondResult li[data-status='unchecked']").count(), 8); assert.equal(await page.locator("#secondResult li[data-status='concern']").count(), 0);
  assert.equal(await page.isEnabled("#secondRun"), true); await context.close();
});
