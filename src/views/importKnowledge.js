// Import product knowledge: the dialog that reads a repository, and the review panel shown inside the product editor.
// Nothing here saves or approves anything. Accepting a suggestion writes it into the editor's fields; the person still presses Save.
import { h, clear, autosize } from "../components/dom.js";
import { chip, button, notice, announce } from "../components/ui.js";
import { planReview, planRefresh, applySuggestion, pickFolderFiles, FIELD_LABELS, STATUS_LABELS, evidenceLabel } from "../domain/importKnowledge.js";

const STEPS = [["read", "Reading your project…"], ["understand", "Understanding what it does…"], ["check", "Checking technical claims…"], ["prepare", "Preparing your product profile…"]];
const CHIP = { verified: "good", inferred: "accent", needs_evidence: "warn", not_found: "neutral" };
const put = (el, ...kids) => { el.append(...kids.filter(k => k != null && k !== false)); return el; };   // native append() would print "null"
const statusChip = s => chip(CHIP[s] || "neutral", STATUS_LABELS[s] || s);

const failure = e => {
  if (!e) return "The import failed.";
  if (e.code === "network") return e.message || "Couldn't reach the Cold server.";
  if (e.code === "access_required") return "This server needs an access code. Enter it under “Connection” in Compose, then try again.";
  return e.message || "The import failed.";
};

/**
 * The "Import from repository" dialog. Resolves with the server's result, or null when the person skips, cancels or closes it.
 * `previous` is evidence from an earlier import (refresh). `source` names where that import came from.
 */
