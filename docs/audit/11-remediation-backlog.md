# 11. Remediation backlog

Every finding from the audit, with a stable ID. **State:** *Open* · *Fixed in this PR* (code or docs changed; evidence given) · *Hypothesis* (not reproduced; stated as such). **Blocks launch** says what scope it blocks (see [10](10-launch-readiness-plan.md)); "Sheets" means it blocks only the optional Google Sheets feature. Owner is a component, since there is one repository and one maintainer group. Evidence uses the shorthand in [03](03-parity-matrix.md): `T:` test, `S:` source, `R:` runtime observation ([08](08-test-and-verification-report.md)).

**No Critical finding stands open.** One High data-loss defect in the optional Sheets feature (DATA-011) was found and fixed during the audit; it would have been Critical had the feature been generally available.

## Status after the pilot-readiness PR (`feat/cold-pilot-readiness`)

Only what was actually done and verified is marked closed. "Partly" says what remains. Evidence is in [08](08-test-and-verification-report.md) (section "Pilot-readiness PR").

| ID | Now | What changed | What remains |
|---|---|---|---|
| QUALITY-002 | **Partly closed** | `.github/workflows/ci.yml`; `test/00-ci-prerequisites.test.js` (fails in CI on a missing Chromium, extension build, Electron, display, Node/SQLite); `scripts/ci-check-skips.cjs` (fails on any skip not allow-listed; only `REAL MODEL:` is). Each failure mode was demonstrated locally | **The workflow has not run on GitHub yet** (it runs on a pull request or a push to `main`). Branch protection requiring it is a repository setting |
| QUALITY-003 | **Partly closed** | The display-dependent tests are included in the CI job under `xvfb-run` | **Still unrun in this environment** (no `xvfb-run`): `desktop-mail` and four `extension-layout` tests. They have never been seen passing here |
| QUALITY-004 | **Closed for the diagnosed cause; stability not yet proven** | Real cause found and fixed: the open-in-email message was wiped ~100 ms after appearing because the store re-announced unchanged settings on every save (a product bug, see below), and the test read it without waiting. Also `until`/`expectText` now say what they waited for and what they last saw | Consecutive-run count in [08](08-test-and-verification-report.md); not ten unless stated there |
| QUALITY-005 | **Closed** | Deleted `production-readiness.js` and the dead `cx-consistency-check.js`; removed the `store.set` monkey-patch, the false "System error" notice and ~100 lines of no-op consistency code from `src/app.js`; added log-only `src/components/global-errors.js`; deleted two vacuous tests (`assert.ok(true)`) | none known |
| QUALITY-001 | Stays fixed | Regression tests in `test/error-visibility.test.js` and `test/e2e.test.js` ("errors: …") | |
| DATA-008 | **Closed** (desktop SQLite) | `lib/db.js` counts unreadable rows (never deletes or rewrites them); `sqliteDb.js` turns the count into a content-free notice; the store keeps it in step; `#notices` is a polite live region | The same for other backends was already handled by browser storage's own notice |
| DATA-009 | **Pilot portion closed; the rest open** | Backup and restore procedure with the real WAL behaviour, tested at the database layer (`test/db-backup.test.js`) | Full JSON export/import and erase-all are **not built** (out of scope; follow-up) |
| CX-002 | **Closed** | Explanation (why / who can change it / what to do instead) sits directly above the disabled Generate button; 375 px browser assertion | |
| CX-004 | **Closed** | Follow-up panel and History say copying/opening doesn't prove it was sent, using the recorded handoff date; absent for sent records | |
| CX-001 | **Partly closed** | First-run checklist for an install that hasn't used Cold yet, derived from real state (nothing stored as done; only Hide is remembered), accessible (axe), per-surface | The "five unassisted users reach a first draft in ≤ 10 minutes" target is a **human validation requirement and has not been run** |
| DOCS-005 | **Partly closed; owner action required** | `SECURITY.md`, issue template config, README links | The owner must enable GitHub private vulnerability reporting (or confirm the fallback mailbox). This could not be verified from here |
| (new) QUALITY-012 | **Found and fixed (twice)** | My first-run design wrote a marker setting; in web mode a settings write rewrites every stored list, which (1) clobbered a damaged store on page load and (2) rewrote the standalone library when a library arrived through a switch (caught by the existing `malformed localStorage` and `switching libraries never merges or destroys` tests). The checklist now writes nothing: visibility is derived from real state (established = a sent/replied draft or 3+ drafts), and only an explicit **Hide** is stored | Heuristic for "established" is simple by design; revisit with pilot feedback |
| (new) UX-regression | **Found and fixed** | After "Open in email" the on-screen "Cold hasn't sent anything" message vanished ~100 ms later in paired mode (every replica save re-announced unchanged settings; Write rebuilt the draft card). I introduced this with the follow-up handoff recording. Now announced only when settings change; asserted in `test/extension.test.js` | |

