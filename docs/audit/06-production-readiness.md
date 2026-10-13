# 06. Production-readiness assessment

## Rubric and how it was applied

| Level | Definition |
|---|---|
| **P0 Absent** | No implementation exists for the stated requirement. |
| **P1 Prototype** | Basic functionality exists but the core workflow or safeguards are incomplete. |
| **P2 Functional** | Primary workflow works; meaningful edge cases or operational safeguards remain. |
| **P3 Launch-ready** | Critical journeys verified; error handling, security, persistence and recovery meet defined acceptance criteria. |
| **P4 Operationally mature** | Monitoring, diagnostics, maintenance, recovery and sustained operation have evidence appropriate to the risk. |

**Rules used.** (1) A capability's level is the **lowest level among its critical domains**; strengths elsewhere do not average a failure away. (2) Documentation quality, a passing suite, or an assertion alone earn nothing; a level needs evidence from a run, a probe, or code read against a test. (3) Evidence against a stand-in (mock model, stand-in Sheets API, fake `chrome.identity`) counts for *Cold's own logic* and never for the external system. (4) Level is judged **per capability on its weakest surface**; per-surface levels are in [03](03-parity-matrix.md). (5) Implementation status is reported separately from level (P0 is completeness, not a verdict).

**The twelve quality domains** (all considered for every capability): functional correctness · workflow completeness · reliability and recovery · data integrity and consistency · security and privacy · accessibility · performance and responsiveness · compatibility and installation · diagnostics and supportability · documentation and user guidance · upgrade and migration safety · operational readiness.

## Per-capability assessment

"Critical domains" are the ones where a failure would be serious for that capability. ✔ = evidence supports meeting the bar · ✖ = known failure or **no evidence** (stated) · ◐ = partly.

