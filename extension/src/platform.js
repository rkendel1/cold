// The extension's "platform": the same interface the web app's platform has (api, settings, snapshot, refresh, hub, backend...),
// so the shared Write, Knowledge, History and Settings screens run unchanged. Differences are the data underneath: a replica kept
// in extension storage, the extension's own model connection, and the page actions only an extension can offer.
import lookups from "../../lib/profile.js";
import { createReplica } from "../../src/services/replica.js";
import { chromeReplicaStorage } from "../../src/services/replicaStorage.js";
import { createLink } from "../../src/services/hubLink.js";
import { createLibraries } from "../../src/services/libraries.js";
import { sharedKeys } from "../../src/domain/constants.js";
import { createLocalModel } from "./localModel.js";
import { createBackend } from "../../src/services/backend.js";
import { chromeHubStore, verifyHub } from "../../src/services/hub.js";
import { loadModelConfig, saveModelConfig, resolveOwn, directSample, syncOriginRules } from "./model.js";
import { createSettingsApi } from "./settingsApi.js";
import { insertIntoBox } from "./page.js";
import { extensionAuth } from "../../src/services/googleAuth.js";
import { createSheetsConnector, chromeLinkStore } from "../../src/services/sheetsConnector.js";
import { extensionDriver } from "../../src/services/accountDrivers.js";
import { workerTransport } from "../../src/services/hostedLibrary.js";

// Set when the extension is built (COLD_GOOGLE_CLIENT_ID); empty means this build has no Google Sheets option.
const GOOGLE_CLIENT_ID = typeof __COLD_GOOGLE_CLIENT_ID__ === "undefined" ? "" : __COLD_GOOGLE_CLIENT_ID__;

