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
export const autosize = ta => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
