import { h } from "./dom.js";

/** Accessible confirm dialog built on <dialog>. Resolves true only on explicit confirmation. */
export function confirmDialog({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise(resolve => {
    const dlg = h("dialog", { "aria-labelledby": "dlg-title", class: "dialog" },
      h("form", { method: "dialog", class: "dialog-body" },
        h("h2", { id: "dlg-title" }, title),
        body ? h("p", {}, body) : null,
        h("div", { class: "dialog-actions" },
          h("button", { type: "submit", value: "cancel", class: "btn ghost" }, cancelLabel),
          h("button", { type: "submit", value: "ok", class: `btn ${danger ? "danger-solid" : "primary"}` }, confirmLabel))));
    dlg.addEventListener("close", () => { const ok = dlg.returnValue === "ok"; dlg.remove(); resolve(ok); });
    document.body.append(dlg);
    if (typeof dlg.showModal === "function") dlg.showModal(); else { resolve(globalThis.confirm(`${title}\n${body || ""}`)); dlg.remove(); }
    dlg.querySelector('button[value="cancel"]')?.focus();
  });
}

/** Single-textarea dialog (used for the sign-off). Resolves with the text, or null when cancelled. */
export function promptDialog({ title, hint, value = "", saveLabel = "Save" }) {
  return new Promise(resolve => {
    const ta = h("textarea", { id: "dlg-input", rows: 3, "aria-describedby": "dlg-hint" });
    ta.value = value;
    const dlg = h("dialog", { "aria-labelledby": "dlg-title", class: "dialog" },
      h("form", { method: "dialog", class: "dialog-body" },
        h("h2", { id: "dlg-title" }, title),
        h("label", { for: "dlg-input" }, "Text"),
        h("p", { class: "hint", id: "dlg-hint" }, hint), ta,
        h("div", { class: "dialog-actions" },
          h("button", { type: "submit", value: "cancel", class: "btn ghost" }, "Cancel"),
          h("button", { type: "submit", value: "ok", class: "btn primary" }, saveLabel))));
    dlg.addEventListener("close", () => { const v = dlg.returnValue === "ok" ? ta.value.trim() : null; dlg.remove(); resolve(v); });
    document.body.append(dlg); dlg.showModal(); ta.focus();
  });
}