export async function createExtensionPlatform() {
  let config = await loadModelConfig();
  const link = createLink();
  const store = chromeHubStore();
  // Standalone: the extension's own library. Shared: a working copy of the Cold Desktop library (see src/services/libraries.js).
  const libs = createLibraries({ hubStore: store, link, makeReplica: (kind, origin) => (kind === "shared"
    ? createReplica({ storage: chromeReplicaStorage(`cold.shared@${origin}`), keepCompose: true, pushLocalFirst: false })
    : createReplica({ storage: chromeReplicaStorage(), keepCompose: true })) });
  const active = await libs.init();
  let accountDriver = null;
  try { const c = await chrome.runtime.sendMessage({ cold: "account", op: "config" }); if (c && c.enabled) accountDriver = extensionDriver(); } catch { /* no account support in this build */ }
  const subs = new Set();
  const notify = () => subs.forEach(fn => fn());
  const ownCfg = () => resolveOwn(config);
  const ownSample = directSample(ownCfg);
  // The on-device model's runtime is a separate script, fetched from inside the extension only when the user first asks for it.
  const loadRuntime = () => new Promise((resolve, reject) => {
    if (globalThis.coldWebLLM) return resolve(globalThis.coldWebLLM);
    const el = document.createElement("script");
    el.src = chrome.runtime.getURL("dist/llm-client.js");
    el.onload = () => (globalThis.coldWebLLM ? resolve(globalThis.coldWebLLM) : reject({ code: "init_failed", message: "The on-device model runtime didn't start." }));
    el.onerror = () => reject({ code: "init_failed", message: "The on-device model runtime is missing from this build of the extension." });
    document.head.append(el);
  });
  const loadPins = async () => (await fetch(chrome.runtime.getURL("dist/model-pins.json"))).json();   // shipped with the build; see modelPins.js
  const localModel = createLocalModel({ loadRuntime, loadPins, libUrl: p => chrome.runtime.getURL(`dist/${p}`) });   // build output lives in extension/dist
  const sheets = GOOGLE_CLIENT_ID ? createSheetsConnector({ auth: extensionAuth({ clientId: GOOGLE_CLIENT_ID }), linkStore: chromeLinkStore() }) : null;
  const backend = createBackend({
    link, getConfig: () => config,
    own: { ready: () => { const o = ownCfg(); return !!(o && o.ready); }, sample: ownSample, label: () => { const o = ownCfg(); return `${o.label} · ${o.model}`; },
      lookups: { tweet: url => lookups.lookupTweet(url, (...a) => fetch(...a)), profile: url => lookups.lookupProfile(url, (...a) => fetch(...a)) } },
  });

  /** Shaped like the web server's /api/config so shared screens can describe what is in use. */
  function server() {
    const d = backend.describe();
    const c = link.state.config, o = ownCfg();
    const app = d && d.kind === "app";
    return { app: "cold", ready: !!d, settingsEnabled: true, dbEnabled: false,
      provider: app ? c.provider : o && o.id, providerLabel: app ? "Cold desktop app" : o && o.label, model: app ? c.model : o && o.model, keySetting: "a model in Settings", account: accountDriver ? { enabled: true, mode: "native" } : { enabled: false } };
  }
  const snapshot = () => { const sample = backend.describe() ? backend.sample : null; return { server: server(), sample, sampleState: sample ? "ready" : "noconfig" }; };

  const platform = {
    api: { profile: backend.profile, tweet: backend.tweet, models: async () => [] },
    /** Email lookup runs only through the paired desktop app, which holds the token; the extension never stores one. */
    people: { available: backend.peopleAvailable, findEmail: backend.findEmail, verifyEmail: backend.verifyEmail },
    tregSettings: null,
    hostShowsBrand: true,   // Chrome's side-panel header already shows this extension's icon and name, so the panel doesn't repeat them
    settings: { model: "", access: "" }, setAccess() {}, setModel() {}, savedModel: () => "",
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    snapshot, backend,
    /** The extension's OWN model connection (never the paired app's or a fallback): { cfg, sample }. cfg is null until a provider is saved. */
    ownModel: () => ({ cfg: ownCfg(), sample: ownSample }),
    /** The on-device model (WebLLM in this browser): lazy, reusable, cancellable. See extension/src/localModel.js. */
    localModel,
    async refresh() { notify(); return snapshot(); },
    settingsApi: createSettingsApi({ getConfig: () => config, setConfig: c => { config = c; notify(); } }),
    hub: {
      link, libs, store, kind: "extension", get replica() { return libs.db; }, origin: "",
      get prefer() { return config.prefer || "app"; },
      setPrefer(v) { config = { ...config, prefer: v === "own" ? "own" : "app" }; saveModelConfig(config); notify(); },
      async connect(addr, code) { const conn = await verifyHub(addr, code, { who: "extension" }); await libs.connect(conn); await link.connect(conn); notify(); },
      async disconnect() { link.disconnect(); await libs.disconnect(); notify(); },
    },
    /** Things only an extension can do. */
    pageActions: {
      async insertTweet(text) {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        try { const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: insertIntoBox, args: [text] }); return result; }
        catch { return { ok: false, message: "Couldn't reach the page. Copy the text instead." }; }
      },
    },
    /** The Google Sheets connector, or null when this build has no Google client id. */
    get sheets() { return sheets; },
    /** Optional Cold account sign-in, offered only when this build has an account service configured; the worker holds the session (extension/src/account.js). */
    get accountDriver() { return accountDriver; },
    /** Hosted-library requests go through the background worker, which holds the bearer token; where the person's library choice is remembered is this extension's storage. */
    hostedTransport: workerTransport(),
    libraryChoice: { get: async () => ((await chrome.storage.local.get("cold.library.choice"))["cold.library.choice"] === "hosted"), set: async on => (on ? chrome.storage.local.set({ "cold.library.choice": "hosted" }) : chrome.storage.local.remove("cold.library.choice")) },
    async detect() {
      let db = active.db, warning = "";
      if (sheets) { try { await sheets.init(); if (sheets.link) { db = await sheets.open(db); if (db.sheets && db.sheets.status.state === "error") warning = "Couldn't read your Google Sheet, so your leads and drafts are not shown right now. Nothing is lost. Open Settings > Google Sheets to reconnect."; } } catch { warning = "Couldn't read your Google Sheet, so your leads and drafts are not shown right now. Nothing is lost. Open Settings > Google Sheets to reconnect."; } }
      return { db, user: null, warning, ...snapshot() };
    },
  };
  link.subscribe(notify);
  syncOriginRules(config).catch(() => {});
  const saved = await store.get();
  if (saved) link.connect(saved).catch(() => {});
  link.start();
  return platform;
}
