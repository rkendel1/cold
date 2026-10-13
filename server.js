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
// COLD_DB_FILE switches products and drafts from browser storage to this SQLite file (the desktop app sets it).
const appDb = process.env.COLD_DB_FILE ? require("./lib/db").createDb(process.env.COLD_DB_FILE) : null;
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

const { SYSTEM, authHeaders, chatRequest, parseChat, apiErrorMessage, unreachable, parseModels } = require("./lib/llm");

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};
// connect-src also allows the loopback address, so a page can reach the Cold desktop app on this computer (paired, with its code).
const HTML_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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

// ---- Browser-extension access ------------------------------------------------------------------------------------
// The extension is paired with a random token shown in Settings. With it the extension may read and write products and drafts,
// generate, and look up profiles/tweets. It can never reach /api/settings (keys, provider choice, the token itself).
const EXT_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[A-Za-z0-9._-]+$/;
const EXT_PATHS = /^\/api\/(config|data(\/.*)?|generate|profile|tweet|people\/email\/(find|verify))$/;
/** A browser extension, or a web page the user approved in Settings, may be given CORS access (it still needs the pairing code). */
const pairedOrigin = origin => EXT_ORIGIN.test(origin) || !!(appDb && appDb.webOrigins().includes(origin));
function extensionAuthorized(req) {
  const want = appDb && appDb.peekExtensionToken();
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
  if (!want || !m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Returns an error response descriptor, or null when the request may proceed. */
function guardGenerate(req) {
  // The paired browser extension authenticates with its pairing token instead of the same-origin rules.
  if (!extensionAuthorized(req)) {
    // Browsers always send Origin on cross-site POSTs. A mismatch means another website is driving the request.
    const origin = req.headers.origin;
    if (origin && origin !== "null") {
      let host = ""; try { host = new URL(origin).host; } catch {}
      if (host !== req.headers.host) return { status: 403, code: "bad_origin", message: "Cross-site requests are not allowed." };
    } else if (origin === "null") return { status: 403, code: "bad_origin", message: "Cross-site requests are not allowed." };
    if (accessToken() && !tokenMatches(req.headers["x-cold-access"])) return { status: 401, code: "access_required", message: "This server requires an access code." };
  }
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now(), win = 60 * 1000, limit = rateLimitPerMinute();
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < win);
  if (hits.length >= limit) { rateBuckets.set(ip, hits); return { status: 429, code: "rate_limited", message: "Too many requests from this address. Wait a minute and try again." }; }
  hits.push(now); rateBuckets.set(ip, hits);
  if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (!v.some(t => now - t < win)) rateBuckets.delete(k);
  return null;
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

/** Live model list for one provider, using its saved key. Returns [{ id, name }]. */
async function providerModels(cfg) {
  const r = await fetch(cfg.baseUrl + cfg.def.modelsPath, { headers: authHeaders(cfg), signal: AbortSignal.timeout(10000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(apiErrorMessage(r.status, data, cfg)), { status: r.status });
  return parseModels(data);
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

// Find or verify one work email through treg. User-initiated, one person per request, same abuse controls as /api/generate.
async function peopleRoute(req, res, op) {
  const denied = guardGenerate(req);
  if (denied) return send(res, denied.status, { error: { code: denied.code, message: denied.message } });
  let body; try { body = JSON.parse(await readBody(req, 8 * 1024)); } catch { return send(res, 400, { error: { message: "Bad request." } }); }
  const treg = require("./lib/treg");
  const out = await treg[op === "find" ? "findEmail" : "verifyEmail"](body || {}, { token: tregToken() });
  send(res, 200, out);   // a miss, a refusal or a failed lookup is a normal outcome the UI explains; it carries no token and no raw provider data
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

  try {
    const { url, init } = chatRequest(cfg, { model, prompt, maxTokens: MAX_TOKENS });
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: { message: apiErrorMessage(r.status, data, cfg, model) } });
    const out = parseChat(cfg, data);
    if (!out) return send(res, 502, { error: { message: "The provider returned no text. Try again." } });
    send(res, 200, out);
  } catch (e) {
    if (ctl.signal.aborted) return;
    send(res, 502, { error: { message: unreachable(cfg, model) } });
  }
}

// ---- Settings API (local/desktop installs only) ----------------------------------------------------------------
const { PROVIDERS } = require("./lib/providers");
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

function guardLocal(req) {
  // Browsers stamp every request with Sec-Fetch-Site and scripts can't forge it. Only this app's own pages are "same-origin":
  // a website, or another browser extension that can reach localhost, shows up as "cross-site" and gets nothing without the token.
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin") return { status: 403, code: "bad_origin", message: "Only the Cold app can do that." };
  // Block DNS-rebinding and cross-site pages from reading or changing keys.
  if (!LOCAL_HOST.test(String(req.headers.host || ""))) return { status: 403, code: "bad_origin", message: "Settings can only be used from this computer." };
  const origin = req.headers.origin;
  if (origin) { let host = ""; try { host = new URL(origin).host; } catch {} if (host !== req.headers.host) return { status: 403, code: "bad_origin", message: "Cross-site requests are not allowed." }; }
  if (accessToken() && !tokenMatches(req.headers["x-cold-access"])) return { status: 401, code: "access_required", message: "This server requires an access code." };
  return null;
}
function guardSettings(req) {
  if (!settings) return { status: 404, code: "settings_disabled", message: "Settings are only available in the desktop app or a local install." };
  if (req.headers.authorization) return { status: 403, code: "bad_origin", message: "The extension can't use settings." };
  return guardLocal(req);
}
function guardData(req) {
  if (!appDb) return { status: 404, code: "db_disabled", message: "This server stores data in the browser." };
  // A request that presents a pairing code must present the right one (browsers omit Origin on simple GETs, so don't rely on it).
  if (req.headers.authorization) return extensionAuthorized(req) ? null : { status: 403, code: "bad_token", message: "The pairing code isn't valid. Copy the current one from Cold's Settings." };
  return guardLocal(req);
}

async function dataRoute(req, res, url) {
  const denied = guardData(req);
  if (denied) return send(res, denied.status, { error: { code: denied.code, message: denied.message } });
  const parts = url.pathname.split("/").filter(Boolean).slice(2);   // after /api/data
  try {
    if (req.method === "GET" && parts.length === 0) return send(res, 200, appDb.snapshot());
    if (req.method === "GET" && parts[0] === "version") return send(res, 200, { version: appDb.version });
    if (req.method === "GET" && parts[0] === "ping") return send(res, 200, { ok: true, version: appDb.version });
    if (req.method === "POST" && parts[0] === "import") {
      return send(res, 200, appDb.importOnce(JSON.parse(await readBody(req, 16 * 1024 * 1024))));
    }
    // ?base=<updatedAt the caller last saw> (or "new") makes a write conditional: if the stored record moved on, nothing is written and the 409 carries it.
    const bq = url.searchParams.get("base"), base = bq === null ? undefined : bq === "new" ? "new" : /^\d{1,16}$/.test(bq) ? Number(bq) : NaN;
    if (Number.isNaN(base)) return send(res, 400, { error: { message: "Bad request." } });
    if (req.method === "DELETE" && parts.length === 2) { appDb.remove(parts[0], decodeURIComponent(parts[1]), { base }); return send(res, 200, { ok: true, version: appDb.version }); }
    if (req.method === "PUT" && (parts.length === 1 || parts.length === 2)) {
      const doc = JSON.parse(await readBody(req, 600 * 1024));
      const saved = parts.length === 2 ? appDb.put(parts[0], decodeURIComponent(parts[1]), doc, { base }) : (appDb.putMeta(parts[0], doc), {});
      return send(res, 200, { ok: true, version: appDb.version, ...saved });
    }
  } catch (e) {
    if (e.code === "conflict") return send(res, 409, { error: { code: "conflict", message: e.message }, current: e.current });
    return send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: { message: e.status ? e.message : e instanceof SyntaxError ? "Bad request." : "Couldn't save." } });
  }
  return send(res, 404, { error: { message: "Not found" } });
}

/** The treg token: saved in Settings, else TREG_TOKEN. It is only ever read here, to call treg; it is never sent to a page. */
const tregToken = () => (settings && settings.integrationKey("treg")) || process.env.TREG_TOKEN || "";
function tregStatus() {
  const saved = settings ? settings.integrationKey("treg") : "", env = !!process.env.TREG_TOKEN;
  return { hasKey: !!saved || env, keyHint: saved ? saved.slice(-4) : "", keyFromEnv: !saved && env };
}

function settingsSnapshot() {
  const active = resolve().id;
  return {
    enabled: true, active, keyStorage: settings.storage,
    integrations: { treg: tregStatus() },
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
  if (url.pathname === "/api/settings/extension" && (req.method === "GET" || req.method === "POST")) {
    if (!appDb) return send(res, 404, { error: { message: "Browser extension pairing needs the desktop app's database." } });
    return send(res, 200, { token: appDb.extensionToken(req.method === "POST"), origin: `http://${req.headers.host}`, dbFile: appDb.file, webOrigins: appDb.webOrigins() });
  }
  if (url.pathname === "/api/settings/web-origins" && req.method === "PUT") {
    if (!appDb) return send(res, 404, { error: { message: "Needs the desktop app's database." } });
    try { return send(res, 200, { webOrigins: appDb.setWebOrigins(JSON.parse(await readBody(req, 16 * 1024)).origins) }); }
    catch (e) { return send(res, e.status || 400, { error: { message: e.status ? e.message : "Bad request." } }); }
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
    const extOrigin = req.headers.origin && EXT_PATHS.test(url.pathname) && pairedOrigin(req.headers.origin) ? req.headers.origin : "";
    if (extOrigin) {
      res.setHeader("access-control-allow-origin", extOrigin); res.setHeader("vary", "Origin");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      if (req.headers["access-control-request-private-network"]) res.setHeader("access-control-allow-private-network", "true");   // Chrome asks before a public page may reach localhost
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS"); res.setHeader("access-control-max-age", "600");
      if (req.method === "OPTIONS") { res.writeHead(204, SECURITY_HEADERS); return res.end(); }
    }
    if (url.pathname === "/api/settings" || url.pathname.startsWith("/api/settings/")) return settingsRoute(req, res, url);
    if (url.pathname === "/api/data" || url.pathname.startsWith("/api/data/")) return dataRoute(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/config") {
      const cfg = resolve();
      return send(res, 200, { app: "cold", ready: cfg.ready, experimental: !!cfg.hf, model: cfg.model, provider: cfg.id, providerLabel: cfg.label, dbEnabled: !!appDb, accessRequired: !!accessToken(), keySetting: cfg.keySetting, settingsEnabled: !!settings, peopleSearch: !!tregToken() });
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      if (resolve().id !== "ai-gateway" || settings) return send(res, 200, { models: [] });
      try { return send(res, 200, { models: await gatewayModels() }); }
      catch { return send(res, 503, { error: { message: "Could not load AI Gateway models. The server default is still available." } }); }
    }
    if (req.method === "POST" && url.pathname === "/api/generate") return generate(req, res);
    if (req.method === "POST" && url.pathname === "/api/profile") return profileRoute(req, res);
    if (req.method === "POST" && url.pathname === "/api/people/email/find") return peopleRoute(req, res, "find");
    if (req.method === "POST" && url.pathname === "/api/people/email/verify") return peopleRoute(req, res, "verify");
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
    if (req.method === "GET" && /^\/brand\/[a-z0-9-]+\.png$/.test(url.pathname)) {   // the logo files only; the pattern allows no other path or type
      const file = path.join(ROOT, "public", url.pathname);
      if (fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), "image/png", { "cache-control": "public, max-age=86400" });
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

server.settings = settings; server.db = appDb;   // the desktop shell attaches an encryption codec before listening
module.exports = server;
