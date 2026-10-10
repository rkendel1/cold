// Server behaviour for /api/generate and static assets, run against a real child process with a MOCK upstream.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const env = require("./helpers/env");

let mock, open, locked, limited;
const post = (srv, body, headers = {}, raw) => fetch(srv.base + "/api/generate", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw ?? JSON.stringify(body) });

before(async () => {
  mock = await env.startMock();
  open = await env.startColdServer({ mockUrl: mock.url });
  locked = await env.startColdServer({ mockUrl: mock.url, env: { COLD_ACCESS_TOKEN: "s3cret-code" } });
  limited = await env.startColdServer({ mockUrl: mock.url, env: { COLD_RATE_LIMIT_PER_MIN: "3" } });
});
after(() => { open.stop(); locked.stop(); limited.stop(); mock.server.close(); });

test("API contract is unchanged: config shape and generate response", async () => {
  const c = await (await fetch(open.base + "/api/config")).json();
  assert.equal(c.app, "cold"); assert.equal(c.ready, true); assert.equal(c.provider, "anthropic"); assert.equal(c.accessRequired, false);
  assert.ok(!JSON.stringify(c).includes("mock-key"), "credential must never be exposed");
  const r = await post(open, { prompt: "Hello" });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.ok("text" in b && "truncated" in b && "model" in b);
  assert.equal((await post(open, { prompt: "" })).status, 400);
  assert.equal((await post(open, null, {}, "{not json")).status, 400);
});

test("with COLD_ACCESS_TOKEN set, generation requires the code and the server reports it", async () => {
  assert.equal((await (await fetch(locked.base + "/api/config")).json()).accessRequired, true);
  const before = mock.prompts.length;
  const none = await post(locked, { prompt: "Hello" });
  assert.equal(none.status, 401); assert.equal((await none.json()).error.code, "access_required");
  assert.equal((await post(locked, { prompt: "Hello" }, { "x-cold-access": "wrong-code!" })).status, 401);
  assert.equal(mock.prompts.length, before, "rejected requests must not reach the provider");
  assert.equal((await post(locked, { prompt: "Hello" }, { "x-cold-access": "s3cret-code" })).status, 200);
});

test("cross-site browser requests are refused before spending credits", async () => {
  const before = mock.prompts.length;
  const r = await post(open, { prompt: "Hello" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403); assert.equal((await r.json()).error.code, "bad_origin");
  assert.equal((await post(open, { prompt: "Hello" }, { origin: "null" })).status, 403);
  assert.equal(mock.prompts.length, before);
  assert.equal((await post(open, { prompt: "Hello" }, { origin: open.base })).status, 200, "same-origin requests still work");
});

test("per-address rate limit returns 429 after the configured number of requests", async () => {
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await post(limited, { prompt: "Hello" })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
});

test("oversized prompts are rejected", async () => {
  const r = await post(open, { prompt: "x".repeat(200 * 1024) });
  assert.equal(r.status, 413);
});

test("static assets and security headers", async () => {
  const html = await fetch(open.base + "/");
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  const text = await html.text();
  assert.match(text, /<script src="\/app\.js">/); assert.match(text, /href="\/app\.css"/);
  const js = await fetch(open.base + "/app.js"); assert.match(js.headers.get("content-type"), /javascript/); assert.ok((await js.text()).length > 10000);
  const css = await fetch(open.base + "/app.css"); assert.match(css.headers.get("content-type"), /text\/css/);
  assert.equal((await fetch(open.base + "/tweet-counter.js")).status, 200);
  assert.equal((await fetch(open.base + "/nope")).status, 404);
  assert.equal((await fetch(open.base + "/src/main.js")).status, 404, "source files are not served");
  assert.equal((await fetch(open.base + "/.env")).status, 404);
});
