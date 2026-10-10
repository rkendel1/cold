# Product-gap assessment (conditional; as of 2026-10-10)

**No customer evidence exists yet, so no gap is validated and none is approved for build.** The "evidence" column cites only the code audit or says what is still needed. Re-score each row after interviews. The technical baseline is in the earlier evaluation, not repeated here.

| Gap | Affected customer | Observed evidence | Consequence if left | Smallest intervention | Test before engineering | Status |
|---|---|---|---|---|---|---|
| Prospect identification and research | Founder who doesn't know whom to contact (Offer B/C) | None from customers. Code: Cold takes every prospect as input. | Cold stays a drafting aid; may sell nothing | None. Deliver manually via Offer B | Offer B shortlists accepted as relevant (target ≥ 8 of 15) and ≥ 2 purchases | Unvalidated |
| Positioning and relevance | Founder unsure why anyone should care | None | Weak "why them" input produces weak drafts | Interview-time prompt for the reason, done by hand | Founders can't state a reason for ≥ 3 of 10 prospects in Offer A | Unvalidated |
| Draft quality and grounding | All | Code: "no invented facts" is a model self-grade | One fabricated claim breaks trust | Deterministic check that numbers and proper nouns appear in supplied text (≈ a small function) | Count unsupported claims in comparisons (`comparisons.csv`); build only if > 0 across ≥ 30 drafts | Unvalidated, cheap |
| Writing controls (ask style, length, meeting asks) | Founders wanting demos or calls | Code: fixed 3 sentences, no meeting asks | Rejected as inflexible | Toggle the meeting rule | Founders edit the ask in ≥ 3 of 10 comparisons | Unvalidated |
| Reusable product knowledge | Repeat users | None | Re-entry cost | Export/import text | Founders ask to keep or reuse the knowledge base | Unvalidated |
| Follow-up and outcome tracking | Sprint customers (C) | Code: status only, no `repliedAt`/outcome | Can't show value or retention | Spreadsheet during the pilot first | Sprint founders log replies reliably in a sheet | Unvalidated |
| Persistence, onboarding, trust | All | Code: localStorage only, no auth | Data loss; endpoint abuse | Operator-run local delivery (no change) | Founders object to data handling | Operational note only |
| Value vs a saved prompt or sales tools | Offer A buyers | None | No differentiation | None | Offer A comparisons: ≥ 4 comparisons, majority choose Cold as "would actually send" | Unvalidated |

Not to build without evidence that a purchased offer requires it: sending, sequencing, a prospect database, billing, multi-user support.
