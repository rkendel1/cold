// Product knowledge: readiness, the prompt text built from it, and tolerant normalisation of saved data.
import { PROOF_TYPES } from "./constants.js";

const str = v => (typeof v === "string" ? v : v == null ? "" : String(v));
const strList = v => (Array.isArray(v) ? v.map(str).map(s => s.trim()).filter(Boolean) : []);

/** "@acme", "acme", "x.com/acme" or "https://twitter.com/acme" -> "@acme"; anything else -> "". */
export function normalizeHandle(v) {
  const m = str(v).trim().match(/^(?:https?:\/\/)?(?:(?:www\.|mobile\.)?(?:x|twitter)\.com\/)?@?([A-Za-z0-9_]{1,15})\/?$/i);
  return m ? `@${m[1]}` : "";
}

/** The product's public links as [label, value] pairs: X handle, website, repository, then any "Label: url" lines. */
export function productLinks(p) {
  const out = [];
  const h = normalizeHandle(p?.xHandle); if (h) out.push(["X handle", h]);
  if (str(p?.website).trim()) out.push(["Website", str(p.website).trim()]);
  if (str(p?.repo).trim()) out.push(["Repository", str(p.repo).trim()]);
  for (const line of strList(p?.socials)) {
    const m = line.match(/^([^:]{1,30}):\s*(\S.*)$/);
    out.push(m && !/^https?$/i.test(m[1]) ? [m[1].trim(), m[2].trim()] : ["Link", line]);
  }
  return out;
}

export function externalProof(p) { return (p?.proof || []).filter(x => x && x.external && x.claim); }
export function internalProof(p) { return (p?.proof || []).filter(x => x && !x.external && x.claim); }

/**
 * What a draft needs from the product. `blocking` items stop generation (Cold writes only from recorded facts);
 * `advised` items make the draft better or safer. Every item has a field id so the UI can link to it.
 */
export function readiness(p) {
  const items = [];
  const add = (level, id, label, why, done) => items.push({ level, id, label, why, done });
  add("blocking", "kName", "Product name", "Named in the draft and the history.", !!str(p?.name).trim());
  add("blocking", "kWhat", "What it does", "Sentence 1 of every email is built from this.", !!str(p?.what).trim());
  add("advised", "kWho", "Who it's for", "Lets the draft say why it fits this person.", !!str(p?.who).trim());
  add("advised", "kProblem", "Problem it solves", "Gives sentence 2 something real to build on.", !!str(p?.problem).trim());
  add("advised", "kAddProof", "One proof point approved for external use", "Without it the draft makes no proof claim at all.", externalProof(p).length > 0);
  const weakProof = externalProof(p).filter(x => !str(x.evidence).trim());
  if (weakProof.length) add("advised", "kProof", "Evidence for approved proof", "Proof without evidence is stated modestly.", false);
  add("advised", "kDont", "Do-not-say rules", 'Put exact phrases in "quotes" and Cold checks for them automatically.', strList(p?.dontSay).length > 0);
  const blocking = items.filter(i => i.level === "blocking" && !i.done);
  const advised = items.filter(i => i.level === "advised" && !i.done);
  return { items, blocking, advised, ready: blocking.length === 0 };
}

/** Prompt text for the model. Only externally approved proof is included; internal-only items are not mentioned at all. */
export function buildKnowledge(p) {
  const facts = {}, L = [];
  L.push(`PRODUCT: ${p.name}`);
  if (p.oneLiner) L.push(`One line: ${p.oneLiner}`);
  if (p.category) L.push(`Category: ${p.category}`);
  if (p.status) L.push(`Status: ${p.status}`);
  if (p.what) { L.push(`[WHAT] What it does: ${p.what}`); facts.WHAT = p.what; }
  if (p.who) { L.push(`[WHO] Who it's for: ${p.who}`); facts.WHO = p.who; }
  if (p.problem) { L.push(`[PROBLEM] Problem it solves: ${p.problem}`); facts.PROBLEM = p.problem; }
  if (p.shortDesc) L.push(`Short description: ${p.shortDesc}`);
  if (p.longDesc) L.push(`Long description: ${String(p.longDesc).slice(0, 2500)}`);
  const ext = externalProof(p);
  const rank = t => { const i = PROOF_TYPES.indexOf(t); return i < 0 ? 9 : i; };
  if (ext.length) {
    L.push("PROOF (allowed externally; use at most one):");
    ext.forEach((x, i) => {
      const id = "P" + (i + 1); facts[id] = x.claim;
      L.push(`[${id}] ${x.type || "Technical"} · strength ${x.strength || "Medium"} (type rank ${rank(x.type) + 1}) — Claim: ${x.claim} — Evidence: ${x.evidence ? x.evidence : "none recorded, so state the claim modestly"}`);
    });
  } else L.push("PROOF: none allowed externally. Use no proof point.");
  (p.techFacts || []).filter(Boolean).forEach((t, i) => { const id = "T" + (i + 1); facts[id] = t; if (i === 0) L.push("TECHNICAL FACTS:"); L.push(`[${id}] ${t}`); });
  (p.approved || []).filter(Boolean).forEach((t, i) => { const id = "A" + (i + 1); facts[id] = t; if (i === 0) L.push("APPROVED LANGUAGE (preferred phrasings):"); L.push(`[${id}] ${t}`); });
  const ds = (p.dontSay || []).filter(Boolean);
  L.push("DO NOT SAY:"); ds.length ? ds.forEach(t => L.push(`- ${t}`)) : L.push("- (none recorded)");
  L.push("- Don't claim production customers, revenue, users or partners unless a PROOF item states them.");
  // Public links are kept apart from `text` so email prompts are unchanged; only tweets use them.
  const links = productLinks(p).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  return { text: L.join("\n"), facts, links };
}

/** Coerce one saved product into the documented shape without losing unknown fields. Returns null if unusable. */
export function normalizeProduct(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = str(raw.id).trim();
  if (!id) return null;
  return {
    ...raw, id,
    name: str(raw.name), oneLiner: str(raw.oneLiner), category: str(raw.category), status: str(raw.status),
    website: str(raw.website), repo: str(raw.repo), xHandle: normalizeHandle(raw.xHandle), socials: strList(raw.socials), what: str(raw.what), who: str(raw.who), problem: str(raw.problem),
    shortDesc: str(raw.shortDesc), longDesc: str(raw.longDesc),
    order: Number.isFinite(raw.order) ? raw.order : index,
    techFacts: strList(raw.techFacts), approved: strList(raw.approved), dontSay: strList(raw.dontSay),
    proof: (Array.isArray(raw.proof) ? raw.proof : []).filter(x => x && typeof x === "object").map((x, i) => ({
      id: str(x.id) || `pr_${index}_${i}`, claim: str(x.claim), evidence: str(x.evidence),
      type: PROOF_TYPES.includes(x.type) ? x.type : "Technical",
      strength: ["High", "Medium", "Low"].includes(x.strength) ? x.strength : "Medium",
      external: x.external === true,
    })),
  };
}
