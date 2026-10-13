// Leads: people you might write to, kept as a list. This file is the one definition of what a lead is, what the CSV template looks
// like, how a CSV becomes leads, and what an import will do, so the screen, the tests and the template file can't drift apart.
// Everything here is pure: no storage, no network, no page.
import { GOALS } from "./constants.js";
import { uid } from "./ids.js";
import mailto from "../../lib/mailto.js";
import profile from "../../lib/profile.js";

export const MAX_IMPORT_ROWS = 5000;          // per import; keeps the preview, the save and the sync fast and the database tidy
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** The columns, in template order. `header` is what the template and export use; `aliases` are other headings an import accepts. */
export const LEAD_FIELDS = [
  { key: "name", header: "name", label: "Name", required: true, aliases: ["fullname", "contact", "contactname", "person", "leadname"], hint: "Who you're writing to. The only required column.", example: ["Jordan Rivera", "Priya Nair", "Sam Okafor"] },
  { key: "company", header: "company", label: "Company", aliases: ["organization", "organisation", "account", "employer", "business", "companyname"], hint: "Where they work. Cold asks for it when it writes the email.", example: ["Northwind Logistics", "Brightside Labs", "Okafor & Co"] },
  { key: "role", header: "role", label: "Role", aliases: ["title", "jobtitle", "position"], hint: "Their job title.", example: ["Head of Platform", "Founder", "COO"] },
  { key: "email", header: "email", label: "Email", aliases: ["emailaddress", "mail", "workemail"], hint: "One address. Used only for Open in email. Cold looks one up only when you press Find email on a lead.", example: ["jordan.rivera@example.com", "priya.nair@example.org", "sam.okafor@example.net"] },
  { key: "profileUrl", header: "profile_url", label: "Profile link", aliases: ["profile", "linkedin", "linkedinurl", "linkedinprofile", "twitter", "xprofile", "xurl", "url", "social"], hint: "A LinkedIn (linkedin.com/in/…) or X (x.com/handle) link.", example: ["https://www.linkedin.com/in/jordan-rivera-example", "https://x.com/priyanair_example", ""] },
  { key: "why", header: "why", label: "Why they'd care", aliases: ["reason", "whythem", "whycare", "hook", "personalization", "personalisation", "context", "relevance"], hint: "The specific reason you're contacting them: something they wrote, built or said. Cold uses it as the only connection and won't invent one.", example: ["Writes about moving batch workloads between cloud and edge", "Posted that most trials stall before a teammate is invited", "Runs the plumbing-shops community we want to learn from"] },
  { key: "product", header: "product", label: "Product", aliases: ["offer", "offering", "productname"], hint: "Which of your saved products to write about (its name, as saved in Knowledge). Leave blank to choose when you write.", example: ["Your product name", "Your product name", ""] },
  { key: "goal", header: "goal", label: "Goal", aliases: ["ask", "objective", "purpose"], hint: "What you want from them: advice, investment, introduction, customer, partnership or other.", example: ["advice", "customer", "introduction"] },
  { key: "list", header: "list", label: "List", aliases: ["group", "campaign", "segment", "tag", "tags", "batch"], hint: "A name to group leads by (for example a campaign or event). Used to filter.", example: ["Q4 founders", "Q4 founders", "Plumbing community"] },
  { key: "notes", header: "notes", label: "Notes", aliases: ["note", "comments", "comment", "remarks"], hint: "Anything for yourself. Never used in an email.", example: ["Met at the infra meetup", "", "Warm intro from Alex"] },
];
const LIMITS = { name: 200, company: 200, role: 200, email: 254, profileUrl: 500, why: 2000, product: 200, goal: 40, list: 100, notes: 4000 };

// ---- the template -----------------------------------------------------------------------------------------------------------
const TEMPLATE_EMAILS = new Set(LEAD_FIELDS.find(f => f.key === "email").example.map(e => e.toLowerCase()));   // only the template's own three sample rows are skipped
/** A cell that a spreadsheet could run as a formula is prefixed with an apostrophe on the way out (and removed on the way in). */
const defuse = v => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const refuse = v => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);
const csvCell = v => { const s = defuse(String(v == null ? "" : v)); return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s; };
const csvLine = cells => cells.map(csvCell).join(",");