## Summary

| ID | Title | Severity | State | Blocks launch |
|---|---|---|---|---|
| QUALITY-001 | Head of the branch had 12 red browser tests; a regression from `1e34b87` | High | Fixed | (was) all |
| QUALITY-002 | No CI or release gating; tests skip silently | High | Partly closed (workflow written, not yet run on GitHub) | **All** until it has run green |
| QUALITY-008 | No evidence of draft quality with a real model | High | Open | **All** |
| QUALITY-010 | Desktop distribution unsigned, no update path, never built here | High | Open | **Desktop** |
| CX-001 | No onboarding or first-run guidance | High | Partly closed (checklist built; usability target unmeasured) | **All** until measured |
| DATA-001 | Google Sheets never run against real Google | High | Open | **Sheets** |
| DATA-011 | Cold blanked user-added Outreach columns on save | High | Fixed | (was) Sheets |
| SEC-006 | Privacy/README said "no cloud storage" after Sheets existed | High | Fixed | (was) all |
| DOCS-005 | No security-reporting, support or feedback route | Medium | Partly closed (needs owner setting) | **All** until the owner confirms |
| QUALITY-011 | Extension is "load unpacked" only | Medium | Open | **Extension** |
| CX-002 | Hosted web with no model is a dead end for visitors | Medium | Fixed | — |
| CX-004 | "Follow-up due" for an unsent draft is unexplained | Medium | Fixed | — |
| CX-005 | Mapper didn't match recognised columns without a name column | Medium | Fixed | No |
| PARITY-001 | Sheets verified on web only, via a fake sign-in | Medium | Open | Sheets |
| PARITY-002 | Sheets removes leads/drafts from desktop pairing sync | Medium | Open | Sheets |
| PARITY-003 | Follow-ups verified on web only | Medium | Open | No |
| PARITY-005 | Claude-artifact runtime has no tests | Medium | Open | Only if that mode ships |
| DATA-002 | `drive.file` may not allow cross-surface sheet reuse | Medium | Hypothesis | Sheets |
| DATA-003 | "Stop using Google Sheets" didn't revoke authorisation | Medium | Fixed | (was) Sheets |
| DATA-004 | Leads are last-writer-wins (all backends) | Medium | Open | No (document) |
| DATA-005 | Unreadable sheet at start-up shows an empty list | Medium | Mitigated | Sheets |
| DATA-007 | Sheets mode has no offline copy | Medium | Open | Sheets |
| DATA-008 | SQLite silently omits unreadable rows | Medium | Fixed | — |
| DATA-009 | No full export, backup/restore or erase | Medium | Backup/restore documented and tested at the database layer; export/import/erase open | Condition met for a pilot |
| QUALITY-003 | 5 tests need a display/Electron; unrunnable here | Medium | In the CI job; still unrun here | via G1 |
| QUALITY-004 | Extension integration tests flaked in whole-suite runs | Medium | Cause fixed; stability per [08](08-test-and-verification-report.md) | via G1 |
| QUALITY-005 | Global error layer masks failures; dead module | Medium | Fixed | — |
| QUALITY-007 | On-device model unverifiable offline; pins not recorded in shipped build | Medium | Open | On-device model |
| SEC-001 | Extension provider keys unencrypted | Medium | Open (documented) | Accepted limitation |
| SEC-003 | Hosted web without access code is open | Medium | Open (documented) | Operator |
| DOCS-001 | README is a monolith | Medium | Open | No |
| DOCS-002 | Dated audits read as current | Medium | Fixed | — |
| DOCS-003 | No getting-started/configuration/troubleshooting | Medium | Fixed | — |
| CX-003, CX-007, CX-008 | Settings length; mobile check of new screens; footer omitted leads | Low | Open / Hypothesis / Fixed | No |
| CX-006 | History intro grammar | Low | Fixed | No |
| PARITY-004 | No Leads-specific extension test | Low | Open | No |
| DATA-006, DATA-010 | Partial-write test gap; non-transactional SQLite import | Low | Open | No |
| SEC-002, SEC-004, SEC-005 | Packaged client secret; real-Chrome sign-in/CSP; dev advisory | Low | Hypothesis / Hypothesis / Open | No |
| QUALITY-006, QUALITY-009 | Node engines mismatch; Chromium-only matrix | Low | Open | No |
| DOCS-004, DOCS-006 | Aspirational standards doc; stale positioning copy | Low | Fixed (banner) / Open | No |
| OPP-001…005 | Opportunities | Opportunity | — | No |

