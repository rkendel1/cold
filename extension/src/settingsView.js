// Extension settings: the extension's own model, the optional link to the Cold app, and what is saved where.
import { h, clear } from "../../src/components/dom.js";
import { button, notice, field, textInput, toast, announce } from "../../src/components/ui.js";
import { PROVIDERS, BY_ID } from "../../lib/providers.js";
import { saveConnection, clearConnection, verify } from "./connection.js";
import { saveModelConfig, resolveOwn, listModels, syncOriginRules } from "./model.js";

const OTHER = "__other__";

export function mountSettingsView(root, { link, replica, getConfig, setConfig }) {
  const host = h("div", { class: "x-stack" });
  root.append(host);

  /* ---------- model ---------- */
  function modelSection() {
    const c = getConfig();
    const sel = h("select", { id: "mProvider", "aria-label": "Provider" }, PROVIDERS.map(p => h("option", { value: p.id }, p.label)));
    sel.value = BY_ID[c.provider] ? c.provider : "ollama";
    const key = h("input", { type: "password", id: "mKey", autocomplete: "off", spellcheck: "false" });
    const url = h("input", { type: "text", id: "mUrl", autocomplete: "off", spellcheck: "false" });
    const modelSel = h("select", { id: "mModel", "aria-label": "Model" });
    const modelText = h("input", { type: "text", id: "mModelText", autocomplete: "off", placeholder: "Model name", hidden: true });
    const preferSel = h("select", { id: "mPrefer", "aria-label": "Which model to use" },
      h("option", { value: "app" }, "The Cold app's, when it's running"), h("option", { value: "own" }, "This extension's, always"));
    preferSel.value = c.prefer || "app";
    const msg = h("p", { class: "hint", role: "status" });
    let models = [];

    const def = () => BY_ID[sel.value];
    const saved = () => (getConfig().providers || {})[sel.value] || {};
    function renderModelOptions() {
      const cur = saved().model || "";
      clear(modelSel).append(h("option", { value: "" }, def().defaultModel ? `Default: ${def().defaultModel}` : "Choose a model"));
      const ids = new Set(); const add = id => { if (id && !ids.has(id)) { ids.add(id); modelSel.append(h("option", { value: id }, id)); } };
      add(cur); models.forEach(m => add(m.id)); modelSel.append(h("option", { value: OTHER }, "Other: type a model name…"));
      modelSel.value = cur && ids.has(cur) ? cur : ""; modelText.hidden = true;
    }
    modelSel.addEventListener("change", () => { modelText.hidden = modelSel.value !== OTHER; if (!modelText.hidden) modelText.focus(); });
    function renderProvider() {
      const s = saved(); key.value = "";
      key.placeholder = s.key ? `Saved (ends in ${s.key.slice(-4)}). Paste a new key to replace it.` : def().needsKey ? "Paste API key" : "Not needed";
      key.disabled = def().id === "ollama";
      url.value = s.baseUrl || ""; url.placeholder = def().baseUrl || "https://your-server/v1";
      urlField.hidden = !def().editableUrl; models = []; renderModelOptions(); msg.textContent = "";
    }
    const urlField = h("div", { class: "field" }, h("label", { for: "mUrl" }, "Base URL"), url);

    /** The provider config as it would be saved, without saving it yet. */
    function draft() {
      const next = { ...getConfig(), provider: sel.value, prefer: preferSel.value, providers: { ...(getConfig().providers || {}) } };
      const p = { ...(next.providers[sel.value] || {}) };
      if (key.value.trim()) p.key = key.value.trim();
      if (def().editableUrl) p.baseUrl = url.value.trim();
      const m = modelSel.value === OTHER ? modelText.value.trim() : modelSel.value; if (m) p.model = m; else delete p.model;
      next.providers[sel.value] = p;
      return next;
    }
    async function ensureHost(next) {
      const cfg = resolveOwn(next); if (!cfg || !chrome.permissions) return true;
      let origin; try { origin = new URL(cfg.baseUrl).origin + "/*"; } catch { return false; }
      if (await chrome.permissions.contains({ origins: [origin] })) return true;
      return chrome.permissions.request({ origins: [origin] });   // must run from a click: it shows Chrome's own prompt
    }
    async function refresh() {
      const next = { ...draft(), configured: true }, cfg = resolveOwn(next);
      if (!cfg || (def().needsKey && !cfg.key) || !cfg.baseUrl) { msg.textContent = def().needsKey && !cfg.key ? "Enter an API key to load this provider's models." : "Enter a base URL first."; return; }
      if (!(await ensureHost(next))) { msg.textContent = "Chrome needs your OK to let Cold talk to that address."; return; }
      await syncOriginRules(next);
      msg.textContent = "Loading models…";
      try { models = await listModels(cfg); msg.textContent = models.length ? `${models.length} models available.` : "No models reported. Choose “Other” to type one."; }
      catch (e) { models = []; msg.textContent = `${e.message} You can still type a model name.`; }
      renderModelOptions();
    }
    async function save() {
      const next = { ...draft(), configured: true }; const cfg = resolveOwn(next);
      if (modelSel.value === OTHER && !modelText.value.trim()) { msg.textContent = "Type a model name, or pick one."; return; }
      if (!(await ensureHost(next))) { msg.textContent = "Chrome needs your OK to let Cold talk to that address."; return; }
      await saveModelConfig(next); await syncOriginRules(next); setConfig(next);
      msg.textContent = cfg && cfg.ready ? `Saved. This extension will use ${cfg.label} · ${cfg.model}.` : "Saved, but it isn't ready yet: add the missing key, URL or model.";
      announce(msg.textContent); toast("Saved"); renderProvider();
    }
    sel.addEventListener("change", renderProvider);
    const f = (label, hint, ...ctl) => h("div", { class: "field" }, h("label", { for: ctl[0].id }, label), hint ? h("p", { class: "hint" }, hint) : null, ...ctl);
    renderProvider();
    return h("section", { class: "x-card", "aria-labelledby": "m-title" }, h("h2", { id: "m-title" }, "Model for this extension"),
      h("p", { class: "hint" }, "Used when the Cold app isn't running. Keys saved here stay in this browser profile and are not encrypted; the Cold app keeps its own keys in your computer's keychain."),
      f("Provider", null, sel), f("API key", null, key), urlField,
      f("Model", null, modelSel, modelText, h("div", { class: "actions" }, button("Refresh models", { onclick: refresh })), msg),
      f("Which model should Write use?", "If the app is running and you choose its model, nothing here is needed.", preferSel),
      h("div", { class: "actions" }, button("Save", { kind: "primary", onclick: save })));
  }

  /* ---------- app link ---------- */
  function appSection() {
    const box = h("section", { class: "x-card", "aria-labelledby": "a-title" }, h("h2", { id: "a-title" }, "Cold app (optional)"));
    function paint() {
      clear(box).append(h("h2", { id: "a-title" }, "Cold app (optional)"));
      const s = link.state;
      if (!s.conn) {
        const address = field({ id: "cAddress", label: "App address", required: null, hint: "Cold: Settings > Browser extension.", control: textInput({ value: "127.0.0.1:47821", inputmode: "url" }) });
        const code = field({ id: "cCode", label: "Pairing code", required: null, control: (id, d) => h("input", { type: "password", id, autocomplete: "off", spellcheck: "false", "aria-describedby": d }) });
        const status = h("div", { role: "status" });
        const go = button("Connect", { kind: "primary", onclick: async () => {
          go.disabled = true; clear(status);
          try { const conn = await verify(address.input.value, code.input.value); await saveConnection(conn); await link.connect(conn); toast("Connected"); }
          catch (e) { clear(status).append(notice("bad", e.message || "Couldn't connect.")); go.disabled = false; }
        } });
        box.append(h("p", { class: "hint" }, "Everything works without the app. Connect it to share your products and drafts with it, and to use its model."), address, code, h("div", { class: "actions" }, go), status);
        return;
      }
      box.append(
        s.online ? notice("good", h("strong", {}, "Connected."), h("p", {}, `The app is running (${s.config.providerLabel || s.config.provider} · ${s.config.model}). Changes sync automatically.`))
          : s.rejected ? notice("bad", h("strong", {}, "The app rejected the pairing code."), h("p", {}, "Disconnect, then connect again with the current code from the app's Settings."))
          : notice("warn", h("strong", {}, "The app isn't running."), h("p", {}, "Cold keeps working from the copy saved in this browser. Drafts and edits sync the next time the app starts.")),
        h("p", { class: "hint" }, `App: ${s.conn.origin}`),
        h("div", { class: "actions" }, button("Disconnect", { kind: "ghost danger", onclick: async () => { await clearConnection(); link.disconnect(); toast("Disconnected"); } })));
    }
    paint(); link.subscribe(paint);
    return box;
  }

  /* ---------- data ---------- */
  function dataSection() {
    const line = h("p", { class: "hint", role: "status" });
    const paint = () => {
      const when = replica.lastSync ? new Date(replica.lastSync).toLocaleString() : "never";
      line.textContent = `Products and drafts are saved in this browser. ${replica.pending ? `${replica.pending} change${replica.pending === 1 ? "" : "s"} waiting to sync with the app.` : "Nothing waiting to sync."} Last synced with the app: ${when}.`;
    };
    paint(); link.subscribe(paint);
    return h("section", { class: "x-card" }, h("h2", {}, "Your data"), line);
  }

  host.append(appSection(), modelSection(), dataSection());
}
