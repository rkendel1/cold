# Privacy and data flow

**Contract.** Your library (products, drafts, notes, statuses, timestamps, sent text) is stored on *your* device by default and Cold
needs no account or Cloud database to keep it. Writing a draft is different: it is model processing, and the prompt for that draft
goes to the model provider you (or the site's operator) chose. These are two separate things and the app says so in Settings → Your data.

| Surface | Library stored in | Cross-surface sharing |
| --- | --- | --- |
| Web | this browser's `localStorage` | only if you pair it with the desktop app |
| Desktop app | one SQLite file in the app's data folder | it is the hub others may pair with |
| Extension | the browser profile's extension storage | only if you pair it with the desktop app |

No Cold cloud backup, account sync or server-side library exists. A hosted server has no database behind it: `/api/data` answers
404 there. Cold contains no analytics, telemetry, crash reporting or remote logging.

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
| Model catalog (web with AI Gateway; provider model lists in Settings) | the provider or AI Gateway; no library content | catalog cached in memory for 5 minutes |
| Pairing and sync | only to the desktop app address you entered, with its code: products, drafts, statuses, notes, sent copies | in the desktop app's SQLite file. Nothing is sent before you pair, or after you disconnect |
| Server logs | startup banner only; no request logging; errors return generic messages | none |
| Rate limiting | in-memory request counts per IP address for one minute | not persisted |

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
* **Browser/OS backup and sync** (for example a browser profile that syncs, or OS file backups of the SQLite file) can copy local data off
  the device outside Cold's control.
* **Network-level proof is test-scope.** The tests prove behaviour of Cold's own code paths in Chromium against a mock provider. They
  don't cover the desktop shell's OS-level traffic, third-party sites visited by the extension, or a deployment's infrastructure.
* **AI Gateway catalog** requests go to ai-gateway.vercel.sh from the server (no library content).
