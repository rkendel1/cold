// Installed-application smoke test: starts the real Cold binary (the installed /opt/Cold/cold by default), in a throwaway HOME, through
// the same lifecycle a pilot user goes through, with SYNTHETIC data only:
//   launch -> library created in the per-user folder -> add a lead and a draft with a handoff -> quit normally -> relaunch -> the records are
//   still there and the database file is the same file.
// It needs a display (run under xvfb-run on a server) and playwright-core (a dev dependency). It does not exercise a model, Google Sheets or
// browser-extension pairing, and it says so in its output.
//   xvfb-run -a node scripts/smoke-deb.cjs [--exe /opt/Cold/cold]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");
const { _electron } = require("playwright-core");

const exe = process.argv.includes("--exe") ? process.argv[process.argv.indexOf("--exe") + 1] : "/opt/Cold/cold";
const steps = [];
const check = (name, ok, detail = "") => { steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`); if (!ok) throw new Error(`failed: ${name}`); };
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const mode = f => (fs.statSync(f).mode & 0o777).toString(8);

async function launch(home, port) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), COLD_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: exe, args: [], env, timeout: 60000 });
  const win = await app.firstWindow();
  await win.waitForSelector("#genBtn", { state: "attached", timeout: 30000 });
  return { app, win };
}
const api = (port, p, init) => fetch(`http://127.0.0.1:${port}${p}`, init).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const put = (port, p, doc) => api(port, p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) });

/** Starts the binary exactly as the launcher does (no flags, so Chromium's own sandbox is ON), checks it serves and has renderer processes, then ends it with SIGTERM. */
async function directLaunch(home, port) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), COLD_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [], { env, stdio: "ignore" });
  const exited = new Promise(r => child.on("exit", (code, signal) => r({ code, signal })));
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { up = await api(port, "/api/data/ping").then(r => r.status === 200, () => false); if (!up) await new Promise(r => setTimeout(r, 250)); }
  check("started as the launcher starts it (no flags), the app answers on its local port", up);
  // This launch's own process tree (earlier runs of the app in this script are gone, but never match on the binary name alone).
  const rows = execFileSync("ps", ["-eo", "pid,ppid,args"], { encoding: "utf8" }).split("\n").map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], args: m[3] }));
  const tree = new Set([child.pid]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (tree.has(r.ppid) && !tree.has(r.pid)) { tree.add(r.pid); grew = true; } }
  const mine = rows.filter(r => tree.has(r.pid));
  const flagged = mine.filter(r => /(^|\s)--no-sandbox(\s|$)/.test(r.args));
  check("Chromium's sandbox is on: renderer processes run and none was started with --no-sandbox", mine.some(r => /--type=renderer/.test(r.args) && /--enable-sandbox/.test(r.args)) && !flagged.length, `${mine.length} processes, flagged: ${flagged.map(r => r.args.slice(0, 80)).join(" | ")}`);
  child.kill("SIGTERM");
  const r = await Promise.race([exited, new Promise(res => setTimeout(() => res("timeout"), 20000))]);
  if (r === "timeout") child.kill("SIGKILL");
  check("SIGTERM (end of a desktop session) ends it", r !== "timeout", JSON.stringify(r));
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cold-smoke-home-"));
  const data = path.join(home, ".config", "Cold"), db = path.join(data, "cold.db");
  const port = await freePort();
  const now = Date.now();
  console.log(`Cold smoke test\n  binary: ${exe}\n  home:   ${home}\n  port:   ${port}`);
  try {
    let { app } = await launch(home, port);
    check("the application window opens and the Cold page loads", true);
    check("the library is in the per-user folder ~/.config/Cold", fs.existsSync(db), db);
    check("the data folder is private (0700) and the library is private (0600)", mode(data) === "700" && mode(db) === "600", `${mode(data)} / ${mode(db)}`);
    const where = await api(port, "/api/settings/extension");
    check("the app reports the same database path", where.body && where.body.dbFile === db, where.body && where.body.dbFile);
    const lead = await put(port, "/api/data/leads/lead_smoke_1", { name: "Pilot Test Lead", company: "Example Co (synthetic)", email: "lead@example.invalid", list: "pilot-smoke", createdAt: now });
    const draft = await put(port, "/api/data/emails/email_smoke_1", { status: "draft", mode: "email", productId: "", recipient: { name: "Pilot Test Lead", company: "Example Co (synthetic)" }, subject: "Smoke draft (synthetic)", body: "Synthetic text. Not a real message.", createdAt: now, handoffs: [{ at: now, how: "copy" }] });
    check("a lead and a draft with a handoff are saved", lead.status === 200 && draft.status === 200, `${lead.status}/${draft.status}`);
    const before = fs.statSync(db);
    await app.close();
    check("a normal quit closes the library: no -wal/-shm files are left", !fs.existsSync(`${db}-wal`) && !fs.existsSync(`${db}-shm`), fs.readdirSync(data).filter(f => f.startsWith("cold.db")).join(", "));
    ({ app } = await launch(home, port));
    const snap = await api(port, "/api/data");
    check("after relaunch the lead is still there", snap.body.leads.some(l => l.id === "lead_smoke_1" && l.email === "lead@example.invalid"));
    const rec = snap.body.emails.find(e => e.id === "email_smoke_1");
    check("after relaunch the draft and its outreach history are still there", rec && rec.handoffs && rec.handoffs[0].how === "copy" && rec.subject === "Smoke draft (synthetic)");
    const after = fs.statSync(db);
    check("the database file was kept, not replaced", after.ino === before.ino);
    await app.close();
    await directLaunch(home, port);
    check("the library is closed after SIGTERM too", !fs.existsSync(`${db}-wal`), fs.readdirSync(data).join(", "));
    console.log("\nNot exercised here: a real model draft, Google Sheets, browser-extension pairing, a real desktop session, the launcher icon, uninstall.");
    console.log(`${steps.length}/${steps.length} smoke checks passed`);
    process.exit(0);
  } catch (e) {
    console.error(`\nsmoke test failed: ${e.message}`);
    process.exit(1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})();
