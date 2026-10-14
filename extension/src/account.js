// Cold account sign-in for the extension, run ONLY in the background service worker. The panel and content scripts never receive the session token: the panel sends
// "status" / "signin" / "signout" and gets back a name and email. Messages are accepted from the extension's own pages only (not from content scripts, which run in web pages).
//
// Flow: begin at the account authority (a hosted Cold server, see lib/auth.js) -> chrome.identity.launchWebAuthFlow opens Google in the browser's own auth window and
// returns the redirect (https://<extension-id>.chromiumapp.org/?code&state) -> complete at the authority, which holds the OAuth client secret and PKCE verifier, checks the
// ID token and issues a session token. No secret is in the extension. `proof` is random, kept here only; the authority gets its hash first and the value at the end.
// The token lives in chrome.storage.session: memory only, readable by extension pages (not content scripts), gone when the browser closes. Never in storage.local, a URL or a log.
// The extension's local library and settings are never read or written here.
const KEY = "cold.account.session";
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const isLoopback = h => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h);

/** Account service address from the build's account.json: https, or http only to this computer. Returns the origin or "". */
export function normalizeAuthority(input) {
  let u; try { u = new URL(String(input || "")); } catch { return ""; }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return "";
  return u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.host)) ? u.origin : "";
}

export function createAccountWorker({ chrome, fetchImpl = (...a) => fetch(...a), now = () => Date.now() }) {
  const area = () => chrome.storage.session;
  const getSession = async () => (await area().get(KEY))[KEY] || null;
  const setSession = s => area().set({ [KEY]: s });
  const clearSession = () => area().remove(KEY);
  let cfg;
  async function config() {
    if (cfg !== undefined) return cfg;
    try { const r = await fetchImpl(chrome.runtime.getURL("dist/account.json")); cfg = r.ok ? normalizeAuthority((await r.json()).url) : ""; } catch { cfg = ""; }
    return cfg;
  }
  async function call(base, path, { method = "GET", body, bearer } = {}) {
    let r;
    try { r = await fetchImpl(`${base}${path}`, { method, credentials: "omit", headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
    catch { throw Object.assign(new Error("unreachable"), { unreachable: true }); }
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
  }
  const shown = a => ({ name: String((a && a.name) || ""), email: String((a && a.email) || "") });

  const ops = {
    async config() { return { enabled: !!(await config()) }; },
    async status() {
      const base = await config(); if (!base) return { state: "signedOut", disabled: true };
      const s = await getSession(); if (!s) return { state: "signedOut" };
      if (s.expiresAt && s.expiresAt <= now()) { await clearSession(); return { state: "expired" }; }
      try {
        const r = await call(base, "/api/account/me", { bearer: s.token });
        if (r.status === 401) { await clearSession(); return { state: "expired" }; }
        if (!r.ok || !r.data.signedIn) return { state: "unavailable", account: s.account };
        return { state: "signedIn", account: shown(r.data.account) };
      } catch { return { state: "unavailable", account: s.account }; }
    },
    async signin() {
      const base = await config(); if (!base) return { error: "account_not_configured", message: "Account sign-in isn't set up in this build of the extension." };
      const redirectUri = chrome.identity.getRedirectURL();
      const proof = b64(crypto.getRandomValues(new Uint8Array(32)));
      const proofHash = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof))));
      let begin;
      try { begin = await call(base, "/api/account/native/begin", { method: "POST", body: { client: "extension", redirectUri, proof: proofHash } }); }
      catch { return { error: "account_unavailable", message: "Couldn't reach the Cold account service. Cold still works without it." }; }
      if (!begin.ok || typeof begin.data.authUrl !== "string" || typeof begin.data.state !== "string") return { error: "account_refused", message: "The Cold account service didn't start sign-in." };
      let back;
      try { back = await chrome.identity.launchWebAuthFlow({ url: begin.data.authUrl, interactive: true }); }
      catch { return { error: "cancelled", message: "Sign-in was closed before it finished, so you're not signed in." }; }
      let q; try { q = new URL(back).searchParams; } catch { return { error: "failed", message: "Google didn't complete the sign-in." }; }
      if (q.get("state") !== begin.data.state) return { error: "failed", message: "The sign-in response didn't match this request, so it was ignored." };      // callback mismatch
      if (q.get("error")) return { error: q.get("error") === "access_denied" ? "cancelled" : "failed", message: q.get("error") === "access_denied" ? "You chose not to sign in." : "Google didn't complete the sign-in." };
      let done;
      try { done = await call(base, "/api/account/native/complete", { method: "POST", body: { state: begin.data.state, code: q.get("code") || "", proof } }); }
      catch { return { error: "account_unavailable", message: "Couldn't reach the Cold account service, so you're not signed in." }; }
      if (!done.ok || typeof done.data.token !== "string") return { error: "failed", message: "Sign-in didn't complete, so you're not signed in. Nothing was changed." };
      await setSession({ token: done.data.token, expiresAt: Number(done.data.expiresAt) || 0, account: shown(done.data.account) });
      return { state: "signedIn", account: shown(done.data.account) };
    },
    async signout() {
      const s = await getSession(), base = await config(); await clearSession();      // forgotten here whatever happens next
      if (!s || !base) return { ok: true, serverConfirmed: true };
      try { const r = await call(base, "/api/account/logout", { method: "POST", bearer: s.token }); return { ok: true, serverConfirmed: r.ok }; } catch { return { ok: true, serverConfirmed: false }; }
    },
  };

  /** Only the extension's own pages (the side panel, or an extension page in a tab). A content script runs in a web page, so its sender URL is that page's, never the extension's. */
  const fromOwnPage = sender => !!sender && sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  function onMessage(msg, sender, respond) {
    if (!msg || msg.cold !== "account") return false;
    if (!fromOwnPage(sender) || typeof msg.op !== "string" || !Object.hasOwn(ops, msg.op)) { respond({ error: "refused" }); return false; }
    ops[msg.op]().then(respond, () => respond({ state: "unavailable" }));
    return true;
  }
  return { ops, onMessage };
}
