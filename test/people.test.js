// Email lookup through treg. Every treg answer here is a CANNED one (a mocked fetch, or a preloaded stand-in for treg.to in a spawned
// server): these tests prove Cold's request building, evidence wording, persistence and credential handling, not that treg or any
// provider returns correct addresses. See docs/people-search.md for what was and wasn't run against the real service.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const env = require("./helpers/env");
const shared = require("../lib/people-shared");
const treg = require("../lib/treg");

const TOKEN = "tg_live_SECRET1234";
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const mockFetch = (...answers) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); const a = answers[Math.min(calls.length, answers.length) - 1]; if (a instanceof Error) throw a; return a; }; f.calls = calls; return f; };
const HIT = { output: { email: "priya@northwind.io", confidence: 0.82, verified: false, first_name: "Priya", last_name: "Nair", } , raw: { secret: "provider payload" }, _treg: { served_by: "hunter.people.email.find", tried: ["quickenrich.people.email.find", "hunter.people.email.find"], charged_micro: 4834 } };
const fresh = () => treg._busy.clear();

test("request: only what the user holds, nothing guessed; missing pieces are reported", () => {
  assert.deepEqual(shared.buildFindRequest({ name: "Priya Nair", profileUrl: "linkedin.com/in/priya-nair" }), { ok: true, body: { linkedin_url: "https://www.linkedin.com/in/priya-nair" }, using: ["LinkedIn profile link"] });
  assert.deepEqual(shared.buildFindRequest({ name: "Priya Nair", domain: "https://www.Northwind.io/about" }).body, { full_name: "Priya Nair", domain: "northwind.io" });
  assert.deepEqual(Object.keys(shared.buildFindRequest({ name: "Priya", profileUrl: "https://www.linkedin.com/in/p-n", domain: "northwind.io" }).body).sort(), ["domain", "full_name", "linkedin_url"]);
  for (const bad of [{ name: "Priya Nair" }, { name: "Priya", profileUrl: "https://x.com/priya" }, { name: "", domain: "northwind.io" }, { name: "Priya", domain: "priya@northwind.io" }, { name: "Priya", domain: "localhost" }]) {
    const r = shared.buildFindRequest(bad); assert.equal(r.ok, false, JSON.stringify(bad)); assert.match(r.message, /LinkedIn|domain/);
  }
});

