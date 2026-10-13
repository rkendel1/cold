# 08. Test and verification report

Nothing here is marked as passed unless it ran. Blocked, skipped and unavailable checks are listed with the reason. Mocks are never counted as evidence about an external system.

## Environment

Linux 6.18 (container, no display, no DBus), Node v22.22.0, npm, Chromium 1194 from `/opt/pw-browsers` driven by `playwright-core` 1.56.1, Electron 44 (installed; cannot launch without a display), axe-core 4.10.2. No network access to Google, model providers, or the model-pin hosts. Audited commit: `8583c99` at the start; final tree = that commit plus this PR's commits (`a69a731` and later). Command outputs were captured to files during the audit; the numbers below are copied from them.

## Existing suite: what it is evidence of

47 files, 323 tests as counted by the runner. By area: outreach/data integrity (`outreach*.test.js`, `data-api`, `db`, `sqlite-store`, `replica`, `shared-library`, `library-parity`: strong, use real stores, a real server and SQLite file, two tabs/windows); leads and CSV (`leads`, `leads-storage`, `e2e` ×6); privacy boundaries (`privacy`: real servers and browser, asserts which hosts are contacted); email handoff (`mailto`, `handoff`, `e2e`); extension (`extension` 17 tests with a real extension build in headless Chromium, `extension-layout`, `local-model`, `model-pins`); accessibility (`e2e` axe over every view, light and dark); and plumbing for the optional Sheets feature (`sheets*`, `google-*`). **Limits of that evidence:** all generation uses a canned model; all Sheets/Google behaviour uses stand-ins; nothing runs against a packaged desktop app; nothing runs on a browser other than Chromium; nothing runs in CI.

## Commands run and results

| # | Command / check | Result |
|---|---|---|
| 1 | `npm test` at audit start (HEAD `8583c99`, extension not built) | **284 pass, 12 fail** (summary lines; skip and total counts were not captured for this run) |
| 2 | Bisect: `node --test test/e2e.test.js` at `d6dc53c` (parent of `1e34b87`, in a throwaway worktree) | **48 pass, 0 fail** |
| 3 | Same at `1e34b87` (with `single-surface-value`, `cx-standards`) | **42 pass, 11 fail** (R8) |
| 4 | Root cause probes (headless Chromium + real server): console shows "Store error detected" on every Generate; window `error` events are `ResizeObserver loop completed with undelivered notifications` | Reproduced; fixed (QUALITY-001) |
| 5 | `npm test` after those fixes, extension still unbuilt | 295 pass, **1 fail** (`desktop-mail`), **23 skipped** (extension/parity/layout tests need `extension/dist`) |
| 6 | `npm run build:extension` | Built `extension/dist` |
| 7 | `npm test` with the extension built (before later fixes) | 311 pass, 7 fail: `desktop-mail`, four `extension-layout` (no display), `extension paired with a running app` (timed out waiting for a sync condition), `parity` (**real stale expectation** from my Settings changes: fixed) |
| 8 | `node --test test/extension.test.js` alone, whole file | **17 pass, 0 fail** (so the earlier extension failures did not reproduce in isolation) |
| 9 | Two further whole-suite runs (parallel, then `--test-concurrency=1`) | Both failed `on-device model (FAKE runtime) and a model server…` once the other tests had run; **root cause found** (test called `isVisible()` immediately after navigation; Settings renders asynchronously) and fixed |
| 10 | `npm run check:app` (committed bundle current) | Pass (exit 0) after `npm run build:app`. The bundle-freshness *test* (`bundle.test.js`) failed once, in a run where `src/` had been edited after the last build, which is what it is for |
| 11 | **Final `npm test` on the final tree** (extension built, bundle built) | **323 tests: 317 pass, 5 fail, 1 skipped, 0 cancelled** (4 min 6 s). Failures: `desktop-mail` (Electron cannot start: no display/DBus) and four `extension-layout` tests ("headed browser without an X server"). Skipped: `REAL MODEL` test (needs `COLD_REAL_MODEL=1` and a model). **All five failures are environmental; none was verified as passing or failing in the product.** |
| 12 | `npm audit --omit=dev` / `npm audit` | 0 vulnerabilities / 1 moderate dev-toolchain advisory (`sprintf-js` via `electron-builder`) |
| 13 | Secret-pattern scan of `src`, `lib`, `server.js`, `extension/src`, `desktop`, committed bundle | No matches (R9) |
| 14 | Link check `node scripts/audit-links.cjs` over `README.md` and `docs/**/*.md` | See "Link validation" below |
| 15 | `npm run verify:local-model` | **Blocked: no network** (`fetch failed` for the 4 pinned models) |
| 16 | `npm run smoke:model` | **Not run** (gated; no model/network) |
| 17 | `npm run desktop:build` / packaging | **Not run** (would need per-OS tooling; never exercised) |
| 18 | `xvfb-run` for the display-dependent tests | **Unavailable** (`xvfb-run` not installed) |

