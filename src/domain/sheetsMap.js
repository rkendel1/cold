// How leads and outreach look as rows in a Google Sheet. The sheet is meant to be used by people, not only by Cold, so:
//   - columns are read by their HEADING, in any order; a column Cold doesn't know on the Leads tab is an extra field of that lead
//   - a row typed straight into the sheet (no id) is a new record: Cold gives it an id when it next reads
//   - Outreach keeps the full record in a "data" column and shows the useful parts as plain columns; changing one of those columns in the
//     sheet (status, notes, email address, subject, follow-up date) is honoured over the saved copy
// Everything is written as plain text (never as a formula), and read back as text.
import { LEAD_FIELDS, cleanCustom, normalizeLead } from "./leads.js";
import { emailText } from "./email.js";
import { STATUSES } from "./constants.js";
import { uid } from "./ids.js";

export const TABS = { leads: "Leads", emails: "Outreach" };
export const CELL_MAX = 45000;   // Google allows 50,000 characters in a cell
const norm = s => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
const str = v => (v == null ? "" : typeof v === "string" ? v : String(v));
const iso = ts => (Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : "");
const stamp = v => { const t = Date.parse(String(v || "").trim()); return Number.isFinite(t) ? t : undefined; };

/** One tab's column layout: the fixed columns (in order), and how to read each heading back. */
export const LEAD_COLUMNS = ["id", ...LEAD_FIELDS.map(f => f.header), "created", "updated"];
export const EMAIL_COLUMNS = ["id", "created", "status", "recipient", "company", "email", "role", "subject", "message", "goal", "product", "sent", "replied", "follow_up", "notes", "data"];
export const headersFor = name => (name === "leads" ? LEAD_COLUMNS : EMAIL_COLUMNS);

/** The sheet's rows as { header, rows: [{ row, cells }] }. Row numbers are the sheet's own (the heading is row 1). Empty rows are skipped. */
export function parseTable(values) {
  const grid = Array.isArray(values) ? values : [];
  const header = (grid[0] || []).map(str);
  const rows = [];
  grid.slice(1).forEach((cells, i) => { const c = (cells || []).map(str); if (c.some(x => x.trim() !== "")) rows.push({ row: i + 2, cells: c }); });
  return { header, rows };
}
/** Column positions by heading (case, spaces and punctuation ignored): { id: 0, profile_url: 4, … }. The first column with a heading wins. */
export function columnIndex(header) {
  const out = {};
  header.forEach((h, i) => { const k = norm(h); if (k && out[k] === undefined) out[k] = i; });
  return out;
}
const at = (cells, idx, name) => { const i = idx[norm(name)]; return i === undefined ? "" : str(cells[i]); };
const pad = (cells, n) => { const out = cells.slice(); while (out.length < n) out.push(""); return out; };

// ---- Leads --------------------------------------------------------------------------------------------------------------------
const LEAD_KEYS = new Set([...LEAD_COLUMNS, ...LEAD_FIELDS.flatMap(f => [f.key, f.label])].map(norm));
const HEADER_ALIAS = Object.fromEntries(LEAD_FIELDS.flatMap(f => [[norm(f.header), f.key], [norm(f.label), f.key], [norm(f.key), f.key]]));

/** The heading row for the Leads tab: the fixed columns, then one column per extra field in use. */
export const leadHeader = (extraNames = []) => [...LEAD_COLUMNS, ...extraNames];
/** Extra-field names a lead needs that the heading doesn't have yet (so the caller can add those columns). */
export const missingExtras = (header, lead) => { const have = new Set(header.map(norm)); return Object.keys(cleanCustom(lead.custom)).filter(n => !have.has(norm(n))); };

export function leadToRow(lead, header) {
  const custom = cleanCustom(lead.custom), idx = columnIndex(header), cells = pad([], header.length);
  const put = (name, v) => { const i = idx[norm(name)]; if (i !== undefined) cells[i] = str(v); };
  put("id", lead.id);
  for (const f of LEAD_FIELDS) put(f.header, lead[f.key]);
  put("created", iso(lead.createdAt)); put("updated", iso(lead.updatedAt));
  for (const [name, v] of Object.entries(custom)) put(name, v);
  return cells;
}
/** A row as a lead. `id` may be empty (a row typed in the sheet): the caller assigns one. Columns Cold doesn't know become extra fields. */
export function rowToLead(cells, header, { now = Date.now(), makeId = () => uid("l") } = {}) {
  const idx = columnIndex(header), raw = { id: at(cells, idx, "id").trim() || makeId(), source: "sheet" };
  for (const f of LEAD_FIELDS) raw[f.key] = at(cells, idx, f.header).trim();
  raw.createdAt = stamp(at(cells, idx, "created")) ?? now; raw.updatedAt = stamp(at(cells, idx, "updated")) ?? now;
  const custom = {};
  header.forEach((h, i) => { if (h.trim() && !LEAD_KEYS.has(norm(h)) && !HEADER_ALIAS[norm(h)]) custom[h.trim()] = str(cells[i]); });
  const c = cleanCustom(custom); if (Object.keys(c).length) raw.custom = c;
  return normalizeLead(raw);
}

