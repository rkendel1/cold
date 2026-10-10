# Implementation report: UX redesign and modularisation (2026-10-10)

## Outcome
Compose-first information architecture, a Knowledge page with a product/offering **dropdown**, a clearer History, an honest grounding/outcome vocabulary, and a modular frontend that deploys the same way as before. All automated tests pass locally. **Production was not checked** and the redesign has **not** been tried with founders.

## Tests run (local, 2026-10-10)
| Check | Result |
|---|---|
| Baseline before changes: `node --test test/*.test.js` | 9/9 pass |
| After changes: `npm test` (all files) | **64/64 pass**, 0 skipped, repeated three consecutive times with no flakes |
| ... of which pre-existing tests (provider, HF-SSH mocks, tweet length) | 9, unchanged and passing |
| `test/domain.test.js`: rules, knowledge/readiness, prompt contract, grounding, storage, store rollback, generation pipelines, API client, router | 16 |
| `test/server-security.test.js`: API contract, access code, origin check, rate limit, body cap, static assets and headers | 6 |
| `test/bundle.test.js`: bundle is current, no credentials in bundle, shell, deployment-topology assumptions, serverless entry, import resolution, no monolith | 7 |
| `test/e2e.test.js`: Chromium against the real server and bundle (navigation, first use, validation, generation contract, loading and double-submit, failure and retry, edit/copy, regenerate guard, improve and undo, internal-only proof, unsupported claims, malformed storage, legacy data, history, Knowledge dropdown, storage-full, tweet mode, access code, responsive at 375/768/1280, axe light and dark, keyboard and reduced motion) | 26 |
| `npm run check:app` (committed bundle current) | pass |

Limits of these results: the browser tests use a **mock model** that returns canned JSON, so they prove behaviour and plumbing, not draft quality. Passing UI tests say nothing about customer demand. The accessibility result is automated axe-core (WCAG 2.0/2.1 A and AA rules) only; it is not a manual screen-reader audit.

## Not verified / blocked
- **Production deployment** (`https://cold-gamma.vercel.app/`): unreachable from this sandbox (DNS failure, proxy 403); no Vercel CLI or credentials. It is unknown which handler the live project invokes; the repo has no `vercel.json` or `api/`, so the inference is that root `server.js` is used. Tests check that assumption locally (`test/bundle.test.js`) but cannot confirm it. No deployment, preview or environment change was made.
- Vercel-specific behaviour (function bundling of `public/*`, runtime handling of `module.exports = server`, CDN caching) is untested. Static assets are read with literal `fs` paths and committed, mirroring the existing `tweet-counter.js` arrangement, to keep that risk low.
- The Claude-artifact (`window.claude`) mode is ported, untested.
- Real model output quality, with any provider.
- Manual assistive-technology testing; Safari and Firefox.

## Security and cost exposure (documented, partially mitigated)
**Before:** `POST /api/generate` was open to anyone who could reach it: no authentication, no rate limit, 512 KB bodies, and it accepted cross-site form posts.
**Now (server-enforced):**
1. Optional `COLD_ACCESS_TOKEN`: when set, requests without the matching `x-cold-access` header get `401` before any provider call (constant-time comparison; tested). The UI shows an access-code field when the server reports `accessRequired`. This is the only control that stops a determined caller.
2. Requests carrying a mismatching or `null` `Origin` get `403` (blocks other websites driving a visitor's browser; does not stop curl).
3. Per-address rate limit (default 30/min, `COLD_RATE_LIMIT_PER_MIN`), in memory per server instance, so serverless instances do not share it: best effort only.
4. Request body cap lowered to 128 KB (an oversized body now receives a `413` reply; previously the socket was dropped).
5. CSP (`script-src 'self'; style-src 'self'; connect-src 'self'`), `nosniff`, `no-referrer`, `X-Frame-Options: DENY` on responses; no inline scripts or styles; no external font or script requests.
6. Credentials remain server-side; the bundle is tested to contain none.

**Remaining risk:** the token is **opt-in**. A deployment without `COLD_ACCESS_TOKEN` is exactly as open as before (the UI and server log now say so). I did not make it mandatory or change any environment variable, because that would change production behaviour without authorisation. **Do not share the deployed URL until `COLD_ACCESS_TOKEN` is set.** The access code is a shared secret held in browser session storage; it is not user authentication. For the commercial pilots, `docs/validation/` still recommends running Cold locally.

## Deviations and decisions
- Removed the author-specific "Load starter set", the fictional prefill and "Example" email, and the "Randy" default sign-off (fabricated first-use content). Existing saved sign-offs and products are untouched.
- Removed the line telling the model how many internal-only proof items exist (leak surface). The prompt contract is otherwise identical.
- Knowledge product selection is a dropdown (per your request during this work), not a side list.
- Self-hosted fonts were not added: the system font stack replaces Google Fonts, so there is no external request.
- Additive data field `repliedAt` on history records; nothing migrated.
- New dev dependencies `playwright-core` and `axe-core`; no runtime dependencies added. No framework.

## Remaining issues
- Tweet drafts have no grounding or checklist (unchanged scope).
- Grounding is word-level; it skips first-of-sentence names, lower-case names and spelled-out numbers (documented in the UI and `experience-changes.md`).
- Rate limit and access control are per-instance/opt-in as described above.
- Committed bundle must be rebuilt (`npm run build:app`) when `src/` changes; `check:app` and a test enforce this.
- No analytics or instrumentation exist, so nothing measures whether the new flow reduces friction. That needs real users.

## Validation materials
`docs/validation/` is unchanged. Two factual corrections were made elsewhere: a note in `docs/evaluation/` that the old mock-check script targets the pre-redesign UI, and the README claim that "every claim is traced" was replaced with what the checks actually do.
