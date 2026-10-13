// Fails when the TAP report contains a skipped test that is not on the allow-list below. A skip is a test that did not run: in CI it must be
// either impossible to avoid (a real external service or a separately provisioned real model) and listed here WITH its reason, or a failure.
// Usage: node scripts/ci-check-skips.cjs test-results/results.tap
const fs = require("node:fs");
const ALLOWED = [
  { name: /^REAL MODEL:/, reason: "needs COLD_REAL_MODEL=1 and a separately provisioned real model; it is not part of the default gate (npm run smoke:model)" },
];
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error(`ci-check-skips: report not found: ${file}`); process.exit(2); }
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const skipped = [], total = { ok: 0, notOk: 0 };
for (const l of lines) {
  const m = /^\s*(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)(?: (.*))?)?$/.exec(l);
  if (!m) continue;
  m[1] === "ok" ? total.ok++ : total.notOk++;
  if (m[3] === "SKIP") skipped.push({ name: m[2], reason: m[4] || "(no reason given)" });
}
const unexpected = skipped.filter(s => !ALLOWED.some(a => a.name.test(s.name)));
for (const s of skipped) console.log(`${unexpected.includes(s) ? "UNEXPECTED SKIP" : "allowed skip   "}: ${s.name} (${s.reason})`);
for (const a of ALLOWED) if (skipped.some(s => a.name.test(s.name))) console.log(`  allow-list reason for ${a.name}: ${a.reason}`);
console.log(`${total.ok + total.notOk} results, ${skipped.length} skipped, ${unexpected.length} unexpected`);
if (unexpected.length) { console.error("A skipped test means coverage did not run. Fix the prerequisite, or add it to ALLOWED with a concrete reason."); process.exit(1); }
