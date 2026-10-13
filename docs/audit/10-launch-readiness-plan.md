# 10. Adoption and launch-readiness plan

## Recommendation

| Scope | Recommendation | Basis |
|---|---|---|
| **General public launch** (all three surfaces, any user) | **No-go** | Gates G1 (no CI), G2 (no installable desktop/extension), G3 (no onboarding), G4 (draft quality unevidenced), G8 (no support/security route) all fail ([06](06-production-readiness.md)) |
| **Supervised pilot of Cold's core** with technically comfortable early adopters who build from source, **Google Sheets off** | **Conditional go** | The core loop (knowledge → draft → copy/handoff → record → follow-up, plus CSV leads) is verified on web and in shared code for desktop/extension, honest about what Cold cannot know, and data-safe in the ways tested. Conditions below (C1–C6) are small |
| **Google Sheets feature** | **No-go** (keep off by default) | Never run against real Google; G7 fails; three known data gaps (DATA-002, -004, -007) |

This recommendation is derived only from the evidence in this audit. **Remaining uncertainty:** real-model draft quality (the largest unknown); real Google behaviour; packaged desktop behaviour; extension behaviour in real, headed Chrome; manual accessibility; whether anyone other than the builder can complete setup unassisted. The commercial validation plan in [`docs/validation/`](../validation/README.md) was prepared and **not executed**; the audit does not substitute for it.

## Launch materials: what exists and what is missing

| Material | State |
|---|---|
| Product positioning / homepage | **Missing.** The app is the page; the README is the only description. `package.json` and README tagline ("five facts") are stale (DOCS-006) |
| Install and onboarding instructions | `docs/getting-started.md` added by this PR; the product has no in-app onboarding (CX-001) |
| Release artifacts / distribution | **Missing:** no installers, no store listing, no hosted instance referenced in the repo (QUALITY-010/-011) |
| CSV template | Present and tested (`examples/leads-template.csv`, in-app download) |
| Integration setup and permission explanations | Present in-app for Gmail handoff and Sheets; Google setup for operators in `docs/google-sheets.md` (unverified against real Google) |
| Provider and model setup | In-app (desktop/extension) and `docs/configuration.md` |
| Empty states and contextual help | Good for Leads/History; weak for first run (CX-001/-002) |
| Error messages and support path | Messages are specific and tested; **no support or security-reporting path** (DOCS-005) |
| Privacy and data-handling disclosure | `docs/privacy-and-data-flow.md` accurate after this PR; no in-app link to it beyond the data line in Settings |
| Known limitations, compatibility | Listed in README/docs; Chromium-only testing; Node ≥ 22.13 for SQLite outside Electron |
| Upgrade and recovery | Troubleshooting added; **no upgrade procedure**, no in-app backup/restore (DATA-009) |
| Feedback collection | **Missing** (by design no telemetry; no form or issue template either) |

## Prioritised checklist with exit criteria

### Phase 0: Conditions for a supervised pilot (days)

| # | Item | Findings | Objective exit criterion |
|---|---|---|---|
| C1 | CI that builds, runs the whole suite under a display, fails on missing prerequisites, and blocks merge | QUALITY-002, -003 | One green main-branch run; a deliberately red PR is blocked; a run with Chromium removed fails |
| C2 | Confirm the extension tests are stable (one flake diagnosed and fixed, one undiagnosed) | QUALITY-004 | 10 consecutive full CI runs without a flake |
| C3 | Name a security contact and an issue route; add `SECURITY.md` | DOCS-005 | Both reachable from README in one click |
| C4 | Explain "Follow-up due" on an unsent draft; put the no-model message next to the button | CX-004, CX-002 | e2e assertions for both |
| C5 | Tell the user when SQLite rows can't be read; document backup | DATA-008, DATA-009 (backup text) | Test with a corrupt row shows the notice; `getting-started` backup step verified by a restore |
| C6 | Pilot protocol: who, how many, what is measured, consent | `docs/validation/` | Plan executed and results reported with denominators |

### Phase 1: Beta (weeks)

| # | Item | Findings | Exit criterion |
|---|---|---|---|
| B1 | First-run checklist | CX-001 | 5 unassisted new users reach a first copied draft in ≤ 10 minutes |
| B2 | Signed desktop installers with a defined update path; packaged smoke test | QUALITY-010 | Installed and launched on a clean machine per OS; `desktop-mail` passes under xvfb on the packaged app |
| B3 | Extension packaged for a store or a documented sideload with updates | QUALITY-011 | Installed by a non-developer from the packaged artifact |
| B4 | Real-model quality evidence | QUALITY-008 | Reported measured result with denominators, one provider per surface |
| B5 | Export all, import, and erase | DATA-009 | Round-trip test; erase verified |
| B6 | Remove the blanket error layer and dead module | QUALITY-005 | `store.set` throws as before; rejected saves surface in tests |
| B7 | Surface-specific tests for follow-ups and Leads on desktop/extension | PARITY-003, -004 | One journey test per surface, in CI |
| B8 | Manual accessibility pass (keyboard + a screen reader) on the five screens and the new flows | — | Written results; defects filed |

### Phase 2: Google Sheets (only if the feature is kept)

| # | Item | Findings | Exit criterion |
|---|---|---|---|
| S1 | Cloud project, consent screen, one client per surface | DATA-001 | Clients created; verification requirements checked against Google's current policy |
| S2 | Real-account runs of J8, J9, J16, J17 on every shipping surface | DATA-001, PARITY-001, SEC-004 | Dated, build-referenced results; defects fixed |
| S3 | Answer the `drive.file` cross-client question | DATA-002 | Documented rule; setup copy matches |
| S4 | Decide the hub-sync rule | PARITY-002 | Documented and tested |
| S5 | Lead versions; offline cache | DATA-004, DATA-007 | Two-device merge test; offline-read test |
| S6 | Then, and only then, consider enabling by default | — | G7 passes |

### Phase 3: General availability

All of G1–G8 pass; no open High finding; accepted limitations published in release notes; support route staffed; one full dry-run of the release process (build, sign, publish, upgrade, rollback).

## Accepted limitations to publish (none is a defect against current documentation)

Cold cannot see sending or replies (by design). Follow-ups are reminders: Cold sends no alert. No telemetry or crash reporting (by design), so problems reach us only if reported. Extension provider keys are stored unencrypted in browser extension storage. A hosted server can see prompts in memory while forwarding them. Surfaces share data only when paired. Draft quality depends on the chosen model and is not evaluated by Cold's tests. Google Sheets (if enabled) is a preview and is not available offline.

## What would change this recommendation

*Toward go for broader adoption:* closing G1–G4 and G8 with the stated evidence, and a pilot whose measured results support the product's promise. *Toward no-go even for a pilot:* a failure of the core loop on a real model in the pilot, a data-loss report, or the CI work revealing failures currently hidden by skips.
