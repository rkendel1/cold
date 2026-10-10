# Cold commercial validation package

**Status (2026-10-10): prepared, NOT executed.** No founder has been contacted, interviewed, shown an offer or charged. The sandbox that produced this package cannot message people, and fabricating evidence is prohibited. See [`2026-10-10-validation-report.md`](2026-10-10-validation-report.md): result is **inconclusive**.

Builds on [`../evaluation/2026-10-10-commercial-evaluation.md`](../evaluation/2026-10-10-commercial-evaluation.md). The technical audit is not repeated.

| File | Purpose |
|---|---|
| [`offers.md`](offers.md) | Offers A/B/C: scope, price, terms, costs, price rationale. **Frozen before recruitment.** |
| [`decision-criteria.md`](decision-criteria.md) | Pre-registered pass / uncertain / fail rules and counting rules. |
| [`recruitment-and-interviews.md`](recruitment-and-interviews.md) | Targeting, message templates, interview script, A/B demo protocol, offer-presentation script, consent. |
| [`product-gaps.md`](product-gaps.md) | Gap hypotheses with the evidence each one still needs. Nothing is approved for build. |
| [`tracker/`](tracker/) | Empty evidence tracker (CSV + schema). Fill it as sessions happen. |
| [`2026-10-10-validation-report.md`](2026-10-10-validation-report.md) | Final report. Update it in place after the experiment; do not rewrite earlier sections. |

## How to run (for the human operator)
1. Approve the prices and the payment method in `offers.md` (marked "operator to confirm"). Commit that approval **before** sending any message.
2. Send recruitment messages by hand, following each community's rules. Log every one in `tracker/funnel.csv`.
3. Hold interviews, run demos, present offers per `recruitment-and-interviews.md`. Fill `tracker/participants.csv` right after each session.
4. Keep names, emails and handles only in `tracker/contacts.private.csv` (git-ignored). Never commit transcripts.
5. After the time box, fill in the report's result sections using the pre-registered criteria.

## Safety constraint for any pilot
Do not host Cold on a public URL while `/api/generate` is unauthenticated. Run it locally (`npm start`, bound to 127.0.0.1) on the operator's machine, with the operator's own key, screen-sharing with the founder, or have the operator run it and send drafts. Founder product knowledge stays in the operator's browser localStorage and is deleted after the engagement unless the founder consents in writing to keep it.
