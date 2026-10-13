// "Open in email": builds a mailto: link from a finished draft, and validates one before anything privileged opens it.
// Shared by the web app, the browser extension and the desktop shell, so all three apply the same rules. Nothing here sends mail:
// a mailto: link only asks the user's own email app to open a draft that the user reviews and sends themselves.

// mailto: links have client- and OS-dependent limits (roughly 2,000 characters is the lowest common ceiling in practice).
// Longer messages are never truncated: the caller is told, and Copy remains the way to move them.
const MAILTO_MAX_LENGTH = 2000;

// One address only. Whitespace, commas, semicolons, angle brackets, quotes, parentheses and backslashes are rejected, which also
// stops a second recipient or a "name <addr>" form being smuggled in. Non-ASCII (internationalised) addresses are allowed.
const EMAIL = /^[^\s@<>()[\],;:"\\]{1,64}@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}-]{2,}$/u;   // the domain: letters, digits, hyphens and dots only

/** True for a single, plausible email address. Deliberately loose: it catches typos, not every invalid mailbox. */
function isEmail(value) {
  const v = String(value == null ? "" : value).trim();
  if (!v || v.length > 254 || /\.\./.test(v)) return false;
  const [local, domain] = v.split("@");
  if (!local || !domain || local.startsWith(".") || local.endsWith(".") || domain.startsWith("-") || domain.startsWith(".") || domain.endsWith("-")) return false;
  return EMAIL.test(v);
}

const crlf = s => String(s == null ? "" : s).replace(/\r\n|\r|\n/g, "\r\n");   // RFC 6068: line breaks in a body are CRLF

/**
 * @returns {{ ok: true, url: string, noRecipient: boolean } | { ok: false, reason: "invalid" | "too_long", length?: number, max?: number }}
 * The recipient is optional: with none, the link opens a draft with the To line empty. One that is given must be a valid address.
 * `subject` is flattened to one line (a line break there could inject headers). The body keeps its line breaks.
 */
function buildMailto({ to, subject = "", body = "" }) {
  const addr = String(to == null ? "" : to).trim();
  if (addr && !isEmail(addr)) return { ok: false, reason: "invalid" };
  const subj = String(subject == null ? "" : subject).replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  const text = crlf(body).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const enc = s => encodeURIComponent(s);                      // encodes & = ? # % + and space, so no value can add or end a parameter
  const url = `mailto:${enc(addr).replace(/%40/g, "@")}?subject=${enc(subj)}&body=${enc(text)}`;
  if (url.length > MAILTO_MAX_LENGTH) return { ok: false, reason: "too_long", length: url.length, max: MAILTO_MAX_LENGTH };
  return { ok: true, url, noRecipient: !addr };
}

/**
 * The gate in front of anything that hands a URL to the operating system (the desktop app's shell.openExternal). Accepts only a
 * mailto: link of the exact shape buildMailto produces: no address or one valid address, and only subject and body parameters.
 */
function isSafeMailto(url) {
  if (typeof url !== "string" || url.length > MAILTO_MAX_LENGTH + 200 || /[\u0000-\u001f\u007f\s]/.test(url) || !/^mailto:/i.test(url)) return false;
  const q = url.indexOf("?");
  const rawAddr = url.slice("mailto:".length, q < 0 ? undefined : q);
  let addr; try { addr = decodeURIComponent(rawAddr); } catch { return false; }
  if (addr !== "" && !isEmail(addr)) return false;
  if (q < 0) return addr !== "";
  const seen = new Set();
  for (const part of url.slice(q + 1).split("&")) {
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    if ((key !== "subject" && key !== "body") || seen.has(key)) return false;
    seen.add(key);
    try { decodeURIComponent(eq < 0 ? "" : part.slice(eq + 1)); } catch { return false; }
  }
  return true;
}

// ---- Web email (Gmail, Outlook) -----------------------------------------------------------------------------------------------
// People who read mail in a browser usually have no mailto: handler registered, so a mailto: link does nothing for them. Gmail and
// Outlook each accept a pre-filled compose link that opens in a new tab using the session the user is already signed into. Cold never
// signs in, never reads mail and never sends: this only opens a draft for the user to review and send.
const WEB_MAX_LENGTH = 6000;   // these servers take longer URLs than mail apps do; past this we still refuse rather than shorten
const WEB_APPS = {
  gmail:   { label: "Gmail", host: "mail.google.com", path: "/mail/", fixed: [["view", "cm"], ["fs", "1"]], keys: { to: "to", subject: "su", body: "body" }, account: "authuser" },
  outlook: { label: "Outlook.com", host: "outlook.live.com", path: "/mail/0/deeplink/compose", fixed: [], keys: { to: "to", subject: "subject", body: "body" } },
  m365:    { label: "Outlook for work or school", host: "outlook.office.com", path: "/mail/deeplink/compose", fixed: [], keys: { to: "to", subject: "subject", body: "body" } },
};
const APP_LABELS = { mailto: "Your computer's default email app", gmail: "Gmail (in your browser)", outlook: "Outlook.com (in your browser)", m365: "Outlook for work or school (in your browser)" };
const APPS = Object.keys(APP_LABELS);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * The compose link for the chosen email app. `app` is "mailto" (default) or one of the web apps; `account` is an optional Gmail
 * address, for people signed into more than one Google account. Same rules as buildMailto: an optional recipient that must be valid
 * if given, a one-line subject, a body that keeps its line breaks, and a refusal (never a truncation) when it is too long.
 * @returns {{ ok: true, url: string, noRecipient: boolean, app: string } | { ok: false, reason: "invalid" | "too_long", length?: number, max?: number }}
 */
function buildHandoff({ app = "mailto", to, subject = "", body = "", account = "" }) {
  const w = WEB_APPS[app];
  if (!w) { const r = buildMailto({ to, subject, body }); return r.ok ? { ...r, app: "mailto" } : r; }
  const addr = String(to == null ? "" : to).trim();
  if (addr && !isEmail(addr)) return { ok: false, reason: "invalid" };
  const subj = String(subject == null ? "" : subject).replace(/[\r\n\u2028\u2029]+/g, " ").replace(CONTROL, "").trim();
  const text = String(body == null ? "" : body).replace(/\r\n|\r/g, "\n").replace(CONTROL, "");
  const acct = String(account || "").trim();
  const params = [...(w.account && isEmail(acct) ? [[w.account, acct]] : []), ...w.fixed, ...(addr ? [[w.keys.to, addr]] : []), [w.keys.subject, subj], [w.keys.body, text]];
  const url = `https://${w.host}${w.path}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
  if (url.length > WEB_MAX_LENGTH) return { ok: false, reason: "too_long", length: url.length, max: WEB_MAX_LENGTH };
  return { ok: true, url, noRecipient: !addr, app };
}

/**
 * The gate in front of anything that hands a URL to the operating system. Accepts a mailto: link (see isSafeMailto) or the EXACT
 * compose link of one of the web apps above: https, that host and path only (never a look-alike host, port, credentials or fragment),
 * only the known parameters, each once, a valid address if one is given, and the fixed parameters unchanged.
 */
function isSafeHandoff(url) {
  if (typeof url !== "string") return false;
  if (/^mailto:/i.test(url)) return isSafeMailto(url);
  if (url.length > WEB_MAX_LENGTH + 300 || /[\u0000-\u001f\u007f\s]/.test(url)) return false;
  let u; try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || !u.search) return false;
  const w = Object.values(WEB_APPS).find(x => x.host === u.hostname && x.path === u.pathname);
  if (!w) return false;
  const allowed = new Set([...w.fixed.map(f => f[0]), w.keys.to, w.keys.subject, w.keys.body, ...(w.account ? [w.account] : [])]);
  const seen = new Set();
  for (const [k, v] of u.searchParams) {
    if (!allowed.has(k) || seen.has(k)) return false;
    seen.add(k);
    const fixed = w.fixed.find(f => f[0] === k);
    if (fixed && v !== fixed[1]) return false;
    if (k === w.keys.to && v !== "" && !isEmail(v)) return false;
    if (w.account && k === w.account && !isEmail(v)) return false;
  }
  return true;
}

module.exports = { MAILTO_MAX_LENGTH, WEB_MAX_LENGTH, APPS, APP_LABELS, WEB_APPS, isEmail, buildMailto, buildHandoff, isSafeMailto, isSafeHandoff };
