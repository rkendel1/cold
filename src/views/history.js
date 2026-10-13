// History: your outreach as YOU have recorded it. Cold never sends mail and never observes replies, so "sent" and "replied" exist only
// when the user sets them. Copying, opening in an email app, generating and editing never change a status.
import { h, clear, fmtDate } from "../components/dom.js";
import { chip, button, toast, announce } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import { copyText } from "../services/clipboard.js";
import { openInEmail, isEmail } from "../services/handoff.js";
import { evaluate } from "../domain/rules.js";
import { emailText } from "../domain/email.js";
import { applyStatus, statusOf, filterOutreach, productFilterOptions, countByStatus, preview, editedSinceSent } from "../domain/outreach.js";
import { compareEmails } from "../domain/library.js";
import { recordHandoff, restartFromSent, followUpState, dueRecords, fmtDue } from "../domain/followup.js";
import { followUpPanel } from "./followUpPanel.js";
import { GOALS, STATUSES, STATUS_COPY, FORMATS, UNKNOWN_STATUS } from "../domain/constants.js";

export function mountHistory(root, { store, openRecord }) {
  const S = store.state;
  let filter = "all", query = "", product = "all";
  const openIds = new Set();            // rows whose details are showing (kept across re-renders)
  const messages = new Map();           // per-row status line, e.g. the result of "Open in email"
  const held = new Map();               // id -> the user's own text from a save that was refused because the record changed elsewhere
  let deferred = false, settling = false;   // settling: a box was just left; hold the redraw so the click that moved focus still lands
  const filters = h("div", { class: "hfilters", role: "group", "aria-label": "Filter by status" });
  const search = h("input", { type: "search", id: "histSearch", "aria-label": "Search outreach", placeholder: "Search name, company, email, subject, notes" });
  const productSel = h("select", { id: "histProduct", "aria-label": "Filter by product" });
  productSel.addEventListener("change", () => { product = productSel.value; render(); });
  const listHost = h("ul", { class: "hist", "aria-label": "Outreach" });
  search.addEventListener("input", () => { query = search.value.trim(); render(); });
  const lede = h("p", { class: "lede" });
  const paintLede = () => { lede.textContent = `Your outreach, as you've recorded it. Cold doesn't send email and can't see your inbox, so “Marked sent” and “Reply recorded” appear only when you set them: open a draft in your email app, send it yourself, then come back and mark it sent. History ${store.keptNote()}`; };
  paintLede();
  root.append(
    h("div", { class: "view-head" },
      h("h1", { id: "history-title", tabindex: "-1" }, "History"),
      lede),
    h("div", { class: "hfilters" }, filters, productSel, search), listHost);

  const latest = id => S.emails.find(x => x.id === id);

  /** Save a changed copy of the freshest stored record (so a slow save can't overwrite a newer change), and keep Write's open draft in step. */
  async function save(id, change, failMsg) {
    const cur = latest(id); if (!cur) return false;
    const next = typeof change === "function" ? change(cur) : { ...cur, ...change };
    try {
      await store.saveEmail(next);
      held.delete(id); messages.delete(id);
      // Keep the draft open in Write in step, but only with what THIS change altered: it may hold text (a note, an edit) that is still
      // waiting to be saved, and a stale copy from here must never overwrite it.
      if (S.current?.id === id) for (const k of Object.keys(next)) if (JSON.stringify(next[k]) !== JSON.stringify(cur[k])) S.current[k] = next[k];
      return true;
    } catch (err) {
      if (err && err.code === "conflict") {
        // The stored (newer) record stays; the user's text stays in the box so nothing they typed is lost. Saving it again is their decision.
        const mine = err.mine || {};
        held.set(id, { note: err.conflicts.includes("note") ? mine.note : undefined, email: err.conflicts.includes("recipient.email") ? (mine.recipient || {}).email : undefined });
        messages.set(id, "Not saved: this was changed somewhere else, so the newer version was kept. Your text is still in the box; change it again to replace the newer version.");
        openIds.add(id); toast("Not saved: changed somewhere else. Your text is still here."); render(); return false;
      }
      toast(failMsg || "Couldn't save that change."); render(); return false;
    }
  }
  /** The user's explicit record of what happened: the only way a status changes. */
  async function setStatus(e, st) {
    if (!STATUSES.includes(st)) return;   // "Unknown status" is not something the user can set; only a supported status is a deliberate correction
    if (await save(e.id, cur => restartFromSent(applyStatus(cur, st, { signature: store.signoffFor(cur) }), S.settings.followUp), "Couldn't update the status.")) { toast(`Status set to “${STATUS_COPY[st].label}”`); announce(`Status set to ${STATUS_COPY[st].label}`); }
  }

  const timers = new Map();   // id -> { t, run }: the change waiting for its 600 ms pause
  function saveLater(id, change) {
    const prev = timers.get(id); if (prev) clearTimeout(prev.t);
    const run = () => { timers.delete(id); save(id, change); };
    timers.set(id, { t: setTimeout(run, 600), run });
  }
  /** Leaving a box saves what was typed in it now; it must never throw the edit away. */
  const flush = id => { const p = timers.get(id); if (p) { clearTimeout(p.t); p.run(); } };

  async function emailIt(e, toInput, msgEl, expand) {
    const cur = latest(e.id) || e;
    const r = await openInEmail({ to: toInput ? toInput.value : cur.recipient?.email, subject: cur.subject, body: emailText(cur, store.signoffFor(cur)), app: S.settings.emailApp, account: S.settings.gmailAccount });
    // a successful handoff records itself and sets a follow-up if none is set (never marks it sent); saving redraws the row, so the message is kept for the redraw
    const saved = r.ok ? await save(e.id, c => recordHandoff(c, "open", S.settings.followUp)) : false;
    messages.set(e.id, r.message); if (msgEl && msgEl.isConnected && !saved) msgEl.textContent = r.message; else render();
    announce(r.message);
    if (!r.ok && r.reason === "invalid") { openIds.add(e.id); expand(); }
  }

  /** Adds a hook class (used by tests and styles) without losing the button's own classes. */
  const tag = (el, cls) => { el.classList.add(cls); return el; };
  const statusChip = st => chip(st === "draft" || st === UNKNOWN_STATUS ? "neutral" : st === "sent" ? "accent" : "good", STATUS_COPY[st].label, { glyph: st !== "draft" && st !== UNKNOWN_STATUS });

  function row(e) {
    const st = statusOf(e), isSocial = e.mode && e.mode !== "email";
    const goal = e.goal === "other" ? (e.goalOther || "Other") : GOALS[e.goal]?.label || "";
    const name = isSocial ? FORMATS[e.mode]?.label || "Tweet" : e.recipient?.name || "Unnamed";
    const score = !isSocial ? (Number.isFinite(e.score) ? e.score : evaluate(e, store.productById(e.productId)).score) : null;
    const dates = [`Created ${fmtDate(e.createdAt)}`, e.updatedAt && fmtDate(e.updatedAt) !== fmtDate(e.createdAt) ? `updated ${fmtDate(e.updatedAt)}` : "",
      e.sentAt && st !== "draft" ? `marked sent ${fmtDate(e.sentAt)}` : "", e.repliedAt && st === "replied" ? `reply recorded ${fmtDate(e.repliedAt)}` : ""].filter(Boolean).join(" · ");
    const sel = h("select", { "aria-label": `Status for ${e.recipient?.name || "draft"} (you set this)`, class: "hStatus" }, (st === UNKNOWN_STATUS ? [UNKNOWN_STATUS, ...STATUSES] : STATUSES).map(s => h("option", { value: s, selected: st === s, title: s === UNKNOWN_STATUS ? STATUS_COPY[s].detail : undefined }, STATUS_COPY[s].label)));
    sel.addEventListener("change", () => setStatus(e, sel.value));

    /* details: address, notes, and the text as it was when marked sent */
    const toIn = h("input", { type: "email", class: "hTo", "aria-label": `Email address for ${e.recipient?.name || "this draft"}`, value: (held.get(e.id)?.email ?? e.recipient?.email) || "", placeholder: "name@company.com", autocomplete: "off" });
    const toMsg = h("p", { class: "field-error" });
    toIn.addEventListener("input", () => {
      const v = toIn.value.trim(), bad = !!v && !isEmail(v); toMsg.textContent = bad ? "That doesn't look like a valid email address." : ""; toIn.toggleAttribute("aria-invalid", bad);
      saveLater(e.id, cur => ({ ...cur, recipient: { ...cur.recipient, email: v } }));
    });
    const noteIn = h("textarea", { class: "hNote", rows: 3, "aria-label": `Notes for ${e.recipient?.name || "this draft"}`, placeholder: "Why they fit, what you actually sent, what the reply said, what to follow up on…" }); noteIn.value = (held.get(e.id)?.note ?? e.note) || "";
    noteIn.addEventListener("input", () => saveLater(e.id, { note: noteIn.value }));
    for (const el of [toIn, noteIn]) { el.dataset.keep = "1"; el.addEventListener("blur", () => { settling = true; flush(e.id); setTimeout(() => { settling = false; if (deferred && !typing()) { deferred = false; render(); } }, 400); }); }
    const edited = editedSinceSent(e, store.signoffFor(e)), fuState = isSocial ? "none" : followUpState(e);
    const fu = isSocial ? null : followUpPanel({ getRec: () => latest(e.id) || e, getSettings: () => S.settings.followUp, announce, apply: fn => save(e.id, fn, "Couldn't save the follow-up.") });
    const details = h("div", { class: "hdetails", hidden: !openIds.has(e.id) },
      fu ? h("div", { class: "field" }, h("strong", {}, "Follow up"), fu.el) : null,
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
        fuState === "due" || fuState === "scheduled" ? h("div", { class: "sub fu-line" }, fuState === "due" ? h("strong", {}, "Follow-up due: ") : "Follow up ", fmtDue(e.followUp.due)) : null,
        e.note ? h("div", { class: "hnote" }, h("strong", {}, "Note: "), e.note) : null),
      h("div", { class: "ctl" }, statusChip(st), score != null ? h("span", { class: "hint", title: "Style checklist score. Not a prediction of replies." }, `Checklist ${score}`) : null, nextStep, sel,
        isSocial ? null : tag(button("Open in email", { onclick: () => emailIt(e, toIn, msg, () => { details.hidden = false; toggle.setAttribute("aria-expanded", "true"); toIn.focus(); }) }), "hEmail"),
        button("Copy", { onclick: async () => { const ok = await copyText(emailText(e, store.signoffFor(e))); toast(ok ? "Copied to clipboard" : "Couldn't copy automatically."); if (ok && !isSocial) save(e.id, c => recordHandoff(c, "copy", S.settings.followUp)); } }),
        button("Open", { title: "Reopen and edit this draft", onclick: () => openRecord(e) }), toggle, del),
      msg, details);
  }

  function render() {
    const all = [...S.emails].sort(compareEmails);
    paintLede();
    const counts = countByStatus(all);
    clear(filters);
    const dueN = dueRecords(all.filter(x => !(x.mode && x.mode !== "email"))).length;
    if (filter === "due" && !dueN) filter = "all";
    if (dueN) filters.append(h("button", { type: "button", class: "btn", id: "fDue", "aria-pressed": String(filter === "due"), onclick: () => { filter = filter === "due" ? "all" : "due"; render(); } }, "Follow-up due", h("span", { class: "mono" }, ` ${dueN}`)));
    ["all", ...STATUSES, ...(counts[UNKNOWN_STATUS] ? [UNKNOWN_STATUS] : [])].forEach(s => filters.append(h("button", { type: "button", class: "btn", "aria-pressed": String(filter === s), onclick: () => { filter = s; render(); } }, s === "all" ? "All" : STATUS_COPY[s].label, h("span", { class: "mono" }, ` ${counts[s]}`))));
    const opts = productFilterOptions(all, S.products);
    if (product !== "all" && !opts.some(o => o.value === product)) product = "all";
    clear(productSel).append(h("option", { value: "all" }, "All products"), ...opts.map(o => h("option", { value: o.value }, o.label)));
    productSel.value = product; productSel.hidden = opts.length < 2 && product === "all";
    const rows = filter === "due" ? filterOutreach(dueRecords(all), { query, product }) : filterOutreach(all, { status: filter, query, product });
    clear(listHost);
    if (!all.length) { listHost.append(h("li", { class: "empty" }, h("h2", {}, "No drafts yet"), h("p", {}, "Every draft you generate is saved here automatically as a draft. You decide when it counts as sent."), button("Write one", { kind: "primary", id: "hGo", onclick: () => openRecord(null) }))); return; }
    if (!rows.length) { listHost.append(h("li", { class: "empty" }, h("p", {}, query || product !== "all" ? "No drafts match your search or filter." : `Nothing is marked “${STATUS_COPY[filter]?.label || filter}” yet.`))); return; }
    rows.forEach(e => listHost.append(row(e)));
  }

  // Saving a note re-renders the list; don't pull the text box out from under someone who is typing in it.
  const typing = () => listHost.contains(document.activeElement) && document.activeElement.dataset.keep === "1";
  listHost.addEventListener("focusout", () => { if (deferred) setTimeout(() => { if (!typing()) { deferred = false; render(); } }, 0); });
  store.subscribe(topic => { if (!["emails", "ready", "settings"].includes(topic)) return; if (typing() || settling) { deferred = true; return; } render(); });
  return { init: render, render };
}
