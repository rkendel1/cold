// The Linux package, checked without building it: the packaging configuration, what the .deb builder adds and withholds, and the .deb
// verifier itself (run on tiny packages made here, so it is known to fail when it should). The real artifact is verified in CI by
// `npm run desktop:deb && npm run verify:deb`, and the installed application by scripts/smoke-deb.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const main = fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8');
const dpkg = spawnSync('dpkg-deb', ['--version']).status === 0;
const SKIP_DPKG = dpkg ? false : 'dpkg-deb is not available (it is on every Debian/Ubuntu machine and the CI runner)';

test('existing packaging targets are unchanged and the .deb is configured from the same build block', () => {
  assert.equal(pkg.build.appId, 'com.kendelconsulting.cold');
  assert.equal(pkg.build.productName, 'Cold');
  assert.deepEqual(pkg.build.mac.target, ['dmg', 'zip']);
  assert.equal(pkg.build.mac.category, 'public.app-category.productivity');
  assert.equal(pkg.build.win.target, 'nsis');
  assert.equal(pkg.build.linux.target, 'AppImage', 'the existing Linux target is untouched; the .deb is an additional, explicit command');
  assert.equal(pkg.build.linux.category, 'Office');
  assert.equal(pkg.scripts['desktop:build'], 'npm run build:app && electron-builder');
  assert.equal(pkg.scripts['desktop:pack'], 'npm run build:app && electron-builder --dir');
  assert.equal(pkg.scripts['desktop:deb'], 'npm run build:app && node scripts/build-deb.cjs');
  assert.equal(pkg.scripts['verify:deb'], 'node scripts/verify-deb.cjs');
});

test('the .deb identity is the product\'s: name, maintainer, description, icon, desktop entry', () => {
  assert.equal(pkg.name, 'cold');
  assert.match(pkg.build.linux.maintainer, /^[^<]+ <[^@\s]+@[^>\s]+>$/);
  assert.ok(pkg.build.linux.synopsis && pkg.build.linux.description.length > 40);
  assert.equal(pkg.desktopName, 'cold.desktop');
  assert.equal(pkg.build.linux.syncDesktopName, true);
  assert.match(main, /app\.setName\("Cold"\)/, 'the running app and the packaged product share one name');
  const icon = fs.readFileSync(path.join(root, pkg.build.icon));
  assert.deepEqual([...icon.subarray(1, 4)], [...Buffer.from('PNG')], 'the existing brand icon is a PNG');
  assert.ok(icon.readUInt32BE(16) >= 512 && icon.readUInt32BE(20) >= 512, 'and large enough for a Linux launcher (512x512)');
});

test('the .deb build uses the existing configuration, withholds a local OAuth secret, and does not touch the other targets', () => {
  const { debConfig } = require('../scripts/build-deb.cjs');
  const c = debConfig(pkg, {});
  assert.deepEqual(c.files, [...pkg.build.files, '!desktop/google.json']);
  assert.deepEqual({ ...c, files: undefined }, { ...pkg.build, files: undefined }, 'everything else is exactly the package.json build block');
  assert.equal(debConfig(pkg, { COLD_ELECTRON_DIST: 'x/y' }).electronDist, path.resolve('x/y'));
  assert.equal(pkg.build.files.includes('!desktop/google.json'), false, 'macOS and Windows builds still bundle desktop/google.json when a maintainer provides it');
});

