// Cold's portable export and its restore policy. Pure functions, no DOM, no storage: the store applies what this module decides.
//
// FORMAT (version 1), one JSON object:
//   { "format": "cold-export", "version": 1, "exportedAt": ISO-8601, "source": "web"|"desktop"|"extension",
//     "counts": { "products": n, "emails": n, "leads": n },
//     "data": { "products": [...], "emails": [...], "leads": [...], "settings": { signature, signoffProduct, emailApp, gmailAccount, followUp } } }
// Records are exactly what Cold holds (including fields this version doesn't know), keyed by their own `id`, so drafts still point at their products
// and leads. NEVER exported: provider API keys, Google or pairing tokens, session codes, the Write form scratch state, the first-run flag.
import { normalizeFollowUpSettings } from "./followup.js";

export const EXPORT_FORMAT = "cold-export";
export const EXPORT_VERSION = 1;
export const KINDS = ["products", "emails", "leads"];
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_RECORDS = 100000;
export const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
export const SETTINGS_KEYS = ["signature", "signoffProduct", "emailApp", "gmailAccount", "followUp"];

/** Field names that look like a credential. Removed from anything exported (and ignored on import), whatever record they are on. */
const SECRET_KEY = /api[-_]?key|secret|token|passw|authorization|bearer|credential/i;
const UNSAFE_KEY = new Set(["__proto__", "constructor", "prototype"]);
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);

/** A deep copy without credential-looking or prototype-polluting keys. */
export function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!isObj(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) if (!SECRET_KEY.test(k) && !UNSAFE_KEY.has(k)) out[k] = stripSecrets(v);
  return out;
}
/** The names of credential-looking keys found anywhere in a value (for a warning; never their values). */
export function secretKeysIn(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach(v => secretKeysIn(v, found));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) { if (SECRET_KEY.test(k)) found.add(k); secretKeysIn(v, found); }
  return found;
}

const clone = v => JSON.parse(JSON.stringify(v));
export const pickSettings = s => { const o = {}; for (const k of SETTINGS_KEYS) if (s && s[k] !== undefined) o[k] = clone(s[k]); return o; };