test("verification wording: deliverability is never presented as identity; unknown stays unknown", () => {
  assert.equal(shared.verdictCopy("valid").tone, "good"); assert.match(shared.verdictCopy("valid").detail, /doesn't show it belongs/);
  assert.equal(shared.verdictCopy("accept_all").tone, "warn"); assert.match(shared.verdictCopy("accept_all").detail, /can't tell/);
  assert.equal(shared.verdictCopy("invalid").tone, "bad");
  for (const x of [null, undefined, "", "unknown"]) assert.equal(shared.verdictCopy(x).label, "Couldn't be determined");
  const odd = shared.verdictCopy("deliverable_maybe"); assert.equal(odd.tone, "neutral"); assert.notEqual(odd.tone, "good");
});

test("find: calls only treg.people.email.find with the cost cap in a header and the token only in a header; a hit is a candidate with nothing invented", async () => {
  fresh(); const f = mockFetch(json(200, HIT));
  const r = await treg.findEmail({ name: "Priya Nair", linkedin: "https://www.linkedin.com/in/priya-nair", domain: "northwind.io", extra: "ignored", pageText: "must never be sent" }, { token: TOKEN, fetchImpl: f, env: {} });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, "https://treg.to/call/treg.people.email.find"); assert.equal(init.method, "POST");
  assert.equal(init.headers["x-treg-token"], TOKEN); assert.equal(init.headers["x-treg-route-max-cost"], "0.05");
  assert.deepEqual(JSON.parse(init.body), { linkedin_url: "https://www.linkedin.com/in/priya-nair", full_name: "Priya Nair", domain: "northwind.io" });
  assert.ok(!url.includes(TOKEN) && !init.body.includes(TOKEN));
  assert.equal(r.ok, true); assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.candidates[0], { email: "priya@northwind.io", provider: "hunter.people.email.find", confidence: 0.82, providerChecked: false, source: null, name: "Priya Nair" });
  assert.equal(r.chargedUsd, 0.004834); assert.deepEqual(r.tried, HIT._treg.tried);
  assert.ok(!JSON.stringify(r).includes("provider payload"), "the raw provider payload isn't passed on"); assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test("find: missing confidence and checks stay unknown; the cost cap can be lowered by the operator but not removed", async () => {
  fresh(); const f = mockFetch(json(200, { output: { email: "a@b.io" }, _treg: {} }));
  const r = await treg.findEmail({ name: "A B", domain: "b.io" }, { token: TOKEN, fetchImpl: f, env: { COLD_TREG_MAX_COST: "0.01" } });
  assert.deepEqual(r.candidates[0], { email: "a@b.io", provider: null, confidence: null, providerChecked: null, source: null, name: null });
  assert.equal(f.calls[0].init.headers["x-treg-route-max-cost"], "0.01");
  assert.equal(treg.maxCost("find", { COLD_TREG_MAX_COST: "50" }), 0.05); assert.equal(treg.maxCost("find", { COLD_TREG_MAX_COST: "abc" }), 0.05);
});

test("find: not configured, not enough information, a miss, a garbage address and provider errors never produce a candidate or leak the token", async () => {
  fresh();
  assert.equal((await treg.findEmail({ name: "A B", domain: "b.io" }, { token: "", fetchImpl: mockFetch() })).code, "not_configured");
  const none = mockFetch(); const insufficient = await treg.findEmail({ name: "A B" }, { token: TOKEN, fetchImpl: none });
  assert.equal(insufficient.code, "insufficient"); assert.equal(none.calls.length, 0, "no request without enough information");
  const miss = await treg.findEmail({ name: "A B", domain: "b.io" }, { token: TOKEN, fetchImpl: mockFetch(json(200, { output: { email: null }, _treg: { tried: ["x"], charged_micro: 0 } })) });
  assert.deepEqual([miss.ok, miss.candidates.length], [true, 0]);
  const junk = await treg.findEmail({ name: "A B", domain: "c.io" }, { token: TOKEN, fetchImpl: mockFetch(json(200, { output: { email: "not an email" } })) });
  assert.equal(junk.ok, false); assert.equal(junk.code, "bad_result");
  for (const [status, code] of [[401, "auth"], [402, "balance"], [422, "refused"], [429, "rate_limited"], [503, "unavailable"], [500, "treg_error"]]) {
    fresh(); const r = await treg.findEmail({ name: "A B", domain: "d.io" }, { token: TOKEN, fetchImpl: mockFetch(json(status, { detail: `bad ${TOKEN}`, balance_micro: 0 })) });
    assert.equal(r.ok, false); assert.equal(r.code, code); assert.ok(!JSON.stringify(r).includes(TOKEN), `${status} message must not echo the token or the upstream body`);
  }
  fresh(); const net = await treg.findEmail({ name: "A B", domain: "e.io" }, { token: TOKEN, fetchImpl: mockFetch(Object.assign(new Error(`failed with ${TOKEN}`), { name: "TypeError" })) });
  assert.equal(net.code, "network"); assert.ok(!JSON.stringify(net).includes(TOKEN));
});

test("find: a pending (202) answer blocks a second billable search for the same person, and a call that is still running does too", async () => {
  fresh(); const f = mockFetch(json(202, { _treg: { outcome: "pending", reserved_micro: 5000, charged_micro: null } }), json(200, HIT));
  const first = await treg.findEmail({ name: "A B", domain: "f.io" }, { token: TOKEN, fetchImpl: f });
  assert.equal(first.pending, true); assert.match(first.message, /won't start another/);
  const again = await treg.findEmail({ name: "A B", domain: "f.io" }, { token: TOKEN, fetchImpl: f });
  assert.equal(again.code, "in_progress"); assert.equal(f.calls.length, 1, "no second request while the first may still complete");
  assert.equal((await treg.findEmail({ name: "C D", domain: "f.io" }, { token: TOKEN, fetchImpl: f })).ok, true, "someone else is unaffected");
  fresh(); let release; const slow = async () => { await new Promise(r => { release = r; }); return json(200, HIT); };
  const p1 = treg.findEmail({ name: "A B", domain: "g.io" }, { token: TOKEN, fetchImpl: slow });
  const p2 = await treg.findEmail({ name: "A B", domain: "g.io" }, { token: TOKEN, fetchImpl: slow });
  assert.equal(p2.code, "in_progress"); release(); assert.equal((await p1).ok, true);
});

test("verify: reports treg's own word and nothing stronger; failures are not verification", async () => {
  fresh();
  for (const [out, status] of [[{ valid: true, status: "valid" }, "valid"], [{ valid: false, status: "accept_all" }, "accept_all"], [{ valid: false, status: "invalid" }, "invalid"], [{ status: "unknown" }, "unknown"], [{}, null]]) {
    const f = mockFetch(json(200, { output: out, _treg: { served_by: "zerobounce.people.email.verify", charged_micro: 1500 } }));
    const r = await treg.verifyEmail({ email: "priya@northwind.io" }, { token: TOKEN, fetchImpl: f });
    assert.equal(r.ok, true); assert.equal(r.status, status); assert.equal(r.servedBy, "zerobounce.people.email.verify");
    assert.equal(f.calls[0].url, "https://treg.to/call/treg.people.email.verify"); assert.deepEqual(JSON.parse(f.calls[0].init.body), { email: "priya@northwind.io" });
    assert.equal(f.calls[0].init.headers["x-treg-route-max-cost"], "0.02");
  }
  assert.equal((await treg.verifyEmail({ email: "nope" }, { token: TOKEN, fetchImpl: mockFetch() })).code, "insufficient");
  const bad = await treg.verifyEmail({ email: "x@y.io" }, { token: TOKEN, fetchImpl: mockFetch(json(503, {})) });
  assert.equal(bad.ok, false); assert.equal(bad.status, undefined);
});

test("only the two operations exist, and the token is not in anything the browser receives", () => {
  assert.deepEqual(Object.values(treg.OPS).sort(), ["treg.people.email.find", "treg.people.email.verify"]);
  assert.equal(treg.BASE, "https://treg.to/call/");
  for (const f of ["public/app.js", "public/app.css", "extension/dist/panel.js"]) {
    const p = path.join(__dirname, "..", f); if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    for (const s of ["x-treg-token", "treg.to/call", "x-treg-route-max-cost", "process.env"]) assert.ok(!text.includes(s), `${f} must not contain ${s}`);
  }
});

// ---- the real server (spawned) with a stand-in for treg.to ---------------------------------------------------------------------------
const SKIP = env.browserAvailable() ? false : "Chromium or playwright-core is not available";
let mock, browser, dir; const servers = [];
before(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-people-")); mock = await env.startMock(); if (!SKIP) browser = await env.launch(); });
after(async () => { if (browser) await browser.close(); servers.forEach(s => s.stop()); mock.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
let n = 0;
async function server(script, extra = {}) {
  const log = path.join(dir, `treg-${++n}.log`); fs.writeFileSync(log, "");
  const s = await env.startColdServer({ mockUrl: mock.url, env: { NODE_OPTIONS: `--require ${path.join(__dirname, "helpers/treg-mock-preload.cjs")}`, TREG_MOCK: JSON.stringify(script), TREG_MOCK_LOG: log, ...extra } });
  servers.push(s); s.requests = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); return s;
}
const post = (s, p, body) => fetch(s.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, text: await r.text() }));

test("server: the token never leaves it; /api/config says only whether lookup is set up; the routes accept one person's details and nothing else", async () => {
  const s = await server({ "treg.people.email.find": [{ body: HIT }] }, { TREG_TOKEN: TOKEN });
  const cfg = await (await fetch(s.base + "/api/config")).text();
  assert.match(cfg, /"peopleSearch":true/); assert.ok(!cfg.includes(TOKEN));
  const r = await post(s, "/api/people/email/find", { name: "Priya Nair", linkedin: "https://www.linkedin.com/in/priya-nair", url: "https://evil.example/", headers: { a: 1 }, page: "a whole page of text" });
  assert.equal(r.status, 200); assert.ok(!r.text.includes(TOKEN)); assert.ok(!r.text.includes("provider payload"));
  const seen = s.requests(); assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://treg.to/call/treg.people.email.find"); assert.equal(seen[0].headers["x-treg-token"], TOKEN);
  assert.deepEqual(JSON.parse(seen[0].body), { linkedin_url: "https://www.linkedin.com/in/priya-nair", full_name: "Priya Nair" }.linkedin_url ? { linkedin_url: "https://www.linkedin.com/in/priya-nair" } : {}, "only the lookup fields are forwarded");
  assert.equal((await fetch(s.base + "/api/people/email/find", { method: "POST", body: "not json{" })).status, 400);
  const off = await server({}, {});
  assert.match(await (await fetch(off.base + "/api/config")).text(), /"peopleSearch":false/);
  const none = await post(off, "/api/people/email/find", { name: "A B", domain: "b.io" });
  assert.match(none.text, /not_configured/); assert.equal(off.requests().length, 0, "no request to treg without a token");
});

test("settings: a saved token is write-only (last four characters only), reaches no page, and removing it turns lookup off", async () => {
  const file = path.join(dir, "settings.json");
  const s = await server({ "treg.people.email.find": [{ body: HIT }] }, { COLD_SETTINGS_FILE: file });
  const put = await fetch(s.base + "/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ integrations: { treg: { apiKey: TOKEN } } }) });
  const snap = await put.text();
  assert.ok(!snap.includes(TOKEN)); assert.deepEqual(JSON.parse(snap).integrations.treg, { hasKey: true, keyHint: "1234", keyFromEnv: false });
  assert.ok(!(await (await fetch(s.base + "/api/settings")).text()).includes(TOKEN));
  assert.match(await (await fetch(s.base + "/api/config")).text(), /"peopleSearch":true/);
  assert.equal((await post(s, "/api/people/email/find", { name: "A B", domain: "b.io" })).status, 200);
  assert.equal(s.requests()[0].headers["x-treg-token"], TOKEN);
  assert.match(fs.readFileSync(file, "utf8"), /integrations/);
  const bad = await fetch(s.base + "/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ integrations: { evil: { apiKey: "x" } } }) });
  assert.equal(bad.status, 400);
  await fetch(s.base + "/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ integrations: { treg: { apiKey: null } } }) });
  assert.match(await (await fetch(s.base + "/api/config")).text(), /"peopleSearch":false/);
});

const LEAD = { id: "l1", name: "Priya Nair", company: "Northwind", role: "Head of Platform", email: "", profileUrl: "https://www.linkedin.com/in/priya-nair", why: "Writes about moving batch jobs to the edge", product: "", goal: "advice", list: "Q4", notes: "Met at the infra meetup", source: "manual", createdAt: 1700000000000, updatedAt: 1700000000000 };
const NOURL = { ...LEAD, id: "l2", name: "Sam Okafor", profileUrl: "", company: "Okafor Labs" };
const P1 = { id: "p1", name: "Acme Edge", order: 0, what: "Acme Edge runs batch jobs on edge servers.", proof: [], techFacts: [], approved: [], dontSay: [] };
async function open(s, leads = [LEAD]) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } }); const page = await context.newPage();
  const errors = []; page.on("pageerror", e => errors.push(String(e))); page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(d => { if (!sessionStorage.getItem("__s")) { localStorage.setItem("cold.leads", JSON.stringify(d.leads)); localStorage.setItem("cold.products", JSON.stringify(d.products)); sessionStorage.setItem("__s", "1"); } }, { leads, products: [P1] });
  await page.goto(s.base + "/#/leads"); await page.waitForSelector("#leadsTable");
  return { page, context, errors };
}
const stored = (page, id = "l1") => page.evaluate(i => JSON.parse(localStorage.getItem("cold.leads")).find(l => l.id === i), id);
const openFinder = async (page, id = "l1") => { await page.click(`tr[data-id="${id}"] .leadFind`); await page.waitForSelector("#feFind"); };
const VERIFY = (status, valid) => [{ body: { output: { status, valid }, _treg: { served_by: "zerobounce.people.email.verify", charged_micro: 1500 } } }];

test("Find email: the candidate is reviewed with separate evidence, verified on request, saved only on accept, and every other field is kept", { skip: SKIP }, async () => {
  const s = await server({ "treg.people.email.find": [{ body: HIT }], "treg.people.email.verify": VERIFY("accept_all", false) }, { TREG_TOKEN: TOKEN });
  const { page, context, errors } = await open(s);
  await openFinder(page);
  assert.match(await page.textContent("#findEmail"), /Cold sends this person's name and company domain \(or LinkedIn link\) to treg, which may ask other data providers/);
  await page.click("#feFind"); await page.waitForSelector("#feEmail");
  assert.equal(await page.textContent("#feEmail"), "priya@northwind.io");
  const facts = await page.textContent(".fe-facts");
  assert.match(facts, /Found byhunter\.people\.email\.find/); assert.match(facts, /SourceThe provider didn't supply a source/);
  assert.match(facts, /82% as scored by the provider.*not proof/); assert.match(facts, /says it did not check the mailbox/);
  assert.match(await page.textContent("#feVerdict"), /Not checked yet/);
  assert.match(await page.textContent("#feCost"), /\$0\.0048/);
  assert.equal((await stored(page)).email, "", "finding a candidate saves nothing");
  assert.equal(s.requests().length, 1);
  await page.click("#feVerify"); await page.waitForFunction(() => /Accepts all mail/.test(document.querySelector("#feVerdict").textContent));
  assert.match(await page.textContent("#feVerdict"), /can't tell whether this mailbox exists/);
  assert.equal((await stored(page)).email, "", "verifying saves nothing");
  await page.click("#feAccept"); await page.waitForSelector("#feSaved");
  const after = await stored(page);
  assert.deepEqual({ ...after, updatedAt: 0 }, { ...LEAD, email: "priya@northwind.io", updatedAt: 0 }, "only the email changed");
  assert.ok(after.updatedAt > LEAD.updatedAt);
  assert.equal(await page.inputValue("#lf-email"), "priya@northwind.io");
  const reqs = s.requests(); assert.deepEqual(reqs.map(r => r.url.split("/call/")[1]), ["treg.people.email.find", "treg.people.email.verify"]);
  assert.deepEqual(JSON.parse(reqs[0].body), { linkedin_url: "https://www.linkedin.com/in/priya-nair" });
  const html = await page.content(); assert.ok(!html.includes(TOKEN)); assert.ok(!JSON.stringify(await page.evaluate(() => ({ ...localStorage }))).includes(TOKEN));
  await page.click("#leadEditor button:has-text('Cancel')");
  await page.click('tr[data-id="l1"] button[aria-label="Write to Priya Nair"]'); await page.waitForSelector("#rEmail");
  assert.equal(await page.inputValue("#rEmail"), "priya@northwind.io", "the accepted email reaches the drafting form");
  assert.deepEqual(errors, []); await context.close();
});

test("Find email: reject, a miss, a provider error and missing information all leave the lead unchanged and never retry on their own", { skip: SKIP }, async () => {
  const s = await server({ "treg.people.email.find": [{ body: HIT }, { body: { output: { email: null }, _treg: { tried: ["a", "b"], charged_micro: 0 } } }, { status: 402, body: { detail: TOKEN } }] }, { TREG_TOKEN: TOKEN });
  const { page, context } = await open(s, [LEAD, NOURL]);
  await openFinder(page); await page.click("#feFind"); await page.waitForSelector("#feEmail");
  await page.click("#feReject"); await page.waitForSelector("#feRejected");
  assert.equal(await page.isVisible("#feEmail"), false); assert.deepEqual(await stored(page), LEAD);
  await page.click("#feFind"); await page.waitForSelector("#feMiss"); assert.match(await page.textContent("#feMiss"), /no email/i); assert.deepEqual(await stored(page), LEAD);
  await page.click("#feFind"); await page.waitForSelector("#findEmail .notice.bad");
  const err = await page.textContent("#findEmail .notice.bad"); assert.match(err, /balance/); assert.match(err, /didn't retry/); assert.ok(!err.includes(TOKEN));
  assert.deepEqual(await stored(page), LEAD); assert.equal(s.requests().length, 3, "exactly one request per press");
  await page.click("#leadEditor button:has-text('Cancel')");
  await openFinder(page, "l2"); await page.click("#feFind");
  assert.match(await page.textContent("#findEmail .notice"), /LinkedIn profile link.*company's website domain/);
  assert.equal(s.requests().length, 3, "no request without enough information");
  await page.fill("#feDomain", "https://www.okaforlabs.com/team"); await page.click("#feFind"); await page.waitForTimeout(300);
  const last = s.requests().at(-1); assert.equal(s.requests().length, 4);
  assert.deepEqual(JSON.parse(last.body), { full_name: "Sam Okafor", domain: "okaforlabs.com" });
  assert.deepEqual(await stored(page, "l2"), NOURL, "the domain typed for the search is not saved to the lead");
  await context.close();
});

test("Find email: a pending answer locks further searches; an existing email is never offered a replacement; without a token the panel says how to set it up", { skip: SKIP }, async () => {
  const s = await server({ "treg.people.email.find": [{ status: 202, body: { _treg: { outcome: "pending", reserved_micro: 5000 } } }, { body: HIT }] }, { TREG_TOKEN: TOKEN });
  const { page, context } = await open(s, [LEAD, { ...NOURL, email: "sam@okafor.io" }]);
  await openFinder(page); await page.click("#feFind"); await page.waitForSelector("#findEmail .notice.info");
  assert.match(await page.textContent("#findEmail"), /won't start another search/); assert.equal(await page.locator("#feFind").isDisabled(), true);
  assert.equal(s.requests().length, 1); assert.equal((await stored(page)).email, "");
  assert.equal(await page.locator('tr[data-id="l2"] .leadFind').count(), 0, "no Find email for a lead that has an address");
  await page.click('tr[data-id="l2"] .leadEdit'); await page.waitForSelector("#lf-email");
  assert.equal(await page.locator("#findEmail").count(), 0); await context.close();
  const off = await server({}, {}); const t = await open(off); await openFinder(t.page);
  assert.match(await t.page.textContent("#findEmail"), /Email lookup isn't set up/); assert.equal(off.requests().length, 0); await t.context.close();
});
