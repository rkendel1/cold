// Import product knowledge: how suggestions from a repository meet the existing product, without ever overwriting it.
//
// Everything here is pure. A suggestion changes the product only when the person chooses it (accept, edit, or replace), and
// nothing imported becomes approved for external use unless that same person asks for it on a verified claim. Where a suggestion
// came from is kept as provenance next to the product, separate from the prose the person ends up with.
import { normalizeHandle } from "./knowledge.js";
import { uid } from "./ids.js";
import repoFilter from "../../lib/repo-filter.cjs";

const str = v => (typeof v === "string" ? v : v == null ? "" : String(v));
export const norm = v => str(v).replace(/\s+/g, " ").trim().toLowerCase();

/** Suggestion field -> product field, for one-value fields. */
export const SCALARS = { name: "name", oneLiner: "oneLiner", what: "what", who: "who", problem: "problem", longDesc: "longDesc", website: "website", repo: "repo", xHandle: "xHandle" };
/** Suggestion field -> product field, for one-per-line lists. */
export const LISTS = { techFact: "techFacts", approved: "approved", dontSay: "dontSay", social: "socials" };

export const FIELD_LABELS = {
  name: "Product name", oneLiner: "One-line description", what: "What it does", who: "Who it's for", problem: "Problem it solves", longDesc: "Long description",
  website: "Website", repo: "Repository", xHandle: "X handle", techFact: "Technical fact", approved: "Approved language", dontSay: "Prohibited phrase", social: "Link", proof: "Proof",
};
export const STATUS_LABELS = { verified: "Verified", inferred: "Inferred", needs_evidence: "Needs evidence", not_found: "Not found" };
export const STATUS_HELP = {
  verified: "An excerpt in the code, a test, an example or a manifest backs this. Check it says what the wording says.",
  inferred: "A reasonable reading, or documentation only. Confirm it before using it.",
  needs_evidence: "Potentially useful, but nothing in the repository supports it yet.",
  not_found: "Cold couldn't determine this from the project.",
};

const same = (field, a, b) => (field === "xHandle" ? normalizeHandle(a) === normalizeHandle(b) : norm(a) === norm(b));

/** Which product value does this suggestion line up with? */
function currentFor(product, s) {
  if (SCALARS[s.field]) return str(product[SCALARS[s.field]]);
  return "";
}

/**
 * Lay the suggestions against the existing product.
 *  mode "fill"     the field is empty: the suggestion would fill it
 *  mode "replace"  the field has the person's own text: the suggestion would replace it (only on request)
 *  mode "add"      a list entry or proof row that isn't there yet
 * Suggestions the product already contains are counted, not shown.
 */
export function planReview(product, result) {
  const items = []; let present = 0;
  for (const s of (result && result.suggestions) || []) {
    if (SCALARS[s.field]) {
      const cur = currentFor(product, s);
      if (cur && same(s.field, cur, s.text)) { present++; continue; }
      items.push({ ...s, mode: cur.trim() ? "replace" : "fill", current: cur });
    } else if (LISTS[s.field]) {
      const lines = (product[LISTS[s.field]] || []).map(norm);
      if (lines.includes(norm(s.text))) { present++; continue; }
      items.push({ ...s, mode: "add", current: "" });
    } else if (s.field === "proof") {
      if ((product.proof || []).some(r => norm(r.claim) === norm(s.text))) { present++; continue; }
      items.push({ ...s, mode: "add", current: "" });
    }
  }
  const empty = f => !str(product[f]).trim();
  const notFound = ((result && result.notFound) || []).filter(n => !SCALARS[n.field] || empty(SCALARS[n.field]));
  return { items, present, notFound };
}

export const recordKey = (field, text) => `${field}|${norm(text)}`;

const keepEvidence = evs => (Array.isArray(evs) ? evs : []).slice(0, 3).map(e => ({ path: str(e.path), kind: str(e.kind), start: e.start | 0, end: e.end | 0, excerpt: str(e.excerpt).slice(0, 300), hash: str(e.hash), url: str(e.url) }));

/** Add (or replace) the provenance record for something the person accepted. Returns a new list. */
export function addRecord(records, item, text, { proofId = "" } = {}) {
  const key = recordKey(item.field, text);
  const rec = { key, field: item.field, text: str(text).trim(), status: item.status, basis: str(item.basis), evidence: keepEvidence(item.evidence), commit: str(item.source && item.source.commit), extractedAt: str(item.source && item.source.extractedAt), ...(proofId ? { proofId } : {}) };
  return [...(records || []).filter(r => r.key !== key), rec].slice(-120);
}

