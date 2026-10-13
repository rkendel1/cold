// A compact, dismissible checklist on Write for an installation that hasn't yet used Cold. Honest by construction: each step reads real state (see domain/firstRun.js),
// nothing is stored as "done", there is no sample data, and the optional leads step never mentions or requires Google Sheets.
import { h, clear, append } from "../components/dom.js";
import { button, chip, announce } from "../components/ui.js";
import { firstRunSteps, requiredDone, isEstablished, shouldShowFirstRun } from "../domain/firstRun.js";

export function mountFirstRun({ store, navigate }) {
  const S = store.state;
  const el = h("section", { id: "firstRun", class: "card first-run", "aria-labelledby": "firstRun-title", hidden: true });
  let sessionStarted = false;   // this page session saw an incomplete checklist (memory only), so it can show "You're set up" once

  const help = (step) => {
    if (step.id === "model") {
      if (step.done) return "A model is ready.";
      if (step.checking) return "Checking…";
      return step.canConfigure ? "Cold needs an AI model to write drafts. Choose a provider (or a model on your computer) in Settings."
        : "This site has no model connected. Only whoever runs it can add one. You can use the Cold desktop app instead.";
    }
    if (step.id === "product") return step.done ? "Saved in Knowledge." : "Type your product's name and one plain sentence in the form below. It is saved once.";
    if (step.id === "draft") return step.done ? "Copied or opened. (Cold records that, not that you sent it.)" : "Say who you're writing to and why, press Generate draft, edit, then Copy email. Cold never sends anything.";
    return step.done ? "Leads imported." : "Optional. Download the CSV template, fill it in, and import it. Or skip this and add people one at a time.";
  };
  const action = step => (step.done ? null : step.id === "model" && step.canConfigure ? button("Open Settings", { kind: "ghost", onclick: () => navigate("settings") })
    : step.id === "leads" ? button("Open Leads", { kind: "ghost", onclick: () => navigate("leads") }) : null);

  function dismiss() {
    store.saveSettings({ firstRun: "dismissed" }).catch(() => {});
    el.hidden = true; announce("Checklist hidden");
    document.getElementById("compose-title")?.focus();
  }

  function paint() {
    const steps = firstRunSteps({ products: S.products, emails: S.emails, leads: S.leads, sampleState: S.sampleState, canConfigureModel: !!(S.server && S.server.settingsEnabled) });
    const established = isEstablished({ emails: S.emails }), settled = S.ready && S.sampleState !== "pending";   // wait until we know whether a model is ready, or a finished install would flash it
    const all = requiredDone(steps);
    if (settled && !established && S.settings.firstRun !== "dismissed" && !all) sessionStarted = true;   // in memory only: nothing is written because a page loaded
    if (!shouldShowFirstRun({ firstRun: S.settings.firstRun, ready: settled, steps, established, sessionStarted })) { el.hidden = true; return; }
    clear(el);
    append(el, [
      h("h2", { id: "firstRun-title" }, all ? "You're set up" : "Get started"),
      h("p", { class: "hint" }, all ? "The three required steps are done. Leads are optional." : "Three steps to your first draft, and one optional. Nothing is sent, and you can hide this any time."),
      h("ol", { class: "first-run-steps" }, steps.map(s => h("li", { dataset: { step: s.id, done: String(s.done) } },
        h("div", { class: "first-run-head" }, chip(s.done ? "good" : "neutral", s.done ? "Done" : s.optional ? "Optional" : "To do"), " ", h("strong", {}, s.label)),
        h("p", { class: "hint" }, help(s)), action(s)))),
      h("div", { class: "actions" }, button("Hide this checklist", { kind: "ghost", id: "firstRunDismiss", onclick: dismiss }))]);
    el.hidden = false;
  }
  store.subscribe(t => { if (["ready", "products", "emails", "leads", "server", "settings"].includes(t)) paint(); });
  paint();
  return { el, paint };
}
