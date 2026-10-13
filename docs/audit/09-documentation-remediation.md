# 09. Documentation remediation

## Principles applied

One authoritative home per topic ([`docs/README.md`](../README.md) is the index and ownership table). Current behaviour is separated from plans and from history. Every changed claim was checked against the source or a test. Nothing was deleted: obsolete material was **bannered as historical** rather than removed, because it is referenced and records real decisions. No document contained a secret; none was added.

## Inventory and disposition

Verdicts: **Accurate** · **Incomplete** · **Stale** · **Misleading** · **Duplicated** · **No longer relevant**. "Checked" means compared against code or tests in this audit.

| Document | Audience | Verdict (before) | What was done | Evidence of check |
|---|---|---|---|---|
| `README.md` (250 lines) | everyone | **Misleading** in three places; **Incomplete**; a monolith (marketing + setup + reference) | Status banner and doc pointers added; "What's in the MVP" → "What it does" and now lists Leads, follow-ups, tweets, extension features, Sheets; **privacy paragraph corrected** (it said there is no cloud storage; Sheets can send leads/drafts to Google); install-command comment corrected (it listed four dev deps; there are two runtime and five dev); Sheets section says "not yet verified against real Google" | package.json, `server.js`, audit 07 |
| `docs/privacy-and-data-flow.md` | users, reviewers | **Misleading** (contract and "no cloud" statements) | Contract and boundary sentences corrected; new "Google Sheets" section (what goes to Google, scope, token locations, stopping, not offline, not covered by the privacy test) | code paths in [07](07-security-privacy-data-authority.md) |
| `docs/google-sheets.md` | users, operators | **Incomplete / over-confident** (written with the feature) | Verification-status banner; own-columns rule; concurrency; start-up behaviour; not synced via pairing; stopping now revokes; "things to check" marked not done | `T:sheets` etc. |
| `docs/library-contract.md`, `docs/standalone-surfaces.md` | developers, users | **Incomplete** (predate Sheets) | Note added at top | — |
| `docs/data-integrity.md` | developers | **Accurate**, **Incomplete** (leads) | Limitations updated: leads are unversioned, last-writer-wins | `src/state/store.js` `saveLead` |
| `docs/shared-library.md`, `docs/people-search.md`, `docs/second-check.md` | users | Accurate (skimmed; consistent with tests named in them) | none | `T:shared-library`, `T:people`, `T:second-check` exist and pass |
| `docs/ask-cold.md` (282 lines) | users | **Not line-checked** in this audit; no contradiction found | none; listed so the gap is visible | `T:extension`, `T:opportunity*` |
| `docs/hf-ssh-provider.md`, `docs/hf-ssh-test.md` | developers | Accurate; clearly labelled experimental | none. Note: `provider-config.json` selects this provider on Vercel **previews** | `provider-config.json`, `server.js` |
| `docs/ux/initial-audit.md`, `parity-audit.md`, `experience-changes.md`, `implementation-report.md` | developers | **Stale** (2026-10-10, before leads/follow-ups/Sheets) but honest history | **Historical banner** added, pointing to this audit | dates, git log |
| `docs/ux/cx-standards.md` | developers | **Misleading** if read as current: states standards as if implemented; added in commit `1e34b87` alongside code that masks errors | Banner: aspirational, not a description | `src/components/production-readiness.js`, QUALITY-005 |
| `docs/evaluation/2026-10-10-commercial-evaluation.md` | product | **Stale** capability statements; recommendation untouched | Historical banner | — |
| `docs/validation/*` (README, offers, decision-criteria, recruitment, product-gaps, report, tracker) | product | Accurate: states "prepared, NOT executed", no fabricated evidence | none | each file's own status line; no contacts private files committed (`.gitignore`) |
| `.env.example` | operators | **Incomplete** (shows the gateway default only) | Not edited; full reference is now `docs/configuration.md` | `server.js`, `lib/providers.js` |
| `examples/leads-template.csv` | users | Accurate (byte-equal to the generator, tested) | none | `T:leads` |
| `package.json` `description` | everyone | **Stale** ("A focused cold-email generator. Give it five facts…") | Not changed (positioning decision; DOCS-006) | |

## New documents (and why)

| Document | Gap it fills |
|---|---|
| `docs/README.md` | There was no index, no statement of which document is canonical, no ownership |
| `docs/getting-started.md` | No quick-start for a person who did not build Cold; explains CSV import and mapping with the real template |
| `docs/configuration.md` | Environment variables were spread over README, `.env.example` and source; several (`COLD_DB_FILE`, `COLD_SETTINGS_FILE`, `TREG_TOKEN`, per-provider keys, Google) were undocumented in one place |
| `docs/troubleshooting.md` | None existed; contains only failure modes observed in code/tests, using the app's own messages |
| `docs/audit/*` | This audit |

## Canonical documentation structure (target)

1. **Product:** `README.md` (what it is, run it), `docs/getting-started.md`.
2. **Operate:** `docs/configuration.md`, `docs/troubleshooting.md`, `docs/google-sheets.md`.
3. **Trust:** `docs/privacy-and-data-flow.md`, `docs/data-integrity.md`, `docs/audit/07-…`.
4. **Architecture:** `docs/standalone-surfaces.md`, `docs/shared-library.md`, `docs/library-contract.md`, `docs/audit/02-…`.
5. **Readiness and plans:** `docs/audit/`, `docs/validation/`.
6. **History:** `docs/ux/`, `docs/evaluation/` (bannered).

## What remains (not done here)

* **DOCS-001:** split the README into a short product page and reference pages (it still mixes marketing, setup, and ~25 sections of reference).
* **DOCS-005:** no `SECURITY.md`, `CONTRIBUTING.md`, release/deployment procedure, support or feedback route. These need the owner's decisions (contact, policy), so they are recorded, not invented.
* **DOCS-006:** positioning copy (`package.json` description, README tagline) still says "five facts" and does not mention leads, follow-ups, or the extension's page features.
* **Screenshots in user docs:** none exist in the product docs. The audit's screenshots are evidence, not marketing; user-facing screenshots should be regenerated from `scripts/audit-screenshots.cjs` when the UI settles.
* **`docs/ask-cold.md`** needs a line-by-line check against `extension/src/askCold.js`.
* **Links:** all relative links in files changed or added by this PR were checked by script (see [08](08-test-and-verification-report.md)); links in untouched historical documents were not.
