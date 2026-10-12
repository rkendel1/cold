// Bundles the extension panel (it reuses Cold's own domain and generation modules) into extension/dist.
// Load it in Chrome/Edge/Brave: chrome://extensions > Developer mode > Load unpacked > pick the extension/ folder.
const path = require("node:path");
const esbuild = require("esbuild");
const root = path.join(__dirname, "..");
esbuild.build({
  entryPoints: [path.join(root, "extension/src/panel.js")],
  bundle: true, minify: false, format: "iife", target: "chrome114", legalComments: "none", logLevel: "warning",
  outdir: path.join(root, "extension/dist"), entryNames: "panel",
}).then(() => console.log("Built extension/dist")).catch(() => process.exit(1));
