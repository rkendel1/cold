const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();   // local time
const rec = (o = {}) => ({ id: 'e1', status: 'draft', goal: 'advice', recipient: { name: 'Ana' }, subject: 'Hello', ...o });

test('follow-up settings: complete, in range, and defaults when nothing valid is stored', async () => {
  const F = await load('src/domain/followup.js');
  const d = F.normalizeFollowUpSettings();
  assert.deepEqual([d.enabled, d.hour, d.skipWeekends, d.repeatDays, d.max], [true, 9, true, 7, 3]);
  assert.equal(d.firstDays.investment, 7); assert.equal(d.firstDays.default, 3);
  const s = F.normalizeFollowUpSettings({ enabled: false, hour: 99, repeatDays: 0, max: 'x', firstDays: { advice: 200, customer: '5', bogus: 1 } });
  assert.deepEqual([s.enabled, s.hour, s.repeatDays, s.max, s.firstDays.advice, s.firstDays.customer], [false, 23, 1, 3, 60, 5]);
  assert.equal(s.firstDays.bogus, undefined);
  assert.deepEqual(F.normalizeFollowUpSettings(F.normalizeFollowUpSettings(s)), s, 'normalising is stable');
});

test('due dates: working days skip weekends, land at the chosen hour, and the first wait depends on the ask', async () => {
  const F = await load('src/domain/followup.js');
  // Thursday 10 Oct 2024 + 3 working days = Tuesday 15 Oct, 09:00
  assert.equal(F.dueAfter(at(2024, 10, 10), 3), at(2024, 10, 15, 9));
  assert.equal(F.dueAfter(at(2024, 10, 10), 3, { skipWeekends: false, hour: 14 }), at(2024, 10, 13, 14) , 'calendar days land on the weekend when weekends are not skipped');
  assert.equal(F.dueAfter(at(2024, 10, 11), 1, { skipWeekends: false }) , at(2024, 10, 12, 9));
  assert.equal(new Date(F.dueAfter(at(2024, 10, 11), 1, { skipWeekends: true })).getDay(), 1, 'a Friday + 1 working day is Monday');
  assert.equal(F.nextDue(rec({ goal: 'investment' }), {}, at(2024, 10, 10)), F.dueAfter(at(2024, 10, 10), 7));
  assert.equal(F.nextDue(rec({ goal: 'advice' }), { firstDays: { advice: 2 } }, at(2024, 10, 10)), F.dueAfter(at(2024, 10, 10), 2));
  assert.equal(F.nextDue(rec({ followUp: { count: 1 } }), {}, at(2024, 10, 10)), F.dueAfter(at(2024, 10, 10), 7), 'later follow-ups use the repeat interval');
});

test('copying or opening records a handoff and sets a follow-up, but never marks anything sent', async () => {
  const F = await load('src/domain/followup.js');
  const now = at(2024, 10, 10);
  const r = F.recordHandoff(rec(), 'copy', {}, now);
  assert.equal(r.status, 'draft'); assert.equal(r.sentAt, undefined); assert.equal(r.sentCopy, undefined);
  assert.deepEqual(r.handoffs, [{ at: now, how: 'copy' }]);
  assert.deepEqual(r.followUp, { due: F.dueAfter(now, 4), count: 0, auto: true });
  // a second copy keeps the date and adds the handoff; a date you set is never replaced
  const again = F.recordHandoff(r, 'open', {}, now + 5000);
  assert.equal(again.followUp.due, r.followUp.due); assert.equal(again.handoffs.length, 2);
  const mine = F.setDue(rec(), at(2024, 11, 1, 15));
  assert.equal(F.recordHandoff(mine, 'copy', {}, now).followUp.due, at(2024, 11, 1, 15));
  // off in settings, turned off for this draft, or replied: nothing is set
  assert.equal(F.recordHandoff(rec(), 'copy', { enabled: false }, now).followUp, undefined);
  assert.equal(F.recordHandoff(F.setDue(rec(), null), 'copy', {}, now).followUp.due, null);
  assert.equal(F.recordHandoff(rec({ status: 'replied' }), 'copy', {}, now).followUp, undefined);
  assert.equal(F.recordHandoff(rec(), 'bogus', {}, now).handoffs, undefined);
  assert.equal(F.recordHandoff(rec(), 'copy', {}, now).id, 'e1'); assert.equal(rec().handoffs, undefined, 'the input is not changed');
  const many = Array.from({ length: 30 }).reduce((x, _, i) => F.recordHandoff(x, 'copy', {}, now + i), rec());
  assert.equal(many.handoffs.length, F.MAX_HANDOFFS);
});

