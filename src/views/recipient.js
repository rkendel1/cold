// Recipient assist: reads a LinkedIn / X profile (or pasted profile text) into the form, works out who the recipient is,
// and suggests grounded reasons they might care. Everything it produces is shown for the sender to edit; nothing is sent.
import { h, clear } from "../components/dom.js";
import { button, announce } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import { extractProfile, suggestReasons, describeError } from "../services/generation.js";

export function createRecipientAssist({ f, S, platform, readForm, persist: persistForm, getProduct }) {
  const val = c => c.input.value.trim();
  const reasoningProduct = getProduct;
  const lookupBtn = button("Look up", { id: "lookupBtn", onclick: () => lookupProfile() });
  const readPastedBtn = button("Read pasted text", { id: "readPastedBtn", onclick: () => readPasted() });
  const profileStatus = h("p", { class: "hint", id: "profileStatus", role: "status" });
  const pasteDetails = h("details", { class: "panel", id: "pasteDetails" }, h("summary", {}, "Paste profile text instead"), h("div", { class: "in" }, f.profilePaste, h("div", { class: "actions" }, readPastedBtn)));
  const profileBlock = h("div", { class: "form", id: "profileBlock" },
    h("div", { class: "field" }, h("label", { for: "rProfileUrl" }, "Their LinkedIn or X profile ", h("span", { class: "opt" }, "Optional")), h("p", { class: "hint", id: "rProfileUrl-hint" }, "Paste a link and Cold reads the public profile to fill in who they are. Nothing is posted or sent to them."), h("div", { class: "actions inline-input" }, f.profileUrl.input, lookupBtn), h("p", { class: "field-error", id: "rProfileUrl-err", hidden: true })),
    profileStatus, pasteDetails, f.profile);
  f.profileUrl.input.setAttribute("aria-describedby", "rProfileUrl-hint rProfileUrl-err profileStatus");
  const reasonBtn = button("Suggest reasons from their profile", { id: "reasonBtn", onclick: () => suggest() });
  const reasonHost = h("div", { id: "reasonBox", class: "reason-box", "aria-live": "polite" });
  const reasonEl = h("div", {}, h("div", { class: "actions" }, reasonBtn), reasonHost);

  /* ---------- profile lookup ---------- */
  let profileCtl = null;
  let epoch = 0;   // bumped by reset(): results of lookups started before a clear are discarded
  function setProfileBusy(busy, msg) {
    lookupBtn.disabled = busy; readPastedBtn.disabled = busy;
    lookupBtn.textContent = busy ? "Reading…" : "Look up";
    if (msg != null) profileStatus.textContent = msg;
    if (msg) announce(msg);
  }
  /** Fills empty identity fields (never overwrites what the user typed) and replaces the profile notes. */
  function applyProfile(r, url) {
    const filled = [];
    for (const k of ["name", "role", "company"]) if (r[k] && !val(f[k])) { f[k].input.value = r[k]; filled.push(k); }
    f.profile.input.value = r.notes || "";
    if (url) f.profileUrl.input.value = url;
    persistForm();
    const what = filled.length ? `Filled in ${filled.join(", ")}` : "Read the profile";
    return `${what}${r.notes ? " and saved notes below" : ". It had little to add, so there are no notes"}. Check them, then say why they should care.`;
  }
  async function readProfileText(text, url) {
    const mine = epoch;
    profileCtl = new AbortController();
    try {
      const r = await extractProfile({ sample: S.sample, text, signal: profileCtl.signal });
      if (mine !== epoch) throw { code: "cancelled" };
      return applyProfile(r, url);
    }
    finally { profileCtl = null; }
  }
  async function lookupProfile() {
    const link = val(f.profileUrl);
    if (!link) { profileStatus.textContent = "Paste a LinkedIn or X profile link first."; f.profileUrl.input.focus(); return; }
    if (!S.sample) { profileStatus.textContent = "Generation isn't set up yet, and Cold needs it to read the profile. See Settings."; return; }
    setProfileBusy(true, "Reading their public profile…");
    try {
      const mine = epoch;
      const res = await platform.api.profile(link);
      if (mine !== epoch) return setProfileBusy(false, "");
      if (!res.ok) {
        pasteDetails.open = res.code === "blocked" || res.code === "unreachable";
        setProfileBusy(false, res.message);
        if (pasteDetails.open) f.profilePaste.input.focus();
        return;
      }
      setProfileBusy(true, "Working out who they are…");
      setProfileBusy(false, await readProfileText(res.text, res.url));
      if (!val(f.why)) suggest({ auto: true });
    } catch (e) {
      const d = describeError(e);
      setProfileBusy(false, d ? d.message.replace(/ Your inputs are kept; try again\.$/, "") : "");
    }
  }
  f.profileUrl.input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); lookupProfile(); } });
  async function readPasted() {
    const text = val(f.profilePaste);
    if (text.length < 20) { profileStatus.textContent = "Paste a few lines from their profile first."; f.profilePaste.input.focus(); return; }
    if (!S.sample) { profileStatus.textContent = "Generation isn't set up yet, and Cold needs it to read the profile. See Settings."; return; }
    setProfileBusy(true, "Reading the pasted text…");
    try { setProfileBusy(false, await readProfileText(text, null)); f.profilePaste.input.value = ""; if (!val(f.why)) suggest({ auto: true }); }
    catch (e) { const d = describeError(e); setProfileBusy(false, d ? d.message : ""); }
  }

  let reasonCtl = null;
  async function useReason(text) {
    if (val(f.why) && val(f.why) !== text && !(await confirmDialog({ title: "Replace what you wrote?", body: "This swaps your current reason for the suggestion. You can edit it afterwards.", confirmLabel: "Use suggestion" }))) return;
    f.why.input.value = text; f.why.setError(""); persistForm(); f.why.input.focus(); announce("Reason added. Edit it so it sounds like you.");
  }
  function renderReasons(res) {
    clear(reasonHost);
    if (!res) return;
    if (res.who) reasonHost.append(h("p", { class: "who-line" }, h("strong", {}, "Who they are: "), res.who, h("span", { class: "hint" }, " From their profile, written by the model. Check it.")));
    if (!res.suggestions.length) reasonHost.append(h("p", { class: "hint" }, res.dropped ? "The model's suggestions weren't supported by the profile text, so Cold dropped them. Write the reason yourself; Cold won't invent one." : "Nothing in their profile connects clearly to your product. Write the reason yourself; Cold won't invent one."));
    else reasonHost.append(h("p", { class: "hint" }, "Each suggestion is tied to words in their profile. Pick one, then make it yours."),
      h("ul", { class: "reasons" }, res.suggestions.map(s => h("li", {}, h("p", {}, s.why), h("p", { class: "hint" }, `Based on: “${s.basis}”`, s.signal ? ` · ${s.signal}` : ""), button("Use this reason", { kind: "secondary", onclick: () => useReason(s.why) })))));
  }
  async function suggest({ auto = false } = {}) {
    if (reasonCtl) return;
    const v = readForm(), product = reasoningProduct();
    if (!S.sample) { if (!auto) renderStatus("Generation isn't set up yet. See Settings."); return; }
    if (!product) { if (!auto) renderStatus("Add what you're offering first, so Cold can tell what would matter to them."); return; }
    if (!v.profile && !v.role && !v.company) { if (!auto) renderStatus("Look up their profile, or fill in their role and company, first."); return; }
    reasonCtl = new AbortController(); reasonBtn.disabled = true; reasonBtn.textContent = "Thinking…"; renderStatus("Working out who they are and why they might care…");
    const mine = epoch;
    try { const res = await suggestReasons({ sample: S.sample, product, form: v, signal: reasonCtl.signal }); if (mine !== epoch) return; renderReasons(res); announce(res.suggestions.length ? `${res.suggestions.length} suggested reasons.` : "No supported reasons found."); }
    catch (e) { const d = describeError(e); renderStatus(d ? d.message : ""); }
    finally { reasonCtl = null; reasonBtn.disabled = false; reasonBtn.textContent = "Suggest reasons from their profile"; }
  }
  const renderStatus = msg => { clear(reasonHost); if (msg) reasonHost.append(h("p", { class: "hint" }, msg)); };

  return {
    profileBlock, reasonEl, suggest,
    /** Empties the helper and cancels anything it is still doing. */
    reset() {
      epoch++; if (profileCtl) profileCtl.abort(); if (reasonCtl) reasonCtl.abort();
      f.profilePaste.input.value = ""; profileStatus.textContent = ""; clear(reasonHost);
    },
  };
}