export const TEMPLATE_HEADERS = LEAD_FIELDS.map(f => f.header);
/** The example file people download and fill in: the exact columns Cold uses, with three made-up sample rows to overwrite or delete. */
export function templateCsv() {
  const rows = [0, 1, 2].map(i => LEAD_FIELDS.map(f => f.example[i]));
  return `${[TEMPLATE_HEADERS, ...rows].map(csvLine).join("\r\n")}\r\n`;
}
/** Your leads in the same columns, ready to open in a spreadsheet or import again. */
export function leadsToCsv(leads) {
  return `${[TEMPLATE_HEADERS, ...leads.map(l => LEAD_FIELDS.map(f => l[f.key]))].map(csvLine).join("\r\n")}\r\n`;
}

// ---- reading a CSV ----------------------------------------------------------------------------------------------------------
/**
 * RFC 4180 reader that also copes with what spreadsheets really produce: a byte-order mark, CRLF or LF, commas / semicolons / tabs as
 * separators, quoted cells that contain separators, quotes ("") and line breaks, and blank lines.
 * @returns {{ ok: true, rows: { line: number, cells: string[] }[], delimiter: string } | { ok: false, message: string }}
 */
export function parseCsv(input) {
  let text = String(input == null ? "" : input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\u0000")) return { ok: false, message: "That doesn't look like a text CSV file. Save the spreadsheet as CSV (comma separated) and try again." };
  const first = text.split(/\r\n|\n|\r/, 1)[0] || "";
  const count = ch => (first.match(new RegExp(ch === "\t" ? "\\t" : `\\${ch}`, "g")) || []).length;
  const delimiter = [",", ";", "\t"].map(d => [d, count(d)]).sort((a, b) => b[1] - a[1])[0];
  const sep = delimiter[1] > 0 ? delimiter[0] : ",";
  const rows = []; let cells = [], cell = "", quoted = false, started = false, line = 1, startLine = 1, justClosed = false;
  const endCell = () => { cells.push(cell); cell = ""; started = false; justClosed = false; };
  const endRow = () => { endCell(); if (cells.some(c => c.trim() !== "")) rows.push({ line: startLine, cells }); cells = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; justClosed = true; } }
      else { if (c === "\n") line++; cell += c; }
      continue;
    }
    if (c === '"' && !started && !justClosed) { quoted = true; started = true; continue; }
    if (c === sep) { endCell(); continue; }
    if (c === "\r" || c === "\n") { if (c === "\r" && text[i + 1] === "\n") i++; endRow(); line++; startLine = line; continue; }
    cell += c; started = true; justClosed = false;
  }
  if (quoted) return { ok: false, message: `A quoted cell that starts on line ${startLine} never closes, so the rest of the file can't be read. Check for a stray quote mark.` };
  if (started || cell !== "" || cells.length) endRow();
  return { ok: true, rows, delimiter: sep };
}

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const FIRST = ["firstname", "first", "givenname", "forename"], LAST = ["lastname", "last", "surname", "familyname"];

/** Which column holds which field. @returns {{ ok: true, columns: Record<string, number>, first?: number, last?: number, ignored: string[] } | { ok: false, message: string }} */
export function mapHeaders(headerCells) {
  const keys = headerCells.map(norm), columns = {}, used = new Set();
  for (const f of LEAD_FIELDS) {
    const wanted = [norm(f.header), norm(f.label), f.key.toLowerCase(), ...f.aliases];
    const i = keys.findIndex((k, idx) => k && !used.has(idx) && wanted.includes(k));
    if (i >= 0) { columns[f.key] = i; used.add(i); }
  }
  const first = keys.findIndex((k, i) => !used.has(i) && FIRST.includes(k)), last = keys.findIndex((k, i) => !used.has(i) && LAST.includes(k));
  if (columns.name === undefined && first < 0 && last < 0) return { ok: false, message: "Couldn't find a name column. The first row must be column headings and include “name”. Download the template to see the columns Cold uses." };
  if (columns.name === undefined) { if (first >= 0) used.add(first); if (last >= 0) used.add(last); }
  return { ok: true, columns, ...(columns.name === undefined ? { first: first >= 0 ? first : undefined, last: last >= 0 ? last : undefined } : {}), ignored: headerCells.filter((h, i) => h.trim() && !used.has(i)).map(h => h.trim()) };
}

