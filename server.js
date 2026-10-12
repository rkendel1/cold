// Cold: server-side LLM generation via AI Gateway, Anthropic, or a local Ollama server.
// No dependencies. Requires Node 18+ (built-in fetch).

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
const { BY_ID } = require("./lib/providers");
const { createSettings } = require("./lib/settings");
// Settings (provider, model, API keys) are editable from the UI only when COLD_SETTINGS_FILE is set, i.e. on a local
// or desktop install. A hosted deployment keeps configuring through environment variables.
const settings = process.env.COLD_SETTINGS_FILE ? createSettings({ file: process.env.COLD_SETTINGS_FILE }) : null;
const baseProvider = () => (process.env.VERCEL_ENV === "preview" ? prototypeConfig.previewProvider : null) || prototypeConfig.provider || process.env.LLM_PROVIDER || "ai-gateway";
const validProvider = id => id === "hf-ssh" || !!BY_ID[id];
if (!validProvider(baseProvider())) throw new Error(`Provider must be one of: hf-ssh, ${Object.keys(BY_ID).join(", ")}`);
const MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || process.env.ANTHROPIC_MAX_TOKENS || "2000", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

/** The effective provider settings for this request: saved settings win over environment defaults. */
function resolve() {
  const id = (settings && settings.active()) || baseProvider();
  if (id === "hf-ssh") return { id, hf: true, label: "hf-ssh", model: "hf-ssh/unknown", key: "", ready: true, keySetting: "Experimental: SSH client, verified host key, and live protocol validation required (no API key)", modelSetting: "" };
  const def = BY_ID[id], env = def.env;
  const saved = settings || { key: () => "", model: () => "", baseUrl: () => "" };
  const key = saved.key(id) || (env.key && process.env[env.key]) || (id === "ai-gateway" ? process.env.VERCEL_OIDC_TOKEN || "" : "");
  const model = saved.model(id) || (env.model && process.env[env.model]) || def.defaultModel;
  const baseUrl = (saved.baseUrl(id) || (env.url && process.env[env.url]) || def.baseUrl).replace(/\/+$/, "");
  const keySetting = id === "ollama" ? "OLLAMA_BASE_URL (no API key needed)" : id === "custom" ? "a base URL for the custom provider" : id === "ai-gateway" ? "AI_GATEWAY_API_KEY (or Vercel OIDC authentication)" : (env.key || "an API key");
  return { id, def, kind: def.kind, label: def.label, key, model, baseUrl, keySetting, modelSetting: env.model || "the model",
    ready: !!baseUrl && (!def.needsKey || !!key) && !!model };
}

const SYSTEM = "You are the writing engine inside Cold, a cold-email generator. Follow the instructions in the user message exactly. When asked for JSON, reply with only the JSON value: no preamble, no code fence.";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};
const HTML_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { tooBig = true; chunks.length = 0; return; }   // keep draining so the 413 reply can be delivered
      chunks.push(c);
    });
    req.on("end", () => tooBig ? reject(Object.assign(new Error("Request too large"), { status: 413 })) : resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---- Abuse and cost controls for /api/generate -------------------------------------------------
// COLD_ACCESS_TOKEN (optional): when set, requests must send it in the x-cold-access header. This is a shared secret
// checked ON THE SERVER; it is the only control here that stops a determined caller. When it is NOT set the endpoint
// stays open exactly as before: set it before sharing the URL. The checks below it are best-effort extras.
const MAX_BODY = 128 * 1024;
const rateBuckets = new Map();   // per server instance: serverless instances do not share this
function accessToken() { return process.env.COLD_ACCESS_TOKEN || ""; }
function rateLimitPerMinute() { const n = parseInt(process.env.COLD_RATE_LIMIT_PER_MIN || "30", 10); return Number.isFinite(n) && n > 0 ? n : 30; }

function tokenMatches(given) {
  const want = accessToken();
  const a = Buffer.from(String(given || "")), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Returns an error response descriptor, or null when the request may proceed. */
function guardGenerate(req) {
  // Browsers always send Origin on cross-site POSTs. A mismatch means another website is driving the request.
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let host = ""; try { host = new URL(origin).host; } catch {}
    if (host !== req.headers.host) return { status: 403, code: "bad_origin", message: "Cross-site requests are not allowed." };
  } else if (origin === "null") return { status: 403, code: "bad_origin", message: "Cross-site requests are not allowed." };
  if (accessToken() && !tokenMatches(req.headers["x-cold-access"])) return { status: 401, code: "access_required", message: "This server requires an access code." };
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now(), win = 60 * 1000, limit = rateLimitPerMinute();
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < win);
  if (hits.length >= limit) { rateBuckets.set(ip, hits); return { status: 429, code: "rate_limited", message: "Too many requests from this address. Wait a minute and try again." }; }
  hits.push(now); rateBuckets.set(ip, hits);
  if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (!v.some(t => now - t < win)) rateBuckets.delete(k);
  return null;
}

