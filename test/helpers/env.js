// Shared test harness: a mock Anthropic endpoint, a Cold server pointed at it, and a browser launcher.
// EVERYTHING the mock returns is canned. Tests using it verify UI/plumbing behaviour, never output quality.
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "../..");

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    for (const d of fs.readdirSync(base)) {
      for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const p = path.join(base, d, sub);
        if (/^chromium-\d+$/.test(d) && fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return null;
}

function playwright() { try { return require("playwright-core"); } catch { return null; } }
const browserAvailable = () => !!(playwright() && findChromium());

const FINAL = { subject: "trial drop-off", what: "Acme Flow turns a signup into a first booked job for plumbers in a day.", why: "You wrote that most trial users stall before inviting a teammate, and we reduced that stall for one design partner.", ask: "Could I get your take on where trials stall for tools like yours?" };

/** Mock model. `behavior` can be changed per test. Records every prompt it receives. */
function startMock(behavior = {}) {
  const mock = { prompts: [], delayMs: 0, failNext: 0, claims: [{ text: "cut that stall", source: "P1" }], final: { ...FINAL }, status: 200 };
  Object.assign(mock, behavior);
  mock.server = http.createServer((req, res) => {
    let b = ""; req.on("data", c => b += c); req.on("end", () => {
      const prompt = JSON.parse(b).messages[0].content; mock.prompts.push(prompt);
      const respond = () => {
        if (mock.failNext > 0) { mock.failNext--; res.writeHead(529, { "content-type": "application/json" }); return res.end("{}"); }
        const isEditor = prompt.includes("You are the editor");
        const isTweet = prompt.startsWith("Write one");
        const out = isTweet ? { text: mock.tweet || "Short tweet." }
          : isEditor ? { draft_failures: [], final: mock.final, checks: Array.from({ length: 20 }, (_, i) => ({ rule: i + 1, pass: true })), proof_id: "P1", claims: mock.claims, could_improve: "" }
          : { relevance: { signal: "wrote about trial stall", rank: 1, category: "Direct shared problem", strength: "strong" }, retrieved: [{ id: "P1", why: "" }], proof_id: "P1", ...mock.final };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "mock", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(out) }] }));
      };
      mock.delayMs ? setTimeout(respond, mock.delayMs) : respond();
    });
  });
  return new Promise(r => mock.server.listen(0, "127.0.0.1", () => { mock.url = `http://127.0.0.1:${mock.server.address().port}`; r(mock); }));
}

async function startColdServer({ mockUrl, env = {} }) {
  const port = 3300 + Math.floor(Math.random() * 600);
  const child = spawn("node", ["server.js"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "mock-key", ANTHROPIC_BASE_URL: mockUrl, PORT: String(port), HOST: "127.0.0.1", COLD_ACCESS_TOKEN: "", COLD_RATE_LIMIT_PER_MIN: "100000", ...env } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/config"); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  return { base, port, stop: () => child.kill() };
}

async function launch() {
  const pw = playwright();
  return pw.chromium.launch({ executablePath: findChromium() });
}

module.exports = { ROOT, startMock, startColdServer, launch, browserAvailable, FINAL };
