// Where a replica keeps its copy. Two adapters, same shape: { get(): Promise<data|null>, set(data): Promise<void> }.
import { STORAGE_KEYS } from "../domain/constants.js";
import { loadAll, readJson, writeJson, normalizeEmail } from "../state/storage.js";
import { normalizeProduct } from "../domain/knowledge.js";
import { normalizeLead } from "../domain/leads.js";
import { compareEmails, compareProducts, compareLeads } from "../domain/library.js";

/** Extension: chrome.storage.local, one key. */
export const chromeReplicaStorage = (key = "cold.replica") => ({
  get: async () => (await chrome.storage.local.get(key))[key] || null,
  set: data => chrome.storage.local.set({ [key]: data }),
  /** Remove this library's one key (nothing else in the extension's storage: not the pairing, not the model settings). */
  clear: () => chrome.storage.local.remove(key),
});

/**
 * Web: the SAME localStorage keys the web app has always used (cold.products, cold.emails, cold.settings, cold.compose), so existing
 * data is picked up as it is and nothing moves. Only what is waiting to sync is kept in one extra key. Older or damaged entries are
 * handled by the same tolerant readers as before (and reported, never deleted).
 */
export function localReplicaStorage(storage = globalThis.localStorage, keys = STORAGE_KEYS) {
  const byId = list => Object.fromEntries(list.map(x => [x.id, x]));
  return {
    /** Remove every key this library owns, including entries Cold couldn't read (a save keeps those; an erase must not). Nothing else in this browser's storage is touched. */
    async clear() { for (const k of [keys.products, keys.emails, keys.leads, keys.settings, keys.compose, keys.sync]) if (k) storage.removeItem(k); },
    async get() {
      const d = loadAll(storage, keys);
      const sync = readJson(keys.sync, {}, storage).value || {};
      const rawSettings = readJson(keys.settings, null, storage).value;
      return { products: byId(d.products), emails: byId(d.emails), leads: byId(d.leads), settings: rawSettings && Object.keys(rawSettings).length ? d.settings : null,
        outbox: Array.isArray(sync.outbox) ? sync.outbox : [], conflicts: Array.isArray(sync.conflicts) ? sync.conflicts : [], lastSync: sync.lastSync || 0, appVersion: sync.appVersion, warnings: d.warnings, compose: d.compose };
    },
    async set(data) {
      // Same order the web app always wrote: products by their order, newest draft first.
      const products = Object.values(data.products).sort(compareProducts);
      const emails = Object.values(data.emails).sort(compareEmails);
      const leads = Object.values(data.leads || {}).sort(compareLeads);
      // Entries this client can't read were skipped on load ("not deleted"): keep them in storage rather than dropping them on save.
      const unread = (key, normalize) => { const v = readJson(key, [], storage).value; return Array.isArray(v) ? v.filter(x => !normalize(x)) : []; };
      writeJson(keys.products, [...products, ...unread(keys.products, normalizeProduct)], storage);
      writeJson(keys.emails, [...emails, ...unread(keys.emails, normalizeEmail)], storage);
      if (keys.leads) writeJson(keys.leads, [...leads, ...unread(keys.leads, normalizeLead)], storage);
      if (data.settings) writeJson(keys.settings, data.settings, storage);
      if (data.compose) writeJson(keys.compose, data.compose, storage);
      writeJson(keys.sync, { outbox: data.outbox, conflicts: data.conflicts, lastSync: data.lastSync, appVersion: data.appVersion }, storage);
    },
  };
}
