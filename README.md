# Cold

A focused cold-email generator. Give it five facts; it gives you an email worth sending.

**Knowledge base → recipient relevance → one goal → three sentences → explicit ask.**

## What's in the MVP

- **Knowledge**: products with plain-English description, audience, problem, proof points (claim, evidence, type, strength, use-externally flag), technical facts, approved language, and do-not-say rules.
- **Compose**: recipient name, role, company, why them, goal (advice, investment, introduction, customer conversation, partnership, other), and anything specific to convey.
- **Generate**: two stages. A draft (relevance classification, knowledge retrieval, three sentences), then an editor pass that checks the draft against 20 rules and rewrites it. Every claim is traced back to a knowledge-base record.
- **Quality**: a 0–100 score from the 20 rules. Length, read time, sentence count, stock openers, marketing language, do-not-say phrases, explicit ask, meeting requests and subject line are checked locally and update live as you edit. "Improve" reruns the editor on a specific weakness.
- **History**: every generated email is saved as a draft. Copy it, mark it sent or replied, reopen and edit.

Cold never sends anything. Generate with AI, send yourself.

## Running it

Cold runs in two modes. The page picks the right one on its own.

### API-key mode (run it yourself)

Needs Node 18 or newer. No dependencies to install.

```sh
cp .env.example .env    # then put your key in .env
npm start               # http://127.0.0.1:3000
```

`.env` settings:

| Variable | Required | Default | |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | | Your Anthropic API key |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-5-5` | Any Messages API model, e.g. `claude-opus-5-5` or `claude-haiku-4-5-20251001` |
| `ANTHROPIC_MAX_TOKENS` | no | `2000` | Per call |
| `PORT` | no | `3000` | |
| `HOST` | no | `127.0.0.1` | Set `0.0.0.0` to expose it on your network |

The key stays on the server: the page calls `/api/generate`, and `server.js` calls the Messages API. Each email takes two calls, a draft and an editor pass. In this mode, products and drafts are saved in the browser's localStorage. `.env` is git-ignored.

### Claude artifact mode

Published as a Claude artifact on claude.ai, the same `index.html` uses the artifact runtime (`window.claude`) instead:

- `sample` to generate with Claude, on the viewer's own account
- `db` to keep the knowledge base and drafts private to the owner
- `user` to check ownership

Opened as a plain file with neither, knowledge editing and history still work, but generation stays off.
