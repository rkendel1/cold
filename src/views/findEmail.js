// Find email: look for a missing work email for one saved lead, review the candidate, and accept or reject it. A candidate is not a
// confirmed identity, and a deliverable address is not necessarily the right person's: identity, source, the provider's own check and a
// deliverability check are shown as separate things, and nothing is saved until the user accepts. Lookups go through the app's server,
// which holds the treg token (see lib/treg.js); this file never sees it.
import { h, clear, append } from "../components/dom.js";
import { button, notice, chip, field, textInput, toast, announce } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import people from "../../lib/people-shared.js";

const money = v => (v == null ? "" : `$${v < 0.01 ? v.toFixed(4) : v.toFixed(3)}`);

export function mountFindEmail({ store, platform, lead, onAccepted }) {
  const svc = platform.people;
  const domain = field({ id: "feDomain", label: "Company website or domain (optional)", required: null, hint: "Used only for this lookup, e.g. acme.com. Not saved to the lead. Cold doesn't guess it.", control: textInput({ placeholder: "acme.com" }) });
  const result = h("div", { id: "feResult", "aria-live": "polite" });
  const findBtn = button("Find email", { kind: "primary", id: "feFind", onclick: () => search() });
  let running = false, locked = false;   // locked: treg may still be working on an earlier search, so another billable one is not started

  const el = h("section", { class: "card find-email", id: "findEmail", "aria-labelledby": "fe-title" },
    h("h3", { id: "fe-title" }, "Find email"),
    h("p", { class: "hint" }, "Cold sends this person's name and company domain (or LinkedIn link) to treg, which may ask other data providers. Nothing is saved until you accept it. A found address is a candidate, not a confirmed identity."),
    domain, h("div", { class: "actions" }, findBtn), result);

  const say = (...kids) => append(clear(result), kids);
  function unavailable() {
    return notice("warn", h("p", {}, "Email lookup isn't set up. Add a treg token in the Cold desktop app's Settings (Integrations), or set TREG_TOKEN on the server. Until then, type the address yourself."));
  }
  if (!svc || !svc.available()) say(unavailable());

  async function search() {
    if (running || locked) return;
    const cur = store.leadById(lead.id) || lead;
    if (cur.email) return say(notice("info", h("p", {}, "This lead already has an email address. Edit it in the form above; Cold won't replace it for you.")));
    const req = people.buildFindRequest({ name: cur.name, profileUrl: cur.profileUrl, domain: domain.input.value });
    if (!req.ok) return say(notice("warn", h("p", {}, req.message)));
    if (!svc || !svc.available()) return say(unavailable());
    running = true; findBtn.disabled = true; say(h("p", { role: "status" }, "Searching…"));
    let res;
    try { res = await svc.findEmail({ name: cur.name, linkedin: cur.profileUrl, domain: domain.input.value }); }
    catch (e) { res = { ok: false, message: (e && e.message) || "Couldn't run the search." }; }
    running = false; findBtn.disabled = locked; findBtn.textContent = "Search again";
    if (!res.ok) return say(notice("bad", h("p", {}, res.message || "The search failed."), h("p", { class: "hint" }, "Nothing was saved. Cold didn't retry automatically: a retry can be billed again.")));
    if (res.pending) { locked = true; findBtn.disabled = true; return say(notice("info", h("p", {}, res.message))); }
    if (!res.candidates || !res.candidates.length) return say(h("p", { id: "feMiss" }, res.message || "No email found."), cost(res));
    say(h("p", { class: "hint" }, `${res.candidates.length === 1 ? "1 candidate" : `${res.candidates.length} candidates`} to review. Pick one only if you're satisfied it is the right person.`),
      res.candidates.map(c => candidate(c, res)), cost(res));
  }
  const cost = res => (res.chargedUsd != null || (res.tried && res.tried.length)
    ? h("p", { class: "hint", id: "feCost" }, [res.chargedUsd != null ? `treg reported a charge of ${money(res.chargedUsd)}.` : "", res.tried && res.tried.length ? `Providers tried: ${res.tried.join(", ")}.` : ""].filter(Boolean).join(" ")) : null);

  function candidate(c) {
    const verdict = h("div", { class: "fe-verdict", id: "feVerdict", role: "status" }, h("span", {}, "Deliverability: "), chip("neutral", "Not checked yet", { glyph: false }));
    const msg = h("p", { class: "hint", role: "status", id: "feMsg" });
    let busy = false;
    const verify = button("Verify deliverability", { id: "feVerify", onclick: async () => {
      if (busy) return; busy = true; verify.disabled = true; msg.textContent = "Checking…";
      try {
        const r = await svc.verifyEmail({ email: c.email });
        if (!r.ok) { msg.textContent = `${r.message || "The check failed."} The address is still unchecked.`; return; }
        const word = r.status || (r.valid === true ? "valid" : r.valid === false ? "invalid" : null), v = people.verdictCopy(word);
        clear(verdict).append(h("span", {}, "Deliverability: "), chip(v.tone === "neutral" ? "neutral" : v.tone, v.label, { glyph: false }), h("p", { class: "hint" }, `${v.detail}${r.servedBy ? ` Checked by ${r.servedBy}.` : ""}${r.chargedUsd ? ` Charge reported: ${money(r.chargedUsd)}.` : ""}`));
        msg.textContent = "";
      } catch (e) { msg.textContent = `${(e && e.message) || "The check failed."} The address is still unchecked.`; }
      finally { busy = false; verify.disabled = false; }
    } });
    const accept = button("Accept and save to this lead", { kind: "primary", id: "feAccept", onclick: async () => {
      const fresh = store.leadById(lead.id);
      if (!fresh) { msg.textContent = "This lead no longer exists. Nothing was saved."; return; }
      if (fresh.email && fresh.email.toLowerCase() !== c.email.toLowerCase()
        && !(await confirmDialog({ title: "Replace the email on this lead?", body: `${fresh.name || "This lead"} now has ${fresh.email}. Replace it with ${c.email}?`, confirmLabel: "Replace email", danger: true }))) return;
      accept.disabled = true;
      try {
        await store.saveLead({ ...fresh, email: c.email });
        clear(result).append(notice("good", h("p", { id: "feSaved" }, `Saved ${c.email} to ${fresh.name || "this lead"}. Cold will use it when you open a draft in your email app. Nothing has been written or sent.`)));
        toast("Email saved to the lead"); announce("Email saved to the lead");
        if (onAccepted) onAccepted(store.leadById(lead.id));
        el.querySelector("#feFind").hidden = true;
      } catch { accept.disabled = false; msg.textContent = "Couldn't save. The lead is unchanged; try again."; }
    } });
    const reject = button("Reject", { kind: "ghost", id: "feReject", onclick: () => { say(h("p", { class: "hint", id: "feRejected" }, "Candidate discarded. The lead is unchanged.")); announce("Candidate discarded"); } });
    const pct = c.confidence == null ? "Not given" : `${Math.round(c.confidence * 100)}% as scored by the provider (how sure it is this is the right person; not proof)`;
    return h("div", { class: "fe-candidate", dataset: { email: c.email } },
      h("p", {}, h("strong", { id: "feEmail" }, c.email)),
      h("dl", { class: "fe-facts" },
        h("dt", {}, "Found by"), h("dd", {}, c.provider || "Not stated"),
        h("dt", {}, "Source"), h("dd", {}, c.source || "The provider didn't supply a source."),
        h("dt", {}, "Person match"), h("dd", {}, pct),
        h("dt", {}, "Provider's own check"), h("dd", {}, c.providerChecked === true ? "The provider says it checked the mailbox. That is its claim, not a Cold verification." : c.providerChecked === false ? "The provider says it did not check the mailbox (the address may be inferred)." : "Not stated")),
      verdict, h("div", { class: "actions" }, verify, accept, reject), msg);
  }
  return el;
}
