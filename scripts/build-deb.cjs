// Builds the Ubuntu/Debian package (dist/cold_<version>_amd64.deb) with the repository's existing electron-builder configuration
// (package.json "build"). The only difference from `npm run desktop:build` is the target, and that this package never carries
// desktop/google.json: a local OAuth client secret is not shipped in a package that others install.
//   npm run desktop:deb        (build:app first, then this)
// COLD_ELECTRON_DIST=<dir> reuses an already-unpacked Electron instead of downloading one (for build machines without access to GitHub releases).
const fs = require("node:fs");
const path = require("node:path");
const { build, Platform, Arch } = require("electron-builder");   // loaded lazily below only matters to the test: requiring this file does not build anything

const root = path.join(__dirname, "..");

/** The package.json "build" configuration, unchanged except that this package never carries a local OAuth client secret. */
function debConfig(pkg, env = process.env) {
  const config = { ...pkg.build, files: [...pkg.build.files, "!desktop/google.json"] };
  if (env.COLD_ELECTRON_DIST) config.electronDist = path.resolve(env.COLD_ELECTRON_DIST);
  return config;
}

if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  build({ projectDir: root, config: debConfig(pkg), targets: Platform.LINUX.createTarget("deb", Arch.x64), publish: "never" })
    .then(files => { for (const f of files) console.log(`Built ${path.relative(root, f)}`); })
    .catch(e => { console.error(e && e.message ? e.message : e); process.exit(1); });
}

module.exports = { debConfig };
