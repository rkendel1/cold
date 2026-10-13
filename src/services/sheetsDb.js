// Leads and outreach kept in a Google Sheet, behind the same small interface the store already uses for the desktop database
// (collection / doc / setMany / deleteMany / onSnapshot), so no screen changes. Products, settings and the Write form stay wherever they
// were: `splitDb` sends only leads and outreach to the sheet.
//
// The sheet is the source of truth. Every save re-reads the tab first (so a row someone inserted or moved in the sheet is never overwritten
// by mistake), a save based on an older version is merged or refused like it is everywhere else, and the sheet is re-read every few seconds
// so changes made in Google Sheets show up in Cold.
import { saveWithMerge } from "../domain/library.js";
import { queryCollection } from "./collection.js";
import { TABS, headersFor, parseTable, columnIndex, readRow, makeRow, missingExtras, versionOf } from "../domain/sheetsMap.js";

const NAMES = ["leads", "emails"];
const POLL_MS = 20000;   // Sheets allows 60 reads a minute per person; two tabs every 20 s is a small fraction
const norm = s => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
/** 1 -> A, 27 -> AA */
export const colLetter = n => { let s = ""; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };

export function createSheetsDb({ api, spreadsheetId, poll = true, pollMs = POLL_MS, now = () => Date.now() } = {}) {
  const cache = { leads: new Map(), emails: new Map() };
  const rowOf = { leads: new Map(), emails: new Map() }, header = { leads: headersFor("leads"), emails: headersFor("emails") };
  const listeners = { leads: new Set(), emails: new Set() };
  const statusSubs = new Set();
  let sheetIds = {}, timer = null, signature = "", status = { state: "connecting", message: "" }, queue = Promise.resolve();

  const setStatus = (state, extra = {}) => { status = { state, message: "", code: "", ...extra, at: now() }; statusSubs.forEach(fn => fn(status)); };
  const fail = e => { setStatus("error", { code: e && e.code || "storage_unavailable", message: (e && e.message) || "Couldn't reach Google Sheets." }); return e; };
  const notify = which => { for (const n of which ? [which] : NAMES) for (const fn of listeners[n]) fn(); };

  /** Take a tab's rows as they are now. Rows without an id (typed in the sheet) get one; the caller writes those ids back. */
  function adopt(name, values) {
    const t = parseTable(values), seen = new Set(), records = new Map(), rows = new Map(), idFixes = [];
    // A missing or damaged heading row is rebuilt from the fixed columns (the tab's rows are kept as they are).
    const hdr = t.header.some(h => h.trim()) ? t.header : headersFor(name);
    const idCol = columnIndex(hdr).id;
    for (const { row, cells } of t.rows) {
      let rec = readRow(name, cells, hdr, { now: now() });
      if (!rec) continue;
      const had = idCol !== undefined && (cells[idCol] || "").trim();
      if (!had || seen.has(rec.id)) { if (had) rec = { ...rec, id: rec.id + "_" + Math.random().toString(36).slice(2, 6) }; idFixes.push({ row, id: rec.id }); }
      seen.add(rec.id); records.set(rec.id, rec); rows.set(rec.id, row);
    }
    header[name] = hdr; cache[name] = records; rowOf[name] = rows;
    return idFixes;
  }
  async function writeIds(name, fixes) {
    if (!fixes.length) return;
    let i = columnIndex(header[name]).id;
    if (i === undefined) { header[name] = ["id", ...header[name]]; await api.write(spreadsheetId, [{ tab: TABS[name], a1: "A1", values: [header[name]] }]); i = 0; }   // never reached for a sheet Cold made
    await api.write(spreadsheetId, fixes.map(f => ({ tab: TABS[name], a1: `${colLetter(i + 1)}${f.row}`, values: [[f.id]] })));
  }
  const sig = vals => JSON.stringify(vals);

  /** Read both tabs, adopt them, and write ids for rows that lacked one. Returns true when anything changed. */
  async function pull({ quiet = false } = {}) {
    const tabs = Object.values(TABS);
    let vals;
    try { vals = await api.readMany(spreadsheetId, tabs); } catch (e) { throw fail(e); }
    const s = sig(vals);
    if (s === signature && status.state === "ok") return false;
    signature = s;
    const fixes = NAMES.map(n => [n, adopt(n, vals[TABS[n]])]);
    try { for (const [n, f] of fixes) await writeIds(n, f); } catch (e) { throw fail(e); }
    setStatus("ok"); if (!quiet) notify();
    return true;
  }

  async function load() {
    try {
      const m = await api.meta(spreadsheetId); sheetIds = m.sheets;
      for (const n of NAMES) if (sheetIds[TABS[n]] === undefined) { await api.addTab(spreadsheetId, TABS[n], headersFor(n)); sheetIds = (await api.meta(spreadsheetId)).sheets; }
    } catch (e) { throw fail(e); }
    signature = ""; await pull({ quiet: true });
    return { url: undefined };
  }

  /** Serialise every change, and start each from a fresh read of the tab it touches. */
  const run = fn => { const job = queue.catch(() => {}).then(fn); queue = job; return job; };
  async function fresh(name) {
    let vals;
    try { vals = await api.read(spreadsheetId, TABS[name]); } catch (e) { throw fail(e); }
    const fixes = adopt(name, vals); signature = "";
    try { await writeIds(name, fixes); } catch (e) { throw fail(e); }
  }
  /** Make sure the heading row has every column Cold writes (and a column per extra field on a lead). Returns whether it changed. */
  async function shape(name, recs) {
    let h = header[name].slice(), changed = false;
    const have = new Set(h.map(norm));
    for (const c of headersFor(name)) if (!have.has(norm(c))) { h.push(c); have.add(norm(c)); changed = true; }
    if (name === "leads") for (const r of recs) for (const x of missingExtras(h, r)) { h.push(x); have.add(norm(x)); changed = true; }
    if (changed) { await api.write(spreadsheetId, [{ tab: TABS[name], a1: `A1:${colLetter(h.length)}1`, values: [h] }]); header[name] = h; }
    return changed;
  }
  const lastCol = name => colLetter(header[name].length);

  /** Save records: rows that exist are rewritten in place, new ones are added at the bottom (one call each). */
  async function store(name, recs) {
    await shape(name, recs);
    const updates = [], adds = [];
    for (const r of recs) { const row = rowOf[name].get(r.id); const cells = makeRow(name, r, header[name]); (row ? updates.push({ tab: TABS[name], a1: `A${row}:${lastCol(name)}${row}`, values: [cells] }) : adds.push([r, cells])); }
    try {
      await api.write(spreadsheetId, updates);
      if (adds.length) { const rows = await api.append(spreadsheetId, TABS[name], adds.map(a => a[1])); adds.forEach(([r], i) => rows[i] && rowOf[name].set(r.id, rows[i])); }
    } catch (e) { throw fail(e); }
    for (const r of recs) cache[name].set(r.id, r);
    signature = ""; setStatus("ok");
  }

  function collection(name) { return queryCollection(listeners[name], () => [...cache[name].entries()].map(([id, d]) => ({ id, data: () => ({ ...d }) }))); }

  function doc(path) {
    const [name, id] = path.split("/");
    return {
      /** Same contract as the desktop database: with `{ expected, base }` the save is conditional on the stored version. */
      set: (data, { expected, base = null } = {}) => run(async () => {
        await fresh(name);
        const send = async (body, exp) => {
          const stored = cache[name].get(id);
          if (exp !== undefined && (exp === null ? !!stored : stored && versionOf(stored) !== exp)) throw { code: "conflict", status: 409, current: stored };
          const updatedAt = Math.max(now(), versionOf(stored) + 1);
          await store(name, [{ ...body, id, updatedAt }]);
          notify(name);
          return { updatedAt };
        };
        if (expected === undefined) return send(data);
        const r = await saveWithMerge({ send, conflictOf: e => (e && e.code === "conflict" ? e.current : null), base, mine: data, expected });
        if (!r.ok) { notify(name); throw { ...r.error, status: 409 }; }
        return r.value;
      }),
      delete: () => run(async () => { await fresh(name); await removeRows(name, [id]); }),
    };
  }
  async function removeRows(name, ids) {
    const rows = ids.map(i => rowOf[name].get(i)).filter(Boolean);
    try { await api.deleteRows(spreadsheetId, sheetIds[TABS[name]], rows); } catch (e) { throw fail(e); }
    ids.forEach(i => cache[name].delete(i));
    // rows below a removed row move up: take the sheet's numbering again on the next read
    rowOf[name] = new Map(); signature = "";
    await pull({ quiet: true }).catch(() => {});
    notify(name); setStatus("ok");
  }
  /** Save many (a CSV import): one read, one write, one append. */
  const setMany = (name, docs) => run(async () => {
    await fresh(name);
    const t = now();
    await store(name, docs.map((d, i) => ({ ...d, updatedAt: Math.max(t + i, versionOf(cache[name].get(d.id)) + 1) })));
    notify(name);
  });
  const deleteMany = (name, ids) => run(async () => { await fresh(name); await removeRows(name, ids); });

  function start() {
    if (!poll || timer) return;
    timer = setInterval(() => {
      if (globalThis.document && document.hidden) return;
      run(async () => { if (await pull({ quiet: false }).catch(() => false)) { /* notified inside pull */ } }).catch(() => {});
    }, pollMs);
  }

  return {
    kind: "sheets", spreadsheetId, load, collection, doc, setMany, deleteMany, start, stop() { clearInterval(timer); timer = null; },
    /** Read the sheet now (for a "Refresh" button or after reconnecting). */
    refresh: () => run(() => { signature = ""; return pull(); }),
    get status() { return status; },
    onStatus(fn) { statusSubs.add(fn); fn(status); return () => statusSubs.delete(fn); },
    /** Everything currently in the sheet, for copying elsewhere. */
    snapshot: () => ({ leads: [...cache.leads.values()], emails: [...cache.emails.values()] }),
  };
}

/** The database the store sees: leads and outreach from the sheet, everything else from the database that was already there. */
export function splitDb(primary, sheets) {
  const mine = n => NAMES.includes(n);
  return {
    get kind() { return primary.kind; }, storage: "sheets", sheets, primary,
    load: () => (primary.load ? primary.load() : Promise.resolve()),
    collection: n => (mine(n) ? sheets.collection(n) : primary.collection(n)),
    doc: p => (mine(p.split("/")[0]) ? sheets.doc(p) : primary.doc(p)),
    setMany: (n, d) => (mine(n) ? sheets.setMany(n, d) : primary.setMany ? primary.setMany(n, d) : Promise.all(d.map(x => primary.doc(`${n}/${x.id}`).set({ ...x })))),
    deleteMany: (n, ids) => (mine(n) ? sheets.deleteMany(n, ids) : primary.deleteMany ? primary.deleteMany(n, ids) : Promise.all(ids.map(i => primary.doc(`${n}/${i}`).delete()))),
    get initialCompose() { return primary.initialCompose; }, get warnings() { return primary.warnings; }, get saveCompose() { return primary.saveCompose; },
    stop() { sheets.stop(); if (primary.stop) primary.stop(); },
  };
}
