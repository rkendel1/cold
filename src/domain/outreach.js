// Outreach status: what the user has told Cold happened to a draft. Cold never observes sending or replies; every transition
// below is called only from an explicit user action (a button or the status menu), never from copying, opening or editing.
import { STATUSES } from "./constants.js";
import { emailText } from "./email.js";

export const statusOf = e => (e && STATUSES.includes(e.status) ? e.status : "draft");

/**
 * The record after the user sets `status`. Returns a NEW object; the input is untouched.
 *  - Entering "sent" stamps sentAt and keeps ONE copy of the text as it was at that moment (`sentCopy`), so later edits don't
 *    rewrite what was sent. Recording a reply without a send does not invent a send.
 *  - Entering "replied" stamps repliedAt. Going back to "draft" keeps the timestamps (they are history, just not shown as current).
 *  - Setting the status a record already has changes nothing.
 */
export function applyStatus(rec, status, { now = Date.now(), signature = "" } = {}) {
  if (!STATUSES.includes(status) || statusOf(rec) === status) return rec;
  const next = { ...rec, status };
  if (status === "sent") { next.sentAt = now; next.sentCopy = { subject: String(rec.subject || ""), text: emailText(rec, signature), at: now }; }
  if (status === "replied") next.repliedAt = now;
  return next;
}

/** Has the text been changed since the user marked it sent? (Only meaningful when a sentCopy exists.) */
export function editedSinceSent(rec, signature = "") {
  if (!rec || !rec.sentCopy) return false;
  return rec.sentCopy.text !== emailText(rec, signature) || String(rec.sentCopy.subject || "") !== String(rec.subject || "");
}

const hay = e => [e.recipient && e.recipient.name, e.recipient && e.recipient.company, e.recipient && e.recipient.email, e.subject, e.productName, e.what, e.note].filter(Boolean).join(" ").toLowerCase();

/** History rows for a status filter ("all" or a status) and a search string. Records with missing fields are never dropped or inferred. */
export function filterOutreach(emails, { status = "all", query = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  return emails.filter(e => (status === "all" || statusOf(e) === status) && (!q || hay(e).includes(q)));
}

export const countByStatus = emails => {
  const c = { all: emails.length }; STATUSES.forEach(s => { c[s] = 0; });
  emails.forEach(e => { c[statusOf(e)]++; });
  return c;
};

/** A short, single-line preview of the message body. */
export const preview = (e, n = 120) => {
  const t = String(e.mode && e.mode !== "email" ? e.what : `${e.what || ""} ${e.why || ""} ${e.ask || ""}`).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