export function importDialog({ api, previous, source = null }) {
  return new Promise(resolve => {
    const refresh = !!previous;
    const fromZip = source && source.host === "upload", fromFolder = source && source.host === "folder";
    const url = h("input", { type: "text", id: "impUrl", autocomplete: "off", placeholder: "https://github.com/owner/name", value: !fromZip && !fromFolder && source && source.url ? source.url : "", "aria-describedby": "impUrlHint" });
    const folder = h("input", { type: "file", id: "impFolder", "aria-describedby": "impFolderHint" });
    folder.webkitdirectory = true; folder.multiple = true;   // a folder picker in Chrome, Edge, Firefox, Safari and the desktop app
    const zip = h("input", { type: "file", id: "impZip", accept: ".zip,application/zip" });
    folder.addEventListener("change", () => { if (folder.files && folder.files.length) zip.value = ""; });
    zip.addEventListener("change", () => { if (zip.files && zip.files.length) folder.value = ""; });
    const err = h("p", { class: "field-error", id: "impErr", role: "alert", hidden: true });
    const goBtn = h("button", { type: "submit", class: "btn primary", value: "go" }, refresh ? "Refresh" : "Read repository");
    const skipBtn = h("button", { type: "button", class: "btn ghost", id: "impSkip" }, refresh ? "Cancel" : "Skip and enter it manually");
    const form = h("form", { class: "dialog-body import-dialog", novalidate: true },
      h("h2", { id: "dlg-title" }, refresh ? "Refresh from repository" : "Import from repository or folder"),
      h("p", { class: "hint" }, refresh
        ? "Cold re-reads the project and shows what changed. Your wording and your approvals stay exactly as they are until you choose otherwise."
        : "Point Cold at the project, on GitHub or in a folder on this computer, and it will draft the product profile from what it finds: README, docs, manifests, tests and examples. You review everything before it's added. Nothing is approved for emails automatically."),
      h("div", { class: "field" }, h("label", { for: "impUrl" }, "GitHub repository address"), h("p", { class: "hint", id: "impUrlHint" }, "A public repository. Cold reads one exact commit and records which."), url),
      h("div", { class: "field" }, h("label", { for: "impFolder" }, fromFolder ? "Or choose the project folder again" : "Or choose a project folder on this computer"),
        h("p", { class: "hint", id: "impFolderHint" }, "Works for private and unpublished projects. Cold reads text files only and skips node_modules, build output and .git. Your browser may ask you to confirm the upload."), folder),
      h("div", { class: "field" }, h("label", { for: "impZip" }, fromZip ? "Or upload the project ZIP again" : "Or upload a ZIP of the project"), h("p", { class: "hint" }, "Works for private projects. Up to 40 MB. Cold reads the ZIP in memory and keeps nothing."), zip),
      err,
      h("div", { class: "dialog-actions" }, skipBtn, goBtn));
    const dlg = h("dialog", { "aria-labelledby": "dlg-title", class: "dialog import-dlg" }, form);
    let done = false, ctl = null;
    const finish = v => { if (done) return; done = true; if (ctl) ctl.abort(); dlg.close(); dlg.remove(); resolve(v); };
    dlg.addEventListener("cancel", e => { e.preventDefault(); finish(null); });
    skipBtn.addEventListener("click", () => finish(null));

    function working(label) {
      const list = h("ol", { class: "import-steps", "aria-label": "Progress" });
      const paint = current => {
        clear(list);
        const at = STEPS.findIndex(s => s[0] === current);
        STEPS.forEach(([k, text], i) => list.append(h("li", { class: i < at ? "done" : i === at ? "now" : "", "aria-current": i === at ? "step" : null }, h("span", { "aria-hidden": "true" }, i < at ? "✓" : i === at ? "…" : "·"), " ", text)));
      };
      paint("read");
      const cancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");
      cancel.addEventListener("click", () => finish(null));
      clear(form).append(h("h2", { id: "dlg-title" }, label), list, h("p", { class: "hint", role: "status" }, "This can take a minute with a local model."), h("div", { class: "dialog-actions" }, cancel));
      return paint;
    }

    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const file = zip.files && zip.files[0], address = url.value.trim();
      const dir = folder.files && folder.files.length ? pickFolderFiles([...folder.files].map(f => ({ path: f.webkitRelativePath || f.name, size: f.size, file: f }))) : null;
      if (!dir && !file && !address) { err.textContent = "Paste a repository address, choose a project folder or choose a ZIP file."; err.hidden = false; url.focus(); return; }
      if (dir && !dir.picked.length) { err.textContent = "That folder has no readable project files (README, docs, source, manifests)."; err.hidden = false; folder.focus(); return; }
      if (file && !/\.zip$/i.test(file.name)) { err.textContent = "Choose a .zip file."; err.hidden = false; return; }
      const saved = [...form.childNodes];
      const paint = working(refresh ? "Refreshing…" : "Importing…");
      ctl = new AbortController();
      try {
        const o = { previous, signal: ctl.signal, onStep: s => { paint(s); announce(STEPS.find(x => x[0] === s)?.[1] || ""); } };
        const result = dir ? await api.importFolder(dir.name, await readFolder(dir.picked), o) : file ? await api.importZip(file, o) : await api.importRepo(address, o);
        finish(result);
      } catch (e) {
        if (done || (e && e.code === "cancelled")) return;
        ctl = null;
        clear(form); saved.forEach(n => form.append(n));
        err.textContent = failure(e); err.hidden = false; url.focus();
      }
    });
    document.body.append(dlg);
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    url.focus();
  });
}

/** Read the chosen files as text. A file the browser can't read (moved, permission) is skipped, as an unreadable archive entry is. */
async function readFolder(picked) {
  const out = [];
  for (const f of picked) { try { out.push({ path: f.path, text: await f.file.text() }); } catch {} }
  return out;
}

/* ---------- review ---------- */

const GROUPS = [
  ["About this product", ["name", "oneLiner", "what", "who", "problem"]],
  ["Proof", ["proof"]],
  ["Facts and wording", ["techFact", "approved", "dontSay"]],
  ["More detail", ["longDesc"]],
  ["Links and social", ["website", "repo", "xHandle", "social"]],
];
const LONG = new Set(["what", "who", "problem", "longDesc", "techFact", "approved", "dontSay", "oneLiner"]);
const HELP = {
  approved: "A reusable phrase based on documented functionality.",
};

function evidenceList(evs) {
  if (!evs || !evs.length) return h("p", { class: "hint" }, "No exact excerpt was found for this.");
  return h("ul", { class: "evidence" }, evs.map(e => h("li", {},
    e.url ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer" }, evidenceLabel(e)) : h("span", { class: "mono" }, evidenceLabel(e)), " ", h("span", { class: "hint" }, `(${e.kind})`),
    e.excerpt ? h("blockquote", {}, e.excerpt) : null)));
}

