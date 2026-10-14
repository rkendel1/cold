# Privacy and data flow

**Contract.** Your library (products, drafts, leads, notes, statuses, timestamps, sent text) is stored on *your* device by default and Cold
needs no account or Cloud database to keep it. **Optional exception: if you set up Google Sheets, your leads and outreach drafts are stored in
a spreadsheet in your own Google Drive instead** (see "Google Sheets" below). Writing a draft is different: it is model processing, and the prompt for that draft
goes to the model provider you (or the site's operator) chose. These are two separate things and the app says so in Settings → Your data.

| Surface | Library stored in | Cross-surface sharing |
| --- | --- | --- |
| Web | this browser's `localStorage` | only if you pair it with the desktop app |
| Desktop app | one SQLite file in the app's data folder | it is the hub others may pair with |
| Extension | the browser profile's extension storage | only if you pair it with the desktop app |

**Optional Google sign-in (hosted web only).** If an operator configures it, signing in sends you to Google and the server receives an ID token once. It keeps Google's `sub`, your display name, your email if Google marks it verified, a random Cold account id, timestamps, and a hashed session id, in a SQLite file on that server. Scopes are `openid email profile`; no Google token is kept and no Gmail or Sheets access is requested. The session cookie is HttpOnly and expires (default 7 days); sign-out deletes the session on the server but not the account record, and does not change anything at Google. Your library is not uploaded or linked to the account. The desktop app and the Chrome extension can also sign in to that server (only if their build is configured with its address): they open Google in your browser, the server keeps the same kind of record under the **same** account id, and the app/extension keep a revocable session token in memory only (never in `settings.json`, `cold.db`, extension local storage, or a URL). Signing in or out never reads, uploads or changes your local library or settings.

**Hosted library (optional, explicit).** If the server has `COLD_DATA_DB_FILE` set and you create and open a hosted library, then (and only then) the leads, drafts (with notes, hand-off and follow-up history), products and library settings you create or save *in that library* are stored in a separate SQLite file on that server, owned by your Cold account id. Your local library is not uploaded, merged or changed. Provider keys, tokens, model settings, the email-app choice and the half-typed Write form stay on your device. Identity data (name, email, session) is in the accounts file; hosted records are in the hosted file; local records are where they always were. No telemetry; model inference is separate and unchanged. There is no automatic backup. Details: [hosted-library.md](hosted-library.md). Details: [google-sign-in.md](google-sign-in.md).

No Cold-run cloud backup, library sync or server-side library exists. A hosted server has no database behind it: `/api/data` answers
404 there. Cold contains no analytics, telemetry, crash reporting or remote logging. The only route by which library data can reach a
third-party store is the optional Google Sheets setting, which is off unless a Google client id is configured and the user turns it on.

## What leaves the device

| Data | Where it goes | Retained by Cold? |
| --- | --- | --- |
| Library (CRUD, reload, history, notes, status, sent text) | nowhere (web/extension: local storage; desktop: local SQLite) | stored locally only |
| **Draft prompt**: this draft's product facts (external-use proof only), recipient name/role/company/why, your instructions | the model provider. **Hosted web:** browser → *the site's Cold server* → provider (the server holds the key). **Desktop:** the local app → provider. **Extension:** browser → provider directly (or → the paired desktop app → its provider) | Cold's server does not log or store it; the provider's own retention terms apply |
| Generated response | back along the same path | not stored by the server; saved to your library locally |
| Other products, other drafts, notes, statuses, sent text, email addresses, sign-off | not sent | n/a |
| Provider API key | web: server environment only, never to the page. Desktop: encrypted (OS keychain) or a private file on that computer. Extension: extension storage (unencrypted) | stays where entered; never given to a paired surface |
| Local model (Ollama / OpenAI-compatible URL on this computer) | the runtime you configured | whatever that runtime does |
| Public profile / tweet lookups (only when you click Look up / Read this page) | the profile link goes to x.com, twitter.com, linkedin.com or the tweet syndication endpoint (server-side on web/desktop; from the browser in the extension) | not retained |
| Email lookup (only when you press Find email / Verify on a lead) | the lead's name, a company domain you typed and/or their LinkedIn link (or one address, to verify) go to your Cold server, then to treg.to, which may pass them to upstream data providers it selects. See [people-search.md](people-search.md) | Cold keeps nothing but what you accept into the lead. The treg token stays on the server |
| Model catalog (web with AI Gateway; provider model lists in Settings) | the provider or AI Gateway; no library content | catalog cached in memory for 5 minutes |
| Pairing and sync | only to the desktop app address you entered, with its code: products, drafts, statuses, notes, sent copies | in the desktop app's SQLite file. Nothing is sent before you pair, or after you disconnect |
| Server logs | startup banner only; no request logging; errors return generic messages | none |
| Rate limiting | in-memory request counts per IP address for one minute | not persisted |

## Google Sheets (optional; off by default)

When (and only when) a Google client id is configured for the build or server **and** the user completes **Settings > Google Sheets**:

* **What goes to Google:** every lead field and extra field (Leads tab), and every outreach record (Outreach tab: readable columns plus a `data`
  column holding the full record: recipient name/company/role/email, subject and message, notes, statuses and dates, follow-up and handoff
  records, sent copy, and the model's `claims`/`checks`). Product knowledge, settings, sign-off and the Write form are **not** sent. The first
  setup can copy what is already in the app into the sheet.
* **What Cold is allowed to touch:** one permission, `drive.file`: files Cold itself creates (or that the user explicitly opens with it). Not
  Drive in general, mail or contacts. **Gmail "Open in email" does not use this permission and needs none.**
* **Where tokens live:** web and extension keep a short-lived access token in memory (plus a "connected" flag in browser storage); the desktop
  server keeps the refresh token with the provider keys (OS-keychain-encrypted when available) and gives the page only short-lived tokens.
* **Who else can see it:** the spreadsheet belongs to the user's Google account and follows Google's sharing settings; Cold cannot see or
  control who it is shared with.
* **Stopping:** "Stop using Google Sheets" copies the sheet's current contents back into the app, signs out and asks Google to revoke
  Cold's access; the spreadsheet stays in Drive until the user deletes it. Revoking at myaccount.google.com also works; Cold then shows "sign in again".
* **Not offline:** with Sheets on, leads and outreach are read from the sheet at start-up; if it can't be reached they are not shown (a banner says so).
* **Not covered by the tests below.** `test/privacy.test.js` asserts "no other host is contacted" with Sheets **off**. The Sheets paths are tested
  against a stand-in API (`test/sheets*.test.js`, `test/google-*.test.js`); nothing here claims to have been verified against Google. See
  [docs/audit/07](audit/07-security-privacy-data-authority.md).

## Keeping this document true

A new **data destination** (anywhere data is stored, sent or read from: a storage backend, a third-party API or sign-in, sync or pairing, a field added to a model prompt, a log or diagnostic) or a new **authority boundary** (which copy of the data wins) must update, **in the same change**: this document, the README "Privacy in one paragraph", the in-app wording (`store.keptNote` and Settings > Your data), and [audit/07](audit/07-security-privacy-data-authority.md). The pull-request template (`.github/pull_request_template.md`) carries this as a checklist item. This exists because the Google Sheets feature shipped while this document and the README still said no data goes to a cloud store (audit SEC-006).

## Tests that hold these boundaries

`test/privacy.test.js` (real servers, real browser, mock model): web CRUD sends no write request anywhere and contacts no other
host; the hosted server refuses library storage; the generate request carries only the prompt, and distinctive strings from
other products, notes, addresses, sent text and sign-off never reach the provider; server output is only the startup banner even
when the provider fails or a malformed request arrives, and nothing is written to disk; an unpaired page never contacts a running
desktop app, and a paired one talks only to it and its own server; the desktop app keeps the library in its SQLite file and keys
out of it. Related: `standalone.test.js`, `server-security.test.js`, `data-api.test.js`, `outreach-integrity.test.js`.

## Unresolved flows and limitations

* **Hosted web processing.** The operator's server sees every prompt in memory while forwarding it. Cold does not store it, but
  Cold cannot prevent an operator from adding their own logging or a proxy in front of it. Self-hosting or the desktop app avoids this.
* **Provider error text.** If a provider rejects a request, its error message is shown to you; Cold does not store it, but a provider
  could echo content in it.
* **"Local" depends on the model you pick.** Ollama and OpenAI-compatible URLs may point at a remote machine; Cold cannot tell.
  Nothing here claims data never leaves the device while a hosted model is selected.
* **Extension storage is not encrypted**, and neither is `localStorage`; anyone with access to the browser profile can read the library.
* **Export, restore and erase.** Export writes a file to your device only; it holds products, drafts and leads but never keys or tokens, and is not encrypted. Erase deletes Cold's records and saved settings from this device, not Google sign-in, Drive/Sheets, provider keys, exported files or any copy of the database or browser profile ([details](data-portability.md)).
* **Browser/OS backup and sync** (for example a browser profile that syncs, or OS file backups of the SQLite file) can copy local data off
  the device outside Cold's control.
* **Network-level proof is test-scope.** The tests prove behaviour of Cold's own code paths in Chromium against a mock provider. They
  don't cover the desktop shell's OS-level traffic, third-party sites visited by the extension, or a deployment's infrastructure.
* **AI Gateway catalog** requests go to ai-gateway.vercel.sh from the server (no library content).