| Capability | Level | Critical domains and result | What holds it at this level |
|---|---|---|---|
| Product knowledge | **P3** | functional ✔ · data integrity ✔ (merge/refuse, storage-full fails loudly) · accessibility ✔(auto) | nothing launch-blocking; lead→product link (OPP-001) is outside this capability |
| Leads, CSV import, mapper, extra fields | **P3** | functional ✔ · data integrity ✔ (idempotent keys; review-before-save) · workflow ✔ · accessibility ✔(auto) · performance ✔ (5,000 rows in one save) | Fixed during audit: CX-005. Open: DATA-010 (Low) |
| Outreach status and sent copy | **P3** | functional ✔ · data integrity ✔ (19 integrity tests) · security n/a | none |
| Copy and email handoff | **P3** web/extension · **P2** desktop | functional ✔ · honesty of outcome ✔ · compatibility ◐ (desktop OS handoff test cannot run here) · security ✔ (allow-list in main process, tested where runnable) | QUALITY-003 |
| Follow-ups | **P2** | functional ✔ · data integrity ✔ · workflow ◐ (no alert; unsent-draft case unexplained) · **verified on web only** (PARITY-003) | PARITY-003, CX-004, OPP-003 |
| SQLite persistence (desktop) | **P2** | functional ✔ · data integrity ◐ (silent omission of unreadable rows; non-transactional import) · upgrade safety ✔ (v1→v2 in-place migration tested) · recovery ✖ (no in-app backup/restore/export) | DATA-008, -009, -010 |
| Hub sync (web/extension ↔ desktop) | **P2** | functional ✔ · reliability ◐ (queues offline; one load-sensitive test) · security ✔ (pairing code; extension can't read keys) · consistency ◐ (Sheets bypasses it) | QUALITY-004, PARITY-002 |
| Grounded drafting | **P2** | plumbing ✔ · reliability ✔ (failure keeps inputs) · **functional correctness against a real model ✖: no evidence** · security ✔ (only this draft's facts leave) | QUALITY-008 |
| Provider and model selection | **P2** | functional ✔ (mock endpoints) · security ◐ (extension keys unencrypted, labelled) · real provider ✖ | SEC-001, QUALITY-008 |
| Context capture, Ask Cold (extension) | **P2** | functional ✔ (stand-in pages) · privacy ✔ (explicit click; text stays local unless a hosted model is chosen) | QUALITY-004 (load flake) |
| Accessibility (whole product) | **P2** | automated axe ✔ on views and 16 added states, light and dark · **manual keyboard/screen-reader ✖** | none blocking; manual pass recommended |
| **Google Sheets (optional)** | **P1** | functional ✔ vs stand-in only · **functional vs real Google ✖** · data integrity ◐ (lead LWW; empty-on-unreadable; no offline) · security ◐ (narrow scope; refresh token server-side on desktop; real consent/CSP in Chrome ✖) · compatibility ✖ (`drive.file` per-client reuse unknown) | DATA-001, -002, -004, -005, -007, PARITY-001, -002, SEC-004 |
| On-device model | **P1** | functional ✔ vs stand-ins · real model ✖ (pins not recorded in shipped build; `verify:local-model` cannot reach network) | QUALITY-007 |
| Onboarding / first-run | **P0** | absent | CX-001 |
| Desktop distribution (install, sign, update) | **P1** | packaging configured · **signing ✖ · auto-update ✖ · never built or launched in this audit ✖** | QUALITY-010 |
| Extension distribution | **P1** | builds and loads unpacked · **store packaging ✖** | QUALITY-011 |
| Diagnostics and supportability | **P1** | no telemetry by design (privacy ✔) · no way to capture state for support ✖ · error layer masks failures ◐ | OPP-005, QUALITY-005 |
| Test automation and release gating | **P0** | no CI, no release workflow; silent skips can make a run look green | QUALITY-002 |
| Documentation and user guidance | **P2** (after this PR) | accurate to the source and reconciled ([09](09-documentation-remediation.md)); getting-started, configuration and troubleshooting added · no support/security-reporting path ✖ | DOCS-005 |

No capability reaches **P4**: no monitoring, alerting, or sustained-operation evidence exists anywhere (and Cold deliberately collects no telemetry).

## Critical-domain gates for launch

A launch of a given scope requires every row in its scope to pass the gate. Evidence required is stated so the gate can be closed objectively.

| Gate | Scope it applies to | Currently | Evidence needed to pass |
|---|---|---|---|
| **G1** The test suite runs automatically and a red run blocks release; no test silently skips in CI | all | **Fail** (no CI) | A workflow running `npm run build:app && npm run check:app && npm run build:extension && npm test` on every push under a display (xvfb) with Chromium installed; skip-on-missing-prerequisite turned into failure in CI; one green run recorded |
| **G2** A person other than the builder can install and start Cold on each launched surface | each launched surface | **Fail** for desktop (unsigned, unbuilt here) and extension (unpackaged); Web passes if hosted | Signed/notarised installers (or a stated, accepted "developer preview" with instructions) and a store or documented sideload path; an unassisted install on a clean machine, recorded |
| **G3** First-run path to a first draft without prior knowledge of Cold | all | **Fail** (no onboarding) | A first-run checklist, and a timed unassisted run (target: first draft in ≤10 minutes) |
| **G4** Draft quality evidenced with a real model on real recipients | core promise | **Fail** (mock only) | The experiment in `docs/validation/` executed, or an equivalent reviewed sample, with the result reported as measured counts |
| **G5** Nothing misleading in privacy or capability claims | all | **Pass after this PR** (SEC-006, DOCS-001/-002 fixed) | Re-check at each release against [07](07-security-privacy-data-authority.md) |
| **G6** Data cannot be silently lost or hidden | all | **Conditional** (DATA-008, DATA-009) | Unreadable rows surfaced to the user; a documented, tested backup/restore path |
| **G7** Optional integration verified against the real service | Google Sheets only | **Fail** (stand-in only) | A real-account run of J8, J9, J16, J17 on each surface that ships it, recorded with date and build; the `drive.file` cross-client question answered |
| **G8** A support and security-reporting path exists | all | **Fail** (none documented) | `SECURITY.md` and an issue/feedback route named by the owner |

### Gate status after the pilot-readiness PR

| Gate | Now | Why |
|---|---|---|
| G1 CI | **Partly met:** workflow, prerequisite enforcement and skip audit exist and were each demonstrated locally; **not yet run on GitHub**, and branch protection is a repository setting | `.github/workflows/ci.yml`, `test/00-ci-prerequisites.test.js`, `scripts/ci-check-skips.cjs` |
| G3 First-run path | **Not met:** the checklist exists; the measured ≤10-minute unassisted-user result does not | human validation required |
| G6 Silent data loss/hiding | **Met for a pilot:** unreadable rows are surfaced and preserved; backup/restore documented and tested at the database layer | export/import/erase still open |
| G8 Support/security route | **Partly met:** `SECURITY.md` written without claiming a disabled feature; **owner must enable private reporting or confirm the mailbox** | repository setting |
| G2, G4, G5, G7 | unchanged | |

## Release blockers, conditions and accepted limitations

* **Blockers for any broad launch:** G1 (QUALITY-002), G2 (QUALITY-010/-011 per surface), G3 (CX-001), G4 (QUALITY-008), G8 (DOCS-005).
* **Blocker for the Google Sheets feature only (keep it off by default until closed):** G7 (DATA-001, DATA-002), plus PARITY-002 decision.
* **Conditions to ship with:** G6 mitigations (DATA-008 warning, backup instructions), CX-002 copy fix for hosted web with no model, CX-004 follow-up wording.
* **Accepted limitations (state them in release notes; none is a defect against current documentation):** Cold cannot see sending or replies (by design); no reminders/alerts for follow-ups; no telemetry or crash reporting (by design); extension provider keys are stored unencrypted in browser extension storage (labelled); the hosted server can see prompts in memory while forwarding them (documented in `docs/privacy-and-data-flow.md`); web/extension/desktop do not share data unless paired; leads/outreach in Google Sheets are not offline.
