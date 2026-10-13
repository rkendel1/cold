// Settings > Your data: export, restore and erase. Three separate, explicit actions. Nothing here runs by itself, and no message says "done" unless the storage
// read back as expected (see services/dataLifecycle.js and store.eraseLocalData).
import { h, clear, append } from "../components/dom.js";
import { button, notice, toast, announce } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import { makeExport, reviewFile, applyRestore } from "../services/dataLifecycle.js";
import { totalRecords, MAX_FILE_BYTES, KINDS } from "../domain/dataExport.js";

const NAME = { products: ["product", "products"], emails: ["draft", "drafts"], leads: ["lead", "leads"] };
const plural = (n, k) => `${n} ${NAME[k][n === 1 ? 0 : 1]}`;
const countsText = c => KINDS.filter(k => c[k]).map(k => plural(c[k], k)).join(", ") || "nothing";

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** The erase confirmation: says what will go, what will not, and needs the word typed. Resolves true only on an explicit, typed confirmation. */
function eraseDialog({ goes, stays }) {
  return new Promise(resolve => {
    const word = h("input", { type: "text", id: "eraseWord", autocomplete: "off", "aria-describedby": "eraseWordHint" });
    const go = h("button", { type: "submit", value: "ok", class: "btn danger-solid", id: "eraseConfirm", disabled: true }, "Erase my data");
    word.addEventListener("input", () => { go.disabled = word.value.trim().toLowerCase() !== "erase"; });
    const dlg = h("dialog", { "aria-labelledby": "dlg-title", class: "dialog", id: "eraseDialog" },
      h("form", { method: "dialog", class: "dialog-body" },
        h("h2", { id: "dlg-title" }, "Erase your Cold data on this device?"),
        h("p", {}, h("strong", {}, "This permanently deletes:")), h("ul", { class: "plain" }, goes.map(g => h("li", {}, g))),
        h("p", {}, h("strong", {}, "This does not touch:")), h("ul", { class: "plain" }, stays.map(g => h("li", {}, g))),
        h("p", { class: "hint", id: "eraseWordHint" }, "It can't be undone from inside Cold. Export first if you may want it back. Type ", h("strong", {}, "erase"), " to confirm."),
        h("label", { for: "eraseWord" }, "Type the word erase"), word,
        h("div", { class: "dialog-actions" }, h("button", { type: "submit", value: "cancel", class: "btn ghost", id: "eraseCancel" }, "Cancel"), go)));
    dlg.addEventListener("close", () => { const ok = dlg.returnValue === "ok" && word.value.trim().toLowerCase() === "erase"; dlg.remove(); resolve(ok); });
    document.body.append(dlg); dlg.showModal(); dlg.querySelector("#eraseCancel").focus();
  });
}

