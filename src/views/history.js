// History: drafts and what the user has recorded about them. Cold never sends mail and never observes replies.
import { h, clear, fmtDate } from "../components/dom.js";
import { chip, button, toast } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import { copyText } from "../services/clipboard.js";
import { evaluate } from "../domain/rules.js";
import { emailText } from "../domain/email.js";
import { GOALS, STATUSES, STATUS_COPY, FORMATS } from "../domain/constants.js";

export function mountHistory(root, { store, openRecord }) {
  const S = store.state;
  let filter = "all", query = "";
  const filters = h("div", { class: "hfilters", role: "group", "aria-label": "Filter by status" });
  const search = h("input", { type: "search", id: "histSearch", "aria-label": "Search drafts", placeholder: "Search name, company, subject" });
  const listHost = h("ul", { class: "hist", "aria-label": "Drafts" });
  search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); render(); });
  root.append(
    h("div", { class: "view-head" },
      h("h1", { id: "history-title", tabindex: "-1" }, "History"),
      h("p", { class: "lede" }, "Drafts you've generated and what you've recorded about them. Cold doesn't send email and can't see your inbox, so “Marked sent” and “Reply recorded” appear only when you set them. History is saved in this browser only, not backed up or synced.")),
    h("div", { class: "hfilters" }, filters, search), listHost);

  async function setStatus(e, st) {
    const next = { ...e, status: st };
    if (st === "sent" && !next.sentAt) next.sentAt = Date.now();
    if (st === "replied" && !next.repliedAt) next.repliedAt = Date.now();
    try { await store.saveEmail(next); toast(`Status set to “${STATUS_COPY[st].label}”`); if (S.current?.id === e.id) { S.current.status = st; S.current.sentAt = next.sentAt; S.current.repliedAt = next.repliedAt; } }
    catch { toast("Couldn't update the status: browser storage is unavailable."); render(); }
  }

  const statusOf = e => (STATUSES.includes(e.status) ? e.status : "draft");
  const statusChip = st => chip(st === "draft" ? "neutral" : st === "sent" ? "accent" : "good", STATUS_COPY[st].label, { glyph: st !== "draft" });

  function render() {
    const all = [...S.emails].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const counts = { all: all.length }; STATUSES.forEach(s => { counts[s] = all.filter(e => statusOf(e) === s).length; });
    clear(filters);
    ["all", ...STATUSES].forEach(s => filters.append(h("button", { type: "button", class: "btn", "aria-pressed": String(filter === s), onclick: () => { filter = s; render(); } }, s === "all" ? "All" : STATUS_COPY[s].label, h("span", { class: "mono" }, ` ${counts[s]}`))));
    const rows = all.filter(e => (filter === "all" || statusOf(e) === filter) && (!query || [e.recipient?.name, e.recipient?.company, e.subject, e.productName, e.what].join(" ").toLowerCase().includes(query)));
    clear(listHost);
    if (!all.length) { listHost.append(h("li", { class: "empty" }, h("h2", {}, "No drafts yet"), h("p", {}, "Every draft you generate is saved here automatically as a draft. You decide when it counts as sent."), button("Write one", { kind: "primary", id: "hGo", onclick: () => openRecord(null) }))); return; }
    if (!rows.length) { listHost.append(h("li", { class: "empty" }, h("p", {}, query ? "No drafts match your search." : `Nothing is marked “${STATUS_COPY[filter]?.label || filter}” yet.`))); return; }
    rows.forEach(e => {
      const st = statusOf(e), isSocial = e.mode && e.mode !== "email";
      const goal = e.goal === "other" ? (e.goalOther || "Other") : GOALS[e.goal]?.label || "";
      const sel = h("select", { "aria-label": `Status for ${e.recipient?.name || "draft"} (you set this)`, class: "hStatus" }, STATUSES.map(s => h("option", { value: s, selected: st === s }, STATUS_COPY[s].label)));
      sel.addEventListener("change", () => setStatus(e, sel.value));
      const score = !isSocial ? (Number.isFinite(e.score) ? e.score : evaluate(e, store.productById(e.productId)).score) : null;
      const dates = [`Created ${fmtDate(e.createdAt)}`, e.sentAt && st !== "draft" ? `marked sent ${fmtDate(e.sentAt)}` : "", e.repliedAt && st === "replied" ? `reply recorded ${fmtDate(e.repliedAt)}` : ""].filter(Boolean).join(" · ");
      let armed = false;
      const del = button("Delete", { kind: "ghost danger", onclick: async () => {
        if (!(await confirmDialog({ title: "Delete this draft?", body: "This removes it from History in this browser. It can't be undone.", confirmLabel: "Delete draft", danger: true }))) return;
        if (S.current?.id === e.id) store.set({ current: null }, "current");
        store.deleteEmail(e.id).then(() => toast("Draft deleted")).catch(() => toast("Couldn't delete the draft."));
      } });
      void armed;
      listHost.append(h("li", { class: "hrow", dataset: { id: e.id } },
        h("div", { class: "minw0" },
          h("div", { class: "who" }, isSocial ? FORMATS[e.mode]?.label || "Tweet" : e.recipient?.name || "Unnamed", " ", h("span", { class: "sub" }, isSocial ? "" : [e.recipient?.role, e.recipient?.company].filter(Boolean).join(", "))),
          h("div", { class: "sub" }, [e.productName, goal, dates].filter(Boolean).join(" · ")),
          h("div", { class: "subject" }, isSocial ? e.what : e.subject)),
        h("div", { class: "ctl" }, statusChip(st), score != null ? h("span", { class: "hint", title: "Style checklist score. Not a prediction of replies." }, `Checklist ${score}`) : null, sel,
          button("Copy", { onclick: async () => toast((await copyText(emailText(e, S.settings.signature))) ? "Copied to clipboard" : "Couldn't copy automatically.") }),
          button("Open", { onclick: () => openRecord(e) }), del)));
    });
  }

  store.subscribe(topic => { if (["emails", "ready", "settings"].includes(topic)) render(); });
  return { init: render, render };
}
