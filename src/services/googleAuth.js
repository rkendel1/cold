// Signing in to Google, one implementation per surface behind one small interface:
//   { kind, connected(): boolean, connect(): Promise<void>, token(refresh?): Promise<string>, disconnect(): Promise<void> }
// All of them ask for ONE scope, drive.file: Cold can open only the spreadsheet it created for you, never your other files.
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const authError = message => ({ code: "google_auth", message });
const SKEW = 60000;

/** Web page: Google Identity Services in this tab. Access tokens last about an hour; renewing one is silent while Google still remembers you. */
export function browserAuth({ clientId, storage = globalThis.localStorage, loadScript = loadGis, timeoutMs = 15000, now = () => Date.now() } = {}) {
  const KEY = "cold.google.connected";
  let tok = null, client = null, wait = null;
  const remembered = () => { try { return storage.getItem(KEY) === "1"; } catch { return false; } };
  const remember = on => { try { on ? storage.setItem(KEY, "1") : storage.removeItem(KEY); } catch { /* session-only */ } };
  const valid = () => tok && tok.expiresAt - now() > SKEW;
  async function request(prompt) {
    await loadScript();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(authError("Google didn't answer. Press Reconnect Google.")), timeoutMs);
      const done = (fn, v) => { clearTimeout(timer); wait = null; fn(v); };
      wait = { resolve: r => done(resolve, r), reject: e => done(reject, e) };
      if (!client) client = globalThis.google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: GOOGLE_SCOPE, callback: r => (r && r.access_token ? wait && wait.resolve(r) : wait && wait.reject(authError("Google didn't sign you in."))), error_callback: () => wait && wait.reject(authError("Google sign-in was closed or blocked.")) });
      client.requestAccessToken({ prompt });
    });
  }
  const adopt = r => { tok = { token: r.access_token, expiresAt: now() + (Number(r.expires_in) || 3600) * 1000 }; remember(true); return tok.token; };
  return {
    kind: "browser", configured: !!clientId,
    connected: () => !!valid() || remembered(),
    /** Must be called from a click: Google opens a sign-in window. */
    async connect() {
      const r = await request("consent");
      if (!String(r.scope || GOOGLE_SCOPE).includes("drive.file")) throw authError("Google didn't give Cold access to the spreadsheet. Try again and tick the box.");
      adopt(r);
    },
    async token(refresh = false) {
      if (valid() && !refresh) return tok.token;
      if (!remembered()) throw authError("Connect your Google account first.");
      try { return adopt(await request("")); }
      catch (e) { tok = null; throw e && e.code ? e : authError("Google needs you to sign in again."); }
    },
    async disconnect() { const t = tok && tok.token; tok = null; remember(false); try { if (t && globalThis.google) globalThis.google.accounts.oauth2.revoke(t, () => {}); } catch { /* already forgotten here */ } },
  };
}
function loadGis() {
  if (globalThis.google && globalThis.google.accounts && globalThis.google.accounts.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = () => resolve(); s.onerror = () => reject(authError("Couldn't load Google sign-in. Check your connection."));
    document.head.append(s);
  });
}

/** Desktop app and local installs: the local Cold server does the sign-in (see lib/google.js); the page gets short-lived tokens from it. */
export function serverAuth({ call, sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = 1500, maxMs = 5 * 60 * 1000, open = url => globalThis.open && globalThis.open(url, "_blank", "noopener") } = {}) {
  let known = false;
  return {
    kind: "server", configured: true,
    connected: () => known,
    /** Reads the saved state (call once at start so connected() is right). */
    async refreshState() { try { known = !!(await call("api/google/status")).connected; } catch { known = false; } return known; },
    /**
     * Starts the sign-in, opens the person's own browser at Google, and waits until the server says it finished.
     * `onUrl(url)` is called with the sign-in address so it can be shown if the window was blocked.
     */
    async connect({ onUrl = () => {} } = {}) {
      const { url } = await call("api/google/connect", { method: "POST" });
      onUrl(url); open(url);
      for (let waited = 0; waited < maxMs; waited += pollMs) {
        await sleep(pollMs);
        const s = await call("api/google/status");
        if (s.connected) { known = true; return; }
        if (s.error) throw authError(s.error);
      }
      throw authError("Sign-in took too long. Try again.");
    },
    async token(refresh = false) {
      try { const r = await call(`api/google/token${refresh ? "?refresh=1" : ""}`); known = true; return r.accessToken; }
      catch (e) { known = false; throw e && e.code ? { code: "google_auth", message: e.message } : authError("Connect your Google account first."); }
    },
    async disconnect() { await call("api/google/disconnect", { method: "POST" }); known = false; },
  };
}

/** Browser extension: Chrome's own sign-in window (chrome.identity), returning a token for the extension's client id. */
export function extensionAuth({ clientId, identity = globalThis.chrome && globalThis.chrome.identity, storage = globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local, now = () => Date.now() } = {}) {
  const KEY = "cold.google.connected";
  let tok = null, known = false;
  const valid = () => tok && tok.expiresAt - now() > SKEW;
  const flow = interactive => new Promise((resolve, reject) => {
    const redirect = identity.getRedirectURL();
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: clientId, response_type: "token", redirect_uri: redirect, scope: GOOGLE_SCOPE, ...(interactive ? { prompt: "consent" } : { prompt: "none" }) })}`;
    identity.launchWebAuthFlow({ url, interactive }, back => {
      if (!back) return reject(authError(interactive ? "Google sign-in was closed." : "Google needs you to sign in again."));
      const p = new URLSearchParams(String(back).split("#")[1] || "");
      if (!p.get("access_token")) return reject(authError("Google didn't sign you in."));
      if (!String(p.get("scope") || GOOGLE_SCOPE).includes("drive.file")) return reject(authError("Google didn't give Cold access to the spreadsheet. Try again and tick the box."));
      tok = { token: p.get("access_token"), expiresAt: now() + (Number(p.get("expires_in")) || 3600) * 1000 }; known = true;
      resolve(tok.token);
    });
  });
  return {
    kind: "extension", configured: !!(clientId && identity),
    connected: () => !!valid() || known,
    async refreshState() { try { known = !!((await storage.get(KEY))[KEY]); } catch { known = false; } return known; },
    async connect() { await flow(true); try { await storage.set({ [KEY]: true }); } catch { /* session-only */ } },
    async token(refresh = false) {
      if (valid() && !refresh) return tok.token;
      if (!known) throw authError("Connect your Google account first.");
      try { return await flow(false); } catch (e) { tok = null; throw e; }
    },
    async disconnect() { tok = null; known = false; try { await storage.remove(KEY); } catch { /* ignore */ } },
  };
}
