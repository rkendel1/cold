// Single in-memory state container with topic subscriptions, plus persistence through a backend.
// Backends: "local" (localStorage), "db" (the Claude-artifact runtime) or "sqlite" (the desktop app's database, through
// services/sqliteDb.js, which mimics the "db" interface). Views never touch storage directly.
import { normalizeFollowUpSettings } from "../domain/followup.js";
import { normalizeFirstRun } from "../domain/firstRun.js";
import { STORAGE_KEYS } from "../domain/constants.js";
import { loadAll, writeJson } from "./storage.js";
import { normalizeProduct } from "../domain/knowledge.js";
import { signoffBlock } from "../domain/signoff.js";
import { normalizeEmail, readJson, emailApp, emailAccount } from "./storage.js";
import { normalizeLead } from "../domain/leads.js";
import { saveIntent, deleteIntent, applySave, compareProducts, compareEmails, compareLeads } from "../domain/library.js";

export { uid } from "../domain/ids.js";

export function createStore({ storage = globalThis.localStorage, platform = null } = {}) {
  const listeners = new Set();
  const state = {
    ready: false,
    backend: "local",
    storage: "",             // "sheets" when leads and outreach are kept in a Google Sheet
    products: [], emails: [], leads: [], settings: { signature: "", signoffProduct: true, emailApp: "mailto", gmailAccount: "", followUp: normalizeFollowUpSettings(), firstRun: "" },
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
    paired: false,           // a pairing made before shared mode: the standalone library synced with the app
    library: "standalone",   // standalone | shared (the Cold Desktop library) | synced | desktop (this IS the desktop library)
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
    else if (which === "leads") writeJson(STORAGE_KEYS.leads, state.leads, storage);
    else if (which === "settings") writeJson(STORAGE_KEYS.settings, state.settings, storage);
  }
  /** The stored drafts exactly as saved (including entries this client can't read), plus a refresh of the in-memory copy. */
  const storedEmails = () => { const v = readJson(STORAGE_KEYS.emails, [], storage).value; return Array.isArray(v) ? v : []; };
  const adoptEmails = list => { state.emails = list.map(x => normalizeEmail(x)).filter(Boolean).sort(compareEmails); };

  /** A database can report rows it couldn't read (SQLite does); keep the notice in step as the database changes, so it clears once the cause is fixed. */
  const syncWarnings = () => { const w = db && db.warnings ? [...db.warnings] : null; if (w && JSON.stringify(w) !== JSON.stringify(state.warnings)) set({ warnings: w }, "notice"); };
  let unsubs = [];
  /** Point the store at a database: show what it holds now and follow its changes. */
  function attach(next) {
    db = next; state.backend = db.kind || "db"; state.storage = db.storage || "";
    if (db.initialCompose !== undefined) state.compose = db.initialCompose;   // stores that keep the form (SQLite, web replica)
    if (db.warnings) state.warnings = [...db.warnings];
    const fail = e => { if (e && e.code === "revoked") set({ notice: "Access to saved data ended. Reload to reconnect." }, "notice"); };
    unsubs = [
      db.collection("products").onSnapshot(snap => {
        const items = snap.docs.map(d => normalizeProduct({ ...d.data(), id: d.id })).filter(Boolean).sort(compareProducts);
        set({ products: items, ready: true }, "products"); syncWarnings();
      }, fail),
      db.collection("leads").onSnapshot(snap => {
        set({ leads: snap.docs.map(d => normalizeLead({ ...d.data(), id: d.id })).filter(Boolean).sort(compareLeads) }, "leads"); syncWarnings();
      }, fail),
      db.collection("emails").orderBy("createdAt", "desc").limit(500).onSnapshot(snap => {
        set({ emails: snap.docs.map(d => normalizeEmail({ ...d.data(), id: d.id })).filter(Boolean) }, "emails"); syncWarnings();
      }, fail),
      // The database notifies every listener on any change, so only announce settings when they really changed: Write rebuilds the open draft on this topic, which would wipe its on-screen messages (e.g. "Cold hasn't sent anything") after any unrelated save.
      db.doc("settings/me").onSnapshot(snap => {
        if (!snap.exists) return;
        const d = snap.data(), next = { ...state.settings, signature: String(d.signature || ""), signoffProduct: d.signoffProduct !== false, emailApp: emailApp(d.emailApp), gmailAccount: emailAccount(d.gmailAccount), followUp: normalizeFollowUpSettings(d.followUp), firstRun: normalizeFirstRun(d.firstRun) };
        if (JSON.stringify(next) !== JSON.stringify(state.settings)) set({ settings: next }, "settings");
      }, fail),
    ];
  }

  const api = {
    state, subscribe, set, emit,

    /**
     * Show a different library (a deliberate choice in Settings). The old one is only detached, never written to or deleted; the draft
     * open in Write belonged to it, so it is closed.
     */
    switchLibrary(next) {
      unsubs.forEach(off => { try { off(); } catch { /* ignore */ } });
      Object.assign(state, { products: [], emails: [], leads: [], current: null, undo: null, settings: { signature: "", signoffProduct: true, emailApp: "mailto", gmailAccount: "", followUp: normalizeFollowUpSettings(), firstRun: "" } });
      attach(next); emit("ready");
    },

    start(boot) {
      if (boot.db) {
        attach(boot.db);
      } else {
        const d = loadAll(storage);
        Object.assign(state, { products: d.products, emails: [...d.emails].sort(compareEmails), leads: [...d.leads].sort(compareLeads), settings: d.settings, compose: d.compose, warnings: d.warnings, ready: true });
      }
      emit("ready");
    },

    /** The database underneath (before any Google Sheet is layered on), for the Sheets setup. */
    database: () => db,

    /** Where saved data lives, in the words the UI uses. */
    where: () => (state.backend === "sqlite" ? "on this computer" : state.surface === "extension" ? "in this extension" : "in this browser"),
    whereFrom: () => (state.backend === "sqlite" ? "this computer" : state.surface === "extension" ? "this extension" : "this browser"),
    /** One sentence fragment, "Products and drafts ___", used by every surface so the wording can't drift. */
    keptNote: () => (state.storage === "sheets" ? `are kept in different places: leads and drafts in your Google Sheet (open it from Settings), products and settings ${state.backend === "sqlite" ? "in the Cold desktop app's database on this computer" : `${api.where()} only`}.`
      : state.backend === "sqlite" ? "are stored in the Cold desktop app's database on this computer and are not synced to other devices."
      : state.library === "shared" ? `are in your Cold Desktop library. ${state.surface === "extension" ? "This extension" : "This browser"} keeps a working copy, so you can keep working while the app is closed and changes sync when it is back.`
      : state.paired ? `are saved ${api.where()} and sync with the Cold desktop app whenever it is running.`
      : `are saved ${api.where()} only and are not backed up or synced to other devices${state.surface === "extension" ? " until you connect the Cold desktop app" : ""}.`),

    /** The sign-off for an email about this record's product: the user's name, plus the product's selected links and social. */
    signoffFor(rec) {
      const product = rec && (state.products.find(p => p.id === rec.productId) || state.products.find(p => p.name && p.name === rec.productName)) || null;
      return signoffBlock({ settings: state.settings, product });
    },

    productById: id => state.products.find(p => p.id === id),
    leadById: id => state.leads.find(l => l.id === id),

    /** Save one lead (add or edit). Leads are versioned by `updatedAt` like products: the newest save wins. */
    async saveLead(l) {
      const body = { ...l, updatedAt: Date.now() };
      if (db) { const { id, ...rest } = body; return queue("l/" + l.id, () => db.doc("leads/" + l.id).set(rest)); }
      const prev = state.leads, i = prev.findIndex(x => x.id === l.id);
      state.leads = (i >= 0 ? prev.map((x, j) => (j === i ? body : x)) : [...prev, body]).sort(compareLeads);
      try { persistLocal("leads"); } catch (e) { state.leads = prev; throw e; }
      emit("leads");
    },
    /** Save many leads at once (an import). One write however many there are. */
    async saveLeads(list) {
      const now = Date.now(), docs = list.map(l => ({ ...l, updatedAt: now }));
      if (!docs.length) return;
      if (db) return queue("leads", () => (db.setMany ? db.setMany("leads", docs) : Promise.all(docs.map(d => db.doc("leads/" + d.id).set({ ...d })))));
      const prev = state.leads, byId = new Map(prev.map(x => [x.id, x]));
      docs.forEach(d => byId.set(d.id, d));
      state.leads = [...byId.values()].sort(compareLeads);
      try { persistLocal("leads"); } catch (e) { state.leads = prev; throw e; }
      emit("leads");
    },
    async deleteLeads(ids) {
      if (!ids.length) return;
      if (db) return queue("leads", () => (db.deleteMany ? db.deleteMany("leads", ids) : Promise.all(ids.map(id => db.doc("leads/" + id).delete()))));
      const prev = state.leads, gone = new Set(ids); state.leads = prev.filter(l => !gone.has(l.id));
      try { persistLocal("leads"); } catch (e) { state.leads = prev; throw e; }
      emit("leads");
    },
    deleteLead(id) { return api.deleteLeads([id]); },

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
      const { expected, base } = saveIntent(e, seen);
      const body = JSON.parse(JSON.stringify(e)); body.updatedAt = Date.now();
      if (db) {
        const { id, ...rest } = body;
        return queue("e/" + e.id, async () => { const r = await db.doc("emails/" + e.id).set(rest, { expected, base }); e.updatedAt = r && Number.isFinite(r.updatedAt) ? r.updatedAt : body.updatedAt; });
      }
      // Local storage: change just this record in what is stored NOW (another tab may have saved since this one loaded).
      const list = storedEmails(), i = list.findIndex(x => x && x.id === e.id), stored = i >= 0 ? list[i] : null;
      const out = applySave({ id: e.id, mine: body, stored, expected, base });
      if (!out.ok) { adoptEmails(list); emit("emails"); throw out.error; }
      const rec = out.record;
      writeJson(STORAGE_KEYS.emails, i >= 0 ? list.map((x, j) => (j === i ? rec : x)) : [rec, ...list], storage);
      adoptEmails(i >= 0 ? list.map((x, j) => (j === i ? rec : x)) : [rec, ...list]);
      e.updatedAt = rec.updatedAt;
      emit("emails");
    },
    async deleteEmail(id) {
      if (db) { const seen = state.emails.find(x => x.id === id); return queue("e/" + id, () => db.doc("emails/" + id).delete({ expected: deleteIntent(seen) })); }
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
