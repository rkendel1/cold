// Bundles the extension panel (it reuses Cold's own domain and generation modules) into extension/dist, plus the on-device model runtime
// (llm-client.js, loaded only on demand, and llm-worker.js) and the compiled model libraries it needs (extension/dist/models/*.wasm).
// Load it in Chrome/Edge/Brave: chrome://extensions > Developer mode > Load unpacked > pick the extension/ folder.
//
// The compiled model libraries are fetched here, at build time, from the URL in extension/src/localModels.js and ACCEPTED ONLY if their
// SHA-256 matches the pinned value there. The extension therefore ships them itself and never fetches code at run time. If they can't be
// fetched (offline build), the build still succeeds and the on-device model reports that its library is missing.
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");
const root = path.join(__dirname, "..");
const dist = path.join(root, "extension/dist");
const common = { bundle: true, format: "iife", target: "chrome114", legalComments: "none", logLevel: "warning", outdir: dist };

const sri = buf => `sha256-${crypto.createHash("sha256").update(buf).digest("base64")}`;

async function fetchLibraries() {
  const { MODELS, RUNTIME } = await import(pathToFileURL(path.join(root, "extension/src/localModels.js")).href);
  const dir = path.join(dist, "models"); fs.mkdirSync(dir, { recursive: true });
  let missing = 0;
  for (const m of MODELS) for (const v of Object.values(m.variants)) {
    const file = path.join(dir, v.lib);
    if (fs.existsSync(file) && sri(fs.readFileSync(file)) === v.libSri) continue;                     // already here and correct
    try {
      const r = await fetch(RUNTIME.libSource + v.lib, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (sri(buf) !== v.libSri) throw new Error(`checksum mismatch (got ${sri(buf)})`);              // never ship a library that isn't the pinned one
      fs.writeFileSync(file, buf);
    } catch (e) { missing++; fs.rmSync(file, { force: true }); console.warn(`warning: couldn't get ${v.lib}: ${e.message}. The on-device model will be unavailable in this build.`); }
  }
  return missing;
}

(async () => {
  await esbuild.build({ ...common, entryPoints: [path.join(root, "extension/src/panel.js")], minify: false, entryNames: "panel" });
  await esbuild.build({ ...common, entryPoints: { "llm-client": path.join(root, "extension/src/llmClient.js"), "llm-worker": path.join(root, "extension/src/llmWorker.js") }, minify: true, define: { "process.env.NODE_ENV": '"production"' } });
  fs.copyFileSync(path.join(root, "extension/src/modelPins.json"), path.join(dist, "model-pins.json"));   // read at run time by the on-device model; tests can swap it in a copy
  const missing = await fetchLibraries();
  console.log(missing ? `Built extension/dist (${missing} model librar${missing === 1 ? "y" : "ies"} missing)` : "Built extension/dist");
})().catch(e => { console.error(e); process.exit(1); });
