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

## Remaining duplication, and why

* **`lib/db.js` repeats the version rules** (`versionOf`, stale check, strictly-newer stamp, about ten lines) because it is a
  CommonJS module in a package that ships `lib/` but not `src/`; importing the ES-module contract would need a packaging change.
  `test/library-parity.test.js` pins it to the shared functions so it cannot drift.
* **SQL ordering** (`ORDER BY created_at DESC`, `position, name`) mirrors `compareEmails`/`compareProducts` because SQLite sorts
  and limits in the query. The parity test checks the resulting order.
* **The two retry loops** (`sqliteDb.js` `put`, `replica.js` `push`) differ in transport (one request vs an outbox with deletes and
  first-contact rules); both call the same merge. Merging them would need a transport abstraction, which this change avoids.
* **Settings and compose-form storage** are not part of the library contract and keep their own simple per-surface storage.
