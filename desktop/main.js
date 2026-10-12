// Cold desktop shell: runs the Cold server inside the app on a fixed local port and shows it in a window.
// A fixed port keeps the page origin stable between launches, which is what keeps saved products and drafts.
const { app, BrowserWindow, Menu, shell, safeStorage, dialog, session } = require("electron");
const path = require("node:path");

const PORT = parseInt(process.env.COLD_PORT || "47821", 10);
const ORIGIN = `http://127.0.0.1:${PORT}`;

app.setName("Cold");
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// Must be set before server.js is loaded: it switches on the Settings screen and picks where keys are saved.
process.env.COLD_SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");
process.env.COLD_DB_FILE = path.join(app.getPath("userData"), "cold.db");   // products and drafts (SQLite)
process.env.HOST = "127.0.0.1";

let win = null;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
}

function openSettings() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.executeJavaScript("location.hash = '#/settings'").catch(() => {});
}

function buildMenu() {
  const mac = process.platform === "darwin";
  const settingsItem = { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openSettings };
  const template = [
    ...(mac ? [{ label: "Cold", submenu: [{ role: "about" }, { type: "separator" }, settingsItem, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }] : [{ label: "File", submenu: [settingsItem, { type: "separator" }, { role: "quit" }] }]),
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }, ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }])] },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 860, minWidth: 720, minHeight: 600, title: "Cold",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.loadURL(ORIGIN);
  // Keep the window on Cold: external links open in the browser, everything else is blocked.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); } });
  win.on("closed", () => { win = null; });
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  const server = require("../server.js");
  if (safeStorage.isEncryptionAvailable()) {
    server.settings.setCodec({ encrypt: s => safeStorage.encryptString(s), decrypt: b => safeStorage.decryptString(b) });
  }
  try { await listen(server); }
  catch (e) {
    dialog.showErrorBox("Cold can't start", e.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use, so Cold can't open. Quit whatever is using it (or another copy of Cold) and try again. You can pick another port with the COLD_PORT environment variable, but saved drafts are tied to the port.`
      : `Cold's local server failed to start: ${e.message}`);
    app.quit(); return;
  }
  buildMenu();
  createWindow();
  app.on("activate", () => { if (!win) createWindow(); });
});

app.on("window-all-closed", () => { app.quit(); });
