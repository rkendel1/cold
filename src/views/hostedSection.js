// Settings > Cold account > Library. Two libraries, side by side and independent: the local library on this device (the default, needs no account, and exactly what you had before) and
// your hosted library on the Cold server (one per account, reachable from web, desktop and extension). Choosing is explicit and reversible. It never copies, merges or deletes
// anything, and signing in doesn't choose.
import { h, clear, append } from "../components/dom.js";
import { button, notice, announce } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import { unavailableDb, hostedReason } from "../services/hostedLibrary.js";

const counts = s => `${s.leads} lead${s.leads === 1 ? "" : "s"}, ${s.emails} draft${s.emails === 1 ? "" : "s"}, ${s.products} product${s.products === 1 ? "" : "s"}`;
const WHY = new Proxy({}, { get: (_, code) => hostedReason(String(code)) });

export function mountHostedSection({ store, platform, lib, choice }) {
  const S = store.state, host = h("div", { id: "hostedSection", "aria-live": "polite" });
  let signedIn = false, message = null, info = null, busy = false;
  const localDb = () => (platform.hub ? platform.hub.replica : platform.localDb);
  const kids = (...x) => append(clear(host), [h("h3", {}, "Library"), message ? notice(message.kind, h("p", { id: "hostedMessage", role: message.kind === "bad" ? "alert" : null }, message.text)) : null, ...x]);

  function draw() {
    const db = store.database();
    if (S.backend === "hosted") {
      if (db && db.unavailable) return kids(h("p", { id: "hostedUnavailable" }, h("strong", {}, "Hosted library selected, but unavailable. "), db.unavailable.message),
        h("p", { class: "hint" }, "Your local library is untouched and isn't shown here. Nothing you do now is saved anywhere."),
        h("div", { class: "actions" }, button("Try again", { id: "hostedRetry", disabled: busy || !signedIn && db.unavailable.code === "session_expired", onclick: () => open(false) }), button("Use my local library", { id: "useLocalBtn", disabled: busy, onclick: toLocal })));
      if (!signedIn) return kids(h("p", { id: "hostedSignedOut" }, h("strong", {}, "Hosted library is open, but you're signed out. "), "Changes can't be saved to it until you sign in again, and nothing is saved on this device instead. Copy any draft you want to keep."),
        h("div", { class: "actions" }, button("Use my local library", { id: "useLocalBtn", disabled: busy, onclick: toLocal })));
      return kids(h("p", { id: "hostedActive" }, h("strong", {}, "Hosted library is open. "), "What you see and save in Cold is stored on the Cold server under your Google account, and you can open it from the web app, the desktop app and the extension."),
        h("p", { class: "hint" }, "The library on this device is separate: it wasn't uploaded and isn't changed while the hosted library is open."),
        h("div", { class: "actions" }, button("Use my local library", { id: "useLocalBtn", disabled: busy, onclick: toLocal })));
    }
    if (S.storage === "sheets") return kids(h("p", { class: "hint", id: "hostedSheets" }, "Google Sheets is in use, so the hosted library isn't available. Stop using Google Sheets first (Settings > Google Sheets)."));
    const head = h("p", { id: "hostedLocalActive" }, h("strong", {}, "Local library is open. "), "You're working with the data stored on this device. Signing in didn't change that, and signing in doesn't back it up.");
    if (!signedIn) return kids(head, h("p", { class: "hint", id: "hostedNeedsSignIn" }, "To use a hosted library, sign in with Google above."));
    if (!info) return kids(head, h("p", { class: "hint" }, "Checking your hosted library…"));
    if (info.error) return kids(head, h("div", { class: "actions" }, button("Try again", { id: "hostedInfoRetry", onclick: load })));
    if (info.disabled) return kids(head, h("p", { class: "hint", id: "hostedDisabled" }, WHY.hosted_disabled));
    if (!info.exists) return kids(head, h("p", { class: "hint" }, "Your account can also have a hosted library: one library kept on the Cold server and available from every surface you sign in on. It starts empty. Nothing from this device is uploaded, copied or merged."),
      h("div", { class: "actions" }, button("Create my hosted library…", { id: "hostedCreate", disabled: busy, onclick: create })));
    kids(head, h("p", { class: "hint", id: "hostedSummary" }, `Your hosted library has ${counts(info)}. Opening it shows those instead of this device's data; nothing is copied or merged.`),
      h("div", { class: "actions" }, button("Open my hosted library…", { id: "hostedOpen", disabled: busy, onclick: () => open(false, true) })));
  }
  async function load() {
    if (!signedIn || S.backend === "hosted") { info = null; return draw(); }
    info = null; draw();
    try { info = await lib.summary(); }
    catch (e) { if (e.code === "hosted_disabled") info = { disabled: true }; else { info = { error: true }; message = { kind: "bad", text: e.code === "session_expired" ? WHY.session_expired : `Couldn't check your hosted library: ${e.message}` }; } }
    draw();
  }
  async function swap(db, text) {
    store.switchLibrary(db); await choice.set(true);
    store.set({ library: "hosted", paired: false }, "surface");
    message = { kind: db.unavailable ? "warn" : "good", text }; draw();
  }
  async function open(created, confirm) {
    if (confirm && !(await confirmDialog({ title: "Open your hosted library?", body: "The hosted library is separate from the library on this device. Your local records are not uploaded, copied or merged, and you can switch back at any time. While it is open, everything you see and save is in the hosted library.", confirmLabel: "Open hosted library" }))) return;
    busy = true; message = null; draw();
    try { const db = await lib.open(); await swap(db, created ? "Your hosted library was created and is open. It is empty." : "Your hosted library is open."); announce("Hosted library open"); }
    catch (e) {
      if (S.backend === "hosted") { store.switchLibrary(unavailableDb({ code: e.code, message: WHY[e.code] || e.message })); message = { kind: "bad", text: WHY[e.code] || e.message || "Couldn't open your hosted library." }; }
      else message = { kind: "bad", text: `Your hosted library wasn't opened and your local library is unchanged. ${WHY[e.code] || e.message || ""}`.trim() };
    }
    busy = false; draw();
  }
  async function create() {
    if (!(await confirmDialog({ title: "Create your hosted library?", body: "It will be stored on the Cold server under your Google account and starts empty. Nothing on this device is uploaded, copied or merged, and you can switch back to the local library at any time.", confirmLabel: "Create hosted library" }))) return;
    busy = true; message = null; draw();
    try { await lib.create(); } catch (e) { busy = false; message = { kind: "bad", text: `Couldn't create your hosted library, and nothing was changed here. ${e.message || ""}`.trim() }; return draw(); }
    await open(true, false);
  }
  async function toLocal() {
    if (!(await confirmDialog({ title: "Switch to your local library?", body: "Your hosted library isn't deleted or changed; you can open it again any time. The local library shows exactly what it held before.", confirmLabel: "Use local library" }))) return;
    backToLocal("You're using the library on this device. Your hosted library is unchanged.");
  }
  async function backToLocal(text) {
    const cur = store.database(); if (cur && cur.stop) cur.stop();
    store.switchLibrary(localDb()); await choice.set(false);
    store.set({ library: platform.hub ? platform.hub.libs.kind : S.backend === "sqlite" ? "desktop" : "standalone", paired: !!platform.hub && platform.hub.libs.kind === "synced" }, "surface");
    message = { kind: "good", text }; info = null; announce("Local library open"); load();
  }
  /** The account section reports whether anyone is signed in. Signing out while the hosted library is open returns to the local library (never leaves hosted writes pointing at nothing). */
  function update(nextSignedIn, { signedOut } = {}) {
    const was = signedIn; signedIn = nextSignedIn;
    if (signedOut && S.backend === "hosted") return backToLocal("You're signed out, so you're back on the library on this device. Your hosted library is unchanged.");
    if (was !== signedIn) { info = null; load(); } else draw();
  }
  draw();
  return Object.assign(host, { update });
}
