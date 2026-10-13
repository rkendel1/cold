// The Cold logo on every surface: the files exist at the sizes their consumers need, the server serves only the logo PNGs, and the
// desktop build and extension manifest point at them.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const size = f => { const b = fs.readFileSync(path.join(ROOT, f)); assert.equal(b.toString("latin1", 1, 4), "PNG", `${f} is a PNG`); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test("extension: the manifest names real, square icons at the sizes Chrome uses, for the toolbar and the extensions page", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8"));
  for (const set of [m.icons, m.action.default_icon]) {
    assert.deepEqual(Object.keys(set).sort((a, b) => a - b), ["16", "32", "48", "128"]);
    for (const [n, f] of Object.entries(set)) assert.deepEqual(size(`extension/${f}`), [Number(n), Number(n)], f);
  }
});

test("desktop: the window and the installer use a 512 px icon that ships with the app", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.build.icon, "public/brand/logo-512.png"); assert.deepEqual(size(pkg.build.icon), [512, 512]);
  assert.ok(pkg.build.files.includes("public/**"));
  assert.match(fs.readFileSync(path.join(ROOT, "desktop/main.js"), "utf8"), /icon: path\.join\(__dirname, "\.\.\/public\/brand\/logo-512\.png"\)/);
});

test("web: pages declare the icons, and the server serves the logo PNGs and nothing else under /brand", async () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /rel="icon"[^>]*href="\/brand\/favicon-32\.png"/); assert.match(html, /rel="apple-touch-icon"[^>]*href="\/brand\/apple-touch-icon\.png"/);
  assert.deepEqual(size("public/brand/favicon-32.png"), [32, 32]); assert.deepEqual(size("public/brand/apple-touch-icon.png"), [180, 180]);
  const port = await new Promise(r => { const l = require("node:net").createServer(); l.listen(0, "127.0.0.1", () => { const n = l.address().port; l.close(() => r(n)); }); });   // asked of the OS: files run in parallel
  const srv = spawn("node", ["server.js"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" } });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/config"); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const ok = await fetch(base + "/brand/logo-96.png"); assert.equal(ok.status, 200); assert.equal(ok.headers.get("content-type"), "image/png");
    for (const bad of ["/brand/nope.png", "/brand/%2e%2e/server.js", "/brand/logo-96.svg", "/brand/"]) assert.equal((await fetch(base + bad)).status, 404, bad);
    assert.match(ok.headers.get("cache-control") || "", /max-age/);
  } finally { srv.kill(); }
});