// ---- one lead ---------------------------------------------------------------------------------------------------------------
const str = v => (typeof v === "string" ? v : v == null ? "" : String(v));
const GOAL_BY_LABEL = Object.fromEntries(Object.entries(GOALS).flatMap(([k, g]) => [[norm(k), k], [norm(g.label), k]]));
/** "Advice" / "customer conversation" / "Investment" -> the goal key, or "" if it isn't one of Cold's goals. */
export const goalKey = v => GOAL_BY_LABEL[norm(v)] || "";

export const isEmail = mailto.isEmail;
/** A LinkedIn or X link in its canonical form, else null. Accepts links without https://. */
export const canonicalProfile = v => { const p = profile.parseProfileUrl(String(v || "").trim()); return p ? p.url : null; };

/** Tolerant reader for a saved lead: never throws, keeps fields it doesn't know. Returns null when there is no usable id. */
export function normalizeLead(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = str(raw.id).trim();
  if (!id) return null;
  return { ...raw, id, name: str(raw.name), company: str(raw.company), role: str(raw.role), email: str(raw.email), profileUrl: str(raw.profileUrl), why: str(raw.why),
    product: str(raw.product), goal: GOALS[raw.goal] ? raw.goal : "", list: str(raw.list), notes: str(raw.notes), source: str(raw.source) || "manual",
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : index };
}

/** What identifies "the same person": their email, else their profile link, else name + company. */
export function leadKey(l) {
  const email = str(l.email).trim().toLowerCase();
  if (email) return `e:${email}`;
  const url = canonicalProfile(l.profileUrl);
  if (url) return `u:${url.toLowerCase()}`;
  return `n:${norm(l.name)}|${norm(l.company)}`;
}

/** Problems with one lead as typed (not an import row). `errors` block saving; `warnings` don't. */
export function checkLead(l) {
  const errors = [], warnings = [];
  if (!str(l.name).trim()) errors.push("Name is required.");
  for (const [k, max] of Object.entries(LIMITS)) if (str(l[k]).length > max) errors.push(`${LEAD_FIELDS.find(f => f.key === k).label} is too long (over ${max} characters).`);
  if (str(l.email).trim() && !isEmail(l.email)) warnings.push("The email address doesn't look valid. Open in email will ask you to fix it.");
  if (str(l.profileUrl).trim() && !canonicalProfile(l.profileUrl)) warnings.push("The profile link isn't a LinkedIn or X profile, so Cold can't read it.");
  return { errors, warnings };
}

/** The cells of one CSV row as a lead (not yet saved), plus what was wrong with it. */
export function rowToLead(cells, map) {
  const cell = i => (i === undefined ? "" : refuse(str(cells[i]).replace(/\u0000/g, "").trim()));
  const lead = {};
  for (const f of LEAD_FIELDS) lead[f.key] = cell(map.columns[f.key]);
  if (map.columns.name === undefined) lead.name = [cell(map.first), cell(map.last)].filter(Boolean).join(" ");
  const notes = [];
  const g = lead.goal;
  if (g) { const k = goalKey(g); if (k) lead.goal = k; else { notes.push(`Goal “${g}” isn't one of Cold's goals (advice, investment, introduction, customer, partnership, other), so it was left blank.`); lead.goal = ""; } }
  const url = lead.profileUrl && canonicalProfile(lead.profileUrl); if (url) lead.profileUrl = url;
  const { errors, warnings } = checkLead(lead);
  return { lead, errors, warnings: [...notes, ...warnings] };
}

