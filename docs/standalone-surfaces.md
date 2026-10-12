# Using Cold on one surface

Cold has three surfaces: the **web app**, the **desktop app** and the **browser extension**. Each one is a complete app. None needs
another to be installed, running or paired. Pairing them is an optional convenience.

## What each surface needs

| | Web app | Desktop app | Browser extension |
| --- | --- | --- | --- |
| Install | open the site (or `npm start`) | install Cold Desktop | load the extension in Chrome/Edge/Brave |
| A model comes from | a provider key **on the web server** (set by whoever runs it, or `.env` for a local install) | a provider you choose in Settings (key stored on this computer) | a provider you choose in Settings (direct from the browser; key in extension storage, unencrypted) |
| Products and drafts live in | this browser (`localStorage`) | one SQLite file on this computer | extension storage |
| Needs the desktop app? | no | is the app | no |
| Needs the extension? | no | no | is the extension |
| If no model is set up | Knowledge and History still work; Write says who must add a provider | Write points to Settings | Write points to Settings |

First run on each: open it, choose a provider (web: the operator already did, or you set `.env`), add a product in Knowledge, write
a draft, edit it, find it again in History, mark it sent / record a reply yourself. Close and reopen: everything is still there.

## Optional connections

* **Desktop app ⇄ web / extension.** In the desktop app: Settings → Browser extension & web apps, copy the address and pairing code.
  In the web app or extension: Settings → Cold desktop app, paste them. Once paired they sync products, drafts, statuses, notes
  and sent copies, and can use the desktop app's model (only the prompt crosses over; provider keys never leave where they are
  stored, and the extension can never read the app's settings). Details of the sync and its conflict handling:
  `docs/data-integrity.md`.
* **Not paired, or the app isn't running:** nothing is disabled. The web app and extension keep working from their own copy and
  catch up when the app returns. If the surface also has no model of its own, Write says that the paired app isn't running and
  what to do (open it, or set up a model here) while Knowledge and History stay usable.
* **Adding a surface later:** pair it and it switches to the Cold Desktop library; its own library is left as it is. Copying it
  across is a separate, previewed action (see `docs/shared-library.md`).

## Dependency audit (what was checked, and what it showed)

| Question | Finding |
| --- | --- |
| Does the web app depend on a running desktop process? | No. Startup (`services/platform.js`) uses the server's own config and `localStorage`. A saved pairing is connected in the background (`link.connect(...).catch`), so a dead app never delays or blocks the page. |
| Does desktop startup or onboarding involve the extension? | No. The desktop shell starts its own local server and window. The pairing section in Settings is passive; there is no install prompt anywhere. |
| Are provider setup, knowledge, drafting, editing and history available independently? | Yes on all three. Web: provider on the server. Desktop and extension: Settings → Model. |
| What is local, what is shared? | Web: `localStorage`. Desktop: SQLite (the hub). Extension: `chrome.storage.local`. Shared only when paired (replica sync, desktop app as source of truth). Web and extension do not sync with each other without the app. There is no cloud service. |
| Which connection failures stop core work? | None. A failed or rejected pairing only changes the sync status in Settings. The one place a missing connection matters is a surface with **no model of its own**, and then only *writing* is unavailable. |
| Implicit assumptions about another surface? | Wording only. The "no model" messages on the web told users to connect the desktop app (read as required), and a paired-but-offline app with no local model gave no explanation. |

## What changed to meet the contract

Wording and states only; no new service, store or abstraction:

* Write's "no model" hint is specific to the surface and to whether a paired app is offline (`noModelHint` in `src/views/compose.js`).
* The web Settings model section says the model is a server-side requirement and that the desktop app is an optional alternative.
* The desktop pairing section says it is optional.

## Tests that prove independence

* `test/standalone.test.js`: web only (no desktop, no extension, nothing else contacted); web with no server provider; web with a
  pairing to an app that isn't running; desktop only, from first run with no provider through Settings, knowledge, drafting,
  restart.
* `test/extension.test.js`: the extension on its own, paired to an app that stops, with no model of its own.
* Existing: pairing/permission boundary (`server-security`, `data-api`), extension never reaching settings, data integrity
  (`outreach-integrity`).

## Limitations

* The web app and the desktop app do **not** share data unless you pair them; two unpaired surfaces are two separate libraries.
* A hosted web deployment needs a server-side provider key. A user cannot supply their own key in a hosted page by design (keys
  never pass through the page); they can run Cold locally, or borrow the desktop app's model.
* The extension stores provider keys unencrypted in the browser profile (the desktop app uses the OS keychain).
* Pairing stays manual: copy the address and code. Nothing is auto-discovered.
* Automated tests cover Chromium with a mock model; they do not cover real providers, or the desktop installer on each OS (the
  Electron shell test needs a display).
