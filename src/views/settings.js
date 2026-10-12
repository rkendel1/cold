// Settings (desktop app / local install): choose the provider and model, and save API keys for any provider.
// Keys are sent to the local server once and never come back: the server only reports whether one is saved.
import { h, clear } from "../components/dom.js";
import { button, notice, toast, announce } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import { copyText } from "../services/clipboard.js";

const OTHER = "__other__";

export function mountSettings(root, { store, platform }) {
  const S = store.state, api = platform.api;
  let snap = null;            // GET /api/settings
  let models = [];            // live model list for the shown provider
  let modelsMsg = "";
  let loadSeq = 0;

  const body = h("div", { class: "in" });
  root.append(
    h("div", { class: "view-head" },
      h("h1", { id: "settings-title", tabindex: "-1" }, "Settings"),
      h("p", { class: "lede" }, "Pick the AI provider and model Cold writes with. Add a key for any provider you use; only the provider you select receives your prompts.")),
    body);

  const providerSelect = h("select", { id: "setProvider" });
  const keyInput = h("input", { type: "password", id: "setKey", autocomplete: "off", spellcheck: "false" });
  const urlInput = h("input", { type: "text", id: "setUrl", autocomplete: "off", spellcheck: "false" });
  const modelSelect = h("select", { id: "setModel" });
  const modelText = h("input", { type: "text", id: "setModelText", autocomplete: "off", spellcheck: "false", placeholder: "Model name, e.g. llama3.1" });
  const status = h("p", { class: "hint", role: "status" });

  const shown = () => snap.providers.find(p => p.id === providerSelect.value);
  const chosenModel = () => (modelSelect.value === OTHER ? modelText.value.trim() : modelSelect.value);

  function renderModelOptions() {
    const p = shown();
    const current = p.model || "";
    clear(modelSelect);
    modelSelect.append(h("option", { value: "" }, p.defaultModel ? `Default: ${p.defaultModel}` : "Choose a model"));
    const ids = new Set();
    const add = id => { if (id && !ids.has(id)) { ids.add(id); modelSelect.append(h("option", { value: id }, id)); } };
    add(current); models.forEach(m => add(m.id));
    modelSelect.append(h("option", { value: OTHER }, "Other: type a model name…"));
    modelSelect.value = current && ids.has(current) ? current : "";
    modelText.hidden = true;
  }
  modelSelect.addEventListener("change", () => { modelText.hidden = modelSelect.value !== OTHER; if (!modelText.hidden) modelText.focus(); });

  function renderProvider() {
    const p = shown();
    keyInput.value = "";
    keyInput.placeholder = p.hasKey ? (p.keyFromEnv ? "Set by environment variable" : `Saved (ends in ${p.keyHint}). Paste a new key to replace it.`) : (p.needsKey ? "Paste API key" : "Not needed");
    keyInput.disabled = p.id === "ollama";
    urlInput.value = p.baseUrl || "";
    urlInput.placeholder = p.defaultBaseUrl || "https://your-server/v1";
    renderModelOptions();
    renderBody();
    loadModels();
  }

  async function loadModels() {
    const p = shown(), seq = ++loadSeq;
    models = []; modelsMsg = "";
    if ((p.needsKey && !p.hasKey) || (!p.baseUrl && !p.defaultBaseUrl)) { modelsMsg = p.needsKey && !p.hasKey ? "Save an API key to load this provider's models." : "Enter a base URL to load models."; renderModelOptions(); renderBody(); return; }
    modelsMsg = "Loading models…"; renderBody();
    try { const list = await api.providerModels(p.id); if (seq !== loadSeq) return; models = list; modelsMsg = list.length ? `${list.length} models available.` : "No models reported. Choose “Other” to type one."; }
    catch (e) { if (seq !== loadSeq) return; modelsMsg = `${e.message || "Couldn't load models."} You can still type a model name.`; }
    renderModelOptions(); renderBody();
  }

  const msgEl = h("p", { class: "hint", id: "setModelMsg", role: "status" });
  function renderBody() { msgEl.textContent = modelsMsg; }

  async function save() {
    const p = shown();
    const patch = { active: p.id, providers: { [p.id]: {} } };
    const e = patch.providers[p.id];
    if (keyInput.value.trim()) e.apiKey = keyInput.value.trim();
    if (p.editableUrl) e.baseUrl = urlInput.value.trim();
    e.model = chosenModel();
    if (modelSelect.value === OTHER && !e.model) { status.textContent = "Type a model name, or pick one from the list."; modelText.focus(); return; }
    saveBtn.disabled = true; status.textContent = "Saving…";
    try {
      snap = await api.saveSettings(patch);
      const fresh = await platform.refresh();
      store.set({ server: fresh.server, sample: fresh.sample, sampleState: fresh.sampleState }, "server");
      status.textContent = fresh.server?.ready ? `Saved. Cold will write with ${fresh.server.providerLabel || fresh.server.provider} · ${fresh.server.model}.` : `Saved, but ${shown().label} isn't ready yet: ${fresh.server?.keySetting ? `set ${fresh.server.keySetting}.` : "check the settings above."}`;
      announce(status.textContent); toast("Settings saved");
      renderProvider(); // refresh placeholders / model list from the saved state
    } catch (err) { status.textContent = err.message || "Couldn't save settings."; }
    finally { saveBtn.disabled = false; }
  }

  const saveBtn = button("Save and use this provider", { kind: "primary", onclick: save });
  const removeKeyBtn = button("Remove saved key", { kind: "ghost danger", onclick: async () => {
    const p = shown(); if (!p.hasKey || p.keyFromEnv) return;
    try { snap = await api.saveSettings({ providers: { [p.id]: { apiKey: null } } }); const fresh = await platform.refresh(); store.set({ server: fresh.server, sample: fresh.sample, sampleState: fresh.sampleState }, "server"); toast("Key removed"); renderProvider(); }
    catch (e) { status.textContent = e.message || "Couldn't remove the key."; }
  } });
  const refreshBtn = button("Refresh models", { onclick: async () => {
    const p = shown();
    // Use whatever key / URL is typed: save it (without switching provider) so the server can query the provider.
    const e = {}; if (keyInput.value.trim()) e.apiKey = keyInput.value.trim(); if (p.editableUrl) e.baseUrl = urlInput.value.trim();
    if (Object.keys(e).length) { try { snap = await api.saveSettings({ providers: { [p.id]: e } }); keyInput.value = ""; const keep = chosenModel(); const cur = shown(); cur.model = keep || cur.model; renderProvider(); return; } catch (err) { modelsMsg = err.message; renderBody(); return; } }
    loadModels();
  } });

  function mountForm() {
    clear(body);
    clear(providerSelect);
    providerSelect.append(...snap.providers.map(p => h("option", { value: p.id }, p.label)));
    providerSelect.value = snap.active;
    providerSelect.addEventListener("change", () => { status.textContent = ""; renderProvider(); });
    const f = (label, hint, ...ctl) => h("div", { class: "field" }, h("label", { for: ctl[0].id }, label), hint ? h("p", { class: "hint" }, hint) : null, ...ctl);
    const urlField = f("Base URL", "Where this provider's API lives. Leave the default unless you run your own server.", urlInput);
    const sync = () => { urlField.hidden = !shown().editableUrl; removeKeyBtn.hidden = !(shown().hasKey && !shown().keyFromEnv); };
    providerSelect.addEventListener("change", sync); store.subscribe(t => { if (t === "server" && snap) sync(); });
    body.append(
      f("Provider", "The provider Cold generates with. Keys you save for other providers are kept until you switch.", providerSelect),
      f("API key", snap.keyStorage === "encrypted" ? "Encrypted with your operating system's keychain. It is sent only to this provider." : "Saved in a private file on this computer (this system has no keychain available). It is sent only to this provider.", keyInput, h("div", { class: "actions" }, removeKeyBtn)),
      urlField,
      f("Model", null, modelSelect, modelText, h("div", { class: "actions" }, refreshBtn), msgEl),
      h("div", { class: "actions" }, saveBtn), status);
    renderProvider(); sync();
    keyInput.addEventListener("input", () => { sync(); });
  }

  /* ---------- browser extension pairing ---------- */
  const extHost = h("section", { class: "ext-panel", "aria-labelledby": "ext-title" });
  async function renderExtension() {
    clear(extHost);
    if (!S.server || !S.server.dbEnabled) return;
    let info;
    try { info = await api.getExtension(); } catch (e) { extHost.append(notice("bad", e.message || "Couldn't load extension details.")); return; }
    const code = h("input", { type: "password", id: "extCode", readonly: true, value: info.token, "aria-label": "Pairing code", spellcheck: "false" });
    const show = button("Show", { onclick: () => { const hid = code.type === "password"; code.type = hid ? "text" : "password"; show.textContent = hid ? "Hide" : "Show"; } });
    const copy = (label, text) => button(`Copy ${label}`, { onclick: async () => { toast((await copyText(text)) ? `${label[0].toUpperCase()}${label.slice(1)} copied` : "Couldn't copy. Select it and copy by hand."); } });
    const rotate = button("Create a new code", { kind: "ghost danger", onclick: async () => {
      if (!(await confirmDialog({ title: "Create a new pairing code?", body: "The extension will be disconnected until you paste the new code into it.", confirmLabel: "Create new code" }))) return;
      try { await api.rotateExtension(); toast("New code created"); renderExtension(); } catch (e) { toast(e.message || "Couldn't create a new code."); }
    } });
    extHost.append(
      h("h2", { id: "ext-title" }, "Browser extension"),
      h("p", { class: "hint" }, "The Cold extension works from this app: it reads your products and saves drafts here, and writes with the provider and model you chose above. It can't see your API keys. Paste the address and pairing code into the extension's setup screen."),
      h("div", { class: "field" }, h("label", { for: "extUrl" }, "App address"), h("input", { type: "text", id: "extUrl", readonly: true, value: info.origin }), h("div", { class: "actions" }, copy("address", info.origin))),
      h("div", { class: "field" }, h("label", { for: "extCode" }, "Pairing code"), code, h("div", { class: "actions" }, show, copy("code", info.token), rotate)),
      h("p", { class: "hint" }, "Your data is one SQLite file you can back up: ", h("span", { class: "mono" }, info.dbFile)));
  }

  async function load() {
    clear(body);
    if (!S.server) { body.append(notice("warn", "Settings need the Cold desktop app or a local Cold server.")); return; }
    if (!S.server.settingsEnabled) { body.append(notice("info", h("strong", {}, "Settings are managed on the server."), h("p", {}, "This copy of Cold is configured through environment variables, so there's nothing to change here. Use the Cold desktop app to pick providers, models and keys in the UI."))); return; }
    body.append(h("p", { class: "hint" }, "Loading settings…"));
    try { snap = await api.getSettings(); mountForm(); body.append(extHost); renderExtension(); }
    catch (e) { clear(body); body.append(notice("bad", e.message || "Couldn't load settings.")); }
  }

  return { init: load, reload: load };
}
