// Tiny DOM helpers. Text is always set with text nodes, never innerHTML, so user content cannot inject markup.
const PROPS = new Set(["value", "checked", "selected", "disabled", "hidden", "indeterminate"]);

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const fmtDate = ts => ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
/**
 * Grows a textarea to fit its text. It is not enough to measure once: a box measured while its view is hidden reads as 0
 * tall, and a box measured at one width clips its text when the window later narrows. So it re-fits whenever its width changes.
 */
const fitted = new WeakSet();
const fit = ta => { ta.style.height = "auto"; const h = ta.scrollHeight; if (h > 0) ta.style.height = `${h + (ta.offsetHeight - ta.clientHeight)}px`; };   // + borders: heights are border-box
export const autosize = ta => {
  fit(ta);
  if (fitted.has(ta) || typeof ResizeObserver === "undefined") return;
  fitted.add(ta);
  let width = -1;
  new ResizeObserver(() => { const w = ta.clientWidth; if (!w) { width = -1; return; } if (w !== width) { width = w; fit(ta); } }).observe(ta);   // 0 = hidden: forget the width so showing it again re-fits
};

/** Focus an element that may sit inside collapsed <details> groups (Settings, Knowledge): open them first so it is actually reachable. */
export function revealAndFocus(id) {
  const el = typeof id === "string" ? document.getElementById(id) : id;
  if (!el) return false;
  for (let d = el.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) d.open = true;
  el.focus(); if (el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  return true;
}
