// Deterministic grounding checks. These compare the draft's WORDS with the text the user supplied.
// They cannot judge meaning, so nothing here is ever called "verified": results are "matches your text" / "needs review".
// Known limits: the first word of each sentence is not checked as a name (capitalisation can't separate names from ordinary words),
// lower-case names and spelled-out numbers are not checked, and a word match does not prove the statement means the same thing.
import { externalProof, internalProof } from "./knowledge.js";

const STOP = new Set("the a an and or but of to in on for with at by from as is are was were be been it its this that these those we our you your they their i me my us not no so if then than too very can could would should will just about into over out up down more most some any each other such only own same also how what when where which who whom why all both few many much one two three".split(" "));
const NAME_OK = new Set(["I", "I'm", "I've", "I'd", "I'll", "Could", "Would", "Should", "Can", "Do", "Does", "Is", "Are", "Will", "If", "We", "We've", "We're", "Our", "You", "You've", "You're", "Your", "The", "A", "An", "This", "That", "And", "But", "Or", "Not", "How", "What", "Why", "When", "Where", "Who", "Hi", "Hello", "Thanks", "Thank"]);

const norm = s => String(s || "").toLowerCase().replace(/[’‘]/g, "'");
const stem = w => w.replace(/(ing|ed|es|s)$/, "");
const wordsOf = s => (norm(s).match(/[a-z0-9][a-z0-9'-]*/g) || []);
const contentWords = s => wordsOf(s).filter(w => w.length > 3 && !STOP.has(w)).map(stem);
const numbersOf = s => (String(s || "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map(n => n.replace(/,/g, "").replace(/\.0+$/, ""));

function corpusFor({ product, recipient = {}, convey = "" }) {
  const p = product || {};
  const parts = [p.name, p.oneLiner, p.category, p.status, p.what, p.who, p.problem, p.shortDesc, p.longDesc,
    ...(p.techFacts || []), ...(p.approved || []),
    ...externalProof(p).flatMap(x => [x.claim, x.evidence]),
    recipient.name, recipient.role, recipient.company, recipient.why, convey];
  const text = parts.filter(Boolean).join("\n");
  return { text, lower: norm(text), words: new Set(wordsOf(text)), numbers: new Set(numbersOf(text)) };
}

/** Capitalised words that are not sentence-initial, plus ALL-CAPS tokens: likely names of people, companies, products. */
function nameCandidates(sentences) {
  const out = new Set();
  for (const s of sentences) {
    const toks = String(s || "").match(/[A-Za-z][A-Za-z0-9'’.-]*/g) || [];
    toks.forEach((t, i) => {
      const clean = t.replace(/[.’']+$/g, "").replace(/['’]s$/, "");
      if (clean.length < 2 || NAME_OK.has(clean)) return;
      const caps = /^[A-Z][a-z0-9]/.test(clean) || /^[A-Z]{2,}$/.test(clean) || /^[A-Z][a-z]+[A-Z]/.test(clean);
      if (caps && (i > 0 || /^[A-Z]{2,}$/.test(clean) || /^[A-Z][a-z]+[A-Z]/.test(clean))) out.add(clean);
    });
  }
  return [...out];
}

function fiveGrams(text) {
  const w = wordsOf(text), out = new Set();
  for (let i = 0; i + 5 <= w.length; i++) out.add(w.slice(i, i + 5).join(" "));
  return out;
}

/**
 * @param {{subject?:string,what?:string,why?:string,ask?:string}} draft
 * @param {{product?:object,recipient?:object,convey?:string,claims?:Array<{text:string,source:string}>,facts?:Record<string,string>}} ctx
 * @returns {{flags:Array<{type:string,text:string,message:string}>, claims:Array<{text:string,source:string,status:"matches"|"mismatch"|"no_record",detail:string}>, clean:boolean}}
 */
export function checkGrounding(draft, ctx) {
  const c = corpusFor(ctx);
  const lines = [draft.subject, draft.what, draft.why, draft.ask];
  const body = lines.join(" ");
  const flags = [];

  const seenNum = new Set();
  for (const n of numbersOf(body)) {
    if (seenNum.has(n)) continue; seenNum.add(n);
    if (!c.numbers.has(n)) flags.push({ type: "number", text: n, message: `The number “${n}” does not appear in what you gave Cold.` });
  }
  for (const name of nameCandidates([draft.what, draft.why, draft.ask])) {
    const key = norm(name);
    if (!c.words.has(key) && !c.lower.includes(key)) flags.push({ type: "name", text: name, message: `“${name}” does not appear in what you gave Cold. If it is a name, product or customer, confirm it is real.` });
  }

  // Internal-only proof must not surface in the draft.
  const draftGrams = fiveGrams(body), draftNums = new Set(numbersOf(body));
  for (const x of internalProof(ctx.product)) {
    const t = `${x.claim} ${x.evidence || ""}`;
    const shared = [...fiveGrams(t)].some(g => draftGrams.has(g));
    const internalNums = numbersOf(t).filter(n => !c.numbers.has(n) && draftNums.has(n));
    if (shared || internalNums.length) flags.push({ type: "internal", text: x.claim, message: `This draft appears to reuse an internal-only proof item (“${x.claim.slice(0, 60)}”). It is not approved for external use.` });
  }

  const facts = ctx.facts || {};
  const claims = (ctx.claims || []).filter(x => x && x.text).map(x => {
    const source = String(x.source || "");
    const ref = facts[source] ?? (source === "RECIPIENT" ? ctx.recipient?.why : source === "CONVEY" ? ctx.convey : undefined);
    if (!ref) return { text: x.text, source, status: "no_record", detail: "The model cited a record that does not exist in your knowledge." };
    const cw = [...new Set(contentWords(x.text))];
    const rw = new Set(contentWords(ref));
    const hit = cw.filter(w => rw.has(w)).length;
    const nums = numbersOf(x.text), numsOk = nums.every(n => numbersOf(ref).includes(n));
    const ok = numsOk && (cw.length === 0 || hit / cw.length >= 0.6);
    return ok
      ? { text: x.text, source, status: "matches", detail: "Wording overlaps with the cited record. This is a word match, not a check of meaning." }
      : { text: x.text, source, status: "mismatch", detail: "The wording does not match the cited record. Check this claim before sending." };
  });

  return { flags, claims, clean: flags.length === 0 && claims.every(x => x.status === "matches") };
}
