// Google sign-in for the HOSTED web app, and the Cold session that follows it. Identity only: the scopes are openid, email and profile, nothing else, and
// no Google token is kept after the ID token has been checked. Sign-in does not give Cold access to Gmail or Sheets and does not own any data yet.
//
// Flow (Authorization Code with PKCE, run by this server):
//   POST /api/account/login      -> state, nonce, PKCE verifier and a browser "binder" cookie are stored; the page gets Google's URL and navigates to it
//   GET  /oauth/account/callback -> state is single-use and must match the binder cookie; the code is exchanged server to server (client secret + verifier);
//                                   the ID token's signature (RS256, Google's keys), issuer, audience, expiry and nonce are checked; only then an account is found
//                                   or created by Google's `sub` and a NEW session is issued (any old one is destroyed)
//   GET  /api/account/me         -> the account for the session cookie. Nothing the browser sends can choose the account
//   POST /api/account/logout     -> same-origin and CSRF-token protected; the server-side session is deleted
const crypto = require("node:crypto");
const { createAccounts } = require("./accounts");

const CALLBACK_PATH = "/oauth/account/callback";
const SCOPE = "openid email profile";
const DEFAULT_URLS = { authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", jwksUrl: "https://www.googleapis.com/oauth2/v3/certs" };
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const TXN_MS = 10 * 60 * 1000, SKEW_S = 60;

/** Which kind of app a redirect URI belongs to: an extension (Chrome's identity redirect) or the desktop app (its fixed loopback callback). null = not acceptable. */
function nativeClientOf(uri) {
  let u; try { u = new URL(uri); } catch { return null; }
  if (u.search || u.hash || u.username || u.password) return null;
  if (u.protocol === "https:" && /^[a-p]{32}\.chromiumapp\.org$/.test(u.host) && u.pathname === "/") return "extension";
  if (u.protocol === "http:" && /^(127\.0\.0\.1|localhost):\d{2,5}$/.test(u.host) && u.pathname === "/oauth/account/callback") return "desktop";
  return null;
}
const extensionOriginOf = uri => { const m = /^https:\/\/([a-p]{32})\.chromiumapp\.org\/$/.exec(uri); return m ? `chrome-extension://${m[1]}` : null; };
const isLoopback = h => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h);

