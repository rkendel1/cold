// "Second check": an optional, independent review of a drafted email by the model the user already chose, as typed questions (see
// src/domain/jevChecks.js). It never changes the draft or its score, isn't saved, and runs only when the user presses the button.
import { h, clear } from "../components/dom.js";
import { button, notice } from "../components/ui.js";
import { checkDraft } from "../domain/jevChecks.js";

const MARK = { ok: ["pass", "✓", "Looks fine: "], concern: ["fail", "!", "Worth a look: "], unchecked: ["unk", "–", "Not checked: "] };

export function mountSecondCheck({ getRec, getProduct, sample }) {
  const out = h("div", { id: "secondResult", "aria-live": "polite" });
  let ranOn = "", busy = false;
  const sig = r => JSON.stringify([r.subject, r.what, r.why, r.ask]);
  const run = button("Run a second check", { id: "secondRun", onclick: async () => {
    const s = sample(); if (busy || !s) return;
    const rec = getRec(); busy = true; run.disabled = true; clear(out).append(h("p", { role: "status" }, "Asking your model…"));
    try {
      const rows = await checkDraft({ sample: s, rec, product: getProduct() });
      ranOn = sig(rec);
      const worth = rows.filter(r => r.status === "concern").length;
      clear(out).append(
        h("p", { id: "secondSummary", role: "status" }, worth ? `${worth} thing${worth === 1 ? "" : "s"} worth a look. The model can be wrong; you decide.` : "Nothing stood out. That is a second opinion, not a guarantee."),
        h("ul", { class: "checks" }, rows.map(r => { const [cls, ic, say] = MARK[r.status]; return h("li", { class: cls, dataset: { rule: String(r.rule), status: r.status } },
          h("span", { class: "ic", "aria-hidden": "true" }, ic), h("span", {}, h("span", { class: "sr-only" }, say), r.label, r.detail ? h("span", { class: "why" }, r.detail) : null)); })));
    } catch (e) { clear(out).append(notice("bad", h("p", {}, (e && e.message) || "The second check couldn't run. Your draft is unchanged."))); }
    finally { busy = false; run.disabled = !sample(); }
  } });
  const stale = h("p", { class: "hint", id: "secondStale", hidden: true }, "You've edited the draft since this check. Run it again to review the new text.");
  const el = h("section", { class: "card stack", "aria-labelledby": "second-title", id: "secondCheck" },
    h("h2", { id: "second-title" }, "Second check (optional)"),
    h("p", { class: "hint" }, "Asks the model you already use a few yes/no and multiple-choice questions about this draft, as an independent second opinion. It can be wrong, it doesn't change the score and it isn't saved. The draft and your product facts go to that model, as they did when you generated it."),
    h("div", { class: "actions" }, run), stale, out);
  return { el, refresh() { run.disabled = busy || !sample(); stale.hidden = !ranOn || ranOn === sig(getRec()); } };
}
