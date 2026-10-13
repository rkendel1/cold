// The only code that talks to treg (https://treg.to), and only for two operations: find a work email and verify one. It runs on the
// server (desktop app or a Cold server), never in a browser, because it holds the treg token. Nothing else may be called through it:
// there is no URL, operation or header a caller can choose.
const crypto = require("node:crypto");
const { buildFindRequest, normalizeDomain, isEmail } = require("./people-shared");

const BASE = "https://treg.to/call/";
const OPS = { find: "treg.people.email.find", verify: "treg.people.email.verify" };
const DEFAULT_MAX_COST = { find: 0.05, verify: 0.02 };   // USD per call; treg's own default is $1, which is far more than one email lookup needs
const TIMEOUT_MS = 70 * 1000;                              // treg answers 202 "pending" after 60 s; wait slightly longer than that
const PENDING_HOLD_MS = 15 * 60 * 1000;

const maxCost = (op, env = process.env) => {
  const n = Number(env.COLD_TREG_MAX_COST);
  return op === "find" && Number.isFinite(n) && n >= 0.001 && n <= 1 ? n : DEFAULT_MAX_COST[op];
};
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v, n = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const usd = micro => (num(micro) == null ? null : Math.round(micro) / 1e6);

/** Billable lookups in flight, or left pending by treg, so the same one is never started twice. */
const busy = new Map();   // key -> expiry (ms since epoch); 0 while a call is running
const keyOf = (op, body) => crypto.createHash("sha256").update(op + JSON.stringify(body)).digest("hex");

function failure(status, data) {
  const d = data && typeof data === "object" ? data : {};
  const detail = d.detail && typeof d.detail === "object" ? d.detail : {};
  if (status === 401 || status === 403) return { code: "auth", message: "treg didn't accept the saved token. Check it in Settings." };
  if (status === 402) return { code: "balance", message: "Your treg balance is too low for this lookup. Nothing was found or saved." };
  if (status === 422) return { code: "refused", message: "treg couldn't run this lookup with the information given. Nothing was charged." };
  if (status === 429) return { code: "rate_limited", message: "treg says there have been too many requests. Wait a minute and try again yourself." };
  if (status === 503 || detail.error === "provider_capacity_unavailable") return { code: "unavailable", message: "treg's providers are unavailable right now. Nothing was charged. Try again in a minute." };
  return { code: "treg_error", message: `treg returned an error (${status}). Nothing was saved.` };
}

/** Never lets the token into anything returned: it is only ever placed in the outgoing header. */
async function call(op, body, { token, fetchImpl = globalThis.fetch, env = process.env, now = Date.now } = {}) {
  if (!token) return { ok: false, code: "not_configured", message: "Email lookup isn't set up. Add a treg token in Settings (or set TREG_TOKEN on the server)." };
  const key = keyOf(op, body), until = busy.get(key);
  if (until !== undefined && (until === 0 || until > now())) return { ok: false, code: "in_progress", message: until === 0 ? "This lookup is already running." : "treg is still working on this lookup. Cold won't start another one: a second search could be billed again. Check back later." };
  busy.set(key, 0);
  let r, data = null, hold = false;
  try {
    r = await fetchImpl(BASE + OPS[op], { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-treg-token": token, "x-treg-route-max-cost": String(maxCost(op, env)) }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    data = await r.json().catch(() => null);
  } catch (e) {
    busy.delete(key);
    return { ok: false, code: "network", message: e && e.name === "TimeoutError" ? "treg didn't answer in time. Cold didn't retry, because a retry could be billed again." : "Couldn't reach treg. Nothing was saved." };
  }
  const meta = data && typeof data._treg === "object" && data._treg ? data._treg : {};
  try {
    if (r.status === 202 || meta.outcome === "pending") { hold = true; busy.set(key, now() + PENDING_HOLD_MS); return { ok: true, pending: true, message: "treg is still searching and will bill the lookup if it finds something. Cold won't start another search for this person meanwhile." }; }
    if (!r.ok) return { ok: false, ...failure(r.status, data) };
    return { ok: true, output: data && typeof data.output === "object" && data.output ? data.output : {}, meta };
  } finally { if (!hold) busy.delete(key); }
}

const cost = meta => ({ chargedUsd: usd(meta.charged_micro), servedBy: str(meta.served_by, 100), tried: Array.isArray(meta.tried) ? meta.tried.filter(x => typeof x === "string").slice(0, 30).map(x => x.slice(0, 100)) : [] });

/**
 * Find a work email. A returned address is a CANDIDATE: treg's own words are kept as it gave them (confidence, "the provider says it
 * checked the mailbox"), and anything it didn't say stays null. The raw provider payload is not passed on.
 */
async function findEmail(input, opts) {
  const req = buildFindRequest({ name: input && input.name, profileUrl: input && input.linkedin, domain: input && input.domain });
  if (!req.ok) return { ok: false, code: "insufficient", message: req.message };
  const res = await call("find", req.body, opts);
  if (!res.ok || res.pending) return res;
  const o = res.output, email = str(o.email, 254);
  const c = cost(res.meta);
  if (!email) return { ok: true, candidates: [], ...c, message: "treg found no email for this person. Nothing was saved." };
  if (!isEmail(email)) return { ok: false, code: "bad_result", message: "treg returned something that isn't an email address. It was discarded." };
  return { ok: true, ...c, candidates: [{
    email, provider: c.servedBy,
    confidence: num(o.confidence),                                // 0..1 as treg maps it; null when not given. Not proof of identity.
    providerChecked: typeof o.verified === "boolean" ? o.verified : null,   // "the provider says it checked the mailbox"
    source: null,                                                 // the routed answer carries no source information, so none is shown
    name: [str(o.first_name, 100), str(o.last_name, 100)].filter(Boolean).join(" ") || null,
  }] };
}

/** Check one address you already have. Returns treg's own verdict word and nothing stronger. */
async function verifyEmail(input, opts) {
  const email = String(input && input.email || "").trim();
  if (!isEmail(email) || email.length > 254) return { ok: false, code: "insufficient", message: "That doesn't look like an email address." };
  const res = await call("verify", { email }, opts);
  if (!res.ok || res.pending) return res;
  const o = res.output, c = cost(res.meta);
  const status = str(o.status, 40);
  return { ok: true, ...c, email, status: status ? status.toLowerCase() : null, valid: typeof o.valid === "boolean" ? o.valid : null, score: num(o.score) };
}

module.exports = { findEmail, verifyEmail, normalizeDomain, maxCost, OPS, BASE, _busy: busy };
