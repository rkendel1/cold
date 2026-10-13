// Test prerequisites. Most browser, extension and desktop tests SKIP when Chromium, the built extension or Electron is missing, which is convenient
// on a laptop and dangerous in CI: a run would be green while the three-surface coverage silently didn't execute. When CI is set (GitHub Actions
// sets it) or COLD_REQUIRE_PREREQS=1, a missing prerequisite FAILS here, with the exact thing that is missing. Locally these tests only report.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENFORCED = process.env.CI === 'true' || process.env.CI === '1' || process.env.COLD_REQUIRE_PREREQS === '1';
const root = path.join(__dirname, '..');

/** Fail when enforced; otherwise just say what is missing (so a laptop run can still proceed, and says so). */
function need(ok, what, fix) {
  if (ok) return;
  const msg = `${what} is missing. ${fix}`;
  if (ENFORCED) assert.fail(`${msg} (CI must not skip the coverage that depends on it.)`);
  console.log(`# not enforced outside CI: ${msg} Tests that need it will be skipped.`);
}
function chromium() {
  const bases = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright'), '/opt/pw-browsers'].filter(Boolean);
  if (process.env.CHROMIUM) return fs.existsSync(process.env.CHROMIUM) ? process.env.CHROMIUM : null;
  for (const base of bases) {
    try {
      for (const d of fs.readdirSync(base).filter(x => /^chromium-\d+$/.test(x))) {
        for (const sub of ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) { const p = path.join(base, d, sub); if (fs.existsSync(p)) return p; }
      }
    } catch { /* next */ }
  }
  return null;
}

test(`prerequisite: Node supports built-in node:sqlite (22.13+)${ENFORCED ? ' [enforced]' : ''}`, () => {
  const [maj, min] = process.versions.node.split('.').map(Number);
  need(maj > 22 || (maj === 22 && min >= 13), `Node ${process.versions.node} is too old for node:sqlite; the SQLite tests need 22.13+. Node`, 'Use Node 22.13 or newer.');
  let ok = true; try { require('node:sqlite'); } catch { ok = false; }
  need(ok, 'node:sqlite', 'Use Node 22.13 or newer.');
});
test(`prerequisite: playwright-core is installed${ENFORCED ? ' [enforced]' : ''}`, () => {
  let ok = true; try { require('playwright-core'); } catch { ok = false; }
  need(ok, 'playwright-core', 'Run npm ci.');
});
test(`prerequisite: a Chromium build is installed${ENFORCED ? ' [enforced]' : ''}`, () => {
  need(!!chromium(), 'Chromium (looked in PLAYWRIGHT_BROWSERS_PATH, ~/.cache/ms-playwright, /opt/pw-browsers, or $CHROMIUM)', 'Run: npx playwright-core install --with-deps chromium');
});
test(`prerequisite: the extension is built (extension/dist/panel.js)${ENFORCED ? ' [enforced]' : ''}`, () => {
  need(fs.existsSync(path.join(root, 'extension/dist/panel.js')), 'extension/dist/panel.js', 'Run: npm run build:extension');
});
test(`prerequisite: the application bundle is built (public/app.js)${ENFORCED ? ' [enforced]' : ''}`, () => {
  need(fs.existsSync(path.join(root, 'public/app.js')), 'public/app.js', 'Run: npm run build:app');
});
test(`prerequisite: Electron is installed (desktop handoff tests)${ENFORCED ? ' [enforced]' : ''}`, () => {
  let p = null; try { p = require('electron'); } catch { /* missing */ }
  need(typeof p === 'string' && fs.existsSync(p), 'the Electron binary', 'Run npm ci (it downloads Electron).');
});
test(`prerequisite: a display is available for headed browsers and Electron (Linux)${ENFORCED ? ' [enforced]' : ''}`, () => {
  if (process.platform !== 'linux') return;
  need(!!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY, 'a display ($DISPLAY)', 'Run the suite under a virtual display: xvfb-run -a npm test');
});
