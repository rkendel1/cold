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
| `OLLAMA_MODEL` | no | `llama3.1` | Local model name (only with `LLM_PROVIDER=ollama`) |
| `OLLAMA_BASE_URL` | no | `http://127.0.0.1:11434` | Ollama (or any OpenAI-compatible local server, e.g. LM Studio) |
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

## Local models (Ollama)

```
ollama pull llama3.1
echo "LLM_PROVIDER=ollama" >> .env
npm start
```

No API key needed. Set `OLLAMA_MODEL` to use a different model. Note `provider-config.json` overrides `LLM_PROVIDER` if its `provider` is set.

## Desktop app

```
npm install
npm run desktop         # run the app
npm run desktop:build   # package a .dmg / installer into dist/
```

Cold runs its own server inside the app on `127.0.0.1:47821` (override with `COLD_PORT`; saved drafts are tied to the port, so keep it stable).

**Settings** (menu: Cold > Settings, or `Cmd/Ctrl+,`) lets you pick the provider and model and save API keys for Ollama, Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, Mistral, Vercel AI Gateway, or any OpenAI-compatible server (LM Studio, vLLM, llama.cpp). Models are listed live from the provider. Keys are encrypted with the OS keychain (Electron `safeStorage`), saved in the app's data folder, and never sent back to the page. The same screen is available to a local `npm start` by setting `COLD_SETTINGS_FILE=/path/to/settings.json` (keys are then stored in that file, mode 0600). Hosted deployments leave it unset and keep using environment variables.

## Open in email

An email draft has an optional **Email address** (in Write, and a **To** field on the draft). **Open in email** hands the current text, including your edits and sign-off, to your own email app as an *unsent* draft: recipient, subject and body filled in, line breaks kept. You review and press Send there. Cold never sends mail, never connects to an email account, never looks an address up, and opening a draft does not change its status.

- **No address, or an invalid one:** nothing opens. Cold says so, puts the cursor in the To field and keeps your draft. **Copy email** always works without an address.
- **Long messages:** `mailto:` links are unreliable past roughly 2,000 characters (`MAILTO_MAX_LENGTH` in `lib/mailto.js`). Longer drafts are never shortened; Cold tells you and you use Copy.
- **Desktop app:** a one-function bridge (`desktop/preload.js`) asks the main process to open the link; the main process only accepts a single valid address with `subject`/`body` and refuses everything else, and reports failure back so the page can point to Copy.
- **Browser, web and extension:** a normal `mailto:` link. A browser cannot tell whether an email app answered, so the message says "if nothing opened, this device may not have an email app set up". Chrome may ask once before handing off to an app. This depends on your local email-app / browser setup and is the one part automated tests cannot prove.

## Tracking outreach (History)

History is where you record what actually happened. Cold records only what you tell it: it can't see your inbox, so nothing is ever marked sent or replied automatically, and copying, opening in your email app, generating and editing never change a status.

1. Write an email, then **Open in email** (or Copy) and send it yourself.
2. Come back and press **Mark sent** (on the draft, or on its row in History). Cold keeps the text as it was at that moment under "Text when you marked it sent".
3. When a reply arrives, press **Record reply**.
4. Filter by **Draft / Marked sent / Reply recorded**, or search by name, company, email address, subject or your notes.

Each row shows the recipient, address (if you entered one), subject, a message preview, the status, and created / updated / marked-sent / reply dates. **Notes & details** holds an optional note (why they fit, what you sent, what the reply said, what to follow up on) and the address; both save as you type. The status menu is still there to correct a mistake.

If you edit a draft after marking it sent, the status and dates don't change and the as-sent text is kept; Cold says so on the draft. This is a single saved copy, not version history, and it is Cold's copy of the text, not proof of what your email app sent. Records saved by older versions load as before (no note, no sent copy; nothing is invented).

## Where your data lives (SQLite)