/** `cold-export-2026-10-14.json`: the date is local, no colons, so it is a legal file name everywhere. */
export function exportFilename(now = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `cold-export-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
}

/** The export object for what Cold currently holds. Throws if the result would not pass its own validation (so a broken export is never offered). */
export function buildExport(state, { now = new Date(), surface = "web" } = {}) {
  const data = { settings: pickSettings(state.settings || {}) };
  for (const k of KINDS) data[k] = (state[k] || []).map(r => stripSecrets(clone(r)));
  const file = { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: now.toISOString(), source: surface, counts: Object.fromEntries(KINDS.map(k => [k, data[k].length])), data };
  const v = validateExport(file);
  if (!v.ok) throw Object.assign(new Error(`The export failed its own check: ${v.errors[0]}`), { code: "export_invalid", errors: v.errors });
  return file;
}
export const exportText = file => JSON.stringify(file, null, 2);
export const totalRecords = c => KINDS.reduce((n, k) => n + ((c && c[k]) || 0), 0);

// ---- validation: the whole file, before anything is written -----------------------------------------------------------------
const FIELD_TYPES = {
  products: { name: "string" },
  emails: { createdAt: "number", status: "string", recipient: "object", handoffs: "array", followUp: "object", note: "string", subject: "string", what: "string", why: "string", ask: "string", sentAt: "number", repliedAt: "number", sentCopy: "object" },
  leads: { name: "string", company: "string", email: "string", list: "string", custom: "object", createdAt: "number" },
};
const typeOf = v => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

/** @returns {{ ok: boolean, errors: string[], warnings: string[], counts: object|null }}  Messages name positions and field names only, never values. */
export function validateExport(file) {
  const errors = [], warnings = [], add = m => { if (errors.length < 12) errors.push(m); };
  if (!isObj(file)) return { ok: false, errors: ["This isn't a Cold export (the file's top level isn't an object)."], warnings, counts: null };
  if (file.format !== EXPORT_FORMAT) return { ok: false, errors: ["This isn't a Cold export file (its format marker is missing or different)."], warnings, counts: null };
  if (!Number.isInteger(file.version)) return { ok: false, errors: ["This Cold export has no version number, so Cold can't tell how to read it."], warnings, counts: null };
  if (file.version > EXPORT_VERSION) return { ok: false, errors: [`This export is version ${file.version}, made by a newer Cold. This Cold reads version ${EXPORT_VERSION}. Update Cold, then try again.`], warnings, counts: null };
  if (file.version < 1) return { ok: false, errors: [`Export version ${file.version} isn't supported.`], warnings, counts: null };
  if (!isObj(file.data)) return { ok: false, errors: ["The file has no data section."], warnings, counts: null };
  const counts = {};
  for (const kind of KINDS) {
    const list = file.data[kind];
    if (!Array.isArray(list)) { add(`The "${kind}" list is missing or isn't a list.`); continue; }
    if (list.length > MAX_RECORDS) { add(`The "${kind}" list has ${list.length} items; the limit is ${MAX_RECORDS}.`); continue; }
    counts[kind] = list.length;
    const seen = new Set();
    list.forEach((r, i) => {
      const at = `${kind}[${i}]`;
      if (!isObj(r)) return add(`${at} isn't a record.`);
      if (typeof r.id !== "string" || !ID_PATTERN.test(r.id)) return add(`${at} has a missing or invalid id.`);
      if (seen.has(r.id)) return add(`${at} repeats the id of an earlier ${kind.slice(0, -1)} in the file.`);
      seen.add(r.id);
      for (const [f, t] of Object.entries(FIELD_TYPES[kind])) if (r[f] !== undefined && typeOf(r[f]) !== t && !(t === "object" && r[f] === null)) add(`${at}.${f} should be ${t === "array" ? "a list" : t === "object" ? "an object" : `a ${t}`}.`);
      if (kind === "products" && (typeof r.name !== "string" || !r.name.trim())) add(`${at} has no name.`);
      if (kind === "leads" && (typeof r.name !== "string" || !r.name.trim())) add(`${at} has no name.`);
      if (kind === "emails" && r.recipient === undefined && !(r.mode && r.mode !== "email")) add(`${at} has no recipient.`);
    });
  }
  if (file.counts !== undefined) {
    if (!isObj(file.counts)) add("The file's counts are malformed.");
    else for (const kind of KINDS) if (counts[kind] !== undefined && file.counts[kind] !== counts[kind]) add(`The file says it has ${file.counts[kind]} ${kind} but contains ${counts[kind]}: it may be truncated or edited.`);
  }
  if (file.data.settings !== undefined && !isObj(file.data.settings)) add("The settings section is malformed.");
  const secrets = secretKeysIn(file.data);
  if (secrets.size) warnings.push(`The file contains credential-like fields (${[...secrets].slice(0, 5).join(", ")}). They will be ignored and never stored.`);
  return { ok: errors.length === 0, errors, warnings, counts: errors.length ? null : counts };
}

/** Text -> { ok, file, errors, warnings } . Rejects an empty, oversized, non-JSON or truncated file with an actionable, content-free message. */
export function parseExport(text, { size = String(text || "").length } = {}) {
  if (!text || !String(text).trim()) return { ok: false, errors: ["The file is empty."], warnings: [] };
  if (size > MAX_FILE_BYTES) return { ok: false, errors: [`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB, so it isn't a Cold export Cold can restore.`], warnings: [] };
  let file;
  try { file = JSON.parse(text); }
  catch { return { ok: false, errors: ["This file isn't valid JSON. If it was cut off while downloading or copying, export again and use the new file."], warnings: [] }; }
  const v = validateExport(file);
  return v.ok ? { ok: true, file, errors: [], warnings: v.warnings, counts: v.counts } : { ok: false, errors: v.errors, warnings: v.warnings };
}

// ---- the import policy ------------------------------------------------------------------------------------------------------
// Two explicit modes; nothing is ever merged field by field and nothing is silently overwritten.
//   "add"     Keeps EVERYTHING already here. A record is added only if its id is new. Same id and identical content: skipped ("already here").
//             Same id, different content: a CONFLICT: the record already here is kept, the file's is not applied, and it is listed.
//             A lead whose email / profile link / name+company matches a lead already here under another id: skipped as a duplicate person.
//             Settings are not touched.
//   "replace" Makes this library equal to the file (destructive, needs explicit confirmation): every record not in the file is deleted, every record
//             in the file is written, and the file's settings are applied. Things a file never holds (pairing, keys, other libraries) are untouched.
export const IMPORT_MODES = ["add", "replace"];

