// Settings > Cold account (hosted web only; the server reports `account.enabled`). Sign in with Google is identity only: it doesn't connect Gmail or Sheets and it
// doesn't move or store your leads and drafts anywhere. Cold keeps working without it. States: signed out, signing in, signed in, failed, session ended.
import { h, clear, append } from "../components/dom.js";
import { button, notice, announce } from "../components/ui.js";

const FAILED = { failed: "Google sign-in didn't complete, so you're not signed in. Nothing was changed. Try again.", cancelled: "You chose not to sign in with Google. You're not signed in, and Cold works as before.", expired: "That sign-in link expired or was already used. Start again." };

export function mountAccountSection({ fetchImpl = (...a) => globalThis.fetch(...a), location = globalThis.location, history = globalThis.history } = {}) {
  const host = h("div", { id: "accountSection", "aria-live": "polite" });
  let csrf = "", wasSignedIn = false, message = null;
  const local = h("p", { class: "hint", id: "accountLocal" }, "You don't need an account. Your products, drafts and leads stay where they are now (see Your data below), and signing in doesn't move or upload them. Cross-device sync isn't available yet.");

  // The page returns here as /?signin=ok|failed|cancelled|expired. Show it once, then take it out of the address bar.
  try {
    const sp = new URLSearchParams(location.search), r = sp.get("signin");
    if (r) { if (FAILED[r]) message = { kind: "bad", text: FAILED[r] }; sp.delete("signin"); const q = sp.toString(); history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`); }
  } catch { /* the address bar is cosmetic */ }

  const draw = (...kids) => append(clear(host), [message ? notice(message.kind, h("p", { id: "accountMessage" }, message.text)) : null, ...kids, local]);
  function signedOut() {
    draw(h("p", {}, "Sign in with Google to identify yourself to Cold. Cold asks Google only for your name and email address, not for Gmail or Google Sheets."),
      h("div", { class: "actions" }, button("Sign in with Google", { kind: "primary", id: "signInBtn", onclick: signIn })));
  }
  function signedIn(a) {
    wasSignedIn = true; csrf = a.csrf;
    draw(h("p", { id: "accountWho" }, "Signed in as ", h("strong", {}, a.account.name || a.account.email || "your Google account"), a.account.name && a.account.email ? ` (${a.account.email})` : ""),
      h("p", { class: "hint" }, "Signing out ends this browser's Cold session. It doesn't sign you out of Google and doesn't change any permission you gave Google."),
      h("div", { class: "actions" }, button("Sign out", { id: "signOutBtn", onclick: signOut })));
  }
  async function signIn() {
    message = null; draw(h("p", { id: "accountBusy" }, "Opening Google…"));
    try {
      const r = await fetchImpl("api/account/login", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ returnTo: "/" }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.url) throw new Error("login");
      location.assign(d.url);
    } catch { message = { kind: "bad", text: "Couldn't start Google sign-in. You're not signed in. Try again in a moment." }; signedOut(); }
  }
  async function signOut() {
    try {
      const r = await fetchImpl("api/account/logout", { method: "POST", headers: { "content-type": "application/json", "x-cold-csrf": csrf } });
      if (!r.ok) throw new Error("logout");
      wasSignedIn = false; csrf = ""; message = { kind: "good", text: "You're signed out. Cold is still available without an account." }; signedOut(); announce("Signed out");
    } catch { message = { kind: "bad", text: "Couldn't confirm that you signed out, so assume you're still signed in. Try again." }; await refresh(); }
  }
  async function refresh() {
    try {
      const r = await fetchImpl("api/account/me", { headers: { accept: "application/json" } });
      if (r.ok) { const d = await r.json(); if (d && d.signedIn && d.account) return signedIn(d); }
      if (r.status === 401 && wasSignedIn && !message) message = { kind: "warn", text: "Your session ended. Sign in again if you want to." };
      wasSignedIn = false; signedOut();
    } catch { message = { kind: "bad", text: "Couldn't check whether you're signed in. Cold still works without an account." }; signedOut(); }
  }
  draw(h("p", { class: "hint" }, "Checking…")); refresh();
  // Coming back to the tab is when a session that ended (expired, or signed out elsewhere) is noticed.
  globalThis.addEventListener?.("focus", () => { if (host.isConnected && wasSignedIn) refresh(); });
  return host;
}
