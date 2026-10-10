// Bundles src/ into public/app.js + public/app.css (checked in, like public/tweet-counter.js).
// Vercel serves the committed files; it does not need to run this. `--check` verifies the committed bundle is current.
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const check = process.argv.includes("--check");
const outdir = check ? fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cold-bundle-")) : path.join(root, "public");

esbuild.build({
  entryPoints: [path.join(root, "src/main.js")],
  bundle: true, minify: true, format: "iife", target: "es2020", legalComments: "none",
  outdir, entryNames: "app", logLevel: "warning",
}).then(() => {
  if (!check) return console.log("Built public/app.js and public/app.css");
  let stale = false;
  for (const f of ["app.js", "app.css"]) {
    const a = fs.readFileSync(path.join(outdir, f)), b = fs.existsSync(path.join(root, "public", f)) ? fs.readFileSync(path.join(root, "public", f)) : null;
    if (!b || !a.equals(b)) { console.error(`public/${f} is out of date. Run: npm run build:app`); stale = true; }
  }
  fs.rmSync(outdir, { recursive: true, force: true });
  process.exit(stale ? 1 : 0);
}).catch(() => process.exit(1));
