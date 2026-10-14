// Cold desktop shell: runs the Cold server inside the app on a fixed local port and shows it in a window.
// A fixed port keeps the page origin stable between launches, which is what keeps saved products and drafts.
const { app, BrowserWindow, Menu, shell, safeStorage, dialog, session, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { isSafeHandoff } = require("../lib/mailto.js");

const PORT = parseInt(process.env.COLD_PORT || "47821", 10);
const ORIGIN = `http://127.0.0.1:${PORT}`;

app.setName("Cold");

// Must be set before server.js is loaded: it switches on the Settings screen and picks where keys are saved.
// userData is Electron's per-user folder: ~/Library/Application Support/Cold (macOS), %APPDATA%\Cold (Windows), $XDG_CONFIG_HOME/Cold or ~/.config/Cold (Linux).
const DATA_DIR = app.getPath("userData");
process.env.COLD_SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
process.env.COLD_DB_FILE = path.join(DATA_DIR, "cold.db");   // products and drafts (SQLite)
process.env.HOST = "127.0.0.1";
// Optional Google Sheets sign-in for this build: desktop/google.json = { "clientId": "...", "clientSecret": "..." } (see docs/google-sheets.md). Without it the option is simply off.
try { const g = require("./google.json"); process.env.COLD_GOOGLE_CLIENT_ID ||= String(g.clientId || ""); process.env.COLD_GOOGLE_CLIENT_SECRET ||= String(g.clientSecret || ""); } catch { /* not configured */ }

let win = null;
let httpServer = null, closed = false;   // the Cold server (and its SQLite library) once started; see will-quit below

/**
 * The data folder is private to the person (leads and drafts live there), so a folder Cold creates is 0700 and a database Cold creates is
 * 0600 (SQLite gives its -wal/-shm files the same mode). Anything that already exists is left exactly as it is: nothing is chmod-ed, moved,
 * replaced or reset here. If the folder or file can't be used, this throws and the caller says so; there is no fallback location.
 */
function prepareDataFolder() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
  const db = process.env.COLD_DB_FILE;
  if (!fs.existsSync(db)) fs.closeSync(fs.openSync(db, "a", 0o600));
}

/** What the person is told when the library can't be opened: where it is, why, and that nothing was changed. No file contents. */
function dataProblem(e) {
  const why = e && e.code === "EACCES" ? "Cold doesn't have permission to use it" : e && e.code === "ENOSPC" ? "the disk is full" : e && /not a database|malformed|corrupt/i.test(String(e.message)) ? "the file doesn't look like a Cold library (it may be damaged)" : String((e && e.message) || e).split("\n")[0].slice(0, 160);
  return `Cold couldn't open your library, so it did not start.\n\nFolder: ${DATA_DIR}\nProblem: ${why}\n\nNothing that was already there was changed, moved or deleted, and Cold has not started a new library in another place. Fix the problem (permissions, free space, or restore a backup of the cold.db files) and start Cold again.`;
}

// Checked BEFORE the single-instance lock: Chromium keeps that lock inside this folder, so in a folder Cold can't write to the lock can't be taken
// and the app would quit quietly as if another copy were already running. A person must be told instead.
try { prepareDataFolder(); }
catch (e) { dialog.showErrorBox("Cold can't open its library", dataProblem(e)); process.exit(1); }
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

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
    width: 1100, height: 860, minWidth: 720, minHeight: 600, title: "Cold", icon: path.join(__dirname, "../public/brand/logo-512.png"),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true, preload: path.join(__dirname, "preload.js") },
  });
  win.loadURL(ORIGIN);
  // Keep the window on Cold: external links open in the browser, everything else is blocked.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); } });
  win.on("closed", () => { win = null; });
}

// "Open in email": the page may ask the OS to open ONE kind of link: a mailto: draft in the user's email app, or the exact compose link of Gmail or Outlook in the browser, and only from Cold's
// own window. Anything else (other schemes, extra parameters, other senders) is refused here, in the main process, regardless of
// what the page sends. Cold never sends mail; this only opens an unsent draft.
ipcMain.handle("cold:open-mail", async (event, url) => {
  const from = event.senderFrame && event.senderFrame.url;
  if (!from || !from.startsWith(ORIGIN)) return { ok: false, message: "not allowed from here" };
  if (!isSafeHandoff(url)) return { ok: false, message: "not a valid email link" };
  try { await shell.openExternal(url); return { ok: true }; }
  catch (e) { return { ok: false, message: e && e.message ? String(e.message).split("\n")[0].slice(0, 120) : "the system couldn't open it" }; }
});

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(path.join(__dirname, "../public/brand/logo-512.png"));   // dev runs; a packaged app gets its icon from the build
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  let server;
  try { server = require("../server.js"); }   // server.js opens the SQLite library when it loads
  catch (e) { dialog.showErrorBox("Cold can't open its library", dataProblem(e)); app.exit(1); return; }
  httpServer = server;
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
// The end of a desktop session (logout, shutdown) or Ctrl-C in a terminal arrives as a signal: quit the same way as the menu does, so the library is closed.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => app.quit());

// Quit cleanly: stop answering, then close the SQLite library so SQLite merges its write-ahead log into cold.db and removes the -wal/-shm
// files. (A crash or kill is still safe: the next launch recovers from them, which is why a backup copies every cold.db* file.)
app.on("will-quit", () => {
  if (closed || !httpServer) return;
  closed = true;
  try { httpServer.closeAllConnections && httpServer.closeAllConnections(); httpServer.close(); } catch { /* already stopped */ }
  try { httpServer.db && httpServer.db.close(); } catch (e) { console.error(`Cold: closing the library failed: ${String(e && e.message).split("\n")[0]}`); }
});
