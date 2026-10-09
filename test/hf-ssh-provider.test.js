const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { generate } = require('../scripts/hf-ssh-provider.cjs');
function mock(output, code = 0) {
  return (cmd, args, opts) => {
    assert.equal(cmd, 'ssh');
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(args.includes('PubkeyAuthentication=no'));
    assert.equal(args.at(-1), 'chat.hf.co');
    assert.equal(opts.shell, undefined);
    const c = new EventEmitter();
    c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.kill = () => {};
    c.stdin.on('finish', () => process.nextTick(() => { c.stdout.write(output); c.emit('close', code); }));
    return c;
  };
}
test('normalizes only clean JSON, without credentials or shell execution', async () => {
  assert.equal(await generate('fictional email', { spawnProcess: mock('{"text":"Draft"}') }), 'Draft');
});
test('rejects terminal banners, malformed output and failed connections', async () => {
  for (const text of ['Welcome\n{"text":"Draft"}', '{}', '{"text":""}', ''])
    await assert.rejects(generate('test', { spawnProcess: mock(text) }), /clean JSON/);
  await assert.rejects(generate('test', { spawnProcess: mock('', 255) }), /connection failed/);
});
test('bounds hanging sessions and supports cancellation', async () => {
  const hanging = () => { const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => {}; return c; };
  await assert.rejects(generate('test', { spawnProcess: hanging, timeoutMs: 5 }), /timed out/);
  const ctl = new AbortController();
  const pending = generate('test', { spawnProcess: hanging, signal: ctl.signal });
  ctl.abort(); await assert.rejects(pending, /cancelled/);
});
