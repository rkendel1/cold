// Detects where Cold is running: the Claude artifact runtime (window.claude) or a Cold server.
import { createApi } from "./api.js";
import { STORAGE_KEYS, sharedKeys } from "../domain/constants.js";
import { createRemoteDb } from "./sqliteDb.js";
import { loadAll } from "../state/storage.js";
import { createReplica } from "./replica.js";
import { localReplicaStorage } from "./replicaStorage.js";
import { createLink } from "./hubLink.js";
import { createLibraries } from "./libraries.js";
import { createBackend } from "./backend.js";
import { localHubStore, verifyHub } from "./hub.js";
import { browserAuth, serverAuth } from "./googleAuth.js";
import { createSheetsConnector, webLinkStore } from "./sheetsConnector.js";

const safeGet = (area, key) => { try { return area.getItem(key) || ""; } catch { return ""; } };
const safeSet = (area, key, v) => { try { v ? area.setItem(key, v) : area.removeItem(key); } catch {} };

const PREFER_KEY = "cold.prefer";

export function createPlatform() {
  const settings = { model: "", access: safeGet(globalThis.sessionStorage || {}, STORAGE_KEYS.access) };
  const api = createApi({ getAccess: () => settings.access, getModel: () => settings.model });
  let server = null, backend = null, hub = null, sheets = null;
  const subs = new Set();
  const notify = () => subs.forEach(fn => fn());
  /** What the rest of the app needs to know right now: the server's config, whether anything can generate, and the sync state. */
  function snapshot() {
    const sample = backend ? (backend.describe() ? backend.sample : null) : (server && server.ready ? api.sample : null);
    return { server, sample, sampleState: sample ? "ready" : server ? "noconfig" : "none" };
  }
  return {
    api, settings,
    /** Fires when generation becomes available/unavailable or the desktop app connects/disconnects. */
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    snapshot,
    get hub() { return hub; },
    /** The Google Sheets connector, or null when this build has no Google sign-in set up. */
    get sheets() { return sheets; },
    get backend() { return backend; },
    /** Email lookup (treg): where a lookup would run, and (only on a server that keeps secrets) where its token is saved. The token is never readable from here. */
    get people() { return backend ? { available: backend.peopleAvailable, findEmail: backend.findEmail, verifyEmail: backend.verifyEmail } : { available: () => !!(server && server.peopleSearch), findEmail: api.findEmail, verifyEmail: api.verifyEmail }; },
    get tregSettings() { return server && server.settingsEnabled ? { status: async () => ((await api.getSettings()).integrations || {}).treg || {}, save: apiKey => api.saveSettings({ integrations: { treg: { apiKey } } }).then(s => (s.integrations || {}).treg || {}) } : null; },
    /** Settings for the model section: only a server that owns provider settings (desktop / local) offers editing. */
    get settingsApi() { return server && server.settingsEnabled ? { getSettings: api.getSettings, saveSettings: api.saveSettings, providerModels: api.providerModels, keyNote: null } : null; },
    setAccess(v) { settings.access = v.trim(); safeSet(globalThis.sessionStorage, STORAGE_KEYS.access, settings.access); },
    setModel(v) { settings.model = v; try { localStorage.setItem(STORAGE_KEYS.gatewayModel, v); } catch {} },
    savedModel() { return safeGet(globalThis.localStorage || {}, STORAGE_KEYS.gatewayModel); },

    /** Re-reads the server's config after Settings changed it. */
    async refresh() {
      server = await api.config();
      notify();
      return snapshot();
    },

    /** Resolves { db, user, sample, server, sampleState }. */
    async detect() {
      const cl = globalThis.claude;
      if (cl && cl.use) {
        const [db, user, sample] = await Promise.all([cl.use("db").catch(() => null), cl.use("user").catch(() => null), cl.use("sample").catch(() => null)]);
        return { db, user, sample, server: null, sampleState: sample ? "ready" : "none" };
      }
      server = await api.config();
      let db = null, warning = "";
      if (server && server.dbEnabled) {
        // Desktop app: products and drafts live in SQLite. Anything already in this browser's storage is copied in once.
        try {
          db = createRemoteDb({ headers: () => (settings.access ? { "x-cold-access": settings.access } : {}), readLocal: () => { const d = loadAll(globalThis.localStorage); return { products: d.products, emails: d.emails, settings: d.settings, compose: d.compose }; } });
          await db.load();
        } catch (e) { db = null; warning = "Couldn't open the Cold database, so this window is using browser storage. Restart the app; if it keeps happening, check the app's data folder."; }
      }
      if (!db && server && !server.dbEnabled) {
        // Web: a full local copy that needs nothing else running. If the Cold desktop app is paired and reachable, the copy syncs with
        // it (changes made here while it was closed are sent when it returns), and its model can be used when this server has none.
        const link = createLink();
        const store = localHubStore();
        // Which library is shown is kept with the pairing: standalone (this browser's own) or the Cold Desktop library (see libraries.js).
        const libs = createLibraries({ hubStore: store, link, makeReplica: (kind, origin) => (kind === "shared"
          ? createReplica({ storage: localReplicaStorage(globalThis.localStorage, sharedKeys(origin)), pushLocalFirst: false })
          : createReplica({ storage: localReplicaStorage() })) });
        const active = await libs.init();
        let prefer = safeGet(globalThis.localStorage || {}, PREFER_KEY) || "app";
        backend = createBackend({ link, getConfig: () => ({ prefer }),
          own: { ready: () => !!(server && server.ready), sample: api.sample, label: () => `${server.providerLabel || server.provider} · ${server.model}`, lookups: { tweet: api.tweet, profile: api.profile }, people: { available: () => !!(server && server.peopleSearch), findEmail: api.findEmail, verifyEmail: api.verifyEmail } } });
        hub = {
          link, libs, store, kind: "web", get replica() { return libs.db; }, origin: globalThis.location ? globalThis.location.origin : "",
          get prefer() { return prefer; },
          setPrefer(v) { prefer = v === "own" ? "own" : "app"; safeSet(globalThis.localStorage, PREFER_KEY, prefer); notify(); },
          async connect(addr, code) { const conn = await verifyHub(addr, code, { who: "web" }); await libs.connect(conn); await link.connect(conn); notify(); },
          async disconnect() { link.disconnect(); await libs.disconnect(); notify(); },
        };
        link.subscribe(notify);
        const saved = await store.get();
        if (saved) link.connect(saved).catch(() => {});    // don't hold the page up if the app is closed
        link.start();
        db = active.db;
      }
      // Optional: leads and outreach kept in the person's own Google Sheet instead of in this app's storage (see sheetsConnector.js).
      const g = server && server.google;
      if (g && g.configured) {
        const auth = g.mode === "server" ? serverAuth({ call: api.googleCall }) : browserAuth({ clientId: g.clientId });
        sheets = createSheetsConnector({ auth, linkStore: webLinkStore(), sheetsBase: g.sheetsBase });
        try { await sheets.init(); if (sheets.link && db) db = await sheets.open(db); } catch { warning = warning || "Couldn't open your Google Sheet. Open Settings to reconnect."; }
      }
      return { db, user: null, ...snapshot(), warning };
    },
  };
}
