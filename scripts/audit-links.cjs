// Checks every relative Markdown link (and #anchor) in README.md and docs/**/*.md resolves. Usage: node scripts/audit-links.cjs
const fs = require("node:fs"), path = require("node:path");
const root = path.join(__dirname, "..");
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const files = [path.join(root, "README.md"), path.join(root, "SECURITY.md"), ...walk(path.join(root, "docs")).filter(f => f.endsWith(".md"))];
const slug = h => h.toLowerCase().replace(/<[^>]+>/g, "").replace(/`/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-");
const anchors = f => new Set([...fs.readFileSync(f, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => slug(m[1])));
let bad = 0, n = 0;
for (const f of files) {
  const text = fs.readFileSync(f, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = m[1]; if (/^(https?:|mailto:)/.test(href)) continue; n++;
    const [p, hash] = href.split("#"), target = p ? path.resolve(path.dirname(f), decodeURIComponent(p)) : f;
    if (!fs.existsSync(target)) { console.log(`BROKEN ${path.relative(root, f)} -> ${href}`); bad++; continue; }
    if (hash && target.endsWith(".md") && !anchors(target).has(hash)) { console.log(`NO ANCHOR ${path.relative(root, f)} -> ${href}`); bad++; }
  }
}
console.log(`${n} relative links checked in ${files.length} files, ${bad} problem(s)`); process.exit(bad ? 1 : 0);
