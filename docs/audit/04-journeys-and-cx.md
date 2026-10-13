# 04. Customer journeys and CX audit

Perspectives: a **new user** (never saw Cold), an **established user**, and a user **recovering from a failure**. Each journey says what was *observed or tested*, not what the screens appear to allow. Screenshots are real captures of the running app ([README](README.md#what-this-audit-does-not-do) says what backs them). Statuses use the [standard vocabulary](README.md#conventions).

| # | Journey | Status | Worst problem |
|---|---|---|---|
| J1 | Install or open for the first time | Partial | Desktop installers are unsigned and the extension is "load unpacked" only (QUALITY-010/-011) |
| J2 | Understand the value and complete onboarding | **Absent** | No onboarding flow (CX-001) |
| J3 | Configure a provider and pick a model | Partial | On hosted web a visitor hits a dead end (CX-002) |
| J4 | Add product knowledge | Verified | Lead→product link is by name (OPP-001) |
| J5 | Import a CSV with the template | Verified | none |
| J6 | Map existing columns | Verified (after a fix) | Recognised columns weren't matched when no name column existed (CX-005, fixed) |
| J7 | Validate, recover from malformed/duplicate rows | Verified | SQLite import is not one transaction (DATA-010) |
| J8 | Connect Google Sheets, choose it as the source of truth | Partial | Never run against real Google (DATA-001) |
| J9 | Create, update, verify data in both directions | Partial | Leads last-writer-wins across devices (DATA-004) |
| J10 | SQL-backed data management | Verified (desktop) | No in-app backup/restore/export (DATA-009) |
| J11 | Select a lead and produce personalised outreach | Partial | Draft quality unevidenced (QUALITY-008) |
| J12 | Copy an email and understand what happens next | Verified | A "follow-up due" for an unsent draft isn't explained (CX-004) |
| J13 | Hand off to Gmail and know what Cold can know | Verified (links) | Desktop OS handoff not verifiable here (QUALITY-003) |
| J14 | Create, inspect, modify, complete a follow-up | Partial | Verified on web only (PARITY-003) |
| J15 | Resume after restart or switch surfaces | Partial | Switching surfaces loses sharing unless paired; Sheets bypasses pairing (PARITY-002) |
| J16 | Recover from provider/auth/network/sync failure | Partial | Unreadable sheet shows an empty list (DATA-005, mitigated) |
| J17 | Disconnect an integration | Verified (after a fix) | "Stop" left Google authorised (DATA-003, fixed) |

---

## J1. Install or open Cold for the first time

* **Goal / outcome.** Be looking at a working app.
* **Entry / prerequisites.** Web: a URL; a model must be configured by whoever runs the server. Desktop: build or receive an installer (`npm run desktop:build`); no release artifacts exist in the repo and none are published. Extension: `npm run build:extension`, then Chrome > Developer mode > Load unpacked.
* **Flow.** Open → lands on **Write** with an empty form and an explanatory card (R1, [`screenshots/01-first-run-write.png`](screenshots/01-first-run-write.png)).
* **Data.** Nothing created until a draft or product is saved.
* **External systems.** None on first load (no analytics, `T:privacy`).
* **Success criteria.** The page renders and the primary action is evident: `T:e2e` "first use: no fabricated prospect, product, example email or default sign-off; first action is obvious".
* **States.** `noscript` message exists (`index.html`). No loading screen needed (static bundle).
* **Usability.** The first screen is a long form (profile lookup, pasted text, who, why, what, goal) with the Generate button below the fold at 1280×860 (R1).
* **Cross-surface.** Desktop and extension have the same first screen; the extension needs developer mode.
* **Verification.** Web: verified. Desktop install/first launch: **Unverified** (packaging never run; installers are unsigned, so macOS Gatekeeper/Windows SmartScreen warnings are expected but not observed). Extension: dev-load only.
* **Severity / fix.** High for adoption beyond developers: signed installers, an update path, and a store-listed extension (QUALITY-010, QUALITY-011).

## J2. Understand the value proposition and complete onboarding

* **Observed.** No onboarding flow exists: no welcome, no tour, no sample data, no checklist, no "connect a model → add a product → write your first email" path (source search for onboarding/welcome/first-run finds nothing; R1). The only guidance is the subtitle ("Tell Cold who you're writing to…") and the right-hand card describing the three-sentence draft.
* **Impact.** A new user must infer that a product must exist before a draft is grounded, that a model must be configured, and where Leads/History fit. Time to first value depends entirely on the person already understanding the product.
* **Status.** Absent. **Severity High (CX-001).** Fix: a first-run checklist (model ready? product added? first draft?) that is dismissible and per-surface-aware.

## J3. Configure an AI provider and select a model

* **Desktop / extension.** Settings > Model: choose among nine providers (`lib/providers.js`), enter a key if needed, pick a model. Verified by `T:settings`, `T:provider`, `T:e2e` (desktop UI). Keys: desktop OS keychain-encrypted when available, else a 0600 file; extension `chrome.storage.local`, **not encrypted** (labelled in the UI).
* **Hosted web.** The server owns the provider (`ANTHROPIC_API_KEY` etc.). With none, a visitor sees a disabled **Generate draft** and, below it: "This site has no model yet: whoever runs it adds a provider key on the server (the Cold desktop app can supply one instead; see Settings)." (R5, [`screenshots/07-write-no-model-configured.png`](screenshots/07-write-no-model-configured.png)). Settings is unavailable on a hosted server by design. A visitor who is not the operator has no way forward.
* **Self-hosted web.** The path is `.env` plus a restart, documented only in the README.
* **Failure states.** Provider errors are shown with retry; inputs are kept (`T:e2e` "failure keeps inputs and offers a nontechnical retry that works").
* **Not verified.** Any real provider call: all tests use a canned model.
* **Severity / fix.** Medium (CX-002): when generation is unavailable, put the message next to the button and say who can fix it; offer the desktop app as the route for individuals.

## J4. Add or manage product knowledge

* **Flow.** Either type the product inline on Write (first run: "saved to Knowledge, so you only enter it once") or Knowledge > Add. Fields: what it does, audience, problem, proof points (claim/evidence/type/strength/use-externally), facts, approved language, do-not-say.
* **Data.** `products` store; only external-use proof is sent to a model (`T:e2e` "internal-only proof is never sent to the model").
* **Verification.** Verified on all surfaces through shared screens: `T:e2e` (Knowledge tests, unsaved edits survive navigation, storage-full fails loudly), `T:sqlite-store`, `T:extension`.
* **Gap.** Leads reference a product by name string (OPP-001): rename/delete breaks the link silently.

## J5. Import an existing lead CSV using the template

* **Flow.** Leads > Download template (`cold-leads-template.csv`, byte-equal to the repo's `examples/leads-template.csv`: `T:leads`) → fill → Import CSV → **Review** (nothing saved) → *Add N leads*.
* **Review panel** states, in words: rows read, new, already-in-leads/repeated, can't-be-imported; options for duplicates and a default list name; expandable lists for invalid rows (with line numbers), "imported but check these", skipped duplicates (R2, [`screenshots/03-leads-import-mapper.png`](screenshots/03-leads-import-mapper.png)).
* **Data.** Creates `leads` rows with `source: "csv"`.
* **Evidence.** `T:leads` (parser: BOM, CRLF/LF, `,;\t`, quoted newlines, unterminated quote error), `T:e2e` (preview, commit, same file again → 0 new, 5,000-row file in one save).
* **Real-world finding.** The reporter's file `cold-leads-100.csv` (100 rows, all `leadN@example.com`) imported **nothing**: every `@example.com` address was treated as a template sample. Fixed earlier in this branch (`31c1ad4`); only the template's exact three sample addresses are skipped now.
* **Status.** Verified. No open defect.

## J6. Map existing columns to Cold's fields

* **Flow.** The review panel's *Match your columns* lists each column with an example value and a choice: Don't import · a Cold field · First/Last name · an existing or new **extra field**. The preview re-counts as you change a column; the mapper stays open while you edit.
* **Defect found by this audit and fixed (CX-005).** For a file with `Who, Employer, Mail, Lead score`, no name column was recognised so *no* column was auto-matched: `Employer` and `Mail` (both known aliases) were left as "Don't import" (R2: [`screenshots/03b-…-BEFORE-fix.png`](screenshots/03b-leads-import-mapper-BEFORE-fix.png); the current behaviour is [`03-leads-import-mapper.png`](screenshots/03-leads-import-mapper.png), where only `Lead score` is left unmatched). Now recognised columns are matched even when the name must be chosen by hand (`T:leads` assertion added).
* **Verification.** `T:leads`, `T:e2e` "map any file layout…", axe clean (R7).
* **Gap.** The mapping is not remembered for the next file (OPP-002). At narrow widths the mapper table (three columns) was not inspected (CX-007, Hypothesis).

## J7. Review validation; recover from malformed or duplicate records

* **Malformed file.** Unterminated quote → a message naming the line; non-text file → "doesn't look like a text CSV"; over 2 MB or 5,000 rows → message with the limit. All leave the app unchanged (`T:leads`).
* **Bad rows.** No name → listed with the line number and reason, others still import. Odd email, non-LinkedIn/X profile link, unknown goal → imported with a warning and the field blanked where appropriate.
* **Duplicates.** Key = email, else canonical profile link, else name+company; "leave as is" (default) or "fill blank fields". Importing the same file twice adds nothing (`T:e2e`).
* **Failure during save.** On the desktop the import is a sequence of writes (`src/services/sqliteDb.js` `setMany`); a failure part-way keeps what was saved and re-reads the database so the screen shows the truth. Retrying is safe because ids and keys deduplicate. Not a single transaction (DATA-010, Low).
* **Status.** Verified.

## J8. Connect Google Sheets and select it as the source of truth

* **Flow** (Settings > Google Sheets, [`05`](screenshots/05-settings-google-sheets-offer.png) / [`06`](screenshots/06-settings-google-sheets-move-step.png)): *Set up* → **1 Connect Google** (one scope, `drive.file`) → **2 Choose** a new sheet or one Cold already made → **3 Move what you have** (optional copy; nothing in the sheet is overwritten) → *Finish* → reload; afterwards leads and outreach are read from and written to the sheet.
* **What is real.** The flow, the API calls, the row mapping and the failure handling run for real against a stand-in Sheets API and, for sign-in, a fake Google object (web) or stand-in token endpoint (desktop server) or fake `chrome.identity` (extension).
* **What is not.** No real Google account, consent screen, quota, or `drive.file` behaviour was exercised. The feature is **off** in any copy of Cold that has no Google client id (Settings says so).
* **Status.** Partial. **High (DATA-001)** for claiming the feature launch-ready; **Medium (DATA-002):** `drive.file` is granted per OAuth client, so a sheet created from the web client may not be openable from the desktop or extension client (Hypothesis).

## J9. Create, update and verify data in both directions

* **Cold → sheet.** Add/edit/delete a lead or draft writes the row (leads: id in column A; outreach: readable columns plus a full-record `data` column) (`T:sheets`, `T:sheets-e2e`).
* **Sheet → Cold.** A row typed into the sheet gets an id when Cold next reads it; changing `status`, `notes`, `email`, `subject` or `follow_up` on the Outreach tab is honoured; changes appear after **Refresh from the sheet** or within about 20 s (only while the tab is visible).
* **Verify.** *Open in Google Sheets* from Settings.
* **Concurrency.** Before every save Cold re-reads the tab, so rows inserted or moved by someone else are not overwritten. Outreach edits carry a version and are merged field-by-field or refused. **Lead edits carry no version: two devices editing the same lead is last-writer-wins** (characterised by a test: DATA-004).
* **Status.** Partial.

## J10. Use SQL-backed data management

* **Where.** Desktop (and a local install with `COLD_DB_FILE`). Leads are rows in the `leads` table with real columns for name/company/email/list; the JSON in `data` is the record.
* **Probe (R6).** A double write is idempotent; a write based on a stale version is refused with `conflict`; a 700 KB document is refused (413); an invalid id is refused (400); WAL mode and schema v2 confirmed.
* **Gaps.** A hand-corrupted row is silently left out of what the app shows (not deleted) with no warning (DATA-008); there is no in-app backup, restore, or export of products/drafts (DATA-009); the README documents copying the file as the backup.
* **Status.** Verified for the implemented behaviour; Surface-specific.

## J11. Select a lead and produce relevant, personalised outreach

* **Flow.** Leads > **Write** on a lead → Write opens with name, company, role, email, profile link and *why* filled in (and product/goal if set) → Generate (two model calls: draft, then an editor pass) → editable draft with checklist and grounding checks.
* **Evidence.** `T:e2e` "Write on a lead fills the draft from it, and the lead then shows how far outreach has got"; `T:outreach`, `T:decide`.
* **Not evidenced.** Whether drafts are *good* or *relevant* with a real model: every test uses a canned response. The repo's own commercial evaluation (`docs/evaluation/`) and validation package say the same; the validation experiment was prepared and not run. **QUALITY-008, High.**

## J12. Copy an email and understand what happens next

* **Flow.** Write > **Copy email** (or History > Copy). Cold copies the text (with sign-off), records a **handoff** (`handoffs: [{at, how:"copy"}]`), and sets a follow-up date if none exists. The draft stays **Draft** (not "Marked sent"). On the draft, the next-step line reads: "open it in your email app (or copy it) and send it yourself. Cold can't send, and can't see your inbox. Come back and press 'Mark as sent'…".
* **Evidence.** `T:e2e` follow-ups test (copy records a handoff, status unchanged), `T:followup`.
* **Friction (CX-004, Medium).** The follow-up date is announced to screen readers and visible in the *Follow up* section, but nothing tells the user that a "Follow-up due" can appear for a draft they never marked sent (R3, [`screenshots/04-history-follow-up-due.png`](screenshots/04-history-follow-up-due.png)): the filter says **Follow-up due**, the row says **Draft**.

## J13. Hand off to Gmail and verify what Cold can actually know

* **Flow.** Settings > Email app: default mail app, Gmail, Outlook.com or Outlook 365 → **Open in email** opens a pre-filled *unsent* compose window in a new tab (or the OS handler on desktop).
* **What Cold can know: nothing about the outcome.** The messages say so ("Review it and press Send there. Cold hasn't sent anything"; "if nothing opened…"). The link is built by `lib/mailto.js`; the desktop main process accepts only a valid mailto or the exact compose link (`T:desktop-mail`, **not runnable here**).
* **Limits.** Link length caps (2,000 / 6,000 characters) → refused with a pointer to Copy, never truncated. No Gmail API, no send, no tracking: **no Google authorisation is needed or used for this** (distinct from the Sheets feature).
* **Status.** Verified for link construction and honesty of messages; OS handoff on desktop Unverified here.

## J14. Create, inspect, modify and complete a follow-up

* **Create.** On first copy/open (automatic, from Settings defaults: 3 working days, longer for investment/partnership/advice, repeat 7 days, max 3, 09:00, skip weekends), or by hand on a draft.
* **Inspect.** History > *Follow-up due* filter with count; a line on each row; full controls under **Notes & details**; Write shows the same panel.
* **Modify / complete.** Change date/time, **I sent a follow-up** (counts it, schedules the next up to the limit), Snooze 1 day / 1 week, **No follow-up**, **Add to calendar** (.ics). Marking **sent** restarts an automatic date from the send; recording a **reply** stops it.
* **Duplicates.** Repeat copy/open never moves an existing date (`T:followup`).
* **Persistence.** On the record, so it survives restart.
* **Gaps.** No alert when something is due (OPP-003). Verified end-to-end on web only; desktop/extension share the code but have no follow-up test (PARITY-003).

## J15. Resume after restart or switch surfaces

* **Restart.** Verified: reload tests on web; SQLite persistence on desktop (`T:sqlite-store`); replica on extension (`T:extension`).
* **Switching surfaces.** Each surface keeps its own library unless paired with the desktop app (then the desktop SQLite file is the shared library). The footer states where data is kept and that it isn't synced ("Drafts are saved in this browser only…" R1).
* **Interaction with Sheets.** If Sheets is on, leads and drafts live in the sheet and **no longer sync through the hub** (PARITY-002, Medium, Confirmed by code; untested). Two surfaces that both use the same sheet do share leads and drafts, but only if each was set up with that sheet.

## J16. Recover from unavailable providers, lost authorisation, network failures, failed sync

| Failure | What happens (observed in tests) | Gap |
|---|---|---|
| Provider error / outage | Error with plain-language retry; inputs kept; no partial draft saved (`T:e2e`) | none found |
| Hosted server key missing | Disabled button + explanation (R5) | CX-002 |
| Desktop app closed (paired web/extension) | Keeps working on the local copy; catches up on return (`T:e2e`, `T:extension`) | one timing flake (QUALITY-004) |
| Browser storage full / malformed | Fails loudly, nothing reported as saved; unreadable entries kept, not deleted (`T:e2e`) | none found |
| Google sign-in expires | Settings shows the problem and **Reconnect Google**; nothing lost (`T:sheets-e2e`) | none |
| Sheet unreadable at start-up | Leads and History appear **empty**; a banner now says "Couldn't read your Google Sheet…" (added by this audit) | DATA-005 (Medium, mitigated): still no local cache, so no offline use |
| Google rate-limit / 5xx | Retried with backoff (`T:sheets`) | real quotas untested |
| Sheet deleted / not shared with Cold | "wasn't found / isn't one Cold created" | recovery is "set up again" |

## J17. Disconnect an integration and understand the effect on stored data

* **Google Sheets.** *Stop using Google Sheets* → confirmation that says what will happen → everything currently in the sheet is **copied back** into the app's own storage → the sheet link is forgotten → the page reloads. The spreadsheet itself is untouched in Drive. **Defect found and fixed (DATA-003):** this did not forget or revoke the Google authorisation (desktop kept a refresh token in `settings.json`; web kept a "connected" flag). It now signs out and asks Google to revoke (web: Google's `revoke`; desktop: the server's `disconnect` calls Google's revoke endpoint; the extension forgets its flag but does not call a revoke endpoint). Verified by `T:sheets-e2e`.
* **Desktop pairing.** Settings > Cold desktop app > Disconnect: the surface returns to its own library; nothing is sent after disconnect (`T:privacy`, `T:shared-library`).
* **Gaps.** No "erase everything" in any surface (DATA-009).

---

## UX quality review

| Dimension | Assessment | Evidence |
|---|---|---|
| Navigation, terminology | Five clear destinations; consistent verbs. "Marked sent" / "Reply recorded" wording is careful and honest | R1, `T:e2e` |
| Discoverability | Weak for: model setup (below the fold), Google Sheets (bottom of Settings), follow-up settings (bottom of Settings) | R4, R5 |
| Hierarchy / consistency | Consistent components; Settings is one long scroll with 7–8 sections | R4 |
| Steps / decisions | First draft needs: model, product (inline), recipient, why, goal: reasonable; no shortcuts for returning users beyond Leads → Write | R1 |
| Long-running feedback | Generation shows steps and a Stop button (`T:e2e` loading state); Sheets setup shows "Waiting for Google…/Setting up…" | `T:sheets-e2e` |
| Validation / recovery | Strong: one error summary, per-field errors, focus handling, kept inputs | `T:e2e` |
| Destructive actions | Delete confirms; Sheets stop confirms and explains | `T:e2e`, `T:sheets-e2e` |
| Keyboard / semantics | Skip link, focus, reduced motion tested; axe clean on all views and 16 added states | `T:e2e`, R7 |
| Responsive | Existing tests cover "any view; primary workflow" at 375/768/1280 (pass after the regression fix); the mapper table and Sheets steps were not specifically inspected at 375 px | `T:e2e`; CX-007 |
| Trust / privacy | Unusually explicit ("Cold never sends anything", where data lives, what leaves). Was **incorrect** once Sheets existed; corrected | SEC-006 |
| UI promise vs backend | Honest on send/reply. One gap: "Follow-up due" for unsent drafts (CX-004). Fixed: History intro read "History are saved…" ([before](screenshots/04b-history-follow-up-due-BEFORE-copy-fix.png)); footer/Settings omitted leads | CX-006, CX-008 |

**Highest-friction workflows (materially obstructive):** first-run orientation (CX-001), the hosted-web no-model dead end (CX-002), getting from "I have a CSV" to "I have drafts" is fine once found. Everything else observed is polish.
