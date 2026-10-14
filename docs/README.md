# Documentation index

One authoritative home per topic. If two documents seem to disagree, the one marked **canonical** wins and the other is a bug; the [audit](audit/README.md) says what the source actually does.

| Audience | Document | Canonical for | Status |
|---|---|---|---|
| Everyone | [../README.md](../README.md) | What Cold is, how to run it, the feature reference | Current (reconciled by the audit) |
| New user | [getting-started.md](getting-started.md) | First draft, first import, what to do next | Current |
| User (Ubuntu) | [ubuntu.md](ubuntu.md) | Installing, running, backing up and removing the desktop app on Ubuntu; the pilot checklist; what is and isn't verified there | Current; **tested in CI and an Ubuntu container, not yet on a pilot's machine** |
| User | [troubleshooting.md](troubleshooting.md) | Verified failure modes and fixes | Current |
| Operator / developer | [configuration.md](configuration.md) | Every environment variable, file and build flag | Current |
| User, reviewer | [privacy-and-data-flow.md](privacy-and-data-flow.md) | What data goes where | Current (Google Sheets added) |
| Operator, user | [google-sign-in.md](google-sign-in.md) | Optional Google sign-in and Cold account foundation (hosted web): flow, sessions, configuration, limits | Current; **not verified against real Google** |
| User | [data-portability.md](data-portability.md) | Export, restore and erase: what each includes, excludes and limits | Current |
| User, operator | [standalone-surfaces.md](standalone-surfaces.md) | What each surface needs and can do alone | Current |
| User | [shared-library.md](shared-library.md) | Pairing web/extension with the desktop app | Current |
| Developer | [library-contract.md](library-contract.md) | What is shared in code and data across surfaces | Current |
| Developer | [data-integrity.md](data-integrity.md) | Merge, conflict and unknown-field rules for outreach records | Current |
| User, operator | [google-sheets.md](google-sheets.md) | Optional Google Sheets storage: behaviour, setup, limits | Current; **preview, unverified against real Google** |
| User | [people-search.md](people-search.md) | Optional email lookup (treg) | Current |
| User | [second-check.md](second-check.md), [ask-cold.md](ask-cold.md) | Extension features | Current |
| Developer | [hf-ssh-provider.md](hf-ssh-provider.md), [hf-ssh-test.md](hf-ssh-test.md) | Experimental provider (not for production) | Experimental |
| **Decision-maker, engineer, PM** | **[audit/](audit/README.md)** | **What works, where, how ready, what must happen before launch** | **Canonical for readiness** |
| Product | [validation/](validation/README.md) | Commercial validation plan (prepared, **not executed**) | Plan |
| Historical | [ux/](ux/initial-audit.md), [evaluation/](evaluation/2026-10-10-commercial-evaluation.md) | Snapshots from 2026-10-10 | Historical (bannered); `ux/cx-standards.md` is aspirational |

**Ownership.** The repository has a single maintainer group (see `package.json`). Each document above is owned by whoever changes the area it describes; a change to behaviour must update the canonical document in the same PR. There is no `SECURITY.md`, `CONTRIBUTING.md`, release procedure or support route yet ([audit DOCS-005](audit/11-remediation-backlog.md)).