---

## High

### QUALITY-001: Head of the branch had 12 red browser tests (regression from `1e34b87`)
* **State:** Fixed in this PR. **Category:** quality. **Surfaces:** web, desktop, extension (shared `src/app.js`).
* **Observed vs expected.** `npm test` at the start of the audit: 12 failures. Expected: green. At `d6dc53c` (parent of `1e34b87`) the browser suite passes 48/48; at `1e34b87` it fails 11 (R8).
* **Cause.** (1) `src/app.js` and `src/components/production-readiness.js` treated every `"error"` store topic as a failure. `compose.js` emits `"error"` with `null` to *clear* an error at the start of every Generate, so each generation logged "Store error detected" and tried to show a "System error" notice. (2) The new `window` `error` handler logged the browser's harmless `ResizeObserver loop…` notice as an application error.
* **Reproduce.** Check out `1e34b87`, `npm test test/e2e.test.js`.
* **User impact.** Test gate unusable; transient false "System error" markup on generation.
* **Remediation done.** Ignore a cleared error; ignore the ResizeObserver notice. Failures 12 → 1 environment-only (`desktop-mail`). **Residual risk:** the blanket layer remains (QUALITY-005).
* **Acceptance.** `npm test` has no failures other than documented environment-blocked tests; evidence: [08](08-test-and-verification-report.md).
* **Owner.** `src/app.js`, `src/components/`. **Blocks launch.** No longer.

### QUALITY-002: No CI, no release gating, and silent skips
* **State:** Open. **Surfaces:** all. **Confirmed:** `.github/` does not exist; `package.json` has no pre-push hook; test files skip when Chromium or `extension/dist` is missing (`test/*.test.js` `SKIP`).
* **Observed vs expected.** The suite was red on the branch for several commits unnoticed (QUALITY-001). With dev dependencies installed but `extension/dist` unbuilt, 23 tests (the extension, parity and layout tests that guard the three-surface claims) were skipped; with no dev dependencies installed, 91 browser tests were skipped (the first run in this audit). Skips appear only as `# skipped N` in the summary and do not fail the run.
* **Impact.** Regressions merge; "green" can mean "mostly skipped".
* **Remediation.** A CI workflow that builds the bundle, runs `check:app`, builds the extension, installs Chromium, runs `npm test` under `xvfb-run`, and **fails when a prerequisite is missing** (convert `SKIP` to an error when `CI` is set); require it for merge; add a release workflow for G2.
* **Acceptance.** A pull request with a deliberately failing test is blocked; a run with Chromium removed fails rather than skips; one green run on the main branch recorded.
* **Dependencies.** QUALITY-003, QUALITY-004. **Owner.** repo root (`.github/`), `test/`. **Blocks launch.** All.