// ---- planning an import ----------------------------------------------------------------------------------------------------
/**
 * Decide, without saving anything, what importing this CSV would do against the leads you already have.
 * @param {string} text   the CSV
 * @param {object[]} existing  current leads
 * @param {{ duplicates?: "skip" | "update", list?: string, now?: number }} opts
 *   `duplicates`: for a person already in your leads: leave them as they are ("skip", the default) or fill in blank fields from the file ("update").
 *   `list`: a list name for rows that don't have their own.
 * @returns {{ ok: false, message: string } | { ok: true, total: number, adds: object[], updates: { existing: object, next: object, changed: string[] }[], unchanged: number,
 *   duplicates: object[], examples: object[], invalid: { line: number, name: string, reasons: string[] }[], warnings: { line: number, name: string, messages: string[] }[], ignored: string[], delimiter: string }}
 */
export function planImport(text, existing = [], { duplicates = "skip", list = "", now = Date.now() } = {}) {
  if (String(text || "").length > MAX_IMPORT_BYTES) return { ok: false, message: `That file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB. Split it into smaller files.` };
  const parsed = parseCsv(text);
  if (!parsed.ok) return parsed;
  if (parsed.rows.length < 2) return { ok: false, message: parsed.rows.length ? "The file has column headings but no rows of leads." : "The file is empty." };
  const map = mapHeaders(parsed.rows[0].cells);
  if (!map.ok) return map;
  const body = parsed.rows.slice(1);
  if (body.length > MAX_IMPORT_ROWS) return { ok: false, message: `That file has ${body.length} rows. Import up to ${MAX_IMPORT_ROWS} at a time; split it and import the parts.` };

  const byKey = new Map(existing.map(l => [leadKey(l), l]));
  const seen = new Map();   // people already planned from this file
  const out = { ok: true, total: body.length, adds: [], updates: [], unchanged: 0, duplicates: [], examples: [], invalid: [], warnings: [], ignored: map.ignored, delimiter: parsed.delimiter };
  for (const { line, cells } of body) {
    const { lead, errors, warnings } = rowToLead(cells, map);
    const name = lead.name || "(no name)";
    if (errors.length) { out.invalid.push({ line, name, reasons: errors }); continue; }
    if (TEMPLATE_EMAILS.has(lead.email.toLowerCase())) { out.examples.push({ line, name }); continue; }       // the template's own sample rows are never imported
    if (!lead.list && list) lead.list = list.trim();
    const key = leadKey(lead);
    if (seen.has(key)) { out.duplicates.push({ line, name, reason: "Appears earlier in this file." }); continue; }
    seen.set(key, true);
    const have = byKey.get(key);
    const warn = () => { if (warnings.length) out.warnings.push({ line, name, messages: warnings }); };   // only rows that will be imported
    // each row gets its own millisecond, so the list reads in the file's order everywhere (lists are ordered by when they were added)
    if (!have) { out.adds.push({ ...lead, id: uid("l"), source: "csv", createdAt: now + out.adds.length, updatedAt: now }); warn(); continue; }
    if (duplicates !== "update") { out.duplicates.push({ line, name, reason: "Already in your leads." }); continue; }
    const changed = LEAD_FIELDS.map(f => f.key).filter(k => lead[k] && lead[k] !== have[k]);
    if (!changed.length) { out.unchanged++; continue; }
    out.updates.push({ existing: have, next: { ...have, ...Object.fromEntries(changed.map(k => [k, lead[k]])), updatedAt: now }, changed }); warn();
  }
  return out;
}

/** The Outreach status of a lead, from the drafts written to them: the furthest one reached, or "none". */
export function leadProgress(lead, emails) {
  let best = "none";
  for (const e of emails) {
    if (!e || !e.recipient || e.recipient.leadId !== lead.id) continue;
    const s = e.status === "replied" ? "replied" : e.status === "sent" ? "sent" : "draft";
    if (s === "replied" || (s === "sent" && best !== "replied") || (s === "draft" && best === "none")) best = s;
  }
  return best;
}

/** Filter + sort for the table. */
export function filterLeads(leads, { query = "", list = "all", progress = "all", emails = [] } = {}) {
  const q = query.trim().toLowerCase();
  return leads.filter(l => (list === "all" || (list === "" ? !l.list : l.list === list)) && (progress === "all" || leadProgress(l, emails) === progress)
    && (!q || [l.name, l.company, l.role, l.email, l.why, l.list, l.notes, l.profileUrl].join(" ").toLowerCase().includes(q)));
}
