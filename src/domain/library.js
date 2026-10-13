// The one library contract: the rules every surface applies when it reads, saves or deletes a product or a draft, whatever it
// stores them in. Storage adapters (browser storage in store.js / replicaStorage.js, extension storage, the replica's outbox, the
// desktop app's SQLite behind the server) call these functions and keep only what is specific to their medium: how bytes are read and
// written. The record formats and the paired-sync protocol are unchanged; see docs/library-contract.md.
//
// Rules covered here: record version (`updatedAt`), what version an edit was based on, whether a save may overwrite what is stored
// (merge different fields, refuse the same field), how a saved record is stamped, and how lists are ordered. Status transitions,
// timestamps and the sent snapshot stay in domain/outreach.js (`applyStatus`), which these functions never bypass.
import { mergeRecords, reconcileSave, conflictError } from "./outreach.js";
import rules from "../../lib/library-rules.cjs";   // the rules the server shares: version, stale test, list order

export const { versionOf, nextVersion, isStale, compareEmails, compareProducts, compareLeads } = rules;
export { mergeRecords, conflictError };

export const LIBRARY_KINDS = ["products", "emails", "leads"];


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

/**
 * Send one save to a store that can refuse it as stale, merging and retrying when the stored record moved. Every transport (the
 * desktop database over HTTP, the replica pushing to the paired app) uses this, so a stale save is resolved the same way everywhere.
 *  - `send(body, expected)` performs the write for that version and throws if the store reports a newer record;
 *  - `conflictOf(error)` returns that newer stored record from such an error, or null for any other failure (which is rethrown);
 *  - `current` is a stored copy the caller already knows is newer than `base`: merge with it before the first send.
 * Returns { ok: true, value, record } (`record` is what was sent) or { ok: false, error } with a `conflict` error when the same
 * field changed on both sides (or the store kept changing). Nothing is written in the failing case.
 */
export async function saveWithMerge({ send, conflictOf, base = null, mine, expected, current = null, tries = 4 }) {
  let body = mine, exp = expected, was = base, cur = current;
  for (let n = 0; n < tries; n++) {
    if (cur) {
      const m = mergeRecords(was, body, cur);
      if (m.conflicts.length) return { ok: false, error: conflictError(m.conflicts, mine, cur) };
      was = cur; body = m.record; exp = versionOf(cur); cur = null;
    }
    try { return { ok: true, value: await send(body, exp), record: body }; }
    catch (e) { cur = conflictOf(e); if (!cur) throw e; }
  }
  return { ok: false, error: conflictError(["(busy)"], mine, cur) };
}
