const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MAILTO_MAX_LENGTH, isEmail, buildMailto, isSafeMailto } = require('../lib/mailto');

const parts = url => { const q = url.indexOf('?'); const p = new URLSearchParams(url.slice(q + 1).replace(/\+/g, '%2B')); return { to: decodeURIComponent(url.slice(7, q)), subject: p.get('subject'), body: p.get('body'), keys: [...p.keys()] }; };

test('a valid recipient, subject and body produce the expected handoff', () => {
  const r = buildMailto({ to: ' sam@trialco.com ', subject: 'trial drop-off', body: 'Hello there.' });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'mailto:sam@trialco.com?subject=trial%20drop-off&body=Hello%20there.');
});

test('Unicode and multi-line bodies round-trip, with CRLF line breaks as RFC 6068 asks', () => {
  const body = 'Hej Åsa,\n\nVi bygger “edge”-jobb — 日本語 🚀\r\nSista raden\rTack';
  const r = buildMailto({ to: 'åsa@exämple.se', subject: 'Frågor om kantdrift ✓', body });
  assert.equal(r.ok, true);
  const p = parts(r.url);
  assert.equal(p.to, 'åsa@exämple.se');
  assert.equal(p.subject, 'Frågor om kantdrift ✓');
  assert.equal(p.body, 'Hej Åsa,\r\n\r\nVi bygger “edge”-jobb — 日本語 🚀\r\nSista raden\r\nTack');
  assert.ok(r.url.includes('%0D%0A'));
  assert.ok(!/[ \n\r"“✓]/.test(r.url), 'the URL itself contains only percent-encoded or safe characters');
});

test('special characters cannot add parameters or recipients', () => {
  const r = buildMailto({ to: 'sam@trialco.com', subject: 'Re: A&B=C?bcc=evil@x.com#frag', body: 'x&cc=evil@x.com\nbody=injected&subject=changed?#' });
  assert.equal(r.ok, true);
  const p = parts(r.url);
  assert.deepEqual(p.keys, ['subject', 'body']);                                    // still exactly two parameters
  assert.equal(p.subject, 'Re: A&B=C?bcc=evil@x.com#frag');                         // the whole thing is subject text
  assert.equal(p.body, 'x&cc=evil@x.com\r\nbody=injected&subject=changed?#');
  assert.equal(r.url.split('?').length, 2); assert.ok(!r.url.includes('#'));
  // a subject cannot carry a line break (header injection); a body keeps its own
  assert.equal(parts(buildMailto({ to: 'a@b.co', subject: 'one\r\nBcc: evil@x.com', body: '' }).url).subject, 'one Bcc: evil@x.com');
  // recipients that try to smuggle more than one address or parameters are refused outright
  for (const bad of ['a@b.com?cc=x@y.com', 'a@b.com,c@d.com', 'a@b.com;c@d.com', 'a@b.com c@d.com', 'Sam <a@b.com>', 'a@b.com\nbcc:x@y.com', '"a b"@c.com'])
    assert.deepEqual(buildMailto({ to: bad, subject: 's', body: 'b' }), { ok: false, reason: 'invalid' }, bad);
});

test('the recipient is optional; one that is given must be valid; plausible unusual addresses are accepted', () => {
  // no address: the link opens a draft with an empty To line (not blocked, not blank: subject and body are filled in)
  assert.deepEqual(buildMailto({ to: '', subject: 'Hello there', body: 'Body text' }), { ok: true, url: 'mailto:?subject=Hello%20there&body=Body%20text', noRecipient: true });
  assert.deepEqual(buildMailto({ to: '   ', subject: 's', body: 'b' }), { ok: true, url: 'mailto:?subject=s&body=b', noRecipient: true });
  assert.deepEqual(buildMailto({ subject: 's', body: 'b' }), { ok: true, url: 'mailto:?subject=s&body=b', noRecipient: true });
  assert.equal(buildMailto({ to: 'sam@trialco.com', subject: 's', body: 'b' }).noRecipient, false);
  // but a typo is still caught, rather than opening a draft addressed to nobody real
  assert.deepEqual(buildMailto({ to: 'sam@', subject: 's', body: 'b' }), { ok: false, reason: 'invalid' });
  for (const bad of ['sam', 'sam@', '@trialco.com', 'sam@trialco', 'sam@@trialco.com', 'a@b.co?x=1', 'a@b.co#x', 'a@b.co/x', 'a@b_c.co', 'a@-b.co', 'sam..lee@trialco.com', '.sam@trialco.com', 'sam@trialco.c', 'sam@-trialco.com', 'sam@trialco..com', 'a'.repeat(65) + '@b.com', 'a@' + 'b'.repeat(250) + '.com'])
    assert.equal(isEmail(bad), false, bad);
  for (const ok of ['sam@trialco.com', 'sam.lee+cold@sub.trialco.co.uk', "o'brien@acme.io", 'x_y-z@a-b.dev', 'user@xn--bcher-kva.example', 'ünï@exämple.de'])
    assert.equal(isEmail(ok), true, ok);
});

test('a long message is never truncated: it is refused with its length, and the limit is exact', () => {
  const body = 'word '.repeat(600);                                                   // ~3,000 characters
  const r = buildMailto({ to: 'sam@trialco.com', subject: 's', body });
  assert.equal(r.ok, false); assert.equal(r.reason, 'too_long'); assert.equal(r.max, MAILTO_MAX_LENGTH); assert.ok(r.length > MAILTO_MAX_LENGTH);
  assert.ok(!('url' in r), 'no partial URL is offered');
  // find the longest body that fits and check every character survives
  let n = 100; while (buildMailto({ to: 'sam@trialco.com', subject: 's', body: 'a'.repeat(n + 1) }).ok) n++;
  const fits = buildMailto({ to: 'sam@trialco.com', subject: 's', body: 'a'.repeat(n) });
  assert.equal(fits.ok, true); assert.equal(fits.url.length <= MAILTO_MAX_LENGTH, true); assert.equal(parts(fits.url).body, 'a'.repeat(n));
});

test('isSafeMailto (the desktop gate) accepts only what buildMailto makes', () => {
  const good = buildMailto({ to: 'sam@trialco.com', subject: 'A&B', body: 'line1\nline2 日本' }).url;
  assert.equal(isSafeMailto(good), true);
  assert.equal(isSafeMailto('mailto:sam@trialco.com'), true);
  assert.equal(isSafeMailto('mailto:?subject=Hi&body=There'), true, 'a draft with no recipient is allowed');
  for (const bad of [
    'https://evil.test', 'javascript:alert(1)', 'file:///etc/passwd', 'tel:+15551234567', 'smb://host/share', 'x-apple.systempreferences:', 'MAILTO_NOT:a@b.com', '',
    'mailto:', 'mailto:not-an-email', 'mailto:?cc=x@y.com', 'mailto:?subject=a&bcc=x@y.com', 'mailto:?subject=a&subject=b', 'mailto:a@b.com,c@d.com', 'mailto:a@b.com?cc=x@y.com', 'mailto:a@b.com?bcc=x@y.com&subject=s', 'mailto:a@b.com?subject=s&subject=t',
    'mailto:a@b.com?subject=%E0%A4%A', 'mailto:a@b.com?subject=a b', 'mailto:a@b.com?subject=s\nbody=b', 'mailto:' + 'a'.repeat(3000) + '@b.com', null, undefined, 42, {}])
    assert.equal(isSafeMailto(bad), false, String(bad).slice(0, 60));
});

const { buildHandoff, isSafeHandoff, WEB_MAX_LENGTH, APPS } = require('../lib/mailto');

test('Gmail and Outlook compose links: exact shape, safe encoding, optional recipient and account, no truncation', () => {
  const g = buildHandoff({ app: 'gmail', to: 'sam@trialco.com', subject: 'Trial drop-off', body: 'Line one.\n\nLine two ✓' });
  assert.deepEqual(g, { ok: true, app: 'gmail', noRecipient: false, url: 'https://mail.google.com/mail/?view=cm&fs=1&to=sam%40trialco.com&su=Trial%20drop-off&body=Line%20one.%0A%0ALine%20two%20%E2%9C%93' });
  // no recipient: the compose window opens with an empty To
  assert.equal(buildHandoff({ app: 'gmail', subject: 'Hi', body: 'x' }).url, 'https://mail.google.com/mail/?view=cm&fs=1&su=Hi&body=x');
  assert.equal(buildHandoff({ app: 'gmail', subject: 'Hi', body: 'x' }).noRecipient, true);
  // more than one Google account: the chosen one is requested; something that isn't an address is ignored
  assert.match(buildHandoff({ app: 'gmail', subject: 'Hi', body: 'x', account: 'randy@kendelconsulting.com' }).url, /^https:\/\/mail\.google\.com\/mail\/\?authuser=randy%40kendelconsulting\.com&view=cm&fs=1&/);
  assert.ok(!buildHandoff({ app: 'gmail', subject: 'Hi', body: 'x', account: 'not an address&view=x' }).url.includes('authuser'));
  assert.equal(buildHandoff({ app: 'outlook', to: 'a@b.co', subject: 'S', body: 'B' }).url, 'https://outlook.live.com/mail/0/deeplink/compose?to=a%40b.co&subject=S&body=B');
  assert.equal(buildHandoff({ app: 'm365', to: 'a@b.co', subject: 'S', body: 'B' }).url, 'https://outlook.office.com/mail/deeplink/compose?to=a%40b.co&subject=S&body=B');
  // the default and unknown apps are the mailto link
  assert.equal(buildHandoff({ to: 'a@b.co', subject: 'S', body: 'B' }).url, 'mailto:a@b.co?subject=S&body=B');
  assert.equal(buildHandoff({ app: 'yahoo', to: 'a@b.co', subject: 'S', body: 'B' }).app, 'mailto');
  assert.deepEqual(APPS, ['mailto', 'gmail', 'outlook', 'm365']);
  // injection: nothing typed can add a parameter, a recipient or a second subject
  const evil = buildHandoff({ app: 'gmail', to: 'a@b.co', subject: 'x&to=evil@x.com&su=y#frag', body: 'b&bcc=evil@x.com\r\nmore' });
  const u = new URL(evil.url);
  assert.deepEqual([...u.searchParams.keys()], ['view', 'fs', 'to', 'su', 'body']);
  assert.equal(u.searchParams.get('to'), 'a@b.co'); assert.equal(u.searchParams.get('su'), 'x&to=evil@x.com&su=y#frag'); assert.equal(u.searchParams.get('body'), 'b&bcc=evil@x.com\nmore');
  assert.equal(u.hash, '');
  assert.equal(new URL(buildHandoff({ app: 'gmail', subject: 'one\r\nBcc: evil@x.com', body: '' }).url).searchParams.get('su'), 'one Bcc: evil@x.com');
  for (const bad of ['a@b.co?cc=x@y.com', 'a@b.co,c@d.co', 'sam@', 'Sam <a@b.co>']) assert.deepEqual(buildHandoff({ app: 'gmail', to: bad, subject: 's', body: 'b' }), { ok: false, reason: 'invalid' }, bad);
  // too long: refused with its length, never shortened; and the limit is exact
  const long = buildHandoff({ app: 'gmail', subject: 's', body: 'word '.repeat(2000) });
  assert.deepEqual([long.ok, long.reason, long.max], [false, 'too_long', WEB_MAX_LENGTH]); assert.ok(long.length > WEB_MAX_LENGTH && !('url' in long));
  let n = 100; while (buildHandoff({ app: 'gmail', subject: 's', body: 'a'.repeat(n + 1) }).ok) n++;
  const fits = buildHandoff({ app: 'gmail', subject: 's', body: 'a'.repeat(n) });
  assert.ok(fits.ok && fits.url.length <= WEB_MAX_LENGTH && new URL(fits.url).searchParams.get('body') === 'a'.repeat(n));
});

test('isSafeHandoff (the desktop gate) allows only the exact compose links and never look-alikes', () => {
  for (const app of ['gmail', 'outlook', 'm365', 'mailto']) assert.equal(isSafeHandoff(buildHandoff({ app, to: 'sam@trialco.com', subject: 'A&B', body: 'x\ny ✓', account: 'me@gmail.com' }).url), true, app);
  assert.equal(isSafeHandoff(buildHandoff({ app: 'gmail', subject: 's', body: 'b' }).url), true, 'no recipient');
  const ok = 'https://mail.google.com/mail/?view=cm&fs=1&to=a%40b.co&su=S&body=B';
  assert.equal(isSafeHandoff(ok), true);
  for (const bad of [
    'https://mail.google.com.evil.test/mail/?view=cm&fs=1&su=S&body=B', 'https://evil.test/mail.google.com/mail/?view=cm', 'https://mail.google.com@evil.test/mail/?view=cm&su=S',
    'http://mail.google.com/mail/?view=cm&fs=1&su=S&body=B', 'https://mail.google.com:8443/mail/?view=cm&su=S', 'https://user:pw@mail.google.com/mail/?view=cm&su=S',
    'https://mail.google.com/mail/u/0/?view=cm&su=S', 'https://mail.google.com/accounts/ServiceLogin?su=S', 'https://mail.google.com/mail/', 'https://mail.google.com/mail/?view=cm&su=S#x',
    'https://mail.google.com/mail/?view=om&fs=1&su=S', 'https://mail.google.com/mail/?view=cm&fs=1&cc=x@y.com&su=S', 'https://mail.google.com/mail/?view=cm&su=A&su=B',
    'https://mail.google.com/mail/?view=cm&to=a@b.co,c@d.co&su=S', 'https://mail.google.com/mail/?view=cm&to=nobody&su=S', 'https://mail.google.com/mail/?authuser=notanaddress&view=cm',
    'https://outlook.live.com.evil.test/mail/0/deeplink/compose?subject=S', 'https://outlook.live.com/mail/0/deeplink/compose?bcc=x@y.co', 'https://outlook.office.com/owa/?path=/mail/action/compose&subject=S',
    'javascript:alert(1)', 'file:///etc/passwd', 'ftp://mail.google.com/mail/?view=cm', 'https://mail.google.com/mail/?view=cm&su=a b', ok + '\n', '', null, undefined, 42, {},
    'https://accounts.google.com/o/oauth2/auth?client_id=x']) assert.equal(isSafeHandoff(bad), false, String(bad).slice(0, 70));
});
