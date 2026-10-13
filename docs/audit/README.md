# Cold product audit, experience parity and adoption readiness

**Audit date:** 2026-10-13 · **Audited commit:** `8583c99` (head of `claude/adoring-johnson-n7whfr` when the audit began); fixes made during the audit are in the commits after it (see [08](08-test-and-verification-report.md)) · **Repository:** `rkendel1/cold` (the only repository: all three surfaces, the server and the shared UI live in it)

This directory is the canonical audit. Nothing else in the repository competes with it as the statement of what Cold does today and how ready it is; other documents describe a topic and link here for the evidence.

| # | Document | Question it answers |
|---|---|---|
| 01 | [Executive summary](01-executive-summary.md) | What is Cold, what works, what is risky, is it ready? |
| 02 | [Repository and architecture inventory](02-architecture-inventory.md) | What exists, where, shared or per-surface, what was and wasn't inspected |
| 03 | [Feature and three-surface parity matrix](03-parity-matrix.md) | Per capability and surface: status, evidence, authority, readiness |
| 04 | [Customer journeys and CX audit](04-journeys-and-cx.md) | The 17 journeys end to end, friction, missing states |
| 05 | [Capability and maturity catalog](05-capability-catalog.md) | What Cold does vs. what it must harden vs. roadmap |
| 06 | [Production-readiness assessment](06-production-readiness.md) | Maturity per capability, gates, blockers, accepted limitations |
| 07 | [Security, privacy and data authority](07-security-privacy-data-authority.md) | Data flows, trust boundaries, sync semantics, verified risks |
| 08 | [Test and verification report](08-test-and-verification-report.md) | Commands, environments, actual results, what could not run |
| 09 | [Documentation remediation](09-documentation-remediation.md) | Inventory, disposition of every document, canonical structure |
| 10 | [Adoption and launch-readiness plan](10-launch-readiness-plan.md) | Prioritised checklist, exit criteria, go/no-go |
| 11 | [Remediation backlog](11-remediation-backlog.md) | Every finding: ID, severity, evidence, acceptance criteria, blocks launch? |

Screenshots are in [`screenshots/`](screenshots/). They were captured from the running app by [`scripts/audit-screenshots.cjs`](../../scripts/audit-screenshots.cjs) in headless Chromium against the test mocks (a canned model and a stand-in Google Sheets API). They show real UI and real layout; they do **not** show real accounts, real model output or real Google behaviour.

## How the audit was done

1. **Source first.** Every claim below was checked against code. Where a document and the code disagree, the code wins and the document is corrected or flagged ([09](09-documentation-remediation.md)).
2. **Run it.** The full suite was run (`npm test`), the app and extension were built, the bundle freshness check was run, and targeted probes were run against the real SQLite layer and the real server (scripts are kept: `scripts/audit-*.cjs`). Where something could not run here, the report says so and why.
3. **Tests are evidence, not proof.** Each important journey was traced to the test that exercises it, and the test was read to see whether it exercises the real path or a stand-in. Mocks are never counted as evidence of external behaviour.
4. **Reproduce a failure before explaining it.** The browser-test failures present at the start of the audit were bisected to a commit by running the same tests at the parent commit (green, 48 of 48) and the suspect commit (red).

## Conventions

**Implementation status:** *Verified* (implemented, and verified for the relevant behaviour) · *Partial* · *Surface-specific* (intentionally on selected surfaces; rationale given) · *Broken* · *Absent* (nothing found after the inspection described in [02](02-architecture-inventory.md)) · *Unverified* (not enough evidence to claim) · *Not applicable*.

**Maturity** (separate from status): **P0** Absent · **P1** Prototype · **P2** Functional · **P3** Launch-ready · **P4** Operationally mature. P0 is completeness, not a judgement. Nothing was scored on documentation quality or a green suite alone; a security or data-integrity gap caps a capability regardless of other strengths ([06](06-production-readiness.md)).

**Findings** have stable IDs by category: `PARITY-`, `CX-`, `DATA-`, `SEC-`, `QUALITY-`, `DOCS-`, `OPP-` (opportunity, not a defect). **Severity:** Critical (severe security, data-integrity or core-product failure risk, confirmed) · High (a major journey is broken, materially misleading or unsafe) · Medium (meaningful issue with a workaround) · Low (polish, docs, consistency) · Opportunity (new capability, not a defect). Each finding is marked **Confirmed** (reproduced or shown in code and, where practical, a test), **Fixed in this PR**, or **Hypothesis** (not reproduced; stated so). The full list with acceptance criteria is in [11](11-remediation-backlog.md).

**Disclosure.** The leads CSV mapper, extra fields, follow-ups and Google Sheets integration were written earlier in the same working session that produced this audit, by the same assistant. They are audited here on the same terms as everything else, and several of the findings are defects in them ([11](11-remediation-backlog.md): CX-005, DATA-003, DATA-005).

## What this audit does not do

It does not approve a launch, and it does not exercise Cold against real Google accounts, real model providers or real mail clients (no credentials, no network access to those services, and no way to message people from this environment). It does not review the commercial validation work in [`docs/validation/`](../validation/README.md), which was prepared and not run (its own status line says so). It is not a penetration test.
