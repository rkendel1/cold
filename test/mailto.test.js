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

test('missing and invalid addresses are told apart; plausible unusual ones are accepted', () => {
  assert.deepEqual(buildMailto({ to: '', subject: 's', body: 'b' }), { ok: false, reason: 'missing' });
  assert.deepEqual(buildMailto({ to: '   ', subject: 's', body: 'b' }), { ok: false, reason: 'missing' });
  for (const bad of ['sam', 'sam@', '@trialco.com', 'sam@trialco', 'sam@@trialco.com', 'sam..lee@trialco.com', '.sam@trialco.com', 'sam@trialco.c', 'sam@-trialco.com', 'sam@trialco..com', 'a'.repeat(65) + '@b.com', 'a@' + 'b'.repeat(250) + '.com'])
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
  for (const bad of [
    'https://evil.test', 'javascript:alert(1)', 'file:///etc/passwd', 'tel:+15551234567', 'smb://host/share', 'x-apple.systempreferences:', 'MAILTO_NOT:a@b.com', '',
    'mailto:', 'mailto:not-an-email', 'mailto:a@b.com,c@d.com', 'mailto:a@b.com?cc=x@y.com', 'mailto:a@b.com?bcc=x@y.com&subject=s', 'mailto:a@b.com?subject=s&subject=t',
    'mailto:a@b.com?subject=%E0%A4%A', 'mailto:a@b.com?subject=a b', 'mailto:a@b.com?subject=s\nbody=b', 'mailto:' + 'a'.repeat(3000) + '@b.com', null, undefined, 42, {}])
    assert.equal(isSafeMailto(bad), false, String(bad).slice(0, 60));
});
