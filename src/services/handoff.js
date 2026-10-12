// "Open in email": hands a finished draft to the user's own email app as an unsent draft. Cold never sends anything.
// Desktop app: a one-purpose bridge asks the OS to open the link (and reports failure). Browser / extension: a mailto: link.
import mailto from "../../lib/mailto.js";

export const { MAILTO_MAX_LENGTH, isEmail, buildMailto } = mailto;

const MESSAGES = {
  missing: "Add the recipient's email address first, then open the draft in your email app.",
  invalid: "That doesn't look like a valid email address. Check it for typos.",
};

/** Plain browser handoff: click a hidden mailto: link. The browser decides which email app (if any) answers. */
function browserOpen(url) {
  const a = document.createElement("a");
  a.href = url; a.rel = "noopener"; a.style.display = "none";
  document.body.append(a); a.click(); a.remove();
}

/**
 * @returns {Promise<{ ok: true, via: "desktop" | "browser", message: string } | { ok: false, reason: "missing" | "invalid" | "too_long" | "failed", message: string }>}
 * `ok: true` only means the request was made. A browser cannot know whether an email app answered, so the message never claims it did.
 */
export async function openInEmail({ to, subject, body }, { desktop = globalThis.coldDesktop, open = browserOpen } = {}) {
  const built = buildMailto({ to, subject, body });
  if (!built.ok) {
    if (built.reason === "too_long") return { ok: false, reason: "too_long", message: `This message is too long to open reliably in an email app (${built.length} characters; the limit is ${built.max}). Nothing was shortened. Use Copy email instead.` };
    return { ok: false, reason: built.reason, message: MESSAGES[built.reason] };
  }
  try {
    if (desktop && typeof desktop.openMail === "function") {
      const r = await desktop.openMail(built.url);
      if (!r || !r.ok) return { ok: false, reason: "failed", message: `Couldn't open your email app${r && r.message ? ` (${r.message})` : ""}. Use Copy email and paste it yourself; your draft is untouched.` };
      return { ok: true, via: "desktop", message: "Opened a draft in your email app. Review it and press Send there. Cold hasn't sent anything." };
    }
    open(built.url);
    return { ok: true, via: "browser", message: "Asked your email app to open a draft. Review it and press Send there; Cold hasn't sent anything. If nothing opened, this device may not have an email app set up: use Copy email." };
  } catch {
    return { ok: false, reason: "failed", message: "Couldn't open your email app. Use Copy email and paste it yourself; your draft is untouched." };
  }
}