// ---- Outreach ----------------------------------------------------------------------------------------------------------------
const body = rec => [rec.what, rec.why, rec.ask].map(str).filter(Boolean).join(" ");
/** The columns people read and edit, for one record. */
export function emailCells(rec) {
  const r = rec.recipient && typeof rec.recipient === "object" ? rec.recipient : {};
  const social = rec.mode && rec.mode !== "email";
  return { recipient: str(r.name), company: str(r.company), email: str(r.email), role: str(r.role), subject: social ? "" : str(rec.subject), message: social ? str(rec.what) : body(rec),
    goal: str(rec.goal === "other" ? rec.goalOther || "other" : rec.goal), product: str(rec.productName), status: str(rec.status || "draft"),
    sent: iso(rec.sentAt), replied: iso(rec.repliedAt), follow_up: iso(rec.followUp && rec.followUp.due), notes: str(rec.note) };
}
/** The record serialised for the data column; if it is too big for a cell, the bulkiest derived parts are dropped first (they are rebuilt on use). */
export function dataCell(rec) {
  const { id, ...rest } = rec;
  let json = JSON.stringify(rest);
  for (const k of ["retrieved", "claims", "checks", "draft", "draftFailures", "sentCopy"]) { if (json.length <= CELL_MAX) break; delete rest[k]; json = JSON.stringify(rest); }
  return json.length <= CELL_MAX ? json : "";
}
export function emailToRow(rec, header) {
  const idx = columnIndex(header), cells = pad([], header.length), c = emailCells(rec);
  const put = (name, v) => { const i = idx[norm(name)]; if (i !== undefined) cells[i] = str(v); };
  put("id", rec.id); put("created", iso(rec.createdAt)); put("data", dataCell(rec));
  for (const [k, v] of Object.entries(c)) put(k, v);
  return cells;
}
/** A row as a record. The saved copy (data column) is the base; a column that differs from what that copy would show was changed in the sheet and wins. */
export function rowToEmail(cells, header, { now = Date.now(), makeId = () => uid("e") } = {}) {
  const idx = columnIndex(header);
  let saved = null;
  try { const p = JSON.parse(at(cells, idx, "data") || "null"); if (p && typeof p === "object" && !Array.isArray(p)) saved = p; } catch { saved = null; }
  const rec = { ...(saved || {}), id: at(cells, idx, "id").trim() || makeId() };
  const shown = saved ? emailCells(rec) : null, cell = k => at(cells, idx, k);
  const edited = k => !saved || cell(k).trim() !== (shown[k] || "").trim();
  if (!saved) {
    const r = {}; Object.assign(r, { name: cell("recipient").trim(), company: cell("company").trim(), role: cell("role").trim(), email: cell("email").trim() });
    Object.assign(rec, { recipient: r, subject: cell("subject").trim(), what: cell("message").trim(), why: "", ask: "", goal: norm(cell("goal")) || "advice", productName: cell("product").trim(), createdAt: stamp(cell("created")) ?? now, mode: "email" });
  } else {
    if (edited("email")) rec.recipient = { ...(rec.recipient || {}), email: cell("email").trim() };
    if (edited("subject") && !(rec.mode && rec.mode !== "email")) rec.subject = cell("subject").trim();
  }
  if (edited("status")) { const s = norm(cell("status")); const hit = STATUSES.find(x => norm(x) === s); if (hit) rec.status = hit; else if (!saved) rec.status = "draft"; }
  if (!rec.status) rec.status = "draft";
  if (edited("notes")) rec.note = cell("notes");
  if (edited("follow_up")) { const t = stamp(cell("follow_up")); rec.followUp = t === undefined ? { ...(rec.followUp || { count: 0 }), due: null, off: true } : { ...(rec.followUp || { count: 0 }), due: t, off: false, auto: false }; }
  if (!Number.isFinite(rec.createdAt)) rec.createdAt = stamp(cell("created")) ?? now;
  return rec;
}
export const emailTextForSheet = emailText;   // kept so the "message" column and Copy agree on what a draft says (without the sign-off)

// ---- Version ----------------------------------------------------------------------------------------------------------------
/** A record's version is its updatedAt; the sheet keeps it in the data column (Outreach) or the "updated" column (Leads). */
export const versionOf = rec => (rec && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0);
export const makeRow = (name, rec, header) => (name === "leads" ? leadToRow(rec, header) : emailToRow(rec, header));
export const readRow = (name, cells, header, opts) => (name === "leads" ? rowToLead(cells, header, opts) : rowToEmail(cells, header, opts));