### QUALITY-008: No evidence of draft quality with a real model
* **State:** Open. **Surfaces:** all. **Confirmed:** every generation test uses `test/helpers/env.js` `startMock` canned output; `smoke:model` is gated; the validation experiment is "prepared, NOT executed" (`docs/validation/README.md`).
* **Impact.** The product's core promise (an email worth sending) is untested; tests prove plumbing, rules and honesty only.
* **Remediation.** Run the validation plan or an equivalent: N real recipients, real models, measured counts (sent, replied) and reviewer ratings; record model and prompt version.
* **Acceptance.** A reported result with denominators for at least one provider per surface; defects fed back into `prompts.js`/`rules.js`.
* **Owner.** `src/domain/prompts.js`, `rules.js`; product. **Blocks launch.** All (broad).

### QUALITY-010: Desktop distribution is unsigned, has no update path, and was not built here
* **State:** Open. **Confirmed:** `package.json` `build` has no signing/notarisation/identity/publish config; no workflow; no auto-update code in `desktop/main.js`. `electron-builder` was not run in this audit.
* **Impact.** First-run OS warnings or blocks; users cannot receive fixes; a packaged build's behaviour (including `desktop/google.json` inclusion) is unverified.
* **Remediation.** Build per OS in CI; sign and notarise; choose an update mechanism or document manual updates; smoke-launch the packaged app (`T:desktop-mail` under xvfb).
* **Acceptance.** Signed artifacts for each target OS installed and launched on a clean machine; update procedure documented and exercised once.
* **Owner.** `package.json`, `desktop/`. **Blocks launch.** Desktop.

### CX-001: No onboarding or first-run guidance
* **State:** Open. **Surfaces:** all. **Evidence:** source search finds no onboarding/welcome/first-run flow; R1; `T:e2e` "first use… first action is obvious" asserts only that no fabricated data appears.
* **Observed vs expected.** A new user lands on a long empty form; nothing says "set up a model, add a product, write your first draft", offers sample data, or points to Leads. Expected (journey 2): a person understands the value and reaches a first draft without outside help.
* **Impact.** Time to first value depends on prior knowledge; the main adoption risk for people who did not build Cold.
* **Remediation.** A dismissible first-run checklist (model ready, product added, first draft, optional leads) that adapts per surface; link the template.
* **Acceptance.** Five unassisted first-time users reach a first copied draft in ≤ 10 minutes (G3), measured; the checklist passes axe and keyboard checks.
* **Owner.** `src/views/compose.js`, `src/app.js`. **Blocks launch.** All.

### DATA-001: Google Sheets has never been run against real Google
* **State:** Open. **Confirmed:** every Sheets test uses `test/helpers/sheets-mock.js`, a fake `window.google`, a stand-in token endpoint, or a fake `chrome.identity`. No Google client id exists in the repo.
* **Impact.** Real consent screens, token behaviour, `drive.file` semantics, quotas, cell formatting (`valueRenderOption=FORMATTED_VALUE`, formula-looking text), and CSP interaction are unknown. The feature is opt-in and off unless configured.
* **Remediation.** Create the Cloud project and clients; run journeys J8, J9, J16, J17 on each surface that ships it with a real account; record results; fix what differs from the stand-in; keep the feature off by default until then.
* **Acceptance.** Gate G7 passes with a dated, build-referenced run on each shipped surface.
* **Dependencies.** DATA-002, SEC-004. **Owner.** `src/services/sheets*.js`, `lib/google.js`. **Blocks launch.** Sheets.

### DATA-011: Cold blanked columns the user added to their own Outreach sheet
* **State:** Fixed in this PR (Confirmed first by a probe). **Surfaces:** all with Sheets.
* **Observed vs expected.** Adding a column (e.g. "My deal size") to the Outreach tab and then editing that record in Cold set the cell to empty. Expected: Cold leaves cells it does not own alone.
* **Cause.** `sheetsDb.store()` rewrote the whole row range from Cold's columns, padding unknown columns with `""`.
* **Remediation done.** `rowFor()` keeps the last-read value of every column Cold doesn't own (and, on Leads, writes extra fields only for names the lead has). Regression test: `T:sheets` "columns a person adds to their own sheet… survive Cold saving that row". Limit: a Leads extra-field value over 2,000 characters is truncated by the existing field limit.
* **Owner.** `src/services/sheetsDb.js`. **Blocks launch.** No longer (Sheets still blocked by DATA-001).

