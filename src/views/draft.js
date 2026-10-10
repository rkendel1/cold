// The result pane in Compose: empty state, progress, error, and the editable draft with its review sections.
import { h, clear, autosize, fmtDate } from "../components/dom.js";
import { chip, button, notice, toast, announce } from "../components/ui.js";
import { confirmDialog, promptDialog } from "../components/dialog.js";
import { copyText } from "../services/clipboard.js";
import { evaluate, checklistVerdict, words } from "../domain/rules.js";
import { checkGrounding } from "../domain/grounding.js";
import { emailText } from "../domain/email.js";
import { GOALS, STATUSES, STATUS_COPY } from "../domain/constants.js";

const STEPS = ["Reading your saved product facts", "Drafting three sentences", "Editor pass against the 20 rules", "Running local checks"];

export function createDraftPane({ store, handlers }) {
  const S = store.state;
  const el = h("div", { class: "out", id: "out" });
  let renderedKey = null;
  const openPanels = new Set();
  let saveT = null;

  const productFor = rec => store.productById(rec.productId) || S.products.find(p => p.name === rec.productName) || null;

  async function persist(rec) {
    clearTimeout(saveT);
    if (!rec.mode || rec.mode === "email") rec.score = evaluate(rec, productFor(rec)).score;
    try { await store.saveEmail(rec); return true; }
    catch (e) { toast(e && e.code === "quota_exceeded" ? "Couldn't save: browser storage is full. Copy your draft now, then delete old drafts in History." : "Couldn't save your changes."); return false; }
  }
  const queueSave = (rec, statusEl) => {
    statusEl.textContent = "Saving…";
    clearTimeout(saveT);
    saveT = setTimeout(async () => { statusEl.textContent = (await persist(rec)) ? "Edits saved in this browser" : "Not saved"; }, 700);
  };

  async function setStatus(rec, st) {
    if (rec.status === st) return;
    rec.status = st;
    if (st === "sent" && !rec.sentAt) rec.sentAt = Date.now();
    if (st === "replied" && !rec.repliedAt) rec.repliedAt = Date.now();
    if (await persist(rec)) toast(`Status set to “${STATUS_COPY[st].label}”`);
    renderedKey = null; render();
  }

  const statusSelect = rec => {
    const sel = h("select", { id: "curStatus", "aria-label": "Status (you set this)" }, STATUSES.map(s => h("option", { value: s, selected: rec.status === s }, STATUS_COPY[s].label)));
    sel.addEventListener("change", () => setStatus(rec, sel.value));
    return sel;
  };

  async function copy(text, what) {
    const ok = await copyText(text);
    toast(ok ? `${what} copied to clipboard` : "Couldn't copy automatically. Select the text and copy it yourself.");
  }

  /* ---------- sections ---------- */
  function groundingSection(rec, product) {
    if (!product) return notice("warn", h("strong", {}, "Grounding can't be checked"), h("p", {}, "This product is no longer in Knowledge, so Cold can't compare the draft with your saved facts."));
    const g = checkGrounding(rec, { product, recipient: rec.recipient, convey: rec.convey, claims: rec.claims, facts: rec.facts });
    const issues = [
      ...g.flags.map(f => ({ kind: "bad", text: f.message })),
      ...g.claims.filter(c => c.status !== "matches").map(c => ({ kind: "warn", text: c.status === "no_record" ? `The model cited ${c.source} for “${c.text}”, but no such record exists. Treat this claim as unsupported.` : `The model cited ${c.source} for “${c.text}”, but the wording doesn't match that record. Check it.` })),
    ];
    const box = issues.length
      ? notice("warn", h("strong", {}, `Review before sending: ${issues.length} item${issues.length === 1 ? "" : "s"} to check`),
          h("ul", { class: "flag-list" }, issues.map(i => h("li", {}, chip(i.kind, i.kind === "bad" ? "Not found" : "Check"), h("span", {}, i.text)))))
      : notice("info", h("strong", {}, "No unmatched numbers, names or cited claims found"),
          h("p", {}, "This only compares words in the draft with the text you saved. It cannot tell whether a statement is true or whether the meaning changed. Read every sentence before you send it."));
    const claimsPanel = g.claims.length ? panel("claims", `Claims the model cited (${g.claims.length})`, [
      h("p", { class: "hint" }, "Source IDs are reported by the model. Cold checks them only by word overlap with your saved text."),
      ...g.claims.map(c => h("div", { class: "fact" }, h("span", { class: "id" }, c.source),
        h("div", {}, h("div", {}, `“${c.text}”`), h("div", {}, c.status === "matches" ? chip("good", "Matches your text") : c.status === "mismatch" ? chip("warn", "Needs review") : chip("bad", "No such record")), h("div", { class: "hint" }, c.detail)))),
    ]) : null;
    return h("div", { class: "stack" }, box, claimsPanel);
  }

  function panel(id, summary, kids, extra) {
    const d = h("details", { class: "panel", dataset: { id }, open: openPanels.has(id) }, h("summary", {}, summary, extra || null), h("div", { class: "in" }, ...kids));
    d.addEventListener("toggle", () => { d.open ? openPanels.add(id) : openPanels.delete(id); });
    return d;
  }

  function checklistSection(rec, product) {
    const ev = evaluate(rec, product);
    const fails = ev.rows.filter(r => r.pass === false);
    const [vt, vc] = checklistVerdict(ev.score, fails.length);
    return panel("checklist", `Style checklist: ${ev.score} / 100`, [
      h("p", { class: "hint" }, "Checks labelled Cold run in your browser and update as you type. Checks labelled Model are the model's own report from its editor pass; they are not independently verified. This score is not a prediction of replies."),
      h("ul", { class: "checks" }, ev.rows.map(r => h("li", { class: r.pass === false ? "fail" : r.pass === null ? "unk" : "pass" },
        h("span", { class: "ic", "aria-hidden": "true" }, r.pass === false ? "✕" : r.pass === null ? "–" : "✓"),
        h("span", {}, h("span", { class: "sr-only" }, r.pass === false ? "Failed: " : r.pass === null ? "Not reported: " : "Passed: "), r.label,
          h("span", { class: "src" }, r.source === "model" ? "Model" : r.source === "both" ? "Cold + Model" : "Cold"),
          r.pass === false && r.note ? h("span", { class: "why" }, r.note) : null)))),
      rec.couldImprove ? h("p", {}, h("strong", {}, "Model's note: "), rec.couldImprove) : null,
    ], chip(vc, vt));
  }

  /* ---------- states ---------- */
  function emptyState() {
    return h("div", { class: "empty" },
      h("h2", {}, "Your draft will appear here"),
      h("p", {}, "Cold writes a subject and three sentences: what you do, why it matters to this person, and one clear question. It uses only the facts you have saved and the reason you give. Nothing is sent for you."),
      h("ol", { class: "steps" },
        h("li", {}, "Say who you're writing to and why they should care."),
        h("li", {}, "Choose what you want from them, and what you're offering."),
        h("li", {}, "Generate, edit the text, then copy it into your own email.")),
      h("p", { class: "hint" }, "Drafts are saved in this browser only. They are not backed up or synced to other devices."));
  }

  function progressCard() {
    return h("div", { class: "card progress", "aria-busy": "true" },
      h("h2", {}, "Writing your draft"),
      h("ol", {}, STEPS.map((t, i) => { const n = i + 1; return h("li", { class: S.step > n ? "done" : S.step === n ? "on" : "" }, h("span", { class: "dot", "aria-hidden": "true" }, S.step > n ? "✓" : ""), t, S.step > n ? h("span", { class: "sr-only" }, " (done)") : S.step === n ? h("span", { class: "sr-only" }, " (in progress)") : null); })),
      h("p", { class: "hint" }, "This usually takes 10–40 seconds per step. Your inputs are kept if it fails."),
      h("div", { class: "actions" }, button("Stop", { onclick: () => handlers.stop() })));
  }

  function errorCard() {
    const e = S.error;
    const box = h("div", { class: "notice bad", role: "alert", tabindex: "-1", id: "genError" }, h("strong", {}, "Couldn't generate a draft"), h("p", {}, e.message),
      e.retryable ? h("div", { class: "actions" }, button("Try again", { kind: "primary", onclick: () => handlers.retry() })) : null);
    return box;
  }

  function emailCard(rec) {
    const product = productFor(rec);
    const f = {
      subject: h("input", { type: "text", id: "eSubject", value: rec.subject }),
      what: h("textarea", { id: "eWhat", rows: 1 }), why: h("textarea", { id: "eWhy", rows: 1 }), ask: h("textarea", { id: "eAsk", rows: 1 }),
    };
    f.what.value = rec.what; f.why.value = rec.why; f.ask.value = rec.ask;
    const saveStatus = h("span", { class: "hint", role: "status" }, rec.edited ? "" : "Saved in this browser");
    const metrics = h("div", { class: "metrics", "aria-label": "Draft length" });
    const review = h("div", {});
    const checklist = h("div", {});
    const signoff = h("p", { class: "signoff" });
    const renderSignoff = () => { signoff.textContent = S.settings.signature ? `Sign-off: ${S.settings.signature}` : "No sign-off set. The copied email ends without one."; };
    const refresh = () => {
      const ev = evaluate(rec, product);
      clear(metrics).append(h("span", {}, h("span", { class: ev.wc > 80 ? "over" : "" }, String(ev.wc)), ` words${ev.wc > 80 ? " (over 80)" : ""}`), h("span", {}, `~${Math.max(ev.secs, 1)} sec read`), h("span", {}, h("span", { class: ev.sentences !== 3 ? "over" : "" }, String(ev.sentences)), " sentences"), h("span", {}, `subject ${words(rec.subject)} words`));
      clear(review).append(groundingSection(rec, product));
      clear(checklist).append(checklistSection(rec, product));
      renderSignoff();
    };
    const sentence = (key, label, ctl) => h("div", { class: "sentence" }, h("label", { for: ctl.id }, label), ctl);
    for (const [k, ctl] of Object.entries(f)) {
      ctl.addEventListener("input", () => {
        if (ctl.tagName === "TEXTAREA") { ctl.value = ctl.value.replace(/\n+/g, " "); autosize(ctl); }
        rec[k] = ctl.value; rec.edited = true; refresh(); queueSave(rec, saveStatus);
      });
    }

    const improveIn = h("input", { type: "text", id: "focusIn", "aria-label": "What should change", placeholder: "e.g. make the reason they should care more specific" });
    const improveBtn = button("Improve", { disabled: !S.sample, onclick: async () => {
      if (rec.edited && !(await confirmDialog({ title: "Rewrite your edited draft?", body: "Improve sends the current text, including your edits, to the editor and replaces it. You can undo it afterwards.", confirmLabel: "Improve" }))) return;
      handlers.improve(improveIn.value.trim() || "Tighten the weakest sentence.");
    } });
    const undoBtn = S.undo && S.undo.id === rec.id ? button("Undo last improvement", { onclick: () => handlers.undo() }) : null;

    const signBtn = button(S.settings.signature ? "Edit sign-off" : "Set sign-off", { kind: "ghost", onclick: async () => {
      const v = await promptDialog({ title: "Your sign-off", hint: "Added under every copied email. Use line breaks for title or company." , value: S.settings.signature });
      if (v !== null) { try { await store.saveSettings({ signature: v }); signBtn.textContent = v ? "Edit sign-off" : "Set sign-off"; refresh(); } catch { toast("Couldn't save your sign-off."); } }
    } });

    const card = h("article", { class: "card", "aria-labelledby": "draft-title" },
      h("div", { class: "draft-head" },
        h("div", { class: "draft-meta" },
          h("h2", { id: "draft-title", tabindex: "-1" }, "Your draft"),
          chip("neutral", `${rec.recipient.name}${rec.recipient.company ? ", " + rec.recipient.company : ""}`, { glyph: false }),
          chip("accent", rec.productName || "No product", { glyph: false }),
          chip("neutral", rec.goal === "other" ? rec.goalOther || "Other" : GOALS[rec.goal]?.label || "", { glyph: false })),
        h("div", { class: "status-wrap" }, h("label", { class: "hint", for: "curStatus" }, "Status (you set this)"), statusSelect(rec))),
      h("div", { class: "sentence" }, h("label", { for: "eSubject" }, "Subject"), f.subject),
      sentence("what", "Sentence 1: what you do", f.what), sentence("why", "Sentence 2: why it matters to them", f.why), sentence("ask", "Sentence 3: the ask", f.ask),
      h("div", { class: "actions" }, signoff, signBtn), metrics,
      h("div", { class: "actions" },
        button("Copy email", { kind: "primary", id: "copyEmail", onclick: () => copy(emailText(rec, S.settings.signature), "Email") }),
        button("Copy subject", { onclick: () => copy(rec.subject, "Subject") }),
        rec.status === "draft" ? button("Mark as sent", { id: "markSent", onclick: () => setStatus(rec, "sent") }) : null,
        button("Regenerate", { kind: "ghost", onclick: async () => {
          if (rec.edited && !(await confirmDialog({ title: "Replace your edited draft?", body: "Regenerating writes a new draft from the same inputs. Your edits to this one stay in History.", confirmLabel: "Regenerate" }))) return;
          handlers.regenerate(rec);
        } }), undoBtn, saveStatus),
      h("p", { class: "next-step" }, h("strong", {}, "Next: "), "paste it into your own email and send it yourself. Cold can't send, and can't see your inbox. Come back and mark it as sent, and record a reply in History if you get one."));
    const wrap = h("div", { class: "stack-lg" }, card,
      h("section", { "aria-label": "Review before sending", class: "stack" }, h("h2", {}, "Check before you send"), review),
      checklist,
      panel("improve", "Ask for a change", [h("p", { class: "hint" }, "Describe what to change. Cold re-runs the editor on the text above, including your edits, and you can undo it."), h("div", { class: "actions" }, improveIn, improveBtn)]),
      rec.relevance ? panel("why", "Why them", [h("p", {}, rec.relevance.signal || ""), h("p", { class: "hint" }, `Relevance ladder rank ${rec.relevance.rank} of 8 (1 = direct shared problem), based on your note: “${rec.recipient.why}”. The ranking is the model's classification.`)], chip(rec.relevance.strength === "strong" ? "good" : rec.relevance.strength === "medium" ? "warn" : "bad", rec.relevance.category || "")) : null,
      rec.draft || (rec.draftFailures || []).length ? panel("editor", "Editor notes", [
        (rec.draftFailures || []).length ? h("ul", {}, rec.draftFailures.map(x => h("li", {}, x))) : h("p", {}, "The model reports that its first draft passed every rule."),
        rec.draft ? h("p", { class: "hint" }, h("strong", {}, "First draft: "), `${rec.draft.subject} — ${rec.draft.what} ${rec.draft.why} ${rec.draft.ask}`) : null]) : null);
    refresh();
    queueMicrotask(() => [f.what, f.why, f.ask].forEach(autosize));
    return wrap;
  }

  function tweetCard(rec) {
    const ta = h("textarea", { id: "tweetDraft", rows: 5 }); ta.value = rec.what;
    const count = h("div", { role: "status", "aria-live": "polite" });
    const saveStatus = h("span", { class: "hint", role: "status" });
    const copyBtn = button("Copy tweet", { kind: "primary", onclick: () => copy(rec.what, "Tweet") });
    const upd = () => {
      const p = globalThis.tweetLength?.(rec.what);
      count.textContent = p ? `${p.weightedLength} / 280 characters${p.valid ? "" : ". Too long: shorten it before copying."}` : "Character counter unavailable";
      copyBtn.disabled = !p?.valid;
    };
    ta.addEventListener("input", () => { rec.what = ta.value; rec.edited = true; upd(); queueSave(rec, saveStatus); });
    upd();
    return h("article", { class: "card", "aria-labelledby": "draft-title" },
      h("div", { class: "draft-head" }, h("h2", { id: "draft-title", tabindex: "-1" }, rec.mode === "reply" ? "Your tweet reply" : "Your tweet"), statusSelect(rec)),
      h("div", { class: "field" }, h("label", { for: "tweetDraft" }, "Draft"), ta), count,
      h("div", { class: "actions" }, copyBtn, button("Regenerate", { kind: "ghost", onclick: () => handlers.regenerate(rec) }), saveStatus),
      h("p", { class: "next-step" }, h("strong", {}, "Next: "), "paste it into X and post it yourself. Cold never posts."));
  }

  function render() {
    const rec = S.current;
    const key = S.busy ? `busy:${S.step}` : `${S.error ? "err:" + S.error.message : ""}|${rec ? `${rec.id}:${rec.versions || 0}:${rec.status}:${!!S.undo}` : "empty"}`;
    if (key === renderedKey) return;
    renderedKey = key;
    clear(el);
    if (S.busy) { el.append(progressCard()); return; }
    if (S.error) el.append(errorCard());
    if (rec) el.append(rec.mode && rec.mode !== "email" ? tweetCard(rec) : emailCard(rec));
    else if (!S.error) el.append(emptyState());
  }

  return {
    el, render,
    invalidate() { renderedKey = null; },
    focusResult() { (el.querySelector("#genError") || el.querySelector("#draft-title"))?.focus({ preventScroll: false }); el.scrollIntoView({ block: "nearest" }); },
  };
}
