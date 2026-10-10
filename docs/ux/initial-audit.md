# Initial UX and architecture audit (2026-10-10)

Baseline = commit `922a3da` (before this PR). Method: code reading of `index.html`, `server.js`, `package.json`, tests, `docs/validation/`, plus a local Playwright probe against the original app (script not kept; results below are copied from its output).

## Baseline
- `node --test test/*.test.js`: **9/9 pass** (provider adapter, HF-SSH experiment with mocks, tweet length). No test touched the frontend.
- Frontend: one 1,274-line `index.html` (CSS, markup, prompts, rule engine, storage, rendering, API client in a single IIFE). Only extra asset: `public/tweet-counter.js` (checked-in esbuild bundle of `twitter-text`).
- Deployment topology: no `vercel.json`, no `api/` directory, no `build` script. Vercel therefore runs the root `server.js`, which does `module.exports = server` and serves `index.html` and `/tweet-counter.js` with literal-path `fs.readFileSync` calls. **Which handler the live Vercel project actually invokes could not be confirmed**: `https://cold-gamma.vercel.app/` is unreachable from this sandbox (DNS failure; proxy 403) and no Vercel credentials exist here. Production is unverified.

## Authoritative behaviour to preserve
- API: `GET /api/config`, `GET /api/models`, `POST /api/generate {prompt, model?}` → `{text, truncated, model}`; provider allowlist (`ai-gateway`/`anthropic`/`hf-ssh`) and the Gateway model regex/catalog check; keys never leave the server.
- Data: localStorage keys `cold.products`, `cold.emails`, `cold.settings`, `cold.compose`, `cold.gatewayModel`; product shape (`name, oneLiner, category, status, website, repo, what, who, problem, shortDesc, longDesc, proof[{id,claim,evidence,type,strength,external}], techFacts[], approved[], dontSay[]`); email record shape; statuses `draft|sent|replied`; `sentAt`.
- Generation: two calls (draft, then editor against 20 rules), three sentences, explicit question ask, no meeting request, one external proof max, do-not-say phrases, why-them ranking.
- Claude-artifact mode (`window.claude` db/sample/user). Not testable here; ported as-is where feasible.

## User journey traced
1. Load → server config fetch → banner about provider. Compose is prefilled with a fictional prospect ("Sarah Chen, CTO, Acme") and shows a fabricated **"Example"** email that contains an invented proof claim ("we've run the same workload unchanged across multiple environments").
2. Knowledge is empty; a "Load starter set" button inserts the author's five personal products. The product selector auto-selects any product named "Compute".
3. Generate validates name, company, why-them and product `what`; errors appear in the output pane only.
4. Result: score 0-100 with verdicts such as **"Ready to send"**; panel "Every claim, traced".
5. Edit → debounced save; copy; "Mark sent"; Regenerate (no confirmation, replaces edits); Improve (explicit).
6. History: filter by status, copy/open/delete.

## Findings
**Defects (verified by probe)**
| # | Finding | Evidence |
|---|---|---|
| D1 | Malformed saved data crashes boot: `cold.products='{"a":1}'`, `cold.emails='"x"'` or `[null]` throw `TypeError` at load and the app never initialises. | Probe output |
| D2 | `lsSet` swallows quota errors. Saving a product with storage full reports "saved" and silently loses it. | Probe: no error shown |
| D3 | Fictional prospect prefilled and a fabricated example email shown to every first-time user. | Probe: `#rName` = "Sarah Chen" |
| D4 | Default signature is the author's own name ("Randy") for every user. | Probe |

**Trust / honesty**
| # | Finding |
|---|---|
| T1 | "Ready to send" verdict and a 0-100 score imply validation. About 55% of the weight is the model grading itself; no relation to replies exists. |
| T2 | "Every claim, traced" is built from the model's own `claims[].source`. A claim is only flagged when the cited id is missing, never when the cited record does not support the wording. Nothing checks numbers or names in the draft against the supplied facts. |
| T3 | No check that internal-only proof leaks into a draft. `buildKnowledge` also tells the model how many internal-only items exist. |
| T4 | Regenerate replaces a hand-edited draft without confirmation. |
| T5 | The UI never states that Cold cannot see replies; "replied" is user-set but not worded as such. |

**Information architecture / UX**
- Compose asks for product selection before explaining why; required vs optional fields are not marked; "Why them" hint is good but the *reason a field is needed* is missing elsewhere.
- Knowledge: eight stacked sections, readiness shown only as a "Missing external proof" chip; "Use externally" is a bare checkbox, internal-only items are not visually separated.
- Tab switch re-renders views; unsaved knowledge edits are protected only by a "click again" toast; compose edits are not lost but the draft pane resets on reload.
- Errors are generic ("Generation stopped partway") with no retry action.
- Tweet modes are mixed into the same selector as email with no explanation.

**Accessibility / responsive**
- `<title>` sits inside `<body>`; no skip link; tabs use `role=tablist` without panels or arrow-key support; inputs remove outlines (focus relies on a box-shadow); 10-12px text for tags/metrics; sentence textareas labelled only by `aria-label`; validation errors are not tied to fields (`aria-invalid`/`aria-describedby`); status conveyed by colour in places. Contrast not measured in the baseline. No horizontal overflow at 375px (probe: 0px).
- External dependency on Google Fonts at render time.

**Security / cost**
- `POST /api/generate` is **unauthenticated, unrate-limited, accepts a 512 KB body, and parses JSON regardless of `Content-Type` or `Origin`**: any website or script can spend the project's AI Gateway credits. The README notes the lack of auth; nothing mitigates it.
- Gateway model allowlist and server-side credentials are sound (tested).

## Out of scope for this PR (from the brief)
Prospect discovery, sending, sequences, CRM, accounts, billing, new database, new providers/pipeline, and any change to the commercial-validation criteria.
