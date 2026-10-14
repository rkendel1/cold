# 07. Security, privacy and data-authority assessment

This traces where information actually goes, from the code, and says which statements are verified by a test or probe and which are not. It makes **no compliance, encryption or security-guarantee claims** beyond what is shown. No secret was found or reproduced in the repository or in this audit (R9). Nothing here is a penetration test.

## 1. What data exists and where it goes

| Data | Stored where (by surface) | Sent to | Evidence |
|---|---|---|---|
| Lead records and imported CSV contents | Web `cold.leads` (localStorage) · Desktop SQLite `leads` · Ext `chrome.storage.local` · **with Sheets on: the user's spreadsheet** | Not to any model. A lead's name/company/role/`why` go into a draft prompt only when the user generates a draft for that lead. **With Sheets on, every lead field and extra field goes to Google** | `T:privacy` (Sheets off), `T:sheets` |
| Product knowledge | Local (same stores). Never in the sheet | Only this draft's external-use facts go to the model provider | `T:privacy`, `T:e2e` ("internal-only proof is never sent") |
| Prompts, AI inputs, model outputs | Outputs saved with the draft (subject, three sentences, `claims`, `checks`, `retrieved`, `draft`) | Hosted web: browser → *Cold's server* → provider. Desktop: local server → provider. Ext: browser → provider directly, or → paired desktop app → provider. On-device model: nowhere | `docs/privacy-and-data-flow.md`, `T:privacy` |
| Draft/outreach records (notes, statuses, sent copy, follow-up, handoffs) | Local; **with Sheets on, the Outreach tab: readable columns plus a `data` column holding the full record JSON, including notes, recipient email, sent copy, model claims** | Google, when Sheets is on | `src/domain/sheetsMap.js`, `T:sheets` |
| Provider API keys | Server env (web) · desktop `settings.json`: OS-keychain-encrypted when `safeStorage` is available, else a 0600 file · **extension: `chrome.storage.local`, not encrypted** | Only to that provider; the page gets `hasKey` and the last 4 characters | `lib/settings.js`, `server.js` `settingsSnapshot`, `T:server-security`; SEC-001 |
| Cold account and session (optional; hosted web, and desktop/extension signing in to the hosted server) | A SQLite file on the hosting server (desktop and extension hold only an in-memory bearer token: app server memory, `chrome.storage.session`) (`COLD_ACCOUNTS_DB_FILE`): account id, Google `sub`, display name, verified email, timestamps, hashed session ids and single-use sign-in states. Browser: one HttpOnly session cookie, nothing in storage | Google receives the sign-in (scopes `openid email profile`); the server gets one ID token and keeps none of Google's tokens. No library data is sent or linked | `T:auth`, `T:auth-e2e`, `T:account-native`, `T:account-surfaces-e2e` (stand-in Google; real Google unverified), [google-sign-in.md](../google-sign-in.md) |
| Google authorisation | Web: access token in page memory + a `cold.google.connected` flag · Desktop: **refresh token in `settings.json`** (same protection as provider keys); the page only ever receives short-lived access tokens · Ext: access token in memory + flag in `chrome.storage.local` | Google only | `lib/google.js`, `T:google-oauth` (the refresh token never appears in any response), `T:google-auth` |
| Email content for Gmail/Outlook/mailto | Not stored beyond the draft | Passed in a URL to the user's own mail client or a new tab on mail.google.com / outlook; **Cold has no Google authorisation for this** | `lib/mailto.js`, `T:mailto`, `T:handoff` |
| Email lookup (optional) | Candidate only until accepted | name/company-domain/LinkedIn link → Cold server → treg.to (+ its upstreams) | `docs/people-search.md`, `T:people` |
| Logs, diagnostics, telemetry | Server logs only a startup banner; no request logging; no analytics or crash reporting | none | `server.js` (3 `console` calls), `T:privacy` |
| Browser caches / backups / temp files | Browser profile storage and OS backups can copy local data off-device (documented). No temp files are written by Cold | | `docs/privacy-and-data-flow.md` |

