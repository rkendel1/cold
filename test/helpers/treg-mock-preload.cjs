// Test-only: loaded into a spawned Cold server with NODE_OPTIONS=--require. Answers requests to https://treg.to/ from the canned script in
// TREG_MOCK ({ "<operation>": [ {status, body}, ... ] }; the last answer repeats) and appends every request it saw to TREG_MOCK_LOG.
// No real network call to treg is made, so nothing here says anything about the live service.
const fs = require("node:fs");
const real = globalThis.fetch, script = JSON.parse(process.env.TREG_MOCK || "{}"), seen = {};
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith("https://treg.to/")) return real(url, init);
  const op = String(url).split("/call/")[1] || "";
  fs.appendFileSync(process.env.TREG_MOCK_LOG, JSON.stringify({ url: String(url), headers: init.headers, body: init.body }) + "\n");
  const list = script[op] || [{ status: 500, body: {} }], i = Math.min(seen[op] = (seen[op] || 0) + 1, list.length) - 1, r = list[i];
  if (r.hang) await new Promise(() => {});
  return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { "content-type": "application/json" } });
};
