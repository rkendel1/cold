// Export, restore and the review before a restore, on top of the store. The store holds the data; domain/dataExport.js decides what a file means and what a
// restore would do; this module applies it with the store's own save and delete paths (so every storage backend behaves as it does for any other save).
//
// A restore is NOT one transaction on every backend, so it is made safe in three ways: the whole file is validated and planned before anything is written; the
// previous state of everything it will touch is kept in memory; and if any step fails, or the result doesn't verify, the touched records are put back and
// that is checked too. If even the put-back can't be confirmed, the error says so (and the screen points to the backup it downloaded first).
import { buildExport, exportText, exportFilename, parseExport, planRestore, verifyRestore, sameRecord, KINDS, totalRecords } from "../domain/dataExport.js";
import { leadKey } from "../domain/leads.js";

const clone = v => JSON.parse(JSON.stringify(v));
/** What the library holds right now, as plain data. */
export const currentLibrary = store => ({ products: clone(store.state.products), emails: clone(store.state.emails), leads: clone(store.state.leads), settings: clone(store.state.settings) });
const surfaceOf = store => (store.state.surface === "extension" ? "extension" : store.state.backend === "hosted" ? "hosted" : store.state.backend === "sqlite" ? "desktop" : "web");

/** The export for what Cold holds now: { file, text, filename, counts }. Throws (code "export_invalid") rather than hand back a file that fails its own check. */
export function makeExport(store, now = new Date()) {
  const file = buildExport(currentLibrary(store), { now, surface: surfaceOf(store) });
  return { file, text: exportText(file), filename: exportFilename(now), counts: file.counts };
}

/** Read and check a chosen file, and plan what restoring it would do in `mode`. Nothing is written. */
export function reviewFile(store, text, { mode = "add", size } = {}) {
  const parsed = parseExport(text, size === undefined ? {} : { size });
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: parsed.warnings };
  const plan = planRestore(parsed.file, currentLibrary(store), { mode, leadKey });
  return { ok: true, file: parsed.file, plan, warnings: parsed.warnings };
}

/** Put back exactly what was there before a failed restore, and check that it worked. */
async function rollback(store, before, plan) {
  try {
    for (const kind of KINDS) {
      const had = new Map(before[kind].map(r => [r.id, r]));
      const created = plan.add[kind].filter(r => !had.has(r.id)).map(r => r.id);
      const restore = [...plan.add[kind].filter(r => had.has(r.id)).map(r => had.get(r.id)), ...plan.remove[kind].map(r => had.get(r.id)).filter(Boolean)];
      if (created.length) await store.deleteRecords(kind, created);
      if (restore.length) await store.saveRecords(kind, restore);
    }
    if (plan.settings) await store.saveSettings(before.settings);
    const now = currentLibrary(store);
    return { ok: KINDS.every(kind => now[kind].length === before[kind].length && before[kind].every(r => { const g = now[kind].find(x => x.id === r.id); return g && sameRecord(g, r); })) };
  } catch { return { ok: false }; }
}

/**
 * Apply a plan from reviewFile. Resolves { ok: true, added, same, conflicts, ... } only after the result verifies; rejects with
 * { code: "restore_failed", rolledBack, message } otherwise, or { code: "not_supported" } for a replace that this library can't safely do.
 */
export async function applyRestore(store, plan) {
  if (plan.mode === "replace") { const can = store.canErase(); if (!can.ok) throw { code: "not_supported", message: can.message }; }
  const result = () => ({ ok: true, mode: plan.mode, added: plan.counts.add, same: plan.counts.same, removed: plan.counts.remove, conflicts: plan.counts.conflicts, duplicatePeople: plan.counts.duplicatePeople, checked: totalRecords(plan.counts.add) });
  if (plan.changes === 0 && !plan.settings) return result();
  const before = currentLibrary(store);
  try {
    for (const kind of ["products", "leads", "emails"]) if (plan.add[kind].length) await store.saveRecords(kind, plan.add[kind]);
    if (plan.settings) await store.saveSettings(plan.settings);
    for (const kind of ["emails", "leads", "products"]) if (plan.remove[kind].length) await store.deleteRecords(kind, plan.remove[kind].map(r => r.id));
    const problems = verifyRestore(plan, currentLibrary(store));
    if (problems.length) throw Object.assign(new Error("verification failed"), { problems });
  } catch (e) {
    const back = await rollback(store, before, plan);
    throw { code: "restore_failed", rolledBack: back.ok, message: back.ok ? "The restore failed, and your library has been put back exactly as it was." : "The restore failed and Cold could not confirm that your library is exactly as it was. Check your drafts and leads, and use the backup downloaded before the restore.", cause: e && (e.message || e.code) };
  }
  return result();
}
