const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTweet } = require('twitter-text');
test('tweet weighted limit covers plain text, URLs, CJK and emoji', () => {
  assert.equal(parseTweet('a'.repeat(280)).valid, true);
  assert.equal(parseTweet('a'.repeat(281)).valid, false);
  assert.equal(parseTweet('https://example.com/very-long-path').weightedLength, 23);
  assert.equal(parseTweet('界'.repeat(140)).valid, true);
  assert.equal(parseTweet('界'.repeat(141)).valid, false);
  assert.equal(parseTweet('😀').weightedLength, 2);
});
