// The Google Sheets connector, the same on every surface. It owns the choice (which spreadsheet, if any), sets one up, copies data into it,
// and gives each surface a database whose leads and outreach live in that sheet. A surface supplies how it signs in (googleAuth.js) and
// where the choice is remembered; everything else is shared.
import { createSheetsApi } from "./sheetsApi.js";
import { createSheetsDb, splitDb } from "./sheetsDb.js";
import { TABS, headersFor } from "../domain/sheetsMap.js";

export const DEFAULT_TITLE = "Cold: leads and outreach";
const LINK_KEY = "cold.sheets";

/** The spreadsheet id from a link (docs.google.com/spreadsheets/d/<id>/edit…) or the id itself; "" if it is neither. */
export function parseSpreadsheetId(input) {
  const s = String(input || "").trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : "";
}

/** Where the choice is kept: this browser's localStorage (web, desktop window) or the extension's storage. */
export const webLinkStore = (storage = globalThis.localStorage) => ({
  async get() { try { const v = JSON.parse(storage.getItem(LINK_KEY) || "null"); return v && typeof v.spreadsheetId === "string" ? v : null; } catch { return null; } },
  async set(link) { storage.setItem(LINK_KEY, JSON.stringify(link)); },
  async clear() { try { storage.removeItem(LINK_KEY); } catch { /* nothing to clear */ } },
});
export const chromeLinkStore = (area = globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local) => ({
  async get() { try { const v = (await area.get(LINK_KEY))[LINK_KEY]; return v && typeof v.spreadsheetId === "string" ? v : null; } catch { return null; } },
  set: link => area.set({ [LINK_KEY]: link }),
  clear: () => area.remove(LINK_KEY),
});

export function createSheetsConnector({ auth, linkStore, sheetsBase, fetchImpl, pollMs } = {}) {
  const api = createSheetsApi({ token: refresh => auth.token(refresh), base: sheetsBase || undefined, fetchImpl });
  let link = null, db = null;
  const subs = new Set(), notify = () => subs.forEach(fn => fn());
  const tabs = () => Object.entries(TABS).map(([name, title]) => ({ title, headers: headersFor(name) }));

  return {
    api, auth,
    /** Is this build set up to sign in to Google at all? */
    get available() { return !!(auth && auth.configured); },
    get link() { return link; },
    get connected() { return !!(auth && auth.connected()); },
    get db() { return db; },
    /** The live status of the sheet connection (ok / error / connecting), once a database is attached. */
    get status() { return db && db.sheets ? db.sheets.status : { state: link ? "connecting" : "off", message: "" }; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** Read what was chosen last time (and the saved sign-in state). Call once at start. */
    async init() { if (auth && auth.refreshState) await auth.refreshState(); link = await linkStore.get(); return link; },

    /** Sign in. On the web and in the extension this must run from a click. */
    async connect(opts) { await auth.connect(opts); notify(); },
    async disconnect() { await auth.disconnect(); notify(); },

    /** A brand-new spreadsheet in the person's Drive, with the two tabs Cold uses. */
    async createSheet(title = DEFAULT_TITLE) {
      const made = await api.create(title, tabs());
      link = { spreadsheetId: made.spreadsheetId, url: made.url, title };
      return link;
    },
    /** A spreadsheet Cold already made (by link or id), checked before it is chosen. Tabs that are missing are added when it is opened. */
    async useSheet(input) {
      const id = parseSpreadsheetId(input);
      if (!id) throw { code: "bad_link", message: "That doesn't look like a Google Sheets link. Paste the address from your browser while the sheet is open." };
      const m = await api.meta(id);
      link = { spreadsheetId: id, url: m.url, title: m.title };
      return link;
    },
    /** Open the chosen sheet as a database. With `strict` a failure throws (setup); otherwise it is kept and shown as a problem to fix (start-up). */
    async open(primary, { strict = false, poll = true } = {}) {
      if (!link) throw { code: "no_sheet", message: "No spreadsheet is chosen." };
      const sheets = createSheetsDb({ api, spreadsheetId: link.spreadsheetId, poll, pollMs });
      try { await sheets.load(); } catch (e) { if (strict) throw e; }
      if (poll) sheets.start();
      db = splitDb(primary, sheets);
      sheets.onStatus(notify);
      return db;
    },
    /** Copy leads and drafts into the sheet. A record that is already there (same id) is left as it is. Returns what was copied. */
    async copyInto(sheets, { leads = [], emails = [] } = {}) {
      const have = sheets.snapshot(), hasL = new Set(have.leads.map(l => l.id)), hasE = new Set(have.emails.map(e => e.id));
      const newL = leads.filter(l => !hasL.has(l.id)), newE = emails.filter(e => !hasE.has(e.id));
      if (newL.length) await sheets.setMany("leads", newL);
      if (newE.length) await sheets.setMany("emails", newE);
      return { leads: newL.length, emails: newE.length, skipped: leads.length - newL.length + emails.length - newE.length };
    },
    /** Stop using the sheet on this surface (the spreadsheet itself is left exactly as it is). */
    async unlink() { link = null; if (db && db.sheets) db.sheets.stop(); db = null; await linkStore.clear(); notify(); },
    async save() { await linkStore.set(link); },
  };
}
