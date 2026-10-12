const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

const rec = (o = {}) => ({ id: 'e1', createdAt: 1000, status: 'draft', mode: 'email', recipient: { name: 'Sam', company: 'TrialCo', email: 'sam@trialco.com' }, subject: 'trial drop-off', what: 'We help.', why: 'You wrote it.', ask: 'Could I ask?', ...o });

test('status changes only through applyStatus, never mutate, and never invent a send or a reply', async () => {
  const { applyStatus, statusOf, editedSinceSent } = await load('src/domain/outreach.js');
  const draft = rec();
  assert.equal(statusOf(draft), 'draft'); assert.equal(draft.sentAt, undefined);
  const sent = applyStatus(draft, 'sent', { now: 5000, signature: 'Randy' });
  assert.deepEqual([sent.status, sent.sentAt, sent.repliedAt], ['sent', 5000, undefined]);
  assert.equal(draft.status, 'draft'); assert.equal(draft.sentCopy, undefined);                       // input untouched
  assert.deepEqual(sent.sentCopy, { subject: 'trial drop-off', text: 'We help. You wrote it.\n\nCould I ask?\n\nRandy', at: 5000 });
  assert.equal(applyStatus(sent, 'sent', { now: 9999 }), sent, 'setting the same status is a no-op');
  const replied = applyStatus(sent, 'replied', { now: 7000 });
  assert.deepEqual([replied.status, replied.sentAt, replied.repliedAt, replied.sentCopy.at], ['replied', 5000, 7000, 5000]);
  // a reply recorded on a draft does not fabricate a send
  const direct = applyStatus(draft, 'replied', { now: 8000 });
  assert.deepEqual([direct.status, direct.sentAt, direct.sentCopy, direct.repliedAt], ['replied', undefined, undefined, 8000]);
  // correcting a mistake keeps the history; marking sent again is a new explicit action
  const back = applyStatus(sent, 'draft'); assert.deepEqual([back.status, back.sentAt, back.sentCopy.at], ['draft', 5000, 5000]);
  assert.equal(applyStatus(back, 'sent', { now: 6000 }).sentAt, 6000);
  assert.equal(applyStatus(draft, 'bogus'), draft);
  // the sent copy survives later edits, and edits are detectable
  const edited = { ...sent, what: 'Totally rewritten.' };
  assert.deepEqual([editedSinceSent(sent, 'Randy'), editedSinceSent(edited, 'Randy'), editedSinceSent(draft)], [false, true, false]);
  assert.equal(edited.status, 'sent'); assert.equal(edited.sentAt, 5000); assert.equal(edited.sentCopy.text.startsWith('We help.'), true);
});

test('filters, counts and search return the right records and tolerate missing fields', async () => {
  const { filterOutreach, countByStatus, preview } = await load('src/domain/outreach.js');
  const all = [
    rec({ id: 'a' }), rec({ id: 'b', status: 'sent', recipient: { name: 'Bo', company: 'BoCo' } }),
    rec({ id: 'c', status: 'replied', recipient: { name: '', company: '', email: 'cy@diaz.dev' }, note: 'Asked for pricing' }),
    { id: 'd', createdAt: 1, status: 'weird-old-value', recipient: {} },            // very old / odd record
    rec({ id: 't', mode: 'reply', status: 'sent', recipient: { name: 'Tweet reply' }, what: 'Nice point.', why: '', ask: '' }),
  ];
  assert.deepEqual(countByStatus(all), { all: 5, draft: 1, sent: 2, replied: 1, unknown: 1 });       // an unfamiliar status is counted as unknown, not as draft
  assert.deepEqual(filterOutreach(all, { status: 'sent' }).map(e => e.id), ['b', 't']);
  assert.deepEqual(filterOutreach(all, { status: 'replied' }).map(e => e.id), ['c']);
  assert.deepEqual(filterOutreach(all, { status: 'draft' }).map(e => e.id), ['a']);
  assert.deepEqual(filterOutreach(all, { status: 'unknown' }).map(e => e.id), ['d']);
  assert.deepEqual(filterOutreach(all, { query: 'cy@diaz' }).map(e => e.id), ['c']);               // search by email, even with no name
  assert.deepEqual(filterOutreach(all, { query: 'pricing' }).map(e => e.id), ['c']);               // and by note
  assert.deepEqual(filterOutreach(all, { status: 'sent', query: 'bo' }).map(e => e.id), ['b']);
  assert.equal(filterOutreach(all, { query: 'zzz' }).length, 0);
  assert.equal(preview(all[0]), 'We help. You wrote it. Could I ask?'); assert.equal(preview(all[4]), 'Nice point.');
  assert.ok(preview(rec({ what: 'x '.repeat(200) })).endsWith('…'));
  assert.equal(preview({ id: 'd' }), '');
});

test('older records load unchanged; notes and the sent copy are kept; nothing is invented', async () => {
  const { normalizeEmail } = await load('src/state/storage.js');
  const legacy = normalizeEmail({ id: 'old', createdAt: 5, status: 'sent', sentAt: 99, recipient: { name: 'Bo' }, subject: 's', what: 'w', why: 'y', ask: 'a' });
  assert.deepEqual([legacy.status, legacy.sentAt, legacy.note, legacy.sentCopy, legacy.repliedAt], ['sent', 99, '', undefined, undefined]);   // sent before sentCopy existed: none is made up
  const full = normalizeEmail({ id: 'n', note: 'Good fit: wrote about trials', sentCopy: { subject: 's', text: 'body', at: 7 }, status: 'replied', repliedAt: 8 });
  assert.deepEqual([full.note, full.sentCopy, full.repliedAt], ['Good fit: wrote about trials', { subject: 's', text: 'body', at: 7 }, 8]);
  assert.equal(normalizeEmail({ id: 'x', sentCopy: 'garbage' }).sentCopy, undefined);
  assert.equal(normalizeEmail({ id: 'y', sentCopy: [1, 2] }).sentCopy, undefined);
  assert.equal(normalizeEmail({ id: 'z', recipient: null }).status, 'draft');   // a MISSING status keeps the legacy default
  assert.equal(normalizeEmail({ id: 'z', recipient: null, status: 7 }).status, 7);   // an unfamiliar one is kept
});