test('the files the packaged app needs at run time are all inside the packaged file list', () => {
  const globs = pkg.build.files;
  const inside = rel => globs.some(g => g.endsWith('/**') ? rel.startsWith(g.slice(0, -2)) : g === rel);
  for (const rel of ['desktop/main.js', 'desktop/preload.js', 'server.js', 'index.html', 'provider-config.json', 'package.json', 'lib/db.js', 'lib/settings.js', 'lib/mailto.js', 'public/app.js', 'public/app.css', 'public/brand/logo-512.png', 'scripts/hf-ssh-provider.cjs']) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} exists`);
    assert.ok(inside(rel), `${rel} is packaged`);
  }
  // main.js locates its assets relative to itself, never to the working directory.
  assert.ok(!/process\.cwd\(\)/.test(main), 'no working-directory assumption in the shell');
  assert.ok(/path\.join\(__dirname, "\.\.\/public\/brand\/logo-512\.png"\)/.test(main));
});

test('platform-specific behaviour in the shell is guarded, not assumed', () => {
  assert.match(main, /process\.platform === "darwin" && app\.dock/, 'the Dock call is macOS-only');
  assert.match(main, /const mac = process\.platform === "darwin"/, 'the application menu differs by platform');
  assert.ok(!/(osascript|open -a|\/Library\/|Application Support\/Cold['"])/.test(main.replace(/\/\/.*$/gm, '')), 'no macOS shell commands or paths in code');
  assert.match(main, /app\.getPath\("userData"\)/, 'the data folder comes from Electron, not a hard-coded path');
});

// ---- the verifier -----------------------------------------------------------------------------------

async function fakeDeb({ arch = 'amd64', asarFiles = {}, postrm = '', extraFiles = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-fakedeb-'));
  const tree = path.join(dir, 'tree');
  const w = (rel, content, mode = 0o644) => { const f = path.join(tree, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content, { mode }); };
  w('opt/Cold/cold', '#!/bin/sh\n', 0o755);
  w('usr/share/applications/cold.desktop', '[Desktop Entry]\nName=Cold\nExec=/opt/Cold/cold %U\nIcon=cold\nType=Application\n');
  w('usr/share/icons/hicolor/512x512/apps/cold.png', fs.readFileSync(path.join(root, 'public/brand/logo-512.png')));
  for (const [rel, content] of Object.entries(extraFiles)) w(rel, content);
  const app = path.join(dir, 'app');
  const base = { 'desktop/main.js': 'x', 'desktop/preload.js': 'x', 'server.js': 'x', 'index.html': 'x', 'lib/db.js': 'x', 'public/app.js': 'x', 'public/app.css': 'x', 'public/brand/logo-512.png': 'x', 'provider-config.json': '{}', 'package.json': JSON.stringify({ main: 'desktop/main.js' }) };
  for (const [rel, content] of Object.entries({ ...base, ...asarFiles })) { const f = path.join(app, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); }
  fs.mkdirSync(path.join(tree, 'opt/Cold/resources'), { recursive: true });
  await require('@electron/asar').createPackage(app, path.join(tree, 'opt/Cold/resources/app.asar'));
  fs.mkdirSync(path.join(tree, 'DEBIAN'));
  fs.writeFileSync(path.join(tree, 'DEBIAN/control'), `Package: ${pkg.name}\nVersion: ${pkg.version}\nArchitecture: ${arch}\nMaintainer: ${pkg.build.linux.maintainer}\nDescription: ${pkg.build.linux.synopsis}\n long text\n`);
  if (postrm) fs.writeFileSync(path.join(tree, 'DEBIAN/postrm'), postrm, { mode: 0o755 });
  const out = path.join(dir, `${pkg.name}_${pkg.version}_${arch}.deb`);
  const r = spawnSync('dpkg-deb', ['--build', '--root-owner-group', tree, out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return out;
}
const verify = deb => spawnSync(process.execPath, [path.join(root, 'scripts/verify-deb.cjs'), deb], { encoding: 'utf8' });

test('verify-deb accepts a well-formed package', { skip: SKIP_DPKG, timeout: 60000 }, async () => {
  const r = verify(await fakeDeb());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /checks passed for cold_/);
});

test('verify-deb fails a package with the wrong architecture, a credential, user data, or a maintainer script that touches the data folder', { skip: SKIP_DPKG, timeout: 120000 }, async () => {
  const fails = (deb, what) => { const r = verify(deb); assert.equal(r.status, 1, `${what} must fail: ${r.stdout}`); return r.stdout; };
  assert.match(fails(await fakeDeb({ arch: 'arm64' }), 'wrong architecture'), /FAIL Architecture is amd64/);
  assert.match(fails(await fakeDeb({ asarFiles: { 'desktop/google.json': '{"clientSecret":"x"}' } }), 'a bundled OAuth secret'), /FAIL app archive has no credentials/);
  assert.match(fails(await fakeDeb({ asarFiles: { 'test/db.test.js': 'x' } }), 'tests in the app'), /FAIL app archive has no credentials/);
  assert.match(fails(await fakeDeb({ asarFiles: { 'node_modules/electron/index.js': 'x' } }), 'a development dependency'), /FAIL app archive has no credentials/);
  assert.match(fails(await fakeDeb({ extraFiles: { 'opt/Cold/cold.db': 'user data' } }), 'a database file'), /FAIL no credentials, user data/);
  assert.match(fails(await fakeDeb({ postrm: '#!/bin/sh\nrm -rf "$HOME/.config/Cold"\n' }), 'a postrm that deletes user data'), /FAIL install, upgrade and removal scripts/);
});

test('verify-deb reports a missing artifact instead of passing', () => {
  const r = verify(path.join(os.tmpdir(), 'cold_does_not_exist.deb'));
  assert.equal(r.status, 2);
});
