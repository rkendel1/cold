// The desktop app's side of Cold account sign-in. Runs in the app's local server (the Electron main process), never in the page: the page asks this module for the
// account's name and email and for "start sign-in" / "sign out", and never sees a token.
//
// Flow (system browser): begin -> the person signs in with Google in their own browser -> Google redirects to this app's fixed loopback address ->
// complete. The account authority (a hosted Cold server, lib/auth.js) holds the OAuth client secret and the PKCE verifier, does the code exchange, checks the
// ID token and issues a session token. Nothing secret is built into the app. The `proof` below is a random value kept only here; the authority is given its hash at the
// start and the value itself at the end, so a stolen redirect (state and code) can't be completed by anyone else.
// The session token is kept in memory only: it is never written to settings.json, cold.db, a URL or a log. Restarting the app signs you out (local data is unaffected).
const crypto = require("node:crypto");

const b64 = buf => buf.toString("base64url");
const TTL = 10 * 60 * 1000;
const isLoopback = h => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h);

/** The authority's address: https, or plain http only to this computer (development). Returns the origin without a trailing slash, or "". */
function normalizeAuthority(input) {
  let u; try { u = new URL(String(input || "")); } catch { return ""; }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return "";
  if (u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.host))) return u.origin;
  return "";
}

function createAccountClient({ authority, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const base = normalizeAuthority(authority);
  let pending = null;          // { state, proof, at }
  let session = null;          // { token, expiresAt, account }
  let lastError = "";

  async function call(path, { method = "GET", body, bearer } = {}) {
    let r;
    try { r = await fetchImpl(`${base}${path}`, { method, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
    catch { throw Object.assign(new Error("unreachable"), { unreachable: true }); }
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, data };
  }

  return {
    configured: !!base,
    /** Start a sign-in. `redirectUri` is this app's own callback address. Returns the Google URL for the person's browser. */
    async begin({ redirectUri }) {
      if (!base) throw Object.assign(new Error("Account sign-in isn't set up in this build of Cold."), { status: 404, code: "account_not_configured" });
      const proof = b64(crypto.randomBytes(32));
      let r; try { r = await call("/api/account/native/begin", { method: "POST", body: { client: "desktop", redirectUri, proof: b64(crypto.createHash("sha256").update(proof).digest()) } }); }
      catch { throw Object.assign(new Error("Couldn't reach the Cold account service. Cold still works without it."), { status: 503, code: "account_unavailable" }); }
      if (!r.ok || typeof r.data.authUrl !== "string" || typeof r.data.state !== "string") throw Object.assign(new Error("The Cold account service didn't start sign-in."), { status: 502, code: "account_refused" });
      pending = { state: r.data.state, proof, at: now() };
      return { url: r.data.authUrl };
    },
    /** Google sent the browser back with a code. Returns { ok, message } for the page the person sees; never throws. */
    async complete({ code, state, error }) {
      const p = pending; pending = null;                                              // one attempt, one answer: a repeated or forged callback finds nothing
      if (!p || now() - p.at > TTL || typeof state !== "string" || state.length !== p.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(p.state))) return { ok: false, message: "This sign-in link expired or didn't start here. Go back to Cold and start again." };
      if (error) { lastError = error === "access_denied" ? "You chose not to sign in." : "Google didn't complete the sign-in."; return { ok: false, message: lastError }; }
      if (!code) return { ok: false, message: "Google didn't send a sign-in code. Start again from Cold." };
      try {
        const r = await call("/api/account/native/complete", { method: "POST", body: { state, code, proof: p.proof } });
        if (!r.ok || typeof r.data.token !== "string" || !r.data.account) { lastError = "Sign-in didn't complete."; return { ok: false, message: "Sign-in didn't complete, so you're not signed in. Nothing was changed." }; }
        session = { token: r.data.token, expiresAt: Number(r.data.expiresAt) || 0, account: { name: String(r.data.account.name || ""), email: String(r.data.account.email || "") } };
        lastError = "";
        return { ok: true, message: "Signed in. You can close this tab and go back to Cold." };
      } catch { lastError = "unreachable"; return { ok: false, message: "Couldn't reach the Cold account service, so you're not signed in." }; }
    },
    /** { state: "signedOut" | "signedIn" | "expired" | "unavailable", account? }. Asks the authority, so a revoked or expired session is noticed. Local data is never involved. */
    async status() {
      if (!session) return { state: "signedOut" };
      if (session.expiresAt && session.expiresAt <= now()) { session = null; return { state: "expired" }; }
      try {
        const r = await call("/api/account/me", { bearer: session.token });
        if (r.status === 401) { session = null; return { state: "expired" }; }
        if (!r.ok || !r.data.signedIn) return { state: "unavailable" };
        session.account = { name: String(r.data.account.name || ""), email: String(r.data.account.email || "") };
        return { state: "signedIn", account: session.account };
      } catch { return { state: "unavailable", account: session.account }; }
    },
    /** Ends the session at the authority (best effort) and ALWAYS forgets it here. `serverConfirmed` says whether the authority acknowledged it. */
    async signOut() {
      const s = session; session = null; pending = null;
      if (!s) return { serverConfirmed: true };
      try { const r = await call("/api/account/logout", { method: "POST", bearer: s.token }); return { serverConfirmed: r.ok }; } catch { return { serverConfirmed: false }; }
    },
    /**
     * Forwards one hosted-library request to the authority with this app's bearer token, which never leaves this process (the page only ever talks to its own local server).
     * Returns { status, data }. A 401 means the session ended: it is forgotten here. A network failure is a 503, never a silent success.
     */
    async hosted({ method, path, body }) {
      if (!base || !session) return { status: 401, data: { error: { code: "not_signed_in", message: "You're signed out, so nothing was saved to your hosted library. Sign in again." } } };
      if (session.expiresAt && session.expiresAt <= now()) { session = null; return { status: 401, data: { error: { code: "not_signed_in", message: "Your sign-in ended, so nothing was saved to your hosted library. Sign in again." } } }; }
      try {
        const r = await call(path, { method, body, bearer: session.token });
        if (r.status === 401) session = null;
        return { status: r.status, data: r.data };
      } catch { return { status: 503, data: { error: { code: "storage_unavailable", message: "Couldn't reach your hosted library. Nothing was saved there." } } }; }
    },
    get lastError() { return lastError; },
  };
}
module.exports = { createAccountClient, normalizeAuthority };
