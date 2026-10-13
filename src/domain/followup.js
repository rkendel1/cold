// Follow-ups: when to nudge someone you wrote to. Cold can't see your inbox, so a follow-up is a reminder YOU can change, never something Cold
// sends. It starts when you hand a draft off (copy it, or open it in your email app) or mark it sent, and stops when you record a reply.
// Settings are a few numbers with sensible defaults; every date can be changed on the draft.
import { GOALS } from "./constants.js";

const DAY = 86400000;
export const MAX_HANDOFFS = 20;

/** The defaults: first nudge after a few working days (longer for the asks that take longer to answer), then weekly, up to three, at 9:00, never on a weekend. */
export const FOLLOWUP_DEFAULTS = Object.freeze({
  enabled: true, hour: 9, skipWeekends: true, repeatDays: 7, max: 3,
  firstDays: { default: 3, advice: 4, introduction: 3, customer: 3, investment: 7, partnership: 5, other: 5 },
});
export const FOLLOWUP_LIMITS = { days: [1, 60], max: [1, 10], hour: [0, 23] };

const int = (v, [lo, hi], d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && String(v).trim() !== "" ? Math.min(hi, Math.max(lo, n)) : d; };
/** Settings as stored (anything, or nothing) -> a complete, in-range set. Unknown or invalid values fall back to the defaults. */
export function normalizeFollowUpSettings(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}, d = FOLLOWUP_DEFAULTS;
  const first = r.firstDays && typeof r.firstDays === "object" ? r.firstDays : {};
  return {
    enabled: r.enabled !== false, hour: int(r.hour, FOLLOWUP_LIMITS.hour, d.hour), skipWeekends: r.skipWeekends !== false,
    repeatDays: int(r.repeatDays, FOLLOWUP_LIMITS.days, d.repeatDays), max: int(r.max, FOLLOWUP_LIMITS.max, d.max),
    firstDays: Object.fromEntries(["default", ...Object.keys(GOALS)].map(k => [k, int(first[k], FOLLOWUP_LIMITS.days, d.firstDays[k] ?? d.firstDays.default)])),
  };
}

/** `days` after `from`, at `hour` local time; with skipWeekends the days are working days and a Saturday or Sunday result moves to Monday. */
export function dueAfter(from, days, { hour = 9, skipWeekends = true } = {}) {
  const d = new Date(from);
  if (skipWeekends) { let left = days; while (left > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) left--; } }
  else d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  if (skipWeekends) { if (d.getDay() === 6) d.setDate(d.getDate() + 2); else if (d.getDay() === 0) d.setDate(d.getDate() + 1); }
  return d.getTime();
}

const daysFor = (s, goal, count) => (count > 0 ? s.repeatDays : s.firstDays[goal] ?? s.firstDays.default);
/** When the next follow-up for this record falls due if started at `from`: the first by goal, later ones by the repeat interval. */
export const nextDue = (rec, settings, from = Date.now()) => {
  const s = normalizeFollowUpSettings(settings);
  return dueAfter(from, daysFor(s, rec && rec.goal, (rec && rec.followUp && rec.followUp.count) || 0), s);
};

const fu = rec => (rec && rec.followUp && typeof rec.followUp === "object" ? rec.followUp : null);
/** none (nothing set) | scheduled | due (the date has passed) | finished (all follow-ups done) | stopped (they replied). */
export function followUpState(rec, now = Date.now()) {
  const f = fu(rec);
  if (rec && rec.status === "replied") return "stopped";
  if (!f) return "none";
  if (f.due == null) return f.count > 0 ? "finished" : "none";
  return f.due <= now ? "due" : "scheduled";
}
export const isDue = (rec, now = Date.now()) => followUpState(rec, now) === "due";

/**
 * The record after you copy it or open it in your email app. This records WHAT HAPPENED (a handoff), never that it was sent. If follow-ups are
 * on and none is set yet, one is scheduled; a date you already set or changed is left alone.
 */
