// Detects where Cold is running: the Claude artifact runtime (window.claude) or a Cold server.
import { createApi } from "./api.js";
import { STORAGE_KEYS } from "../domain/constants.js";
import { createRemoteDb } from "./sqliteDb.js";
import { loadAll } from "../state/storage.js";

const safeGet = (area, key) => { try { return area.getItem(key) || ""; } catch { return ""; } };
const safeSet = (area, key, v) => { try { v ? area.setItem(key, v) : area.removeItem(key); } catch {} };

export function createPlatform() {
  const settings = { model: "", access: safeGet(globalThis.sessionStorage || {}, STORAGE_KEYS.access) };
  const api = createApi({ getAccess: () => settings.access, getModel: () => settings.model });
  return {
    api, settings,
    setAccess(v) { settings.access = v.trim(); safeSet(globalThis.sessionStorage, STORAGE_KEYS.access, settings.access); },
    setModel(v) { settings.model = v; try { localStorage.setItem(STORAGE_KEYS.gatewayModel, v); } catch {} },
    savedModel() { return safeGet(globalThis.localStorage || {}, STORAGE_KEYS.gatewayModel); },

    /** Re-reads the server's config after Settings changed it. */
    async refresh() {
      const server = await api.config();
      const sample = server && server.ready ? api.sample : null;
      return { server, sample, sampleState: sample ? "ready" : server ? "noconfig" : "none" };
    },

    /** Resolves { db, user, sample, server, sampleState }. */
    async detect() {
      const cl = globalThis.claude;
      if (cl && cl.use) {
        const [db, user, sample] = await Promise.all([cl.use("db").catch(() => null), cl.use("user").catch(() => null), cl.use("sample").catch(() => null)]);
        return { db, user, sample, server: null, sampleState: sample ? "ready" : "none" };
      }
      const server = await api.config();
      const sample = server && server.ready ? api.sample : null;
      let db = null, warning = "";
      if (server && server.dbEnabled) {
        // Desktop app: products and drafts live in SQLite. Anything already in this browser's storage is copied in once.
        try {
          db = createRemoteDb({ headers: () => (settings.access ? { "x-cold-access": settings.access } : {}), readLocal: () => { const d = loadAll(globalThis.localStorage); return { products: d.products, emails: d.emails, settings: d.settings, compose: d.compose }; } });
          await db.load();
        } catch (e) { db = null; warning = "Couldn't open the Cold database, so this window is using browser storage. Restart the app; if it keeps happening, check the app's data folder."; }
      }
      return { db, user: null, sample, server, warning, sampleState: sample ? "ready" : server ? "noconfig" : "none" };
    },
  };
}
