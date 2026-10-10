// Generation pipelines. `sample` is any function with the shape of api.sample (including `.json`),
// so the provider/transport stays behind that boundary and these functions stay testable without a network.
import { buildKnowledge } from "../domain/knowledge.js";
import { draftPrompt, editorPrompt, tweetPrompt } from "../domain/prompts.js";
import { evaluate } from "../domain/rules.js";
import { uid } from "../domain/ids.js";

/** Turn a thrown error into { message, retryable } copy a founder can act on. */
export function describeError(e) {
  switch (e && e.code) {
    case "cancelled": return null;
    case "not_granted": return { message: "Claude access was declined for this page. Reload and allow it, then try again.", retryable: false };
    case "sampling_disabled": return { message: "Claude isn't available on this account.", retryable: false };
    case "rate_limited": return { message: (e.message && !/^The server returned/.test(e.message)) ? e.message : "Too many requests right now. Wait a minute, then try again.", retryable: true };
    case "session_expired": return { message: "Sign in to Claude again, then try again.", retryable: true };
    case "invalid_json": return { message: "The reply came back in an unexpected shape. Your inputs are kept; try again.", retryable: true };
    case "refused": return { message: "The model declined this request. Adjust the inputs and try again.", retryable: false };
    case "prompt_too_large": return { message: "This product's knowledge is too long. Shorten the long description in Knowledge and try again.", retryable: false };
    case "access_required": return { message: "This server needs an access code. Enter it under “Connection” below the form, then try again.", retryable: false };
    case "network": return { message: "Couldn't reach the Cold server. Check that it is running and your connection, then try again.", retryable: true };
    case "api_error": return { message: `${e.message || "The AI provider returned an error."} Your inputs are kept; try again.`, retryable: true };
    default: return { message: "Generation stopped partway. Your inputs are kept; try again.", retryable: true };
  }
}

const trim = v => String(v || "").trim();

function emailRecord({ id, createdAt, status, form, product, fin, draft, ed, prev }) {
  const rec = {
    id, createdAt, status,
    recipient: { name: form.name, role: form.role, company: form.company, why: form.why },
    productId: product.id, productName: product.name, goal: form.goal, goalOther: form.goalOther || "", convey: form.convey || "",
    subject: trim(fin.subject), what: trim(fin.what), why: trim(fin.why), ask: trim(fin.ask),
    relevance: prev ? prev.relevance : (draft.relevance || null),
    retrieved: prev ? prev.retrieved : (Array.isArray(draft.retrieved) ? draft.retrieved.slice(0, 8) : []),
    proofId: ed.proof_id || draft.proof_id || null,
    facts: buildKnowledge(product).facts,
    claims: Array.isArray(ed.claims) ? ed.claims.slice(0, 10) : [],
    checks: Array.isArray(ed.checks) ? ed.checks : [],
    draftFailures: Array.isArray(ed.draft_failures) ? ed.draft_failures.slice(0, 12) : [],
    couldImprove: ed.could_improve || "",
    draft: prev ? prev.draft : { subject: draft.subject, what: draft.what, why: draft.why, ask: draft.ask },
    edited: false, versions: (prev ? (prev.versions || 1) : 0) + 1,
  };
  if (prev && prev.sentAt) rec.sentAt = prev.sentAt;
  if (prev && prev.repliedAt) rec.repliedAt = prev.repliedAt;
  rec.score = evaluate(rec, product).score;
  return rec;
}

/** Two model calls: draft, then editor pass. Returns the record; never mutates inputs. */
export async function generateEmail({ sample, product, form, signal, onStep = () => {} }) {
  const k = buildKnowledge(product);
  onStep(2);
  const draft = await sample.json(draftPrompt(k, form), { signal, cache: false });
  if (!draft || !draft.what) throw { code: "invalid_json" };
  onStep(3);
  const ed = await sample.json(editorPrompt(k, form, draft, ""), { signal, cache: false });
  const fin = ed && ed.final && ed.final.what ? ed.final : draft;
  onStep(4);
  return emailRecord({ id: uid("e"), createdAt: Date.now(), status: "draft", form, product, fin, draft, ed: ed || {}, prev: null });
}

/** Re-runs the editor on the CURRENT text (including the user's edits) with a user-supplied focus. */
export async function improveEmail({ sample, product, current, focus, signal, onStep = () => {} }) {
  const form = { ...current.recipient, productId: current.productId, goal: current.goal, goalOther: current.goalOther, convey: current.convey };
  const k = buildKnowledge(product);
  const draft = { subject: current.subject, what: current.what, why: current.why, ask: current.ask };
  onStep(3);
  const ed = await sample.json(editorPrompt(k, form, draft, focus), { signal, cache: false });
  const fin = ed && ed.final && ed.final.what ? ed.final : draft;
  onStep(4);
  return emailRecord({ id: current.id, createdAt: current.createdAt, status: current.status || "draft", form, product, fin, draft, ed: ed || {}, prev: current });
}

export async function generateTweet({ sample, product, form, tweetLength, signal }) {
  const prompt = tweetPrompt(form, product ? buildKnowledge(product).text : "None");
  let result = await sample.json(prompt, { signal, cache: false });
  let text = trim(result?.text);
  if (!tweetLength(text).valid) {
    result = await sample.json(`${prompt}\nShorten this draft to fit 280 weighted characters: ${text}`, { signal, cache: false });
    text = trim(result?.text);
  }
  if (!text || !tweetLength(text).valid) throw { code: "api_error", message: "The model did not produce a valid tweet within 280 characters." };
  return {
    id: uid("e"), createdAt: Date.now(), status: "draft", mode: form.mode, tweetUrl: form.tweetUrl, tweetContext: form.tweetContext,
    recipient: { name: form.mode === "reply" ? "Tweet reply" : "Original tweet", role: "", company: "", why: form.tweetContext },
    productId: product?.id || "", productName: product?.name || "", goal: form.goal, convey: form.convey,
    subject: form.mode === "reply" ? "Tweet reply" : "Original tweet", what: text, why: "", ask: "",
  };
}
