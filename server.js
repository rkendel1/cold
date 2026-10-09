// Cold: server-side LLM generation via AI Gateway or Anthropic.
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

const prototypeConfig = require("./provider-config.json");
const PROVIDER = (process.env.VERCEL_ENV === "preview" ? prototypeConfig.previewProvider : null) || prototypeConfig.provider || process.env.LLM_PROVIDER || "ai-gateway";
if (!["ai-gateway", "anthropic", "hf-ssh"].includes(PROVIDER)) throw new Error("Provider must be ai-gateway, anthropic, or hf-ssh");
const IS_HF = PROVIDER === "hf-ssh";
const IS_GATEWAY = PROVIDER === "ai-gateway";
const credential = () => IS_GATEWAY
  ? process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || ""
  : process.env.ANTHROPIC_API_KEY || "";
const MODEL = IS_GATEWAY
  ? process.env.AI_GATEWAY_MODEL || "anthropic/claude-sonnet-4.5"
  : process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || process.env.ANTHROPIC_MAX_TOKENS || "2000", 10);
const KEY_SETTING = IS_GATEWAY ? "AI_GATEWAY_API_KEY (or Vercel OIDC authentication)" : "ANTHROPIC_API_KEY";
const MODEL_SETTING = IS_GATEWAY ? "AI_GATEWAY_MODEL" : "ANTHROPIC_MODEL";
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

function apiErrorMessage(status, data, model = MODEL) {
  const msg = data && data.error && data.error.message;
  if (status === 401) return `Authentication was rejected. Check ${KEY_SETTING}.`;
  if (status === 404) return `Model "${model}" wasn't found. Check ${MODEL_SETTING}.`;
  if (status === 429) return "Rate limited by the API. Wait a minute and try again.";
  if (status === 529 || status >= 500) return "The API is overloaded or unavailable right now. Try again shortly.";
  return msg ? `API error: ${msg}` : `API error (${status}).`;
}

let modelCache = null;
let modelCacheUntil = 0;
async function gatewayModels() {
  if (modelCache && Date.now() < modelCacheUntil) return modelCache;
  const response = await fetch("https://ai-gateway.vercel.sh/v1/models", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Model catalog unavailable");
  const data = await response.json();
  if (!Array.isArray(data.data)) throw new Error("Invalid model catalog");
  const models = data.data.filter(m => m.type === "language" && typeof m.id === "string")
    .map(m => ({ id: m.id, name: m.name || m.id, provider: m.id.split("/")[0] }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!models.length) throw new Error("Empty model catalog");
  modelCache = models;
  modelCacheUntil = Date.now() + 5 * 60 * 1000;
  return models;
}

async function generate(req, res) {
  if (!IS_HF && !credential()) return send(res, 400, { error: { message: `Missing ${KEY_SETTING}.` } });
  let prompt, model = MODEL;
  try {
    const body = JSON.parse(await readBody(req));
    prompt = String(body.prompt || "");
    if (IS_GATEWAY && body.model != null) {
      if (typeof body.model !== "string" || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/.test(body.model) || body.model.length > 200)
        return send(res, 400, { error: { message: "Invalid AI Gateway model." } });
      model = body.model;
    }
  } catch (e) {
    return send(res, e.status || 400, { error: { message: e.status === 413 ? "Prompt too large." : "Bad request." } });
  }
  if (!prompt.trim()) return send(res, 400, { error: { message: "Empty prompt." } });

  if (IS_HF) {
    const ctl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctl.abort(); });
    try {
      const text = await require("./scripts/hf-ssh-provider.cjs").generate(`${SYSTEM}\n${prompt}`, { signal: ctl.signal });
      return send(res, 200, { text, truncated: false, model: "hf-ssh/unknown" });
    } catch (e) {
      if (!ctl.signal.aborted) return send(res, 503, { error: { message: e.message } });
      return;
    }
  }

  if (IS_GATEWAY && model !== MODEL) {
    try {
      if (!(await gatewayModels()).some(m => m.id === model))
        return send(res, 400, { error: { message: "Select a language model from the AI Gateway catalog." } });
    } catch {
      return send(res, 503, { error: { message: "Model catalog unavailable. Retry or use the server default model." } });
    }
  }
  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });

  try {
    const r = await fetch(IS_GATEWAY ? "https://ai-gateway.vercel.sh/v1/chat/completions" : `${API_URL}/v1/messages`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        ...(IS_GATEWAY ? { authorization: `Bearer ${credential()}` } : { "x-api-key": credential(), "anthropic-version": "2023-06-01" }),
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        ...(IS_GATEWAY
          ? { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], stream: false }
          : { system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: { message: apiErrorMessage(r.status, data, model) } });
    const choice = data.choices && data.choices[0];
    const text = IS_GATEWAY ? choice?.message?.content : (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (typeof text !== "string" || !text.trim()) return send(res, 502, { error: { message: "The provider returned no text. Try again." } });
    send(res, 200, { text, truncated: IS_GATEWAY ? choice.finish_reason === "length" : data.stop_reason === "max_tokens", model: data.model });
  } catch (e) {
    if (ctl.signal.aborted) return;
    send(res, 502, { error: { message: `Couldn't reach ${PROVIDER} from the server.` } });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      return send(res, 200, { app: "cold", ready: IS_HF ? true : !!credential(), experimental: IS_HF, model: IS_HF ? "hf-ssh/unknown" : MODEL, provider: PROVIDER, keySetting: IS_HF ? "Experimental: SSH client, verified host key, and live protocol validation required (no API key)" : KEY_SETTING });
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      if (!IS_GATEWAY) return send(res, 200, { models: [] });
      try { return send(res, 200, { models: await gatewayModels() }); }
      catch { return send(res, 503, { error: { message: "Could not load AI Gateway models. The server default is still available." } }); }
    }
    if (req.method === "POST" && url.pathname === "/api/generate") return generate(req, res);
    if (req.method === "GET" && url.pathname === "/tweet-counter.js") {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "public/tweet-counter.js")), "application/javascript; charset=utf-8");
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "index.html")), "text/html; charset=utf-8");
    }
    send(res, 404, { error: { message: "Not found" } });
  } catch (e) {
    send(res, 500, { error: { message: "Server error" } });
  }
});

if (require.main === module) server.listen(PORT, HOST, () => {
  console.log(`Cold is running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(credential() ? `Generating via ${PROVIDER} with ${MODEL}` : `Missing ${KEY_SETTING}: generation is off.`);
});

module.exports = server;
