# Google sign-in and Cold accounts (foundation)

**Status: implemented and tested against a stand-in for Google. Not verified against real Google, and not deployed anywhere by this change.** This is an identity foundation only. Nothing is stored in an account yet.

## What it is and what it isn't

* **Is:** an optional "Sign in with Google" for the **hosted web app**, a stable internal Cold account id for each Google identity, and a server-side session so the server knows who is asking.
* **Isn't:** cloud storage, sync, billing, team features, or any Gmail or Google Sheets access. Signing in **does not** give Cold access to Gmail or Sheets and does not claim you connected either (that is the separate, optional Google Sheets setting). Your products, drafts and leads stay where they are (browser, desktop file, extension) and are **not** moved, uploaded or linked to your account. Hosted account-owned data and cross-device sync are **future work** that will define their own migration.
* **Local-only use is unchanged.** No sign-in is required for anything. With no sign-in configured, none of this appears.

## Supported surfaces

| Surface | Sign-in |
|---|---|
| Hosted / self-hosted **web** (server run with the settings below) | **Yes** (Settings > Cold account) |
| **Desktop app** and local installs (`COLD_DB_FILE` / `COLD_SETTINGS_FILE` set) | No: sign-in is disabled even if the variables are set |
| **Browser extension** | No; no cookie, secret or session is ever copied into extension storage, and there is no cross-surface token sharing |

## Identity information

Cold receives Google's ID token (once, server to server) and keeps **only**: Google's `sub` (the stable external identity), your display name, your email address **if Google says it is verified**, a random internal account id (`acc_…`), and timestamps. No picture, locale, Google access or refresh token, or ID token is kept. The email and name are profile attributes: they are refreshed on each sign-in, they never change your account id, and **two different Google identities with the same email are two accounts** (no automatic merging). Stored in the accounts SQLite file the operator configures; signing out does not delete the account record.

**Scopes requested:** `openid email profile`, only. No Gmail, Sheets or Drive scope, and no offline access. Sign-out **ends Cold's session only**; it does not sign you out of Google and does not revoke anything at Google (there is nothing to revoke: no API permission is requested).

## How it works

Authorization Code flow with PKCE, run by the server.

1. `POST /api/account/login` (same-origin only): the server stores a random `state`, `nonce` and PKCE verifier, and sets a short-lived HttpOnly "binder" cookie so only this browser can finish. It returns Google's URL; the page navigates there.
2. `GET /oauth/account/callback`: the state is **single-use** and must match the binder cookie. The server exchanges the code with its client secret and the verifier, then checks the ID token: RS256 signature against Google's published keys, `iss`, `aud`, expiry, `nonce`. Only then is the account found or created **by `sub`** (one transaction; a primary key makes concurrent first sign-ins resolve to one account) and a **new** session issued; any session cookie from before is destroyed. Every failure shows the same generic "didn't complete" result, creates no session, and says nothing about whether an account exists.
3. `GET /api/account/me`: the account for the session cookie. The browser can't name an account: ids, headers and parameters it sends are ignored. 401 when there is no valid session.
4. `POST /api/account/logout`: same-origin and a CSRF token (derived from the session by an HMAC with `COLD_SESSION_SECRET`, returned by `/me`) required; the server deletes the session and clears the cookie.

**Sessions.** A random 256-bit id in a cookie; the server stores only a keyed hash of it. HttpOnly, `SameSite=Lax`, `Path=/`, no `Domain`; over https the cookie is named `__Host-cold_session` and `Secure`. Fixed lifetime (default 7 days, `COLD_SESSION_TTL_HOURS`), no sliding renewal. Nothing about the session or Google is put in localStorage.

**Return address.** The only places sign-in can send you back to are the allow-listed paths in `COLD_AUTH_RETURN_PATHS` (default `/`); the redirect URI sent to Google is the single configured value.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `COLD_AUTH_GOOGLE_CLIENT_ID` | to turn it on | Google "Web application" OAuth client id. Unset = feature off |
| `COLD_AUTH_GOOGLE_CLIENT_SECRET` | yes, once on | Server-side only; never sent to the browser |
| `COLD_AUTH_REDIRECT_URI` | yes | Exactly `https://<your-host>/oauth/account/callback` (plain `http://localhost…` only outside production) |
| `COLD_SESSION_SECRET` | yes | 32+ random characters (`openssl rand -base64 32`). Keys session hashes and CSRF tokens. Changing it signs everyone out |
| `COLD_ACCOUNTS_DB_FILE` | yes | Path of the SQLite accounts file. **Needs storage that survives restarts and Node 22.13+** |
| `COLD_SESSION_TTL_HOURS` | no | 1 to 2160, default 168 |
| `COLD_AUTH_RETURN_PATHS` | no | Comma-separated allowed return paths, default `/` |
| `COLD_AUTH_GOOGLE_AUTH_URL`, `_TOKEN_URL`, `_JWKS_URL` | no | **Tests only**; refused in production |