export function mountDataPortability({ store }) {
  const S = store.state;
  const host = h("div", { class: "form data-portability", id: "dataPortability" });
  const exportMsg = h("p", { class: "hint", role: "status", id: "exportMsg" });
  const restoreHost = h("div", { id: "restorePanel", "aria-live": "polite" });
  const eraseHost = h("div", { id: "erasePanel", "aria-live": "polite" });
  const fileIn = h("input", { type: "file", id: "restoreFile", accept: ".json,application/json", hidden: true, "aria-label": "Choose a Cold export file to restore" });
  let text = "", fileName = "", mode = "add";

  /* ---------- export ---------- */
  function doExport() {
    clear(exportMsg); exportMsg.className = "hint";
    try {
      const out = makeExport(store);
      if (!totalRecords(out.counts)) { exportMsg.textContent = "There's nothing to export yet: you have no products, drafts or leads."; return; }
      download(out.filename, out.text);
      exportMsg.textContent = `Exported ${countsText(out.counts)} to “${out.filename}”. Your browser saves it wherever it saves downloads; Cold can't see where. It contains your leads and drafts but no keys or passwords: keep it private.`;
      announce("Export created");
    } catch (e) { exportMsg.className = "hint bad-text"; exportMsg.textContent = `Couldn't create the export, so no file was made. ${e && e.message ? e.message : ""}`.trim(); }
  }

  /* ---------- restore ---------- */
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files && fileIn.files[0]; fileIn.value = ""; if (!f) return;
    fileName = f.name; mode = "add"; text = "";
    if (f.size > MAX_FILE_BYTES) return showProblems(["The file is too large to be a Cold export."]);
    try { text = await f.text(); } catch { return showProblems(["Couldn't read that file."]); }
    review();
  });
  function showProblems(errors, warnings = []) {
    append(clear(restoreHost), [h("h3", {}, `Can't restore ${fileName}`), notice("bad", h("ul", { class: "plain" }, errors.map(e => h("li", {}, e)))), h("p", { class: "hint" }, "Nothing was changed."),
      h("div", { class: "actions" }, button("Close", { kind: "ghost", id: "restoreClose", onclick: () => clear(restoreHost) }))]);
    announce("That file can't be restored. Nothing was changed.");
  }
  function review() {
    const r = reviewFile(store, text, { mode });
    if (!r.ok) return showProblems(r.errors);
    const p = r.plan, replace = mode === "replace", can = store.canErase();
    const list = (title, items) => (items.length ? h("details", { class: "panel" }, h("summary", {}, `${title} (${items.length})`), h("ul", { class: "plain" }, items.slice(0, 15).map(i => h("li", {}, i)), items.length > 15 ? h("li", { class: "hint" }, `…and ${items.length - 15} more`) : null)) : null);
    const radio = (v, label, hint, off) => h("label", { class: "choice" }, h("input", { type: "radio", name: "restoreMode", value: v, checked: mode === v, disabled: !!off, onchange: () => { mode = v; review(); } }), h("span", {}, h("strong", {}, label), h("span", { class: "hint block" }, off || hint)));
    const label = replace ? (p.changes ? "Replace my library" : "Nothing to change") : (p.changes ? `Add ${totalRecords(p.counts.add)} item${totalRecords(p.counts.add) === 1 ? "" : "s"}` : "Nothing new to add");
    append(clear(restoreHost), [h("h3", {}, `Restore ${fileName}`),
      h("p", { id: "restoreSummary" }, `This file has ${countsText(r.file.counts)}, exported ${String(r.file.exportedAt || "").slice(0, 10) || "on an unknown date"}${r.file.source ? ` from ${r.file.source}` : ""}.`),
      r.warnings.length ? notice("warn", r.warnings.map(w => h("p", {}, w))) : null,
      radio("add", "Add what's new (keeps everything you have)", "Adds records whose id isn't here yet. Anything already here is kept as it is, never overwritten."),
      radio("replace", "Replace my library with this file", "Deletes what isn't in the file and makes your library match it. Needs confirmation.", can.ok ? "" : can.message),
      h("p", { id: "restorePlan" }, replace
        ? `Will write ${countsText(p.counts.add)} and delete ${countsText(p.counts.remove)} that ${totalRecords(p.counts.remove) === 1 ? "isn't" : "aren't"} in the file. Your saved sign-off and preferences are replaced by the file's.`
        : `Will add ${countsText(p.counts.add)}. ${totalRecords(p.counts.same)} already here (identical), ${p.counts.conflicts} kept your version (same id, different content), ${p.counts.duplicatePeople} skipped as someone you already have.`),
      replace ? list("Will be deleted", p.remove.products.concat(p.remove.emails, p.remove.leads).map(x => x.label)) : null,
      list("Kept your version", p.conflicts.map(x => `${NAME[x.kind][0]}: ${x.label}`)), list("Skipped: already in your leads", p.duplicatePeople.map(x => x.label)),
      h("div", { class: "actions" }, button(label, { kind: replace ? "danger-solid" : "primary", id: "restoreGo", disabled: !p.changes && !(replace && p.settings), onclick: () => run(p) }), button("Cancel", { kind: "ghost", id: "restoreCancel", onclick: () => { clear(restoreHost); text = ""; } }))]);
  }
  async function run(plan) {
    const go = restoreHost.querySelector("#restoreGo"); if (go) go.disabled = true;
    try {
      if (plan.mode === "replace") {
        const ok = await confirmDialog({ title: "Replace your library with this file?", danger: true, confirmLabel: "Replace my library",
          body: `This deletes ${countsText(plan.counts.remove)} that aren't in the file and replaces the rest with the file's. Before it does, Cold downloads a backup of what you have now.` });
        if (!ok) { if (go) go.disabled = false; return; }
        const cur = makeExport(store);                                  // a safety backup; if it can't be made, nothing is replaced
        if (totalRecords(cur.counts)) download(`cold-backup-before-restore-${cur.filename.slice(12)}`, cur.text);
      }
      const done = await applyRestore(store, plan);
      append(clear(restoreHost), [h("h3", {}, "Restored"), notice("good", h("p", { id: "restoreResult" },
        done.mode === "replace" ? `Your library now matches ${fileName}: wrote ${countsText(done.added)}, deleted ${countsText(done.removed)}. Checked: every record was read back.`
          : `Added ${countsText(done.added)}. ${totalRecords(done.same)} were already here, ${done.conflicts} kept your version, ${done.duplicatePeople} skipped as duplicates. Checked: every added record was read back.`)),
        h("div", { class: "actions" }, button("Close", { kind: "ghost", id: "restoreClose", onclick: () => clear(restoreHost) }))]);
      toast("Restore finished"); announce("Restore finished and checked");
    } catch (e) {
      append(clear(restoreHost), [h("h3", {}, e && e.code === "restore_failed" ? "The restore failed" : "Can't restore"), notice("bad", h("p", { id: "restoreResult" }, e && e.message ? e.message : "Something went wrong and Cold could not confirm what was saved. Check your drafts and leads.")),
        h("div", { class: "actions" }, button("Close", { kind: "ghost", id: "restoreClose", onclick: () => clear(restoreHost) }))]);
      announce("The restore did not complete");
    }
  }

  /* ---------- erase ---------- */
  const where = S.surface === "extension" ? "this extension's storage" : S.backend === "sqlite" ? "the Cold desktop app on this computer" : "this browser";
  function eraseScope() {
    const c = { products: S.products.length, emails: S.emails.length, leads: S.leads.length };
    return {
      goes: [`Your ${plural(c.products, "products")}, ${plural(c.emails, "emails")} and ${plural(c.leads, "leads")}, in ${where}.`, "Your saved sign-off, email-app choice and follow-up settings, and the unsent Write form.", "Anything waiting to sync.",
        ...(S.backend === "sqlite" ? ["The old browser copy inside the desktop app, if there is one. The database file is compacted so deleted content isn't left behind in it."] : [])],
      stays: ["Your connection to the Cold desktop app, your provider keys, and the extension's pairing.", "Google sign-in and anything in Google Drive or Sheets.", "Exports and backups you made, copies of the database file, and browser or operating-system backups.", "Other libraries (for example the desktop app's, when this one is a standalone copy), and email you have sent."],
    };
  }
  async function doErase() {
    if (!(await eraseDialog(eraseScope()))) return;
    try {
      const gone = await store.eraseLocalData();
      append(clear(eraseHost), [notice("good", h("p", { id: "eraseResult" }, `Erased ${countsText(gone)} and the saved settings on this device. Cold checked that nothing was left. Reload Cold to start fresh.`)),
        h("div", { class: "actions" }, button("Reload Cold", { kind: "primary", id: "eraseReload", onclick: () => globalThis.location.reload() }))]);
      announce("Your data was erased");
    } catch (e) {
      append(clear(eraseHost), [notice("bad", h("p", { id: "eraseResult", role: "alert" }, `${(e && e.message) || "Cold couldn't erase your data."} Don't treat it as erased: some of it may still be stored. You can try again, or follow the manual steps in docs/troubleshooting.md.`))]);
      announce("Erasing did not finish");
    }
  }
  function paintErase() {
    const can = store.canErase();
    append(clear(eraseHost), can.ok ? [] : [h("p", { class: "hint", id: "eraseUnavailable" }, can.message)]);
    eraseBtn.disabled = !can.ok;
  }
  const eraseBtn = button("Erase my data on this device…", { kind: "ghost danger", id: "eraseBtn", onclick: doErase });
  store.subscribe(t => { if (t === "ready" || t === "settings") { if (!eraseHost.querySelector("#eraseResult")) paintErase(); } });

  append(host, [
    h("h3", {}, "Back up, restore and erase"),
    h("p", { class: "hint" }, "Export your products, drafts and leads as one file you can keep or move. It never includes provider keys, tokens or passwords. Restoring checks the whole file first and never overwrites what you have unless you choose Replace and confirm."),
    h("div", { class: "actions" }, button("Export my data", { kind: "primary", id: "exportBtn2", onclick: doExport }), button("Restore from an export…", { id: "restoreBtn", onclick: () => fileIn.click() }), eraseBtn),
    exportMsg, fileIn, restoreHost, eraseHost]);
  paintErase();
  return host;
}
