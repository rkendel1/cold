// Settings > Cold account (optional, on every surface that can offer it). Sign in with Google is identity only: it doesn't connect Gmail or Sheets, doesn't move,
// upload or merge anything, and doesn't change which data you're working with. Cold works the same without it. States: signed out, signing in, signed in, failed,
// session ended, account service unreachable. The surface-specific part (cookie, local app, extension worker) is the driver in services/accountDrivers.js.
import { h, clear, append } from "../components/dom.js";
import { button, notice, announce } from "../components/ui.js";
import { mountHostedSection } from "./hostedSection.js";

const FAILED = { failed: "Google sign-in didn't complete, so you're not signed in. Nothing was changed. Try again.", cancelled: "You chose not to sign in with Google. You're not signed in, and Cold works as before.", expired: "That sign-in link expired or was already used. Start again." };
const LOCAL = { web: "You don't need an account. Your products, drafts and leads stay in this browser (see Your data below); signing in doesn't move or upload them. Cross-device sync isn't available yet.",
  desktop: "You don't need an account. Your products, drafts and leads stay in this app's database on this computer; signing in doesn't move, upload or change them. Cross-device sync isn't available yet.",
  extension: "You don't need an account. Your products, drafts and leads stay in this extension's storage; signing in doesn't move, upload or change them. Cross-device sync isn't available yet." };

export function mountAccountSection({ driver, hosted = null, location = globalThis.location, history = globalThis.history, pollMs = 2000, maxWaitMs = 5 * 60 * 1000 }) {
  const host = h("div", { id: "accountSection", "aria-live": "polite" });
  let wasSignedIn = false, message = null, waiting = null;
  const local = h("p", { class: "hint", id: "accountLocal" }, LOCAL[driver.kind] || LOCAL.web);

  // The hosted web page returns here as /?signin=ok|failed|cancelled|expired. Show it once, then take it out of the address bar.
  try {
    const sp = new URLSearchParams(location.search), r = sp.get("signin");
    if (r) { if (FAILED[r]) message = { kind: "bad", text: FAILED[r] }; sp.delete("signin"); const q = sp.toString(); history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`); }
  } catch { /* the address bar is cosmetic */ }

  const hostedEl = hosted ? mountHostedSection(hosted) : null;                // the library choice (hosted or local); it learns from this section whether anyone is signed in
  const draw = (...kids) => append(clear(host), [message ? notice(message.kind, h("p", { id: "accountMessage" }, message.text)) : null, ...kids, hostedEl, local]);
  const tell = (signedIn, o) => { if (hostedEl) hostedEl.update(signedIn, o); };
  const where = driver.kind === "web" ? "this browser's session" : "this app";
  function signedOut(o) {
    tell(false, o);
    draw(h("p", {}, "Sign in with Google to identify yourself to Cold. Cold asks Google only for your name and email address, not for Gmail or Google Sheets, and not for Drive."),
      h("div", { class: "actions" }, button("Sign in with Google", { kind: "primary", id: "signInBtn", onclick: signIn })));
  }
  function signedIn(a) {
    wasSignedIn = true; tell(true);
    draw(h("p", { id: "accountWho" }, "Signed in as ", h("strong", {}, a.account.name || a.account.email || "your Google account"), a.account.name && a.account.email ? ` (${a.account.email})` : ""),
      h("p", { class: "hint" }, `Signing out ends ${where === "this app" ? "this app's" : "this browser's"} Cold session. It doesn't sign you out of Google, doesn't change any permission you gave Google, and doesn't touch your local data.`),
      h("div", { class: "actions" }, button("Sign out", { id: "signOutBtn", onclick: signOut })));
  }
  function waitingView() {
    draw(h("p", { id: "accountBusy" }, "Finish signing in in your web browser. Cold will pick it up here when you're done."),
      h("div", { class: "actions" }, button("Cancel", { id: "signInCancel", onclick: () => { stopWaiting(); message = null; signedOut(); } })));
  }
  const stopWaiting = () => { if (waiting) { clearInterval(waiting.timer); waiting = null; } };
  async function signIn() {
    message = null; stopWaiting(); draw(h("p", { id: "accountBusy" }, "Opening Google…"));
    try {
      const r = await driver.signIn();
      if (r && r.navigating) return;                                    // the web page is leaving for Google
      if (!r || !r.pending) return refresh();                           // the extension's flow has already finished: show where it ended
      waitingView(); const started = Date.now();
      waiting = { timer: setInterval(async () => {
        const s = await driver.status().catch(() => ({ state: "unavailable" }));
        if (s.state === "signedIn") { stopWaiting(); message = { kind: "good", text: "You're signed in." }; signedIn(s); announce("Signed in"); }
        else if (Date.now() - started > maxWaitMs) { stopWaiting(); message = { kind: "warn", text: "Sign-in wasn't finished in time, so you're not signed in. You can try again." }; signedOut(); }
      }, pollMs) };
    } catch (e) { message = { kind: "bad", text: e && e.code === "account_unavailable" ? "Couldn't reach the Cold account service, so you're not signed in. Cold still works without it." : `Couldn't start Google sign-in. You're not signed in.${e && e.message && e.code !== "login_failed" ? ` ${e.message}` : ""}` }; signedOut(); return; }
    await refresh();
  }
  async function signOut() {
    try {
      const r = await driver.signOut(); if (!r.ok) throw new Error("logout");
      wasSignedIn = false;
      message = { kind: r.serverConfirmed ? "good" : "warn", text: r.serverConfirmed ? "You're signed out. Cold is still available without an account, and your local data is unchanged." : "You're signed out here, but Cold couldn't reach the account service to end the session there. Your local data is unchanged." };
      signedOut({ signedOut: true }); announce("Signed out");
    } catch { message = { kind: "bad", text: "Couldn't confirm that you signed out, so assume you're still signed in. Try again." }; await refresh(); }
  }
  async function refresh() {
    let s; try { s = await driver.status(); } catch { s = { state: "unavailable" }; }
    if (s.state === "signedIn") return signedIn(s);
    if (s.state === "unavailable") { message = { kind: "warn", text: "Couldn't reach the Cold account service, so your sign-in can't be checked right now. Cold still works without it; your local data is unaffected." }; if (s.account) { draw(h("p", { id: "accountWho" }, "Last known account: ", h("strong", {}, s.account.name || s.account.email || "your Google account")), h("div", { class: "actions" }, button("Check again", { id: "accountRetry", onclick: refresh }))); return; } return signedOut(); }
    if ((s.state === "expired" || wasSignedIn) && (!message || message.kind === "good")) message = { kind: "warn", text: "Your session ended. Sign in again if you want to. Your local data is unaffected." };
    wasSignedIn = false; signedOut();
  }
  draw(h("p", { class: "hint" }, "Checking…")); refresh();
  // Coming back to the window is when a session that ended (expired, or revoked elsewhere) is noticed.
  globalThis.addEventListener?.("focus", () => { if (host.isConnected && wasSignedIn && !waiting) refresh(); });
  return host;
}
