// Checks a built Cold .deb against what a pilot installation needs, without installing it:
// identity and architecture, the files that must be there, the things that must NOT be there (credentials, user data, dev tooling,
// tests), and that the maintainer scripts leave a person's data alone.
//   node scripts/verify-deb.cjs [path/to/cold_<version>_amd64.deb]    (default: the single dist/*.deb)
// Exit 0 when every check passes, 1 otherwise. Needs dpkg-deb (any Debian/Ubuntu machine, and the CI runner).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

function resolveDeb() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const dir = path.join(root, "dist");
  const debs = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".deb")) : [];
  if (debs.length !== 1) { console.error(`verify-deb: expected exactly one dist/*.deb, found ${debs.length}. Build it with: npm run desktop:deb`); process.exit(2); }
  return path.join(dir, debs[0]);
}
const deb = resolveDeb();
if (!fs.existsSync(deb)) { console.error(`verify-deb: ${deb} does not exist`); process.exit(2); }

// ---- identity
const field = f => { try { return run("dpkg-deb", ["-f", deb, f]).trim(); } catch { return ""; } };
const expectedName = `${pkg.name}_${pkg.version}_amd64.deb`;
check("file name identifies product, version, architecture and type", path.basename(deb) === expectedName, `${path.basename(deb)} (expected ${expectedName})`);
check("Package is the product name", field("Package") === pkg.name, field("Package"));
check("Version matches package.json", field("Version") === pkg.version, `${field("Version")} vs ${pkg.version}`);
check("Architecture is amd64", field("Architecture") === "amd64", field("Architecture"));
check("Maintainer is set", /<.+@.+>/.test(field("Maintainer")), field("Maintainer"));
const desc = field("Description");
check("Description has a one-line synopsis", desc.split("\n")[0].trim().length > 0, JSON.stringify(desc.split("\n")[0]));

// ---- files
const listing = run("dpkg-deb", ["-c", deb]).split("\n").filter(Boolean).map(l => { const m = /^(\S+)\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.*?)(?: -> .*)?$/.exec(l); return m ? { mode: m[1], size: Number(m[2]), path: m[3] } : null; }).filter(Boolean);
const has = p => listing.find(e => e.path === p);
check("application binary is installed and executable", has("./opt/Cold/cold") && /x/.test(has("./opt/Cold/cold").mode), "./opt/Cold/cold");
check("app archive is present", !!has("./opt/Cold/resources/app.asar"));
check("desktop entry is installed", !!has("./usr/share/applications/cold.desktop"));
check("icon is installed", has("./usr/share/icons/hicolor/512x512/apps/cold.png") && has("./usr/share/icons/hicolor/512x512/apps/cold.png").size > 1000, "512x512 PNG");
const unwanted = /(^|\/)(google\.json|\.env[^/]*|settings\.json|[^/]*\.(db|db-wal|db-shm|sqlite3?)|test-results|\.git)$|\/(test|tests|docs|examples|extension)\//;
check("no credentials, user data or test material outside the app archive", !listing.filter(e => unwanted.test(e.path)).length, listing.filter(e => unwanted.test(e.path)).map(e => e.path).join(", "));

// ---- the app archive (what the application itself is made of)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cold-verify-deb-"));
try {
  const asarFile = path.join(tmp, "app.asar");
  if (has("./opt/Cold/resources/app.asar")) {
    const tar = run("sh", ["-c", `dpkg-deb --fsys-tarfile "${deb}" | tar -xO ./opt/Cold/resources/app.asar > "${asarFile}"`], { stdio: ["ignore", "pipe", "pipe"] });
    void tar;
    const inside = require("@electron/asar").listPackage(asarFile, { isPack: false }).map(p => p.replace(/\\/g, "/"));
    for (const need of ["/desktop/main.js", "/desktop/preload.js", "/server.js", "/index.html", "/lib/db.js", "/public/app.js", "/public/app.css", "/public/brand/logo-512.png", "/provider-config.json"]) check(`app archive contains ${need}`, inside.includes(need));
    const bad = inside.filter(p => /^\/(test|tests|docs|examples|extension|\.github)\//.test(p) || /\/desktop\/google\.json$/.test(p) || /\/\.env/.test(p) || /\.(db|sqlite3?|db-wal)$/.test(p) || /^\/node_modules\/(electron|electron-builder|esbuild|playwright-core|axe-core)(\/|$)/.test(p));
    check("app archive has no credentials, user data, tests or development dependencies", !bad.length, bad.slice(0, 5).join(", "));
    const desktopPkg = JSON.parse(run("sh", ["-c", `node -e 'process.stdout.write(require("@electron/asar").extractFile(process.argv[1], "package.json"))' "${asarFile}"`]));
    check("app archive starts desktop/main.js", desktopPkg.main === "desktop/main.js", desktopPkg.main);
  }
  // ---- desktop entry and maintainer scripts
  const entry = run("sh", ["-c", `dpkg-deb --fsys-tarfile "${deb}" | tar -xO ./usr/share/applications/cold.desktop`]);
  check("desktop entry names the product and starts the installed binary", /^Name=Cold$/m.test(entry) && /^Exec=\/opt\/Cold\/cold(\s|$)/m.test(entry) && /^Icon=cold$/m.test(entry), entry.split("\n").filter(l => /^(Name|Exec|Icon)=/.test(l)).join(" | "));
  fs.mkdirSync(path.join(tmp, "ctl"));
  run("dpkg-deb", ["-e", deb, path.join(tmp, "ctl")]);
  const scripts = ["preinst", "postinst", "prerm", "postrm"].map(n => path.join(tmp, "ctl", n)).filter(fs.existsSync).map(f => ({ f: path.basename(f), text: fs.readFileSync(f, "utf8") }));
  const touchesData = scripts.filter(s => /\/home\/|\$HOME|~\/|\.config|cold\.db|userData|\/root\b/.test(s.text));
  check("install, upgrade and removal scripts never touch a person's data folder", !touchesData.length, touchesData.map(s => s.f).join(", "));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail && !r.ok ? ` — ${r.detail}` : ""}`);
const failed = results.filter(r => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed for ${path.basename(deb)}`);
process.exit(failed.length ? 1 : 0);
