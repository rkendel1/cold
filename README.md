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

`index.html` is a single self-contained page. It is built to run as a Claude artifact on claude.ai, where it uses the artifact runtime (`window.claude`) for:

- `sample` to generate with Claude, on the viewer's own account
- `db` to keep the knowledge base and drafts private to the owner
- `user` to check ownership

Opened anywhere else, the page still works for knowledge editing and history (saved to the browser's localStorage), but generation is disabled until it runs inside Claude.
