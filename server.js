// Cold: local server for API-key mode.
// Serves index.html and calls the Anthropic Messages API with the key and model from .env.
// No dependencies. Requires Node 18+ (built-in fetch).

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv(path.join(ROOT, ".env"));

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS || "2000", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const API_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

const SYSTEM = "You are the writing engine inside Cold, a cold-email generator. Follow the instructions in the user message exactly. When asked for JSON, reply with only the JSON value: no preamble, no code fence.";

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function apiErrorMessage(status, data) {
  const msg = data && data.error && data.error.message;
  if (status === 401) return "The API key in .env was rejected. Check ANTHROPIC_API_KEY.";
  if (status === 404) return `Model "${MODEL}" wasn't found. Check ANTHROPIC_MODEL in .env.`;
  if (status === 429) return "Rate limited by the API. Wait a minute and try again.";
  if (status === 529 || status >= 500) return "The API is overloaded or unavailable right now. Try again shortly.";
  return msg ? `API error: ${msg}` : `API error (${status}).`;
}

async function generate(req, res) {
  if (!API_KEY) return send(res, 400, { error: { message: "ANTHROPIC_API_KEY is missing from .env." } });
  let prompt;
  try {
    const body = JSON.parse(await readBody(req));
    prompt = String(body.prompt || "");
  } catch (e) {
    return send(res, e.status || 400, { error: { message: e.status === 413 ? "Prompt too large." : "Bad request." } });
  }
  if (!prompt.trim()) return send(res, 400, { error: { message: "Empty prompt." } });

  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });

  try {
    const r = await fetch(`${API_URL}/v1/messages`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: { message: apiErrorMessage(r.status, data) } });
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    send(res, 200, { text, truncated: data.stop_reason === "max_tokens", model: data.model });
  } catch (e) {
    if (ctl.signal.aborted) return;
    send(res, 502, { error: { message: "Couldn't reach the Anthropic API from the server." } });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      return send(res, 200, { app: "cold", ready: !!API_KEY, model: MODEL });
    }
    if (req.method === "POST" && url.pathname === "/api/generate") return generate(req, res);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "index.html")), "text/html; charset=utf-8");
    }
    send(res, 404, { error: { message: "Not found" } });
  } catch (e) {
    send(res, 500, { error: { message: "Server error" } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Cold is running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(API_KEY ? `Generating with ${MODEL}` : "No ANTHROPIC_API_KEY in .env: generation is off until you add one and restart.");
});
