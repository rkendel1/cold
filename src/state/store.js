// Single in-memory state container with topic subscriptions, plus persistence through a backend.
// Backends: "local" (localStorage) or "db" (the Claude-artifact runtime). Views never touch storage directly.
import { STORAGE_KEYS } from "../domain/constants.js";
import { loadAll, writeJson } from "./storage.js";
import { normalizeProduct } from "../domain/knowledge.js";
import { normalizeEmail } from "./storage.js";

export { uid } from "../domain/ids.js";

export function createStore({ storage = globalThis.localStorage, platform = null } = {}) {
  const listeners = new Set();
  const state = {
    ready: false,
    backend: "local",
    products: [], emails: [], settings: { signature: "" },
    compose: null,           // last compose form values (persisted)
    current: null,           // draft shown in Compose
    undo: null,              // { id, rec } snapshot taken before an Improve
    sample: null,            // generation function, or null when generation is unavailable
    busy: false, step: 0, error: null,   // error: { message, retryable }
    server: null,            // /api/config response, or null
    sampleState: "pending",  // pending | ready | noconfig | none | blocked
    warnings: [],
    notice: "",
  };
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const emit = topic => listeners.forEach(fn => fn(topic, state));
  const set = (patch, topic) => { Object.assign(state, patch); emit(topic); };

  let db = null;
  const serial = {};
  const queue = (key, fn) => (serial[key] = (serial[key] || Promise.resolve()).catch(() => {}).then(fn));

  function persistLocal() {
    writeJson(STORAGE_KEYS.products, state.products, storage);
    writeJson(STORAGE_KEYS.emails, state.emails, storage);
    writeJson(STORAGE_KEYS.settings, state.settings, storage);
  }

  const api = {
    state, subscribe, set, emit,

    start(boot) {
      if (boot.db) {
        db = boot.db; state.backend = "db";
        const fail = e => { if (e && e.code === "revoked") set({ notice: "Access to saved data ended. Reload to reconnect." }, "notice"); };
        db.collection("products").onSnapshot(snap => {
          const items = snap.docs.map(d => normalizeProduct({ ...d.data(), id: d.id })).filter(Boolean).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || String(a.name).localeCompare(b.name));
          set({ products: items, ready: true }, "products");
        }, fail);
        db.collection("emails").orderBy("createdAt", "desc").limit(500).onSnapshot(snap => {
          set({ emails: snap.docs.map(d => normalizeEmail({ ...d.data(), id: d.id })).filter(Boolean) }, "emails");
        }, fail);
        db.doc("settings/me").onSnapshot(snap => { if (snap.exists) set({ settings: { ...state.settings, signature: String(snap.data().signature || "") } }, "settings"); }, fail);
      } else {
        const d = loadAll(storage);
        Object.assign(state, { products: d.products, emails: d.emails, settings: d.settings, compose: d.compose, warnings: d.warnings, ready: true });
      }
      emit("ready");
    },

    productById: id => state.products.find(p => p.id === id),

    async saveProduct(p) {
      const body = { ...p, updatedAt: Date.now() };
      if (db) { const { id, ...rest } = body; return queue("p/" + p.id, () => db.doc("products/" + p.id).set(rest)); }
      const prev = state.products;
      const i = prev.findIndex(x => x.id === p.id);
      state.products = i >= 0 ? prev.map((x, j) => (j === i ? body : x)) : [...prev, body];
      try { persistLocal(); } catch (e) { state.products = prev; throw e; }
      emit("products");
    },
    async deleteProduct(id) {
      if (db) return queue("p/" + id, () => db.doc("products/" + id).delete());
      const prev = state.products; state.products = prev.filter(p => p.id !== id);
      try { persistLocal(); } catch (e) { state.products = prev; throw e; }
      emit("products");
    },
    async saveEmail(e) {
      const body = JSON.parse(JSON.stringify(e)); body.updatedAt = Date.now();
      if (db) { const { id, ...rest } = body; return queue("e/" + e.id, () => db.doc("emails/" + e.id).set(rest)); }
      const prev = state.emails;
      const i = prev.findIndex(x => x.id === e.id);
      state.emails = i >= 0 ? prev.map((x, j) => (j === i ? body : x)) : [body, ...prev];
      try { persistLocal(); } catch (err) { state.emails = prev; throw err; }
      emit("emails");
    },
    async deleteEmail(id) {
      if (db) return queue("e/" + id, () => db.doc("emails/" + id).delete());
      const prev = state.emails; state.emails = prev.filter(e => e.id !== id);
      try { persistLocal(); } catch (e) { state.emails = prev; throw e; }
      emit("emails");
    },
    async saveSettings(s) {
      const prev = state.settings; state.settings = { ...prev, ...s };
      if (db) return queue("settings", () => db.doc("settings/me").set(state.settings)).finally(() => emit("settings"));
      try { persistLocal(); } catch (e) { state.settings = prev; throw e; }
      emit("settings");
    },
    /** Compose form values are a convenience; failing to save them must never interrupt the user. */
    saveCompose(form) {
      state.compose = form;
      try { writeJson(STORAGE_KEYS.compose, form, storage); } catch {}
    },
  };
  return api;
}
