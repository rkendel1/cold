// Knowledge: reusable product context. Uses the existing product data model unchanged.
import { h, $, $$, clear, autosize } from "../components/dom.js";
import { field, textInput, textArea, button, chip, toast, notice } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import { PROOF_TYPES, PROOF_STRENGTHS } from "../domain/constants.js";
import { readiness, externalProof, normalizeHandle, productLinks } from "../domain/knowledge.js";
import { linkKey, orderLinks, signoffBlock } from "../domain/signoff.js";
import { uid } from "../domain/ids.js";
import { sourceOf, norm } from "../domain/importKnowledge.js";
import { importDialog, mountReview } from "./importKnowledge.js";

export function mountKnowledge(root, { store, navigate, platform = null }) {
  const S = store.state;
  const canImport = () => !!(platform && platform.api && platform.api.importRepo && S.surface !== "extension");
  let sel = null;           // { id, isNew, dirty, el, read, focusers }
  let draftProduct = null;  // unsaved new product

  const picker = h("select", { "aria-describedby": "pickerStatus" });
  const pickerField = field({ id: "kProduct", required: null, label: "Product or offering", hint: "Choose which product's facts to view and edit. Compose uses the same list.", control: id => { picker.id = id; return picker; } });
  const pickerStatus = h("p", { class: "hint", id: "pickerStatus", "aria-live": "polite" });
  const editorHost = h("div", {});
  root.append(
    h("div", { class: "view-head" },
      h("h1", { id: "knowledge-title", tabindex: "-1" }, "Product knowledge"),
      h("p", { class: "lede" }, "The facts Cold is allowed to write from. Enter them once and reuse them in every draft. Cold only states what's recorded here and what you type in Compose.")),
    h("div", { class: "picker" }, pickerField, pickerStatus),
    editorHost);

  /** Resolves true when it is safe to leave the current editor (nothing unsaved, or the user agreed to discard). */
  async function guarded(fn) {
    if (sel?.dirty && !(await confirmDialog({ title: "Discard unsaved changes?", body: "You have edits to this product that haven't been saved.", confirmLabel: "Discard changes", danger: true }))) return false;
    if (sel) sel.dirty = false;
    fn();
    return true;
  }

  /* ---------- product dropdown ---------- */
  function renderList() {
    clear(picker);
    if (!S.ready) { picker.append(h("option", { value: "" }, "Loading your products…")); picker.disabled = true; return; }
    picker.disabled = false;
    const items = [...S.products];
    if (draftProduct) items.push(draftProduct);
    if (!items.length) picker.append(h("option", { value: "" }, "No products yet"));
    items.forEach(p => picker.append(h("option", { value: p.id }, p.name || (p._new ? "New product (unsaved)" : "Untitled product"))));
    picker.append(h("option", { value: "__new" }, "Add a new product…"));
    picker.value = sel && items.some(p => p.id === sel.id) ? sel.id : (items[0]?.id || "");
    const cur = items.find(p => p.id === picker.value);
    if (!cur) { pickerStatus.textContent = ""; return; }
    const r = readiness(cur);
    pickerStatus.textContent = !r.ready ? `Needs ${r.blocking.map(b => b.label.toLowerCase()).join(" and ")} before Cold can draft.` : r.advised.length ? `Ready to draft. ${r.advised.length} suggestion${r.advised.length === 1 ? "" : "s"} below would improve drafts.` : "Ready to draft. Nothing is missing.";
  }
  picker.addEventListener("change", async () => {
    const v = picker.value;
    const ok = await guarded(() => (v === "__new" ? newProduct() : select(v)));
    if (!ok) renderList();                 // user kept their edits: put the dropdown back
  });

  function newProduct() {
    draftProduct = { id: uid("p"), name: "", order: S.products.length, proof: [], techFacts: [], approved: [], dontSay: [], _new: true };
    select(draftProduct.id);
    sel.dirty = true; sel.setStatus("Not saved yet");
    $("#kName", editorHost)?.focus();
  }

  function select(id) {
    const p = S.products.find(x => x.id === id) || (draftProduct?.id === id ? draftProduct : null);
    clear(editorHost);
    if (!p) { sel = null; editorHost.append(emptyState()); renderList(); return; }
    sel = buildEditor(p);
    editorHost.append(sel.el);
    renderList();
  }

  const emptyState = () => h("div", { class: "empty" }, h("h2", {}, "Add what you're selling"),
    h("p", {}, "Start with two things: the product's name and what it does in one plain sentence. That's enough for a first draft. Add proof, audience and wording rules whenever you like."),
    h("div", { class: "actions" },
      canImport() ? button("Import from repository or folder", { kind: "primary", id: "emptyImport", onclick: () => { newProduct(); sel?.startImport?.(); } }) : null,
      button("Add your first product", { kind: canImport() ? "secondary" : "primary", id: "emptyAdd", onclick: () => newProduct() })));

  /* ---------- editor ---------- */
  function buildEditor(p) {
    const refs = {};
    const lines = a => (a || []).join("\n");
    const mk = (key, props) => (refs[key] = field({ id: key, ...props }));
    mk("kName", { label: "Product name", required: true, control: textInput({ value: p.name }) });
    mk("kOne", { label: "One-line description", control: textInput({ value: p.oneLiner }) });
    mk("kWhat", { label: "What it does", required: true, hint: "Sentence 2 of every email (how you solve their problem) is built from this. Write it the way you'd say it out loud.", control: textArea({ rows: 2 }) });
    mk("kWho", { label: "Who it's for", hint: "Lets a draft say why it fits this particular person.", control: textArea({ rows: 2 }) });
    mk("kProblem", { label: "Problem it solves", hint: "Every email opens with this, not with the product. Name the cost people pay today (time, money, risk), specifically.", control: textArea({ rows: 2 }) });
    mk("kTech", { label: "Technical facts", hint: "One per line. Anything here may be used as a fact in a draft.", control: textArea({ rows: 3 }) });
    mk("kApproved", { label: "Approved language", hint: "Phrasings you like, one per line. The draft prefers these.", control: textArea({ rows: 3 }) });
    mk("kDont", { label: "Prohibited claims and phrases", hint: "One per line. Put exact phrases in \"double quotes\" and Cold also checks drafts for them automatically.", control: textArea({ rows: 3 }) });
    mk("kCat", { label: "Category", control: textInput({ value: p.category }) });
    mk("kStatus", { label: "Status", control: textInput({ value: p.status, placeholder: "e.g. Private beta" }) });
    mk("kWeb", { label: "Website", control: (id, d) => h("input", { type: "url", id, value: p.website || "", "aria-describedby": d }) });
    mk("kX", { label: "X (Twitter) handle", hint: "Tweets can tag or mention it, like @acme.", control: textInput({ value: p.xHandle, placeholder: "@yourproduct" }) });
    mk("kLinks", { label: "Other links", hint: "One per line, as “Label: link”, e.g. LinkedIn: https://linkedin.com/company/acme. Tweets may include these.", control: textArea({ rows: 3 }) });
    mk("kRepo", { label: "Repository", control: (id, d) => h("input", { type: "url", id, value: p.repo || "", "aria-describedby": d }) });
    mk("kShort", { label: "Short description", control: textArea({ rows: 2 }) });
    mk("kLong", { label: "Long description", hint: "Background the generator may draw on (first 2,500 characters are used).", control: textArea({ rows: 4 }) });
    refs.kX.input.addEventListener("change", () => { const n = normalizeHandle(refs.kX.input.value); if (n) refs.kX.input.value = n; });
    const set = (k, v) => { refs[k].input.value = v || ""; };
    set("kLinks", lines(p.socials)); set("kWhat", p.what); set("kWho", p.who); set("kProblem", p.problem); set("kTech", lines(p.techFacts)); set("kApproved", lines(p.approved)); set("kDont", lines(p.dontSay)); set("kShort", p.shortDesc); set("kLong", p.longDesc);

    const rows = (p.proof || []).map(x => ({ ...x }));
    const imported = { source: p.importSource || null, records: Array.isArray(p.provenance) ? p.provenance : [] };   // where imported facts came from (kept apart from the prose)
    const proofHost = h("div", { class: "form" });
    const readyHost = h("div", {});
    const status = h("span", { class: "status", role: "status" }, p._new ? "Not saved yet" : `Saved ${store.where()}`);
    const saveBtn = h("button", { type: "submit", class: "btn primary", id: "kSave" }, "Save product");

    /* sign-off: which of this product's links go under your name in emails about it */
    const skip = new Set(p.signoffSkip || []);
    const pickHost = h("div", { class: "form", id: "signoffPick" });
    const previewEl = h("p", { class: "signoff", id: "signoffPreview", role: "status" });
    function renderSignoffPick() {
      const links = orderLinks(productLinks({ website: refs.kWeb.input.value.trim(), xHandle: normalizeHandle(refs.kX.input.value), repo: refs.kRepo.input.value.trim(), socials: refs.kLinks.input.value.split("\n").map(s => s.trim()).filter(Boolean) }));
      clear(pickHost);
      if (!links.length) pickHost.append(h("p", { class: "hint" }, "Add a website, X handle or other links above, then choose which go under your name in emails about this product."));
      for (const l of links) {
        const key = linkKey(l), cb = h("input", { type: "checkbox", checked: !skip.has(key) });
        cb.addEventListener("change", () => { cb.checked ? skip.delete(key) : skip.add(key); renderSignoffPreview(); if (sel) { sel.dirty = true; status.textContent = "Unsaved changes"; } });
        pickHost.append(h("label", { class: "check" }, cb, ` ${l[0]}: ${l[1]}`));
      }
      renderSignoffPreview();
    }
    function renderSignoffPreview() {
      const block = signoffBlock({ settings: { ...S.settings, signature: S.settings.signature || "Your name" }, product: { ...read(), name: refs.kName.input.value.trim() } });
      previewEl.textContent = `Under your name in emails about ${refs.kName.input.value.trim() || "this product"}:\n${block}${S.settings.signature ? "" : "\n(Set your name in Settings or on any draft.)"}`;
    }
    const read = () => {
      const val = k => refs[k].input.value.trim();
      const lines = k => refs[k].input.value.split("\n").map(s => s.trim()).filter(Boolean);
      return {
        ...p, _new: undefined, id: p.id, order: p.order ?? S.products.length,
        name: val("kName"), status: val("kStatus"), oneLiner: val("kOne"), category: val("kCat"), website: val("kWeb"), repo: val("kRepo"), xHandle: normalizeHandle(val("kX")), socials: lines("kLinks"), signoffSkip: [...skip],
        what: val("kWhat"), who: val("kWho"), problem: val("kProblem"), shortDesc: val("kShort"), longDesc: val("kLong"),
        techFacts: lines("kTech"), approved: lines("kApproved"), dontSay: lines("kDont"),
        ...(imported.source ? { importSource: imported.source, provenance: imported.records } : {}),
        proof: rows.filter(r => r.claim.trim()).map(r => ({ id: r.id, claim: r.claim.trim(), evidence: (r.evidence || "").trim(), type: r.type, strength: r.strength, external: !!r.external })),
      };
    };
    const markDirty = () => { if (!sel) return; sel.dirty = true; status.textContent = "Unsaved changes"; renderReady(); if (compact) paintSummary(); };

    function renderReady() {
      const r = readiness(read());
      clear(readyHost).append(h("section", { "aria-labelledby": "ready-title" },
        h("h2", { id: "ready-title" }, "Is this ready to draft from?"),
        r.ready ? notice(r.advised.length ? "info" : "good", h("strong", {}, r.advised.length ? "Ready for a first draft" : "Ready: nothing missing"), h("p", {}, r.advised.length ? "These would make drafts more specific and safer:" : "Everything Cold uses is filled in.")) : notice("warn", h("strong", {}, "Not ready yet"), h("p", {}, "Cold only writes from recorded facts, so these are needed before it can draft:")),
        tuck(r, h("ul", { class: "ready-list" }, r.items.map(i => h("li", {},
          i.done ? chip("good", "Done") : chip(i.level === "blocking" ? "bad" : "warn", i.level === "blocking" ? "Needed" : "Recommended"),
          h("span", {}, h("strong", {}, i.label), h("span", { class: "hint" }, ` ${i.why}`)),
          i.done ? null : button("Go to field", { kind: "ghost", onclick: () => focusField(i.id) })))))));
    }
    function focusField(id) {
      const target = id === "kAddProof" ? $("#kAddProof", el) : id === "kProof" ? $(".pEv", el) : refs[id]?.input;
      for (let d = target?.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;   // a collapsed section holds it
      target?.scrollIntoView({ block: "center" }); target?.focus();
    }

    /* proof */
    function renderProof() {
      const keepFocus = document.activeElement?.closest?.(".proof")?.dataset.rid;
      const keepSel = document.activeElement?.classList?.contains("pVis");
      clear(proofHost);
      const group = (external, title, badge, help) => {
        const g = rows.filter(r => !!r.external === external);
        return h("div", { class: "proof-group" }, h("h3", {}, title, " ", badge), h("p", { class: "hint" }, help),
          g.length ? g.map(proofRow) : h("p", { class: "hint" }, external ? "None yet. Without an approved proof point, drafts make no proof claim." : "None. Keep claims you can't yet share here so they can never leak into a draft."));
      };
      proofHost.append(
        group(true, "Approved for external use", chip("good", "May appear in drafts"), "Cold uses at most one of these per email, and only when it fits the person. Add evidence so the claim isn't stated vaguely."),
        group(false, "Internal only", chip("neutral", "Never sent to the model", { glyph: false }), "Kept for your own reference. These are not included in any draft or prompt."));
      if (keepFocus) { const row = proofHost.querySelector(`[data-rid="${keepFocus}"]`); (keepSel ? row?.querySelector(".pVis") : null)?.focus(); }
    }
    function proofRow(r) {
      const claim = field({ required: null, label: "Claim", control: (id, d) => h("input", { type: "text", id, class: "pClaim", value: r.claim, "aria-describedby": d }) });
      const ev = field({ required: null, label: "Evidence", hint: "The deployment, customer or benchmark behind it.", control: (id, d) => h("input", { type: "text", id, class: "pEv", value: r.evidence || "", "aria-describedby": d }) });
      const mkSel = (label, cls, opts, v) => field({ required: null, label, control: (id, d) => { const s = h("select", { id, class: cls, "aria-describedby": d }, opts.map(([val, text]) => h("option", { value: val, selected: val === v }, text))); return s; } });
      const type = mkSel("Type", "pType", PROOF_TYPES.map(t => [t, t]), r.type || "Technical");
      const str = mkSel("Strength", "pStr", PROOF_STRENGTHS.map(t => [t, t]), r.strength || "Medium");
      const vis = mkSel("Who can use this", "pVis", [["external", "Approved for external use"], ["internal", "Internal only"]], r.external ? "external" : "internal");
      claim.input.addEventListener("input", () => { r.claim = claim.input.value; markDirty(); });
      ev.input.addEventListener("input", () => { r.evidence = ev.input.value; markDirty(); });
      type.input.addEventListener("change", () => { r.type = type.input.value; markDirty(); });
      str.input.addEventListener("change", () => { r.strength = str.input.value; markDirty(); });
      vis.input.addEventListener("change", () => { r.external = vis.input.value === "external"; markDirty(); renderProof(); const row = proofHost.querySelector(`[data-rid="${r.id}"] .pVis`); row?.focus(); });
      return h("div", { class: `proof ${r.external ? "" : "internal"}`, dataset: { rid: r.id }, role: "group", "aria-label": `Proof: ${r.claim || "new item"}` },
        claim, ev, h("div", { class: "meta" }, type, str, vis, button("Remove", { kind: "ghost danger", onclick: () => { rows.splice(rows.indexOf(r), 1); markDirty(); renderProof(); } })),
        r.external && !(r.evidence || "").trim() ? chip("warn", "Needs evidence") : null);
    }

    /* import from repository: suggestions are written into these same fields, and nothing is saved or approved until the person says so */
    const importHost = h("div", {});
    const importBar = h("div", { class: "import-bar" });
    const FIELD_REF = { name: "kName", oneLiner: "kOne", what: "kWhat", who: "kWho", problem: "kProblem", longDesc: "kLong", website: "kWeb", repo: "kRepo", xHandle: "kX", techFacts: "kTech", approved: "kApproved", dontSay: "kDont", socials: "kLinks" };
    const poke = ref => { autosize(ref.input); ref.input.dispatchEvent(new Event("input", { bubbles: true })); };
    const adapter = {
      set(field, value) { const ref = refs[FIELD_REF[field]]; ref.input.value = value; poke(ref); },
      addLine(field, text) { const ref = refs[FIELD_REF[field]], cur = ref.input.value.replace(/\s+$/, ""); ref.input.value = cur ? `${cur}\n${text}` : text; poke(ref); },
      addProof(row) { rows.push(row); markDirty(); renderProof(); return row; },
    };
    const removeLine = r => {
      if (r.field === "proof") { const i = rows.findIndex(x => x.id === r.proofId || norm(x.claim) === norm(r.text)); if (i >= 0) rows.splice(i, 1); markDirty(); renderProof(); return; }
      const ref = refs[FIELD_REF[{ techFact: "techFacts", approved: "approved", dontSay: "dontSay", social: "socials" }[r.field]]];
      ref.input.value = ref.input.value.split("\n").filter(l => norm(l) !== norm(r.text)).join("\n"); poke(ref);
    };
    const moveProofInternal = id => { const row = rows.find(x => x.id === id); if (row) { row.external = false; markDirty(); renderProof(); } };
    function paintImportBar() {
      clear(importBar);
      if (!canImport()) return;
      const src = imported.source;
      importBar.append(
        button(src ? "Refresh from repository" : "Import from repository or folder", { kind: src ? "secondary" : "primary", id: "kImport", onclick: () => startImport() }),
        h("span", { class: "hint" }, src
          ? `Imported from ${src.host === "upload" ? "an uploaded project" : src.host === "folder" ? `the folder “${src.repo}” on this computer` : `${src.owner}/${src.repo} @ ${String(src.commit).slice(0, 7)}`}. Refreshing shows what changed and never overwrites your edits or approvals.`
          : "Let Cold read a repository or ZIP and draft this profile. You review everything first."));
    }
    async function startImport() {
      if (!canImport()) return;
      const src = imported.source, refresh = !!src;
      const result = await importDialog({ api: platform.api, previous: refresh ? imported.records.map(r => ({ key: r.key, evidence: r.evidence })) : undefined, source: src });
      if (!result) { importBar.querySelector("button")?.focus(); return; }
      clear(importHost);
      const panel = mountReview({
        result, refresh, getProduct: read, adapter, records: imported.records, removeLine, moveProofInternal,
        setRecords: r => { imported.records = r; }, setSource: () => { imported.source = sourceOf(result); paintImportBar(); },
        onChange: () => { markDirty(); renderSignoffPick(); },
        onClose: () => { clear(importHost); importBar.querySelector("button")?.focus(); },
      });
      importHost.append(panel); panel.scrollIntoView?.({ block: "start" }); panel.focus();
    }

    // Extension: one level of collapsible sections so the panel stays short. Elsewhere: plain sections, as before.
    const compact = S.surface === "extension";
    const sect = (id, title, open, ...kids) => compact
      ? h("details", { class: "panel", id: `sec-${id}`, open: open || null }, h("summary", {}, title), h("div", { class: "in" }, ...kids))
      : h("section", { "aria-labelledby": `${id}-title` }, h("h2", { id: `${id}-title` }, title), ...kids);
    const tuck = (r, list) => (compact && r.ready && !r.advised.length ? h("details", { class: "panel" }, h("summary", {}, "What's filled in"), h("div", { class: "in" }, list)) : list);   // all done: one line, details on request
    const summaryEl = h("p", { class: "hint", id: "kSummary" });
    const paintSummary = () => {
      const r = read(), ext = r.proof.filter(x => x.external).length;
      summaryEl.textContent = `${r.proof.length} proof point${r.proof.length === 1 ? "" : "s"} (${ext} approved for drafts) · ${r.techFacts.length} technical fact${r.techFacts.length === 1 ? "" : "s"} · ${r.dontSay.length} prohibited phrase${r.dontSay.length === 1 ? "" : "s"}`;
    };

    const el = h("form", { class: "peditor", id: "kForm", novalidate: true, autocomplete: "off", dataset: { id: p.id } },
      h("h2", { class: "sr-only" }, "Edit product"),
      importBar, importHost,
      readyHost,
      compact ? summaryEl : null,
      sect("about", "About this product", true, refs.kName, refs.kOne, refs.kWhat, refs.kWho, refs.kProblem),
      sect("proof", "Proof", false,
        h("p", { class: "hint" }, "Proof points are the claims Cold can use to make the \"why it matters\" sentence credible. Choose carefully who can use each one."),
        proofHost, h("div", {}, button("Add proof", { id: "kAddProof", onclick: () => { const r = { id: uid("pr"), claim: "", evidence: "", type: "Technical", strength: "Medium", external: true }; rows.push(r); markDirty(); renderProof(); proofHost.querySelector(`[data-rid="${r.id}"] .pClaim`)?.focus(); } }))),
      sect("words", "Facts and wording", false, refs.kTech, refs.kApproved, refs.kDont),
      h("details", { class: "panel" }, h("summary", {}, "More detail ", h("span", { class: "opt" }, "(optional)")), h("div", { class: "in" }, h("div", { class: "grid2" }, refs.kCat, refs.kStatus, refs.kRepo), refs.kShort, refs.kLong)),
      h("details", { class: "panel", open: !!(p.website || p.xHandle || (p.socials || []).length) }, h("summary", {}, "Links and social ", h("span", { class: "opt" }, "(used in tweets and your email sign-off)")), h("div", { class: "in" }, h("div", { class: "grid2" }, refs.kWeb, refs.kX), refs.kLinks,
        h("div", { class: "field" }, h("strong", {}, "Include in your email sign-off"), h("p", { class: "hint" }, "Your name is set once in Settings. For emails about this product, the ones ticked here go under it."), pickHost, previewEl))),
      h("div", { class: "savebar" }, saveBtn,
        button("Write an email with this", { kind: "ghost", id: "kCompose", onclick: () => { if (sel?.dirty) toast("Unsaved edits aren't used in drafts until you save."); navigate("compose", { productId: p.id }); } }),
        status, button("Delete", { kind: "ghost danger", id: "kDelete", onclick: () => remove(p) })));

    el.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.closest(".import-review")) e.preventDefault(); });   // Enter in a suggestion must not save the product
    el.addEventListener("input", e => { if (e.target.closest(".proof") || e.target.closest(".import-review")) return; markDirty(); if ([refs.kWeb, refs.kX, refs.kRepo, refs.kLinks, refs.kName].some(c => c.input === e.target)) renderSignoffPick(); });
    renderSignoffPick(); paintImportBar();
    el.addEventListener("submit", async ev => {
      ev.preventDefault();
      const rec = read();
      refs.kName.setError(rec.name ? "" : "Name the product so you can find it again.");
      if (!rec.name) { refs.kName.input.focus(); return; }
      saveBtn.disabled = true; status.textContent = "Saving…";
      try {
        await store.saveProduct(rec);
        draftProduct = null; if (sel) { sel.id = rec.id; sel.dirty = false; }
        status.textContent = `Saved ${store.where()}`; toast(`${rec.name} saved`);
        renderList(); renderReady();
      } catch (err) {
        status.textContent = err && err.code === "quota_exceeded" ? "Not saved: browser storage is full. Delete old drafts in History, then save again." : "Not saved: browser storage is unavailable.";
      } finally { saveBtn.disabled = false; }
    });

    renderProof(); renderReady(); if (compact) paintSummary();
    [refs.kWhat, refs.kWho, refs.kProblem].forEach(c => c.input.addEventListener("input", () => autosize(c.input)));
    return { id: p.id, isNew: !!p._new, dirty: false, el, setStatus: t => { status.textContent = t; }, focus: focusField, startImport };
  }

  async function remove(p) {
    const unsaved = !S.products.some(x => x.id === p.id);
    if (!unsaved && !(await confirmDialog({ title: `Delete ${p.name || "this product"}?`, body: `This removes the product and its proof from ${store.whereFrom()}. Drafts already in History keep their text.`, confirmLabel: "Delete product", danger: true }))) return;
    try {
      if (!unsaved) await store.deleteProduct(p.id);
      draftProduct = null; sel = null; toast(unsaved ? "Discarded" : "Product deleted");
      select(S.products[0]?.id); renderList();
    } catch { toast("Couldn't delete: browser storage is unavailable."); }
  }

  store.subscribe(topic => {
    if (topic === "products" || topic === "ready") {
      renderList();
      if (!sel || (!sel.dirty && !draftProduct)) { const keep = sel?.id; select(S.products.some(p => p.id === keep) ? keep : S.products[0]?.id); }
    }
  });
  window.addEventListener("beforeunload", e => { if (sel?.dirty) { e.preventDefault(); e.returnValue = ""; } });

  return {
    init() { select(S.products[0]?.id); },
    show({ productId, focus, newProduct: np } = {}) {
      if (np) { guarded(() => newProduct()); return; }
      if (productId && sel?.id !== productId) guarded(() => select(productId));
      if (focus && sel) setTimeout(() => sel?.focus(focus), 0);
    },
  };
}
