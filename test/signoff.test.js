const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = rel => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

const FELT = { id: 'p1', name: 'FeltDB', website: 'https://feltdb.com', xHandle: '@feltdb', repo: 'https://github.com/feltdb/feltdb', socials: ['LinkedIn: https://linkedin.com/company/feltdb', 'https://docs.feltdb.com'] };

test('the sign-off is your name plus the selected details from the product profile, formatted', async () => {
  const { signoffBlock, signoffLinks, linkKey } = await load('src/domain/signoff.js');
  const settings = { signature: 'Randy Kendel', signoffProduct: true };
  assert.equal(signoffBlock({ settings, product: FELT }), ['Randy Kendel', 'FeltDB', 'https://feltdb.com', 'X: @feltdb', 'Repository: https://github.com/feltdb/feltdb', 'LinkedIn: https://linkedin.com/company/feltdb', 'Link: https://docs.feltdb.com'].join('\n'));
  // a different product brings its own details; one with none leaves just the name
  assert.equal(signoffBlock({ settings, product: { name: 'Acme', xHandle: '@acme' } }), 'Randy Kendel\nAcme\nX: @acme');
  assert.equal(signoffBlock({ settings, product: { name: 'Bare' } }), 'Randy Kendel');
  // unchecked links stay out; unchecking everything leaves just the name
  const skip = signoffLinks(FELT).filter(([l]) => l === 'Repository' || l === 'Link').map(linkKey);
  assert.equal(signoffBlock({ settings, product: { ...FELT, signoffSkip: skip } }), 'Randy Kendel\nFeltDB\nhttps://feltdb.com\nX: @feltdb\nLinkedIn: https://linkedin.com/company/feltdb');
  assert.equal(signoffBlock({ settings, product: { ...FELT, signoffSkip: signoffLinks(FELT).map(linkKey) } }), 'Randy Kendel');
  // the global switch, a multi-line name, and no name at all
  assert.equal(signoffBlock({ settings: { ...settings, signoffProduct: false }, product: FELT }), 'Randy Kendel');
  assert.equal(signoffBlock({ settings: { signature: 'Randy Kendel\nFounder' }, product: { name: 'Acme', website: 'https://acme.dev' } }), 'Randy Kendel\nFounder\nAcme\nhttps://acme.dev');
  assert.equal(signoffBlock({ settings: { signature: '  ' }, product: FELT }), '', 'no name, no sign-off (a block of links alone is not a sign-off)');
  assert.equal(signoffBlock({ settings: undefined, product: undefined }), '');
  assert.equal(signoffBlock({ settings: { signature: 'R' }, product: null }), 'R');
});

test('subjects start with a capital letter; the rest is left as written', async () => {
  const { capitalizeFirst } = await load('src/domain/email.js');
  assert.deepEqual(['trial drop-off', 'quick question', 'Already Fine', 'état des lieux', '  spaced out', '3 ideas', '', null, undefined, 'ünïcode'].map(capitalizeFirst),
    ['Trial drop-off', 'Quick question', 'Already Fine', 'État des lieux', '  Spaced out', '3 ideas', '', '', '', 'Ünïcode']);
});
