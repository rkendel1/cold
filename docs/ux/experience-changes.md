# Experience changes (2026-10-10)

What changed in the UI and architecture, why, and how to see it. The baseline and the defects behind these changes are in [`initial-audit.md`](initial-audit.md). Nothing here claims the redesign has been tried with founders: it has not. The commercial-validation materials in `docs/validation/` are unchanged.

## Information architecture
Three destinations in one primary navigation, Compose first: **Write** (`#/compose`, default), **Knowledge** (`#/knowledge`), **History** (`#/history`). Hash routes mean the server never needs to know about routes (works on a static host and in Vercel's single-handler setup), and the back button works. On phones the navigation becomes a fixed bottom bar. Each view has one `h1`, which receives focus on navigation; a skip link jumps to the content.

## Before / after
| Area | Before | After |
|---|---|---|
| First load | Fictional prospect ("Sarah Chen, CTO, Acme") prefilled; fabricated "Example" email with an invented proof claim; author's name as default sign-off; "Load starter set" inserted the author's own five products | Empty form with example placeholders only; an empty-state panel that describes the three-sentence structure; **no fabricated data**; no default sign-off; no starter set |
| Getting a first draft | Had to visit Knowledge first, or the generator refused | Compose asks for the product's **name and one plain sentence** inline when no product exists, saves it to Knowledge, and generates. Proof, audience and rules stay optional and are suggested afterwards |
| Required vs optional | Unmarked; errors appeared only in the output pane | Every field is labelled Required or Optional; "Why should this person care?" explains why it is needed; a single error summary (role=alert, focused) lists what's missing with links, and each field has `aria-invalid` plus an inline message |
| Product choice | Select with an auto-picked "Compute" | Dropdown of saved products showing readiness ("Needs what it does", "N ways to improve drafts", "complete"), with "Add another product in Knowledge…" |
| Knowledge navigation | Side list | **Dropdown to choose the product or offering** (also guards unsaved edits with a confirm dialog), one editor per product |
| Knowledge structure | Eight stacked sections; a "Use externally" checkbox | A **readiness checklist** at the top (Needed / Recommended / Done, each with "Go to field"); About, Proof, Facts and wording; optional details collapsed. Proof is split into **Approved for external use** and **Internal only (never sent to the model)** groups, each row with an explicit "Who can use this" control |
| Internal proof | Not sent, but the prompt told the model how many internal items existed | Not mentioned in the prompt at all |
| Generation | Spinner list; failures showed a generic message with no retry; Regenerate silently replaced edits | Progress with Stop; button disabled and relabelled so a second submit is impossible; failures keep every input, say what happened in plain language and offer **Try again**; Regenerate and Improve ask first if you edited the draft, and Improve can be **undone** |
| The draft | Verdict "Ready to send" and a 0–100 score | Editable subject and three visibly labelled sentences, live length metrics, **Copy email** (primary), Copy subject, Mark as sent, a "Next:" instruction. Copy confirmation appears only if the browser accepted the copy |
| Grounding | "Every claim, traced" = the model's own claim list | **Deterministic "Check before you send"** (see below); the model's claim list is shown separately with a word-overlap status; the style score is renamed "Style checklist" with per-row source tags (Cold / Model) and an explicit "not a prediction of replies" |
| History | Status filter; labels `Draft/Sent/Replied` | Labels state who decided: **Draft**, **Marked sent**, **Reply recorded** (the user's own record), `repliedAt` stamped alongside `sentAt`, search box, copy/open/delete with confirm. Page text says Cold doesn't send mail or see replies |
| Errors in storage | Malformed saved data crashed the app at load; a full browser reported "saved" | Malformed data is skipped with a visible notice and **never deleted**; failed writes are rolled back and reported ("Not saved: browser storage is full") |
| Accessibility | See audit | Real `<label>`s everywhere, `aria-describedby` for hints and errors, 44px targets, 3px focus ring, status chips use words plus a glyph (never colour alone), `role=status/alert` announcements, native `<dialog>` confirms, reduced-motion respected, system fonts (no external font request); axe-core passes in light and dark |
| Security | Open endpoint (see below) | Server-side controls and a CSP; remaining risk documented |

## Grounding: what is and is not checked
`src/domain/grounding.js`, shown in the draft pane under "Check before you send". It compares the draft's words with the text the user supplied (product fields, approved proof, recipient fields, "convey"):
- **Numbers** in the draft that do not appear in that text are flagged "Not found".
- **Names** (capitalised mid-sentence words and ALL-CAPS tokens) not in that text are flagged.
- **Internal-only proof** reused in the draft (shared 5-word phrase, or a number that appears only in internal text) is flagged.
- **Claims the model cited** are shown as *Matches your text* only when the cited record exists and the wording overlaps (≥ 60% of content words, all numbers present); otherwise *Needs review* or *No such record*.

It does **not** verify meaning or truth, skips the first word of each sentence, and ignores lower-case names and spelled-out numbers. A clean result says exactly that. Nothing is labelled "verified".

## Persistence
Same localStorage keys and data shapes (`cold.products`, `cold.emails`, `cold.settings`, `cold.compose`, `cold.gatewayModel`); additive field `repliedAt` on history records. Navigation never discards edits: views stay mounted, so unsaved Knowledge edits and the in-progress draft survive tab changes, and leaving a product with unsaved edits asks first. Pages state that data lives in this browser only and is not backed up or synced. The Claude-artifact (`window.claude`) backend is ported but **untested** here, as before.

## Architecture
`index.html` is a 17-line shell. Source is vanilla ES modules in `src/`, bundled by esbuild (already a dev dependency) into the committed `public/app.js` and `public/app.css`, the same pattern as `public/tweet-counter.js`.

```
src/
  main.js, app.js, navigation.js      boot, shell, hash router
  domain/   constants, rules, knowledge, prompts, grounding, email, ids   (pure, unit-tested)
  state/    store.js (state + subscriptions + persistence), storage.js (validated localStorage)
  services/ api.js (HTTP client), generation.js (pipelines + error copy), platform.js, clipboard.js
  components/ dom.js (h()), ui.js, dialog.js
  views/    compose.js, draft.js, knowledge.js, history.js
  styles/   tokens.css, layout.css, components.css
```
Generation and provider logic stays behind `services/`: views call pipelines with an injected `sample` function and never see a provider. The prompts and the 20 rules are unchanged apart from removing the internal-proof count line. No framework or runtime dependency was added: the audit found no requirement that vanilla modules cannot meet. Dev dependencies added: `playwright-core` (browser tests) and `axe-core` (accessibility scan).

## Server and API
Contract unchanged (`GET /api/config`, `GET /api/models`, `POST /api/generate {prompt, model?}`), plus the additive `accessRequired` field and a `401/403/429` with `error.code` when a guard rejects a request. New static routes `/app.js`, `/app.css`. See the security section of `docs/ux/implementation-report.md`.
