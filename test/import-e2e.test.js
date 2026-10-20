// Browser end-to-end for "Import from repository". The model is a MOCK returning canned JSON, and the project is a ZIP built in memory:
// these tests prove the review/safety behaviour (nothing added or approved without a click, existing data kept), not output quality.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const env = require("./helpers/env");
const { makeZip } = require("./helpers/archives");

const SKIP = env.browserAvailable() ? false : "Chromium or playwright-core is not available";
const AXE = path.join(__dirname, "../node_modules/axe-core/axe.min.js");

const README = "# Replayly\n\nReplayly records every change to your application state and lets you replay the recorded operations later.\n\nTransaction sets do not automatically add a __version field.\nBlazing fast and trusted by 500 customers.\n";
const SRC = "export function replay(log) {\n  return log.reduce((s, op) => apply(s, op), {});\n}\n";
const TEST = "test('replay restores recorded state', () => {\n  expect(replay(record({ a: 1 }))).toEqual({ a: 1 });\n});\n";
const PKG = JSON.stringify({ name: "replayly", license: "MIT", homepage: "https://replayly.dev" }, null, 2);
const zipOf = (readme = README) => makeZip({ "proj/README.md": readme, "proj/src/index.js": SRC, "proj/test/replay.test.js": TEST, "proj/package.json": PKG });

const A = { name: { text: "Replayly" }, what: { text: "A library that records every change to your app state so you can replay it later.", evidence: [{ id: "E1", quote: "records every change to your application state and lets you replay the recorded operations" }] }, oneLiner: { text: "Record and replay app state" }, conflict: "" };
const B = { who: { text: "" }, problem: { text: "" }, overview: { text: "" }, approved: [] };
const C = {
  techFacts: [
    { text: "Replaying recorded operations restores state.", evidence: [{ id: "E3", quote: "return log.reduce((s, op) => apply(s, op), {});" }] },
    { text: "Transaction sets do not automatically add a __version field.", kind: "limitation", evidence: [{ id: "E1", quote: "Transaction sets do not automatically add a __version field." }] },
  ],
  proof: [
    { claim: "Replayable application state", type: "Technical", explanation: "Implemented and tested.", evidence: [{ id: "E3", quote: "return log.reduce((s, op) => apply(s, op), {});" }, { id: "E4", quote: "replay restores recorded state" }] },
    { claim: "Trusted by 500 customers", type: "Customer", evidence: [{ id: "E1", quote: "trusted by 500 customers" }] },
  ],
  dontSay: [],
};
const importReply = prompt => (prompt.includes("TASK: say what this product does") ? A : prompt.includes("TASK: complete the profile") ? B : prompt.includes('"techFacts"') ? C : undefined);

let browser, mock, srv;
before(async () => { if (SKIP) return; mock = await env.startMock(); mock.custom = importReply; srv = await env.startColdServer({ mockUrl: mock.url }); browser = await env.launch(); });
after(async () => { if (SKIP) return; await browser.close(); srv.stop(); mock.server.close(); });

async function open(seed, { bypassCSP = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, bypassCSP });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  if (seed) await page.addInitScript(s => { if (!sessionStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); sessionStorage.setItem("__seeded", "1"); } }, seed);
  await page.goto(srv.base + "/#/knowledge");
  await page.waitForSelector("#view-knowledge", { state: "visible" });
  return { page, errors, close: () => context.close() };
}
async function runImport(page, buffer, trigger) {
  await page.click(trigger);
  await page.waitForSelector("#impZip");
  await page.setInputFiles("#impZip", { name: "proj.zip", mimeType: "application/zip", buffer });
  await page.click("dialog.import-dlg button[value=go]");
  await page.waitForSelector(".import-review", { timeout: 20000 });
}
const card = (page, label) => page.locator(`.import-card[aria-label^="${label}"]`).first();
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("cold.products")));

