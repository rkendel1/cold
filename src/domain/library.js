// The one library contract: the rules every surface applies when it reads, saves or deletes a product or a draft, whatever it
// stores them in. Storage adapters (browser storage in store.js / replicaStorage.js, extension storage, the replica's outbox, the
// desktop app's SQLite behind the server) call these functions and keep only what is specific to their medium: how bytes are read and
// written. The record formats and the paired-sync protocol are unchanged; see docs/library-contract.md.
//
// Rules covered here: record version (`updatedAt`), what version an edit was based on, whether a save may overwrite what is stored
// (merge different fields, refuse the same field), how a saved record is stamped, and how lists are ordered. Status transitions,
// timestamps and the sent snapshot stay in domain/outreach.js (`applyStatus`), which these functions never bypass.
import { versionOf, nextVersion, mergeRecords, reconcileSave, conflictError } from "./outreach.js";

export { versionOf, nextVersion, mergeRecords, conflictError };

export const LIBRARY_KINDS = ["products", "emails"];

/** Newest draft first; products by their own order, then name. (SQLite orders the same way in SQL: see lib/db.js.) */
export const compareEmails = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
export const compareProducts = (a, b) => (a.order ?? 99) - (b.order ?? 99) || String(a.name).localeCompare(String(b.name));

/**
 * What a save is based on. `rec` is the record being saved, `seen` the copy this client last read (if any).
 * `expected` is the version the edit started from (null: a new record); `base` is the copy of that version, when known.
 */
export function saveIntent(rec, seen) {
  const expected = Number.isFinite(rec.updatedAt) ? rec.updatedAt : seen ? versionOf(seen) : null;
  return { expected, base: seen && versionOf(seen) === expected ? seen : null };
}
export const deleteIntent = seen => (seen ? versionOf(seen) : undefined);

/**
 * Decide and stamp one save against what is stored RIGHT NOW. Returns { ok: true, record } with the record to store (id and a new
 * version set), or { ok: false, error } with a `conflict` error and nothing to store.
 */
export function applySave({ id, mine, stored, expected, base = null, now }) {
  const out = reconcileSave({ base, mine, stored, expected });
  if (!out.ok) return out;
  return { ok: true, merged: !!out.merged, record: { ...out.record, id, updatedAt: nextVersion(stored, now) } };
}
