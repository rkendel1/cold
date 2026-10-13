# 02. Repository and architecture inventory

## Repositories and packages

There is **one repository**, `rkendel1/cold` (npm package `cold@0.1.0`, private, author Kendel Consulting). It contains every surface, the server and the shared UI. There is no monorepo tooling and no separate packages; "shared" means shared source files bundled by `esbuild` into each surface. No dependency repository was found or needed. `.github/` does not exist, so there are **no CI workflows** and no release workflow ([QUALITY-002](11-remediation-backlog.md)).

## What exists and where

| Piece | Location | Entry point / build | Notes |
|---|---|---|---|
| **Shared UI** (all five screens, domain rules, state) | `src/` (`domain/` pure logic, `state/`, `services/`, `components/`, `views/`, `styles/`) | `src/main.js` → `npm run build:app` (`scripts/build-app.cjs`) → committed `public/app.js` + `public/app.css`; `npm run check:app` fails if the bundle is stale | Vanilla ES modules, no framework. The design system is `src/styles/tokens.css` + `components.css` and `src/components/ui.js`. |
| **Web app** | `index.html` + `public/` served by `server.js` | `npm start` (Node ≥ 18; default `127.0.0.1:3000`) | Deployed on Vercel per `test/bundle.test.js` (deployment-topology test, local only). No `vercel.json`; `provider-config.json` sets `previewProvider: "hf-ssh"` for Vercel previews (experimental, see `docs/hf-ssh-provider.md`). |
| **Server** | `server.js` (443 lines, no framework) + `lib/` | same | Routes: `/api/config`, `/api/generate`, `/api/models`, `/api/profile`, `/api/tweet`, `/api/people/email/*`, `/api/settings*`, `/api/data*`, `/api/google/*`, `/oauth/google/callback`. |
| **Desktop app** | `desktop/main.js`, `desktop/preload.js` | `npm run desktop`; package: `npm run desktop:build` (`electron-builder`, Electron `^44.7.0`) | Electron shell around the same server on `127.0.0.1:47821` (`COLD_PORT`). Targets: macOS dmg+zip, Windows NSIS, Linux AppImage. **No code-signing, notarisation or auto-update is configured** (`package.json` `build`). |
| **Browser extension** | `extension/` (`manifest.json` MV3, `background.js`, `panel.html`, `src/*`) | `npm run build:extension` (`scripts/build-extension.cjs`) → `extension/dist/` (gitignored) | Side panel. Distribution today is "Load unpacked". Not packaged for any store. |
| **SQL persistence** | `lib/db.js` (SQLite via built-in `node:sqlite`) + `src/services/sqliteDb.js` (browser-side client) | Desktop sets `COLD_DB_FILE` itself; a local install may set it (Node 22.13+) | Tables `products`, `emails`, `leads`, `meta`; `PRAGMA user_version` = 2; WAL mode. Hosted servers never set it. |
| **Replica / hub sync** | `src/services/replica.js`, `replicaStorage.js`, `hubLink.js`, `libraries.js`, `hub.js` | | Web and extension keep a local copy and optionally sync with the desktop app ("hub"). |
| **Providers / models** | `lib/providers.js` (9 providers), `lib/llm.js`, `lib/settings.js`; extension: `extension/src/model.js`, `llmClient.js`, `localModel.js` | | Keys: server env, or desktop `settings.json` (OS-keychain-encrypted when available), or extension storage (not encrypted). |
| **Product knowledge** | `src/domain/knowledge.js`, `src/views/knowledge.js` | | |
| **Writing / generation** | `src/views/compose.js`, `draft.js`, `src/services/generation.js`, `src/domain/prompts.js`, `rules.js`, `grounding.js` | | Two model calls per email (draft, editor pass), then deterministic checks. |
| **Context capture, Ask Cold** | `extension/src/page.js`, `pageCard.js`, `askCold.js`, `src/domain/opportunity.js`, `decide.js` | | Extension only. |
| **Leads, CSV, mapper** | `src/domain/leads.js`, `src/views/leads.js`, `examples/leads-template.csv` | | Mapper and extra fields (`suggestMapping`, `mapFromTargets`, `cleanCustom`). |
| **Outreach status, follow-ups** | `src/domain/outreach.js`, `src/domain/followup.js`, `src/views/followUpPanel.js`, `followUpSettings.js` | | |
| **Email handoff** | `lib/mailto.js`, `src/services/handoff.js`, `desktop/main.js` (`cold:open-mail`) | | Builds `mailto:` or Gmail/Outlook compose links; never sends. |
| **Google Sheets** | `src/domain/sheetsMap.js`, `src/services/sheetsApi.js`, `sheetsDb.js`, `sheetsConnector.js`, `googleAuth.js`, `src/views/sheetsSetup.js`, `lib/google.js`, `server.js` (`googleRoute`) | | Optional; off unless a Google client id is configured. See [07](07-security-privacy-data-authority.md). |
| **Email lookup** | `lib/treg.js`, `lib/people-shared.js`, `src/views/findEmail.js` | | Optional, treg.to. |
| **Settings / preferences** | `src/views/settings.js`, `followUpSettings.js`, `sheetsSetup.js`, `lookupSettings.js` | | |
| **Onboarding** | none | | **Absent** ([CX-001](11-remediation-backlog.md)). |
| **Tests** | `test/` (47 files, 314 `test()` calls), `test/helpers/` (mock model, mock Sheets API) | `npm test` = `node --test test/*.test.js` | Browser tests need Chromium; extension tests need `extension/dist` built; desktop-mail needs Electron and a display. |
| **Tooling** | `scripts/` (`build-app`, `build-extension`, `pin-local-model`, `hf-ssh-*`, `audit-*`) | | |
| **Documentation** | `README.md`, `docs/` | | See [09](09-documentation-remediation.md). |

