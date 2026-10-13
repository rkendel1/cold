## What changed and why

## Checks
- [ ] Tests added or updated for the behaviour; CI is green (it runs the whole suite under a virtual display and fails on skipped coverage).
- [ ] **Data destinations and authority.** If this adds or changes anywhere data is stored, sent, or read from (a storage backend, a third-party API or sign-in, sync/pairing, a new field in a model prompt, a log or diagnostic), I updated **all** of: `docs/privacy-and-data-flow.md`, the README privacy paragraph, the in-app wording (`store.keptNote` and Settings > Your data), and `docs/audit/07-security-privacy-data-authority.md`. If it doesn't, I say so here: ____
- [ ] No secrets, keys, tokens or real people's data in code, tests, docs or screenshots.
- [ ] Documentation affected by the change is updated (index: `docs/README.md`); `node scripts/audit-links.cjs` passes.
- [ ] Anything I could not verify (real model, real Google, packaged app, manual accessibility) is stated as unverified, not as passed.
