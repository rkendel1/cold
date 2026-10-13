# Configuration reference

Every setting below was checked against the code that reads it (`server.js`, `lib/`, `desktop/main.js`, `scripts/build-extension.cjs`). A `.env` file in the repository root is read at start-up by `server.js` for any variable not already set in the environment (`.env.example` shows the common ones). Secrets belong in the environment or `.env`, never in the repository.

## Server and web app (`npm start`, hosted deployments)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to bind. `0.0.0.0` exposes the server on your network; set `COLD_ACCESS_TOKEN` first |
| `LLM_PROVIDER` | `ai-gateway` | Provider id: `ollama`, `anthropic`, `openai`, `google`, `openrouter`, `groq`, `mistral`, `ai-gateway`, `custom` (or experimental `hf-ssh`). `provider-config.json` `provider` overrides it when set; on Vercel previews (`VERCEL_ENV=preview`) `previewProvider` (currently `hf-ssh`, experimental) is used |
| `LLM_MAX_TOKENS` / `ANTHROPIC_MAX_TOKENS` | `2000` | Per model call |
| Provider keys, models, URLs | provider default | Per provider (see next table) |
| `VERCEL_OIDC_TOKEN` | | Used as the AI Gateway key on Vercel when `AI_GATEWAY_API_KEY` is unset |
| `COLD_ACCESS_TOKEN` | unset | If set, `/api/generate` requires it in the `x-cold-access` header and the page asks for it. **Set before sharing a URL**: without it anyone who can reach the server can spend your provider credit |
| `COLD_RATE_LIMIT_PER_MIN` | `30` | Best-effort per-address limit on `/api/generate`, in memory, per instance |
| `COLD_DB_FILE` | unset | Path to a SQLite file; turns on `/api/data` (products, drafts, leads). Needs Node 22.13+. The desktop app sets this itself; hosted deployments must not |
| `COLD_SETTINGS_FILE` | unset | Path to a settings file; turns on the Settings screen's editable provider keys (desktop and local installs). Never set on a hosted server |
| `TREG_TOKEN` | unset | Optional [treg](https://treg.to) token for *Find email* (a token saved in Settings takes precedence) |
| `COLD_GOOGLE_CLIENT_ID` | unset | **Turns on the optional Google Sheets setting.** Web: a "Web application" OAuth client id (the page signs in with Google's script). With `COLD_SETTINGS_FILE` set (desktop/local), a "Desktop app" client id: the server runs the sign-in |
| `COLD_GOOGLE_CLIENT_SECRET` | unset | Desktop/local only: the Desktop client's secret (Google does not treat installed-app secrets as confidential) |
| `COLD_GOOGLE_AUTH_URL`, `COLD_GOOGLE_TOKEN_URL`, `COLD_GOOGLE_SHEETS_BASE` | Google's | Overrides for tests/stand-ins. Do not set in production |
| `NODE_ENV` | | Read by the test helpers only |

### Provider environment variables

| Provider id | Key | Model | Base URL | Needs a key |
|---|---|---|---|---|
| `ollama` | | `OLLAMA_MODEL` (default `llama3.1`) | `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`) | no |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) | `ANTHROPIC_BASE_URL` | yes |
| `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` (default `gpt-4o-mini`) | | yes |
| `google` (Gemini) | `GEMINI_API_KEY` | `GEMINI_MODEL` (default `gemini-2.0-flash`) | | yes |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` (default `anthropic/claude-sonnet-4.5`) | | yes |
| `groq` | `GROQ_API_KEY` | `GROQ_MODEL` (default `llama-3.3-70b-versatile`) | | yes |
| `mistral` | `MISTRAL_API_KEY` | `MISTRAL_MODEL` (default `mistral-large-latest`) | | yes |
| `ai-gateway` | `AI_GATEWAY_API_KEY` | `AI_GATEWAY_MODEL` (default `anthropic/claude-sonnet-4.5`) | | yes |
| `custom` (OpenAI-compatible) | `CUSTOM_API_KEY` | `CUSTOM_MODEL` | `CUSTOM_BASE_URL` | no |

Defaults come from `lib/providers.js`. On the desktop app and in the extension, provider, model and key are chosen in **Settings > Model** instead; Settings values take precedence over the environment.

## Desktop app

| Setting | Where | What it does |
|---|---|---|
| `COLD_PORT` | environment | Local port for the app's own server (default `47821`). Saved data is tied to the page origin, so keep it stable |
| Data folder | Electron `userData` | `cold.db` (SQLite, WAL) and `settings.json` (provider keys, Google refresh token; encrypted with the OS keychain when available, else a private 0600 file) |
| `desktop/google.json` | file, git-ignored | `{ "clientId": "…", "clientSecret": "…" }` for the Desktop OAuth client; read at launch and exported as the two variables above. Copy `desktop/google.example.json`. **If present when packaging, it is included in the app** |

## Browser extension

| Setting | Where | What it does |
|---|---|---|
| `COLD_GOOGLE_CLIENT_ID` | environment at **build time** (`npm run build:extension`) | Compiles in the "Web application" OAuth client id (redirect `https://<extension-id>.chromiumapp.org/`). Unset: the build has no Google Sheets option |
| Provider, model, key | Settings > Model | Stored in `chrome.storage.local` (**not encrypted**) |
| Host access | Chrome's permission prompt | Optional host permissions are requested per origin: the provider or desktop-app address you enter, and (for Ask Cold / Browse With Me) a page's site when you ask Cold to read it |

## Build and test

| Command | Purpose |
|---|---|
| `npm run build:app` / `check:app` | Rebuild / verify the committed bundle (`public/app.js`, `public/app.css`) |
| `npm run build:extension` | Build `extension/dist` (needed by the extension tests) |
| `npm test` | Whole suite. Browser tests need Chromium (`PLAYWRIGHT_BROWSERS_PATH` or `CHROMIUM`); extension tests need `extension/dist`; the desktop-mail and side-panel layout tests need Electron and a display (`xvfb-run -a npm test` on headless Linux); the SQLite tests need Node 22.13+. Locally, a missing prerequisite skips the dependent tests; with `CI=true` or `COLD_REQUIRE_PREREQS=1`, `test/00-ci-prerequisites.test.js` **fails** instead |
| `node scripts/ci-check-skips.cjs <tap file>` | Fails if the TAP report has a skipped test that is not allow-listed (only `REAL MODEL:` is) |
| `npm run smoke:model` | Real-model smoke test, only with `COLD_REAL_MODEL=1` and a model |
| `npm run verify:local-model` | Re-checks the on-device model pins against the network |
| `node scripts/audit-screenshots.cjs`, `node scripts/audit-axe.cjs` | Reproduce the audit screenshots and the extra accessibility scan |