A **fourth runtime** exists: when `window.claude` is present, `src/services/platform.js` uses the Claude artifact runtime for storage and generation (`README` "Claude artifact mode"). No test in the suite targets it specifically ([PARITY-005](11-remediation-backlog.md), Unverified).

## Shared versus surface-specific

| Capability | Shared source | Differs by surface |
|---|---|---|
| Write, Knowledge, Leads, History, Settings screens | all of `src/views/` | Web/desktop run the page from the server; the extension bundles the same modules into the side panel (`extension/src/panel.js`). |
| Storage backend | `src/state/store.js` talks to one small interface (`collection`, `doc`, `setMany`) | Web: localStorage via replica. Desktop: SQLite through `/api/data`. Extension: `chrome.storage.local` via replica. Optional: Google Sheets layered on top for leads and outreach only (`splitDb`). |
| Generation | `src/services/generation.js` | Web: server's provider. Desktop: Settings-chosen provider. Extension: own provider directly, or the paired desktop app's. On-device model: extension only. |
| Google sign-in | `googleAuth.js` interface | Web: Google Identity Services in the page. Desktop: the local server runs OAuth (PKCE, loopback). Extension: `chrome.identity.launchWebAuthFlow`. |
| Page awareness, tweet insertion, Ask Cold | extension only | by design |
| Pairing code, allowed web origins | desktop only | by design |

## Which implementation is authoritative for each capability

Authority for **data** (where the single true copy lives) is tabulated per capability in [03](03-parity-matrix.md) and explained in [07](07-security-privacy-data-authority.md). In short: web → that browser's localStorage; desktop → the SQLite file; extension → extension storage; paired surfaces → the desktop SQLite file (the hub) with local working copies; **leads and outreach, when Google Sheets is enabled → the spreadsheet** (products and settings stay local).

## What was inspected

All of `src/`, `lib/`, `server.js`, `desktop/`, `extension/` (source and manifest), `scripts/`, `package.json` / lockfile, `provider-config.json`, `.env.example`, every file in `docs/` and `README.md`, and all 47 test files (read for what they exercise; run, see [08](08-test-and-verification-report.md)). The git history was used to bisect a test regression (`1e34b87`).

## What could not be inspected or verified here

* **Real Google.** No Google account, client id or network access to Google. Everything about Sheets is verified against a stand-in API ([DATA-001](11-remediation-backlog.md)).
* **Real model providers.** All generation tests use a canned mock; output quality is not evidenced. The gated real-model smoke test (`npm run smoke:model`) and `npm run verify:local-model` could not run (no network; the latter reports `fetch failed` for 4 pinned models).
* **Real mail clients and Gmail.** Only the exact links Cold builds are checked.
* **Desktop packaging, installation, upgrade, signing.** `electron-builder` was not run; the packaged artifact was never launched. One test that launches Electron fails here for lack of a display/DBus (environment, not a verified product fault).
* **Extension in a real, headed Chrome** (4 layout tests need a display) and in any store.
* **Vercel deployment health.** Only local configuration tests exist.
* **Screen-reader and keyboard walkthroughs.** Only automated axe checks were run.
* **Operational behaviour over time** (long-running use, large lead lists in a real sheet, Google quota behaviour).
