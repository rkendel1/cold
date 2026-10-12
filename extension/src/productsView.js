// Products inside the extension: enough to write from the page without the app. Proof points, do-not-say rules and the rest
// are edited in the Cold app and come across when it syncs.
import { h, clear } from "../../src/components/dom.js";
import { button, field, textInput, textArea, toast, chip } from "../../src/components/ui.js";
import { readiness, normalizeHandle } from "../../src/domain/knowledge.js";
import { uid } from "../../src/domain/ids.js";

export function mountProductsView(root, { store }) {
  const S = store.state;
  const list = h("div", { class: "x-stack" });
  const editor = h("div", { class: "x-stack" });
  root.append(h("div", { class: "x-stack" }, h("p", { class: "hint" }, "The products Cold writes about. Add the basics here; proof points and do-not-say rules are edited in the Cold app and sync across."), list, editor));

  function renderList() {
    clear(list);
    if (!S.products.length) list.append(h("p", {}, "No products yet. Add the one you want to write about."));
    for (const p of S.products) {
      const r = readiness(p);
      list.append(h("div", { class: "x-card" }, h("h2", {}, p.name || "Untitled"), h("p", { class: "hint" }, p.what || "No description yet."),
        r.ready ? chip("good", "Ready to write from") : chip("bad", `Needs ${r.blocking.map(b => b.label.toLowerCase()).join(" and ")}`),
        h("div", { class: "actions" }, button("Edit", { onclick: () => edit(p) }))));
    }
    list.append(h("div", { class: "actions" }, button("Add a product", { kind: "primary", id: "addProduct", onclick: () => edit(null) })));
  }

  function edit(p) {
    clear(editor);
    const f = {
      name: field({ id: "pName", label: "Product name", required: true, control: textInput({ value: p ? p.name : "" }) }),
      what: field({ id: "pWhat", label: "What it does, in one plain sentence", required: true, control: textArea({ rows: 2 }) }),
      who: field({ id: "pWho", label: "Who it's for", required: null, control: textArea({ rows: 2 }) }),
      problem: field({ id: "pProblem", label: "Problem it solves", required: null, control: textArea({ rows: 2 }) }),
      website: field({ id: "pSite", label: "Website", required: null, control: textInput({ value: p ? p.website : "", placeholder: "https://" }) }),
      x: field({ id: "pX", label: "X handle", required: null, control: textInput({ value: p ? p.xHandle : "", placeholder: "@yourproduct" }) }),
      links: field({ id: "pLinks", label: "Other links", required: null, hint: "One per line: Label: link", control: textArea({ rows: 2 }) }),
    };
    f.what.input.value = p ? p.what : ""; f.who.input.value = p ? p.who : ""; f.problem.input.value = p ? p.problem : ""; f.links.input.value = p ? (p.socials || []).join("\n") : "";
    const val = c => c.input.value.trim();
    const save = async () => {
      let ok = true;
      if (!val(f.name)) { f.name.setError("Name the product."); ok = false; } else f.name.setError("");
      if (!val(f.what)) { f.what.setError("Say what it does in one sentence."); ok = false; } else f.what.setError("");
      if (!ok) return;
      const base = p || { id: uid("p"), order: S.products.length, proof: [], techFacts: [], approved: [], dontSay: [] };
      try {
        await store.saveProduct({ ...base, name: val(f.name), what: val(f.what), who: val(f.who), problem: val(f.problem), website: val(f.website), xHandle: normalizeHandle(val(f.x)), socials: f.links.input.value.split("\n").map(s => s.trim()).filter(Boolean) });
        clear(editor); toast("Product saved");
      } catch { toast("Couldn't save the product."); }
    };
    editor.append(h("div", { class: "x-card" }, h("h2", {}, p ? "Edit product" : "New product"), f.name, f.what, f.who, f.problem, f.website, f.x, f.links,
      h("div", { class: "actions" }, button("Save product", { kind: "primary", id: "saveProduct", onclick: save }), button("Cancel", { kind: "ghost", onclick: () => clear(editor) }))));
    f.name.input.focus();
  }

  store.subscribe(t => { if (t === "products" || t === "ready") renderList(); });
  renderList();
}
