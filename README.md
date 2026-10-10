# Cold

A focused cold-email generator. Give it five facts; it gives you an email worth sending.

**Knowledge base → recipient relevance → one goal → three sentences → explicit ask.**

## What's in the MVP

- **Knowledge**: products with plain-English description, audience, problem, proof points (claim, evidence, type, strength, use-externally flag), technical facts, approved language, and do-not-say rules.
- **Compose**: recipient name, role, company, why them, goal (advice, investment, introduction, customer conversation, partnership, other), and anything specific to convey.
- **Generate**: two stages. A draft (relevance classification, knowledge retrieval, three sentences), then an editor pass that checks the draft against 20 rules and rewrites it. Cold then runs a deterministic **"Check before you send"** that flags numbers and names in the draft that are not in the text you supplied, and any reuse of internal-only proof. It compares words only: it cannot verify that a claim is true. The model's own claim-to-source list is shown separately with a word-overlap status.
- **Quality**: a 0–100 *style checklist* from the 20 rules (about half are the model's own report, labelled as such; it is not a prediction of replies). Length, read time, sentence count, stock openers, marketing language, do-not-say phrases, explicit ask, meeting requests and subject line are checked locally and update live as you edit. "Improve" reruns the editor on a specific weakness.
- **History**: every generated email is saved as a draft. Copy it, mark it sent, record a reply, reopen and edit. "Sent" and "reply" are your own records: Cold sends nothing and cannot see replies.

Cold never sends anything. Generate with AI, send yourself.

## Running it

Cold runs in two modes. The page picks the right one on its own.

### API-key mode (run it yourself)

Needs Node 18 or newer. Running the app needs no installed dependencies.

```sh
cp .env.example .env    # then put your key in .env
npm start               # http://127.0.0.1:3000
```

`.env` settings:

| Variable | Required | Default | |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | for Anthropic | | Your Anthropic API key (only with `LLM_PROVIDER=anthropic`) |
| `LLM_PROVIDER` | no | `ai-gateway` | `ai-gateway` or `anthropic` |
| `AI_GATEWAY_API_KEY` | locally | | AI Gateway key; on Vercel, falls back to `VERCEL_OIDC_TOKEN` |
| `AI_GATEWAY_MODEL` | no | `anthropic/claude-sonnet-4.5` | Gateway model ID (`provider/model`) |
| `LLM_MAX_TOKENS` | no | `2000` | Per call, overrides `ANTHROPIC_MAX_TOKENS` |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-5-5` | Any Messages API model, e.g. `claude-opus-5-5` or `claude-haiku-4-5-20251001` |
| `ANTHROPIC_MAX_TOKENS` | no | `2000` | Per call |
| `COLD_ACCESS_TOKEN` | no | | If set, `/api/generate` requires this value in the `x-cold-access` header; the page shows an access-code field. **Set it before sharing the URL.** |
| `COLD_RATE_LIMIT_PER_MIN` | no | `30` | Best-effort per-address limit on `/api/generate` (per server instance) |
| `PORT` | no | `3000` | |
| `HOST` | no | `127.0.0.1` | Set `0.0.0.0` to expose it on your network |

The key stays on the server: the page calls `/api/generate`, and `server.js` calls AI Gateway’s Chat Completions API by default (or the Anthropic Messages API). Each email takes two calls, a draft and an editor pass. In this mode, products and drafts are saved in the browser's localStorage. `.env` is git-ignored.

### Choosing a model

In Compose, the **AI Gateway provider / model** dropdown lists language models from the live Gateway catalog, grouped by model creator (Anthropic, OpenAI, Google, etc.). Gateway still handles inference-provider routing automatically. Your choice is remembered in this browser and sent with each draft, editor and improve request. The configured server default remains available if the catalog cannot load. Non-Gateway modes hide this control. Model pricing varies.

### Vercel

AI Gateway uses server-side `VERCEL_OIDC_TOKEN` on Vercel, or `AI_GATEWAY_API_KEY` if configured in project environment variables. Never put either credential in browser code. Configure `AI_GATEWAY_MODEL` to change models. Gateway usage requires available credits; generation is not an unlimited free service.

See [AI Gateway authentication and API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions). Without `COLD_ACCESS_TOKEN` this app has no authentication: visitors can call the generation endpoint and consume credits. With it set, the server rejects requests that lack the code (the only control that stops a determined caller); same-origin checking, a per-address rate limit and a 128 KB body cap are best-effort extras. Vercel currently runs the root `server.js` (no `vercel.json`, no `api/`, no build step), so `public/app.js` and `public/app.css` are **committed** and must be rebuilt with `npm run build:app` whenever `src/` changes. This is not verified against the live Vercel project.

### Claude artifact mode

Published as a Claude artifact on claude.ai, the same `index.html` uses the artifact runtime (`window.claude`) instead:

- `sample` to generate with Claude, on the viewer's own account
- `db` to keep the knowledge base and drafts private to the owner
- `user` to check ownership

Opened as a plain file with neither, knowledge editing and history still work, but generation stays off.

## Tweets and replies

Select **Tweet reply** or **Original tweet** in Writing mode. Paste the source tweet text (for replies) or your topic (for original tweets). An optional X/Twitter status link is saved as a reference. Links are not fetched automatically: a reply requires pasted content. Knowledge is optional in social modes.

Drafts use X's weighted 280-character limit via `twitter-text`, including URL and Unicode weighting. Overlong model results get one shortening attempt; editable drafts show a live counter and disable the copy button when invalid. Drafts are saved in History. Nothing posts automatically: copy/paste and submit on X yourself. Email mode is unchanged.

`npm install` installs dependencies. `npm run build:tweet-counter` rebuilds the checked-in browser character counter after dependency changes.

## Project layout and development

`index.html` is a small shell. The frontend is vanilla ES modules in `src/` (`domain/` pure logic, `state/`, `services/`, `components/`, `views/`, `styles/`), bundled by esbuild into the committed `public/app.js` and `public/app.css`. See `docs/ux/experience-changes.md`.

```sh
npm install            # dev dependencies only: esbuild, playwright-core, axe-core, twitter-text
npm run build:app      # rebuild public/app.js and public/app.css after editing src/
npm run check:app      # fail if the committed bundle is stale
npm test               # unit, server, bundle/deploy-config and browser tests
```

Browser tests need Chromium (`PLAYWRIGHT_BROWSERS_PATH`, or `CHROMIUM=/path/to/chrome`); they are skipped when it is unavailable. They use a **mock** model, so they verify UI behaviour and plumbing, not output quality.
