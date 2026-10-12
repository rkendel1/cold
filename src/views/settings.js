// Settings: the same sections on every surface (web, desktop, extension), in the same order and words.
//   Model                        which provider and model write your drafts (editable where this surface keeps the keys)
//   Cold desktop app             web and extension: connect, see sync status
//   Browser extension & web apps desktop only: pairing code and the web pages allowed to sync
//   Your data                    where your records live
// What a surface can't do is said in place, never silently omitted.
import { h, clear, append } from "../components/dom.js";
import { button, notice, toast, announce } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import { copyText } from "../services/clipboard.js";

const OTHER = "__other__";
const KEY_NOTE = {
  encrypted: "Encrypted with your operating system's keychain. It is sent only to this provider.",
  file: "Saved in a private file on this computer (this system has no keychain available). It is sent only to this provider.",
  extension: "Saved in this browser profile's extension storage, which is not encrypted (the desktop app uses your keychain). It is sent only to this provider.",
};

export function mountSettings(root, { store, platform }) {
  const S = store.state;
  const body = h("div", { class: "in" });
  root.append(
    h("div", { class: "view-head" },
      h("h1", { id: "settings-title", tabindex: "-1" }, "Settings"),
      h("p", { class: "lede" }, "Choose the model that writes your drafts and connect Cold's other surfaces. Provider keys stay where you enter them and are never sent to the web page, the extension or the desktop app on your behalf.")),
    body);

  const section = (id, title, ...kids) => h("section", { class: "set-section", "aria-labelledby": `${id}-title` }, h("h2", { id: `${id}-title` }, title), ...kids);
  const field = (label, ...ctl) => h("div", { class: "field" }, h("label", { for: ctl[0].id }, label), ...ctl);

  /* ---------- Model: the editable form, for a surface that stores provider keys ---------- */
  function modelForm(sapi) {
    let snap = null, models = [], modelsMsg = "", loadSeq = 0;
    const host = h("div", { class: "form" });
    const providerSelect = h("select", { id: "setProvider" });
    const keyInput = h("input", { type: "password", id: "setKey", autocomplete: "off", spellcheck: "false" });
    const urlInput = h("input", { type: "text", id: "setUrl", autocomplete: "off", spellcheck: "false" });
    const modelSelect = h("select", { id: "setModel" });
    const modelText = h("input", { type: "text", id: "setModelText", autocomplete: "off", spellcheck: "false", placeholder: "Model name, e.g. llama3.1" });
    const msgEl = h("p", { class: "hint", id: "setModelMsg", role: "status" });
    const status = h("p", { class: "hint", role: "status" });
    const shown = () => snap.providers.find(p => p.id === providerSelect.value);
    const chosenModel = () => (modelSelect.value === OTHER ? modelText.value.trim() : modelSelect.value);

    function renderModelOptions() {
      const p = shown(), current = p.model || "";
      clear(modelSelect).append(h("option", { value: "" }, p.defaultModel ? `Default: ${p.defaultModel}` : "Choose a model"));
      const ids = new Set(); const add = id => { if (id && !ids.has(id)) { ids.add(id); modelSelect.append(h("option", { value: id }, id)); } };
      add(current); models.forEach(m => add(m.id));
      modelSelect.append(h("option", { value: OTHER }, "Other: type a model name…"));
      modelSelect.value = current && ids.has(current) ? current : ""; modelText.hidden = true;
    }
    modelSelect.addEventListener("change", () => { modelText.hidden = modelSelect.value !== OTHER; if (!modelText.hidden) modelText.focus(); });
    const urlField = field("Base URL", urlInput);
    const removeKeyBtn = button("Remove saved key", { kind: "ghost danger", onclick: async () => {
      const p = shown(); if (!p.hasKey || p.keyFromEnv) return;
      try { snap = await sapi.saveSettings({ providers: { [p.id]: { apiKey: null } } }); await after(); toast("Key removed"); renderProvider(); }
      catch (e) { status.textContent = e.message || "Couldn't remove the key."; }
    } });
    const sync = () => { urlField.hidden = !shown().editableUrl; removeKeyBtn.hidden = !(shown().hasKey && !shown().keyFromEnv); };

    function renderProvider() {
      const p = shown();
      keyInput.value = ""; keyInput.disabled = p.id === "ollama";
      keyInput.placeholder = p.hasKey ? (p.keyFromEnv ? "Set by environment variable" : `Saved (ends in ${p.keyHint}). Paste a new key to replace it.`) : (p.needsKey ? "Paste API key" : "Not needed");
      urlInput.value = p.baseUrl || ""; urlInput.placeholder = p.defaultBaseUrl || "https://your-server/v1";
      renderModelOptions(); sync(); loadModels();
    }
    async function loadModels() {
      const p = shown(), seq = ++loadSeq; models = [];
      if ((p.needsKey && !p.hasKey) || (!p.baseUrl && !p.defaultBaseUrl)) { msgEl.textContent = p.needsKey && !p.hasKey ? "Save an API key to load this provider's models." : "Enter a base URL to load models."; renderModelOptions(); return; }
      msgEl.textContent = "Loading models…";
      try { const list = await sapi.providerModels(p.id); if (seq !== loadSeq) return; models = list; msgEl.textContent = list.length ? `${list.length} models available.` : "No models reported. Choose “Other” to type one."; }
      catch (e) { if (seq !== loadSeq) return; msgEl.textContent = `${e.message || "Couldn't load models."} You can still type a model name.`; }
      renderModelOptions();
    }
    /** Tell the rest of the app the model may have changed. */
    async function after() { const fresh = await platform.refresh(); store.set({ server: fresh.server, sample: fresh.sample, sampleState: fresh.sampleState }, "server"); return fresh; }
    async function save() {
      const p = shown();
      const patch = { active: p.id, providers: { [p.id]: {} } }, e = patch.providers[p.id];
      if (keyInput.value.trim()) e.apiKey = keyInput.value.trim();
      if (p.editableUrl) e.baseUrl = urlInput.value.trim();
      e.model = chosenModel();
      if (modelSelect.value === OTHER && !e.model) { status.textContent = "Type a model name, or pick one from the list."; modelText.focus(); return; }
      saveBtn.disabled = true; status.textContent = "Saving…";
      try {
        snap = await sapi.saveSettings(patch);
        const fresh = await after();
        status.textContent = fresh.server && fresh.server.ready ? `Saved. Cold will write with ${fresh.server.providerLabel || fresh.server.provider} · ${fresh.server.model}.` : `Saved, but ${shown().label} isn't ready yet: add the missing key, URL or model.`;
        announce(status.textContent); toast("Settings saved"); renderProvider();
      } catch (err) { status.textContent = err.message || "Couldn't save settings."; }
      finally { saveBtn.disabled = false; }
    }
    const saveBtn = button("Save and use this provider", { kind: "primary", onclick: save });
    const refreshBtn = button("Refresh models", { onclick: async () => {
      const p = shown(), e = {};   // use what's typed: save it (without switching provider) so the provider can be queried
      if (keyInput.value.trim()) e.apiKey = keyInput.value.trim(); if (p.editableUrl) e.baseUrl = urlInput.value.trim();
      if (Object.keys(e).length) { try { snap = await sapi.saveSettings({ providers: { [p.id]: e } }); const keep = chosenModel(); const cur = shown(); cur.model = keep || cur.model; renderProvider(); return; } catch (err) { msgEl.textContent = err.message; return; } }
      loadModels();
    } });

    async function mount() {
      try { snap = await sapi.getSettings(); } catch (e) { host.append(notice("bad", e.message || "Couldn't load settings.")); return; }
      clear(providerSelect).append(...snap.providers.map(p => h("option", { value: p.id }, p.label)));
      providerSelect.value = snap.active;
      providerSelect.addEventListener("change", () => { status.textContent = ""; renderProvider(); });
      host.append(
        field("Provider", providerSelect), field("API key", keyInput, h("p", { class: "hint" }, KEY_NOTE[snap.keyStorage] || KEY_NOTE.encrypted), h("div", { class: "actions" }, removeKeyBtn)),
        urlField, field("Model", modelSelect, modelText, h("div", { class: "actions" }, refreshBtn), msgEl), h("div", { class: "actions" }, saveBtn), status);
      renderProvider();
    }
    mount();
    return host;
  }

  /* ---------- Model: a surface that doesn't store provider keys says what it uses ---------- */
  function modelSummary() {
    const box = h("div", { class: "form" });
    const paint = () => {
      const s = platform.snapshot().server, d = platform.backend && platform.backend.describe();
      clear(box); append(box, [
        s && s.ready ? h("p", {}, "This site writes with ", h("strong", {}, `${s.providerLabel || s.provider} · ${s.model}`), ", set up by whoever runs it. Provider keys stay on that server.")
          : h("p", {}, h("strong", {}, "No model is set up on this server."), " Writing drafts needs one: whoever runs this site adds a provider key on the server (see the README), and your key never passes through this page. Optionally, you can borrow the Cold desktop app's model by connecting it below. Products, drafts and History work without either."),
        d && d.kind === "app" ? h("p", { class: "hint" }, `Right now drafts are written by ${d.label}.`) : null]);
    };
    paint(); platform.subscribe(paint);
    return box;
  }

  /** Which model Write uses when both this surface's own and the desktop app's are available. */
  function preference() {
    const hub = platform.hub;
    if (!hub || !hub.link.state.conn) return null;
    const sel = h("select", { id: "setPrefer", "aria-label": "Which model Write should use" },
      h("option", { value: "app" }, "The Cold desktop app's, when it's running"), h("option", { value: "own" }, `This ${hub.kind === "web" ? "site" : "extension"}'s, always`));
    sel.value = hub.prefer; sel.addEventListener("change", () => { hub.setPrefer(sel.value); toast("Saved"); });
    return field("Which model should Write use?", sel, h("p", { class: "hint" }, "If the desktop app isn't running, Write falls back to the other automatically."));
  }

  /* ---------- Cold desktop app (web and extension) ---------- */
  function hubSection() {
    const hub = platform.hub;
    const box = h("div", { class: "form" });
    const line = h("p", { class: "hint", role: "status", id: "syncLine" });
    let shown = 0;
    const here = hub.kind === "web" ? "this browser" : "this extension";
    /** Show the library the pairing now selects. The library that is no longer shown is only detached: it is not written to or deleted. */
    const applyLibrary = () => { store.switchLibrary(hub.replica); store.set({ library: hub.libs.kind, paired: hub.libs.kind === "synced" }, "surface"); };
    const LIBRARY_LABEL = {
      shared: () => `The Cold Desktop library. ${here[0].toUpperCase()}${here.slice(1)} keeps a working copy, so you can keep working while the app is closed.`,
      standalone: () => `${here[0].toUpperCase()}${here.slice(1)}'s own library. It is not shared: what you change here does not reach the Cold Desktop library.`,
      synced: () => `${here[0].toUpperCase()}${here.slice(1)}'s library, kept in sync with the Cold Desktop app (connected before shared libraries existed).`,
    };
    /** Copy the standalone library into the shared one, only after showing exactly what will be copied. Nothing is overwritten or removed. */
    async function importStandalone() {
      const snap = await hub.libs.readStandalone();
      const haveP = new Set(S.products.map(p => p.id)), haveE = new Set(S.emails.map(e => e.id));
      const newP = snap.products.filter(p => !haveP.has(p.id)), newE = snap.emails.filter(e => !haveE.has(e.id));
      const skipped = snap.products.length - newP.length + snap.emails.length - newE.length;
      if (!newP.length && !newE.length) { toast(skipped ? "Everything in this library is already in the shared library." : `${here[0].toUpperCase()}${here.slice(1)}'s own library is empty.`); return; }
      const names = (list, f) => list.slice(0, 5).map(f).filter(Boolean).join(", ") + (list.length > 5 ? ", …" : "");
      const body = `${newP.length} product${newP.length === 1 ? "" : "s"}${newP.length ? ` (${names(newP, p => p.name)})` : ""} and ${newE.length} draft${newE.length === 1 ? "" : "s"}${newE.length ? ` (${names(newE, e => (e.recipient && e.recipient.name) || e.subject)})` : ""} will be copied. `
        + `${skipped ? `${skipped} item${skipped === 1 ? " is" : "s are"} already in the shared library and will not be touched. ` : ""}The library in ${here} is not changed or deleted.`;
      if (!(await confirmDialog({ title: "Copy into the shared library?", body, confirmLabel: "Copy" }))) return;
      let failed = 0;
      for (const p of newP) { try { await store.saveProduct(p); } catch { failed++; } }
      for (const e of newE) { try { await store.saveEmail({ ...e }); } catch { failed++; } }
      toast(failed ? `Copied, but ${failed} item${failed === 1 ? "" : "s"} could not be saved.` : `Copied ${newP.length + newE.length} item${newP.length + newE.length === 1 ? "" : "s"} into the shared library.`);
    }
    async function chooseLibrary(library) {
      const toShared = library === "shared";
      if (!(await confirmDialog({ title: toShared ? "Use the Cold Desktop library?" : `Use ${here}'s own library?`,
        body: toShared ? `You will see and edit the library kept in Cold Desktop. The library in ${here} is not changed, and you can switch back.`
          : `You will see ${here}'s own library again. The Cold Desktop library is not changed or deleted, and what you change here will not reach it until you switch back.`,
        confirmLabel: toShared ? "Use the desktop library" : "Use this library" }))) return;
      try { await hub.libs.use(library); applyLibrary(); toast(toShared ? "Using the Cold Desktop library" : `Using ${here}'s own library`); paint(); }
      catch (e) { toast(e.message || "Couldn't switch libraries."); }
    }
    function libraryBlock() {
      const k = hub.libs.kind;
      return h("div", { class: "stack", id: "libraryBlock" }, h("strong", {}, "Library in use"), h("p", { id: "libraryLine" }, LIBRARY_LABEL[k]()),
        h("div", { class: "actions" },
          k === "shared" ? button("Switch to " + here + "'s own library", { id: "useStandalone", onclick: () => chooseLibrary("standalone") }) : null,
          k === "standalone" ? button("Use the Cold Desktop library", { id: "useShared", onclick: () => chooseLibrary("shared") }) : null,
          k === "shared" ? button(`Copy ${here}'s library into the shared one…`, { id: "importStandalone", onclick: importStandalone }) : null));
    }
    const KIND = { emails: "draft", products: "product" };
    /** Edits that couldn't be merged with a newer change at the app: the app's version was kept, this one is set aside until the user decides. */
    function conflictsBlock() {
      const list = hub.replica.conflicts; shown = list.length;
      if (!list.length) return null;
      return h("div", { class: "stack", id: "syncConflicts" }, h("strong", {}, "Edits set aside"),
        h("p", { class: "hint" }, "These were changed here and in the Cold desktop app at the same time. The app's version was kept. Nothing was deleted: restore yours to replace the app's version, or dismiss it."),
        list.map(c => {
          const label = (c.mine && (c.mine.recipient?.name || c.mine.subject || c.mine.name)) || c.id;
          return h("div", { class: "row" }, h("span", {}, `${KIND[c.kind] || c.kind} “${label}” (${c.fields.join(", ")})`),
            c.mine ? button("Use my version", { onclick: async () => { await hub.replica.resolveConflict(c.kind, c.id, { restore: true }); toast("Restored. It will sync again."); paint(); } }) : null,
            button("Dismiss", { kind: "ghost", onclick: async () => { await hub.replica.resolveConflict(c.kind, c.id); paint(); } }));
        }));
    }
    function paint() {
      clear(box);
      const s = hub.link.state;
      const when = hub.replica.lastSync ? new Date(hub.replica.lastSync).toLocaleString() : "never";
      line.textContent = hub.libs.kind === "standalone" ? "Syncing is off: this library is not shared with the app."
        : `${hub.replica.pending ? `${hub.replica.pending} change${hub.replica.pending === 1 ? "" : "s"} waiting to sync. ` : "Nothing waiting to sync. "}Last synced: ${when}.`;
      if (!s.conn) {
        const addr = h("input", { type: "text", id: "hubAddress", value: "127.0.0.1:47821", inputmode: "url", autocomplete: "off", spellcheck: "false" });
        const code = h("input", { type: "password", id: "hubCode", autocomplete: "off", spellcheck: "false" });
        const msg = h("div", { role: "status", id: "hubMsg" });
        const go = button("Connect", { kind: "primary", id: "hubConnect", onclick: async () => {
          go.disabled = true; clear(msg);
          try { await hub.connect(addr.value, code.value); applyLibrary(); toast("Connected to the Cold Desktop library"); }
          catch (e) { clear(msg).append(notice("bad", e.message || "Couldn't connect.")); go.disabled = false; }
        } });
        append(box, [
          h("p", { class: "hint" }, hub.kind === "web"
            ? "Optional. Your products and drafts already work in this browser. Connect the Cold desktop app to share them with it and with the extension, and to use its model. In the app: Settings > Browser extension & web apps, add this page's address below to its allowed web apps, then copy its address and pairing code here."
            : "Optional. Everything works without the app. Connect it to share your products and drafts with it and with the web app, and to use its model. Copy its address and pairing code from its Settings > Browser extension & web apps."),
          h("p", { class: "hint", id: "connectNote" }, `Connecting makes the Cold Desktop library the one you work in. The library ${hub.kind === "web" ? "in this browser" : "in this extension"} stays exactly as it is, and you can switch back to it at any time. Nothing is copied unless you choose to copy it.`),
          hub.kind === "web" ? h("p", {}, "This page's address: ", h("code", {}, hub.origin)) : null,
          field("App address", addr), field("Pairing code", code), h("div", { class: "actions" }, go), msg, line]);
        return;
      }
      append(box, [
        s.online ? notice("good", h("strong", {}, "Connected."), h("p", {}, `The Cold desktop app is running (${s.config.providerLabel || s.config.provider} · ${s.config.model}). Changes sync automatically.`))
          : s.rejected ? notice("bad", h("strong", {}, "The desktop app rejected the pairing code."), h("p", {}, "Disconnect, then connect again with the current code from the app's Settings."))
          : notice("warn", h("strong", {}, "The Cold desktop app isn't running."), h("p", {}, "Cold keeps working from the copy saved here. Drafts and edits sync the next time the app starts.")),
        libraryBlock(), preference(), line, conflictsBlock(),
        h("div", { class: "actions" },
          button("Sync now", { id: "syncNow", onclick: async () => { try { await hub.replica.sync(); toast("Synced"); } catch { toast("The desktop app isn't reachable right now. Your changes are kept and will sync later."); } paint(); } }),
          button("Disconnect", { kind: "ghost danger", id: "hubDisconnect", onclick: async () => { await hub.disconnect(); applyLibrary(); toast("Disconnected. This " + (hub.kind === "web" ? "browser" : "extension") + "'s own library is in use."); } }))]);
    }
    paint(); hub.link.subscribe(paint); store.subscribe(t => { if (t === "emails" || t === "products") { if (box.isConnected && hub.replica.conflicts.length !== shown && hub.link.state.conn) paint(); /* pending count changed */ const p = hub.replica.pending; if (line.isConnected) line.textContent = line.textContent.replace(/^(\d+ changes? waiting to sync\. |Nothing waiting to sync\. )/, p ? `${p} change${p === 1 ? "" : "s"} waiting to sync. ` : "Nothing waiting to sync. "); } });
    return box;
  }

  /* ---------- Browser extension & web apps (desktop only) ---------- */
  async function pairingSection() {
    const api = platform.api;
    const box = h("div", { class: "form" });
    async function paint() {
      clear(box);
      let info;
      try { info = await api.getExtension(); } catch (e) { box.append(notice("bad", e.message || "Couldn't load pairing details.")); return; }
      const code = h("input", { type: "password", id: "extCode", readonly: true, value: info.token, "aria-label": "Pairing code", spellcheck: "false" });
      const show = button("Show", { onclick: () => { const hid = code.type === "password"; code.type = hid ? "text" : "password"; show.textContent = hid ? "Hide" : "Show"; } });
      const copy = (label, text) => button(`Copy ${label}`, { onclick: async () => { toast((await copyText(text)) ? `${label[0].toUpperCase()}${label.slice(1)} copied` : "Couldn't copy. Select it and copy by hand."); } });
      const rotate = button("Create a new code", { kind: "ghost danger", onclick: async () => {
        if (!(await confirmDialog({ title: "Create a new pairing code?", body: "The extension and any web app will be disconnected until you paste the new code into them.", confirmLabel: "Create new code" }))) return;
        try { await api.rotateExtension(); toast("New code created"); paint(); } catch (e) { toast(e.message || "Couldn't create a new code."); }
      } });
      const origins = h("textarea", { id: "webOrigins", rows: 3, "aria-label": "Allowed web apps", placeholder: "https://cold.example.com\nhttp://127.0.0.1:3000" }); origins.value = (info.webOrigins || []).join("\n");
      const originMsg = h("p", { class: "hint", role: "status" });
      box.append(
        h("p", { class: "hint" }, "Optional: Cold works fully without the extension or any web app. If you use them, this app is the hub: it keeps your database and your model keys. The extension and web pages you allow keep their own copy, sync with it whenever it's running, and can use its model. They can read and write products and drafts and generate; they can never see your keys or these settings."),
        field("App address", h("input", { type: "text", id: "extUrl", readonly: true, value: info.origin }), h("div", { class: "actions" }, copy("address", info.origin))),
        field("Pairing code", code, h("div", { class: "actions" }, show, copy("code", info.token), rotate)),
        field("Allowed web apps", origins, h("p", { class: "hint" }, "Web pages that may connect, one address per line (for example your hosted Cold site). They still need the pairing code. Remove a line to cut a page off."),
          h("div", { class: "actions" }, button("Save allowed web apps", { id: "saveOrigins", onclick: async () => {
            try { const r = await api.setWebOrigins(origins.value.split("\n").map(x => x.trim()).filter(Boolean)); origins.value = r.webOrigins.join("\n"); originMsg.textContent = r.webOrigins.length ? `${r.webOrigins.length} allowed.` : "No web apps are allowed."; toast("Saved"); }
            catch (e) { originMsg.textContent = e.message || "Couldn't save."; }
          } })), originMsg),
        h("p", { class: "hint" }, "Your data is one SQLite file you can back up: ", h("span", { class: "mono" }, info.dbFile)));
    }
    paint();
    return box;
  }

  /* ---------- Your data ---------- */
  function dataSection() {
    const p = h("p", { class: "hint", id: "dataLine" });
    const paint = () => { p.textContent = `Products and drafts ${store.keptNote()}`; };   // the same sentence the footer and History use
    // Storing is local; writing a draft is not necessarily. Say where the prompt for a draft goes, without promising more than is known.
    const flow = h("p", { class: "hint", id: "modelFlowLine" });
    const paintFlow = () => {
      const sv = S.server, d = platform.backend && platform.backend.describe(), name = (sv && (sv.providerLabel || sv.provider)) || "the model provider";
      flow.textContent = d && d.kind === "app" ? "When you write a draft, the prompt (this draft's product facts and recipient details) goes to the Cold desktop app, which sends it to its model provider."
        : sv && sv.provider === "ollama" ? "When you write a draft, the prompt goes to your local Ollama server. Whether anything leaves your computer depends on where that runs."
        : S.backend === "sqlite" || S.surface === "extension" ? `When you write a draft, the prompt (this draft's product facts and recipient details) is sent from ${S.surface === "extension" ? "this browser" : "this computer"} to ${name}. Your other products, drafts and notes are not sent.`
        : `When you write a draft, the prompt (this draft's product facts and recipient details) goes through this site's server to ${name}. The server doesn't keep it; the provider's own retention terms apply. Your other products, drafts and notes are not sent.`;
    };

    paint(); paintFlow(); store.subscribe(t => { if (t === "server" || t === "ready" || t === "surface") { paint(); paintFlow(); } });
    return h("div", {}, p, flow);
  }

  async function load() {
    clear(body);
    if (!S.server) { body.append(notice("warn", "Settings need the Cold desktop app, a Cold server, or the extension.")); return; }
    const sapi = platform.settingsApi;
    const model = sapi ? modelForm(sapi) : modelSummary();
    append(body, [section("model", "Model", model, preference())]);
    if (platform.hub) body.append(section("hub", "Cold desktop app", hubSection()));
    if (S.server.dbEnabled && platform.api.getExtension) body.append(section("pairing", "Browser extension & web apps", await pairingSection()));
    body.append(section("data", "Your data", dataSection()));
  }

  store.subscribe(t => { if (t === "server" && !root.hidden && !body.firstChild) load(); });
  return { init: load, reload: load };
}
