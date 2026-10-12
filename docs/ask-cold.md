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
| Local inference / "JEv"-style evaluation? | **Neither existed when Ask Cold shipped** (the on-device model was added after; see below). There is no WebLLM or other in-browser model runtime, and no JEv interface in this repository. What exists: the extension's own provider connection (`extension/src/model.js`), which calls a model directly from the browser; with Ollama or a custom server at a loopback address that is a model on this computer. Structured calls (`sample.json`) and a grounding check (`suggestReasons`) were reused in spirit; the evaluator is new but is one function and one model call, not a framework. |
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

## Local-first: three ways to run the check

| | On-device model (new) | Model server on this computer | Hosted or paired model |
| --- | --- | --- | --- |
| What it is | WebLLM running a small open model in this browser, on your GPU (WebGPU), in a worker | The extension's own model connection pointed at a loopback address (Ollama, LM Studio…) | A hosted provider, or the Cold desktop app's model |
| Software to install | none | the model server | none |
| Page text goes to | the model in this browser only | that address on this computer | the provider / the desktop app (and on to its provider) |
| Cold calls it | **verified local** (it cannot send the text anywhere: the adapter has no network code) | on this computer, but **not verified**: Cold can't see what that server does with the text | not local |
| Used when | you set it up (or it is already stored in this browser) and no server is chosen | configured in Settings; if both exist, a selector lets you choose | only after you press "Use … for these checks"; lasts for the panel session |

There is **no automatic fallback**. If the on-device model can't start, Cold says why, reads nothing, and lists the choices; it never
retries on another model. Choosing the on-device model explicitly also rules out the hosted option until you change that choice.

### How the on-device model works

* **Lazy.** Opening the panel loads nothing. The runtime script (`dist/llm-client.js`) is fetched from inside the extension the first time
  you ask for the model; the model itself loads on first use and then stays loaded for the life of the panel, so later checks and
  Browse With Me reuse it. Closing the panel frees it (the downloaded files stay).
* **Where it runs.** A dedicated worker (`dist/llm-worker.js`) started by the panel page. The panel only sends it the prompt for a check.
* **States** (shown under *On-device model*): not loaded → checking this computer → loading (with progress and a Cancel button) → ready,
  or an explicit error: no WebGPU / no graphics adapter, not enough memory (offers the smaller model), download failed, a file failed
  its checksum, files incomplete, could not start.
* **First use downloads the model.** You are told the estimated size, the source and the licence and asked before anything is downloaded.
  If the files are already in this browser, it just loads them.
* **Models.** Qwen2.5 1.5B Instruct (default; about 1 GB estimated; needs about 1.7–1.9 GB of graphics memory) and Qwen2.5 0.5B Instruct
  (about 0.4 GB estimated; about 1 GB of graphics memory; weaker). Both are Apache-2.0. Sizes are estimates from parameter count and
  4-bit quantisation, not measured downloads.
* **Where the files come from.** Weights (data only): `https://huggingface.co/mlc-ai/<model>/resolve/<revision>/`. The compiled WebGPU
  library for each model (code) is **bundled into the extension** at build time from `mlc-ai/binary-mlc-llm-libs`, accepted only if its
  SHA-256 matches the value pinned in `extension/src/localModels.js`, and the runtime checks the same hash again before using it. The
  extension never downloads code at run time.
* **Cache.** The browser's Cache API for this extension holds the files, so the download happens once. Reload, restart and reopening the
  panel reuse it.
* **Remove or reset.** *Remove downloaded model* in the panel deletes the files and frees memory; setting it up again downloads again.
  Uninstalling the extension removes everything. *Cancel* stops a download; the next attempt resumes from what is cached.
* **Memory.** The panel checks WebGPU and picks the f16 or f32 build of the model automatically. If loading fails for lack of graphics
  memory or storage, it says so and offers the 0.5B model; it never switches on its own.

### Requirements

