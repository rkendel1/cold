// Settings > Follow-ups: how long to wait before a follow-up reminder, how often, how many, and at what time. Smart defaults; every number can be changed.
import { h } from "../components/dom.js";
import { button, toast } from "../components/ui.js";
import { GOALS } from "../domain/constants.js";
import { FOLLOWUP_DEFAULTS, FOLLOWUP_LIMITS, normalizeFollowUpSettings } from "../domain/followup.js";

/* ---------- Follow-ups: when to be reminded to nudge someone ---------- */
export function followUpSection({ store, field }) {
  const S = store.state;
    const cur = normalizeFollowUpSettings(S.settings.followUp);
    const num = (id, v, [min, max]) => h("input", { type: "number", id, min, max, step: 1, value: v, inputmode: "numeric" });
    const on = h("input", { type: "checkbox", id: "fuOn" }), weekends = h("input", { type: "checkbox", id: "fuSkip" });
    const first = Object.fromEntries(["default", ...Object.keys(GOALS)].map(k => [k, num(`fuFirst-${k}`, cur.firstDays[k], FOLLOWUP_LIMITS.days)]));
    const repeat = num("fuRepeat", cur.repeatDays, FOLLOWUP_LIMITS.days), max = num("fuMax", cur.max, FOLLOWUP_LIMITS.max);
    const hour = h("select", { id: "fuHour" }, Array.from({ length: 24 }, (_, i) => h("option", { value: i }, `${String(i).padStart(2, "0")}:00`)));
    const msg = h("p", { class: "hint", role: "status", id: "fuMsg" });
    const show = c => { on.checked = c.enabled; weekends.checked = c.skipWeekends; hour.value = c.hour; repeat.value = c.repeatDays; max.value = c.max; for (const [k, i] of Object.entries(first)) i.value = c.firstDays[k]; };
    const read = () => normalizeFollowUpSettings({ enabled: on.checked, skipWeekends: weekends.checked, hour: hour.value, repeatDays: repeat.value, max: max.value, firstDays: Object.fromEntries(Object.entries(first).map(([k, i]) => [k, i.value])) });
    show(cur);
    const save = button("Save follow-up settings", { kind: "primary", id: "saveFollowUp", onclick: async () => {
      const next = read(); show(next);
      try { await store.saveSettings({ followUp: next }); msg.textContent = "Saved. New follow-ups use these. Dates already set stay as they are."; toast("Follow-up settings saved"); }
      catch { msg.textContent = "Couldn't save that."; }
    } });
    const reset = button("Use the defaults", { kind: "ghost", id: "resetFollowUp", onclick: () => { show(normalizeFollowUpSettings(FOLLOWUP_DEFAULTS)); msg.textContent = "Defaults filled in. Press Save to keep them."; } });
    return h("div", { class: "form", id: "followUpSettings" },
      h("label", { class: "check" }, on, " Set a follow-up reminder when I copy an email or open it in my email app"),
      h("p", { class: "hint" }, "Cold can't send email or see your inbox, so this is a reminder for you: it shows in History as “Follow-up due”, and you can add it to your calendar. Copying or opening a draft doesn't mark it sent. You can change or clear the date on any draft, and recording a reply stops it."),
      h("h3", {}, "Wait before the first follow-up"),
      h("p", { class: "hint" }, "In days (working days if weekends are skipped). Set by what you asked for, because some asks take longer to answer."),
      h("div", { class: "grid2" }, Object.entries(first).map(([k, i]) => field(k === "default" ? "Anything else" : GOALS[k].label, i))),
      h("h3", {}, "After that"),
      h("div", { class: "grid2" }, field("Follow up again every (days)", repeat), field("At most this many follow-ups", max)),
      h("div", { class: "grid2" }, field("Time of day", hour), h("div", { class: "field" }, h("label", { class: "check" }, weekends, " Skip weekends"))),
      h("div", { class: "actions" }, save, reset), msg);
  }
