// Leads: the people you might write to. Import a CSV (after a review of exactly what will happen), see and edit every lead, write to one
// with a click, export the list, and download the template that shows the columns Cold uses. Same screen on web, desktop and the extension;
// on the desktop app the leads live in the SQLite database.
import { h, clear, append } from "../components/dom.js";
import { button, notice, chip, field, textInput, textArea, toast, announce } from "../components/ui.js";
import { confirmDialog, promptDialog } from "../components/dialog.js";
import { GOALS, STATUS_COPY } from "../domain/constants.js";
import { uid } from "../domain/ids.js";
import { mountFindEmail } from "./findEmail.js";
import { LEAD_FIELDS, MAX_CUSTOM, MAX_IMPORT_BYTES, cleanCustom, customNames, templateCsv, leadsToCsv, planImport, checkLead, leadProgress, filterLeads, canonicalProfile } from "../domain/leads.js";

const PAGE = 100;
/** Adds a hook class (for tests and styles) without losing the button's own classes. */
const tag = (el, cls) => { el.classList.add(cls); return el; };
const PROGRESS_CHIP = { none: ["neutral", "Not contacted"], draft: ["neutral", STATUS_COPY.draft.label], sent: ["accent", STATUS_COPY.sent.label], replied: ["good", STATUS_COPY.replied.label] };