test("importing into an empty product adds nothing until accepted, and imported proof is internal-only", { skip: SKIP }, async () => {
  const t = await open(); const { page } = t;
  await page.waitForSelector("#emptyImport");
  await runImport(page, zipOf(), "#emptyImport");
  assert.match(await page.textContent(".import-review"), /Nothing has been added or approved yet/);
  assert.equal(await page.inputValue("#kWhat"), "", "the editor is untouched by the import itself");
  assert.equal(await page.locator("#view-knowledge .proof").count(), 0);

  // statuses are computed from evidence, not taken from the model
  assert.match(await card(page, "What it does").textContent(), /Inferred/);
  assert.match(await card(page, "Technical fact: verified").first().textContent(), /Verified/);
  const risky = card(page, "Proof: needs_evidence");
  assert.match(await risky.textContent(), /Needs evidence/);
  assert.match(await risky.textContent(), /keep internal-only/i);
  assert.equal(await risky.getByText("Add and approve for external use").count(), 0, "an unsupported claim can't be approved from the import");
  assert.match(await page.textContent(".import-review"), /Not found/);

  // excerpts link to the pinned revision's file (zip: no link) and show where the text came from
  await card(page, "Technical fact: verified").locator("summary").click();
  assert.match(await card(page, "Technical fact: verified").textContent(), /src\/index\.js:2/);

  await card(page, "What it does").getByRole("button", { name: "Use this" }).click();
  assert.match(await page.inputValue("#kWhat"), /records every change to your app state/);
  await card(page, "Proof: verified").getByRole("button", { name: "Add as internal-only" }).click();
  assert.equal(await page.locator("#view-knowledge .proof.internal").count(), 1);
  assert.equal(await page.locator("#view-knowledge .proof:not(.internal)").count(), 0, "nothing was approved for external use");
  await page.click(".import-card:has-text('Technical fact') >> text=Discard");
  await page.fill("#kName", "Replayly");
  await page.click("#impDone");
  await page.click("#kSave"); await page.waitForSelector("#kForm .status:has-text('Saved')");
  const [p] = await stored(page);
  assert.equal(p.proof.length, 1); assert.equal(p.proof[0].external, false);
  assert.match(p.proof[0].evidence, /src\/index\.js:\d/);
  assert.equal(p.importSource.host, "upload");
  assert.ok(p.provenance.length >= 2 && p.provenance.every(r => r.commit.startsWith("zip-sha256:")));
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("a verified proof point can be approved with one explicit click; Enter inside a suggestion doesn't save the product", { skip: SKIP }, async () => {
  const t = await open(); const { page } = t;
  await runImport(page, zipOf(), "#emptyImport");
  await page.fill("#kName", "Replayly");
  await card(page, "Proof: verified").locator("input").press("Enter");
  assert.equal((await stored(page)) || null, null, "Enter did not submit the product form");
  await card(page, "Proof: verified").getByRole("button", { name: "Add and approve for external use" }).click();
  assert.equal(await page.locator("#view-knowledge .proof:not(.internal)").count(), 1);
  await t.close();
});

test("existing wording and approved proof are preserved; a replacement needs its own click", { skip: SKIP }, async () => {
  const APPROVED = { id: "pr1", claim: "Cut trial stall for one design partner", evidence: "Pilot, March", type: "Customer", strength: "High", external: true };
  const mine = { id: "p1", name: "Replayly", order: 0, what: "My own careful sentence about what it does.", who: "", problem: "", proof: [APPROVED], techFacts: [], approved: [], dontSay: ['"magic"'] };
  const t = await open({ "cold.products": [mine] }); const { page } = t;
  await runImport(page, zipOf(), "#kImport");
  const what = card(page, "What it does");
  assert.match(await what.textContent(), /Replaces your text/);
  assert.match(await what.textContent(), /My own careful sentence/);
  assert.equal(await page.inputValue("#kWhat"), mine.what, "still the user's text");
  await what.getByRole("button", { name: "Discard" }).click();
  assert.equal(await page.inputValue("#kWhat"), mine.what);
  // prohibited-phrase suggestions are offered for the project's own hype; the user's existing rule stays
  const dont = page.locator('.import-card[aria-label^="Prohibited phrase"]');
  assert.ok(await dont.count() >= 1);
  await dont.first().getByRole("button", { name: "Add" }).click();
  const lines = (await page.inputValue("#kDont")).split("\n");
  assert.equal(lines[0], '"magic"'); assert.ok(lines.length >= 2);
  await page.click("#impDone"); await page.click("#kSave"); await page.waitForSelector("#kForm .status:has-text('Saved')");
  const [p] = await stored(page);
  assert.equal(p.what, mine.what);
  assert.deepEqual(p.proof.filter(r => r.id === "pr1")[0], APPROVED);
  await t.close();
});

test("refresh flags evidence that changed, and never changes an approved claim on its own", { skip: SKIP }, async () => {
  const t = await open(); const { page } = t;
  await runImport(page, zipOf(), "#emptyImport");
  await page.fill("#kName", "Replayly");
  await card(page, "Proof: verified").getByRole("button", { name: "Add and approve for external use" }).click();
  await page.click("#impDone"); await page.click("#kSave"); await page.waitForSelector("#kForm .status:has-text('Saved')");
  // the project changes: replay is removed from the source and the test
  const changed = makeZip({ "proj/README.md": README, "proj/package.json": PKG, "proj/src/index.js": "export const noop = () => {};\n" });
  await runImport(page, changed, "#kImport");
  const flagged = page.locator('.import-card[aria-label$="needs a look"]');
  assert.ok(await flagged.count() >= 1, "the approved proof is flagged");
  assert.match(await flagged.first().textContent(), /Approved for external use/);
  assert.match(await flagged.first().textContent(), /stays approved until you change it/);
  assert.equal(await page.locator("#view-knowledge .proof:not(.internal)").count(), 1, "still approved");
  await flagged.first().getByRole("button", { name: "Move to internal-only" }).click();
  assert.equal(await page.locator("#view-knowledge .proof:not(.internal)").count(), 0);
  assert.equal(await page.locator("#view-knowledge .proof.internal").count(), 1);
  await t.close();
});

test("the review panel has no accessibility violations", { skip: SKIP }, async () => {
  const t = await open(null, { bypassCSP: true }); const { page } = t;
  await runImport(page, zipOf(), "#emptyImport");
  await page.addScriptTag({ path: AXE });
  const res = await page.evaluate(() => axe.run(".import-review", { runOnly: ["wcag2a", "wcag2aa"] }));
  assert.deepEqual(res.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).slice(0, 2).join(" | ")}`), []);
  await t.close();
});

test("a model failure shows a readable error in the dialog and keeps the dialog open", { skip: SKIP }, async () => {
  const t = await open(); const { page } = t;
  await page.click("#emptyImport");
  await page.fill("#impUrl", "https://example.com/not/github");
  await page.click("dialog.import-dlg button[value=go]");
  await page.waitForSelector("#impErr:not([hidden])");
  assert.match(await page.textContent("#impErr"), /GitHub repository address/);
  await page.click("#impSkip");
  assert.equal(await page.locator("dialog.import-dlg").count(), 0);
  await t.close();
});
