// Google Sheets setup: the optional way to keep leads and outreach in the person's own spreadsheet instead of in this app.
// One guided flow, the same on web, desktop and the extension (sign-in differs underneath; see services/googleAuth.js):
//   1 Connect Google (one narrow permission)  ->  2 Choose a spreadsheet  ->  3 Move what you have  ->  done
// After setup the panel shows the connection's health and how to stop. Nothing changes until the last step is confirmed.
import { h, clear, append } from "../components/dom.js";
import { button, notice, toast, announce } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";

const STEPS = ["Connect Google", "Choose a spreadsheet", "Move what you have"];

/** What a person needs to know before they agree: short, and true to what the code does. */
const FACTS = [
  "Your leads and outreach drafts are rows in a spreadsheet in your own Google Drive. Edit them in Google Sheets or in Cold; both stay in step.",
  "Cold asks Google for one narrow permission: files that Cold itself creates. It can't see your other files, your email or your contacts.",
  "Your products, settings and model keys stay where they are now. Cold still never sends email for you.",
  "You can stop at any time. Leaving copies your leads and drafts back, and the spreadsheet stays in your Drive.",
];

export function mountSheetsSetup({ store, platform, reload = () => globalThis.location.reload() }) {
  const S = store.state, c = platform.sheets;
  const host = h("div", { class: "sheets-setup", id: "sheetsSetup" });
  if (!c || !c.available) {
    return append(host, [notice("neutral", h("p", {}, "Google Sheets isn't available in this copy of Cold, because no Google sign-in has been set up for it. Your leads and outreach are kept ", store.whereFrom ? store.whereFrom() : "here", ". See docs/google-sheets.md for how to turn it on."))]);
  }
  let step = null, choice = "new", pasted = "", move = true, busy = false, error = "", signInUrl = "";
  const surface = S.surface === "extension" ? "extension" : S.surface === "desktop" || S.backend === "sqlite" ? "desktop app" : "browser";

  const rail = i => h("ol", { class: "steps", "aria-label": "Setup steps" }, STEPS.map((t, k) => h("li", { class: k === i ? "current" : k < i ? "done" : "", "aria-current": k === i ? "step" : null }, `${k + 1}. ${t}`)));
  const problem = () => (error ? notice("bad", h("p", {}, error)) : null);
  const nav = (...btns) => h("div", { class: "actions" }, ...btns);
  const go = (s, keep) => { step = s; if (!keep) error = ""; paint(); announce(typeof s === "number" ? STEPS[s] : "Google Sheets"); };
  const say = e => (e && e.message) || "Something went wrong. Try again.";

  /* ---------- not set up ---------- */
  function home() {
    return [h("h3", {}, "Keep leads and outreach in Google Sheets"),
      h("p", { class: "hint" }, "Optional. Cold works fully without it."),
      h("ul", { class: "plain" }, FACTS.map(f => h("li", {}, f))),
      nav(button("Set up Google Sheets", { kind: "primary", id: "sheetsStart", onclick: () => go(c.connected ? 1 : 0) }))];
  }

  /* ---------- 1. connect ---------- */
  function connectStep() {
    const link = signInUrl ? h("p", { class: "hint", id: "sheetsWait", role: "status" }, "Finish signing in in the window that opened. If nothing opened, ", h("a", { href: signInUrl, target: "_blank", rel: "noopener" }, "open Google sign-in here"), ".") : null;
    return [rail(0), h("h3", {}, "Connect your Google account"),
      h("p", {}, `Cold will ask Google for permission to create and use one spreadsheet. Google opens its own sign-in ${surface === "desktop app" ? "in your web browser" : "window"}; Cold never sees your Google password.`),
      problem(), link,
      nav(button(busy ? "Waiting for Google…" : "Connect Google", { kind: "primary", id: "sheetsConnect", disabled: busy, onclick: async () => {
        busy = true; error = ""; signInUrl = ""; paint();
        try { await c.connect({ onUrl: u => { signInUrl = u; paint(); } }); busy = false; signInUrl = ""; go(1); }
        catch (e) { busy = false; signInUrl = ""; error = say(e); paint(); }
      } }), button("Cancel", { kind: "ghost", id: "sheetsCancel", onclick: () => go(null) }))];
  }

  /* ---------- 2. choose ---------- */
  function chooseStep() {
    const radio = (v, label, hint) => h("label", { class: "choice" }, h("input", { type: "radio", name: "sheetChoice", value: v, checked: choice === v, onchange: () => { choice = v; paint(); } }), h("span", {}, h("strong", {}, label), h("span", { class: "hint block" }, hint)));
    const input = choice === "existing" ? h("div", { class: "field" }, h("label", { for: "sheetLink" }, "Link to the spreadsheet"), h("input", { type: "text", id: "sheetLink", autocomplete: "off", placeholder: "https://docs.google.com/spreadsheets/d/…", value: pasted, oninput: e => { pasted = e.target.value; } }),
      h("p", { class: "hint" }, "It must be a spreadsheet Cold created for you (for example from another device). Google doesn't let Cold open other spreadsheets.")) : null;
    return [rail(1), h("h3", {}, "Choose a spreadsheet"),
      radio("new", "Create a new spreadsheet", "Called “Cold: leads and outreach”, with a Leads tab and an Outreach tab, in your Google Drive."),
      radio("existing", "Use a spreadsheet Cold already made", "Choose this to connect this device to the sheet you set up on another one."),
      input, problem(),
      nav(button("Next", { kind: "primary", id: "sheetsNext", disabled: busy, onclick: async () => {
        error = "";
        if (choice === "existing") { busy = true; paint(); try { await c.useSheet(pasted); busy = false; go(2); } catch (e) { busy = false; error = say(e); paint(); } return; }
        go(2);
      } }), button("Back", { kind: "ghost", onclick: () => go(0) }), button("Cancel", { kind: "ghost", onclick: () => go(null) }))];
  }

  /* ---------- 3. move what you have, then do it ---------- */
  function moveStep() {
    const nL = S.leads.length, nE = S.emails.length, any = nL + nE > 0;
    return [rail(2), h("h3", {}, "Move what you have"),
      any ? h("label", { class: "check" }, h("input", { type: "checkbox", id: "sheetsMove", checked: move, onchange: e => { move = e.target.checked; } }), ` Copy my ${nL} lead${nL === 1 ? "" : "s"} and ${nE} draft${nE === 1 ? "" : "s"} into the sheet`)
        : h("p", {}, "You have no leads or drafts yet, so there is nothing to move."),
      h("p", { class: "hint" }, `Copies stay in this ${surface} as a backup. Anything already in the sheet is left as it is. After this, new leads and drafts are saved in the sheet.`),
      problem(),
      nav(button(busy ? "Setting up…" : "Finish setup", { kind: "primary", id: "sheetsFinish", disabled: busy, onclick: finish }), button("Back", { kind: "ghost", disabled: busy, onclick: () => go(1) }))];
  }
  async function finish() {
    busy = true; error = ""; paint();
    try {
      if (choice === "new" && !c.link) await c.createSheet();
      const db = await c.open(store.database(), { strict: true, poll: true });   // a sheet made earlier in this flow (after a failed try) is reused, not made twice
      if (move && (S.leads.length || S.emails.length)) await c.copyInto(db.sheets, { leads: S.leads, emails: S.emails });
      await c.save();
      busy = false; step = "done"; paint(); announce("Google Sheets is set up");
    } catch (e) { busy = false; error = say(e); paint(); }
  }

  function done() {
    return [h("h3", {}, "You're set up"), h("p", {}, "Your leads and outreach now live in ", h("a", { href: c.link.url, target: "_blank", rel: "noopener" }, c.link.title || "your spreadsheet"), "."),
      nav(button("Start using it", { kind: "primary", id: "sheetsDone", onclick: () => reload() }))];
  }

  /* ---------- set up: health, open, refresh, stop ---------- */
  function linked() {
    const st = c.status || { state: "connecting" }, bad = st.state === "error";
    const authBad = bad && (st.code === "google_auth" || !c.connected);
    return [h("h3", {}, "Google Sheets"),
      h("p", { id: "sheetsLine" }, "Leads and outreach are kept in ", h("a", { href: c.link.url, target: "_blank", rel: "noopener" }, c.link.title || "your spreadsheet"), "."),
      bad ? notice("warn", h("p", { id: "sheetsProblem" }, st.message || "Cold can't reach the spreadsheet right now."), h("p", { class: "hint" }, "Nothing is lost. What you see here is what was last read from the sheet; changes will be saved once the connection is back.")) : h("p", { class: "hint", id: "sheetsOk" }, st.state === "ok" ? "Connected and in step with the sheet." : "Connecting…"),
      problem(),
      nav(
        authBad ? button("Reconnect Google", { kind: "primary", id: "sheetsReconnect", onclick: async () => { try { await c.connect(); await c.db.sheets.refresh(); error = ""; } catch (e) { error = say(e); } paint(); } }) : null,
        button("Refresh from the sheet", { id: "sheetsRefresh", onclick: async () => { try { await c.db.sheets.refresh(); toast("Refreshed"); error = ""; } catch (e) { error = say(e); } paint(); } }),
        h("a", { class: "btn", href: c.link.url, target: "_blank", rel: "noopener", id: "sheetsOpen" }, "Open in Google Sheets"),
        button("Stop using Google Sheets", { kind: "ghost danger", id: "sheetsStop", onclick: stop }))];
  }
  async function stop() {
    if (!(await confirmDialog({ title: "Stop using Google Sheets?", body: `Cold copies your leads and drafts from the sheet back into this ${surface}, then goes back to saving them here. Cold also signs out of Google here and asks Google to revoke its access. The spreadsheet stays in your Google Drive untouched.`, confirmLabel: "Copy back and stop" }))) return;
    try {
      const sheets = c.db.sheets, primary = c.db.primary, snap = sheets.snapshot();
      const put = (name, list) => (primary.setMany ? primary.setMany(name, list) : Promise.all(list.map(d => { const { id, ...rest } = d; return primary.doc(`${name}/${id}`).set(rest); })));
      await put("leads", snap.leads); await put("emails", snap.emails);
      await c.unlink(); await c.disconnect().catch(() => {}); reload();   // forget the sign-in too: a stopped connection must not leave Google access behind
    } catch (e) { error = `Couldn't copy your data back, so nothing was changed. ${say(e)}`; paint(); }
  }

  function paint() {
    const body = step === "done" ? done() : c.link && step === null ? linked() : step === null ? home() : step === 0 ? connectStep() : step === 1 ? chooseStep() : moveStep();
    append(clear(host), body.filter(Boolean));
  }
  c.subscribe(() => { if (step === null) paint(); });
  paint();
  return host;
}