/** Reads the environment into a config, or { enabled: false }. Throws a clear error (naming variables, never values) when it is partly configured. */
function readConfig(env = process.env) {
  const production = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  const clientId = env.COLD_AUTH_GOOGLE_CLIENT_ID || "";
  if (!clientId) return { enabled: false, reason: "not_configured" };
  if (env.COLD_SETTINGS_FILE || env.COLD_DB_FILE) return { enabled: false, reason: "local_install" };   // desktop and local installs keep working locally; sign-in is for the hosted web app
  const problems = [];
  const clientSecret = env.COLD_AUTH_GOOGLE_CLIENT_SECRET || "", sessionSecret = env.COLD_SESSION_SECRET || "", file = env.COLD_ACCOUNTS_DB_FILE || "";
  if (!clientSecret) problems.push("COLD_AUTH_GOOGLE_CLIENT_SECRET is not set");
  if (sessionSecret.length < 32) problems.push("COLD_SESSION_SECRET must be at least 32 characters (for example: openssl rand -base64 32)");
  if (!file) problems.push("COLD_ACCOUNTS_DB_FILE is not set (a path on storage that survives restarts)");
  let redirect = null;
  try { redirect = new URL(env.COLD_AUTH_REDIRECT_URI || ""); } catch { /* reported below */ }
  if (!redirect) problems.push("COLD_AUTH_REDIRECT_URI is not set to a full URL");
  else {
    if (redirect.pathname !== CALLBACK_PATH || redirect.search || redirect.hash) problems.push(`COLD_AUTH_REDIRECT_URI must end with exactly ${CALLBACK_PATH}`);
    if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && isLoopback(redirect.host) && !production)) problems.push("COLD_AUTH_REDIRECT_URI must be https (plain http only for localhost outside production)");
  }
  const overrides = ["COLD_AUTH_GOOGLE_AUTH_URL", "COLD_AUTH_GOOGLE_TOKEN_URL", "COLD_AUTH_GOOGLE_JWKS_URL"].filter(k => env[k]);
  if (production && overrides.length) problems.push(`${overrides.join(", ")} are for tests and must not be set in production`);
  // Hosted libraries (optional): their own file, never the accounts file, and in production never a temporary or relative location.
  const pathMod = require("node:path"), dataFile = env.COLD_DATA_DB_FILE || "";
  if (dataFile) {
    const abs = pathMod.resolve(dataFile), tmp = [require("node:os").tmpdir(), "/tmp", "/var/tmp"];
    if (file && abs === pathMod.resolve(file)) problems.push("COLD_DATA_DB_FILE must be a different file from COLD_ACCOUNTS_DB_FILE");
    if (production && (!pathMod.isAbsolute(dataFile) || tmp.some(t => abs === t || abs.startsWith(t + pathMod.sep)))) problems.push("COLD_DATA_DB_FILE must be an absolute path on persistent storage (not a temporary directory) in production");
  }
  if (production && file && (!pathMod.isAbsolute(file) || file === ":memory:")) problems.push("COLD_ACCOUNTS_DB_FILE must be an absolute path on persistent storage in production");
  // Desktop and extension sign-in (optional): exact redirect URIs the server will accept, each registered with Google for the same web client.
  const nativeRedirects = String(env.COLD_AUTH_NATIVE_REDIRECTS || "").split(",").map(x => x.trim()).filter(Boolean);
  for (const r of nativeRedirects) if (!nativeClientOf(r)) problems.push("COLD_AUTH_NATIVE_REDIRECTS entries must be https://<extension-id>.chromiumapp.org/ or http://127.0.0.1:<port>/oauth/account/callback (or localhost)");
  const nativeH = env.COLD_NATIVE_SESSION_HOURS === undefined || env.COLD_NATIVE_SESSION_HOURS === "" ? 168 : Number(env.COLD_NATIVE_SESSION_HOURS);
  if (!Number.isFinite(nativeH) || nativeH < 1 || nativeH > 24 * 90) problems.push("COLD_NATIVE_SESSION_HOURS must be between 1 and 2160");
  const rate = env.COLD_AUTH_RATE_LIMIT_PER_MIN === undefined || env.COLD_AUTH_RATE_LIMIT_PER_MIN === "" ? 30 : Number(env.COLD_AUTH_RATE_LIMIT_PER_MIN);
  if (!Number.isInteger(rate) || rate < 1 || rate > 100000) problems.push("COLD_AUTH_RATE_LIMIT_PER_MIN must be a whole number from 1 to 100000");
  const ttlH = env.COLD_SESSION_TTL_HOURS === undefined || env.COLD_SESSION_TTL_HOURS === "" ? 168 : Number(env.COLD_SESSION_TTL_HOURS);
  if (!Number.isFinite(ttlH) || ttlH < 1 || ttlH > 24 * 90) problems.push("COLD_SESSION_TTL_HOURS must be between 1 and 2160");
  const returnPaths = String(env.COLD_AUTH_RETURN_PATHS || "/").split(",").map(s => s.trim()).filter(Boolean);
  if (!returnPaths.every(p => /^\/[A-Za-z0-9/_.-]*$/.test(p) && !p.startsWith("//"))) problems.push("COLD_AUTH_RETURN_PATHS must be a comma-separated list of absolute paths");
  if (problems.length) throw new Error(`Cold sign-in is configured incompletely, so the server will not start: ${problems.join("; ")}.`);
  return { enabled: true, production, dataFile, rateLimit: rate, clientId, nativeRedirects, nativeTtlMs: nativeH * 3600 * 1000, clientSecret, sessionSecret, file, redirectUri: redirect.href, host: redirect.host, secure: redirect.protocol === "https:", ttlMs: ttlH * 3600 * 1000, returnPaths,
    urls: { authUrl: env.COLD_AUTH_GOOGLE_AUTH_URL || DEFAULT_URLS.authUrl, tokenUrl: env.COLD_AUTH_GOOGLE_TOKEN_URL || DEFAULT_URLS.tokenUrl, jwksUrl: env.COLD_AUTH_GOOGLE_JWKS_URL || DEFAULT_URLS.jwksUrl } };
}

// ---- ID token verification -----------------------------------------------------------------------------------------
const b64json = s => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
class AuthError extends Error { constructor(code) { super(code); this.code = code; } }

