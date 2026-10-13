// Regenerates the screenshots used in docs/audit/. They are captured from the running app in headless Chromium against the test mocks
// (a canned model and a stand-in Google Sheets API), so they show real UI, not real accounts or real model output.
// Usage: node scripts/audit-screenshots.cjs
const path = require("node:path");
const env = require("../test/helpers/env");
const { startSheetsMock } = require("../test/helpers/sheets-mock");
const OUT = path.join(__dirname, "../docs/audit/screenshots");

const FAKE_GIS = () => { window.google = { accounts: { oauth2: { initTokenClient: cfg => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: "good-token", expires_in: 3600, scope: "https://www.googleapis.com/auth/drive.file" }), 5) }), revoke() {} } } }; };
const P1 = { id: "p1", name: "Acme Flow", order: 1, what: "Scheduling for plumbers", audience: "Plumbing shops", problem: "Missed jobs", proofs: [], facts: [], approved: [], banned: [] };
const LEADS = [["l1", "Ana Ruiz", "Northwind", "ana@northwind.io"], ["l2", "Bo Lee", "Beta Co", "bo@beta.io"]].map(([id, name, company, email], i) => ({ id, name, company, email, list: "Q4", goal: "advice", source: "csv", createdAt: Date.now() - i * 1000 }));
const DUE = { id: "e1", createdAt: Date.now() - 86400000 * 5, status: "draft", mode: "email", goal: "advice", productId: "p1", productName: "Acme Flow", recipient: { name: "Ana Ruiz", company: "Northwind", email: "ana@northwind.io" }, subject: "onboarding", what: "Acme Flow turns a signup into a first booked job.", why: "You wrote that trials stall.", ask: "Could I get your take?", handoffs: [{ at: Date.now() - 86400000 * 4, how: "copy" }], followUp: { due: Date.now() - 3600000, count: 0, auto: true } };

(async () => {
  const model = await env.startMock(), sheets = await startSheetsMock();
  const plain = await env.startColdServer({ mockUrl: model.url });
  const google = await env.startColdServer({ mockUrl: model.url, env: { COLD_GOOGLE_CLIENT_ID: "audit-client", COLD_GOOGLE_SHEETS_BASE: sheets.url } });
  const browser = await env.launch();
  const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, name), fullPage: false }); console.log("wrote", name); };
  const open = async (server, seed, init) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } }), page = await ctx.newPage();
    if (init) await page.addInitScript(init);
    if (seed) await page.addInitScript(s => { if (!sessionStorage.getItem("__s")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); sessionStorage.setItem("__s", "1"); } }, seed);
    await page.goto(server.base + "/"); await page.waitForSelector("#genBtn", { state: "attached" }); await page.waitForTimeout(600);
    return { ctx, page };
  };
  try {
    let { ctx, page } = await open(plain); await shot(page, "01-first-run-write.png");
    await page.click("#nav-leads"); await page.waitForSelector("#importBtn"); await shot(page, "02-leads-empty.png"); await ctx.close();
    ({ ctx, page } = await open(plain, { "cold.products": [P1] }));
    await page.click("#nav-leads"); await page.waitForSelector("#importBtn");
    const csv = "Who,Employer,Mail,Lead score\r\nAna Ruiz,Acme,ana@acme.io,87\r\nBo Lee,Beta,bo@beta.io,\r\n";
    await page.setInputFiles("#leadsFile", { name: "other-crm-export.csv", mimeType: "text/csv", buffer: Buffer.from(csv) }); await page.waitForSelector("#mapper");
    await page.selectOption("#mapperTable tbody tr:nth-child(1) select", "name"); await page.waitForSelector("#importSummary"); await shot(page, "03-leads-import-mapper.png"); await ctx.close();
    ({ ctx, page } = await open(plain, { "cold.products": [P1], "cold.emails": [DUE], "cold.leads": LEADS }));
    await page.click("#nav-history"); await page.waitForSelector(".hrow"); await page.click(".hrow .hToggle"); await page.waitForTimeout(300); await shot(page, "04-history-follow-up-due.png"); await ctx.close();
    ({ ctx, page } = await open(google, { "cold.products": [P1], "cold.leads": LEADS, "cold.emails": [DUE] }, FAKE_GIS));
    await page.click("#nav-settings"); await page.waitForSelector("#sheetsStart"); await page.locator("#sheetsSetup").scrollIntoViewIfNeeded(); await shot(page, "05-settings-google-sheets-offer.png");
    await page.click("#sheetsStart"); await page.click("#sheetsConnect"); await page.waitForSelector("#sheetsNext"); await page.click("#sheetsNext"); await page.waitForSelector("#sheetsFinish"); await page.locator("#sheetsSetup").scrollIntoViewIfNeeded(); await shot(page, "06-settings-google-sheets-move-step.png"); await ctx.close();
  } finally { await browser.close(); plain.stop(); google.stop(); model.server.close(); await sheets.close(); }
})().catch(e => { console.error(e); process.exit(1); });
