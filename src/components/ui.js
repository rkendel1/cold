import { h } from "./dom.js";

const GLYPH = { good: "✓", warn: "!", bad: "✕", accent: "•", neutral: "" };

/** Status chip. Meaning is carried by the words and a glyph, never by colour alone. */
export function chip(kind, text, { glyph = true } = {}) {
  return h("span", { class: `chip ${kind}` }, glyph && GLYPH[kind] ? h("span", { "aria-hidden": "true" }, GLYPH[kind]) : null, text);
}

let fieldN = 0;
/** Labelled control. `control` is a function receiving the generated id so label/for and aria-describedby always match. */
export function field({ id: fixedId, label, hint, required, error, control, className = "" }) {
  const id = fixedId || `f${++fieldN}`;
  const hintId = hint ? `${id}-hint` : null;
  const errId = `${id}-err`;
  const input = control(id, [hintId, errId].filter(Boolean).join(" "));
  const described = (input.getAttribute("aria-describedby") || "").split(" ").filter(Boolean);
  [hintId, errId].forEach(x => { if (x && !described.includes(x)) described.push(x); });
  input.setAttribute("aria-describedby", described.join(" "));
  const wrap = h("div", { class: `field ${className}` },
    h("label", { for: id }, label, required === null ? null : required ? h("span", { class: "req" }, " Required") : h("span", { class: "opt" }, " Optional")),
    hint ? h("p", { class: "hint", id: hintId }, hint) : null,
    input,
    h("p", { class: "field-error", id: errId, hidden: true }));
  wrap.setError = msg => {
    const e = wrap.querySelector(".field-error");
    e.textContent = msg || ""; e.hidden = !msg;
    if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
  };
  wrap.input = input;
  return wrap;
}

export const textInput = (props = {}) => (id, describedby) => h("input", { type: "text", id, "aria-describedby": describedby, autocomplete: "off", ...props });
export const textArea = (props = {}) => (id, describedby) => h("textarea", { id, rows: 3, "aria-describedby": describedby, ...props });

export function button(label, { kind = "secondary", ...props } = {}) {
  return h("button", { type: "button", class: `btn ${kind}`, ...props }, label);
}

export function notice(kind, ...kids) {
  return h("div", { class: `notice ${kind}`, role: kind === "bad" ? "alert" : null }, ...kids);
}

/** Visually hidden live region for screen-reader announcements. */
let live;
export function announce(msg) {
  if (!live) { live = h("div", { class: "sr-only", role: "status", "aria-live": "polite", id: "announcer" }); document.body.append(live); }
  live.textContent = ""; setTimeout(() => { live.textContent = msg; }, 30);
}

let toastEl, toastT;
export function toast(msg) {
  if (!toastEl) { toastEl = h("div", { class: "toast", role: "status", "aria-live": "polite" }); document.body.append(toastEl); }
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { toastEl.hidden = true; }, 2600);
}
