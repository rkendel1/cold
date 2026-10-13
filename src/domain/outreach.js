// Outreach status: what the user has told Cold happened to a draft. Cold never observes sending or replies; every transition
// below is called only from an explicit user action (a button or the status menu), never from copying, opening or editing.
import { STATUSES, UNKNOWN_STATUS } from "./constants.js";
import { emailText } from "./email.js";
import { stopForReply } from "./followup.js";
import rules from "../../lib/library-rules.cjs";

/**
 * draft | sent | replied, or "unknown" for a status this client doesn't recognise. Only a record with NO status at all gets the
 * legacy default of "draft"; an unfamiliar value is reported as unknown and is never written back as something else.
 */
export const statusOf = e => {
  const s = e && e.status;
  if (s == null || s === "") return "draft";
  return STATUSES.includes(s) ? s : UNKNOWN_STATUS;
};

/**
 * The record after the user sets `status`. Returns a NEW object; the input is untouched.
 *  - Entering "sent" stamps sentAt and keeps ONE copy of the text as it was at that moment (`sentCopy`), so later edits don't
 *    rewrite what was sent. Recording a reply without a send does not invent a send.
 *  - Entering "replied" stamps repliedAt. Going back to "draft" keeps the timestamps (they are history, just not shown as current).
 *  - Setting the status a record already has changes nothing. A record with an unknown status keeps it until the user picks a
 *    supported one here; that choice is the only way it changes.
 */
export function applyStatus(rec, status, { now = Date.now(), signature = "" } = {}) {
  if (!STATUSES.includes(status) || statusOf(rec) === status) return rec;
  const next = { ...rec, status };
  if (status === "sent") { next.sentAt = now; next.sentCopy = { subject: String(rec.subject || ""), text: emailText(rec, signature), body: emailText(rec, ""), at: now }; }
  if (status === "replied") { next.repliedAt = now; return stopForReply(next); }
  return next;
}

/** Has the text been changed since the user marked it sent? (Only meaningful when a sentCopy exists.) */
export function editedSinceSent(rec, signature = "") {
  if (!rec || !rec.sentCopy) return false;
  // Compare the message itself (not the sign-off): changing your sign-off or a product link later isn't an edit to what was sent.
  const same = typeof rec.sentCopy.body === "string" ? rec.sentCopy.body === emailText(rec, "") : rec.sentCopy.text === emailText(rec, signature);
  return !same || String(rec.sentCopy.subject || "") !== String(rec.subject || "");
}

const hay = e => [e.recipient && e.recipient.name, e.recipient && e.recipient.company, e.recipient && e.recipient.email, e.subject, e.productName, e.what, e.note].filter(Boolean).join(" ").toLowerCase();

/** History rows for a status filter ("all" or a status) and a search string. Records with missing fields are never dropped or inferred. */
export const NO_PRODUCT = "none";
/** A product filter matches the stable productId only, never the display name. "none" is every record saved without one. */
const inProduct = (e, product) => product === "all" || (product === NO_PRODUCT ? !e.productId : e.productId === product);
export function filterOutreach(emails, { status = "all", query = "", product = "all" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  return emails.filter(e => (status === "all" || statusOf(e) === status) && inProduct(e, product) && (!q || hay(e).includes(q)));
}
/**
 * The choices for a product filter: [{ value, label }]. Current products by their current name; a record whose product was removed
 * is offered under the name saved on it; records with no productId share "No product". Read-only: nothing is rewritten.
 */
export function productFilterOptions(emails, products) {
  const out = [], seen = new Set();
  for (const p of products) { seen.add(p.id); out.push({ value: p.id, label: p.name || "Untitled product" }); }
  for (const e of emails) if (e.productId && !seen.has(e.productId)) { seen.add(e.productId); out.push({ value: e.productId, label: `${e.productName || "Unknown product"} (removed)` }); }
  if (emails.some(e => !e.productId)) out.push({ value: NO_PRODUCT, label: "No product" });
  return out;
}

export const countByStatus = emails => {
  const c = { all: emails.length, [UNKNOWN_STATUS]: 0 }; STATUSES.forEach(s => { c[s] = 0; });
  emails.forEach(e => { c[statusOf(e)]++; });
  return c;
};

/** A short, single-line preview of the message body. */
export const preview = (e, n = 120) => {
  const t = String(e.mode && e.mode !== "email" ? e.what : `${e.what || ""} ${e.why || ""} ${e.ask || ""}`).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// ---- Concurrent edits -------------------------------------------------------------------------------------------------------
// Every surface (web, desktop, extension) saves a whole record, but a record's `updatedAt` is its version: a save says which
// version it was based on, and a save based on an older version is merged field by field or refused, never written over the top.

export const { versionOf, nextVersion } = rules;

const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
const eq = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (isObj(a) && isObj(b)) { const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined); return ka.length === kb.length && ka.every(k => eq(a[k], b[k])); }
  return false;
};
const ATOMIC = new Set(["sentCopy", "followUp"]);   // the sent snapshot is one unit: its parts are never mixed from two copies

/**
 * Three-way merge of one record. `base` is the copy the edit started from, `mine` the edited copy, `theirs` the stored copy.
 * A field changed on only one side takes that side's value; a field changed identically on both is fine; a field changed
 * DIFFERENTLY on both is a conflict and keeps the stored value. Nothing is decided by "whoever saved last".
 * @returns {{ record: object, conflicts: string[] }}  `record` is only meaningful when `conflicts` is empty.
 */
export function mergeRecords(base, mine, theirs) {
  const b0 = isObj(base) ? base : {}, conflicts = [], out = {};
  const merge = (b, m, t, path, into) => {
    for (const k of new Set([...Object.keys(m), ...Object.keys(t), ...Object.keys(b)])) {
      if (!path && k === "updatedAt") continue;                                  // the version is assigned by whoever stores the record
      const here = path ? `${path}.${k}` : k, bv = b[k], mv = m[k], tv = t[k];
      let v;
      if (eq(mv, tv)) v = mv;
      else if (eq(mv, bv)) v = tv;
      else if (eq(tv, bv)) v = mv;
      else if (isObj(mv) && isObj(tv) && (bv === undefined || isObj(bv)) && !ATOMIC.has(k)) { into[k] = {}; merge(bv || {}, mv, tv, here, into[k]); continue; }
      else { conflicts.push(here); v = tv; }
      if (v !== undefined) into[k] = v;
    }
  };
  merge(b0, mine || {}, theirs || {}, "", out);
  return { record: out, conflicts };
}

/** The error a caller gets when a save would have destroyed a newer change. `mine` is the user's edit, `current` what is stored. */
export const conflictError = (conflicts, mine, current) => ({ code: "conflict", conflicts, mine, current,
  message: "This was changed somewhere else, so your edit was not saved over it. The newer version is kept; your edit is still on screen." });

/**
 * Decide what to store for a save. `expected` is the version the edit was based on (null for a brand-new record), `base` the copy
 * of that version when the caller has it. Returns { ok: true, record } (not yet versioned) or { ok: false, error }.
 */
export function reconcileSave({ base = null, mine, stored, expected }) {
  if (!stored) return { ok: true, record: mine };
  if (expected != null && versionOf(stored) === expected) return { ok: true, record: mine };
  const m = mergeRecords(base, mine, stored);
  return m.conflicts.length ? { ok: false, error: conflictError(m.conflicts, mine, stored) } : { ok: true, record: m.record, merged: true };
}
