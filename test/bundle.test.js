// Build and deployment-configuration checks. These are LOCAL checks: they do not prove the Vercel project is healthy.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");

test("committed public/app.js and app.css are up to date with src/", () => {
  const r = spawnSync("node", ["scripts/build-app.cjs", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("the bundle contains no credentials or server-only configuration", () => {
  const js = read("public/app.js");
  for (const bad of ["ANTHROPIC_API_KEY", "AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "mock-key", "s3cret-code"]) assert.ok(!js.includes(bad), `${bad} must not be in browser code`);
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(js));
});

test("index.html is a small shell that loads only same-origin assets", () => {
  const html = read("index.html");
  assert.ok(html.split("\n").length < 30, "index.html must stay a shell");
  const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  for (const s of srcs) assert.ok(s.startsWith("/"), `unexpected external reference ${s}`);
  for (const f of ["public/app.js", "public/app.css", "public/tweet-counter.js"]) assert.ok(fs.existsSync(path.join(root, f)), `${f} is missing`);
});

test("deployment topology: Vercel runs the root server.js; assets are read via literal paths it can bundle", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.main, "server.js");
  assert.ok(!fs.existsSync(path.join(root, "vercel.json")), "no vercel.json: topology is zero-config (update docs/ux if this changes)");
  assert.ok(!fs.existsSync(path.join(root, "api")), "no api/ directory: server.js is the only handler");
  assert.equal(pkg.scripts.build, undefined, "no `build` script: Vercel does not run a build, so public/ must be committed");
  const server = read("server.js");
  for (const lit of ['path.join(ROOT, "index.html")', 'path.join(ROOT, "public/app.js")', 'path.join(ROOT, "public/app.css")', 'path.join(ROOT, "public/tweet-counter.js")'])
    assert.ok(server.includes(lit), `server.js must read ${lit} with a literal path`);
});

test("server.js exports an http.Server and does not listen when required (serverless-compatible entry)", () => {
  const http = require("node:http");
  delete require.cache[require.resolve("../server")];
  const server = require("../server");
  assert.ok(server instanceof http.Server);
  assert.equal(server.listening, false);
});

test("ES modules in src/ resolve: every relative import points at an existing file", () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(root, "src")).filter(f => f.endsWith(".js"))) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/from\s+"(\.[^"]+)"|import\s+"(\.[^"]+)"/g)) {
      const target = path.resolve(path.dirname(f), m[1] || m[2]);
      assert.ok(fs.existsSync(target), `${path.relative(root, f)} imports missing ${m[1] || m[2]}`);
    }
  }
});

test("no source module is a monolith", () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(root, "src")).filter(f => f.endsWith(".js"))) assert.ok(fs.readFileSync(f, "utf8").split("\n").length < 400, `${path.relative(root, f)} is too large`);
});