### SEC-006: Privacy statements became false once Google Sheets existed
* **State:** Fixed in this PR. **Evidence.** README ("no cloud database… the only way surfaces share data is pairing") and `docs/privacy-and-data-flow.md` ("No Cold cloud backup, account sync…"; "stored on your device") contradicted the Sheets feature, which sends leads and full outreach records to Google.
* **Remediation done.** Both corrected; Sheets section added with what goes to Google, scope, token locations, stopping. **Acceptance for the future.** Any PR that adds a data path updates the privacy document (add a checklist item).
* **Owner.** `README.md`, `docs/privacy-and-data-flow.md`. **Blocks launch.** No longer.

---

## Medium

### DOCS-005: No security-reporting, support or feedback route
Open. No `SECURITY.md`, `CONTRIBUTING.md`, issue template or contact in docs. **Remediation:** the owner names a security contact and an issue route; add `SECURITY.md`; link from README and Settings. **Acceptance:** a reader can find how to report a vulnerability and a bug in under a minute. **Owner:** repo root. **Blocks:** all (a minimal route).

### QUALITY-011: Extension is "load unpacked" only
Open. `README`/`getting-started`: Developer mode required; no packaging script or store assets. **Remediation:** package (zip, version, icons exist), store listing or documented sideload with update steps; justify the host permissions. **Acceptance:** installable by a non-developer. **Owner:** `extension/`. **Blocks:** Extension.

### CX-002: Hosted web with no model is a dead end for a visitor
Open. R5: disabled **Generate draft** with the explanation below the fold; Settings is unavailable on hosted servers by design. **Remediation:** place the message beside the button; say who can fix it; offer the desktop app. **Acceptance:** a screenshot test shows the message adjacent to the button at 375 px. **Owner:** `src/views/compose.js`. **Blocks:** hosted web.

