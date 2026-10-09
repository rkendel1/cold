// Deliberately isolated from the production provider. No API keys or app data sent.
const { spawn } = require('node:child_process');

const PROMPT = 'Write a fictional cold email about a scheduling tool. Reply ONLY with JSON containing subject and body strings. Do not invent customer metrics.';

function run({ spawnProcess = spawn, input = process.stdin, output = process.stdout, timeoutMs = 120000 } = {}) {
  if (!input.isTTY) {
    output.write('Interactive terminal required. Run npm run test:hf-ssh in your local terminal.\n');
    return Promise.resolve(2);
  }
  output.write(`Experimental Hugging Face SSH smoke test (not a production integration).\nSelect Qwen/Qwen3.8-27B ONLY if the service actually lists it; record the exact model.\nSubmit this public, fictional prompt:\n${PROMPT}\n\nCheck: no sign-in/key required, requested model available, valid JSON response.\nRepeat in a fresh session and record latency, errors, and any limits shown.\nExit the session when finished; it will be terminated after 120 seconds.\nAn SSH exit code does NOT prove inference success or unlimited usage.\n\n`);
  return new Promise(resolve => {
    // Preserve normal host-key verification. No credentials, overrides, or shell interpolation.
    const child = spawnProcess('ssh', ['-tt', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', 'chat.hf.co'], { stdio: 'inherit' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      output.write(error.code === 'ENOENT' ? 'OpenSSH client is not installed in this environment.\n' : `SSH could not start (${error.code || 'unknown error'}).\n`);
      resolve(2);
    });
    child.once('close', code => {
      clearTimeout(timer);
      output.write(timedOut ? 'Session timed out; inference remains unverified.\n' : 'Record observed results manually; transport completion alone is not a pass.\n');
      resolve(timedOut ? 2 : code === 0 ? 0 : 1);
    });
  });
}

if (require.main === module) run().then(code => { process.exitCode = code; });
module.exports = { run, PROMPT };
