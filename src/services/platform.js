// Detects where Cold is running: the Claude artifact runtime (window.claude) or a Cold server.
import { createApi } from "./api.js";
import { STORAGE_KEYS } from "../domain/constants.js";

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

    /** Resolves { db, user, sample, server, sampleState }. */
    async detect() {
      const cl = globalThis.claude;
      if (cl && cl.use) {
        const [db, user, sample] = await Promise.all([cl.use("db").catch(() => null), cl.use("user").catch(() => null), cl.use("sample").catch(() => null)]);
        return { db, user, sample, server: null, sampleState: sample ? "ready" : "none" };
      }
      const server = await api.config();
      const sample = server && server.ready ? api.sample : null;
      return { db: null, user: null, sample, server, sampleState: sample ? "ready" : server ? "noconfig" : "none" };
    },
  };
}