### CX-004: "Follow-up due" for a draft that was only copied is unexplained
Open. R3: filter "Follow-up due", row status "Draft". Behaviour is by design (Cold can't tell if you sent it) but the panel doesn't say so. **Remediation:** when status is Draft and a handoff exists, add "You copied this on {date}. If you haven't sent it, send it, then press Mark sent." **Acceptance:** text appears in the follow-up panel and History row; covered by an e2e assertion. **Owner:** `src/views/followUpPanel.js`.

### CX-005: Mapper didn't match recognised columns when no name column existed
Fixed. R2: `Employer` and `Mail` were left as "Don't import". `suggestMapping` now matches recognised columns independently of the name (`detectColumns`). Test: `T:leads` ("recognised columns (Employer, Mail) are matched…"). **Owner:** `src/domain/leads.js`.

### PARITY-001: Sheets verified on web only, through a fake sign-in
Open. Desktop: real server routes against a stand-in token endpoint only; extension: fake `chrome.identity` unit test; no real-Chrome extension run, and `T:extension` doesn't cover Sheets. **Remediation:** an extension integration test with the real side panel and a stand-in; a desktop route+UI test; then real runs under DATA-001. **Acceptance:** each surface has a test through its own sign-in path to a written row. **Blocks:** Sheets.

### PARITY-002: Sheets takes leads and drafts out of the desktop pairing sync
Open. **Confirmed by reading:** `splitDb` routes `leads`/`emails` to the sheet; the replica/hub sync only sees what is written to the primary store. Two surfaces paired to the desktop app, one on Sheets, will not share leads/drafts; a surface on Sheets and a surface on SQLite are independent. **Not covered by a test.** **Remediation:** decide and document the rule (Sheets disables hub sync for those kinds, or the hub reads/writes through Sheets); show it in Settings when both are on. **Acceptance:** a test for the chosen rule and a sentence in the setup flow. **Blocks:** Sheets.

### PARITY-003: Follow-ups verified on web only
Open. `T:followup` is pure domain; `T:e2e` exercises web. Extension and desktop share the code but no test drives them. **Acceptance:** one follow-up journey test per surface. **Owner:** `test/`.

### PARITY-005: Claude-artifact runtime (`window.claude`) has no tests
Open, **Unverified**. `src/services/platform.js` has a branch for it; README documents it; no test targets it. **Remediation:** a stand-in `window.claude` test, or remove the mode and the README section. **Blocks:** only if that mode ships.

### DATA-002: `drive.file` may not allow a sheet created on one surface to be opened from another
Hypothesis. `drive.file` is granted per OAuth client; web, desktop and extension use different clients. "Use a spreadsheet Cold already made" may fail across surfaces. **Verify** under DATA-001; if confirmed, make each surface create its own sheet or use one client across surfaces; fix the setup copy. **Blocks:** Sheets.

### DATA-003: "Stop using Google Sheets" didn't revoke authorisation
Fixed. R4/`T:sheets-e2e`: stop now also signs out and asks Google to revoke (web: when a token is held; desktop server: revoke endpoint; extension forgets its flag). Remaining gap: the extension makes no revoke call. **Owner:** `src/views/sheetsSetup.js`, `googleAuth.js`.

### DATA-004: Leads are last-writer-wins on every backend
Open (characterised by a test for Sheets). Only outreach records are versioned (`saveEmail`); `saveLead`/`saveProduct` write unconditionally. **Remediation:** send `expected` for leads and reuse the merge; start with Sheets where multi-device use is the point. **Acceptance:** two-device edit of different fields merges; same field is refused. **Owner:** `src/state/store.js`, `sheetsDb.js`.

### DATA-005: A sheet that can't be read at start-up shows an empty list
Mitigated. Characterised by test; this PR adds a banner and a `sheets-e2e` test. Still no cached copy. **Remediation:** see DATA-007. **Blocks:** Sheets.

### DATA-007: Sheets mode has no offline copy
Open. Not offline with Sheets as the source of truth (the stores run without a network otherwise). **Remediation:** keep a read-only local cache of the last good read; queue writes. **Acceptance:** with the network off, the last-read leads display with a notice. **Blocks:** Sheets.

### DATA-008: SQLite silently omits unreadable rows
Open. R6: a row with non-JSON `data` is absent from the snapshot with no warning (the row is kept in the file). **Remediation:** return a count and show the standard "N saved items couldn't be read and were skipped" notice that browser storage already uses. **Acceptance:** a test with a corrupt row shows the notice.

### DATA-009: No full export, backup/restore or erase
Open. Only *Leads → Export CSV*; the documented backup is "copy `cold.db`". No "erase everything". **Remediation:** an Export all (JSON) and Import, and a confirmed Erase all; document. **Acceptance:** round-trip test; erase removes local data and, optionally, offers Google sign-out. **Condition for launch.**

### QUALITY-003: Five tests can't run without a display or Electron
Open. `desktop-mail` (Electron: `Failed to connect to the bus… launch`), and four `extension-layout` tests (`Missing X server or $DISPLAY`). Not product failures; not verified either. **Remediation:** run under `xvfb-run` in CI (QUALITY-002).

### QUALITY-004: Extension integration tests flaked in whole-suite runs
Partly fixed. Three whole-suite runs, three different outcomes for the extension tests: run 1 failed `extension paired with a running app…` (a wait for the desktop database to show the sent status timed out); runs 2 and 3 (parallel and `--test-concurrency=1`) failed `on-device model (FAKE runtime) and a model server…`. That second one is diagnosed: the test called `isVisible('#askEngineField')` straight after navigating to Settings, which does not wait, while the extension builds Settings asynchronously; it passed when run alone (17/17 for the whole file) and failed when the machine was busier. **Fixed in this PR** by waiting for the element. The first is **not diagnosed**: it passed 4/4 alone and in the later full runs. **Acceptance:** 10 consecutive whole-suite runs in CI with no extension-test failure; the remaining timeout converted to a condition wait with a clear message.

### QUALITY-005: A blanket error layer masks failures; one module is dead
Open. `production-readiness.js` replaces `store.set` with a version that swallows exceptions and returns `null`, and an `unhandledrejection` handler that `preventDefault()`s and shows a generic notice; the notice code duplicates `app.js`. `cx-consistency-check.js` is never imported (and would add `tabindex` and `aria-current` if wired). **Impact:** an exception thrown while updating state, or any unhandled promise rejection, is swallowed or turned into a generic message, which hides the cause and makes real faults look like noise; it also forced the test failures in QUALITY-001 to be diagnosed by bisection. **Remediation:** remove the monkey-patch and the dead module; keep per-operation error handling; keep the global handler for logging only. **Acceptance:** `store.set` throws as before; tests assert a rejected save surfaces.

### QUALITY-007: On-device model can't be verified offline; pins not recorded in the shipped build
Open. `verify:local-model` fails "fetch failed" for 4 models here; `T:local-model` asserts the shipped build "fails closed (pins not yet recorded)". **Remediation:** record pins; run verification in CI with network; do a real WebGPU run. **Blocks:** on-device model only.

### SEC-001: Extension stores provider keys unencrypted
Open, documented in the UI and README. **Acceptance for closing:** either accept and keep the label, or prefer the paired desktop app's keychain-held key and remove the extension's own.

### SEC-003: Hosted web without `COLD_ACCESS_TOKEN` is open
Open, documented (README, startup warning). **Remediation:** refuse to start with `HOST=0.0.0.0` and no token, or require an explicit override.

### DOCS-001: The README is a monolith
Open. 250+ lines mixing marketing, setup, reference. **Remediation:** split (see [09](09-documentation-remediation.md)).

### DOCS-002 / DOCS-003
Fixed. Dated audits bannered as historical; getting-started, configuration and troubleshooting added.

---

## Low

Low findings are recorded compactly: the acceptance criterion for each is that the stated defect no longer reproduces by the method named in its entry (a test, a screenshot, or the listed check). Each names its component in the entry.

* **CX-003** Settings is one long page; new sections sit at the bottom (R4). Group or tab it. *Open.*
* **CX-006** History intro read "History are saved in this browser only…". *Fixed* ("Your drafts…"). **CX-008** Footer/Settings sentence omitted leads. *Fixed* ("Products, drafts and leads…").
* **CX-007** The import-review mapper table and Sheets steps were not inspected at 375 px. *Hypothesis.* Check with the responsive test.
* **PARITY-004** No Leads-specific extension test (shared module). *Open.*
* **DATA-006** An import that fails between Sheets calls (update vs append) isn't tested as a partial failure; ids make retry safe by design. *Hypothesis.*
* **DATA-010** CSV import into SQLite is a sequence of writes, not one transaction (`sqliteDb.js` `setMany`). Retry-safe; shows the truth after re-read. *Open.*
* **SEC-002** A desktop Google client secret in `desktop/google.json` is packaged. Not confidential per Google, but owners should know. *Hypothesis.*
* **SEC-004** Real Google sign-in under the page CSP and the extension's `response_type=token` flow weren't run in real Chrome. *Hypothesis.*
* **SEC-005** `npm audit`: 1 moderate dev-toolchain advisory (`sprintf-js` via `electron-builder`); `--omit=dev`: 0. *Open.*
* **QUALITY-006** `package.json` `engines.node >=18` but SQLite storage needs `node:sqlite` (22.13+; documented in README/`.env.example`; Electron bundles it). *Open.*
* **QUALITY-009** Browser tests run on Chromium only. *Open.*
* **DOCS-004** `docs/ux/cx-standards.md` read as implemented. *Fixed (banner).* **DOCS-006** Positioning copy is stale ("five facts"). *Open.*

## Opportunities

* **OPP-001** Reference products by id in leads. **OPP-002** Remember a CSV mapping per header set. **OPP-003** Follow-up alerts (desktop notifications, email digest). **OPP-004** Push-style Sheets sync (Apps Script webhook) instead of 20 s polling. **OPP-005** A "copy diagnostics" button (versions, storage kind, last Sheets status; no content). See [05](05-capability-catalog.md).
