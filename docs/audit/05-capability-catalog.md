# 05. Capability and maturity catalog

Three questions, kept apart on purpose:

* **A. What Cold does today** (assessed on its merits).
* **B. What Cold must still do to deliver its *existing* promises reliably** (hardening of things already claimed). These are the launch-relevant items.
* **C. What could improve the product or its position** (opportunities; not defects, not promised anywhere).

Maturity levels (P0–P4) and per-capability gates are in [06](06-production-readiness.md); per-surface status is in [03](03-parity-matrix.md).

## A. What Cold does today

| Capability | User problem and intended outcome | Authoritative implementation | Boundaries (UI / service / storage) | Validation and failure handling | Security and privacy | Tests (and meaningful gaps) | Runtime verification | Operational dependencies | Known limitations | Next step |
|---|---|---|---|---|---|---|---|---|---|---|
| **Grounded email drafting** | Write a short, specific cold email without inventing facts | `generation.js`, `prompts.js`, `rules.js`, `grounding.js`, `decide.js` | Compose view → `generation.js` → provider via server (web), local server (desktop), direct or paired app (ext) | 20-rule editor pass + deterministic checks; unsupported claims never shown as verified; failure keeps inputs | Internal-only proof never sent; only this draft's facts go to the provider (`T:privacy`) | Strong on plumbing (`T:e2e`, `T:outreach`, `T:decide`). **Gap: no real-model evidence of quality** | Mock model only | A provider account | Checklist score ≠ reply prediction | QUALITY-008 |
| **Product knowledge** | Save facts once; reuse | `knowledge.js` | Knowledge view ↔ store | Required fields; internal vs external proof | Local only | `T:e2e` | Yes (browser) | none | Lead↔product by name | OPP-001 |
| **Leads + CSV import/export + mapper + extra fields** | Bring an existing list; start a draft per person | `leads.js` | Leads view ↔ store ↔ (SQLite / local / Sheets) | Review-before-save, per-row reasons, size limits, idempotent keys | Values written as text; export neutralises formula prefixes | Strong (`T:leads` 9, `T:e2e` ×6, `T:leads-storage`) | Yes (R2, R7) | none | Mapping not remembered; 5,000 rows / 2 MB per import | OPP-002 |
| **Outreach status + sent copy** | Record what really happened without Cold guessing | `outreach.js` | History/Write ↔ store | User-set only; concurrent edits merged or refused | Local | Strong (`T:outreach-integrity` 19) | Yes | none | none material | — |
| **Email handoff (copy, Gmail/Outlook/mailto)** | Get the text into the user's own mail with minimal fuss | `lib/mailto.js`, `handoff.js`, `desktop/main.js` | Draft/History → link → OS or new tab | Validated address; length caps; refusal not truncation; main-process allow-list | No Google authorisation, no account access, no send | `T:mailto`, `T:handoff`, `T:e2e`; desktop IPC test not runnable here | Links yes; OS handoff no | A mail client or webmail login | Cannot know the outcome (by design, said everywhere) | QUALITY-003 |
| **Follow-ups** | Not forget to nudge | `followup.js` | Draft/History ↔ record | Clamped settings; idempotent handoff; limit | Local | `T:followup` (5), `T:e2e` (web) | Web | none | No alerts; web-only verification | PARITY-003, OPP-003 |
| **SQLite persistence** | Durable local library with inspectable data | `lib/db.js` | Browser → `/api/data` → SQLite | Outreach writes versioned (merge-or-refuse); leads/products unconditional; size and id guards | Loopback-only unless host set; settings routes refuse non-local hosts and extension tokens | `T:db`, `T:sqlite-store`, `T:data-api`, `T:server-security`, R6 | R6 probe | Node 22.13+ (Electron bundles it) | Unreadable rows silently omitted | DATA-008, DATA-009 |
| **Hub sync (web/extension ↔ desktop)** | Share a library on one computer | `replica.js`, `hubLink.js`, `libraries.js` | Pairing code over loopback | Offline edits queue; merge or surface conflict | Pairing code; extension can't read provider keys (`T:extension`) | `T:shared-library`, `T:replica`, `T:extension` | Yes (browser + real server) | Desktop app running for sync | One test timing-flaky under load | QUALITY-004 |
| **Provider + model selection** | Use the user's own model | `lib/providers.js`, `settings.js` | Settings ↔ server/desktop/ext storage | Key never returned to the page (hint = last 4 chars) | Keychain encryption (desktop); **extension unencrypted** | `T:provider`, `T:settings`, `T:server-security` | Mock endpoints | Provider accounts | Real providers untested here | SEC-001 |
| **Context capture / Ask Cold / second check** | Turn a page into an opportunity or reply | `extension/src/*`, `opportunity.js`, `decide.js` | Extension only | Explicit click; one bounded evaluator; second check can only lower confidence | Page text stays local unless a hosted model is chosen (stated) | `T:opportunity*`, `T:extension`, `T:second-check` | Stand-in pages | Chrome | Mock model | — |
| **Google Sheets storage (optional)** | Keep leads/outreach in the user's own spreadsheet | `sheetsDb.js`, `sheetsMap.js`, `sheetsApi.js`, `sheetsConnector.js`, `googleAuth.js`, `lib/google.js` | Settings wizard → connector → Sheets API; sign-in per surface | Read-before-write; versions on outreach only; backoff on 429/5xx; clear errors; start-up banner | `drive.file` only; tokens in memory (web/ext) or server-side (desktop); CSP opens Google only when configured (`T:google-oauth`) | `T:sheets` 9, `T:sheets-e2e` 3, `T:google-oauth` 3, `T:google-auth` 4 — **all against stand-ins** | None against Google | A Google Cloud project, one OAuth client per surface, Sheets API enabled | Leads LWW; empty-on-unreadable; no offline; not synced via hub | DATA-001…007 |
| **Email lookup (treg)** | Find a missing work email | `lib/treg.js` | Lead → server → treg.to | Candidate only; nothing saved until accepted | Token server-side only | `T:people` (13) | Stand-in | treg token | Third-party data path (documented) | — |
| **On-device model** | Private drafting without a provider | `extension/src/localModel.js` | Extension only | Checksum-pinned libraries, fail-closed | Local | `T:local-model` 14 (stand-ins) | Real runtime without GPU only | WebGPU | Real model/quality unverified; pins not recorded in shipped build | QUALITY-007 |

