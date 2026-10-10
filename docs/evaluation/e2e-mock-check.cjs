// Reproducible end-to-end check of Cold's UI -> /api/generate -> persistence path.
// Uses a MOCK Anthropic endpoint, so it proves plumbing, NOT output quality.
// Run: node docs/evaluation/e2e-mock-check.cjs   (needs playwright resolvable; Chromium via PLAYWRIGHT_BROWSERS_PATH)
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const calls = [];
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    const prompt = JSON.parse(b).messages[0].content; calls.push(prompt);
    const isEditor = prompt.includes("You are the editor");
    const final = { subject: "onboarding drop-off", what: "Acme Flow turns a signup into a first booked job for plumbers in under a day.", why: "You wrote that most of your trial users stall before inviting a teammate, and we cut that stall for one design partner.", ask: "Could I get your take on where trials stall for tools like yours?" };
    const out = isEditor ? { draft_failures: [], final, checks: Array.from({ length: 20 }, (_, i) => ({ rule: i + 1, pass: true })), proof_id: "P1", claims: [{ text: "cut that stall", source: "P1" }], could_improve: "" }
      : { relevance: { signal: "wrote about trial stall", rank: 1, category: "Direct shared problem", strength: "strong" }, retrieved: [{ id: "P1", why: "" }], proof_id: "P1", ...final };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "mock", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(out) }] }));
  });
}).listen(0, "127.0.0.1", async () => {
  const env = { ...process.env, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "mock", ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`, PORT: "3123", HOST: "127.0.0.1" };
  const srv = spawn("node", ["server.js"], { cwd: path.join(__dirname, "../.."), env, stdio: "ignore" });
  await new Promise(r => setTimeout(r, 1200));
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage();
  const result = {};
  try {
    // 1) Gate: no product in the knowledge base -> generation must be blocked with no LLM call.
    await page.goto("http://127.0.0.1:3123/");
    await page.waitForTimeout(800);
    result.banner = await page.textContent("#banner");
    await page.fill("#rName", "Sam Ortiz"); await page.fill("#rCompany", "TrialCo");
    await page.fill("#rWhy", "Wrote that most trial users stall before inviting a teammate.");
    await page.click("#genBtn"); await page.waitForTimeout(500);
    result.blockedWithoutProduct = (await page.textContent("#out")).trim().slice(0, 120);
    result.llmCallsAfterBlockedAttempt = calls.length;
    // 2) Seed one product (same shape the Knowledge editor saves) and generate.
    await page.evaluate(() => localStorage.setItem("cold.products", JSON.stringify([{ id: "p1", name: "Acme Flow", order: 0,
      what: "Acme Flow turns a signup into a first booked job for plumbers.", who: "Plumbing shops", problem: "Trials stall",
      proof: [{ claim: "Cut trial stall for one design partner", evidence: "", type: "Customer", strength: "Medium", external: true },
              { claim: "INTERNAL-ONLY secret claim", evidence: "", type: "Revenue / growth", strength: "High", external: false }],
      techFacts: [], approved: [], dontSay: ["generic database"] }])));
    await page.reload(); await page.waitForTimeout(800);
    await page.fill("#rName", "Sam Ortiz"); await page.fill("#rCompany", "TrialCo");
    await page.fill("#rWhy", "Wrote that most trial users stall before inviting a teammate.");
    await page.click("#genBtn"); await page.waitForTimeout(2500);
    result.llmCalls = calls.length;
    result.draftPromptExcludesInternalProof = !calls[0].includes("secret claim");
    result.draftPromptForbidsInventing = /Never invent customers/.test(calls[0]);
    result.outputHasScore = /\b\d{2,3}\b/.test(await page.textContent("#out"));
    result.outputSnippet = (await page.textContent("#out")).replace(/\s+/g, " ").slice(0, 260);
    // 3) Persistence + status tracking.
    await page.click("#tab-history"); await page.waitForTimeout(300);
    result.historyRows = await page.locator(".hrow").count();
    await page.selectOption(".hStatus", "replied");
    result.persistedStatus = await page.evaluate(() => JSON.parse(localStorage.getItem("cold.emails"))[0].status);
    result.historyFieldsStored = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("cold.emails"))[0]).sort());
  } catch (e) { result.exception = String(e).slice(0, 300); }
  console.log(JSON.stringify(result, null, 2));
  await browser.close(); srv.kill(); mock.close();
});