If `COLD_AUTH_GOOGLE_CLIENT_ID` is set but anything required is missing or invalid (including a non-https redirect URI in production), **the server refuses to start** and the message names the settings, never their values. Production means `NODE_ENV=production` or `VERCEL_ENV=production`. Secrets belong in the environment, never in the repository ([.env.example](../.env.example) has placeholders only).

**Why a new persistence mechanism.** The hosted server deliberately has no database (it is serverless-friendly), and sessions and accounts must outlive a request. A small SQLite file (the engine `lib/db.js` already uses) is the minimum that gives atomic account creation and revocable sessions without a new dependency. **It therefore cannot run on a platform with no persistent disk** (for example plain Vercel serverless functions): there, leave sign-in unconfigured, or put the accounts file on a mounted volume. No other service or framework was added.

**Deployment topology.** Cookies are same-origin: the page, the API and the callback must be served from one host (`COLD_AUTH_REDIRECT_URI`'s host). Requests to account routes with a different `Host`, `Origin` or `Sec-Fetch-Site` are refused. A reverse proxy must pass `Host` through unchanged and terminate https; running several instances works because all state is in the one file, but they must share that file.

## Google Cloud Console setup

1. Create (or choose) a Google Cloud project; **APIs & Services > OAuth consent screen**: user type External (or Internal for a Workspace); app name, support email.
2. **Scopes:** add only `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. These are non-sensitive scopes, so **Google's app verification is not required for them**; while the consent screen is in *Testing*, only listed **test users** can sign in (up to 100) and Google shows a warning. Publish it to "In production" for the public.
3. **Credentials > Create credentials > OAuth client ID > Web application.** *Authorized JavaScript origins:* not needed for this server-side flow. *Authorized redirect URIs:* exactly your `COLD_AUTH_REDIRECT_URI` (add `http://localhost:3000/oauth/account/callback` for development). Use a **separate client per environment** so redirect URIs and cookie behaviour are configured per environment.
4. Copy the client id and secret into the server's environment. Don't paste them into chat, an issue, or a commit.

**Local development:** a `.env` with the variables above, `COLD_AUTH_REDIRECT_URI=http://localhost:3000/oauth/account/callback`, and `COLD_ACCOUNTS_DB_FILE=./dev-accounts.db` (keep it out of version control). Open the app at `http://localhost:3000` (not 127.0.0.1: the host must match the redirect URI).

## Verification status

* **Automated (stand-in Google):** `test/auth.test.js` (13) and `test/auth-e2e.test.js` (4). They cover state, nonce, issuer, audience, signature, algorithm and expiry rejection; callback errors; unapproved return paths and cross-site requests; one account per subject under concurrency; profile changes; no email merging; client-supplied ids ignored; session rotation, expiry and logout; cookie attributes for http and production (`__Host-`, `Secure`) configurations; no secrets in responses or captured logs; and that unconfigured or desktop use is unaffected. **These prove Cold's own logic. They do not prove that real Google sign-in works.**
* **Live smoke test (not yet run):** with a real client in a deployed, https environment: (1) sign in with a test user and confirm Google's consent screen lists only name/email/profile; (2) confirm the browser's cookie jar shows `__Host-cold_session` as `HttpOnly; Secure; SameSite=Lax` and that localStorage holds nothing from sign-in; (3) reload and confirm you stay signed in; (4) sign out and confirm the cookie is gone and `/api/account/me` returns 401; (5) deny consent and confirm "chose not to sign in" with no session; (6) sign in on a second browser with the same Google account and confirm the same account (the operator can check one row in `accounts`). Record the date and build.

## Known limitations

* Not verified against real Google, and not production-ready until the live smoke test above has been run on the deployed callback.
* Requires a persistent disk and Node 22.13+; not available on stateless serverless hosting.
* No account deletion, export or data-ownership features yet; sign-out keeps the account record; there is no "sign out everywhere" and no session list.
* Fixed (non-sliding) session lifetime; a session ends at expiry even if you are active.
* Account records are not encrypted at rest beyond what the host's disk provides; session ids and sign-in states are stored only as keyed hashes.
* Rate limiting on sign-in routes is per instance, in memory.