## B. Hardening required to deliver existing promises

Each item is a defect or missing safeguard in something already shipped or documented. Full records, with acceptance criteria, in [11](11-remediation-backlog.md).

| Existing promise | What is missing | IDs |
|---|---|---|
| "Each is complete by itself" and "works with nothing else running" | An installable, updatable desktop app and a distributable extension (today: build from source) | QUALITY-010, QUALITY-011 |
| "A new user can get started" (README, in-app copy) | A first-run path; a clear route when no model is configured | CX-001, CX-002 |
| "Cold only records what you tell it" / honest states | Explain follow-up-due on an unsent draft | CX-004 |
| "Your data stays where you put it; you can see where" | Real-Google verification of the Sheets path; lead concurrency; offline/empty behaviour; hub interaction | DATA-001, -002, -004, -005, -007, PARITY-002 |
| "Nothing is lost / nothing is deleted" | Visible handling of unreadable rows; transactional import; export/backup/erase | DATA-008, -009, -010 |
| "Tested on all three surfaces" (parity claims) | Surface-specific tests for follow-ups, Leads on the extension, Sheets on desktop/extension | PARITY-001, -003, -004 |
| "The suite protects the product" | CI that fails loudly; no silent skips; fix the timing flake; run display-dependent tests under xvfb | QUALITY-002, -003, -004 |
| "Errors are handled gracefully" | Replace the blanket error layer with per-operation handling | QUALITY-005 |
| Privacy statements | Kept in step with every new data path (corrected for Sheets) | SEC-006 |
| "Quality drafts" (core value) | Evidence with real models on real recipients | QUALITY-008 |

## C. Opportunities (not defects)

| ID | Opportunity | Why it could matter | Dependency |
|---|---|---|---|
| OPP-001 | Reference product by id in leads and show a broken link | Prevents silent breakage after renames | Data migration |
| OPP-002 | Remember a CSV mapping per header set | Faster repeat imports | none |
| OPP-003 | Follow-up reminders (desktop notifications; email digest) | A reminder that never alerts is easy to miss | Per-surface notification APIs |
| OPP-004 | Push-style Sheets sync (Apps Script webhook) instead of 20 s polling | Fewer reads, faster updates | Operator-side setup |
| OPP-005 | A "copy diagnostics" button (versions, storage kind, last Sheets status; no content) | Supportability without telemetry | none |

## Audit questions

| Expectation | Answer | Evidence |
|---|---|---|
| A feature works without another surface running | **Yes.** Each surface is self-contained; pairing is optional | `T:standalone`, `T:e2e` ("works on its own"), `docs/standalone-surfaces.md` |
| The user can identify the authoritative copy of their data | **Mostly.** Footer/Settings say where data is kept; with Sheets, "kept in different places: leads and drafts in your Google Sheet…". Not identifiable: which surface holds the newest copy when unpaired | `src/state/store.js` `keptNote`, R1, R4 |
| Google Sheets two-way sync is real, not import/export | **Implemented as real reads and writes per operation, plus polling** (rows, versions, merges). Verified only against a stand-in | `T:sheets`, `T:sheets-e2e`; DATA-001 |
| Source-of-truth switch is deterministic and documented | **Partly.** *Local → Sheets* and *Sheets → local* are defined and tested (copy in without overwriting; copy back). *Sheet A → Sheet B* and *two devices on different sources* are not defined | [07](07-security-privacy-data-authority.md), `docs/google-sheets.md` |
| CSV imports are safe to retry; failures don't silently corrupt | **Yes** for retry (keys/ids); failures show the truth after re-read. Not one transaction on SQLite | `T:leads`, `T:e2e`; DATA-010 |
| Follow-ups survive restarts; duplicates handled | **Yes** (stored on the record; repeat copy doesn't move a date) | `T:followup`, `T:e2e` |
| Gmail handoff doesn't imply delivery or tracking | **Yes.** Every message states Cold hasn't sent anything and cannot tell what happened | `T:e2e`, `T:handoff`, README |
| UI success states reflect real results | **Mostly.** Saves that fail say so (storage-full, conflicts). One pattern masks failures: a global layer swallows exceptions in `store.set` and unhandled rejections (QUALITY-005) | `src/components/production-readiness.js` |
| Provider credentials and sensitive data not exposed via client code, logs or records | **Yes by construction:** no keys in the bundle (pattern scan), server logs only a startup banner, settings return key *hints* only, refresh tokens never returned to the page. **Exception:** extension keys unencrypted in extension storage (documented) | R9 (secret scan), `T:privacy`, `T:google-oauth`; SEC-001 |
| Important operations recoverable after partial failure | **Mostly.** Read-before-write and ids make retries safe. A sheet unreadable at start-up shows empty until reconnect | `T:sheets`; DATA-005/-006 |
