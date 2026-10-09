// Experimental line-input protocol hypothesis, NOT a verified HF API.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const knownHosts = path.join(__dirname, '../hf-ssh-known-hosts');
function generate(prompt, { spawnProcess = spawn, signal, timeoutMs = 30000 } = {}) {
  if (spawnProcess === spawn && !fs.existsSync(knownHosts))
    return Promise.reject(new Error('HF SSH requires a verified host key in hf-ssh-known-hosts. Live protocol is unverified.'));
  if (signal?.aborted) return Promise.reject(new Error('HF SSH request cancelled.'));
  return new Promise((resolve, reject) => {
    let child, timer, output = '', settled = false;
    const finish = (error, text) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) child?.kill('SIGTERM');
      error ? reject(error) : resolve(text);
    };
    const abort = () => finish(new Error('HF SSH request cancelled.'));
    try {
      child = spawnProcess('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'PubkeyAuthentication=no', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', 'chat.hf.co'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return finish(new Error('HF SSH could not start.')); }
    timer = setTimeout(() => finish(new Error('HF SSH timed out; automated protocol may be unsupported.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new Error('HF SSH unavailable: an OpenSSH executable is required.')));
    child.stdin.on('error', () => finish(new Error('HF SSH rejected prompt input.')));
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 65536) finish(new Error('HF SSH response too large.'));
    });
    // Drain stderr but never expose it (could echo prompt or connection details).
    child.stderr.on('data', () => {});
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new Error('HF SSH connection failed; check host trust and anonymous access.'));
      try {
        const data = JSON.parse(output.trim());
        if (!data || typeof data.text !== 'string' || !data.text.trim()) throw new Error();
        finish(null, data.text);
      } catch { finish(new Error('HF SSH returned no clean JSON text envelope; automated protocol is unverified.')); }
    });
    // Hypothesis only: service accepts one stdin line and EOF, and obeys JSON envelope.
    // No model claim: model selection is not documented/verified.
    child.stdin.end(JSON.stringify({ prompt: `Return ONLY a JSON object with a text string containing your response.\n${prompt}` }) + '\n');
  });
}
module.exports = { generate };