In the desktop app, products and drafts are stored in one SQLite file: `~/Library/Application Support/Cold/cold.db` on macOS (the path is also shown in Settings > Browser extension). It uses WAL mode, so you can copy it for a backup or open it with any SQLite tool, e.g. `sqlite3 cold.db "select recipient_name, status, subject from emails"`. Provider keys are *not* in this file; they are encrypted separately in `settings.json`.

On first launch, anything already saved in the app's browser storage (the old localStorage data) is copied into SQLite once. The original browser data is left in place untouched.

Outside the desktop app, Cold still uses browser storage unless you set `COLD_DB_FILE=/path/to/cold.db` (needs Node 22.13+). Hosted deployments never set it.

## One product, three surfaces

Web, the desktop app and the browser extension run the **same screens** (Write, Knowledge, History, Settings), the same domain rules (outreach status, notes, the sent copy) and the same words. Where a surface can't do something it says so in place instead of hiding it.

| | Web | Desktop app | Extension |
|---|---|---|---|
| Write, Knowledge, History | same | same | same |
| Where records live | this browser | SQLite (the **hub**) | extension storage |
| Provider keys | stay on the server (hosted site: not editable) | editable, OS keychain | editable, browser storage (not encrypted, labelled) |
| Works with nothing else running | yes | yes | yes |
| Syncs with the desktop app | optional | is the hub | optional |
| Read the open tweet or profile ("This page") | no | no | yes |
| Put a draft in X's tweet box | no | no | yes |
| Pairing code, allowed web apps | no | yes | no |

**How the surfaces share data.** The desktop app is the hub. Web and the extension each keep a full local copy, work with the app closed, and sync with it whenever it is running: changes made while it was closed are sent when it returns, the hub's newer copy of anything wins, and deletes sync too. While the desktop app is closed, web and the extension cannot sync *with each other*; each catches up when the app is back. There is no cloud service.

**Connect the web app:** in the desktop app, Settings > Browser extension & web apps, add the web app's address under *Allowed web apps* (shown on the web app's own Settings page) and copy the pairing code. In the web app, Settings > Cold desktop app, paste the app's address and the code. If the hub isn't reachable you can still use everything; **Settings > Sync now** retries. When both the web server and the desktop app have a model, Settings lets you pick which one Write uses; if the chosen one disappears, the other is used automatically. Only the prompt goes to the desktop app; provider keys never leave where they are stored.

## Browser extension

The extension is the same app in Chrome's side panel, plus a **This page** card on Write.

```
npm run build:extension      # bundles extension/dist
```

Then in Chrome, Edge or Brave: `chrome://extensions` > turn on Developer mode > **Load unpacked** > choose the `extension/` folder. Click the Cold icon to open the side panel.

- **On its own:** Settings > Model works like the desktop app's: pick a provider (Ollama, Anthropic, OpenAI, Gemini, OpenRouter, Groq, Mistral, AI Gateway, or any OpenAI-compatible server), add a key if it needs one, choose a model. The extension calls the provider directly. Keys saved here live in the browser profile's extension storage and are *not* encrypted. Local Ollama needs no setup: the extension removes the browser-extension `Origin` header from its own requests to the Ollama address you configure, since Ollama otherwise answers 403.
- **With the desktop app:** Settings > Cold desktop app, paste the address and pairing code. Products, drafts, statuses, notes and sent copies sync both ways automatically.
- **This page:** open a tweet and click *Read this page* to reply (optionally say what you want to say back); on a LinkedIn or X profile it fills in who they are and suggests reasons they'd care. *Put it in the tweet box* types the draft into X's reply box and you press Reply yourself. Pages are read only when you click.
- **Security:** with the app, the extension authenticates with the pairing code and can only read and write products and drafts, generate, and look up public profiles and tweets. It cannot read or change the app's provider keys, the provider choice, the allowed web apps or the code. Creating a new code in the app disconnects every paired surface. The extension reads x.com, twitter.com and linkedin.com pages only when you click *Read this page*, and talks only to `127.0.0.1` / `localhost` for the app.

