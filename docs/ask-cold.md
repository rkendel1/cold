# Ask Cold and Browse With Me (browser extension)

Two ways to ask "is there an opportunity on the page I'm looking at?", both explicit, both through one bounded evaluator.

* **Ask Cold**: you type a question (or pick one of four) and press *Ask about this page*. Cold reads the current page once.
* **Browse With Me**: you press *Start*. While it is *Active*, Cold checks the page you are on after it loads. *Pause* and *Stop* are
  always visible; the state (Not running / Active / Paused / Stopped) and the number of pages checked are shown.

Both live in the Write view of the side panel. Code: `src/domain/opportunity.js` (the evaluator, eligibility, session, result
validation, and the pure helpers for the two actions), `extension/src/askCold.js` (the panel UI and browser wiring).

## Audit: what already existed

| Question | Finding |
| --- | --- |
| How is the active page read? | `readPage()` (`extension/src/page.js`) is injected with `chrome.scripting` only when the user clicks "Read this page", and that button is enabled only for X tweets and X/LinkedIn profiles. It returns the main text (≤ 6000 chars). Reused as is. |
| Which pages can the extension touch? | Static host permissions: x.com, twitter.com, linkedin.com, loopback. Everything else is an *optional* host permission (`https://*/*`, `http://*/*`) that nothing used yet. The new code asks per site, from a click, through Chrome's own prompt. No manifest change. |
| Local inference / "JEv"-style evaluation? | **Neither exists.** There is no WebLLM or other in-browser model runtime, and no JEv interface in this repository. What exists: the extension's own provider connection (`extension/src/model.js`), which calls a model directly from the browser; with Ollama or a custom server at a loopback address that is a model on this computer. Structured calls (`sample.json`) and a grounding check (`suggestReasons`) were reused in spirit; the evaluator is new but is one function and one model call, not a framework. |
| Library and product knowledge | `store.state.products` / `store.state.emails` in the panel; saves go through `store.saveEmail` (the shared library contract). |
| Prospects? | The library has no prospect record, only drafts. "Save as prospect" therefore stores a normal *draft-status* record (name/company, product, and a note quoting the evidence), with no generated text. No new table, store or CRM. |
| Draft flow | `compose.fill()` (the same call "Read this page" uses). "Start a draft" fills the Write form; the user adds the reason and presses Generate. |

## How a check works

1. **Deterministic gates first, no model.** The page must be http(s); mail, sign-in, payment/banking, messaging, account/settings/checkout
   pages and private windows are never looked at; a page with almost no text is "nothing to judge" without a model call; no product
   knowledge means "add a product first".
2. **Permission.** Ask Cold asks Chrome for the site on your click; Browse With Me only looks at sites you have already allowed (an
   *Allow Cold on this site* button asks for the current one).
3. **Relationships.** Only people in your library whose name or company appears on the page are included, as "known contacts". The rest
   of the library, notes, statuses and internal proof never reach the model.
4. **One model call**, with the page quoted inside a data block that the page cannot close, and instructions to treat it as data.
5. **Validation in code**, not trust: every evidence quote must appear in the page; names, roles and companies must appear in the page
   (otherwise they are blanked); a follow-up must name a known contact; confidence is clamped; at most three results. What survives is
   split into **On the page (quoted)** and **Cold's inference (not stated on the page)** plus **Not known** and a suggested next step.
6. **Verdict**: *opportunity*, *uncertain* (only low confidence), or *No meaningful opportunity found*.

## What you can do with a result

Only three things, all by click: **Save as prospect** (normal library save), **Start a draft** (fills the Write form, generates nothing),
**Dismiss**. The evaluator and session cannot save, draft, send or contact anyone (a test checks the module has no such imports or calls).
Gmail approval requirements are untouched; nothing here talks to Gmail.

## Browse With Me limits

Nothing runs before Start, while paused or after Stop. It looks only at the active tab, one page at a time (4 s apart), never the same
page twice, never an excluded page, and stops by itself after 25 pages or one hour with a stated reason. A surfaced opportunity is shown
once per session (keyed by type and company), and dismissed or saved ones stay hidden. Results need medium or high confidence and quoted
evidence to be surfaced. State is in memory only: no browsing history, telemetry or new storage; closing the panel or stopping ends it.

## Local-first, and exactly how far that goes

* Page text goes **only** to the extension's own model, and only if it is reachable at a loopback address (`127.0.0.1`, `localhost`,
  `[::1]`), for example Ollama. The panel says which model and host it is using.
* If there is no such model, the page is **not read**. Cold says why and offers the choice: set one up in Settings, or use the available
  model (a hosted provider, or the paired desktop app) *for this panel session*, which you can turn off again. It never falls back by itself.
* The paired desktop app's provider address is not visible to the extension, so Cold cannot call it local; it counts as "unverified".

### Unresolved limitation: in-browser local inference

Because there is no WebLLM-style runtime in the extension, a user with no model server on their computer cannot run these checks
locally; they must install one (for example Ollama) or consent to a hosted model. This change does **not** add an in-browser model, so
it does not claim "works with no setup and nothing leaves the browser". The tests verify the gate and the network behaviour against a
fake model server on loopback and a blocked hosted address; they have **not** been run against a real Ollama.

## Other limitations

* The ranking is only as good as the configured model; validation removes unsupported claims but cannot make a weak model insightful.
* Evidence quotes are checked as text on the page the extension could read (the first 6000 characters of the main content).
* Single-page apps that change content without a page load are only seen when the tab finishes loading or is re-activated.
* Exclusions are a fixed list (not user-editable) so that no new persistence is needed.
