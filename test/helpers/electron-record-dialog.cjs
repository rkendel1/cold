// Preloaded into an UNPACKAGED Electron main process with NODE_OPTIONS="--require <this file>" so a test can see the error box Cold would show
// (a real one would block waiting for a click). When the app requires "electron" it gets the real module with only dialog.showErrorBox replaced
// by a recorder that writes the title and message to $COLD_TEST_DIALOG_FILE. Nothing else changes.
const fs = require("node:fs");
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
  const m = load.call(this, request, ...rest);
  if (request !== "electron" || !m || typeof m !== "object") return m;
  const dialog = { showErrorBox: (title, message) => fs.writeFileSync(process.env.COLD_TEST_DIALOG_FILE, JSON.stringify({ title, message })) };
  return new Proxy(m, { get: (target, key) => (key === "dialog" ? dialog : target[key]) });
};