function apiErrorMessage(status, data, cfg, model = cfg.model) {
  const msg = data && data.error && data.error.message;
  if (status === 401 || status === 403) return `Authentication was rejected. Check ${cfg.keySetting}.`;
  if (status === 404) return `Model "${model}" wasn't found. Check ${cfg.modelSetting}.`;
  if (status === 429) return "Rate limited by the API. Wait a minute and try again.";
  if (status === 529 || status >= 500) return "The API is overloaded or unavailable right now. Try again shortly.";
  return typeof msg === "string" && msg ? `API error: ${msg}` : `API error (${status}).`;
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

function authHeaders(cfg) {
  if (cfg.kind === "anthropic") return { "x-api-key": cfg.key, "anthropic-version": "2023-06-01" };
  return cfg.key ? { authorization: `Bearer ${cfg.key}` } : {};
}

/** Live model list for one provider, using its saved key. Returns [{ id, name }]. */
async function providerModels(cfg) {
  const r = await fetch(cfg.baseUrl + cfg.def.modelsPath, { headers: authHeaders(cfg), signal: AbortSignal.timeout(10000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(apiErrorMessage(r.status, data, cfg)), { status: r.status });
  const rows = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : [];
  const seen = new Set();
  return rows.map(m => {
    const raw = typeof m === "string" ? m : m.id || m.name || m.model;
    if (typeof raw !== "string") return null;
    const id = raw.replace(/^models\//, "");
    return { id, name: m.display_name || id };
  }).filter(m => m && !seen.has(m.id) && seen.add(m.id)).sort((a, b) => a.id.localeCompare(b.id));
}

// Looks up a LinkedIn / X profile link, or a single tweet. Same abuse controls as /api/generate; only those two sites are ever fetched.
async function profileRoute(req, res, fn = "lookupProfile") {
  const denied = guardGenerate(req);
  if (denied) return send(res, denied.status, { error: { code: denied.code, message: denied.message } });
  let link;
  try { link = JSON.parse(await readBody(req, 8 * 1024)).url; } catch { return send(res, 400, { error: { message: "Bad request." } }); }
  if (typeof link !== "string" || !link.trim() || link.length > 300) return send(res, 400, { error: { message: "Enter a profile link." } });
  const result = await require("./lib/profile")[fn](link, (...a) => fetch(...a));
  send(res, 200, result);   // a failed lookup is a normal outcome the UI explains, not a request error
}

async function generate(req, res) {
  const denied = guardGenerate(req);
  if (denied) return send(res, denied.status, { error: { code: denied.code, message: denied.message } });
  const cfg = resolve();
  if (!cfg.ready) return send(res, 400, { error: { message: `Missing ${cfg.keySetting}.` } });
  const isGateway = cfg.id === "ai-gateway";
  let prompt, model = cfg.model;
  try {
    const body = JSON.parse(await readBody(req, MAX_BODY));
    prompt = String(body.prompt || "");
    // Per-request model choice is the hosted AI Gateway picker; local installs choose the model in Settings.
    if (isGateway && !settings && body.model != null) {
      if (typeof body.model !== "string" || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/.test(body.model) || body.model.length > 200)
        return send(res, 400, { error: { message: "Invalid AI Gateway model." } });
      model = body.model;
    }
  } catch (e) {
    return send(res, e.status || 400, { error: { message: e.status === 413 ? "Prompt too large." : "Bad request." } });
  }
  if (!prompt.trim()) return send(res, 400, { error: { message: "Empty prompt." } });

  if (cfg.hf) {
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

  if (isGateway && model !== cfg.model) {
    try {
      if (!(await gatewayModels()).some(m => m.id === model))
        return send(res, 400, { error: { message: "Select a language model from the AI Gateway catalog." } });
    } catch {
      return send(res, 503, { error: { message: "Model catalog unavailable. Retry or use the server default model." } });
    }
  }
  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });

  const openai = cfg.kind === "openai";
  try {
    const r = await fetch(cfg.baseUrl + cfg.def.chatPath, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", ...authHeaders(cfg) },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        ...(openai
          // Ollama: skip hidden "thinking" (it can burn the whole token budget) and force valid JSON.
          ? { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], stream: false, ...(cfg.id === "ollama" ? { reasoning_effort: "none", response_format: { type: "json_object" } } : {}) }
          : { system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: { message: apiErrorMessage(r.status, data, cfg, model) } });
    const choice = data.choices && data.choices[0];
    const text = openai ? choice?.message?.content : (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (typeof text !== "string" || !text.trim()) return send(res, 502, { error: { message: "The provider returned no text. Try again." } });
    send(res, 200, { text, truncated: openai ? choice.finish_reason === "length" : data.stop_reason === "max_tokens", model: data.model });
  } catch (e) {
    if (ctl.signal.aborted) return;
    send(res, 502, { error: { message: cfg.id === "ollama" ? `Couldn't reach Ollama at ${cfg.baseUrl}. Is it running (ollama serve) and is "${model}" pulled?` : `Couldn't reach ${cfg.label} from the server.` } });
  }
}

// ---- Settings API (local/desktop installs only) ----------------------------------------------------------------
const { PROVIDERS } = require("./lib/providers");
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

function guardSettings(req) {
  if (!settings) return { status: 404, code: "settings_disabled", message: "Settings are only available in the desktop app or a local install." };
  // Block DNS-rebinding and cross-site pages from reading or changing keys.
  if (!LOCAL_HOST.test(String(req.headers.host || ""))) return { status: 403, code: "bad_origin", message: "Settings can only be used from this computer." };
  const origin = req.headers.origin;
  if (origin) { let host = ""; try { host = new URL(origin).host; } catch {} if (host !== req.headers.host) return { status: 403, code: "bad_origin", message: "Cross-site requests are not allowed." }; }
  if (accessToken() && !tokenMatches(req.headers["x-cold-access"])) return { status: 401, code: "access_required", message: "This server requires an access code." };
  return null;
}

function settingsSnapshot() {
  const active = resolve().id;
  return {
    enabled: true, active, keyStorage: settings.storage,
    providers: PROVIDERS.map(def => {
      const id = def.id, key = settings.key(id), env = def.env;
      const envKey = !!(env.key && process.env[env.key]);
      return {
        id, label: def.label, needsKey: def.needsKey, editableUrl: !!def.editableUrl,
        hasKey: !!key || envKey, keyHint: key ? key.slice(-4) : "", keyFromEnv: !key && envKey,
        model: settings.model(id) || (env.model && process.env[env.model]) || "", defaultModel: def.defaultModel,
        baseUrl: settings.baseUrl(id) || (env.url && process.env[env.url]) || "", defaultBaseUrl: def.baseUrl,
      };
    }),
  };
}

async function settingsRoute(req, res, url) {
  const denied = guardSettings(req);
  if (denied) return send(res, denied.status, { error: { code: denied.code, message: denied.message } });
  if (req.method === "GET" && url.pathname === "/api/settings") return send(res, 200, settingsSnapshot());
  if (req.method === "PUT" && url.pathname === "/api/settings") {
    try {
      let body; try { body = JSON.parse(await readBody(req, MAX_BODY)); } catch (e) { if (e.status) throw e; throw new Error("Bad request."); }
      settings.update(body);
    } catch (e) { return send(res, e.status || 400, { error: { message: e.message || "Bad request." } }); }
    return send(res, 200, settingsSnapshot());
  }
  if (req.method === "GET" && url.pathname === "/api/settings/models") {
    const id = url.searchParams.get("provider") || "";
    const def = BY_ID[id];
    if (!def) return send(res, 400, { error: { message: "Unknown provider." } });
    const saved = { key: settings.key(id) || (def.env.key && process.env[def.env.key]) || "", baseUrl: (settings.baseUrl(id) || (def.env.url && process.env[def.env.url]) || def.baseUrl).replace(/\/+$/, "") };
    if (!saved.baseUrl) return send(res, 400, { error: { message: "Enter a base URL first." } });
    if (def.needsKey && !saved.key) return send(res, 400, { error: { message: "Save an API key first." } });
    try { return send(res, 200, { models: await providerModels({ id, def, kind: def.kind, key: saved.key, baseUrl: saved.baseUrl, keySetting: "the API key", modelSetting: "the model" }) }); }
    catch (e) { return send(res, 502, { error: { message: e.status ? e.message : `Couldn't reach ${def.label}${id === "ollama" ? ". Is Ollama running?" : "."}` } }); }
  }
  return send(res, 404, { error: { message: "Not found" } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/settings" || url.pathname.startsWith("/api/settings/")) return settingsRoute(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/config") {
      const cfg = resolve();
      return send(res, 200, { app: "cold", ready: cfg.ready, experimental: !!cfg.hf, model: cfg.model, provider: cfg.id, providerLabel: cfg.label, accessRequired: !!accessToken(), keySetting: cfg.keySetting, settingsEnabled: !!settings });
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      if (resolve().id !== "ai-gateway" || settings) return send(res, 200, { models: [] });
      try { return send(res, 200, { models: await gatewayModels() }); }
      catch { return send(res, 503, { error: { message: "Could not load AI Gateway models. The server default is still available." } }); }
    }
    if (req.method === "POST" && url.pathname === "/api/generate") return generate(req, res);
    if (req.method === "POST" && url.pathname === "/api/profile") return profileRoute(req, res);
    if (req.method === "POST" && url.pathname === "/api/tweet") return profileRoute(req, res, "lookupTweet");
    if (req.method === "GET" && url.pathname === "/tweet-counter.js") {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "public/tweet-counter.js")), "application/javascript; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/app.js") {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "public/app.js")), "application/javascript; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/app.css") {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "public/app.css")), "text/css; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") return send(res, 204, "", "image/x-icon");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "index.html")), "text/html; charset=utf-8", { "content-security-policy": HTML_CSP });
    }
    send(res, 404, { error: { message: "Not found" } });
  } catch (e) {
    send(res, 500, { error: { message: "Server error" } });
  }
});

if (require.main === module) server.listen(PORT, HOST, () => {
  const cfg = resolve();
  console.log(`Cold is running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(cfg.ready ? `Generating via ${cfg.id} with ${cfg.model}` : `Missing ${cfg.keySetting}: generation is off.`);
  if (!accessToken() && HOST !== "127.0.0.1") console.warn("WARNING: COLD_ACCESS_TOKEN is not set and the server is reachable beyond localhost: anyone who can reach it can spend your AI credits.");
});

server.settings = settings;   // the desktop shell attaches an encryption codec before listening
module.exports = server;