/** Verifies a Google ID token and returns its claims, or throws AuthError(code). Only RS256 with a key from Google's published set is accepted. */
function verifyIdToken(token, { keys, clientId, nonce, nowS, issuers = ISSUERS }) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw new AuthError("token_malformed");
  let header, claims;
  try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { throw new AuthError("token_malformed"); }
  if (!header || header.alg !== "RS256") throw new AuthError("token_alg");
  const jwk = (keys || []).find(k => k.kid && k.kid === header.kid && k.kty === "RSA");
  if (!jwk) throw new AuthError("token_key");
  let ok = false;
  try { ok = crypto.createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url")); } catch { ok = false; }
  if (!ok) throw new AuthError("token_signature");
  if (!claims || typeof claims !== "object") throw new AuthError("token_malformed");
  if (!issuers.includes(claims.iss)) throw new AuthError("token_issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId) || (aud.length > 1 && claims.azp !== clientId)) throw new AuthError("token_audience");
  if (!Number.isFinite(claims.exp) || claims.exp + SKEW_S <= nowS) throw new AuthError("token_expired");
  if (Number.isFinite(claims.iat) && claims.iat - SKEW_S > nowS) throw new AuthError("token_future");
  if (typeof claims.nonce !== "string" || claims.nonce !== nonce) throw new AuthError("token_nonce");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new AuthError("token_subject");
  return claims;
}

const parseCookies = h => Object.fromEntries(String(h || "").split(";").map(p => { const i = p.indexOf("="); return i < 0 ? null : [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }).filter(Boolean));

function createAuth({ env = process.env, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), send, config = null } = {}) {
  const cfg = config || readConfig(env);
  if (!cfg.enabled) {
    const off = (req, res) => send(res, 404, { error: { code: "account_disabled", message: "Sign-in isn't available here. Cold works without it." } });
    return { enabled: false, reason: cfg.reason, publicConfig: () => ({ enabled: false }), authenticate: () => null, handle: (req, res, url) => (url.pathname.startsWith("/api/account/") || url.pathname === CALLBACK_PATH ? (off(req, res), true) : false), close() {} };
  }
  const accounts = createAccounts({ file: cfg.file, secret: cfg.sessionSecret, now });
  const prefix = cfg.secure ? "__Host-" : "";
  const SESSION = `${prefix}cold_session`, TXN = `${prefix}cold_signin`;
  const cookie = (name, value, maxAgeS) => `${name}=${value}; Path=/; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${cfg.secure ? "; Secure" : ""}`;
  const expire = name => cookie(name, "", 0);
  let jwks = { keys: [], at: 0 };
  async function keysFor(kid) {
    const fresh = now() - jwks.at < 3600 * 1000;
    if (fresh && jwks.keys.some(k => k.kid === kid)) return jwks.keys;
    if (jwks.at && now() - jwks.at < 60 * 1000) return jwks.keys;            // don't refetch more than once a minute, whatever token arrives
    const r = await fetchImpl(cfg.urls.jwksUrl, { headers: { accept: "application/json" } });
    if (!r.ok) throw new AuthError("keys_unavailable");
    const body = await r.json().catch(() => null);
    if (!body || !Array.isArray(body.keys)) throw new AuthError("keys_unavailable");
    jwks = { keys: body.keys, at: now() };
    return jwks.keys;
  }

  const fail = (res, code, extra = []) => send(res, 302, "", "text/plain", { location: `/?signin=${code}#/settings`, "set-cookie": [expire(TXN), ...extra] });
  const sameOrigin = req => {
    if (req.headers.host !== cfg.host) return false;
    const site = req.headers["sec-fetch-site"]; if (site && site !== "same-origin") return false;
    const origin = req.headers.origin; if (origin) { let h = ""; try { h = new URL(origin).host; } catch { /* not a url */ } if (h !== req.headers.host) return false; }
    return true;
  };
  const bad = (res, status, code, message) => send(res, status, { error: { code, message } });
  const sessionOf = req => { const id = parseCookies(req.headers.cookie)[SESSION]; const a = id ? accounts.sessionAccount(id) : null; return a ? { id, account: a, via: "cookie" } : null; };
  const hits = new Map();
  const limited = req => { const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim(), t = now(), list = (hits.get(ip) || []).filter(x => t - x < 60000); list.push(t); hits.set(ip, list); if (hits.size > 5000) hits.clear(); return list.length > (cfg.rateLimit || 30); };

  async function readJson(req, max = 2048) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > max) throw new AuthError("too_large"); chunks.push(c); }
    try { const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
  }


  // ---- desktop and extension: bearer sessions, CORS for the registered extensions only ----------------------------------
  const redirects = new Set(cfg.nativeRedirects || []);
  const extOrigins = new Set([...redirects].map(extensionOriginOf).filter(Boolean));
  const corsFor = req => { const o = req.headers.origin; return o && extOrigins.has(o) ? { "access-control-allow-origin": o, vary: "Origin", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "600" } : {}; };
  /** A native client call carries no cookie. A browser page from some other origin must not be able to drive it: Origin is absent (desktop shell, curl) or one registered extension. */
  const originOk = req => !req.headers.origin || extOrigins.has(req.headers.origin);
  const bearerOf = req => { const m = /^Bearer (\S{20,200})$/.exec(req.headers.authorization || ""); return m ? m[1] : ""; };
  const nsend = (req, res, status, body, extra = {}) => send(res, status, body, undefined, { ...corsFor(req), ...extra });
  const nerr = (req, res, status, code, message) => nsend(req, res, status, { error: { code, message } });
  const nativeSession = req => { if (!originOk(req)) return null; const id = bearerOf(req); const a = id ? accounts.sessionAccount(id, "native") : null; return a ? { id, account: a, via: "bearer" } : null; };

  async function nativeHandle(req, res, url) {
    const p = url.pathname;
    const isNativeRoute = p === "/api/account/native/begin" || p === "/api/account/native/complete" || ((p === "/api/account/me" || p === "/api/account/logout") && req.headers.authorization);
    if (req.method === "OPTIONS" && (p.startsWith("/api/account/native/") || p === "/api/account/me" || p === "/api/account/logout")) {
      if (!extOrigins.has(req.headers.origin || "")) return nerr(req, res, 403, "bad_origin", "Not allowed."), true;
      return send(res, 204, "", "text/plain", corsFor(req)), true;
    }
    if (!isNativeRoute && !p.startsWith("/api/account/native/")) return false;
    if (!redirects.size) return nerr(req, res, 404, "native_disabled", "Desktop and extension sign-in aren't set up on this server."), true;
    if (!originOk(req)) return nerr(req, res, 403, "bad_origin", "Cross-site requests are not allowed."), true;
    if (p === "/api/account/native/begin" && req.method === "POST") {
      if (limited(req)) return nerr(req, res, 429, "rate_limited", "Too many attempts. Wait a minute and try again."), true;
      let body; try { body = await readJson(req); } catch { return nerr(req, res, 413, "too_large", "Request too large."), true; }
      const kind = nativeClientOf(typeof body.redirectUri === "string" ? body.redirectUri : "");
      if (!kind || body.client !== kind || !redirects.has(body.redirectUri)) return nerr(req, res, 400, "bad_redirect", "That sign-in address isn't registered."), true;
      if (kind === "extension" && req.headers.origin !== extensionOriginOf(body.redirectUri)) return nerr(req, res, 403, "bad_origin", "Not allowed."), true;   // an extension may only ask for its own redirect
      if (typeof body.proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.proof)) return nerr(req, res, 400, "bad_request", "Bad request."), true;
      const t = accounts.beginNativeSignIn({ client: kind, redirectUri: body.redirectUri, proofHash: body.proof, ttlMs: TXN_MS });
      const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: body.redirectUri, response_type: "code", scope: SCOPE, state: t.state, nonce: t.nonce,
        code_challenge: crypto.createHash("sha256").update(t.verifier).digest("base64url"), code_challenge_method: "S256", include_granted_scopes: "false" });
      return nsend(req, res, 200, { authUrl: `${cfg.urls.authUrl}?${q}`, state: t.state, expiresInSeconds: TXN_MS / 1000 }), true;
    }
    if (p === "/api/account/native/complete" && req.method === "POST") {
      if (limited(req)) return nerr(req, res, 429, "rate_limited", "Too many attempts. Wait a minute and try again."), true;
      let body; try { body = await readJson(req, 4096); } catch { return nerr(req, res, 413, "too_large", "Request too large."), true; }
      const txn = accounts.takeNativeSignIn({ state: body.state, proof: body.proof });
      const refuse = () => nerr(req, res, 400, "signin_failed", "Sign-in didn't complete. Nothing was changed. Try again.");     // one answer for every cause
      if (!txn || typeof body.code !== "string" || !body.code || body.code.length > 2048) return refuse(), true;
      if (req.headers.origin && txn.client === "extension" && req.headers.origin !== extensionOriginOf(txn.redirectUri)) return refuse(), true;
      try {
        const r = await fetchImpl(cfg.urls.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ code: body.code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: txn.redirectUri, grant_type: "authorization_code", code_verifier: txn.verifier }).toString() });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || typeof data.id_token !== "string") throw new AuthError("exchange_failed");
        const kid = (() => { try { return b64json(data.id_token.split(".")[0]).kid; } catch { return ""; } })();
        const claims = verifyIdToken(data.id_token, { keys: await keysFor(kid), clientId: cfg.clientId, nonce: txn.nonce, nowS: Math.floor(now() / 1000) });
        const { id: accountId } = accounts.resolveAccount({ provider: "google", subject: claims.sub, name: claims.name || claims.given_name || "", email: claims.email_verified === true ? claims.email : "" });
        const s = accounts.createSession(accountId, cfg.nativeTtlMs, "native");
        const a = accounts.sessionAccount(s.id, "native");
        nsend(req, res, 200, { token: s.id, expiresAt: s.expiresAt, account: { name: a.name, email: a.email } });
      } catch { refuse(); }
      return true;
    }
    if (p === "/api/account/me" && req.method === "GET") {
      const s = nativeSession(req);
      if (!s) return nerr(req, res, 401, "not_signed_in", "You're not signed in."), true;
      return nsend(req, res, 200, { signedIn: true, account: { name: s.account.name, email: s.account.email }, expiresAt: s.account.expiresAt }), true;
    }
    if (p === "/api/account/logout" && req.method === "POST") {      // a bearer token is not ambient (the browser never adds it), so there is no CSRF to guard; origin was checked above
      const id = bearerOf(req); if (id && nativeSession(req)) accounts.destroySession(id);
      return nsend(req, res, 200, { signedOut: true }), true;
    }
    return nerr(req, res, 405, "method_not_allowed", "Not allowed."), true;
  }

  async function handle(req, res, url) {
    if (await nativeHandle(req, res, url)) return true;
    const p = url.pathname;
    if (p === "/api/account/login" && req.method === "POST") {
      if (!sameOrigin(req)) return bad(res, 403, "bad_origin", "Cross-site requests are not allowed."), true;
      if (limited(req)) return bad(res, 429, "rate_limited", "Too many attempts. Wait a minute and try again."), true;
      let body; try { body = await readJson(req); } catch { return bad(res, 413, "too_large", "Request too large."), true; }
      const returnTo = body.returnTo === undefined ? "/" : body.returnTo;
      if (typeof returnTo !== "string" || !cfg.returnPaths.includes(returnTo)) return bad(res, 400, "bad_return", "That return address isn't allowed."), true;
      const t = accounts.beginSignIn({ returnTo, ttlMs: TXN_MS });
      const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: SCOPE, state: t.state, nonce: t.nonce,
        code_challenge: crypto.createHash("sha256").update(t.verifier).digest("base64url"), code_challenge_method: "S256", include_granted_scopes: "false" });
      send(res, 200, { url: `${cfg.urls.authUrl}?${q}` }, undefined, { "set-cookie": cookie(TXN, t.binder, TXN_MS / 1000) });
      return true;
    }
    if (p === CALLBACK_PATH && req.method === "GET") {
      if (limited(req)) return fail(res, "failed"), true;
      const txn = accounts.takeSignIn({ state: url.searchParams.get("state") || "", binder: parseCookies(req.headers.cookie)[TXN] });
      if (!txn) return fail(res, "expired"), true;                                            // unknown, used, expired or another browser's: never a session
      if (url.searchParams.get("error")) return fail(res, url.searchParams.get("error") === "access_denied" ? "cancelled" : "failed"), true;
      const code = url.searchParams.get("code") || "";
      if (!code || code.length > 2048) return fail(res, "failed"), true;
      try {
        const r = await fetchImpl(cfg.urls.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code", code_verifier: txn.verifier }).toString() });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || typeof data.id_token !== "string") throw new AuthError("exchange_failed");
        const kid = (() => { try { return b64json(data.id_token.split(".")[0]).kid; } catch { return ""; } })();
        const claims = verifyIdToken(data.id_token, { keys: await keysFor(kid), clientId: cfg.clientId, nonce: txn.nonce, nowS: Math.floor(now() / 1000) });
        const { id: accountId } = accounts.resolveAccount({ provider: "google", subject: claims.sub, name: claims.name || claims.given_name || "", email: claims.email_verified === true ? claims.email : "" });
        const old = parseCookies(req.headers.cookie)[SESSION]; if (old) accounts.destroySession(old);   // rotate: a session id from before sign-in is never reused
        const s = accounts.createSession(accountId, cfg.ttlMs);
        send(res, 302, "", "text/plain", { location: `${txn.returnTo}?signin=ok#/settings`, "set-cookie": [expire(TXN), cookie(SESSION, s.id, Math.floor(cfg.ttlMs / 1000))] });
      } catch { fail(res, "failed"); }                                                       // one generic outcome: nothing says which check failed or whether an account exists
      return true;
    }
    if (p === "/api/account/me" && req.method === "GET") {
      const s = sessionOf(req);
      if (!s) return send(res, 401, { error: { code: "not_signed_in", message: "You're not signed in." } }, undefined, parseCookies(req.headers.cookie)[SESSION] ? { "set-cookie": expire(SESSION) } : {}), true;
      send(res, 200, { signedIn: true, account: { name: s.account.name, email: s.account.email }, csrf: accounts.csrfFor(s.id), expiresAt: s.account.expiresAt });
      return true;
    }
    if (p === "/api/account/logout" && req.method === "POST") {
      if (!sameOrigin(req)) return bad(res, 403, "bad_origin", "Cross-site requests are not allowed."), true;
      const id = parseCookies(req.headers.cookie)[SESSION], s = sessionOf(req);
      if (s) {
        const want = Buffer.from(accounts.csrfFor(s.id)), got = Buffer.from(String(req.headers["x-cold-csrf"] || ""));
        if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return bad(res, 403, "bad_csrf", "That request wasn't recognised. Reload and try again."), true;
      }
      if (id) accounts.destroySession(id);
      send(res, 200, { signedOut: true }, undefined, { "set-cookie": expire(SESSION) });
      return true;
    }
    if (p.startsWith("/api/account/") || p === CALLBACK_PATH) return bad(res, 405, "method_not_allowed", "Not allowed."), true;
    return false;
  }
  /** The signed-in account for ANY client: a bearer token (desktop, extension) if the request carries Authorization, else the cookie session (web). Never both, never a client-named account. { id, account, via } or null. */
  const bearerSession = req => { const id = bearerOf(req); const a = id ? accounts.sessionAccount(id, "native") : null; return a ? { id, account: a, via: "bearer" } : null; };
  const authenticate = req => (req.headers.authorization ? bearerSession(req) : sessionOf(req));
  /** For account-data routes. A cookie is ambient, so writes need same-origin and the session's CSRF token; a bearer token is not ambient, so only the origin rule applies (no web page, only a registered extension). null = allowed. */
  const guard = (req, s, write) => {
    if (s.via === "bearer") return originOk(req) ? null : { status: 403, code: "bad_origin", message: "Cross-site requests are not allowed." };
    if (write) { if (!sameOrigin(req)) return { status: 403, code: "bad_origin", message: "Cross-site requests are not allowed." }; const want = Buffer.from(accounts.csrfFor(s.id)), got = Buffer.from(String(req.headers["x-cold-csrf"] || "")); return want.length === got.length && crypto.timingSafeEqual(want, got) ? null : { status: 403, code: "bad_csrf", message: "That request wasn't recognised. Reload and try again." }; }
    const site = req.headers["sec-fetch-site"]; return site && site !== "same-origin" ? { status: 403, code: "bad_origin", message: "Cross-site requests are not allowed." } : null;
  };
  return { enabled: true, publicConfig: () => ({ enabled: true, native: redirects.size > 0, hosted: !!cfg.dataFile }), authenticate, guard, corsFor, extOrigins, handle, accounts, config: { secure: cfg.secure, ttlMs: cfg.ttlMs }, close: () => accounts.close() };
}

module.exports = { createAuth, readConfig, verifyIdToken, AuthError, CALLBACK_PATH, SCOPE };
