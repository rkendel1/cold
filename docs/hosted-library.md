# Hosted library

**Status: implemented for the web app, the desktop app and the Chrome extension, tested against a stand-in for Google. Not verified against real Google, a packaged desktop app, or a Chrome Web Store build, and not deployed anywhere by this change. Not production-ready until the persistent-disk deployment and the live smoke test below have been run.**

Cold now has two separate places your work can live. You choose between them, explicitly. Cold never combines them.

| | **Local library** | **Hosted library** |
|---|---|---|
| Where | This device: browser storage (web), SQLite file (desktop), extension storage (extension) | One SQLite database on the Cold server you sign in to |
| Needs an account | No (the default, and unchanged) | Yes: your Google sign-in ([google-sign-in.md](google-sign-in.md)) |
| Who can reach it | This device only (or whatever you paired it with) | Web, desktop and extension, when signed in to the same account |
| Backed up by signing in | **No** | Not automatically: see "Backups" |

**Signing in does not switch libraries, and nothing is uploaded, imported, merged or synchronised, ever, by signing in, signing out, or switching.** Switching only changes which library the screens read and write. Both keep exactly what they hold.

## What lives in the hosted library

One library per Cold account (the account id comes from your sign-in session; email is never the key).

| Stored in the hosted library | Stays on the device |
|---|---|
| **Leads**, including extra fields | Model and provider settings, API keys, tokens, Google credentials |
| **Drafts** (outreach records): recipient, text, notes, status, sent copy, sent and reply times, hand-off history, follow-up dates and counts, lead and product references, any extra fields | The pairing with the desktop app; Google Sheets setup |
| **Products** (the facts drafts are written from) | Email-app choice (mailto vs Gmail) and Gmail account name |
| **Library settings**: sign-off, "add sign-off", follow-up rules | The Write form you are half-way through (it can hold someone's details; it is neither uploaded nor kept in hosted mode) |
| | Local database paths, extension internals, "first-run" checklist state, the remembered library choice |

Rules: the record model and checks are the app's own (the same shapes as export/restore). Unknown extra fields are kept. A record that carries a credential-like field name (`apiKey`, `token`, `password`, `secret`, …) or names an owner (`accountId`, `owner`, `userId`, …) is **refused**, not silently stripped. References (a draft's lead and product) are by id inside your own library and are not required to exist, as locally; they can never point into another account's records. Deleting a lead does not delete its drafts (as locally).

**Known gaps (documented, not hidden):** the email-app choice and Gmail account name aren't kept in the hosted library, so they start at their defaults when you open it; the first-run checklist doesn't use it; Google Sheets and the hosted library can't both be active (the app asks you to stop Sheets first); erasing or replacing a hosted library from the app is not available yet (delete records one by one); export works, restore *adds* only.

## Choosing a library

**Settings > Cold account**, once you are signed in (the badge in the header says *Local library* or *Hosted library* on every screen):

1. **Create my hosted library…** (first time): explains it's separate, starts empty, uploads nothing; you confirm; it is created and opened.
2. **Open my hosted library…** (any time later, on any surface): shows how many leads, drafts and products it holds; you confirm; the screens now read and write it.
3. **Use my local library**: back to this device's data, exactly as it was. The hosted library is not changed.

If you opened the hosted library on this device before, Cold opens it again at start-up **only while you're signed in**. Otherwise it stays selected but **empty and read-only-in-effect**, with the reason ("signed out", "can't be reached", "not created"), and the header badge says *Hosted library: unavailable*. It never quietly shows your local library, and it never writes to local storage. Switch back deliberately with *Use my local library*. Signing out while the hosted library is open returns you to the local library and says so.

If the session ends while you work, the screen says your changes were **not** saved (and not saved locally either). Edits that couldn't be saved are not reported as saved; copy any draft you want to keep, sign in again, and reopen.

## Architecture and API

Server (`lib/hosted.js`, `lib/hostedDb.js`), all under `/api/hosted`:

| Route | Does |
|---|---|
| `GET /library`, `POST /library` | Whether you have a library, with counts; create it (idempotent) |
| `GET /data`, `GET /data/version` | Your whole library in one consistent read; its version (for cheap change checks) |
| `PUT /data/{products|emails|leads}/{id}[?base=<updatedAt>|new]` | Create or update a record. With `base`, only if the stored record is still at that version (otherwise `409` with the stored record, which is yours) |
| `DELETE /data/{kind}/{id}[?base=…]` | Delete a record (deleting twice is fine) |
| `PUT /data/settings` | The library settings listed above (other keys are dropped) |

It is the desktop database's wire protocol on purpose, so every surface reuses the app's existing database client and views; there is no second domain model or sync engine.

