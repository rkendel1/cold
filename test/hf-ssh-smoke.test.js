const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { run } = require('../scripts/hf-ssh-smoke.cjs');

function fixture() {
  let text = '';
  return { output: { write: chunk => { text += chunk; } }, text: () => text };
}
test('noninteractive environments do not start SSH', async () => {
  const f = fixture();
  assert.equal(await run({ input: { isTTY: false }, output: f.output, spawnProcess: () => { throw new Error('unexpected spawn'); } }), 2);
  assert.match(f.text(), /Interactive terminal required/);
});
test('fixed destination and host verification; exit is not inference proof', async () => {
  const f = fixture();
  const code = await run({ input: { isTTY: true }, output: f.output, spawnProcess: (cmd, args, options) => {
    assert.equal(cmd, 'ssh');
    assert.deepEqual(args, ['-tt', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', 'chat.hf.co']);
    assert.deepEqual(options, { stdio: 'inherit' });
    const child = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child;
  } });
  assert.equal(code, 0);
  assert.match(f.text(), /transport completion alone is not a pass/);
});
test('missing SSH is an explicit blocker', async () => {
  const f = fixture();
  const code = await run({ input: { isTTY: true }, output: f.output, spawnProcess: () => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit('error', Object.assign(new Error(), { code: 'ENOENT' })));
    return child;
  } });
  assert.equal(code, 2);
  assert.match(f.text(), /not installed/);
});
test('sessions are bounded by a timeout', async () => {
  const f = fixture();
  const code = await run({ input: { isTTY: true }, output: f.output, timeoutMs: 5, spawnProcess: () => {
    const child = new EventEmitter();
    child.kill = signal => { assert.equal(signal, 'SIGTERM'); child.emit('close', null); };
    return child;
  } });
  assert.equal(code, 2);
  assert.match(f.text(), /timed out/);
});
