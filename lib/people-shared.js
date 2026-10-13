// People search, the parts the page and the server both need: what a lookup request may contain, and how to word what treg answered.
// Pure: no network, no credentials. The treg token never appears in this file or anywhere the browser can read.
const { parseProfileUrl } = require("./profile");
const { isEmail } = require("./mailto");

const MAX_NAME = 200;

/** "https://www.Acme.com/about" -> "acme.com". Returns "" when it isn't a plain company domain (an email address or a path-less word is not one). */
function normalizeDomain(input) {
  let s = String(input == null ? "" : input).trim().toLowerCase();
  if (!s || s.includes("@") || /\s/.test(s)) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0];
  return /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(s) && s.length <= 253 ? s : "";
}

/**
 * The request for one lookup, built only from what the user already holds about this person (plus a company domain they typed for it).
 * Nothing is guessed: a missing piece is reported, not filled in.
 * @returns {{ ok: true, body: object, using: string[] } | { ok: false, message: string }}
 */
function buildFindRequest({ name, profileUrl, domain } = {}) {
  const fullName = String(name || "").trim().slice(0, MAX_NAME);
  const li = profileUrl ? parseProfileUrl(profileUrl) : null;
  const dom = normalizeDomain(domain);
  const body = {}, using = [];
  if (li && li.site === "linkedin") { body.linkedin_url = li.url; using.push("LinkedIn profile link"); }
  if (fullName && dom) { body.full_name = fullName; body.domain = dom; using.push("name", "company domain"); }
  if (!body.linkedin_url && !body.domain) {
    return { ok: false, message: fullName
      ? "To look up an email, Cold needs either their LinkedIn profile link (add it to this lead) or the company's website domain (type it below). Cold doesn't guess either one."
      : "Add the person's name and company domain, or their LinkedIn profile link, then try again." };
  }
  return { ok: true, body, using };
}

/** What each verification word from treg means, and what it does NOT prove. `tone`: good | warn | bad | neutral. */
const VERDICTS = {
  valid:      { label: "Deliverable", tone: "good", detail: "The verifier says this mailbox accepts mail. That doesn't show it belongs to the person you mean." },
  invalid:    { label: "Not deliverable", tone: "bad", detail: "The verifier says this address can't receive mail. Don't use it." },
  accept_all: { label: "Accepts all mail", tone: "warn", detail: "This domain accepts mail for any address, so the verifier can't tell whether this mailbox exists." },
  catch_all:  { label: "Accepts all mail", tone: "warn", detail: "This domain accepts mail for any address, so the verifier can't tell whether this mailbox exists." },
  risky:      { label: "Risky", tone: "warn", detail: "The verifier found signs that mail to this address may bounce or be filtered." },
  unknown:    { label: "Couldn't be determined", tone: "neutral", detail: "The verifier couldn't tell. Treat the address as unchecked." },
};
/** The wording for a verification word; a word treg adds later is shown as it came, never as success. */
function verdictCopy(status) {
  const key = String(status == null ? "" : status).trim().toLowerCase();
  if (!key) return VERDICTS.unknown;
  return VERDICTS[key] || { label: String(status).slice(0, 40), tone: "neutral", detail: "The verifier returned this result. Cold doesn't know what it means, so it is not treated as deliverable." };
}

module.exports = { normalizeDomain, buildFindRequest, verdictCopy, VERDICTS, isEmail };
