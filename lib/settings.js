// Persistent provider settings for the desktop app (and any local server that sets COLD_SETTINGS_FILE).
// Keys are encrypted at rest through an injected codec (Electron safeStorage); without one they are stored
// in a 0600 file. Keys are never returned to the browser: only whether one is saved and its last four characters.
const fs = require("node:fs");
const path = require("node:path");
const { BY_ID } = require("./providers");

function createSettings({ file }) {
  let codec = null;
  let data = { active: "", providers: {}, integrations: {} };   // integrations[name] = { key: {enc, v} } (not model providers; e.g. treg)   // providers[id] = { key?: {enc, v}, model?, baseUrl? }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object") data = { active: typeof raw.active === "string" ? raw.active : "", providers: raw.providers && typeof raw.providers === "object" ? raw.providers : {}, integrations: raw.integrations && typeof raw.integrations === "object" ? raw.integrations : {} };
    } catch { /* first run or unreadable file: start empty */ }
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  load();

  const entry = id => (data.providers[id] ||= {});
  function readKey(id) {
    const k = data.providers[id] && data.providers[id].key;
    if (!k || typeof k.v !== "string") return "";
    if (!k.enc) return k.v;
    if (!codec) return "";                       // encrypted but no codec available: treat as not saved
    try { return codec.decrypt(Buffer.from(k.v, "base64")); } catch { return ""; }
  }

  const INTEGRATIONS = new Set(["treg", "google"]);
  function readIntegrationKey(name) {
    const k = data.integrations[name] && data.integrations[name].key;
    if (!k || typeof k.v !== "string") return "";
    if (!k.enc) return k.v;
    if (!codec) return "";
    try { return codec.decrypt(Buffer.from(k.v, "base64")); } catch { return ""; }
  }

  return {
    file,
    integrationKey: readIntegrationKey,
    setCodec(c) { codec = c; },
    get storage() { return codec ? "encrypted" : "file"; },
    active: () => (BY_ID[data.active] ? data.active : ""),
    key: readKey,
    model: id => (data.providers[id] && data.providers[id].model) || "",
    baseUrl: id => (data.providers[id] && data.providers[id].baseUrl) || "",
    /** patch = { active?, providers?: { id: { apiKey?: string|null, model?: string, baseUrl?: string } } }. Throws {message} on bad input. */
    update(patch) {
      const p = patch && typeof patch === "object" ? patch : {};
      if (p.active != null && p.active !== "" && !BY_ID[p.active]) throw new Error("Unknown provider.");
      for (const [id, v] of Object.entries(p.providers || {})) {
        if (!BY_ID[id]) throw new Error("Unknown provider.");
        if (!v || typeof v !== "object") continue;
        if (v.apiKey != null && (typeof v.apiKey !== "string" || v.apiKey.length > 4096)) throw new Error("Invalid API key.");
        if (v.model != null && (typeof v.model !== "string" || v.model.length > 200 || /[\s\u0000-\u001f]/.test(v.model.trim()))) throw new Error("Invalid model name.");
        if (v.baseUrl != null) {
          if (typeof v.baseUrl !== "string" || v.baseUrl.length > 500) throw new Error("Invalid base URL.");
          if (v.baseUrl.trim() && !/^https?:\/\/[^\s/]+/i.test(v.baseUrl.trim())) throw new Error("Base URL must start with http:// or https://.");
        }
      }
      for (const [name, v] of Object.entries(p.integrations || {})) {
        if (!INTEGRATIONS.has(name)) throw new Error("Unknown integration.");
        if (v && v.apiKey != null && (typeof v.apiKey !== "string" || v.apiKey.length > 4096 || /[\s\u0000-\u001f]/.test(v.apiKey.trim()))) throw new Error("Invalid token.");
      }
      if (p.active != null) data.active = p.active;
      for (const [name, v] of Object.entries(p.integrations || {})) {
        if (!v || v.apiKey === undefined) continue;
        const key = v.apiKey == null ? "" : v.apiKey.trim(), e = (data.integrations[name] ||= {});
        if (!key) delete e.key; else e.key = codec ? { enc: true, v: codec.encrypt(key).toString("base64") } : { enc: false, v: key };
      }
      for (const [id, v] of Object.entries(p.providers || {})) {
        if (!v || typeof v !== "object") continue;
        const e = entry(id);
        if (v.apiKey !== undefined) {
          const key = v.apiKey == null ? "" : v.apiKey.trim();
          if (!key) delete e.key;
          else e.key = codec ? { enc: true, v: codec.encrypt(key).toString("base64") } : { enc: false, v: key };
        }
        if (v.model !== undefined) { const m = (v.model || "").trim(); if (m) e.model = m; else delete e.model; }
        if (v.baseUrl !== undefined) { const u = (v.baseUrl || "").trim().replace(/\/+$/, ""); if (u) e.baseUrl = u; else delete e.baseUrl; }
      }
      save();
    },
  };
}

module.exports = { createSettings };
