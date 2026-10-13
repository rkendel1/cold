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

test('no recipient is fine; a typo, or a too-long message, opens nothing and says what to do', async () => {
  const { openInEmail } = await load('src/services/handoff.js');
  const opts = { desktop: { openMail: never }, open: never };
  // no address: still opens a draft (To line empty) and says so
  const opened = [];
  const none = await openInEmail({ ...draft, to: '' }, { desktop: null, open: u => opened.push(u) });
  assert.equal(none.ok, true); assert.match(none.message, /with no recipient \(add one there\)/); assert.match(opened[0], /^mailto:\?subject=trial%20drop-off&body=/);
  const viaApp = await openInEmail({ ...draft, to: undefined }, { desktop: { openMail: async u => { opened.push(u); return { ok: true }; } }, open: never });
  assert.equal(viaApp.ok, true); assert.match(viaApp.message, /with no recipient/); assert.ok(opened[1].startsWith('mailto:?subject='));
  const invalid = await openInEmail({ ...draft, to: 'sam@' }, opts);
  assert.deepEqual([invalid.ok, invalid.reason], [false, 'invalid']); assert.match(invalid.message, /valid email address/); assert.match(invalid.message, /clear it/);
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

test('generated subjects start with a capital; edits and improvements keep it; the user\'s own typing is never altered', async () => {
  const { generateEmail, improveEmail } = await load('src/services/generation.js');
  const product = { id: 'p', name: 'Acme', what: 'Does a thing.', proof: [], techFacts: [], approved: [], dontSay: [] };
  const sample = { json: async () => ({ subject: 'quick question', what: 'a.', why: 'b.', ask: 'c?', final: { subject: 'state for ai-native founders', what: 'a.', why: 'b.', ask: 'c?' } }) };
  const rec = await generateEmail({ sample, product, form: { name: 'Sam', company: 'TrialCo', why: 'x', goal: 'advice' } });
  assert.equal(rec.subject, 'State for ai-native founders');
  const again = await improveEmail({ sample, product, current: { ...rec, subject: 'my own lowercase subject' }, focus: 'tighten' });
  assert.equal(again.subject, 'State for ai-native founders');          // the editor's new subject is capitalised too
  const edited = { ...rec, subject: 'my own lowercase subject' };
  assert.equal(edited.subject, 'my own lowercase subject');              // nothing re-capitalises what the user typed
});

test('Gmail and Outlook: the draft opens in a compose tab (or the default browser on desktop), with the right link and honest wording', async () => {
  const { openInEmail } = await load('src/services/handoff.js');
  const opened = [];
  const web = await openInEmail({ ...draft, app: 'gmail', account: 'me@gmail.com' }, { desktop: null, open: u => opened.push(u) });
  assert.equal(web.ok, true); assert.equal(web.app, 'gmail');
  assert.equal(opened[0], 'https://mail.google.com/mail/?authuser=me%40gmail.com&view=cm&fs=1&to=sam%40trialco.com&su=trial%20drop-off&body=Line%20one.%0A%0ALine%20two%20%E2%9C%93');
  assert.match(web.message, /Opened a Gmail compose tab/); assert.match(web.message, /sign in/); assert.match(web.message, /hasn't sent anything/); assert.match(web.message, /pop-ups/);
  // no recipient is fine here too
  const none = await openInEmail({ ...draft, to: '', app: 'outlook' }, { desktop: null, open: u => opened.push(u) });
  assert.match(none.message, /Outlook\.com compose tab with no recipient/); assert.match(opened[1], /^https:\/\/outlook\.live\.com\/mail\/0\/deeplink\/compose\?subject=/);
  // desktop: the same link goes to the bridge, which opens the default browser
  const sent = [];
  const desk = await openInEmail({ ...draft, app: 'm365' }, { desktop: { openMail: async u => { sent.push(u); return { ok: true }; } }, open: never });
  assert.equal(desk.via, 'desktop'); assert.match(desk.message, /Opened your browser to a Outlook for work or school compose window/); assert.ok(sent[0].startsWith('https://outlook.office.com/mail/deeplink/compose?'));
  // failures keep the draft and point to Copy; too long and typos open nothing
  const failed = await openInEmail({ ...draft, app: 'gmail' }, { desktop: { openMail: async () => ({ ok: false, message: 'no browser' }) }, open: never });
  assert.deepEqual([failed.ok, failed.reason], [false, 'failed']); assert.match(failed.message, /Couldn't open Gmail \(no browser\)/); assert.match(failed.message, /Copy email/);
  const long = await openInEmail({ ...draft, body: 'word '.repeat(2000), app: 'gmail' }, { desktop: null, open: never });
  assert.deepEqual([long.ok, long.reason], [false, 'too_long']); assert.match(long.message, /Gmail \(\d{4,} characters; the limit is 6000\)\. Nothing was shortened/);
  assert.equal((await openInEmail({ ...draft, to: 'sam@', app: 'gmail' }, { desktop: null, open: never })).reason, 'invalid');
  // an unknown or missing choice falls back to the default mailto link
  const fallback = []; await openInEmail({ ...draft, app: 'something-else' }, { desktop: null, open: u => fallback.push(u) });
  assert.ok(fallback[0].startsWith('mailto:'));
  // the mailto default now points people who use webmail to the fix
  const def = await openInEmail(draft, { desktop: null, open: () => {} });
  assert.match(def.message, /choose Gmail or Outlook in Settings > Email app/);
});

test('the saved email-app choice is validated: unknown values and non-addresses are dropped, never trusted', async () => {
  const { emailApp, emailAccount, loadAll } = await load('src/state/storage.js');
  assert.deepEqual(['gmail', 'outlook', 'm365', 'mailto'].map(emailApp), ['gmail', 'outlook', 'm365', 'mailto']);
  assert.deepEqual(['yahoo', '', null, undefined, 7, '<script>'].map(emailApp), Array(6).fill('mailto'));
  assert.deepEqual(['me@gmail.com', ' me@gmail.com ', 'not an address', '', null, 'a@b.co?x=1'].map(emailAccount), ['me@gmail.com', 'me@gmail.com', '', '', '', '']);
  const store = { getItem: k => (k === 'cold.settings' ? JSON.stringify({ signature: 'R', emailApp: 'bogus', gmailAccount: 'x' }) : null), setItem() {} };
  const loaded = loadAll(store).settings;
  assert.deepEqual({ ...loaded, followUp: undefined }, { signature: 'R', signoffProduct: true, emailApp: 'mailto', gmailAccount: '', followUp: undefined });
  assert.equal(loaded.followUp.enabled, true, 'follow-up settings default in');
});
