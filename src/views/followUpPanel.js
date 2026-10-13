// The follow-up controls for one draft, the same on Write and History: when it's due, change the date and time, "I sent a follow-up",
// snooze, clear, and add it to your own calendar. Cold only reminds: it never sends a follow-up, and it can't see whether you did.
import { h, clear } from "../components/dom.js";
import { button } from "../components/ui.js";
import { followUpState, normalizeFollowUpSettings, nextDue, fmtDue, toLocalInput, fromLocalInput, setDue, snooze, completeFollowUp, followUpIcs } from "../domain/followup.js";

function downloadIcs(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** `apply(fn)` takes a function from the record to the changed record, saves it, and resolves true when it was saved. */
export function followUpPanel({ getRec, getSettings, apply, announce = () => {} }) {
  const el = h("div", { class: "followup", role: "group", "aria-label": "Follow-up" });
  const act = async (fn, said) => { if (await apply(fn)) { paint(); announce(said); } };
  function paint() {
    const rec = getRec(), s = normalizeFollowUpSettings(getSettings()), st = followUpState(rec), f = rec.followUp || {};
    const of = f.count != null ? Math.min((f.count || 0) + 1, s.max) : 1;
    const line = h("p", { class: "fu-state", role: "status" });
    if (st === "due") line.append(h("strong", {}, "Follow-up due."), ` It was due ${fmtDue(f.due)}. This is follow-up ${of} of ${s.max}.`);
    else if (st === "scheduled") line.append(h("strong", {}, "Follow-up set:"), ` ${fmtDue(f.due)}${f.auto ? " (set automatically)" : ""}. Follow-up ${of} of ${s.max}.`);
    else if (st === "stopped") line.textContent = "They replied, so there are no more follow-ups for this one.";
    else if (st === "finished") line.textContent = `All ${f.count} follow-up${f.count === 1 ? "" : "s"} done. Set another date below if you want one more.`;
    else line.textContent = f.off ? "No follow-up for this draft." : s.enabled ? "No follow-up yet. One is set when you copy this or open it in your email app." : "Follow-ups are off in Settings. You can still set a date for this one.";
    clear(el).append(line);
    if (st === "stopped") return;
    const when = h("input", { type: "datetime-local", class: "fu-when", "aria-label": "Follow-up date and time", value: toLocalInput(f.due != null ? f.due : nextDue(rec, s)) });
    const row = h("div", { class: "actions" }, when,
      button(f.due != null ? "Change date" : "Set follow-up", { class: "fu-set", onclick: () => { const t = fromLocalInput(when.value); if (t == null) return when.focus(); act(r => setDue(r, t), "Follow-up date saved"); } }));
    if (f.due != null) row.append(
      button("I sent a follow-up", { class: "fu-done", title: "Counts it and sets the next one, up to your limit", onclick: () => act(r => completeFollowUp(r, getSettings()), "Follow-up recorded") }),
      button("Snooze 1 day", { kind: "ghost", class: "fu-snooze", onclick: () => act(r => snooze(r, 1, getSettings()), "Snoozed one day") }),
      button("Snooze 1 week", { kind: "ghost", class: "fu-snooze7", onclick: () => act(r => snooze(r, 7, getSettings()), "Snoozed one week") }),
      button("Add to calendar", { kind: "ghost", class: "fu-ics", onclick: () => downloadIcs("cold-follow-up.ics", followUpIcs(getRec())) }),
      button("No follow-up", { kind: "ghost", class: "fu-clear", onclick: () => act(r => setDue(r, null), "Follow-up cleared") }));
    el.append(row);
  }
  paint();
  return { el, paint };
}