**Local vs. provider vs. Google vs. Cold's backend.** *Local:* the whole library unless Sheets is on. *Model provider:* one draft's prompt at a time. *Google:* leads and outreach, only when the user sets up Sheets (plus the sign-in itself). *Cold's own backend* (hosted web only): sees each prompt in memory while forwarding it, stores nothing; the desktop server is local.

## 2. Trust boundaries and credentials

* **Server routes.** `/api/settings*` and `/api/google/*` (except the OAuth callback) require a loopback `Host`, same-origin, no `Authorization` header (so an extension cannot use them), and the access code when one is set (`guardLocal`, `guardSettings`). The OAuth callback is GET-only, loopback-only, accepts only a `state` the server issued (single use, 10-minute expiry), and returns a human page with `default-src 'none'`. Verified end-to-end in `T:google-oauth` (forged state → 400; extension header → 403; foreign origin → 403).
* **Extension ↔ desktop.** Pairing code; the extension can read/write products and drafts, generate, and look up public profiles and tweets, but cannot read or change provider keys, provider choice, allowed origins, or Google tokens (`T:extension`, `T:google-oauth` for the Google part).
* **Content-security-policy.** The page may contact only itself and loopback, **plus Google's Sheets and sign-in hosts if and only if a Google client id is configured** (`T:google-oauth`: with no client id the policy contains no Google host; a desktop server loads no Google script into the page). The *web* build additionally allows Google's sign-in script when configured. **Not verified: that this policy lets the real Google sign-in script work in a real Chrome** (SEC-004).
* **Secrets in source.** Pattern scan for common key formats over `src`, `lib`, `server.js`, `extension/src`, `desktop`, and the committed bundle found none (R9). `desktop/google.json` (client id/secret for the desktop OAuth client) is git-ignored and, if present when packaging, is included in the app (`package.json` `build.files` includes `desktop/**`). Google treats installed-app client secrets as non-confidential, but owners should know it ships (SEC-002).
* **Dependencies.** `npm audit --omit=dev`: 0 vulnerabilities. `npm audit` (including dev): one moderate advisory in the `electron-builder` toolchain (`sprintf-js` via `roarr`/`global-agent`), build-time only (SEC-005).

## 3. Source-of-truth and synchronisation semantics (Google Sheets)

Behaviour below is what the code does; "verified" means against the **stand-in** API (DATA-001).