/**
 * Accept a suggestion into the product through an adapter that reads and writes the editor's fields.
 *   adapter = { get(field), set(field, value), addLine(listField, text), addProof(row) -> row }
 * `edits.text` is the (possibly edited) wording; `edits.evidence` the proof's evidence text; `edits.approve` asks for external use.
 * Returns { records, note }. Throws if asked to approve something that isn't a verified proof point.
 */
export function applySuggestion(adapter, records, item, edits = {}) {
  const text = str(edits.text != null ? edits.text : item.text).trim();
  if (!text) throw new Error("Nothing to add.");
  if (item.field === "proof") {
    if (edits.approve && (item.status !== "verified" || !item.proof)) throw new Error("Only a verified proof point can be approved from an import.");
    const p = item.proof || { type: "Technical", strength: "Low", evidence: "" };
    const row = adapter.addProof({ id: uid("pr"), claim: text, evidence: str(edits.evidence != null ? edits.evidence : p.evidence).trim(), type: p.type, strength: p.strength, external: edits.approve === true });
    return { records: addRecord(records, item, text, { proofId: row.id }), note: edits.approve ? "Added and approved for external use." : "Added as internal-only. Approve it under Proof when you're ready." };
  }
  if (SCALARS[item.field]) { adapter.set(SCALARS[item.field], item.field === "xHandle" ? normalizeHandle(text) || text : text); return { records: addRecord(records, item, text), note: item.mode === "replace" ? "Replaced." : "Added." }; }
  if (LISTS[item.field]) { adapter.addLine(LISTS[item.field], text); return { records: addRecord(records, item, text), note: "Added." }; }
  throw new Error("Unknown suggestion.");
}

/** Everything a refresh found about earlier imports: still-true pointers are updated; changed or missing evidence is returned for review. */
export function planRefresh(product, result) {
  const by = new Map(((result && result.changes) || []).map(c => [c.key, c]));
  const records = [], flagged = [];
  for (const r of product.provenance || []) {
    const c = by.get(r.key);
    if (!c) { records.push(r); continue; }
    if (c.state === "current") { records.push({ ...r, evidence: keepEvidence(c.evidence.length ? c.evidence : r.evidence), commit: str(result.source && result.source.commit), extractedAt: str(result.source && result.source.extractedAt) }); continue; }
    records.push(r);
    const list = LISTS[r.field] ? (product[LISTS[r.field]] || []).map(norm) : [];
    const row = r.field === "proof" ? (product.proof || []).find(x => x.id === r.proofId || norm(x.claim) === norm(r.text)) : null;
    const scalar = SCALARS[r.field] ? norm(product[SCALARS[r.field]]) : "";
    const stillThere = r.field === "proof" ? !!row : LISTS[r.field] ? list.includes(norm(r.text)) : scalar === norm(r.text);
    if (stillThere) flagged.push({ record: r, state: c.state, reason: c.reason, approved: !!(row && row.external), proofId: row ? row.id : "" });
  }
  return { records, flagged };
}

/** The product's source record after an import or refresh. */
export function sourceOf(result) {
  const s = (result && result.source) || {};
  return { host: str(s.host), owner: str(s.owner), repo: str(s.repo), url: str(s.url), ref: str(s.ref), commit: str(s.commit), importedAt: str(s.extractedAt) };
}

export const evidenceLabel = e => `${e.path}${e.end > e.start ? `:${e.start}-${e.end}` : e.start ? `:${e.start}` : ""}`;

/**
 * Which files of a folder chosen on this computer to read, before reading any of them. `files` are { path, size } with the path
 * relative to the chosen folder's parent ("project/src/a.js", as the browser reports it). Applies the server's own filters so
 * node_modules and the like are never read, keeps shallow files (README, manifests, docs) first, and stops at the size and count
 * caps. Returns { name, picked, skipped, capped }.
 */
export function pickFolderFiles(files) {
  const list = [...(files || [])].map(f => ({ ...f, path: str(f.path).replace(/\\/g, "/") })).filter(f => f.path);
  const name = list.length ? list[0].path.split("/")[0] : "";
  const inner = f => (name && f.path.startsWith(`${name}/`) ? f.path.slice(name.length + 1) : f.path);
  const ok = list.filter(f => repoFilter.keep(inner(f), Number(f.size) || 0));
  ok.sort((a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : 1));
  const picked = []; let total = 0, capped = false;
  for (const f of ok) {
    if (picked.length >= repoFilter.MAX_FILES || total + (Number(f.size) || 0) > repoFilter.MAX_ARCHIVE) { capped = true; break; }
    picked.push(f); total += Number(f.size) || 0;
  }
  return { name, picked, skipped: list.length - ok.length, capped };
}
