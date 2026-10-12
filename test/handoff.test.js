const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

const draft = { to: 'sam@trialco.com', subject: 'trial drop-off', body: 'Line one.\n\nLine two ✓' };
const never = () => { throw new Error('must not open anything'); };

test('browser handoff: opens a mailto link with the exact current text, and never claims to have sent or opened', async () => {
  const { openInEmail } = await load('src/services/handoff.js');
  const opened = [];
  const r = await openInEmail(draft, { desktop: null, open: u => opened.push(u) });
  assert.equal(r.ok, true); assert.equal(r.via, 'browser'); assert.equal(opened.length, 1);
  assert.match(opened[0], /^mailto:sam@trialco\.com\?subject=trial%20drop-off&body=Line%20one\.%0D%0A%0D%0ALine%20two%20%E2%9C%93$/);
  assert.match(r.message, /hasn't sent anything/); assert.match(r.message, /If nothing opened/);
  assert.doesNotMatch(r.message, /\b(sent!|was sent|has been sent|email sent)\b/i);
});

test('desktop handoff: success is reported by the OS; failure and exceptions keep the draft and point to Copy', async () => {
  const { openInEmail } = await load('src/services/handoff.js');
  const calls = [];
  const ok = await openInEmail(draft, { desktop: { openMail: async u => { calls.push(u); return { ok: true }; } }, open: never });
  assert.deepEqual([ok.ok, ok.via, calls.length], [true, 'desktop', 1]);
  assert.match(ok.message, /Opened a draft in your email app/); assert.match(ok.message, /hasn't sent anything/);
  const refused = await openInEmail(draft, { desktop: { openMail: async () => ({ ok: false, message: 'no handler' }) }, open: never });
  assert.deepEqual([refused.ok, refused.reason], [false, 'failed']); assert.match(refused.message, /no handler/); assert.match(refused.message, /Copy email/);
  const threw = await openInEmail(draft, { desktop: { openMail: async () => { throw new Error('ipc down'); } }, open: never });
  assert.deepEqual([threw.ok, threw.reason], [false, 'failed']); assert.match(threw.message, /Copy email/);
  const noReply = await openInEmail(draft, { desktop: { openMail: async () => undefined }, open: never });
  assert.equal(noReply.reason, 'failed');
  const browserThrows = await openInEmail(draft, { desktop: null, open: () => { throw new Error('blocked'); } });
  assert.deepEqual([browserThrows.ok, browserThrows.reason], [false, 'failed']);
});

test('nothing opens for a missing, invalid or too-long message, and each says what to do', async () => {
  const { openInEmail } = await load('src/services/handoff.js');
  const opts = { desktop: { openMail: never }, open: never };
  const missing = await openInEmail({ ...draft, to: '' }, opts);
  assert.deepEqual([missing.ok, missing.reason], [false, 'missing']); assert.match(missing.message, /Add the recipient's email address/);
  const invalid = await openInEmail({ ...draft, to: 'sam@' }, opts);
  assert.deepEqual([invalid.ok, invalid.reason], [false, 'invalid']); assert.match(invalid.message, /valid email address/);
  const long = await openInEmail({ ...draft, body: 'x '.repeat(2000) }, opts);
  assert.deepEqual([long.ok, long.reason], [false, 'too_long']); assert.match(long.message, /Nothing was shortened/); assert.match(long.message, /Copy email/); assert.match(long.message, /\d{4} characters/);
});

test('the recipient address is stored with the draft, survives normalisation, and older drafts still load', async () => {
  const { normalizeEmail } = await load('src/state/storage.js');
  const { generateEmail } = await load('src/services/generation.js');
  assert.equal(normalizeEmail({ id: 'e1', recipient: { name: 'Sam', email: 'sam@trialco.com' } }).recipient.email, 'sam@trialco.com');
  assert.equal(normalizeEmail({ id: 'old', recipient: { name: 'Sam', company: 'X', why: 'y' } }).recipient.email, '');       // saved before this field existed
  assert.equal(normalizeEmail({ id: 'odd', recipient: { email: 42 } }).recipient.email, '42');                               // tolerant, never throws
  const product = { id: 'p', name: 'Acme', what: 'Does a thing.', proof: [], techFacts: [], approved: [], dontSay: [] };
  const sample = { json: async () => ({ subject: 's', what: 'a.', why: 'b.', ask: 'c?', final: { subject: 's', what: 'a.', why: 'b.', ask: 'c?' } }) };
  const rec = await generateEmail({ sample, product, form: { name: 'Sam', company: 'TrialCo', why: 'x', goal: 'advice', email: '  sam@trialco.com ' } });
  assert.equal(rec.recipient.email, 'sam@trialco.com');
  const none = await generateEmail({ sample, product, form: { name: 'Sam', company: 'TrialCo', why: 'x', goal: 'advice' } });
  assert.equal(none.recipient.email, '');
});
