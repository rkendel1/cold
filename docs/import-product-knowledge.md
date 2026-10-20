# Import product knowledge

Point Cold at a GitHub repository (or upload a ZIP) and it drafts the product profile from what the project actually contains. Everything lands in the normal product editor as **suggestions**. Nothing is added, saved or approved for emails until you choose it.

## What you see

Knowledge → **Import from repository** (or on the empty screen). Paste a public GitHub address or choose a ZIP (up to 40 MB; works for private projects). Cold shows its progress, then a review panel above the editor:

| Label | Meaning |
| --- | --- |
| **Verified** | An exact excerpt in code, a test, an example or a manifest backs it. Still check it says what the wording says. |
| **Inferred** | A reasonable reading, or documentation only (Cold has not checked it against the implementation). |
| **Needs evidence** | Possibly useful, but nothing in the project supports it. Customer, adoption, production-readiness, security and performance claims land here unless a benchmark exists. |
| **Not found** | Cold could not determine it and left it blank. |

Per suggestion you can edit the wording, **Use this / Add**, **Replace current** (only offered when a field already has your text), or **Discard**. Each has an Evidence list with file and line range, the excerpt, and (for GitHub) a link to that exact commit.

## Safety rules

1. Imported proof is always added **internal-only**. A *verified* proof point also offers "Add and approve for external use": one explicit click, never automatic. Unsupported claims cannot be approved from the import.
2. Status is computed by Cold from where the evidence lives. A model-cited quote that does not occur verbatim in the cited file is dropped.
3. Your existing text, approved proof and prohibited phrases are never overwritten; imports only add or offer replacements.
4. Prohibited-phrase suggestions (the project's own hype words) are offered, not added.
5. The model only sees the repository's files, never your existing product data, so internal-only proof cannot reach a prompt. Repository text is treated as untrusted data.

## Provenance

Accepted items keep a record on the product (`importSource`, `provenance`): repository, commit SHA (or a content hash for ZIPs), file and line range, excerpt, status and extraction time. It is kept apart from the prose and is never sent to the model.

## Refresh from repository

Re-reads the project and re-checks each earlier excerpt against the new files (no model needed for that). Facts whose source changed or disappeared appear under **Needs a look**. An approved claim stays approved until you press **Move to internal-only**. New findings are listed as fresh suggestions. A refresh never replaces the profile.

## Configuration

- Runs on the Cold server (web, desktop, local install), using the configured model provider. Not available in the Chrome extension.
- `COLD_GITHUB_TOKEN` (or `GITHUB_TOKEN`) is optional: it raises GitHub's rate limit and allows private repositories the token can read. Without it, upload a ZIP for private code.
- Only `github.com` repositories are fetched; the commit is resolved to a SHA first and that exact archive is read in memory.

## Known limits

- Verification confirms the cited excerpt exists; it cannot prove the excerpt entails the wording. Read before approving.
- `@appport/github` is not used yet: it resolves repositories to commits but has no file/archive API, and needs an AuthBoundry authority and FeltDB plus Node 22. Ingestion sits behind `lib/repoSource.js` so it can be swapped in.
