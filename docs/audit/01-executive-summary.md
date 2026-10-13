# 01. Executive summary

## What Cold actually is today

Cold is a **privacy-first outreach drafting and tracking tool** with one codebase and three surfaces: a web app, an Electron desktop app, and a Chrome side-panel extension. You save facts about what you offer, add the people you want to write to (by hand or by importing a CSV), and Cold drafts a short, grounded email or tweet using a model *you* choose (nine providers, or an on-device model in the extension). You copy the draft or hand it to your own mail client; **Cold never sends anything and cannot see whether you did**, so "sent" and "replied" are records you make. Copying or handing off records the handoff and sets a configurable **follow-up** reminder. Data lives on the device (browser storage, a SQLite file on the desktop, extension storage), shared between surfaces only by optional pairing with the desktop app. Optionally, leads and outreach can live in the user's own **Google Sheet**; that part is a preview built against stand-ins, off unless an operator configures a Google client.

It is **pre-1.0**: there are no release artifacts, no CI, and no onboarding, and nothing has been tested with a real model or a real Google account.

## Verified strengths

* **Honest by construction.** Every message about sending, replying and handoff says what Cold can and cannot know, and tests assert it (`T:e2e`, `T:handoff`). This is rare and is the product's best trust asset.
* **Careful data handling in the core.** Outreach records are versioned and merged or refused on conflict (19 integrity tests); unreadable browser entries are kept, not deleted; storage-full fails loudly; CSV import is review-first, idempotent and reports every rejected row; SQLite probes behaved (R6).
* **A coherent shared UI.** Five screens, the same words and rules on all three surfaces, automated accessibility checks clean on every view and on the 16 states added later (R7).
* **Strong privacy engineering for what existed before Sheets:** no telemetry, no request logging, keys never returned to the page, pairing-code-guarded extension access, tests that watch network boundaries (`T:privacy`).
* **A large, meaningful test suite:** 47 files, about 320 tests, most of which exercise real stores, a real server and a real browser.

## Material limitations

* **Draft quality is unproven.** Every generation test uses a canned model; the commercial validation experiment was prepared and not run (QUALITY-008).
* **No way to get Cold as a user.** Desktop installers are unsigned and unbuilt; the extension is "load unpacked"; there is no CI or release workflow (QUALITY-002, -010, -011).
* **No onboarding** (CX-001); on a hosted site with no model, a visitor has nothing to do (CX-002).
* **Google Sheets was never run against Google**, bypasses desktop pairing, has no offline copy, and treats leads as last-writer-wins (DATA-001, -002, -004, -005, -007; PARITY-002).
* **Three-surface parity is verified for the shared screens, but follow-ups and Sheets are verified on web only** (PARITY-001, -003).
* **No full export, backup or erase** beyond leads CSV and copying the database file (DATA-009).

## Highest-risk findings

No Critical finding stands open. The audit found and fixed, in this PR:

1. **The test suite was red on the branch** (12 failures) because a commit added blanket error handling that treated clearing an error as a failure (QUALITY-001, bisected: green 48/48 at the parent, red at the commit). Nothing prevented it from merging because there is no CI (QUALITY-002, still open).
2. **Privacy documentation became false** once Sheets existed: it said no data goes to a cloud store (SEC-006).
3. **A data-loss bug in the Sheets feature:** columns users added to their own Outreach sheet were blanked on every save (DATA-011).
4. **"Stop using Google Sheets" didn't revoke the Google authorisation** (DATA-003), and an unreadable sheet opened as an empty list with no explanation (DATA-005, now a banner).
5. **The CSV mapper skipped every column when the name column wasn't recognised** (CX-005), plus two copy errors.

The open High items are QUALITY-002, QUALITY-008, QUALITY-010, CX-001 and DATA-001; see [11](11-remediation-backlog.md).

## Overall adoption-readiness assessment

| Scope | Assessment |
|---|---|
| Core loop (knowledge → draft → copy/handoff → record → follow-up; CSV leads) | **Functional (P2–P3).** Works and is honest; verified with a mock model on web, by shared code on desktop and extension |
| Getting Cold into a stranger's hands | **Prototype (P0–P1).** Source builds only, no first-run guidance |
| Google Sheets | **Prototype (P1).** Opt-in preview; do not enable by default |
| Operations (CI, release, diagnostics, monitoring) | **Absent to prototype (P0–P1)** |

**Recommendation ([10](10-launch-readiness-plan.md)): no-go for general launch; conditional go for a supervised pilot of the core with Sheets off, after six small conditions** (CI, flake fix, security contact, two copy fixes, a corrupt-row notice and backup text, a pilot protocol). The largest remaining uncertainty is whether the drafts are good with real models.

## Immediate priorities

1. **CI that cannot be silently green** (QUALITY-002, -003, -004): it would have caught the regression and protects every other finding.
2. **Real-model evidence** (QUALITY-008): run the validation experiment, because everything else is worth little if drafts don't earn replies.
3. **First-run path and distribution** (CX-001, QUALITY-010, -011): so someone who didn't build Cold can use it.
4. **Decide Sheets' future:** verify against real Google (DATA-001/-002) and settle the pairing rule (PARITY-002), or keep it off and out of the marketing.
5. **Close the support gap** (DOCS-005).

## How to read the rest

[02](02-architecture-inventory.md) what exists and what wasn't inspected · [03](03-parity-matrix.md) per capability and surface · [04](04-journeys-and-cx.md) the 17 journeys · [05](05-capability-catalog.md)–[06](06-production-readiness.md) maturity and gates · [07](07-security-privacy-data-authority.md) data flows and sync semantics · [08](08-test-and-verification-report.md) what ran and what didn't · [09](09-documentation-remediation.md) documents · [10](10-launch-readiness-plan.md) the plan · [11](11-remediation-backlog.md) every finding.
