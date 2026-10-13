// Google sign-in for the desktop app and local installs (the "installed app" OAuth flow with PKCE and a loopback redirect).
// The page asks the local server to start it, the user signs in in their own browser, Google sends them back to this computer, and the
// server keeps the refresh token where provider keys are kept (encrypted by the operating system when it can). The page only ever
// receives short-lived access tokens, and only for Cold's narrow scope: files Cold itself created in the person's Drive (drive.file).
const crypto = require("node:crypto");

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const DEFAULTS = { authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", revokeUrl: "https://oauth2.googleapis.com/revoke" };
const b64 = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const TTL = 10 * 60 * 1000;

function createGoogleOAuth({ clientId = "", clientSecret = "", settings = null, fetchImpl = (...a) => fetch(...a), urls = {}, now = () => Date.now() } = {}) {
  const u = { ...DEFAULTS, ...urls };
  const pending = new Map();       // state -> { verifier, redirectUri, at }
  let access = null;               // { token, expiresAt } (memory only)
  let lastError = "";

  const refreshToken = () => (settings ? settings.integrationKey("google") : "");
  const configured = () => !!(clientId && settings);
  const form = o => new URLSearchParams(o).toString();
  async function post(url, body) {
    const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form(body) });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  return {
    configured,
    /** Where to send the person to sign in. `redirectUri` is this server's own callback address. */
    start({ redirectUri }) {
      if (!configured()) throw Object.assign(new Error("Google sign-in isn't set up in this build of Cold."), { status: 404, code: "google_not_configured" });
      for (const [k, v] of pending) if (now() - v.at > TTL) pending.delete(k);
      const state = b64(crypto.randomBytes(24)), verifier = b64(crypto.randomBytes(48));
      pending.set(state, { verifier, redirectUri, at: now() });
      const q = form({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE, state, code_challenge: b64(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", access_type: "offline", prompt: "consent", include_granted_scopes: "false" });
      return { url: `${u.authUrl}?${q}` };
    },
    /** Google redirected back with a code. Returns { ok, message } for the page the person sees. */
    async callback({ code, state, error }) {
      const p = state && pending.get(state); pending.delete(state);
      if (!p || now() - p.at > TTL) return { ok: false, message: "This sign-in link has expired. Go back to Cold and start again." };
      if (error) { lastError = error === "access_denied" ? "You chose not to give Cold access." : "Google didn't complete the sign-in."; return { ok: false, message: lastError }; }
      if (!code) return { ok: false, message: "Google didn't send a sign-in code. Start again from Cold." };
      const r = await post(u.tokenUrl, { code, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), redirect_uri: p.redirectUri, grant_type: "authorization_code", code_verifier: p.verifier });
      if (!r.ok || !r.data.access_token) { lastError = "Google refused the sign-in."; return { ok: false, message: lastError }; }
      if (!r.data.scope || !String(r.data.scope).includes("drive.file")) { lastError = "Google didn't grant access to the spreadsheet Cold creates. Try again and tick the box."; return { ok: false, message: lastError }; }
      if (r.data.refresh_token) settings.update({ integrations: { google: { apiKey: r.data.refresh_token } } });
      access = { token: r.data.access_token, expiresAt: now() + (Number(r.data.expires_in) || 3600) * 1000 };
      lastError = "";
      return { ok: true, message: "Connected. You can close this tab and go back to Cold." };
    },
    /** A current access token for the page to use with the Sheets API. */
    async token({ refresh = false } = {}) {
      if (!refresh && access && access.expiresAt - now() > 60000) return { accessToken: access.token, expiresAt: access.expiresAt };
      const rt = refreshToken();
      if (!rt) throw Object.assign(new Error("Connect your Google account first."), { status: 401, code: "google_auth" });
      const r = await post(u.tokenUrl, { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), refresh_token: rt, grant_type: "refresh_token" });
      if (!r.ok || !r.data.access_token) {
        if (r.data && r.data.error === "invalid_grant") settings.update({ integrations: { google: { apiKey: null } } });   // revoked or expired: connect again
        access = null; throw Object.assign(new Error("Google needs you to sign in again."), { status: 401, code: "google_auth" });
      }
      access = { token: r.data.access_token, expiresAt: now() + (Number(r.data.expires_in) || 3600) * 1000 };
      return { accessToken: access.token, expiresAt: access.expiresAt };
    },
    status: () => ({ configured: configured(), connected: configured() && !!refreshToken(), error: lastError }),
    /** Forget the sign-in here and ask Google to revoke it. */
    async disconnect() {
      const rt = refreshToken(); access = null; lastError = "";
      if (settings) settings.update({ integrations: { google: { apiKey: null } } });
      if (rt) { try { await post(u.revokeUrl, { token: rt }); } catch { /* the token is already forgotten here */ } }
    },
  };
}

module.exports = { createGoogleOAuth, SCOPE };
