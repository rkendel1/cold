// Lets the shared Settings screen edit the extension's own model: the same three calls the desktop server's settings API has,
// answered from this browser profile's extension storage. Keys stay here and go only to the provider you chose.
import { PROVIDERS, BY_ID } from "../../lib/providers.js";
import { saveModelConfig, resolveOwn, listModels, syncOriginRules } from "./model.js";

export function createSettingsApi({ getConfig, setConfig }) {
  const snapshot = () => {
    const c = getConfig();
    return {
      enabled: true, active: BY_ID[c.provider] ? c.provider : "ollama", keyStorage: "extension",
      providers: PROVIDERS.map(def => { const p = (c.providers || {})[def.id] || {}; return { id: def.id, label: def.label, needsKey: def.needsKey, editableUrl: !!def.editableUrl, hasKey: !!p.key, keyHint: p.key ? p.key.slice(-4) : "", keyFromEnv: false, model: p.model || "", defaultModel: def.defaultModel, baseUrl: p.baseUrl || "", defaultBaseUrl: def.baseUrl }; }),
    };
  };
  /** Chrome shows its own prompt the first time a custom address is used. Must run from a click. */
  async function ensureHost(cfg) {
    if (!cfg || !chrome.permissions) return true;
    let origin; try { origin = new URL(cfg.baseUrl).origin + "/*"; } catch { return false; }
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return chrome.permissions.request({ origins: [origin] });
  }
  const NO_HOST = { message: "Chrome needs your OK to let Cold talk to that address." };

  return {
    getSettings: async () => snapshot(),
    async saveSettings(patch) {
      const c = getConfig(), next = { ...c, providers: { ...(c.providers || {}) } };
      if (patch.active) { if (!BY_ID[patch.active]) throw { message: "Unknown provider." }; next.provider = patch.active; next.configured = true; }
      for (const [id, v] of Object.entries(patch.providers || {})) {
        if (!BY_ID[id]) throw { message: "Unknown provider." };
        const p = { ...(next.providers[id] || {}) };
        if (v.apiKey === null) delete p.key; else if (v.apiKey) p.key = String(v.apiKey).trim();
        if (v.baseUrl !== undefined) { if (v.baseUrl && !/^https?:\/\/[^\s/]+/i.test(v.baseUrl.trim())) throw { message: "Base URL must start with http:// or https://." }; v.baseUrl ? (p.baseUrl = v.baseUrl.trim().replace(/\/+$/, "")) : delete p.baseUrl; }
        if (v.model !== undefined) { if (/\s/.test((v.model || "").trim())) throw { message: "Invalid model name." }; v.model ? (p.model = v.model.trim()) : delete p.model; }
        next.providers[id] = p;
      }
      if (!(await ensureHost(resolveOwn({ ...next, configured: true })))) throw NO_HOST;
      await saveModelConfig(next); await syncOriginRules(next); setConfig(next);
      return snapshot();
    },
    async providerModels(id) {
      const cfg = resolveOwn({ ...getConfig(), configured: true }, id);
      if (!(await ensureHost(cfg))) throw NO_HOST;
      await syncOriginRules(getConfig());
      return listModels(cfg);
    },
  };
}