| Question | Behaviour | Status |
|---|---|---|
| **Initial connection and existing data** | Setup (a) creates a spreadsheet with two tabs or attaches to one Cold made, (b) optionally copies the current leads and drafts in. A record whose id is already in the sheet is **left as it is**; nothing is overwritten. The local copy stays as a backup | Verified (`T:sheets-e2e`, `T:google-auth` connector test) |
| **What is the source of truth afterwards** | The sheet, for leads and outreach only. Products, settings, sign-off and the Write form stay in the surface's own storage | Verified; documented |
| **Every save** | Re-read the tab first, then write only that row (existing rows rewritten in place by their *current* row number; new rows appended). Inserts or reordering by someone else do not misdirect the write | Verified |
| **Columns the person added** | Leads: unknown columns become **extra fields** (up to 20, names ≤ 60 chars, values ≤ 2,000 chars) and are written back. Outreach and any other column: **kept untouched** when Cold saves the row. *(A defect found by this audit blanked these columns on every save; fixed in this PR: DATA-011.)* | Verified after fix |
| **Field mapping / schema evolution** | Columns are matched by heading (case/spacing/punctuation ignored), in any order. Missing Cold columns are added to the heading row; missing tabs are re-created at start-up | Verified |
| **Conflicts** | *Outreach:* each save carries the version it was based on; a stale save is merged field-by-field if the changes don't overlap, otherwise refused with a visible message (the newer value is kept). *Leads (and products): **no version is sent: two devices editing the same lead is last-writer-wins.** This is true on every backend, not just Sheets: `store.saveLead`/`saveProduct` write unconditionally and only outreach records (`saveEmail`) carry a version* (DATA-004, characterised by a test for Sheets). A change typed into the sheet itself is read at the next read; if it lands between Cold's read and write (milliseconds) it can be overwritten (Sheets offers no conditional write) | Verified (outreach); Confirmed limitation (leads) |
| **Retry and idempotency** | Records are keyed by id, so re-running an import or a failed save never duplicates. 429/5xx are retried with backoff (2 retries). Auth failures are not retried silently | Verified |
| **Partial and failed writes** | An import is up to three calls (heading fix, in-place updates, append). A failure between them leaves a partial result; the next read shows the truth and a retry completes it. Not tested as a partial failure (DATA-006, Hypothesis) | Partly verified |
| **Disconnect / revocation** | *Stop using Google Sheets* copies the sheet's current contents back into local storage, forgets the link, **signs out and asks Google to revoke** (web: when a token is held in the page; desktop: the server revokes the refresh token; extension: forgets its flag, no revoke call). The spreadsheet is untouched. *(Before this PR the sign-out did not happen: DATA-003.)* If a user revokes access at Google instead, the next call fails with "sign in again" and Settings offers *Reconnect* | Verified (web); desktop at route level |
| **Source switching** | Defined: local → Sheets (copy in) and Sheets → local (copy back). **Not defined:** Sheet A → Sheet B (the connector can only attach one), two devices on different sources, or "merge two sheets" | Gap (PARITY-002) |
| **Stale or corrupted state** | A sheet with a damaged heading row is rebuilt from the fixed columns. A malformed `data` cell is ignored and the readable columns are used. An unreadable sheet at start-up: the app opens with **no leads or drafts shown, a banner, and an error status in Settings** (added by this audit); no local cache is used | Verified (banner); DATA-005/-007 |
| **Local SQLite** | Outreach writes are versioned and merge-or-refuse; lead and product writes are unconditional. An unreadable row is **omitted from the app's view without a warning** (the row stays in the file) (DATA-008, R6). The schema migrates in place (v1→v2 tested) | Verified; gap |

## 4. Verified risks and gaps

| ID | Risk | Severity | State |
|---|---|---|---|
| SEC-001 | Extension stores provider keys unencrypted in `chrome.storage.local`; anyone with the browser profile can read them | Medium (documented, labelled in the UI) | Confirmed; accepted/documented |
| SEC-002 | A desktop Google client secret placed in `desktop/google.json` is packaged into the app | Low | Hypothesis (informational) |
| SEC-003 | Hosted web without `COLD_ACCESS_TOKEN` exposes the generation endpoint to anyone; rate limit is per instance, in memory | Medium | Confirmed; documented (README, startup warning) |
| SEC-004 | Real Google sign-in under the page's CSP, and `chrome.identity` flow (`response_type=token`), not exercised in real Chrome | Low–Medium | Hypothesis (Unverified) |
| SEC-005 | Dev-toolchain advisory (`sprintf-js`) | Low | Confirmed; build-time only |
| SEC-006 | README/`privacy-and-data-flow.md` said there is no cloud storage or account; false once Sheets exists | High (materially misleading) | **Fixed in this PR** |
| DATA-003 | "Stop" left Google authorised | Medium | **Fixed in this PR** |
| DATA-011 | Cold blanked user-added Outreach columns on save | High (data loss) | **Fixed in this PR** |
| DATA-004, -005, -007, -008, -009 | LWW leads; empty-on-unreadable; no offline; silent row omission; no export/erase | Medium | Open ([11](11-remediation-backlog.md)) |

No vulnerability requiring private disclosure was found; the items above are product or documentation defects. The repository has no `SECURITY.md` or stated reporting process (DOCS-005): vulnerabilities should be escalated through whichever route the owner designates once one exists.

## 5. What this assessment does not establish

Encryption at rest beyond the OS keychain call for desktop keys (the code calls `safeStorage` when available; behaviour on each OS was not observed); any property of Google's, a model provider's or treg's systems; the behaviour of a real browser profile's sync or backup; data-retention behaviour of any third party.
