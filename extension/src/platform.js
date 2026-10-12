// The extension's "platform": the same interface the web app's platform has (api, settings, snapshot, refresh, hub, backend...),
// so the shared Write, Knowledge, History and Settings screens run unchanged. Differences are the data underneath: a replica kept
// in extension storage, the extension's own model connection, and the page actions only an extension can offer.
import lookups from "../../lib/profile.js";
import { createReplica } from "../../src/services/replica.js";
import { chromeReplicaStorage } from "../../src/services/replicaStorage.js";
import { createLink } from "../../src/services/hubLink.js";
import { createLibraries } from "../../src/services/libraries.js";
import { sharedKeys } from "../../src/domain/constants.js";
import { createBackend } from "../../src/services/backend.js";
import { chromeHubStore, verifyHub } from "../../src/services/hub.js";
import { loadModelConfig, saveModelConfig, resolveOwn, directSample, syncOriginRules } from "./model.js";
import { createSettingsApi } from "./settingsApi.js";
import { insertIntoBox } from "./page.js";

export async function createExtensionPlatform() {
  let config = await loadModelConfig();
  const link = createLink();
  const store = chromeHubStore();
  // Standalone: the extension's own library. Shared: a working copy of the Cold Desktop library (see src/services/libraries.js).
  const libs = createLibraries({ hubStore: store, link, makeReplica: (kind, origin) => (kind === "shared"
    ? createReplica({ storage: chromeReplicaStorage(`cold.shared@${origin}`), keepCompose: true, pushLocalFirst: false })
    : createReplica({ storage: chromeReplicaStorage(), keepCompose: true })) });
  const active = await libs.init();
  const subs = new Set();
  const notify = () => subs.forEach(fn => fn());
  const ownCfg = () => resolveOwn(config);
  const ownSample = directSample(ownCfg);
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
      provider: app ? c.provider : o && o.id, providerLabel: app ? "Cold desktop app" : o && o.label, model: app ? c.model : o && o.model, keySetting: "a model in Settings" };
  }
  const snapshot = () => { const sample = backend.describe() ? backend.sample : null; return { server: server(), sample, sampleState: sample ? "ready" : "noconfig" }; };

  const platform = {
    api: { profile: backend.profile, tweet: backend.tweet, models: async () => [] },
    settings: { model: "", access: "" }, setAccess() {}, setModel() {}, savedModel: () => "",
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    snapshot, backend,
    /** The extension's OWN model connection (never the paired app's or a fallback): { cfg, sample }. cfg is null until a provider is saved. */
    ownModel: () => ({ cfg: ownCfg(), sample: ownSample }),
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
    async detect() { return { db: active.db, user: null, warning: "", ...snapshot() }; },
  };
  link.subscribe(notify);
  syncOriginRules(config).catch(() => {});
  const saved = await store.get();
  if (saved) link.connect(saved).catch(() => {});
  link.start();
  return platform;
}
