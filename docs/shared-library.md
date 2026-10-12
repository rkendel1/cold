# Sharing one local library through Cold Desktop

Web and the extension can work in the **same library as Cold Desktop** on the same computer. It is a choice: each surface works fully
without it, and nothing is copied, merged or deleted unless the user asks.

## Audit (what existed, what was wrong)

| Question | Finding |
| --- | --- |
| Does the desktop service expose every library operation the shared contract needs? | Yes: `GET /api/data` (snapshot, version, ping) and `PUT`/`DELETE /api/data/{products,emails}/:id` with the optional `?base=<version>` check, answering 409 with the stored record. No new endpoint was needed. |
| Authentication and origins | Pairing code as a bearer token (a request that presents a code must present the right one); web pages additionally need to be on the app's "Allowed web apps" list for CORS; the extension is recognised by its code. Settings and provider keys are refused to code holders. All unchanged. |
| Does the database leave the app? | No. The browser only ever sees JSON records through those routes; the SQLite file is not served on any path (tested). |
| How did web/extension choose local vs paired storage? | They always used one local replica; pairing attached it to the app. On first contact the replica **pushed every record that existed only locally** and then merged both ways, so connecting silently merged two libraries into one. That is what this change removes. |
| Versions, conflicts, deletes, retries | Already in the replica + `saveWithMerge` (docs/library-contract.md): version-checked writes, field merge, a persisted conflict list, offline outbox, conditional deletes. Reused as is. |

## Behaviour

| | Standalone (default) | Shared with Cold Desktop |
| --- | --- | --- |
| Where records live | this browser / extension (unchanged keys) | the desktop SQLite is authoritative; this surface holds a working copy in its own storage keys, **per desktop address**, and syncs with the app |
| When the app is closed | n/a | startup, drafting, editing and history work on the working copy; changes wait (Settings shows how many) and sync when the app returns, using the usual version checks; a clash keeps the app's version and sets the surface's edit aside for review |
| Reaches the desktop library | never | yes, through the existing routes |
| Shown in Settings | "Library in use: this browser's own library. It is not shared" and "Syncing is off" | "Library in use: the Cold Desktop library…" plus pending changes and last sync |

* **Connecting** (address + pairing code, as before) makes the Cold Desktop library the active one. The text above the button says that
  the existing library stays as it is and nothing is copied unless chosen.
* **Switching** between the two libraries is a confirmed action in Settings and only changes which one is shown. The other is not
  written to, merged or deleted (tested byte for byte).
* **Copying** the standalone library into the shared one is a separate button. It first shows what will be copied (counts and names)
  and what is already there and will be left alone; it adds records the shared library does not have and never overwrites one that
  exists. The standalone library is not changed.
* **Disconnecting** forgets the pairing and returns to the standalone library; the shared working copy stays in storage untouched.
* A pairing made **before this change** keeps working as before (the standalone library kept in sync) and is labelled that way.

Code: `src/services/libraries.js` (which library is active, kept with the pairing), `replica.js` (`pushLocalFirst: false` for the
shared copy), `store.switchLibrary`, Settings. All record rules still come from `src/domain/library.js`.

## Tests

`test/shared-library.test.js` (web ⇄ desktop both ways including status, notes, create, delete; desktop closed at startup, offline
edits, merge, clash and restore; switching and copying without loss; old pairings; the SQLite file and keys never exposed),
the extension case in `test/extension.test.js`, and the updated pairing tests in `e2e`, `extension` and `privacy`.

## Limitations

* The working copy follows the app by polling (a few seconds), not instantly, and requires the app to be running at its pairing address.
* One shared working copy per desktop address. Disconnecting does not delete it, and there is no button to discard it.
* Copying is all-or-nothing for the standalone library; it matches by id and never merges two records that share an id (it skips them).
* Provider keys never enter library records or responses; the working copy is stored unencrypted like any browser storage.
* Pairings made before this change were already merged by the old behaviour; that cannot be undone, only labelled.
