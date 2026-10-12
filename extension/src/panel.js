// Cold side panel. It works on its own: products and drafts are kept in this browser, and the model is the extension's own.
// When the Cold desktop app is running and paired, it syncs with it and can use its model; when the app closes, nothing stops.
import "../../src/styles/tokens.css";
import "../../src/styles/layout.css";
import "../../src/styles/components.css";
import "./panel.css";
import { h } from "../../src/components/dom.js";
import { button, notice, chip } from "../../src/components/ui.js";
import { createStore } from "../../src/state/store.js";
import { getConnection } from "./connection.js";
import { createReplica } from "./replica.js";
import { createLink } from "./link.js";
import { createBackend } from "./backend.js";
import { loadModelConfig, syncOriginRules } from "./model.js";
import { mountWorkspace } from "./workspace.js";
import { mountSettingsView } from "./settingsView.js";
import { mountProductsView } from "./productsView.js";

const REPLICA_KEY = "cold.replica";
const storage = { get: async () => (await chrome.storage.local.get(REPLICA_KEY))[REPLICA_KEY] || null, set: data => chrome.storage.local.set({ [REPLICA_KEY]: data }) };

async function boot() {
  const root = document.getElementById("app");
  let config = await loadModelConfig();
  const replica = createReplica({ storage });
  await replica.load();
  const store = createStore({ storage: {} });
  store.start({ db: replica });
  const link = createLink({ replica });
  const backend = createBackend({ link, getConfig: () => config });
  syncOriginRules(config).catch(() => {});

  const views = { write: h("section", { "aria-label": "Write" }), products: h("section", { "aria-label": "Products", hidden: true }), settings: h("section", { "aria-label": "Settings", hidden: true }) };
  const status = h("div", { class: "x-status", role: "status" });
  const banner = h("div", {});
  let current = "write";
  const show = name => {
    current = name;
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
    tabs.forEach(t => { t.querySelector("input").checked = t.querySelector("input").value === name; });
    paint();
  };
  const tabs = [["write", "Write"], ["products", "Products"], ["settings", "Settings"]].map(([k, label]) => h("label", {}, h("input", { type: "radio", name: "xview", value: k, checked: k === current, onchange: () => show(k) }), label));

  function paint() {
    const d = backend.describe(), s = link.state;
    status.replaceChildren(
      h("strong", {}, "Cold"),
      d ? chip(d.kind === "app" ? "good" : "accent", d.label, { glyph: false }) : chip("warn", "No model set up"),
      ...(s.conn ? [chip(s.online ? "good" : "neutral", s.online ? "App connected" : "App not running", { glyph: false })] : []));
    const msgs = [];
    if (!d) msgs.push(notice("warn", h("strong", {}, "Choose a model to start."), h("p", {}, "Pick a provider in Settings, or open the Cold app and pair it. Local models like Ollama need no key."), button("Open Settings", { onclick: () => show("settings") })));
    else if (s.conn && !s.online && !s.rejected) msgs.push(notice("info", h("strong", {}, "The Cold app isn't running."), h("p", {}, `You can keep writing: Cold uses the copy saved in this browser${replica.pending ? ` and will sync ${replica.pending} change${replica.pending === 1 ? "" : "s"} when the app is back` : ""}.`)));
    if (s.rejected) msgs.push(notice("bad", h("strong", {}, "The app rejected this extension's pairing code."), h("p", {}, "Open Settings, disconnect, and pair again with the current code.")));
    banner.replaceChildren(...msgs);
  }
  link.subscribe(paint); store.subscribe(t => { if (t === "emails" || t === "products") paint(); });

  root.append(h("div", { class: "x-head" }, status), h("div", { class: "pills", role: "radiogroup", "aria-label": "Section", style: "margin-bottom:12px" }, tabs), banner, views.write, views.products, views.settings);
  mountWorkspace(views.write, { backend, store, onOpenSettings: () => show("settings") });
  mountProductsView(views.products, { store });
  mountSettingsView(views.settings, { link, replica, getConfig: () => config, setConfig: c => { config = c; paint(); } });
  paint();

  const conn = await getConnection();
  if (conn) await link.connect(conn);
  link.start();
}

boot().catch(e => { document.getElementById("app").append(h("p", {}, `Cold couldn't start: ${e && e.message ? e.message : e}`)); });
