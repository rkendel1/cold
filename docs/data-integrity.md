# Outreach data integrity across surfaces

Core invariant: **a local edit must not silently destroy information the editing client does not understand, or overwrite a newer
record without detecting the conflict.** This note records the audit, the (small) change that enforces it, and what is still not
covered.

## Audit: where a one-record change became a whole-list write, and where data was lost

| Path | Before | Now |
| --- | --- | --- |
| `statusOf` (`src/domain/outreach.js`) | any unrecognised status read as `draft` | missing status → `draft` (legacy default); unrecognised → `unknown` |
| `normalizeEmail` (`src/state/storage.js`), run on every load | rewrote an unrecognised status to `draft`; rebuilt `recipient` and `sentCopy` from known keys only, dropping others | keeps the status as stored; keeps unknown keys inside `recipient` and `sentCopy` (unknown top-level keys were already kept) |
| Browser `localStorage` (`store.saveEmail/deleteEmail/saveProduct/saveSettings`) | every save wrote the **whole** in-memory emails, products and settings lists, so a stale tab erased other tabs' records, and entries the client could not read were dropped | a save re-reads the stored list and changes only its own record; products/settings saves write only their own key; unreadable entries stay in storage |
| Desktop SQLite (`lib/db.js`, `PUT/DELETE /api/data/:kind/:id`) | per-record upsert, but unconditional: last writer won | optional `?base=<updatedAt\|new>`: written only if the stored record is still at that version, else **409** with the stored record. The server assigns a strictly increasing `updatedAt` |
| SQLite client (`src/services/sqliteDb.js`) | optimistic write, no version | sends the version it was based on; on 409 merges different-field changes and retries, otherwise throws a `conflict` error and shows the stored record |
| Replica: web (paired) and extension (`src/services/replica.js`) | whole copy persisted on every change from memory; sync check-then-write was racy; if the hub had a newer copy the local edit was **silently dropped** | each change starts from what storage holds now, one at a time; each hub write names the version it saw (409 → merge/retry); an edit that cannot be merged is kept in `conflicts` (persisted) instead of discarded |
| Replica outbox handling | `data.outbox = remain` could drop a change queued while a sync ran | only entries actually sent are removed |
| Web replica adapter (`replicaStorage.js`) | rewrote both lists from memory, dropping unreadable entries | keeps unreadable entries; persists `conflicts` |

Unchanged on purpose: the storage formats and keys, the SQLite schema, the pairing/permission model, the extension permissions
and manifest, and the endpoint set (the existing routes accept an optional query parameter). Status transitions still happen only
in `applyStatus`, from an explicit user action; opening an email or copying text never changes status.

## The mechanism

* **Version** = the record's existing `updatedAt`. Stores assign a strictly newer value on every conditional save.
* **A save names the version it was based on** (`e.updatedAt`, or the copy the client last saw; `null` for a new record).
* If the stored record is still at that version the save is written. If not, `mergeRecords(base, mine, theirs)`
  (`src/domain/outreach.js`) decides per field: changed on one side only → take that change; changed identically → fine;
  changed **differently** → conflict. `sentCopy` is one unit, so a sent snapshot is never mixed from two copies. `recipient` is
  merged key by key.
* On conflict nothing is written. The caller gets `{ code: "conflict", conflicts, mine, current }`, so the user's edit is
  recoverable and the stored record is intact. History keeps the user's note/address text in its box and says why it was not
  saved; the draft pane keeps the edit on screen and says so. The replica keeps the set-aside edit under Settings → Cold desktop
  app, with "Use my version" (a deliberate new edit) and "Dismiss".
* Scenarios this separates: a note on record A while another surface edits record B (both kept); a note while another surface
  marks the same record replied (merged: replied stays, the note is added); the same note edited in two places (conflict);
  a stale draft trying to set `sent` over `replied`, or to drop a newer `sentCopy` (status conflict / the stored value wins).

## Which paths are protected

* Web, browser `localStorage` (no desktop app): record-level read-modify-write with the version check.
* Web served by the desktop database, and the desktop app itself: server-enforced version check (409) + client merge.
* Web (paired) and extension replica ↔ desktop app: version-checked pushes, merge, persisted conflict list.
* Unknown statuses and unfamiliar fields: preserved through load, edit, save, replica storage, sync and the SQLite JSON column.

Tests: `test/outreach-integrity.test.js` (real stores; two tabs on one storage; two windows on the real server and SQLite file;
the real replica syncing with that server; the web storage adapter), `test/e2e.test.js` (History with an unknown status).

## Limitations (not claimed as solved)

* **Unversioned writes are still accepted.** A client that sends no `?base=` (an older web/extension build, or any custom
  caller) writes unconditionally, so the guarantee applies to clients that send versions. This keeps the shared contract
  compatible; making the version mandatory would break older paired extensions.
* **`localStorage` has no cross-tab lock.** The read-modify-write is synchronous inside one tab, but two tabs can still interleave
  between a read and a write in the same instant. `chrome.storage.local` is likewise read-then-write. Both are narrow windows,
  not transactions. Tabs also do not live-refresh; a stale tab finds out on its next save (which is then merged or refused).
* **Products, settings and the compose form are not versioned.** Products still sync through the same replica path (so they
  get the same conflict handling there), but the in-browser product list and settings are whole-value, last-writer-wins.
* **Compatibility defaults remain.** A save may add the established defaults for missing optional fields (e.g. `note: ""`,
  `goal: "advice"`, empty `checks`), as before; present valid values are never overwritten. A known field with an unusable type
  (e.g. `checks` that is not an array, or a `sentCopy` that is not an object) is still repaired on load as before.
* **Deleting from `localStorage` is not version-checked** (delete against the desktop database and the replica is).
* **Whole-record conflicts in the draft pane are coarse.** The pane reports a conflict and keeps the edit on screen; it does not
  offer a per-field merge. History keeps note/address text only.
* **An unreadable (non-JSON) emails list is still replaced by the first save**, as before; entries inside a readable list that
  cannot be read are now kept.
* A field removed on one side counts as a change on that side. The set-aside list keeps the 50 most recent conflicts.
