// The desktop shell's one privileged action. Runs the REAL Electron app, with shell.openExternal replaced by a recorder, so nothing
// opens on the machine running the tests. This proves the validation and plumbing; it does not prove an email app is installed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pw; try { pw = require('playwright-core'); } catch { pw = null; }
let electronPath = null; try { electronPath = require('electron'); } catch { /* not installed */ }
const SKIP = !pw || !electronPath || !fs.existsSync(String(electronPath)) ? 'Electron or playwright-core is not available' : false;

test('desktop: the page can open a valid mailto draft and nothing else', { skip: SKIP, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-desk-'));
  const env = { ...process.env, COLD_PORT: String(47900 + Math.floor(Math.random() * 90)), LLM_PROVIDER: 'ollama' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await pw._electron.launch({ args: [path.join(__dirname, '../desktop/main.js'), `--user-data-dir=${dir}`], env });
  try {
    await app.evaluate(({ shell }) => { globalThis.__opened = []; globalThis.__fail = false; shell.openExternal = async u => { if (globalThis.__fail) throw new Error('No application knows how to open this'); globalThis.__opened.push(u); return true; }; });
    const win = await app.firstWindow();
    await win.waitForSelector('#genBtn', { state: 'attached' });
    // the bridge exposes exactly one function and no Node access
    assert.deepEqual(await win.evaluate(() => Object.keys(window.coldDesktop)), ['openMail']);
    assert.deepEqual(await win.evaluate(() => [typeof require, typeof process, typeof window.electron]), ['undefined', 'undefined', 'undefined']);
    const good = 'mailto:sam@trialco.com?subject=Hello%20there&body=Line%201%0D%0ALine%202';
    assert.deepEqual(await win.evaluate(u => window.coldDesktop.openMail(u), good), { ok: true });
    assert.deepEqual(await app.evaluate(() => globalThis.__opened), [good]);
    // Gmail / Outlook compose links open in the default browser, but only the exact links, never a look-alike host
    const gmail = 'https://mail.google.com/mail/?view=cm&fs=1&to=sam%40trialco.com&su=Hello&body=Line%201%0ALine%202';
    assert.deepEqual(await win.evaluate(u => window.coldDesktop.openMail(u), gmail), { ok: true });
    for (const bad of ['https://mail.google.com.evil.test/mail/?view=cm&fs=1&su=S', 'http://mail.google.com/mail/?view=cm&fs=1&su=S', 'https://mail.google.com/mail/?view=cm&fs=1&cc=x@y.com&su=S', 'https://accounts.google.com/o/oauth2/auth?client_id=x', 'https://mail.google.com@evil.test/mail/?view=cm']) {
      assert.equal((await win.evaluate(u => window.coldDesktop.openMail(u), bad)).ok, false, bad);
    }
    assert.deepEqual(await app.evaluate(() => globalThis.__opened), [good, gmail]);
    // anything else is refused in the main process and never reaches the OS
    for (const bad of ['https://evil.test', 'file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.com?cc=x@y.com', 'mailto:a@b.com,c@d.com', 'mailto:nobody', 'tel:+15551234567', '']) {
      const r = await win.evaluate(u => window.coldDesktop.openMail(u), bad);
      assert.equal(r.ok, false, bad);
    }
    assert.deepEqual(await app.evaluate(() => globalThis.__opened), [good, gmail], 'only the valid links were passed to the system');
    // a system failure is reported to the page (which keeps the draft and offers Copy)
    await app.evaluate(() => { globalThis.__fail = true; });
    const failed = await win.evaluate(u => window.coldDesktop.openMail(u), good);
    assert.equal(failed.ok, false); assert.match(failed.message, /No application knows/);
    // navigating the window to a mailto link directly is still blocked: only the bridge opens email
    await win.evaluate(() => { location.href = 'mailto:sam@trialco.com'; });
    await win.waitForTimeout(300);
    assert.deepEqual(await app.evaluate(() => globalThis.__opened), [good, gmail]);
    assert.match(win.url(), /^http:\/\/127\.0\.0\.1:\d+\//);
  } finally { await app.close(); }
});
