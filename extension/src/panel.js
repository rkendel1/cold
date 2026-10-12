// Cold side panel: connect screen, then the workspace. Reuses the app's own domain, generation and storage modules.
import "../../src/styles/tokens.css";
import "../../src/styles/layout.css";
import "../../src/styles/components.css";
import "./panel.css";
import { h, clear } from "../../src/components/dom.js";
import { button, notice, field, textInput } from "../../src/components/ui.js";
import { createApi } from "../../src/services/api.js";
import { createRemoteDb } from "../../src/services/sqliteDb.js";
import { createStore } from "../../src/state/store.js";
import { getConnection, saveConnection, clearConnection, appFetch, verify } from "./connection.js";
import { mountWorkspace } from "./workspace.js";

const root = document.getElementById("app");

function showConnect(message = "") {
  clear(root);
  const address = field({ id: "cAddress", label: "App address", required: null, hint: "Shown in Cold: Settings > Browser extension.", control: textInput({ value: "127.0.0.1:47821", inputmode: "url" }) });
  const code = field({ id: "cCode", label: "Pairing code", required: null, hint: "Copy it from the same place in Settings.", control: (id, d) => h("input", { type: "password", id, autocomplete: "off", spellcheck: "false", "aria-describedby": d }) });
  const status = h("div", { role: "status" }, message ? notice("bad", message) : null);
  const go = button("Connect", { kind: "primary", type: "submit" });
  const form = h("form", { class: "form", novalidate: true },
    h("h1", {}, "Connect to Cold"),
    h("p", { class: "lede" }, "Cold works from the desktop app. It keeps your products, drafts and model settings; this extension uses them. Open the app, go to Settings, and copy the address and pairing code here."),
    address, code, h("div", { class: "actions" }, go), status);
  form.addEventListener("submit", async e => {
    e.preventDefault(); go.disabled = true; go.textContent = "Connecting…"; clear(status);
    try { await saveConnection(await verify(address.input.value, code.input.value)); await boot(); }
    catch (err) { clear(status).append(notice("bad", err.message || "Couldn't connect.")); go.disabled = false; go.textContent = "Connect"; }
  });
  root.append(form);
}

function showProblem(text, conn) {
  clear(root).append(h("div", { class: "form" }, h("h1", {}, "Cold"), notice("warn", text),
    h("div", { class: "actions" }, button("Try again", { kind: "primary", onclick: () => boot() }), button("Change connection", { kind: "ghost", onclick: async () => { await clearConnection(); showConnect(); } }))));
}

async function boot() {
  clear(root);
  const conn = await getConnection();
  if (!conn) return showConnect();
  const fetchImpl = appFetch(conn);
  const api = createApi({ fetchImpl, remote: true });
  const config = await api.config();
  if (!config) return showProblem("Couldn't reach the Cold app. Make sure it's running, then try again.", conn);
  const db = createRemoteDb({ fetchImpl, migrate: false });
  try { await db.load(); }
  catch (e) { return showProblem("The Cold app didn't accept this extension's pairing code. Open Settings in the app and copy the current code.", conn); }
  const store = createStore({ storage: {} });
  store.start({ db });
  mountWorkspace(root, { api, store, config, onDisconnect: async () => { db.stop(); await clearConnection(); showConnect(); } });
}

boot().catch(() => showProblem("Something went wrong starting Cold. Try again.", null));