## Targeted checks added or run for this audit

| ID | What | Result | Where |
|---|---|---|---|
| R1–R5, R7 | Real screenshots and a real-browser axe scan of the screens added after the original accessibility test (mapper, extra fields, follow-up panel and settings, Sheets steps; light and dark) | 7 screenshots; **axe: 0 violations in 16 screen/theme states** (automated WCAG 2.0/2.1 A+AA only) | `scripts/audit-screenshots.cjs`, `scripts/audit-axe.cjs`, `screenshots/` |
| R6 | SQLite probe of `lib/db.js` | double write idempotent; stale write → `conflict`; 700 KB doc → 413; invalid id → 400; hand-corrupted row silently omitted; WAL, `user_version` 2 | one-off script (outputs in [07](07-security-privacy-data-authority.md)) |
| R8 | Regression bisect (items 2–3) | as above | git history |
| R9 | Secret scan, log scan (server has 3 `console` calls: startup banner only), `npm audit` | as above | |
| — | **New regression tests** | CSV mapper matches recognised columns without a name column; user-added Outreach columns survive saves; "Stop" forgets the Google sign-in; start-up banner when the sheet is unreadable; Settings sections in the parity test | `test/leads.test.js`, `test/sheets.test.js`, `test/sheets-e2e.test.js`, `test/parity.test.js` |
| — | **Characterisation tests** (pin current limitations) | Leads in a sheet are last-writer-wins while outreach edits are detected (DATA-004); an unreadable sheet opens empty with an error status (DATA-005) | `test/sheets.test.js` |

## What each important journey was verified by

| Journey | Verified by | Limitation |
|---|---|---|
| J1 first open | R1; `T:e2e` first-use | desktop install not run |
| J3 provider | `T:settings`, `T:provider`, R5 | mock endpoints only |
| J5–J7 CSV | `T:leads`, `T:e2e`, R2, R7, real reported file | — |
| J8–J9, J16–J17 Sheets | `T:sheets`, `T:sheets-e2e`, `T:google-oauth`, `T:google-auth` | **stand-ins only** |
| J10 SQLite | `T:db`, `T:sqlite-store`, `T:e2e`, R6 | — |
| J11 personalised draft | `T:e2e` | **canned model** |
| J12–J14 copy, Gmail handoff, follow-up | `T:e2e`, `T:followup`, `T:handoff`, `T:mailto` | handoff outcome unknowable by design; follow-ups web only; desktop OS handoff test not runnable here |
| J15 restart/switch | `T:e2e`, `T:sqlite-store`, `T:extension`, `T:shared-library` | Sheets interaction untested (PARITY-002) |

## Coverage gaps and unverified claims

* **Real model output quality** (QUALITY-008) and **real Google** (DATA-001) are unverified; stand-in results are not evidence about them.
* **Packaged desktop app, OS handoff, extension in headed Chrome** are unverified here (QUALITY-003, -010).
* **Surface-specific follow-up and Leads tests** do not exist for desktop and extension (PARITY-003, -004).
* **Claude-artifact runtime** has no test (PARITY-005).
* **Manual accessibility** (keyboard, screen reader) was not performed; axe is automated and finds a subset of issues.
* **Chromium only**; no Firefox/Safari run.
* **Flakiness:** one extension test failed once in the first whole-suite run and is undiagnosed (QUALITY-004).

## Link validation

`node scripts/audit-links.cjs` checks every relative Markdown link and `#anchor` in `README.md` and `docs/**/*.md`. **Result: 145 relative links in 41 files, 0 problems** (run after all documents were written; broken links reported by an earlier run were links to documents not yet written). External `https://` links were **not** checked (no network). A second check confirmed that every finding ID cited in any document exists in [11](11-remediation-backlog.md) (below).

## Reproducing

```sh
npm install && npm run build:app && npm run build:extension
npm test                         # needs Chromium; the display-dependent tests need xvfb-run or a desktop
npm run check:app
node scripts/audit-screenshots.cjs && node scripts/audit-axe.cjs && node scripts/audit-links.cjs
```