test('follow-up lifecycle: due, done and rescheduled up to the limit, snoozed, cleared, stopped by a reply, and marking sent restarts an automatic date', async () => {
  const F = await load('src/domain/followup.js'), O = await load('src/domain/outreach.js');
  const t0 = at(2024, 10, 10);
  let r = F.recordHandoff(rec(), 'copy', {}, t0);
  assert.equal(F.followUpState(r, t0), 'scheduled'); assert.equal(F.followUpState(r, r.followUp.due), 'due');
  assert.deepEqual(F.dueRecords([r, rec({ id: 'x' })], r.followUp.due + 1).map(x => x.id), ['e1']);
  const t1 = r.followUp.due;
  r = F.completeFollowUp(r, {}, t1); assert.equal(r.followUp.count, 1); assert.equal(r.followUp.due, F.dueAfter(t1, 7));
  r = F.completeFollowUp(r, {}, t1); r = F.completeFollowUp(r, {}, t1);
  assert.equal(r.followUp.count, 3); assert.equal(r.followUp.due, null); assert.equal(F.followUpState(r, t1), 'finished', 'stops at the limit');
  assert.equal(F.completeFollowUp(rec(), { max: 1 }, t0).followUp.due, null);
  // snooze counts from now, at the usual hour; a person's chosen date is no longer "automatic"
  const s = F.snooze(F.recordHandoff(rec(), 'copy', {}, t0), 1, {}, t0);
  assert.equal(s.followUp.due, F.dueAfter(t0, 1)); assert.equal(s.followUp.auto, false);
  // a reply stops it (and keeps the history); clearing turns it off for this draft
  const sent = O.applyStatus(F.recordHandoff(rec(), 'copy', {}, t0), 'sent', { now: t0 });
  const replied = O.applyStatus(sent, 'replied', { now: t0 });
  assert.equal(replied.followUp.due, null); assert.equal(F.followUpState(replied, t0), 'stopped'); assert.equal(replied.followUp.count, 0);
  assert.equal(F.followUpState(F.setDue(r, null), t0), 'finished');
  // marking sent later restarts an automatic follow-up from then, but never moves one you set
  const later = t0 + 3 * 86400000;
  const restarted = F.restartFromSent(O.applyStatus(F.recordHandoff(rec(), 'copy', {}, t0), 'sent', { now: later }), {}, later);
  assert.equal(restarted.followUp.due, F.dueAfter(later, 4));
  const chosen = F.setDue(F.recordHandoff(rec(), 'copy', {}, t0), at(2024, 12, 2, 10));
  assert.equal(F.restartFromSent(O.applyStatus(chosen, 'sent', { now: later }), {}, later).followUp.due, at(2024, 12, 2, 10));
});

test('a follow-up merges with concurrent edits as one unit, and is exported as a calendar entry', async () => {
  const F = await load('src/domain/followup.js'), O = await load('src/domain/outreach.js');
  const base = rec({ followUp: { due: 1000, count: 0 } });
  const a = { ...base, followUp: { due: 2000, count: 0 } }, b = { ...base, followUp: { due: 3000, count: 0 } };
  assert.deepEqual(O.mergeRecords(base, a, b).conflicts, ['followUp']);
  const ics = F.followUpIcs(rec({ recipient: { name: 'Ana; Ruiz' }, followUp: { due: Date.UTC(2024, 9, 15, 9) } }), Date.UTC(2024, 9, 10));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/); assert.match(ics, /DTSTART:20241015T090000Z/); assert.match(ics, /DTEND:20241015T091500Z/);
  assert.ok(ics.includes('SUMMARY:Follow up with Ana\\; Ruiz\r\n'), 'separators in names are escaped'); assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.equal(F.followUpIcs(rec()), '');
  const local = F.toLocalInput(at(2024, 10, 15, 9)); assert.equal(local, '2024-10-15T09:00'); assert.equal(F.fromLocalInput(local), at(2024, 10, 15, 9)); assert.equal(F.fromLocalInput(''), null);
});

test('unsent guidance (CX-004): only for a record still marked Draft with an active follow-up, from the real handoff, never an invented date', async () => {
  const F = await load('src/domain/followup.js');
  const day = ts => F.fmtDay(ts);
  const copied = rec({ handoffs: [{ at: at(2024, 10, 8), how: 'copy' }], followUp: { due: at(2024, 10, 14, 9), count: 0, auto: true } });
  assert.equal(F.unsentGuidance(copied), `You copied this on ${day(at(2024, 10, 8))}. Copying an email doesn't prove it was sent. If you haven't sent it, send it first, then mark it as sent.`);
  const opened = { ...copied, handoffs: [{ at: at(2024, 10, 7), how: 'copy' }, { at: at(2024, 10, 9), how: 'open' }] };
  assert.match(F.unsentGuidance(opened), new RegExp(`^You opened this in your email app on ${day(at(2024, 10, 9)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Opening an email doesn't prove it was sent\\. If you haven't sent it`), 'the LATEST handoff is described');
  const none = rec({ followUp: { due: at(2024, 10, 14), count: 0, auto: false } });
  assert.match(F.unsentGuidance(none), /^This is still marked Draft, so Cold has no record that it was sent\. If you haven't sent it/);
  assert.doesNotMatch(F.unsentGuidance(none), /copied|opened/, 'no handoff, so no invented date or action');
  for (const status of ['sent', 'replied', 'archived']) assert.equal(F.unsentGuidance({ ...copied, status }), null, `not shown for ${status}`);
  assert.equal(F.unsentGuidance(rec({ handoffs: copied.handoffs })), null, 'no follow-up, nothing to explain');
  assert.equal(F.unsentGuidance({ ...copied, followUp: { due: null, count: 1 } }), null, 'finished follow-ups say nothing');
  assert.equal(F.unsentGuidance({ ...copied, status: undefined }) !== null, true, 'a record with no status is a Draft');
});