const volatile = new Set(["updatedAt"]);
/** Same record apart from the version stamp the store assigns on each save. Key order is irrelevant. */
export function sameRecord(a, b) {
  const canon = v => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
  const strip = r => { const o = { ...r }; for (const k of volatile) delete o[k]; return o; };
  return JSON.stringify(canon(strip(a))) === JSON.stringify(canon(strip(b)));
}
const label = (kind, r) => (kind === "emails" ? (r.recipient && r.recipient.name) || r.subject || r.id : r.name || r.id);

/**
 * @param file   a validated export object
 * @param existing { products, emails, leads } as held now
 * @param leadKey the function that decides "same person" (domain/leads.js)
 * @returns a plan: what would be added, what is already here, what conflicts, what would be deleted. It writes nothing.
 */
export function planRestore(file, existing, { mode = "add", leadKey = l => `i:${l.id}` } = {}) {
  if (!IMPORT_MODES.includes(mode)) throw new Error("Unknown restore mode.");
  const plan = { mode, add: { products: [], emails: [], leads: [] }, same: { products: [], emails: [], leads: [] }, conflicts: [], duplicatePeople: [], remove: { products: [], emails: [], leads: [] }, settings: null };
  const byId = Object.fromEntries(KINDS.map(k => [k, new Map((existing[k] || []).map(r => [r.id, r]))]));
  const personKeys = new Map((existing.leads || []).map(l => [leadKey(l), l.id]));
  for (const kind of KINDS) for (const raw of file.data[kind]) {
    const rec = stripSecrets(clone(raw)), have = byId[kind].get(rec.id);
    if (have) {
      if (sameRecord(have, rec)) plan.same[kind].push(rec);                                     // already here, identical: nothing to do
      else if (mode === "replace") plan.add[kind].push(rec);                                     // the library becomes the file: this one is replaced
      else plan.conflicts.push({ kind, id: rec.id, label: label(kind, have) });                  // add mode: what is here is kept, the file's is not applied
      continue;
    }
    if (kind === "leads" && mode === "add") { const k = leadKey(rec), other = personKeys.get(k); if (other) { plan.duplicatePeople.push({ id: rec.id, label: label(kind, rec), sameAs: other }); continue; } personKeys.set(k, rec.id); }
    plan.add[kind].push(rec);
  }
  if (mode === "replace") {
    for (const kind of KINDS) { const keep = new Set(file.data[kind].map(r => r.id)); for (const r of existing[kind] || []) if (!keep.has(r.id)) plan.remove[kind].push({ id: r.id, label: label(kind, r) }); }
    plan.settings = pickSettings(stripSecrets(clone(file.data.settings || {})));
    if (plan.settings.followUp) plan.settings.followUp = normalizeFollowUpSettings(plan.settings.followUp);
  }
  plan.counts = {
    add: Object.fromEntries(KINDS.map(k => [k, plan.add[k].length])), same: Object.fromEntries(KINDS.map(k => [k, plan.same[k].length])),
    remove: Object.fromEntries(KINDS.map(k => [k, plan.remove[k].length])), conflicts: plan.conflicts.length, duplicatePeople: plan.duplicatePeople.length,
  };
  plan.changes = totalRecords(plan.counts.add) + totalRecords(plan.counts.remove);
  return plan;
}

/** After applying: every record the plan wrote must be present, and every one it removed must be gone. Returns [] when everything checks out. */
export function verifyRestore(plan, after) {
  const problems = [];
  for (const kind of KINDS) {
    const have = new Map((after[kind] || []).map(r => [r.id, r]));
    for (const r of plan.add[kind]) { const got = have.get(r.id); if (!got) problems.push(`a ${kind.slice(0, -1)} that should have been saved is missing`); else if (kind === "emails" && (got.status !== r.status || (got.note || "") !== (r.note || "") || (got.createdAt || 0) !== (r.createdAt || 0))) problems.push("a draft was saved with different status, notes or dates than the file"); else if (kind !== "emails" && (got.name || "") !== (r.name || "")) problems.push(`a ${kind.slice(0, -1)} was saved with a different name`); }
    for (const r of plan.remove[kind]) if (have.has(r.id)) problems.push(`a ${kind.slice(0, -1)} that should have been removed is still there`);
  }
  return [...new Set(problems)];
}
