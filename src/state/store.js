// Single in-memory state container with topic subscriptions, plus persistence through a backend.
// Backends: "local" (localStorage), "db" (the Claude-artifact runtime) or "sqlite" (the desktop app's database, through
// services/sqliteDb.js, which mimics the "db" interface). Views never touch storage directly.
import { STORAGE_KEYS } from "../domain/constants.js";
import { loadAll, writeJson } from "./storage.js";
import { normalizeProduct } from "../domain/knowledge.js";
import { normalizeEmail, readJson } from "./storage.js";
import { versionOf, nextVersion, reconcileSave } from "../domain/outreach.js";

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
    surface: "web",          // web | desktop | extension: only used for wording about where data lives
    paired: false,           // is the Cold desktop app paired (web and extension)
  };
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const emit = topic => listeners.forEach(fn => fn(topic, state));
  const set = (patch, topic) => { Object.assign(state, patch); emit(topic); };

  let db = null, composeTimer = null;
  const serial = {};
  const queue = (key, fn) => (serial[key] = (serial[key] || Promise.resolve()).catch(() => {}).then(fn));

  // Each save writes only the key it changes. Emails are never written from this tab's in-memory list (see saveEmail), so a
  // product or settings save can't put back a stale copy of the drafts.
  function persistLocal(which) {
    if (which === "products") writeJson(STORAGE_KEYS.products, state.products, storage);
    else if (which === "settings") writeJson(STORAGE_KEYS.settings, state.settings, storage);
  }
  /** The stored drafts exactly as saved (including entries this client can't read), plus a refresh of the in-memory copy. */
  const storedEmails = () => { const v = readJson(STORAGE_KEYS.emails, [], storage).value; return Array.isArray(v) ? v : []; };
  const adoptEmails = list => { state.emails = list.map(x => normalizeEmail(x)).filter(Boolean); };

  const api = {
    state, subscribe, set, emit,

    start(boot) {
      if (boot.db) {
        db = boot.db; state.backend = db.kind || "db";
        if (db.initialCompose !== undefined) state.compose = db.initialCompose;   // stores that keep the form (SQLite, web replica)
        if (db.warnings && db.warnings.length) state.warnings = db.warnings;
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

    /** Where saved data lives, in the words the UI uses. */
    where: () => (state.backend === "sqlite" ? "on this computer" : state.surface === "extension" ? "in this extension" : "in this browser"),
    whereFrom: () => (state.backend === "sqlite" ? "this computer" : state.surface === "extension" ? "this extension" : "this browser"),
    /** One sentence fragment, "Products and drafts ___", used by every surface so the wording can't drift. */
    keptNote: () => (state.backend === "sqlite" ? "are stored in the Cold desktop app's database on this computer and are not synced to other devices."
      : state.paired ? `are saved ${api.where()} and sync with the Cold desktop app whenever it is running.`
      : `are saved ${api.where()} only and are not backed up or synced to other devices${state.surface === "extension" ? " until you connect the Cold desktop app" : ""}.`),

    productById: id => state.products.find(p => p.id === id),

    async saveProduct(p) {
      const body = { ...p, updatedAt: Date.now() };
      if (db) { const { id, ...rest } = body; return queue("p/" + p.id, () => db.doc("products/" + p.id).set(rest)); }
      const prev = state.products;
      const i = prev.findIndex(x => x.id === p.id);
      state.products = i >= 0 ? prev.map((x, j) => (j === i ? body : x)) : [...prev, body];
      try { persistLocal("products"); } catch (e) { state.products = prev; throw e; }
      emit("products");
    },
    async deleteProduct(id) {
      if (db) return queue("p/" + id, () => db.doc("products/" + id).delete());
      const prev = state.products; state.products = prev.filter(p => p.id !== id);
      try { persistLocal("products"); } catch (e) { state.products = prev; throw e; }
      emit("products");
    },
    /**
     * Save one draft. The version it was based on (`e.updatedAt`, or what this client last saw) travels with the save, so a save
     * based on an old copy can't overwrite a newer one: changes to different fields are merged, a change to the SAME field is
     * refused with a `conflict` error ({ conflicts, mine, current }) and the stored record is left as it is. On success `e.updatedAt`
     * is set to the saved version.
     */
    async saveEmail(e) {
      const seen = state.emails.find(x => x.id === e.id);
      const expected = Number.isFinite(e.updatedAt) ? e.updatedAt : seen ? versionOf(seen) : null;
      const base = seen && versionOf(seen) === expected ? seen : null;
      const body = JSON.parse(JSON.stringify(e)); body.updatedAt = Date.now();
      if (db) {
        const { id, ...rest } = body;
        return queue("e/" + e.id, async () => { const r = await db.doc("emails/" + e.id).set(rest, { expected, base }); e.updatedAt = r && Number.isFinite(r.updatedAt) ? r.updatedAt : body.updatedAt; });
      }
      // Local storage: change just this record in what is stored NOW (another tab may have saved since this one loaded).
      const list = storedEmails(), i = list.findIndex(x => x && x.id === e.id), stored = i >= 0 ? list[i] : null;
      const out = reconcileSave({ base, mine: body, stored, expected });
      if (!out.ok) { adoptEmails(list); emit("emails"); throw out.error; }
      const rec = { ...out.record, updatedAt: nextVersion(stored) };
      writeJson(STORAGE_KEYS.emails, i >= 0 ? list.map((x, j) => (j === i ? rec : x)) : [rec, ...list], storage);
      adoptEmails(i >= 0 ? list.map((x, j) => (j === i ? rec : x)) : [rec, ...list]);
      e.updatedAt = rec.updatedAt;
      emit("emails");
    },
    async deleteEmail(id) {
      if (db) { const seen = state.emails.find(x => x.id === id); return queue("e/" + id, () => db.doc("emails/" + id).delete({ expected: seen ? versionOf(seen) : undefined })); }
      const list = storedEmails().filter(x => !(x && x.id === id));
      writeJson(STORAGE_KEYS.emails, list, storage);
      adoptEmails(list);
      emit("emails");
    },
    async saveSettings(s) {
      const prev = state.settings; state.settings = { ...prev, ...s };
      if (db) return queue("settings", () => db.doc("settings/me").set(state.settings)).finally(() => emit("settings"));
      try { persistLocal("settings"); } catch (e) { state.settings = prev; throw e; }
      emit("settings");
    },
    /** Compose form values are a convenience; failing to save them must never interrupt the user. */
    saveCompose(form) {
      state.compose = form;
      if (db && (db.kind === "sqlite" || db.saveCompose)) {
        clearTimeout(composeTimer);
        composeTimer = setTimeout(() => { (db.saveCompose ? Promise.resolve(db.saveCompose(form)) : db.doc("compose/me").set(form)).catch(() => {}); }, 600);
        return;
      }
      try { writeJson(STORAGE_KEYS.compose, form, storage); } catch {}
    },
  };
  return api;
}