/**
 * The review panel. `getProduct()` is the editor's current (unsaved) state; `adapter` writes into the editor's fields.
 * `state` = { records, source, setRecords, setSource } carries provenance. Returns the element.
 */
export function mountReview({ result, getProduct, adapter, records, setRecords, setSource, refresh, onChange, onClose, moveProofInternal, removeLine }) {
  const root = h("section", { class: "import-review card", "aria-labelledby": "imp-title", tabindex: "-1" });
  let recs = records;
  const commit = result.source.commit || "";
  const where = result.source.host === "upload" ? `uploaded project ${result.source.repo ? `“${result.source.repo}”` : ""}`.trim() : result.source.host === "folder" ? `folder ${result.source.repo ? `“${result.source.repo}”` : "on this computer"}` : `${result.source.owner}/${result.source.repo} @ ${commit.slice(0, 7)}`;
  const accepted = () => { setSource(); setRecords(recs); onChange(); };

  let plan = planReview(getProduct(), result);
  let flagged = [];
  if (refresh) {
    const r = planRefresh(getProduct(), result);
    recs = r.records; flagged = r.flagged; setRecords(recs); setSource(); onChange();
  }

  const note = h("p", { class: "hint", role: "status" });
  const body = h("div", { class: "import-body" });
  put(root,
    h("h2", { id: "imp-title" }, refresh ? "Review the changes" : "Review what Cold found"),
    h("p", {}, `Read ${result.read.files} files from ${where}. `, h("strong", {}, "Nothing has been added or approved yet."), " Accept what's right, edit as you go, discard the rest. Imported proof is always added as internal-only until you approve it."),
    ...(result.warnings || []).map(w => notice("warn", h("p", {}, w))),
    refresh && plan.present ? h("p", { class: "hint" }, `${plan.present} fact${plan.present === 1 ? "" : "s"} you already have still match the project and are not shown again.`) : null,
    body, note);

  function card(item) {
    const long = LONG.has(item.field) || item.field === "proof";
    const label = FIELD_LABELS[item.field] || item.field;
    const input = long ? h("textarea", { rows: item.field === "longDesc" ? 5 : 2, "aria-label": label }) : h("input", { type: "text", "aria-label": label });
    input.value = item.text;
    const evInput = item.field === "proof" ? h("input", { type: "text", "aria-label": "Evidence recorded with this proof point", value: item.proof.evidence || "" }) : null;
    if (long) setTimeout(() => autosize(input), 0);
    const status = h("div", { class: "import-status" });
    const el = h("div", { class: `import-card ${item.status}`, role: "group", "aria-label": `${label}: ${item.status}` });
    const finish = msg => { clear(el).append(h("p", { class: "import-done" }, h("strong", {}, label), ": ", msg)); announce(`${label}: ${msg}`); };
    const accept = (opts = {}) => {
      try {
        const out = applySuggestion(adapter, recs, item, { text: input.value, evidence: evInput ? evInput.value : undefined, approve: opts.approve });
        recs = out.records; accepted(); finish(out.note);
      } catch (e) { status.textContent = e.message; }
    };
    const verb = item.mode === "replace" ? "Replace current" : item.mode === "fill" ? "Use this" : item.field === "proof" ? "Add as internal-only" : "Add";
    const acts = h("div", { class: "actions" }, button(verb, { kind: item.mode === "replace" ? "secondary" : "primary", onclick: () => accept() }));
    if (item.field === "proof" && item.status === "verified") acts.append(button("Add and approve for external use", { kind: "secondary", onclick: () => accept({ approve: true }) }));
    acts.append(button("Discard", { kind: "ghost", onclick: () => finish("Discarded.") }));
    put(el,
      h("div", { class: "import-head" }, h("strong", {}, label), " ", statusChip(item.status), item.mode === "replace" ? chip("neutral", "Replaces your text", { glyph: false }) : null,
        item.field === "proof" ? chip("neutral", `${item.proof.type} · strength ${item.proof.strength}`, { glyph: false }) : null),
      input, evInput ? h("div", {}, h("span", { class: "hint" }, "Evidence kept with the proof point"), evInput) : null,
      item.mode === "replace" ? h("p", { class: "hint" }, "Your current text: ", h("em", {}, item.current)) : null,
      h("p", { class: "hint" }, item.basis), HELP[item.field] ? h("p", { class: "hint" }, HELP[item.field]) : null,
      item.field === "proof" && item.recommended === "internal" ? h("p", { class: "hint" }, "Recommended: keep internal-only until you have evidence beyond the code.") : null,
      h("details", {}, h("summary", {}, `Evidence (${item.evidence.length})`), evidenceList(item.evidence)),
      acts, status);
    return el;
  }

  function flaggedCard(f) {
    const r = f.record, label = FIELD_LABELS[r.field] || r.field;
    const el = h("div", { class: "import-card needs_evidence", role: "group", "aria-label": `${label}: needs a look` });
    const done = msg => clear(el).append(h("p", { class: "import-done" }, h("strong", {}, label), ": ", msg));
    const acts = h("div", { class: "actions" }, button("Keep as is", { kind: "primary", onclick: () => done("Kept.") }));
    if (r.field === "proof" && f.approved) acts.append(button("Move to internal-only", { kind: "secondary", onclick: () => { moveProofInternal(f.proofId); onChange(); done("Moved to internal-only. Approve it again once you've checked it."); } }));
    else if (r.field === "proof" || ["techFact", "approved", "dontSay", "social"].includes(r.field)) acts.append(button("Remove", { kind: "secondary", onclick: () => { removeLine(r); onChange(); done("Removed."); } }));
    el.append(
      h("div", { class: "import-head" }, h("strong", {}, label), " ", chip("warn", f.state === "missing" ? "Source removed" : "Source changed"), f.approved ? chip("good", "Approved for external use") : null),
      h("p", {}, r.text), h("p", { class: "hint" }, f.reason, f.approved ? " This claim is approved for external use, so it stays approved until you change it." : ""),
      h("details", {}, h("summary", {}, `What it was based on (${r.evidence.length})`), evidenceList(r.evidence)), acts);
    return el;
  }

  function paint() {
    clear(body);
    if (flagged.length) body.append(h("div", { class: "import-group" }, h("h3", {}, "Needs a look"), h("p", { class: "hint" }, "Earlier imports that this project no longer backs up the same way. Nothing is changed until you choose."), flagged.map(flaggedCard)));
    for (const [title, fields] of GROUPS) {
      const items = plan.items.filter(i => fields.includes(i.field));
      if (!items.length) continue;
      const bulk = fields.includes("techFact") ? items.filter(i => i.field === "techFact" && i.status === "verified") : [];
      body.append(h("div", { class: "import-group" }, h("h3", {}, title),
        bulk.length > 1 ? h("div", { class: "actions" }, button(`Add all ${bulk.length} verified facts`, { kind: "secondary", onclick: () => {
          for (const it of bulk) { try { recs = applySuggestion(adapter, recs, it, {}).records; } catch {} }
          accepted(); plan = { ...plan, items: plan.items.filter(i => !bulk.includes(i)) }; paint(); note.textContent = `Added ${bulk.length} verified facts to the editor.`;
        } }), h("span", { class: "hint" }, "Verified facts only. Each one still needs your read.")) : null,
        items.map(card)));
    }
    const nf = plan.notFound;
    if (nf.length) body.append(h("div", { class: "import-group" }, h("h3", {}, "Not found"), h("p", { class: "hint" }, "Cold couldn't determine these from the project, so it left them blank rather than guess."), h("ul", { class: "ready-list" }, nf.map(n => h("li", {}, chip("neutral", STATUS_LABELS.not_found, { glyph: false }), " ", h("strong", {}, n.label))))));
    if (!body.childNodes.length) body.append(notice("info", h("p", {}, refresh ? "Nothing new or changed. Your product still matches the project." : "Cold didn't find anything to suggest.")));
    body.append(h("div", { class: "actions" }, button("Done reviewing", { kind: "primary", id: "impDone", onclick: () => onClose() }), h("span", { class: "hint" }, "Then check the fields below and press Save product.")));
  }
  paint();
  return root;
}
