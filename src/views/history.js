// History: your outreach as YOU have recorded it. Cold never sends mail and never observes replies, so "sent" and "replied" exist only
// when the user sets them. Copying, opening in an email app, generating and editing never change a status.
import { h, clear, fmtDate } from "../components/dom.js";
import { chip, button, toast, announce } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import { copyText } from "../services/clipboard.js";
import { openInEmail, isEmail } from "../services/handoff.js";
import { evaluate } from "../domain/rules.js";
import { emailText } from "../domain/email.js";
import { applyStatus, statusOf, filterOutreach, countByStatus, preview, editedSinceSent } from "../domain/outreach.js";
import { GOALS, STATUSES, STATUS_COPY, FORMATS } from "../domain/constants.js";

export function mountHistory(root, { store, openRecord }) {
  const S = store.state;
  let filter = "all", query = "";
  const openIds = new Set();            // rows whose details are showing (kept across re-renders)
  const messages = new Map();           // per-row status line, e.g. the result of "Open in email"
  let deferred = false;
  const filters = h("div", { class: "hfilters", role: "group", "aria-label": "Filter by status" });
  const search = h("input", { type: "search", id: "histSearch", "aria-label": "Search outreach", placeholder: "Search name, company, email, subject, notes" });
  const listHost = h("ul", { class: "hist", "aria-label": "Outreach" });
  search.addEventListener("input", () => { query = search.value.trim(); render(); });
  root.append(
    h("div", { class: "view-head" },
      h("h1", { id: "history-title", tabindex: "-1" }, "History"),
      h("p", { class: "lede" }, `Your outreach, as you've recorded it. Cold doesn't send email and can't see your inbox, so “Marked sent” and “Reply recorded” appear only when you set them: open a draft in your email app, send it yourself, then come back and mark it sent. History is stored ${store.where()}; it isn't synced to other devices.`)),
    h("div", { class: "hfilters" }, filters, search), listHost);

  const latest = id => S.emails.find(x => x.id === id);

  /** Save a changed copy of the freshest stored record (so a slow save can't overwrite a newer change), and keep Write's open draft in step. */
  async function save(id, change, failMsg) {
    const cur = latest(id); if (!cur) return false;
    const next = typeof change === "function" ? change(cur) : { ...cur, ...change };
    try {
      await store.saveEmail(next);
      if (S.current?.id === id) Object.assign(S.current, { status: next.status, sentAt: next.sentAt, repliedAt: next.repliedAt, sentCopy: next.sentCopy, note: next.note, recipient: next.recipient });
      return true;
    } catch { toast(failMsg || "Couldn't save that change."); render(); return false; }
  }
  /** The user's explicit record of what happened: the only way a status changes. */
  async function setStatus(e, st) {
    if (await save(e.id, cur => applyStatus(cur, st, { signature: S.settings.signature }), "Couldn't update the status.")) { toast(`Status set to “${STATUS_COPY[st].label}”`); announce(`Status set to ${STATUS_COPY[st].label}`); }
  }

  const timers = new Map();
  function saveLater(id, change) { clearTimeout(timers.get(id)); timers.set(id, setTimeout(() => save(id, change), 600)); }
  const flush = id => { if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); } };

  async function emailIt(e, toInput, msgEl, expand) {
    const cur = latest(e.id) || e;
    const r = await openInEmail({ to: toInput ? toInput.value : cur.recipient?.email, subject: cur.subject, body: emailText(cur, S.settings.signature) });
    messages.set(e.id, r.message); if (msgEl) msgEl.textContent = r.message; else render();
    announce(r.message);
    if (!r.ok && (r.reason === "missing" || r.reason === "invalid")) { openIds.add(e.id); expand(); }
  }

  /** Adds a hook class (used by tests and styles) without losing the button's own classes. */
  const tag = (el, cls) => { el.classList.add(cls); return el; };
  const statusChip = st => chip(st === "draft" ? "neutral" : st === "sent" ? "accent" : "good", STATUS_COPY[st].label, { glyph: st !== "draft" });

  function row(e) {
    const st = statusOf(e), isSocial = e.mode && e.mode !== "email";
    const goal = e.goal === "other" ? (e.goalOther || "Other") : GOALS[e.goal]?.label || "";
    const name = isSocial ? FORMATS[e.mode]?.label || "Tweet" : e.recipient?.name || "Unnamed";
    const score = !isSocial ? (Number.isFinite(e.score) ? e.score : evaluate(e, store.productById(e.productId)).score) : null;
    const dates = [`Created ${fmtDate(e.createdAt)}`, e.updatedAt && fmtDate(e.updatedAt) !== fmtDate(e.createdAt) ? `updated ${fmtDate(e.updatedAt)}` : "",
      e.sentAt && st !== "draft" ? `marked sent ${fmtDate(e.sentAt)}` : "", e.repliedAt && st === "replied" ? `reply recorded ${fmtDate(e.repliedAt)}` : ""].filter(Boolean).join(" · ");
    const sel = h("select", { "aria-label": `Status for ${e.recipient?.name || "draft"} (you set this)`, class: "hStatus" }, STATUSES.map(s => h("option", { value: s, selected: st === s }, STATUS_COPY[s].label)));
    sel.addEventListener("change", () => setStatus(e, sel.value));

    /* details: address, notes, and the text as it was when marked sent */
    const toIn = h("input", { type: "email", class: "hTo", "aria-label": `Email address for ${e.recipient?.name || "this draft"}`, value: e.recipient?.email || "", placeholder: "name@company.com", autocomplete: "off" });
    const toMsg = h("p", { class: "field-error" });
    toIn.addEventListener("input", () => {
      const v = toIn.value.trim(), bad = !!v && !isEmail(v); toMsg.textContent = bad ? "That doesn't look like a valid email address." : ""; toIn.toggleAttribute("aria-invalid", bad);
      saveLater(e.id, cur => ({ ...cur, recipient: { ...cur.recipient, email: v } }));
    });
    const noteIn = h("textarea", { class: "hNote", rows: 3, "aria-label": `Notes for ${e.recipient?.name || "this draft"}`, placeholder: "Why they fit, what you actually sent, what the reply said, what to follow up on…" }); noteIn.value = e.note || "";
    noteIn.addEventListener("input", () => saveLater(e.id, { note: noteIn.value }));
    for (const el of [toIn, noteIn]) { el.dataset.keep = "1"; el.addEventListener("blur", () => flush(e.id)); }
    const edited = editedSinceSent(e, S.settings.signature);
    const details = h("div", { class: "hdetails", hidden: !openIds.has(e.id) },
      isSocial ? null : h("div", { class: "field" }, h("label", {}, "Email address ", h("span", { class: "opt" }, "Optional")), toIn, toMsg),
      h("div", { class: "field" }, h("label", {}, "Notes ", h("span", { class: "opt" }, "Optional, only for you")), noteIn),
      e.sentCopy ? h("div", { class: "field" }, h("strong", {}, "Text when you marked it sent"), h("p", { class: "hint" }, `Saved ${fmtDate(e.sentCopy.at)}. Cold's copy of the text at that moment${edited ? "; you've edited the draft since" : ""}. Not proof of what your email app sent.`), isSocial ? null : h("p", {}, h("strong", {}, "Subject: "), e.sentCopy.subject), h("p", { class: "preline" }, e.sentCopy.text)) : null);
    const toggle = button("Notes & details", { kind: "ghost", "aria-expanded": String(openIds.has(e.id)), onclick: () => {
      const show = details.hidden; details.hidden = !show; toggle.setAttribute("aria-expanded", String(show)); show ? openIds.add(e.id) : openIds.delete(e.id);
    } }); tag(toggle, "hToggle");
    const msg = h("p", { class: "hint hmsg", role: "status" }, messages.get(e.id) || "");
    const del = button("Delete", { kind: "ghost danger", onclick: async () => {
      if (!(await confirmDialog({ title: "Delete this draft?", body: `This removes it from History on ${store.whereFrom()}. It can't be undone.`, confirmLabel: "Delete draft", danger: true }))) return;
      if (S.current?.id === e.id) store.set({ current: null }, "current");
      store.deleteEmail(e.id).then(() => toast("Draft deleted")).catch(() => toast("Couldn't delete the draft."));
    } });
    const nextStep = st === "draft" ? tag(button("Mark sent", { title: "Only after you've sent it yourself", onclick: () => setStatus(e, "sent") }), "hMarkSent")
      : st === "sent" ? tag(button("Record reply", { title: "Only when a reply has arrived", onclick: () => setStatus(e, "replied") }), "hRecordReply") : null;

    return h("li", { class: "hrow", dataset: { id: e.id } },
      h("div", { class: "minw0" },
        h("div", { class: "who" }, name, " ", h("span", { class: "sub" }, isSocial ? "" : [e.recipient?.role, e.recipient?.company].filter(Boolean).join(", "))),
        h("div", { class: "sub" }, [!isSocial && e.recipient?.email, e.productName, goal, dates].filter(Boolean).join(" · ")),
        h("div", { class: "subject" }, isSocial ? "" : e.subject),
        h("div", { class: "preview" }, preview(e)),
        e.note ? h("div", { class: "hnote" }, h("strong", {}, "Note: "), e.note) : null),
      h("div", { class: "ctl" }, statusChip(st), score != null ? h("span", { class: "hint", title: "Style checklist score. Not a prediction of replies." }, `Checklist ${score}`) : null, nextStep, sel,
        isSocial ? null : tag(button("Open in email", { onclick: () => emailIt(e, toIn, msg, () => { details.hidden = false; toggle.setAttribute("aria-expanded", "true"); toIn.focus(); }) }), "hEmail"),
        button("Copy", { onclick: async () => toast((await copyText(emailText(e, S.settings.signature))) ? "Copied to clipboard" : "Couldn't copy automatically.") }),
        button("Open", { title: "Reopen and edit this draft", onclick: () => openRecord(e) }), toggle, del),
      msg, details);
  }

  function render() {
    const all = [...S.emails].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const counts = countByStatus(all);
    clear(filters);
    ["all", ...STATUSES].forEach(s => filters.append(h("button", { type: "button", class: "btn", "aria-pressed": String(filter === s), onclick: () => { filter = s; render(); } }, s === "all" ? "All" : STATUS_COPY[s].label, h("span", { class: "mono" }, ` ${counts[s]}`))));
    const rows = filterOutreach(all, { status: filter, query });
    clear(listHost);
    if (!all.length) { listHost.append(h("li", { class: "empty" }, h("h2", {}, "No drafts yet"), h("p", {}, "Every draft you generate is saved here automatically as a draft. You decide when it counts as sent."), button("Write one", { kind: "primary", id: "hGo", onclick: () => openRecord(null) }))); return; }
    if (!rows.length) { listHost.append(h("li", { class: "empty" }, h("p", {}, query ? "No drafts match your search." : `Nothing is marked “${STATUS_COPY[filter]?.label || filter}” yet.`))); return; }
    rows.forEach(e => listHost.append(row(e)));
  }

  // Saving a note re-renders the list; don't pull the text box out from under someone who is typing in it.
  const typing = () => listHost.contains(document.activeElement) && document.activeElement.dataset.keep === "1";
  listHost.addEventListener("focusout", () => { if (deferred) setTimeout(() => { if (!typing()) { deferred = false; render(); } }, 0); });
  store.subscribe(topic => { if (!["emails", "ready", "settings"].includes(topic)) return; if (typing()) { deferred = true; return; } render(); });
  return { init: render, render };
}
