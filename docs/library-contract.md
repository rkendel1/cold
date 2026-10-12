# The library contract: shared in code, shared in data

Cold's **library** is the user's products and drafts (with their notes, statuses, timestamps and sent snapshot). Web, desktop and the
extension each keep it in their own place. What they share is *rules* (code) and, only when paired, *records* (data).

## Shared in code (one implementation)

| Rule | Where |
| --- | --- |
| Status meaning and transitions (`draft → sent → replied`, unknown statuses kept, sent snapshot, no invented send) | `src/domain/outreach.js` (`statusOf`, `applyStatus`) |
| Record shape tolerance: defaults for missing fields, unknown fields kept | `src/state/storage.js` (`normalizeEmail`), `src/domain/knowledge.js` (`normalizeProduct`) |
| Record version (`updatedAt`), what version an edit was based on, whether a save may overwrite what is stored (merge different fields, refuse the same field), how the saved record is stamped | `src/domain/library.js` (`saveIntent`, `applySave`, `deleteIntent`; merge and conflict in `outreach.js`) |
| List order (newest draft first; products by their order, then name) | `src/domain/library.js` (`compareEmails`, `compareProducts`) |
| The query surface the store reads through (`collection().orderBy().limit().onSnapshot()`) | `src/services/collection.js` |
| The store every screen uses: `saveEmail`, `deleteEmail`, `saveProduct`, … | `src/state/store.js` |

## Storage adapters (only what differs by medium)

| Surface | Adapter | What is specific to it |
| --- | --- | --- |
| Web, or any page with no server | `store.js` local branch | reading/writing the raw `cold.emails` list in `localStorage` so other records are left exactly as stored |
| Web (with a Cold server) | `replica.js` + `replicaStorage.js` (`localReplicaStorage`) | the same `localStorage` keys, plus the outbox of changes waiting for a paired app |
| Extension | `replica.js` + `replicaStorage.js` (`chromeReplicaStorage`) | one `chrome.storage.local` key |
| Desktop | `sqliteDb.js` (browser side) + `lib/db.js` (SQLite) | HTTP calls to the local server; SQL columns, WAL, transactions |
| Pairing / sync | `replica.js` `sync`/`push`, `hubLink.js`, `server.js` `/api/data` | the outbox, the version-checked `PUT/DELETE ?base=`, the pairing code |

None of the adapters decides what a status change means, whether a save conflicts, or how a list is ordered; they call the shared
functions above. Adding a surface means writing a storage adapter, not re-implementing the rules.

## Shared in data (only when paired)

Records and their formats are unchanged: the same ids, `updatedAt`, `status`, `sentAt`, `repliedAt`, `sentCopy`, `note` and any
fields a newer or older client added. Surfaces exchange them only through the explicit pairing with the desktop app (see
`docs/standalone-surfaces.md`, `docs/data-integrity.md`, `docs/privacy-and-data-flow.md`). Unpaired surfaces share nothing. There
is no migration: an existing record is read in place and rewritten in place, never transformed.

## What used to be duplicated, and where it lives now

* **Version, stale test, list order:** one definition in `lib/library-rules.cjs`. It is CommonJS under `lib/` so the server
  (`lib/db.js`) and the desktop package can load it, and `src/domain/library.js` re-exports it for the app code and both bundles.
  SQLite no longer sorts: the server returns rows ordered by the same comparators as every other surface.
* **Merge-and-retry on a stale save:** one driver, `saveWithMerge` in `src/domain/library.js`, used by the desktop-database client
  and by the replica's push to the paired app. Each supplies only its `send` and how to recognise "stored record is newer".
* **The query helper** and **save/stamp/intent rules** are in `services/collection.js` and `domain/library.js` as before.

## What is deliberately left

* **Deleting through the replica** (`push` for `delete`) is a single conditional request with its own conflict note; the database
  client's delete goes through its optimistic-write path. They share the version rule, and a retry loop would add nothing for a
  request that either applies or reports the newer record.
* **Settings and the compose form** are not library records and each medium keeps its own one-line storage for them.
* **The `status` column in SQLite** (`'draft'` default) is an index column for people using `sqlite3`; the stored JSON is the record,
  and status meaning stays in `outreach.js`.