/** Hand a text file to the user. A BOM makes Excel read the accents correctly; Cold's own reader strips it again. */
function download(name, text) {
  const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function mountLeads(root, { store, navigate, platform }) {
  const S = store.state;
  let mapperOpen = null, mapping = null, query = "", listFilter = "all", progressFilter = "all", shown = PAGE, plan = null, planName = "", selected = new Set();

  const fileIn = h("input", { type: "file", id: "leadsFile", accept: ".csv,text/csv,text/plain,.txt", hidden: true, "aria-label": "Choose a CSV file of leads" });
  const search = h("input", { type: "search", id: "leadSearch", "aria-label": "Search leads", placeholder: "Search name, company, email, reason, notes" });
  const listSel = h("select", { id: "leadList", "aria-label": "Filter by list" });
  const progSel = h("select", { id: "leadProgress", "aria-label": "Filter by outreach" },
    [["all", "Everyone"], ["none", "Not contacted"], ["draft", "Draft written"], ["sent", "Marked sent"], ["replied", "Reply recorded"]].map(([v, l]) => h("option", { value: v }, l)));
  const importHost = h("section", { id: "importPanel", class: "card", "aria-live": "polite", hidden: true });
  const editorHost = h("section", { id: "leadEditor", class: "card", hidden: true });
  const tableHost = h("div", { class: "table-wrap" });
  const bulkHost = h("div", { class: "actions", id: "bulkBar", hidden: true });
  const count = h("p", { class: "hint", id: "leadCount", role: "status" });

  root.append(
    h("div", { class: "view-head" }, h("h1", { id: "leads-title", tabindex: "-1" }, "Leads"),
      h("p", { class: "lede" }, "The people you might write to. Import a spreadsheet saved as CSV, or add them one at a time; then write to any of them in a click. Cold only uses what you put here. It looks up an email only when you press Find email on a lead.")),
    h("div", { class: "actions" },
      button("Import CSV", { kind: "primary", id: "importBtn", onclick: () => fileIn.click() }),
      button("Download template", { id: "templateBtn", onclick: () => { download("cold-leads-template.csv", templateCsv()); announce("Template downloaded"); } }),
      button("Export CSV", { id: "exportBtn", onclick: () => { if (!S.leads.length) return toast("There are no leads to export yet."); download("cold-leads.csv", leadsToCsv(S.leads)); } }),
      button("Add lead", { id: "addLeadBtn", onclick: () => edit(null) })),
    fileIn, importHost, editorHost,
    h("div", { class: "hfilters" }, search, listSel, progSel), count, bulkHost, tableHost);

  /* ---------- import: review first, then save ---------- */
  fileIn.addEventListener("change", async () => {
    const file = fileIn.files && fileIn.files[0]; fileIn.value = "";
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return showProblem(file.name, `That file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB. Split it into smaller files.`);
    let text; try { text = await file.text(); } catch { return showProblem(file.name, "Couldn't read that file."); }
    planName = file.name; mapping = null; mapperOpen = null; runPlan(text, { duplicates: "skip", list: file.name.replace(/\.[^.]+$/, "") }, true);
  });
  let sourceText = "";
  function showProblem(name, message) { clear(importHost).append(h("h2", {}, `Can't import ${name}`), notice("bad", h("p", {}, message)), h("div", { class: "actions" }, button("Download the template", { onclick: () => download("cold-leads-template.csv", templateCsv()) }), button("Close", { kind: "ghost", onclick: () => { importHost.hidden = true; } }))); importHost.hidden = false; announce(message); }
  function runPlan(text, opts, fresh) {
    sourceText = text; plan = planImport(text, S.leads, { ...opts, mapping });
    if (!plan.ok && plan.mapping) { mapping = plan.mapping; if (plan.headers) return showMapper(plan.message); }
    if (!plan.ok) return showProblem(planName, plan.message);
    if (!mapping) mapping = plan.mapping;
    const dupSel = h("select", {},
      h("option", { value: "skip" }, "Leave people already in my leads as they are"), h("option", { value: "update" }, "Fill in their blank fields from this file"));
    dupSel.value = opts.duplicates;
    const listIn = h("input", { type: "text", value: opts.list, placeholder: "e.g. Q4 founders" });
    const redo = () => runPlan(sourceText, { duplicates: dupSel.value, list: listIn.value }, false);
    const opts2 = () => ({ duplicates: dupSel.value, list: listIn.value });
    dupSel.addEventListener("change", redo); listIn.addEventListener("change", redo);
    const n = plan.adds.length + plan.updates.length;
    const line = (label, items, fmt) => items.length ? h("details", { class: "panel" }, h("summary", {}, `${label} (${items.length})`), h("ul", { class: "plain" }, items.slice(0, 15).map(fmt), items.length > 15 ? h("li", { class: "hint" }, `…and ${items.length - 15} more`) : null)) : null;
    append(clear(importHost), [
      h("h2", { id: "import-title" }, `Review ${planName}`),
      h("p", { id: "importSummary" }, `${plan.total} row${plan.total === 1 ? "" : "s"} read. `, h("strong", {}, `${plan.adds.length} new`), plan.updates.length ? `, ${plan.updates.length} to update` : "", `, ${plan.duplicates.length + plan.unchanged} already in your leads or repeated, ${plan.invalid.length} can't be imported${plan.examples.length ? `, ${plan.examples.length} sample row${plan.examples.length === 1 ? "" : "s"} from the template skipped` : ""}.`),
      h("p", { class: "hint" }, "Nothing has been saved yet."),
      field({ id: "dupPolicy", label: "If someone is already in your leads", required: null, control: id => { dupSel.id = id; return dupSel; } }),
      field({ id: "importList", label: "List for rows that don't have one", required: null, control: id => { listIn.id = id; return listIn; } }),
      plan.ignored.length ? h("p", { class: "hint" }, `Columns Cold doesn't use were ignored: ${plan.ignored.join(", ")}.`) : null,
      mapperPanel(opts2),
      line("Rows that can't be imported", plan.invalid, x => h("li", {}, `Line ${x.line}: ${x.name}. ${x.reasons.join(" ")}`)),
      line("Imported, but check these", plan.warnings, x => h("li", {}, `Line ${x.line}: ${x.name}. ${x.messages.join(" ")}`)),
      line("Skipped: already there", plan.duplicates, x => h("li", {}, `Line ${x.line}: ${x.name}. ${x.reason}`)),
      line("Will be filled in", plan.updates, x => h("li", {}, `${x.existing.name}: ${x.changed.join(", ")}`)),
      h("div", { class: "actions" },
        button(n ? `Add ${plan.adds.length} lead${plan.adds.length === 1 ? "" : "s"}${plan.updates.length ? ` and update ${plan.updates.length}` : ""}` : "Nothing to import", { kind: "primary", id: "confirmImport", disabled: !n, onclick: () => commit(n) }),
        button("Cancel", { kind: "ghost", id: "cancelImport", onclick: () => { importHost.hidden = true; plan = null; } }))]);
    importHost.hidden = false;
    if (fresh) { announce(`${plan.adds.length} new leads ready to review`); importHost.scrollIntoView?.({ block: "nearest" }); }
  }

  /* ---------- match the file's columns to Cold's fields (or to extra fields of your own) ---------- */
  const FIELD_CHOICES = [...LEAD_FIELDS.map(f => [f.key, f.label]), ["first", "First name (joined to last)"], ["last", "Last name (joined to first)"]];
  /** One row per column in the file: what it is called, an example from the file, and what it should become. Changing a row re-plans the import. */
  function mapperPanel(getOpts, { open = false } = {}) {
    const names = customNames(S.leads);
    const rows = plan.headers.map((head, i) => {
      const target = mapping[i] || "";
      const sel = h("select", { "aria-label": `What “${head || `column ${i + 1}`}” should become` },
        h("option", { value: "" }, "Don't import"),
        h("optgroup", { label: "Cold's fields" }, FIELD_CHOICES.map(([v, l]) => h("option", { value: v }, l))),
        h("optgroup", { label: "Extra fields" }, names.map(n => h("option", { value: `x:${n}` }, n)), h("option", { value: "x:+" }, "A new extra field…")));
      const known = target === "" || FIELD_CHOICES.some(([v]) => v === target) || names.includes(target.slice(2));
      sel.value = known ? target : "x:+";
      const nameIn = h("input", { type: "text", maxlength: 60, placeholder: "Name of the extra field", "aria-label": `Name for the extra field made from “${head}”`, value: known ? "" : target.slice(2) || head, hidden: sel.value !== "x:+" });
      const apply = () => { mapping = mapping.slice(); mapping[i] = sel.value === "x:+" ? (nameIn.value.trim() ? `x:${nameIn.value.trim()}` : "") : sel.value; runPlan(sourceText, getOpts(), false); };
      sel.addEventListener("change", () => { if (sel.value === "x:+" && !nameIn.value.trim()) nameIn.value = head; nameIn.hidden = sel.value !== "x:+"; apply(); });
      nameIn.addEventListener("change", apply);
      return h("tr", {}, h("td", {}, h("strong", {}, head || `(column ${i + 1})`)), h("td", { class: "sub" }, plan.samples[i] || "empty"), h("td", {}, sel, nameIn));
    });
    const box = h("details", { class: "panel", id: "mapper", open: open || (mapperOpen === null ? plan.ignored.length > 0 || !!plan.repeated.length : mapperOpen) },
      h("summary", {}, "Match your columns to Cold's fields"),
      h("p", { class: "hint" }, `Choose what each column in your file should become. Columns you don't need can stay as “Don't import”. Use “A new extra field…” to keep something Cold has no field for (up to ${MAX_CUSTOM} per lead); extra fields are kept with the lead, exported and searchable.`),
      plan.repeated.length ? notice("warn", h("p", {}, `More than one column was matched to ${plan.repeated.join(", ")}. Only the first is used.`)) : null,
      h("div", { class: "table-wrap" }, h("table", { class: "leads", id: "mapperTable" }, h("caption", { class: "sr-only" }, "Columns in your file"),
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Column in your file"), h("th", { scope: "col" }, "Example"), h("th", { scope: "col" }, "Becomes"))), h("tbody", {}, rows))));
    box.addEventListener("toggle", () => { mapperOpen = box.open; });   // stays as the person left it while they change columns
    return box;
  }
  /** The file has no column Cold can use as a name: show the mapper alone so one can be chosen. */
  function showMapper(message) {
    const opts = { duplicates: "skip", list: "" };
    plan.samples = plan.samples || plan.headers.map(() => "");
    append(clear(importHost), [h("h2", { id: "import-title" }, `Review ${planName}`), notice("warn", h("p", {}, message)), mapperPanel(() => opts, { open: true }),
      h("div", { class: "actions" }, button("Cancel", { kind: "ghost", id: "cancelImport", onclick: () => { importHost.hidden = true; plan = null; } }))]);
    importHost.hidden = false;
  }
  async function commit(n) {
    const btn = importHost.querySelector("#confirmImport"); btn.disabled = true; btn.textContent = "Saving…";
    try {
      await store.saveLeads([...plan.adds, ...plan.updates.map(u => u.next)]);
      const added = plan.adds.length, updated = plan.updates.length;
      importHost.hidden = true; plan = null; shown = Math.max(shown, PAGE);
      toast(`${added} lead${added === 1 ? "" : "s"} added${updated ? `, ${updated} updated` : ""}`); announce(`${added} leads added`);
    } catch { btn.disabled = false; btn.textContent = `Add ${n}`; showProblem(planName, "Couldn't save the leads. Nothing was lost: try again."); }
  }

  /* ---------- add / edit one lead ---------- */
  function edit(lead, { findEmail = false } = {}) {
    const isNew = !lead; let base = lead || { id: uid("l"), source: "manual", createdAt: Date.now() };
    const f = {};
    for (const spec of LEAD_FIELDS) {
      const common = { id: `lf-${spec.key}`, label: spec.label, hint: spec.hint, required: spec.required ? true : null };
      if (spec.key === "why" || spec.key === "notes") f[spec.key] = field({ ...common, control: textArea({ rows: spec.key === "why" ? 3 : 2 }) });
      else if (spec.key === "product") f[spec.key] = field({ ...common, control: (id, d) => h("select", { id, "aria-describedby": d }, h("option", { value: "" }, "Choose when I write"), S.products.map(p => h("option", { value: p.name }, p.name || "Untitled")), base.product && !S.products.some(p => p.name === base.product) ? h("option", { value: base.product }, `${base.product} (not in Knowledge)`) : null) });
      else if (spec.key === "goal") f[spec.key] = field({ ...common, control: (id, d) => h("select", { id, "aria-describedby": d }, h("option", { value: "" }, "Choose when I write"), Object.entries(GOALS).map(([k, g]) => h("option", { value: k }, g.label))) });
      else f[spec.key] = field({ ...common, control: textInput(spec.key === "list" ? { list: "leadLists" } : spec.key === "email" ? { type: "email", inputmode: "email" } : {}) });
      f[spec.key].input.value = base[spec.key] || "";
    }
    const msg = h("p", { class: "hint", role: "status" });
    // extra fields: the ones this lead has, plus any other lead has (blank, ready to fill), plus a way to add a new one
    const extras = []; const extraHost = h("div", { class: "form", id: "extraFields" });
    const addExtra = (name, value) => {
      const nameIn = h("input", { type: "text", maxlength: 60, "aria-label": "Extra field name", placeholder: "Field name", value: name, class: "extra-name" });
      const valIn = h("input", { type: "text", maxlength: 2000, "aria-label": name ? `${name}` : "Extra field value", placeholder: "Value", value, class: "extra-value" });
      nameIn.addEventListener("input", () => valIn.setAttribute("aria-label", nameIn.value || "Extra field value"));
      const row = h("div", { class: "grid2 extra-row" }, nameIn, valIn);
      const rec = { nameIn, valIn, row };
      row.append(button("Remove", { kind: "ghost", "aria-label": `Remove ${name || "this extra field"}`, onclick: () => { extras.splice(extras.indexOf(rec), 1); row.remove(); } }));
      extras.push(rec); extraHost.append(row); return rec;
    };
    const have = cleanCustom(base.custom);
    for (const n of new Set([...Object.keys(have), ...customNames(S.leads)])) addExtra(n, have[n] || "");
    const readCustom = () => cleanCustom(Object.fromEntries(extras.map(r => [r.nameIn.value, r.valIn.value])));
    const read = () => { const r = { ...base, ...Object.fromEntries(LEAD_FIELDS.map(s => [s.key, f[s.key].input.value.trim()])) }; const c = readCustom(); if (Object.keys(c).length || base.custom) r.custom = c; return r; };
    const save = async () => {
      const rec = read(), { errors, warnings } = checkLead(rec);
      f.name.setError(errors.join(" ")); if (errors.length) { f.name.input.focus(); return; }
      if (rec.profileUrl && canonicalProfile(rec.profileUrl)) rec.profileUrl = canonicalProfile(rec.profileUrl);
      try { await store.saveLead(rec); toast(isNew ? "Lead added" : "Lead saved"); editorHost.hidden = true; if (warnings.length) toast(warnings[0]); }
      catch { msg.textContent = "Couldn't save. Your changes are still here; try again."; }
    };
    clear(editorHost).append(h("h2", { id: "editor-title" }, isNew ? "Add a lead" : `Edit ${base.name || "lead"}`),
      h("div", { class: "form" }, h("div", { class: "grid2" }, f.name, f.company), h("div", { class: "grid2" }, f.role, f.email), f.profileUrl, f.why, h("div", { class: "grid2" }, f.product, f.goal), h("div", { class: "grid2" }, f.list, f.notes),
        h("h3", {}, "Extra fields"), h("p", { class: "hint" }, `Anything else you want to keep about them that Cold has no field for (up to ${MAX_CUSTOM}). Never used in an email unless you copy it in.`), extraHost,
        button("Add an extra field", { kind: "ghost", id: "addExtra", onclick: () => { if (extras.length >= MAX_CUSTOM) return toast(`Up to ${MAX_CUSTOM} extra fields.`); addExtra("", "").nameIn.focus(); } }),
        h("div", { class: "actions" }, button("Save lead", { kind: "primary", id: "saveLead", onclick: save }), button("Cancel", { kind: "ghost", onclick: () => { editorHost.hidden = true; } }),
          isNew ? null : button("Delete lead", { kind: "ghost danger", id: "deleteLead", onclick: () => del([base.id]).then(done => { if (done) editorHost.hidden = true; }) })), msg));
    // Only for a saved lead with no address: a found email is offered as a candidate, never saved until accepted. A lead that has one is never replaced from here.
    let finder = null;
    if (!isNew && !base.email && platform && platform.people) {
      finder = mountFindEmail({ store, platform, lead: base, onAccepted: fresh => { if (fresh) { base = fresh; f.email.input.value = fresh.email; } } });
      editorHost.append(finder);
    }
    editorHost.hidden = false; (findEmail && finder ? finder.querySelector("#feFind") : f.name.input).focus(); editorHost.scrollIntoView?.({ block: "nearest" });
  }
  async function del(ids) {
    const names = ids.map(id => store.leadById(id)).filter(Boolean);
    if (!(await confirmDialog({ title: ids.length === 1 ? `Delete ${names[0] ? names[0].name || "this lead" : "this lead"}?` : `Delete ${ids.length} leads?`, body: "This removes them from your leads. Drafts already written to them stay in History.", confirmLabel: "Delete", danger: true }))) return false;
    try { await store.deleteLeads(ids); ids.forEach(id => selected.delete(id)); toast(ids.length === 1 ? "Lead deleted" : `${ids.length} leads deleted`); return true; }
    catch { toast("Couldn't delete. Nothing was removed."); return false; }
  }

  /* ---------- the table ---------- */
  function render() {
    const lists = [...new Set(S.leads.map(l => l.list).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    append(clear(listSel), [h("option", { value: "all" }, "All lists"), h("option", { value: "" }, "No list"), ...lists.map(l => h("option", { value: l }, l))]); listSel.value = listFilter;
    document.getElementById("leadLists") || document.body.append(h("datalist", { id: "leadLists" }));
    clear(document.getElementById("leadLists")).append(...lists.map(l => h("option", { value: l })));
    selected = new Set([...selected].filter(id => S.leads.some(l => l.id === id)));
    const rows = filterLeads(S.leads, { query, list: listFilter, progress: progressFilter, emails: S.emails });
    count.textContent = S.leads.length ? `${rows.length} of ${S.leads.length} lead${S.leads.length === 1 ? "" : "s"}` : "";
    clear(tableHost);
    if (!S.leads.length) { tableHost.append(h("div", { class: "empty" }, h("h2", {}, "No leads yet"), h("p", {}, "Download the template, fill it in a spreadsheet, save it as CSV and import it here. Or add someone by hand."), h("p", { class: "hint" }, "Prefer to work in Google Sheets? ", h("a", { href: "#/settings" }, "Keep your leads in a Google Sheet"), "."), h("div", { class: "actions" }, button("Download template", { onclick: () => download("cold-leads-template.csv", templateCsv()) }), button("Import CSV", { kind: "primary", onclick: () => fileIn.click() })))); renderBulk(); return; }
    if (!rows.length) { tableHost.append(h("p", { class: "empty" }, "No leads match.")); renderBulk(); return; }
    const all = h("input", { type: "checkbox", id: "selectAll", "aria-label": "Select all shown leads", checked: rows.slice(0, shown).every(l => selected.has(l.id)) });
    all.addEventListener("change", () => { rows.slice(0, shown).forEach(l => (all.checked ? selected.add(l.id) : selected.delete(l.id))); render(); });
    const th = t => h("th", { scope: "col" }, t);
    append(tableHost, [h("table", { class: "leads", id: "leadsTable" }, h("caption", { class: "sr-only" }, "Leads"),
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, all), th("Name"), th("Company"), th("Email"), th("Why they'd care"), th("List"), th("Outreach"), th("Actions"))),
      h("tbody", {}, rows.slice(0, shown).map(l => {
        const [kind, label] = PROGRESS_CHIP[leadProgress(l, S.emails)];
        const check = h("input", { type: "checkbox", "aria-label": `Select ${l.name}`, checked: selected.has(l.id) }); check.addEventListener("change", () => { check.checked ? selected.add(l.id) : selected.delete(l.id); renderBulk(); });
        const issues = checkLead(l).warnings;
        return h("tr", { dataset: { id: l.id } }, h("td", {}, check),
          h("td", {}, h("strong", {}, l.name || "Unnamed"), l.role ? h("div", { class: "sub" }, l.role) : null),
          h("td", {}, l.company), h("td", {}, l.email, issues.some(w => /email/.test(w)) ? h("span", { class: "chip warn", title: "This address doesn't look valid" }, "check") : null),
          h("td", { class: "why" }, l.why), h("td", {}, l.list), h("td", {}, chip(kind, label, { glyph: false })),
          h("td", { class: "ctl" }, tag(button("Edit", { kind: "ghost", "aria-label": `Edit ${l.name}`, onclick: () => edit(l) }), "leadEdit"), !l.email && platform && platform.people ? tag(button("Find email", { kind: "ghost", "aria-label": `Find an email for ${l.name}`, onclick: () => edit(l, { findEmail: true }) }), "leadFind") : null, tag(button("Write", { "aria-label": `Write to ${l.name}`, onclick: () => navigate("compose", { lead: l }) }), "leadWrite")));
      }))),
      rows.length > shown ? h("div", { class: "actions" }, button(`Show ${Math.min(PAGE, rows.length - shown)} more`, { id: "showMore", onclick: () => { shown += PAGE; render(); } })) : null]);
    renderBulk();
  }
  function renderBulk() {
    bulkHost.hidden = !selected.size; clear(bulkHost);
    if (!selected.size) return;
    bulkHost.append(h("span", { id: "selCount" }, `${selected.size} selected`),
      button("Set list…", { id: "bulkList", onclick: async () => { const v = await promptDialog({ title: "List for the selected leads", hint: "Type a list name, or leave it empty to remove them from any list.", value: "" }); if (v === null) return; await store.saveLeads(S.leads.filter(l => selected.has(l.id)).map(l => ({ ...l, list: v.trim() }))); toast("List updated"); } }),
      button("Delete selected", { kind: "ghost danger", id: "bulkDelete", onclick: () => del([...selected]) }),
      button("Clear selection", { kind: "ghost", onclick: () => { selected.clear(); render(); } }));
  }
  search.addEventListener("input", () => { query = search.value; shown = PAGE; render(); });
  listSel.addEventListener("change", () => { listFilter = listSel.value; shown = PAGE; render(); });
  progSel.addEventListener("change", () => { progressFilter = progSel.value; shown = PAGE; render(); });
  store.subscribe(t => { if (t === "leads" || t === "emails" || t === "ready" || t === "products") render(); });
  return { init: render, edit, importText: (text, name = "pasted.csv") => { planName = name; mapping = null; mapperOpen = null; runPlan(text, { duplicates: "skip", list: "" }, true); } };
}
