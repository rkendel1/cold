// "Open in email": builds a mailto: link from a finished draft, and validates one before anything privileged opens it.
// Shared by the web app, the browser extension and the desktop shell, so all three apply the same rules. Nothing here sends mail:
// a mailto: link only asks the user's own email app to open a draft that the user reviews and sends themselves.

// mailto: links have client- and OS-dependent limits (roughly 2,000 characters is the lowest common ceiling in practice).
// Longer messages are never truncated: the caller is told, and Copy remains the way to move them.
const MAILTO_MAX_LENGTH = 2000;

// One address only. Whitespace, commas, semicolons, angle brackets, quotes, parentheses and backslashes are rejected, which also
// stops a second recipient or a "name <addr>" form being smuggled in. Non-ASCII (internationalised) addresses are allowed.
const EMAIL = /^[^\s@<>()[\],;:"\\]{1,64}@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\.]{2,}$/;

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
 * @returns {{ ok: true, url: string } | { ok: false, reason: "missing" | "invalid" | "too_long", length?: number, max?: number }}
 * `subject` is flattened to one line (a line break there could inject headers). The body keeps its line breaks.
 */
function buildMailto({ to, subject = "", body = "" }) {
  const addr = String(to == null ? "" : to).trim();
  if (!addr) return { ok: false, reason: "missing" };
  if (!isEmail(addr)) return { ok: false, reason: "invalid" };
  const subj = String(subject == null ? "" : subject).replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  const text = crlf(body).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const enc = s => encodeURIComponent(s);                      // encodes & = ? # % + and space, so no value can add or end a parameter
  const url = `mailto:${enc(addr).replace(/%40/g, "@")}?subject=${enc(subj)}&body=${enc(text)}`;
  if (url.length > MAILTO_MAX_LENGTH) return { ok: false, reason: "too_long", length: url.length, max: MAILTO_MAX_LENGTH };
  return { ok: true, url };
}

/**
 * The gate in front of anything that hands a URL to the operating system (the desktop app's shell.openExternal). Accepts only a
 * mailto: link of the exact shape buildMailto produces: one valid address, and only subject and body parameters.
 */
function isSafeMailto(url) {
  if (typeof url !== "string" || url.length > MAILTO_MAX_LENGTH + 200 || /[\u0000-\u001f\u007f\s]/.test(url) || !/^mailto:/i.test(url)) return false;
  const q = url.indexOf("?");
  const rawAddr = url.slice("mailto:".length, q < 0 ? undefined : q);
  let addr; try { addr = decodeURIComponent(rawAddr); } catch { return false; }
  if (!isEmail(addr)) return false;
  if (q < 0) return true;
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

module.exports = { MAILTO_MAX_LENGTH, isEmail, buildMailto, isSafeMailto };
