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
  /** After an erase, nothing may be saved until the page is reloaded: a stale draft, form or timer in memory must not write erased data back. */
  let locked = false;
  const writable = () => { if (locked) throw { code: "erased", message: "Your data was erased on this device. Reload Cold to continue." }; };
  const blankSettings = () => ({ signature: "", signoffProduct: true, emailApp: "mailto", gmailAccount: "", followUp: normalizeFollowUpSettings(), firstRun: "" });
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
      writable();
      const body = { ...l, updatedAt: Date.now() };
      if (db) { const { id, ...rest } = body; return queue("l/" + l.id, () => db.doc("leads/" + l.id).set(rest)); }
      const prev = state.leads, i = prev.findIndex(x => x.id === l.id);
      state.leads = (i >= 0 ? prev.map((x, j) => (j === i ? body : x)) : [...prev, body]).sort(compareLeads);
      try { persistLocal("leads"); } catch (e) { state.leads = prev; throw e; }
      emit("leads");
    },
    /** Save many leads at once (an import). One write however many there are. */
    async saveLeads(list) {
      writable();
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
      writable();
      if (!ids.length) return;
      if (db) return queue("leads", () => (db.deleteMany ? db.deleteMany("leads", ids) : Promise.all(ids.map(id => db.doc("leads/" + id).delete()))));
      const prev = state.leads, gone = new Set(ids); state.leads = prev.filter(l => !gone.has(l.id));
      try { persistLocal("leads"); } catch (e) { state.leads = prev; throw e; }
      emit("leads");
    },
    deleteLead(id) { return api.deleteLeads([id]); },

    async saveProduct(p) {
      writable();
      const body = { ...p, updatedAt: Date.now() };
      if (db) { const { id, ...rest } = body; return queue("p/" + p.id, () => db.doc("products/" + p.id).set(rest)); }
      const prev = state.products;
      const i = prev.findIndex(x => x.id === p.id);
      state.products = i >= 0 ? prev.map((x, j) => (j === i ? body : x)) : [...prev, body];
      try { persistLocal("products"); } catch (e) { state.products = prev; throw e; }
      emit("products");
    },
    async deleteProduct(id) {
      writable();
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
      writable();
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
      writable();
      if (db) { const seen = state.emails.find(x => x.id === id); return queue("e/" + id, () => db.doc("emails/" + id).delete({ expected: deleteIntent(seen) })); }
      const list = storedEmails().filter(x => !(x && x.id === id));
      writeJson(STORAGE_KEYS.emails, list, storage);
      adoptEmails(list);
      emit("emails");
    },
    async saveSettings(s) {
      writable();
      const prev = state.settings; state.settings = { ...prev, ...s };
      if (db) return queue("settings", () => db.doc("settings/me").set(state.settings)).finally(() => emit("settings"));
      try { persistLocal("settings"); } catch (e) { state.settings = prev; throw e; }
      emit("settings");
    },
    /**
     * Save many records of one kind at once ("products" | "emails" | "leads"): one write however many (a restore). Records are saved as given, with the store's version
     * stamp; nothing is merged. Rejects (and changes nothing in memory) if the storage refuses.
     */
    async saveRecords(kind, list) {
      writable();
      if (kind === "leads") return api.saveLeads(list);
      const now = Date.now(), docs = list.map(r => ({ ...r, updatedAt: now }));
      if (!docs.length) return;
      if (db) return queue(`bulk/${kind}`, () => (db.setMany ? db.setMany(kind, docs) : Promise.all(docs.map(d => { const { id, ...rest } = d; return db.doc(`${kind}/${id}`).set(rest); }))));
      if (kind === "products") {
        const prev = state.products, byId = new Map(prev.map(x => [x.id, x])); docs.forEach(d => byId.set(d.id, d)); state.products = [...byId.values()];
        try { persistLocal("products"); } catch (e) { state.products = prev; throw e; }
        return emit("products");
      }
      const list0 = storedEmails(), byId = new Map(list0.filter(x => x && x.id).map(x => [x.id, x])); docs.forEach(d => byId.set(d.id, d));
      const next = [...byId.values()]; writeJson(STORAGE_KEYS.emails, next, storage); adoptEmails(next); emit("emails");
    },
    /** Delete many records of one kind at once. */
    async deleteRecords(kind, ids) {
      writable();
      if (!ids.length) return;
      if (kind === "leads") return api.deleteLeads(ids);
      if (db) return queue(`bulk/${kind}`, () => (db.deleteMany ? db.deleteMany(kind, ids) : Promise.all(ids.map(id => db.doc(`${kind}/${id}`).delete()))));
      const gone = new Set(ids);
      if (kind === "products") { const prev = state.products; state.products = prev.filter(p => !gone.has(p.id)); try { persistLocal("products"); } catch (e) { state.products = prev; throw e; } return emit("products"); }
      const next = storedEmails().filter(x => !(x && gone.has(x.id))); writeJson(STORAGE_KEYS.emails, next, storage); adoptEmails(next); emit("emails");
    },

    /**
     * Can this library be erased from here? Not when the library is a working copy of the desktop app's (an erase would sync as a delete THERE) or is kept in a Google
     * Sheet (Cold's local erase doesn't touch the user's spreadsheet). The reason is said in words, so the screen never offers a half-working erase.
     */
    canErase() {
      if (state.storage === "sheets") return { ok: false, reason: "sheets", message: "Your leads and drafts are kept in your Google Sheet, which Cold's erase doesn't touch. To remove them, stop using Google Sheets in Settings (this copies them back here), then erase; and delete the spreadsheet in Google Drive yourself." };
      if (state.library === "shared" || state.library === "synced" || state.paired) return { ok: false, reason: "paired", message: "This is connected to the Cold desktop app, so erasing here would be copied there as a delete. Erase in the desktop app, or disconnect it in Settings first." };
      return { ok: true };
    },
    /**
     * Erase this device's Cold library (records, saved settings, the Write form, anything waiting to sync). Waits for saves in flight, blocks all further saves, erases
     * through the storage this library uses, then CHECKS what is left. Resolves with what was removed; rejects with { code: "erase_failed" | "erase_incomplete" | "not_supported" }
     * if anything may remain: it never resolves as a success unless the storage reads back empty. Never called except from a confirmed user action.
     */
    async eraseLocalData() {
      const can = api.canErase(); if (!can.ok) throw { code: "not_supported", message: can.message };
      const removed = { products: state.products.length, emails: state.emails.length, leads: state.leads.length };
      await Promise.allSettled(Object.values(serial));
      clearTimeout(composeTimer); locked = true;
      let left;
      try {
        if (db && typeof db.erase === "function") {
          left = await db.erase();
          // The desktop page may still hold the browser copy from before the database existed; it is Cold's data too, so it goes with the rest.
          if (db.kind === "sqlite") for (const k of [STORAGE_KEYS.products, STORAGE_KEYS.emails, STORAGE_KEYS.leads, STORAGE_KEYS.settings, STORAGE_KEYS.compose, STORAGE_KEYS.sync]) { try { storage.removeItem(k); } catch { /* reported below if it remains */ } }
        }
        else {
          for (const k of [STORAGE_KEYS.products, STORAGE_KEYS.emails, STORAGE_KEYS.leads, STORAGE_KEYS.settings, STORAGE_KEYS.compose, STORAGE_KEYS.sync]) storage.removeItem(k);
          const d = loadAll(storage); left = { products: d.products.length, emails: d.emails.length, leads: d.leads.length };
          if ([STORAGE_KEYS.products, STORAGE_KEYS.emails, STORAGE_KEYS.leads, STORAGE_KEYS.settings].some(k => storage.getItem(k) != null)) left.emails = left.emails || 1;
        }
      } catch (e) { locked = false; throw { code: "erase_failed", message: "Cold couldn't erase your data. Some or all of it may still be here.", cause: e && e.message }; }
      const remaining = (left.products || 0) + (left.emails || 0) + (left.leads || 0);
      if (remaining > 0) { locked = false; throw { code: "erase_incomplete", remaining: left, message: `Erasing didn't finish: ${remaining} saved item${remaining === 1 ? " is" : "s are"} still here.` }; }
      Object.assign(state, { products: [], emails: [], leads: [], current: null, undo: null, compose: null, warnings: [], settings: blankSettings() });
      emit("ready");
      return removed;
    },

    /** Compose form values are a convenience; failing to save them must never interrupt the user. */
    saveCompose(form) {
      if (locked) return;
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
