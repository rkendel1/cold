// Where a replica keeps its copy. Two adapters, same shape: { get(): Promise<data|null>, set(data): Promise<void> }.
import { STORAGE_KEYS } from "../domain/constants.js";
import { loadAll, readJson, writeJson } from "../state/storage.js";

/** Extension: chrome.storage.local, one key. */
export const chromeReplicaStorage = (key = "cold.replica") => ({
  get: async () => (await chrome.storage.local.get(key))[key] || null,
  set: data => chrome.storage.local.set({ [key]: data }),
});

/**
 * Web: the SAME localStorage keys the web app has always used (cold.products, cold.emails, cold.settings, cold.compose), so existing
 * data is picked up as it is and nothing moves. Only what is waiting to sync is kept in one extra key. Older or damaged entries are
 * handled by the same tolerant readers as before (and reported, never deleted).
 */
export function localReplicaStorage(storage = globalThis.localStorage) {
  const byId = list => Object.fromEntries(list.map(x => [x.id, x]));
  return {
    async get() {
      const d = loadAll(storage);
      const sync = readJson(STORAGE_KEYS.sync, {}, storage).value || {};
      const rawSettings = readJson(STORAGE_KEYS.settings, null, storage).value;
      return { products: byId(d.products), emails: byId(d.emails), settings: rawSettings && Object.keys(rawSettings).length ? d.settings : null,
        outbox: Array.isArray(sync.outbox) ? sync.outbox : [], lastSync: sync.lastSync || 0, appVersion: sync.appVersion, warnings: d.warnings, compose: d.compose };
    },
    async set(data) {
      // Same order the web app always wrote: products by their order, newest draft first.
      const products = Object.values(data.products).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || String(a.name).localeCompare(String(b.name)));
      const emails = Object.values(data.emails).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      writeJson(STORAGE_KEYS.products, products, storage);
      writeJson(STORAGE_KEYS.emails, emails, storage);
      if (data.settings) writeJson(STORAGE_KEYS.settings, data.settings, storage);
      if (data.compose) writeJson(STORAGE_KEYS.compose, data.compose, storage);
      writeJson(STORAGE_KEYS.sync, { outbox: data.outbox, lastSync: data.lastSync, appVersion: data.appVersion }, storage);
    },
  };
}
