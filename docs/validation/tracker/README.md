# Evidence tracker

- `participants.csv`: one row per participant, anonymous ID (`P01`...). **Currently empty: no participant exists.**
- `funnel.csv`: recruitment funnel counts. Currently all `0` / `not attempted`.
- `comparisons.csv`: one row per Cold-vs-baseline draft comparison (Offer A).
- `contacts.private.csv`: **never committed** (git-ignored). Map `participant_id` to contact method here only.

Field rules
- `evidence_basis` values: `observed`, `self-reported`, `inferred`. One value per row; if a row mixes, split into columns or add notes.
- `decision` values: `paid`, `committed`, `next_step`, `declined`, `no_decision`, `no_response`, `interest_only`, `not_offered`.
- Money fields are the exact price shown, in USD. `payment_received_date` stays blank until money is received.
- Do not paste confidential customer data, transcripts or contact details.