export function recordHandoff(rec, how, settings, now = Date.now()) {
  if (!rec || (how !== "copy" && how !== "open")) return rec;
  const handoffs = [...(Array.isArray(rec.handoffs) ? rec.handoffs : []), { at: now, how }].slice(-MAX_HANDOFFS);
  const next = { ...rec, handoffs };
  const s = normalizeFollowUpSettings(settings), f = fu(rec);
  if (s.enabled && rec.status !== "replied" && !(f && (f.due != null || f.count > 0 || f.off))) next.followUp = { due: nextDue(rec, s, now), count: 0, auto: true };
  return next;
}
/** Marking it sent is a better starting point than the copy: an automatic follow-up (not one you chose) moves to count from the send. */
export function restartFromSent(rec, settings, now = Date.now()) {
  const s = normalizeFollowUpSettings(settings), f = fu(rec);
  if (!s.enabled || rec.status !== "sent" || (f && (f.off || (f.due != null && !f.auto) || f.count > 0))) return rec;
  return { ...rec, followUp: { due: nextDue({ ...rec, followUp: null }, s, now), count: 0, auto: true } };
}
/** A reply ends it: the date is cleared, the history of nudges is kept. */
export const stopForReply = rec => (fu(rec) && fu(rec).due != null ? { ...rec, followUp: { ...fu(rec), due: null } } : rec);

/** You chose a date and time yourself (a number of ms), or null to clear it and turn off automatic follow-ups for this draft. */
export function setDue(rec, due) {
  const f = fu(rec) || { count: 0 };
  if (due == null) return { ...rec, followUp: { ...f, due: null, off: true, auto: false } };
  return { ...rec, followUp: { ...f, due, off: false, auto: false } };
}
/** Push the date back by `days` from now (not from the old date), at the usual hour. */
export const snooze = (rec, days, settings, now = Date.now()) => setDue(rec, dueAfter(now, days, normalizeFollowUpSettings(settings)));

/** You sent a follow-up: count it, and schedule the next one until the limit. */
export function completeFollowUp(rec, settings, now = Date.now()) {
  const s = normalizeFollowUpSettings(settings), f = fu(rec) || { count: 0 }, count = (f.count || 0) + 1;
  const base = { ...f, count, lastAt: now, off: false };
  if (count >= s.max || !s.enabled) return { ...rec, followUp: { ...base, due: null } };
  return { ...rec, followUp: { ...base, due: nextDue({ ...rec, followUp: { count } }, s, now), auto: true } };
}

/** Records waiting on you, soonest first. */
export const dueRecords = (emails, now = Date.now()) => emails.filter(e => isDue(e, now)).sort((a, b) => fu(a).due - fu(b).due);

/** "Mon 14 Oct, 09:00". */
export const fmtDue = ts => new Date(ts).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** The value for a datetime-local box (local time, no zone) and back. */
export const toLocalInput = ts => { const d = new Date(ts), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
export const fromLocalInput = v => { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };

/** A calendar entry (.ics) for the follow-up, so your own calendar can remind you. Nothing is sent anywhere. */
export function followUpIcs(rec, now = Date.now()) {
  const f = fu(rec); if (!f || f.due == null) return "";
  const esc = t => String(t || "").replace(/[\\;,]/g, m => `\\${m}`).replace(/\r?\n/g, "\\n");
  const stamp = ts => new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const who = (rec.recipient && (rec.recipient.name || rec.recipient.company)) || "your contact";
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Cold//Follow-up//EN", "BEGIN:VEVENT", `UID:followup-${rec.id}-${f.due}@cold`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(f.due)}`, `DTEND:${stamp(f.due + 15 * 60000)}`,
    `SUMMARY:${esc(`Follow up with ${who}`)}`, `DESCRIPTION:${esc(rec.subject ? `About: ${rec.subject}` : "Follow up on your email")}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}
export { DAY };
