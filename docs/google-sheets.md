# Google Sheets (optional)

> **Verification status.** Built and tested against a **stand-in** Sheets API and a fake sign-in; **never run against a real Google account**, so it is
> **not launch-ready**. Treat it as opt-in preview and keep it off by default until the checks in [audit 06 gate G7](audit/06-production-readiness.md) pass.
> Known limits: [DATA-001, -002, -004, -005, -007](audit/11-remediation-backlog.md).

Cold can keep **leads and outreach** in a Google Sheet in the user's own Drive instead of in the app's storage. It is optional and off
unless you configure it. Products, settings and model keys always stay where they are, and Cold still never sends email for you.

## What users see

**Settings > Google Sheets** (and a link from an empty Leads screen) starts a guided setup:

1. **Connect Google.** One permission: `drive.file`, meaning files Cold itself creates. Cold cannot see other Drive files, email or contacts.
2. **Choose a spreadsheet.** Create a new one ("Cold: leads and outreach", with a *Leads* and an *Outreach* tab), or connect this device to one Cold already made.
3. **Move what you have.** Optionally copy current leads and drafts into the sheet (nothing already there is overwritten; copies stay as a backup).

Afterwards, Settings shows the connection's health, *Refresh from the sheet*, *Reconnect Google* if the sign-in expired, *Open in Google Sheets*, and
*Stop using Google Sheets* (copies everything back, leaves the spreadsheet untouched).

## How the sheet works

* The sheet is the source of truth for leads and outreach. Cold re-reads it before every save (so a row someone inserted or moved is never overwritten) and every ~20 seconds.
* **Leads tab:** `id, name, company, role, email, profile_url, why, product, goal, list, notes, created, updated`, then one column per extra field.
  Columns are read **by heading**, in any order. A column Cold doesn't know is an extra field. A row typed straight into the sheet gets an id when Cold next reads.
* **Outreach tab:** readable columns (`status, recipient, company, email, subject, message, goal, product, sent, replied, follow_up, notes`) plus a `data` column holding the full record.
  Changing status, notes, email, subject or follow_up in the sheet is honoured over the saved copy.
* Everything is written as plain text (never a formula).
* **Your own columns are safe.** On the Leads tab, a column Cold doesn't know is kept as an extra field (up to 20; names up to 60 characters, values up to 2,000). On the Outreach tab, and for any column Cold doesn't own, Cold leaves the cell exactly as it found it when it saves that row.
* **Concurrent edits.** Outreach records carry a version: edits to different fields are merged, the same field is refused with a visible message. **Leads carry no version: if two devices edit the same lead, the later save wins.** (This is true of leads on every storage backend.)
* **Start-up.** If the sheet can't be read when Cold starts (sign-in expired, sheet deleted, offline), leads and drafts are **not shown**, a banner explains, and Settings > Google Sheets offers *Reconnect*. Nothing is deleted. There is no offline copy.
* **Not synced through the desktop pairing.** Leads and drafts in a sheet are shared only by surfaces that use the same sheet.
* **Stopping** copies everything back, signs out of Google and asks Google to revoke Cold's access (the extension only forgets its sign-in). The spreadsheet stays in Drive.

## Setting it up (the operator, once)

Create a Google Cloud project, enable the **Google Sheets API**, configure the OAuth consent screen with the single scope
`https://www.googleapis.com/auth/drive.file`, then create one OAuth client per surface:

| Surface | Client type | Where the id goes |
| --- | --- | --- |
| Web (a hosted Cold server) | Web application, with your site as an authorised JavaScript origin | `COLD_GOOGLE_CLIENT_ID` in the server's environment |
| Desktop app / local install | Desktop app | `desktop/google.json` (see `google.example.json`), or `COLD_GOOGLE_CLIENT_ID` and `COLD_GOOGLE_CLIENT_SECRET` |
| Browser extension | Web application, with redirect `https://<extension-id>.chromiumapp.org/` | `COLD_GOOGLE_CLIENT_ID=… npm run build:extension` |

Without a client id the option is simply unavailable (Settings says so) and the page is not allowed to contact Google at all: Cold's
content-security-policy only opens `sheets.googleapis.com` and `accounts.google.com` when a client id is configured.

**How sign-in works per surface.** Web: Google Identity Services in the page (tokens live in memory; ~1 hour; renewed silently). Desktop: the local
server runs the OAuth code flow with PKCE and a loopback redirect, keeps the refresh token with the provider keys (encrypted by the operating
system when available), and gives the page only short-lived access tokens. Extension: Chrome's `identity.launchWebAuthFlow`.

**Things to check before shipping (not yet done).** (1) `drive.file` access is granted per OAuth app: confirm with real accounts that a sheet created on one
surface can be opened from another (all three clients should belong to the same Cloud project); if Google treats them separately, "use a
spreadsheet Cold already made" will fail with a clear "not found / no access" message and each surface should create its own sheet. (2) Review
Google's current verification requirements for your consent screen. (3) The Sheets API allows 60 reads per minute per user; Cold polls two tabs every 20 seconds.
