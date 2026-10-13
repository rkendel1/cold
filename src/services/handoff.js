// "Open in email": hands a finished draft to the user's own email app as an unsent draft. Cold never sends anything and never signs in
// to anything. The user chooses the app once (Settings > Email app): their computer's default (a mailto: link), or Gmail / Outlook in
// the browser, which open a pre-filled compose tab using the session the user is already signed into.
// Desktop app: a one-purpose bridge asks the OS to open the link (and reports failure). Browser / extension: a link opened in a new tab.
import mailto from "../../lib/mailto.js";

export const { MAILTO_MAX_LENGTH, WEB_MAX_LENGTH, APPS, APP_LABELS, WEB_APPS, isEmail, buildMailto, buildHandoff } = mailto;

const INVALID = "That doesn't look like a valid email address. Fix it, or clear it to open the draft without a recipient.";

/** Click a hidden link. A mailto: link goes to whichever app the browser knows; a web compose link opens in a new tab so Cold stays open. */
function browserOpen(url) {
  const a = document.createElement("a");
  a.href = url; a.rel = "noopener noreferrer"; a.style.display = "none";
  if (/^https:/i.test(url)) a.target = "_blank";
  document.body.append(a); a.click(); a.remove();
}

/**
 * @param {{ to?: string, subject?: string, body?: string, app?: string, account?: string }} draft  `app`: "mailto" (default), "gmail", "outlook" or "m365"
 * @returns {Promise<{ ok: true, via: "desktop" | "browser", app: string, message: string } | { ok: false, reason: "invalid" | "too_long" | "failed", message: string }>}
 * `ok: true` only means the request was made. Nothing here can know whether an email app or tab opened, so the message never claims it did.
 */
export async function openInEmail({ to, subject, body, app = "mailto", account = "" }, { desktop = globalThis.coldDesktop, open = browserOpen } = {}) {
  const built = buildHandoff({ app, to, subject, body, account });
  const web = !!WEB_APPS[app];   // from what was asked for: a failed build has no app name
  const label = web ? WEB_APPS[app].label : "your email app";
  if (!built.ok) {
    if (built.reason === "too_long") return { ok: false, reason: "too_long", message: `This message is too long to open reliably in ${web ? label : "an email app"} (${built.length} characters; the limit is ${built.max}). Nothing was shortened. Use Copy email instead.` };
    return { ok: false, reason: built.reason, message: INVALID };
  }
  const none = built.noRecipient ? " with no recipient (add one there)" : "";
  try {
    if (desktop && typeof desktop.openMail === "function") {
      const r = await desktop.openMail(built.url);
      if (!r || !r.ok) return { ok: false, reason: "failed", message: `Couldn't open ${label}${r && r.message ? ` (${r.message})` : ""}. Use Copy email and paste it yourself; your draft is untouched.` };
      return { ok: true, via: "desktop", app: built.app, message: web ? `Opened your browser to a ${label} compose window${none}. If it asks you to sign in, do that first. Review the draft and press Send there; Cold hasn't sent anything.` : `Opened a draft in your email app${none}. Review it and press Send there. Cold hasn't sent anything.` };
    }
    open(built.url);
    return { ok: true, via: "browser", app: built.app, message: web
      ? `Opened a ${label} compose tab${none}. If it asks you to sign in, do that first. Review the draft and press Send there; Cold hasn't sent anything. If no tab appeared, your browser may have blocked it: allow pop-ups for this page, or use Copy email.`
      : `Asked your email app to open a draft${none}. Review it and press Send there; Cold hasn't sent anything. If nothing opened, this device may have no email app set up: choose Gmail or Outlook in Settings > Email app, or use Copy email.` };
  } catch {
    return { ok: false, reason: "failed", message: `Couldn't open ${label}. Use Copy email and paste it yourself; your draft is untouched.` };
  }
}