**Authentication** is the existing one, resolved on the server, never from anything the client names:

| Surface | How it reaches `/api/hosted` | Protection |
|---|---|---|
| Web | Its HttpOnly session cookie | Same-origin check plus the session's CSRF token on every change |
| Desktop | The page talks to its own local server, which adds its in-memory bearer token | The token never reaches the page or disk |
| Extension | The panel asks the background worker, which adds its bearer token (session storage); the worker only forwards `/api/hosted/library` and `/api/hosted/data[...]` | No token in the panel or content scripts; only registered extension origins get CORS (never cookies) |

No session: `401` (`not_signed_in`). A bad bearer never falls back to a cookie. A cookie id is not a bearer token and vice versa. Errors are short and say nothing about other accounts or the database (`storage_failed`: "Couldn't save. Nothing was changed.").

**Ownership.** Every row has `account_id`; every query filters on it; the id is the session's. Two accounts can use the same record id without touching each other. The tests send forged ids, owners, headers, cookies and paths from one account at another and check that nothing crosses.

**Integrity.** Each change is one immediate transaction (a settings change moves the version and the document together or not at all). A write that fails is rolled back and answered with an error; the page undoes its on-screen change and says it couldn't save. `PUT` is idempotent; creating something that exists with `base=new` is a refused `409`, not a duplicate. There is no offline queue, no background sync and no conflict resolution: if two surfaces edit the same field, the later save is refused as stale and the person sees the newer version.

## Deployment

Needs: Node 22.13+; a **persistent writable disk** for `COLD_ACCOUNTS_DB_FILE` and `COLD_DATA_DB_FILE` (two files, kept separate on purpose); HTTPS in production; the sign-in settings in [google-sign-in.md](google-sign-in.md). Hosted libraries need sign-in; `COLD_DATA_DB_FILE` without it stops the server. In production the data file must be an absolute path that is not the accounts file and not under a temporary directory; if the file can't be opened (permissions, a newer schema) the server **refuses to start** rather than fall back to storage that wouldn't last. Files are created `0600`.

**Not supported:** stateless serverless hosting without a mounted volume (for example plain Vercel functions). Nothing here silently falls back to the filesystem's ephemeral storage.

**Schema and upgrades.** `hosted.db` uses SQLite `user_version` migrations that run once, in a transaction, so starting twice (or two processes starting together) is safe; a file made by a newer Cold is refused untouched. The accounts file is not modified by this feature (its own upgrades are described in google-sign-in.md).

**Backups and recovery: there is no automatic backup.** Nothing here copies, replicates or restores your data. To back up, stop the server (or use SQLite's `.backup`) and copy `hosted.db` and `accounts.db` together, with their `-wal` and `-shm` files if present; restoring is replacing them while the server is stopped. A lost disk loses every hosted library. Individual users can also export their hosted library as JSON (Settings > Your data) while it is open.

## What is sent when the hosted library is open

Only what you create or save there: the leads, drafts (including notes and hand-off history), products and library settings above, to the Cold server you signed in to, over its HTTPS address. Reading sends nothing but the request. Nothing local is sent, nothing is sent in the background or on sign-in, and no analytics or telemetry exist. Model inference is unchanged and separate: a draft's prompt goes to your chosen model provider exactly as before, and hosted records are not sent to a provider.

## Verification status

* **Automated (stand-in Google, mock model):** `test/hosted.test.js` (server: ownership, two-account isolation, both session kinds, CSRF, validation, rollback, restart persistence, migrations), `test/hosted-client.test.js` (page library, unavailable state, worker forwarding), `test/hosted-surfaces-e2e.test.js` (the web app, the real desktop local server and page, and the real extension in Chromium against one server: a library created on the web is read and updated from the desktop app and then the extension, survives a server restart, shows the failure when the service goes away, and leaves each local library byte-for-byte unchanged). They prove Cold's own logic; **not** real Google, a packaged app or a store build.
* **Live smoke test (not yet run):** with real Google credentials and the persistent-disk deployment: sign in on web, create the library, add a lead and a draft; sign in on the desktop app and the extension with the same Google account, open the library, see and edit the same records; restart the server and confirm they remain; sign out and confirm local data is untouched.

## Known limitations

* Not verified against real Google, a packaged desktop app or a Web Store build; not deployed.
* No automatic backup, no disaster recovery, no migration or import between local and hosted libraries (use export/restore in add mode if you want to copy), no offline hosted writes, no conflict resolution beyond refusing stale saves, no sharing or teams.
* The gaps listed under "What lives in the hosted library".
* Cross-device freshness is by polling the library version every few seconds while the window is visible; a change made elsewhere appears then, not instantly.
* One hosted library per account; no account deletion.