Chrome, Edge or Brave 114 or newer (the extension's minimum) with WebGPU and a graphics adapter; a few GB of free disk space for the
cache; about 2 GB of free graphics memory for the default model. No GPU, a remote desktop session or a blocked driver gives "no
graphics adapter is available"; the other two options remain.

### What stays on this device, and the requests to expect

| Data | During an on-device check |
| --- | --- |
| Page text, your question, product facts, matched contacts, results | stay in this browser. Not sent anywhere. |
| Model files | downloaded **once**, from `huggingface.co` only, as plain GET requests for `mlc-chat-config.json`, `tokenizer.json`, `tensor-cache.json` and weight shards. No query string, body, cookie or page/library data (a test checks this against the real runtime). |
| The compiled library | read from inside the extension; no request. |
| Telemetry, history, evaluations | none. Nothing is stored except the model files and your normal library saves. |

### Security notes

* The extension-page CSP gains one token, `'wasm-unsafe-eval'` (Chrome's own MV3 default), because compiling the bundled WebAssembly
  needs it. It does not allow `eval`, inline scripts or remote scripts; the runtime contains no `eval`/`new Function`.
* No new host permissions were added. Reading pages still uses the existing per-site, user-granted permission.
* Page text is untrusted: it is inside a data block, and only the validated result is used (see *How a check works*).

## Verification status (what has and has not been proven)

Run on: Chromium 141 headless on Linux, 4 CPUs, 16 GB RAM, **no GPU**, WebLLM 0.2.86.

| Claim | How it was checked | Result |
| --- | --- | --- |
| The adapter's lazy start, reuse, cancel, failure states, unsupported hardware, no fallback | unit tests with a fake runtime (`test/local-model.test.js`) | pass (deterministic; says nothing about a real model) |
| Ask Cold and Browse With Me both use the shared evaluator on the on-device model; reuse; consent; cancel; cache; remove; no hosted fallback; nothing leaves the browser | extension tests with a **fake runtime** | pass (deterministic; says nothing about a real model) |
| No WebGPU adapter: clear message, runtime not loaded, nothing sent, hosted model not contacted | **real runtime** in the real extension | pass |
| The real runtime starts inside the extension under its CSP, picks the f32 build on a software adapter, creates a WebGPU device, loads the bundled library and asks the model host only for model files | **real runtime**, software WebGPU (SwiftShader), **stand-in** model files | pass up to the point where it asks for weights (the stand-in has none) |
| A library that doesn't match its pinned hash is refused | **real runtime**, one bit flipped in a throwaway copy | pass (`integrity_failed`) |
| **A real model downloads, loads and completes an opportunity check** | not possible here | **NOT VERIFIED** |

**Blocker for the last row.** This environment's network policy denies `huggingface.co` (HTTP 403 from the proxy), so no real weights
could be downloaded, and the sandbox has no GPU (only a software adapter, which has no `shader-f16`). To close it, run the extension
on a machine with a GPU and network access to huggingface.co, press *Set up the on-device model*, then *Ask about this page* on a
page that mentions a company hiring for something you sell, and note the browser, GPU, model, load time and result in this table.
In a cloud environment the host to allow is `huggingface.co` (Network access → Allowed domains).

## Unresolved limitations

* **A real model has not been run.** Everything above the table's last row is verified; real-model quality, speed, memory use and the
  exact download size are not. Expect a 1.5B (and especially 0.5B) model to be weaker than a hosted one: it will miss subtle
  opportunities and return more "uncertain" or "none". Validation removes unsupported claims but cannot add insight.
* **Weights are not pinned to a commit.** `MODEL_SOURCE.revision` is `"main"` and the config/tokenizer checksums are empty, because the
  commit could not be looked up here. The compiled libraries *are* pinned and verified. Run `npm run pin:local-model` on a networked
  machine and commit its output to close this; until then the weights follow the upstream repository. (The runtime has no checksum for
  weight shards.)
* **Download size and graphics-memory figures are estimates** (memory figures come from WebLLM's own model list).
* **Size.** The extension package grows by about 35 MB (the runtime, its worker and four compiled libraries).
* **One generation at a time** and no streaming to the UI; a check on integrated graphics can take many seconds.
* **Browser support.** Firefox and Safari are not supported by this extension; Chrome-family browsers without WebGPU get the "unsupported" state.

## Other limitations

* The ranking is only as good as the configured model; validation removes unsupported claims but cannot make a weak model insightful.
* Evidence quotes are checked as text on the page the extension could read (the first 6000 characters of the main content).
* Single-page apps that change content without a page load are only seen when the tab finishes loading or is re-activated.
* Exclusions are a fixed list (not user-editable) so that no new persistence is needed.
