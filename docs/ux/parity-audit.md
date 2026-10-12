# Cross-surface audit and shared-UI boundary

Written before the unification work. Surfaces: **web** (the page served by `server.js`, hosted or `npm start`), **desktop** (Electron around the same page, with SQLite and the keychain) and the **browser extension** (Chrome side panel).

## Decision that shapes this

The desktop app is the **hub**. Web and the extension each keep a full local copy of products and drafts and work with nothing else running. Whenever the hub is reachable they push what changed locally and pull what changed there, and retry after outages. There is no cloud service, account or new public endpoint. Consequence, stated plainly: while the desktop app is closed, web and the extension cannot sync *with each other*; each catches up when the hub is back.

## What exists today

| Concern | Web | Desktop | Extension |
|---|---|---|---|
| Entry / shell | `src/app.js` (header, nav Write · Knowledge · History · Settings, router) | same page | own shell in `extension/src/panel.js` (Write · Products · Settings, no History) |
| Write | `views/compose.js` + `recipient.js` + `tweetForm.js` + `draft.js` | same | own `workspace.js` (different labels, different result card, no status, notes, checklist, improve, validation summary, Clear all) |
| Knowledge | `views/knowledge.js` (full editor) | same | own `productsView.js` (7 fields; no proof points) |
| History | `views/history.js` | same | none (a 5-item "recent" list with Copy) |
| Settings | provider form only when the server has `COLD_SETTINGS_FILE`; otherwise "managed on the server" | provider form + extension pairing | own `settingsView.js` (own model + app link) |
| Data | browser localStorage | SQLite via `sqliteDb.js` | own `replica.js` over `chrome.storage` |
| Status / notes / sent copy | `domain/outreach.js` | same | not available |
| Domain, prompts, generation, handoff | `src/domain`, `src/services` | same | reused |

## Duplicated or divergent

1. Extension Write, Knowledge and Settings re-implement screens that already exist (about 500 lines), with different words ("Products", "Write the email", "Write a reply") and fewer capabilities.
2. The extension has no History, so Draft / Sent / Replied, notes and the sent copy are invisible there.
3. Web has no way to reach the other surfaces' data, and no Settings surface on a hosted deployment.
4. Hub-link code (`connection.js`, `link.js`, `backend.js`, `replica.js`) lives under `extension/` but is not extension-specific.

## Proposed boundary

**One implementation, used by every surface** (no per-surface copies):
- `src/domain/*` (products, outreach statuses, rules, prompts, handoff rules) and `lib/*` (providers, llm, mailto, profile).
- `src/services/*` (generation, handoff, clipboard, API client) plus the hub link, replica and backend chooser, moved from `extension/` to `src/services/`.
- `src/state/store.js` (the only state container) and `src/components/*`, `src/styles/*`.
- **Views**: Write (`compose.js`), Knowledge, History, the draft pane, and the Settings frame. The extension mounts these same views.

**Adapters** (small, per runtime, same interface):
- Storage: SQLite client (desktop), localStorage replica (web), `chrome.storage` replica (extension).
- Settings data source: server settings API (desktop / local server), browser-profile storage (extension), read-only summary (hosted web).
- Model source: the surface's own (server or extension-direct) and the desktop hub's, chosen by one shared function.

**Runtime-specific on purpose** (shown, labelled, and gated, never faked):
| Capability | Web | Desktop | Extension | Why |
|---|---|---|---|---|
| Read the current page ("This page" card) | no | no | **yes** | needs page access only the extension has |
| Type a draft into X's reply box | no | no | **yes** | same |
| Provider keys editable | only on a local server with settings enabled | **yes** (keychain) | **yes** (own, unencrypted browser storage, labelled) | keys never travel between surfaces |
| Pairing code and allowed web origins | no | **yes** (hub) | enter code | the hub owns them |
| Sync with the desktop app | **yes** (needs desktop running) | is the hub | **yes** | decision above |
| Open in email | mailto | bridge to the OS | mailto | OS access differs |

## Rules kept
No provider credential crosses to web or the extension. No new permissions. The hub accepts a client only with the pairing code and, for web pages, an origin the user approved in Settings. No outreach-status logic outside `domain/outreach.js`.

## Result (what was built)

- Extension rebuilt on `startApp`: the same Write (`compose.js`), Knowledge, History, draft pane and Settings as web and desktop. Deleted `workspace.js`, `productsView.js`, `settingsView.js` (about 500 duplicated lines). The only extension-specific screen part is `pageCard.js`.
- Hub link, replica, backend chooser and pairing helpers moved to `src/services/` and shared by web and extension. Web keeps its data in the same localStorage keys as before (existing data and tests unchanged) behind the replica.
- Settings has the same sections everywhere (Model, Cold desktop app / Browser extension & web apps, Your data). The model form is one implementation with three data sources (server settings API, extension storage, read-only summary).
- Wording about where data lives comes from one function (`store.keptNote()`), used by the footer, History, Settings and the draft pane.
- Hub accepts approved web origins (managed in desktop Settings, never wildcards) in addition to the extension; same pairing code, same boundaries (no settings, keys or origins reachable with it).
- Page security policy `connect-src` now also allows loopback addresses so a page can reach the desktop app.

## Remaining gaps (not hidden)

1. **Web and extension can't sync with each other while the desktop app is closed.** Chosen deliberately (no cloud). Each catches up when the app returns.
2. **Concurrent offline edits to the same record on two surfaces:** the hub's newer copy wins and the older offline edit is dropped. Not merged.
3. **A hosted HTTPS site reaching the desktop app on localhost** depends on the browser's local-network permission (Chrome shows a prompt in recent versions). Tested with local http pages only, not a real hosted site.
4. **Hosted web can't edit provider keys** (by design). It can use the desktop app's model when paired.
5. **Extension keys are unencrypted** in browser storage (labelled in Settings); the desktop app uses the OS keychain.
6. **The extension has no AI Gateway model picker** (that picker only exists for a hosted server).
7. **Chromium browsers only** for the extension; no Firefox or Safari build.
8. **Open in email** uses a native bridge on desktop and a `mailto:` link on web and the extension; whether an email app opens depends on the user's setup.
