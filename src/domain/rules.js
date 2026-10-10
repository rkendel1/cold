// Local rule engine. Pure functions: no DOM, no storage.
import { RULES, MARKETING, OPENERS, MEETING, BAD_SUBJECT } from "./constants.js";

export const words = t => (String(t || "").trim().match(/\S+/g) || []).length;

export function sentenceCount(t) {
  t = String(t || "").trim(); if (!t) return 0;
  t = t.replace(/\b(e\.g|i\.e|etc|vs|Mr|Ms|Mrs|Dr|Inc|Co|Ltd|St)\./gi, "$1").replace(/(\d)\.(\d)/g, "$1$2").replace(/\.(com|io|ai|dev|org|net)\b/gi, "$1");
  const m = t.match(/[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g);
  return m ? m.filter(s => s.trim().length > 1).length : 0;
}

/** Phrases in "double quotes" or word/word pairs inside do-not-say rules become automatic checks. */
export function dontSayTerms(list) {
  const out = [];
  (list || []).forEach(r => {
    (String(r).match(/["“]([^"”]{2,60})["”]/g) || []).forEach(q => out.push(q.slice(1, -1)));
    (String(r).match(/\b[A-Za-z]{1,8}\/[A-Za-z]{1,8}\b/g) || []).forEach(x => out.push(x));
  });
  return [...new Set(out.map(s => s.toLowerCase()))];
}

export function localChecks(e, product) {
  const body = [e.what, e.why, e.ask].join(" "), low = body.toLowerCase();
  const wc = words(body), secs = Math.round(wc / 238 * 60);
  const r = {};
  const sc = [e.what, e.why, e.ask].map(sentenceCount);
  const total = sc.reduce((a, b) => a + b, 0);
  r[4] = total === 3 && sc.every(n => n === 1) ? { pass: true } : { pass: false, note: `Body has ${total} sentence${total === 1 ? "" : "s"}; each line should be one sentence.` };
  r[5] = wc >= 40 && wc <= 80 ? { pass: true } : { pass: false, note: wc < 40 ? `${wc} words. A little thin; make sure it's still clear.` : `${wc} words. Cut to 80 or fewer.` };
  r[6] = secs <= 60 ? { pass: true } : { pass: false, note: `About ${secs} seconds to read.` };
  const op = OPENERS.find(re => re.test(String(e.what || "").slice(0, 90)));
  r[7] = op ? { pass: false, note: "Opens with a stock phrase. Start with what you do." } : { pass: true };
  const mk = MARKETING.filter(m => low.includes(m));
  r[9] = mk.length ? { pass: false, note: `Marketing phrasing: ${mk.map(m => `"${m}"`).join(", ")}` } : { pass: true };
  const ds = dontSayTerms(product?.dontSay).filter(t => low.includes(t) || String(e.subject || "").toLowerCase().includes(t));
  r[16] = ds.length ? { pass: false, note: `Uses a banned phrase: ${ds.map(t => `"${t}"`).join(", ")}` } : { pass: true };
  const ask = String(e.ask || "").trim();
  r[18] = /\?["”’)]*$/.test(ask) ? { pass: true } : { pass: false, note: "The ask isn't phrased as a question." };
  r[19] = MEETING.test(e.why + " " + e.ask) ? { pass: false, note: "Asks for a meeting, call or time. Let them pick the next step." } : { pass: true };
  const sw = words(e.subject);
  r[20] = !sw ? { pass: false, note: "Add a subject." } : sw > 6 ? { pass: false, note: `Subject is ${sw} words. Keep it to 6 or fewer.` } : BAD_SUBJECT.test(e.subject) ? { pass: false, note: "Subject reads like marketing." } : { pass: true };
  return { r, wc, secs, total };
}

/**
 * Style checklist for an email record. `source` marks who produced each row:
 * "cold" = computed here, "model" = the model's own report from the editor pass.
 */
export function evaluate(e, product) {
  const L = localChecks(e, product);
  const model = {};
  (e.checks || []).forEach(c => { if (c && c.rule) model[c.rule] = c; });
  const rows = RULES.map(rule => {
    let res, source = "cold";
    if (rule.kind === "local") res = L.r[rule.n];
    else if (rule.kind === "both") {
      const a = L.r[rule.n], b = model[rule.n];
      res = !a.pass ? a : (b && b.pass === false) ? { pass: false, note: b.note } : { pass: true };
      if (a.pass) source = "both";
    } else {
      const b = model[rule.n];
      res = b ? { pass: b.pass !== false, note: b.note } : { pass: null };
      source = "model";
    }
    return { ...rule, ...res, source };
  });
  let earned = 0, total = 0;
  rows.forEach(x => { total += x.w; if (x.pass !== false) earned += x.w; });
  return { rows, score: Math.round(100 * earned / total), wc: L.wc, secs: L.secs, sentences: L.total };
}

/** Checklist outcome wording. It reports the checklist only; it does not predict replies or say "ready". */
export const checklistVerdict = (score, failCount) =>
  failCount === 0 ? ["All checks passed", "good"] : score >= 70 ? ["Some checks failed", "warn"] : ["Several checks failed", "bad"];
