// The extension's own model connection, used when the Cold app isn't running (or when you prefer it). Provider, model and key
// live in this browser profile's extension storage. Note: that storage is not encrypted; the desktop app encrypts keys with the OS keychain.
import { BY_ID } from "../../lib/providers.js";
import { chatRequest, parseChat, apiErrorMessage, unreachable, authHeaders, parseModels } from "../../lib/llm.js";
import { parseLooseJson } from "../../src/domain/email.js";

const KEY = "cold.model";
export const DEFAULT_CONFIG = { provider: "ollama", prefer: "app", providers: {} };

export async function loadModelConfig() { const o = await chrome.storage.local.get(KEY); return { ...DEFAULT_CONFIG, ...(o[KEY] || {}) }; }
export const saveModelConfig = c => chrome.storage.local.set({ [KEY]: c });

/** Stored settings -> the provider config the shared request builder understands (or null if the provider is unknown). */
export function resolveOwn(c, provider = c.provider) {
  const def = BY_ID[provider];
  if (!def) return null;
  const p = (c.providers || {})[def.id] || {};
  const baseUrl = String(p.baseUrl || def.baseUrl || "").replace(/\/+$/, "");
  const cfg = { id: def.id, def, kind: def.kind, label: def.label, key: p.key || "", model: p.model || def.defaultModel, baseUrl, keySetting: "the API key in the extension's Settings", modelSetting: "the model in the extension's Settings" };
  // Only counts once the user has saved model settings: defaults alone (e.g. an Ollama model that may not be installed) are not a setup.
  cfg.ready = !!c.configured && !!baseUrl && !!cfg.model && (!def.needsKey || !!cfg.key);
  return cfg;
}

/** A sample() with the same shape as the app's: sample(prompt, { signal }) -> { text, truncated }, plus sample.json. */
export function directSample(getCfg) {
  async function sample(prompt, opts = {}) {
    const cfg = getCfg();
    if (!cfg || !cfg.ready) throw { code: "no_model", message: "Choose a model in the extension's Settings first." };
    const { url, init } = chatRequest(cfg, { model: cfg.model, prompt, browser: true });
    let r;
    try { r = await fetch(url, { ...init, signal: opts.signal }); }
    catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled" }; throw { code: "api_error", message: unreachable(cfg, cfg.model, "from the extension") }; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: r.status === 429 ? "rate_limited" : "api_error", status: r.status, message: apiErrorMessage(r.status, data, cfg) };
    const out = parseChat(cfg, data);
    if (!out) throw { code: "api_error", message: "The provider returned no text. Try again." };
    return { text: out.text, truncated: out.truncated };
  }
  sample.json = async (prompt, opts) => parseLooseJson((await sample(prompt, opts)).text);
  return sample;
}

/** Live model list for a provider config. Throws { message }. */
export async function listModels(cfg) {
  let r;
  try { r = await fetch(cfg.baseUrl + cfg.def.modelsPath, { headers: authHeaders(cfg, { browser: true }), signal: AbortSignal.timeout(10000) }); }
  catch { throw { message: unreachable(cfg, cfg.model, "from the extension") }; }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw { message: apiErrorMessage(r.status, data, cfg) };
  return parseModels(data);
}

/**
 * Ollama refuses requests that carry a browser-extension Origin (it answers 403 unless OLLAMA_ORIGINS is set). So for the
 * local-server providers only, remove that header on this extension's own requests. Scoped to the configured host.
 */
export async function syncOriginRules(c) {
  if (!chrome.declarativeNetRequest) return;
  const origins = new Set(["http://127.0.0.1:11434", "http://localhost:11434"]);
  for (const id of ["ollama", "custom"]) { const b = c.providers && c.providers[id] && c.providers[id].baseUrl; if (b) { try { origins.add(new URL(b).origin); } catch { /* ignore */ } } }
  const addRules = [...origins].map((o, i) => ({ id: i + 1, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] }, condition: { urlFilter: `|${o}/`, resourceTypes: ["xmlhttprequest"], initiatorDomains: [chrome.runtime.id] } }));
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map(r => r.id), addRules });
}
