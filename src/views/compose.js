// Compose: the primary workspace. Form on the left, result on the right (stacked on narrow screens).
import { h, $, $$, clear } from "../components/dom.js";
import { field, textInput, textArea, button, notice, chip, announce, toast } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import { GOALS, FORMAT_CHOICES } from "../domain/constants.js";
import { isEmail } from "../services/handoff.js";
import { readiness } from "../domain/knowledge.js";
import { uid } from "../domain/ids.js";
import { generateEmail, improveEmail, generateTweet, describeError } from "../services/generation.js";
import { createDraftPane } from "./draft.js";
import { createRecipientAssist } from "./recipient.js";
import { createTweetForm } from "./tweetForm.js";

export function mountCompose(root, { store, platform, navigate }) {
  const S = store.state;
  let ctl = null;

  /* ---------- form ---------- */
  let leadId = "";   // the lead this draft is for (set when you press Write on a lead); saved on the draft so Leads can show its progress
  const leadNote = h("p", { class: "hint", id: "leadNote", hidden: true });
  const f = {
    name: field({ id: "rName", label: "Name", required: true, control: textInput({ placeholder: "e.g. Sarah Chen" }) }),
    company: field({ id: "rCompany", label: "Company", required: true, control: textInput({ placeholder: "e.g. Acme" }) }),
    role: field({ id: "rRole", label: "Role", control: textInput({ placeholder: "e.g. CTO" }) }),
    why: field({ id: "rWhy",
      label: "Why should this person care?", required: true,
      hint: "The specific reason you're contacting them: something they wrote, built or said. Cold uses this as the only connection between you and won't invent one.",
      control: textArea({ rows: 3, placeholder: "e.g. They've written about how hard it is to move workloads between cloud and edge." }),
    }),
    email: field({ id: "rEmail", label: "Email address", required: null, hint: "Optional. Only used for “Open in email”; Cold looks one up only when you press Find email on a lead, and it never sends mail.", control: textInput({ placeholder: "sarah@acme.com", inputmode: "email", type: "email" }) }),
    profileUrl: field({ id: "rProfileUrl", label: "Their LinkedIn or X profile", hint: "Paste a link and Cold reads the public profile to fill in who they are. Nothing is posted or sent to them.", control: textInput({ placeholder: "linkedin.com/in/sarahchen or x.com/sarahchen", inputmode: "url" }) }),
    profilePaste: field({ id: "rProfilePaste", label: "Or paste their profile text", required: null, hint: "Copy their headline, About section or recent posts from the profile. Use this when the link can't be read.", control: textArea({ rows: 4 }) }),
    profile: field({ id: "rProfile", label: "What Cold learned from their profile", required: null, hint: "Cold treats this as facts you supplied and can use it for the reason you're writing. Edit or delete anything that's wrong.", control: textArea({ rows: 4 }) }),
    goalOther: field({ id: "goalOther", label: "Describe what you want from them", required: true, control: textInput({}), className: "goal-other" }),
    convey: field({ id: "rConvey", label: "Anything specific to get across?", hint: "A point you want in the draft. Cold treats it as a fact you supplied.", control: textArea({ rows: 2 }) }),
    pName: field({ id: "pName", label: "Product or offer name", required: true, control: textInput({}) }),
    pWhat: field({ id: "pWhat", label: "What it does, in one plain sentence", required: true, hint: "Sentence 1 of the draft is built from this. It's saved to Knowledge, so you only enter it once.", control: textArea({ rows: 2 }) }),
  };
  const formatRadios = Object.entries(FORMAT_CHOICES).map(([k, v]) => h("label", {}, h("input", { type: "radio", name: "format", value: k, id: `fmt-${k}` }), v.label));
  const goalRadios = Object.entries(GOALS).map(([k, g]) => h("label", {}, h("input", { type: "radio", name: "goal", value: k, id: `goal-${k}` }), g.label));
  const productSelect = h("select", { "aria-describedby": "productReady" });
  const productReady = h("div", { id: "productReady", class: "hint", "aria-live": "polite" });
  const productFieldWrap = field({ id: "rProduct", label: "Which product?", required: true, control: id => { productSelect.id = id; return productSelect; } });

  const modelSelect = h("select", { id: "gatewayModel", "aria-describedby": "gatewayHint" });
  const modelHint = h("p", { class: "hint", id: "gatewayHint", role: "status" });
  const accessInput = h("input", { type: "password", id: "accessCode", autocomplete: "off", "aria-describedby": "accessHint" });
  accessInput.value = platform.settings.access;
  accessInput.addEventListener("change", () => { platform.setAccess(accessInput.value); renderConnection(); });
  const connection = h("div", { class: "in" });

  const errorSummary = h("div", { id: "errorSummary", class: "notice bad", role: "alert", tabindex: "-1", hidden: true });
  const genBtn = h("button", { type: "submit", class: "btn primary", id: "genBtn" }, "Generate draft");
  const genHint = h("p", { class: "hint", id: "genHint", role: "status" });
  genBtn.setAttribute("aria-describedby", "genHint");

  const tw = createTweetForm({ platform, persist: () => persistForm() });
  const socialGroup = tw.el;
  const assist = createRecipientAssist({ f, S, store, platform, readForm: () => readForm(), persist: () => persistForm(), getProduct: () => reasoningProduct(), pName: f.pName, pWhat: f.pWhat });
  const emailGroup = h("div", { class: "form", id: "emailGroup" },
    leadNote,
    assist.profileBlock,
    h("fieldset", {}, h("legend", {}, "Who are you writing to?"), h("div", { class: "row3" }, f.name, f.company, f.role), f.email),
    f.why, assist.reasonEl,
    h("fieldset", {}, h("legend", {}, "What do you want from them?"), h("div", { class: "pills" }, goalRadios), f.goalOther),
  );
  const productTitle = h("div", { class: "group-title" }, "What are you offering?");
  const productGroup = h("div", { class: "form", id: "productGroup" },
    productTitle,
    h("div", { id: "inlineProduct", class: "form" }, f.pName, f.pWhat,
      h("p", { class: "hint" }, "Want to add proof, who it's for, or phrases to avoid? Do that in Knowledge after your first draft.")),
    h("div", { id: "pickProduct", class: "form" }, productFieldWrap, productReady));

  const form = h("form", { class: "form", id: "composeForm", novalidate: true, autocomplete: "off" },
    h("div", { class: "view-head" },
      h("h1", { id: "compose-title", tabindex: "-1" }, "Write an outreach draft"),
      h("p", { class: "lede" }, "Tell Cold who you're writing to and why they should care. It drafts a short, editable message from the product facts you've saved. It never sends anything.")),
    errorSummary,
    h("fieldset", {}, h("legend", { class: "sr-only" }, "Format"), h("div", { class: "pills", role: "radiogroup", "aria-label": "Format" }, formatRadios)),
    emailGroup, socialGroup, productGroup, tw.useField,
    h("details", { class: "panel" }, h("summary", {}, "More context ", h("span", { class: "opt" }, "(optional)")), h("div", { class: "in" }, f.convey)),
    h("details", { class: "panel", id: "connectionPanel" }, h("summary", {}, "Connection and model"), connection),
    h("div", { class: "actions" }, genBtn, button("Clear all", { kind: "ghost", id: "clearBtn", onclick: () => clearAll() })),
    genHint);

  const pane = createDraftPane({
    store, platform,
    handlers: {
      stop: () => ctl && ctl.abort(),
      retry: () => submit(),
      regenerate: rec => { fillForm(formFromRecord(rec)); submit({ skipConfirm: true }); },
      improve: focus => runImprove(focus),
      undo: () => undo(),
    },
  });

  root.append(h("div", { class: "desk" }, form, pane.el));

  /* ---------- form <-> values ---------- */
  const radio = (name, v) => { const r = $(`input[name="${name}"][value="${v}"]`, form); if (r) r.checked = true; };
  const checked = name => ($(`input[name="${name}"]:checked`, form) || {}).value;
  const val = c => c.input.value.trim();

  function readForm() {
    return {
      ...tw.read(), mode: (checked("format") || "email") === "email" ? "email" : tw.read().mode,
      name: val(f.name), role: val(f.role), company: val(f.company), productId: productSelect.value,
      why: val(f.why), goal: checked("goal") || "advice", goalOther: val(f.goalOther), convey: val(f.convey),
      profileUrl: val(f.profileUrl), profile: val(f.profile), email: val(f.email), leadId,
    };
  }
  function paintLead() {
    const l = leadId && store.leadById(leadId);
    leadNote.hidden = !leadId; leadNote.textContent = "";
    if (leadId) leadNote.append(`Writing to ${l ? l.name : "a lead"} from your Leads. `, h("button", { type: "button", class: "linkbtn", id: "unlinkLead", onclick: () => { leadId = ""; paintLead(); persistForm(); } }, "Not this lead"));
  }
  function fillForm(d) {
    leadId = d.leadId || ""; paintLead();
    radio("format", d.mode && d.mode !== "email" ? "tweet" : "email"); tw.fill(d);
    f.name.input.value = d.name || ""; f.role.input.value = d.role || ""; f.company.input.value = d.company || "";
    f.profileUrl.input.value = d.profileUrl || ""; f.profile.input.value = d.profile || ""; f.email.input.value = d.email || ""; assist.reset();
    f.why.input.value = d.why || ""; f.convey.input.value = d.convey || ""; f.goalOther.input.value = d.goalOther || "";
    radio("goal", GOALS[d.goal] ? d.goal : "advice");
    if (d.productId && [...productSelect.options].some(o => o.value === d.productId)) productSelect.value = d.productId;
    syncMode(); renderProduct();
  }
  const formFromRecord = e => e.mode && e.mode !== "email"
    ? { mode: e.mode, tweetUrl: e.tweetUrl, tweetContext: e.tweetContext, tweetAuthor: e.tweetAuthor, tweetPoint: e.tweetPoint, tweetUse: e.tweetUse, productId: e.productId, goal: e.goal, convey: e.convey }
    : ({ mode: e.mode, tweetUrl: e.tweetUrl, tweetContext: e.tweetContext, name: e.recipient.name, role: e.recipient.role, company: e.recipient.company, why: e.recipient.why, profileUrl: e.recipient.profileUrl, profile: e.recipient.profile, email: e.recipient.email, leadId: e.recipient.leadId, productId: e.productId, goal: e.goal, goalOther: e.goalOther, convey: e.convey });
  /** Empties everything in Write: inputs, helper results, the shown draft and any error. Saved drafts stay in History. */
  async function clearAll() {
    const edited = S.current && S.current.edited;
    if (edited && !(await confirmDialog({ title: "Clear everything?", body: "This clears the form and the draft on screen. Your edited draft stays in History.", confirmLabel: "Clear all" }))) return;
    if (ctl) ctl.abort();                       // stop a draft that is still being written
    f.pName.input.value = ""; f.pWhat.input.value = "";
    fillForm({ goal: "advice", productId: productSelect.value });
    clearErrors(); setError(null);
    store.set({ current: null, undo: null, busy: false, step: 0 }, "current");
    persistForm(); pane.invalidate(); renderAll(); renderProduct();
    announce("Cleared. Starting fresh."); f.name.input.focus();
  }
  const persistForm = () => store.saveCompose(readForm());

  function syncMode() {
    const social = (checked("format") || "email") !== "email";
    emailGroup.hidden = social; socialGroup.hidden = !social; tw.sync();
    productTitle.textContent = social ? "Product to feature or mention" : "What are you offering?";
    tw.useField.hidden = !social;
    for (const w of [productFieldWrap, f.pName, f.pWhat]) { const m = w.querySelector("label span"); if (m) { m.className = social ? "opt" : "req"; m.textContent = social ? " Optional" : " Required"; } }
    f.goalOther.hidden = checked("goal") !== "other";
    genBtn.textContent = S.busy ? "Generating…" : social ? "Generate tweet" : "Generate draft";
  }
  form.addEventListener("input", () => { persistForm(); });
  form.addEventListener("change", e => { if (["format", "goal", "tweetKind"].includes(e.target.name)) syncMode(); if (e.target === productSelect) { if (productSelect.value === "__new") { productSelect.value = S.products[0]?.id || ""; navigate("knowledge", { newProduct: true }); return; } renderProduct(); } persistForm(); });

  /** The product to reason about: the selected one, or the inline one typed on a first run. */
  function reasoningProduct() {
    const p = store.productById(productSelect.value);
    if (p) return p;
    if (S.products.length === 0 && val(f.pName) && val(f.pWhat)) return { id: "draft", name: val(f.pName), what: val(f.pWhat), proof: [], techFacts: [], approved: [], dontSay: [] };
    return null;
  }

  /* ---------- product area ---------- */
  function renderProduct() {
    const has = S.products.length > 0;
    $("#inlineProduct", form).hidden = has; $("#pickProduct", form).hidden = !has;
    const keep = productSelect.value;
    clear(productSelect);
    S.products.forEach(p => productSelect.append(h("option", { value: p.id }, p.name || "Untitled")));
    productSelect.append(h("option", { value: "__new" }, "Add another product in Knowledge…"));
    productSelect.value = S.products.some(p => p.id === keep) ? keep : (S.products[0]?.id || "");
    const p = store.productById(productSelect.value);
    clear(productReady);
    if (p) {
      const r = readiness(p);
      if (!r.ready) productReady.append(chip("bad", `Needs ${r.blocking.map(b => b.label.toLowerCase()).join(" and ")}`), " ", h("button", { type: "button", class: "linkbtn", onclick: () => navigate("knowledge", { productId: p.id, focus: r.blocking[0].id }) }, "Add it in Knowledge"));
      else if (r.advised.length) productReady.append(chip("warn", `${r.advised.length} way${r.advised.length === 1 ? "" : "s"} to improve drafts`), " ", h("button", { type: "button", class: "linkbtn", onclick: () => navigate("knowledge", { productId: p.id, focus: r.advised[0].id }) }, `See what's missing (${r.advised[0].label.toLowerCase()})`));
      else productReady.append(chip("good", "Knowledge is complete for drafting"));
    }
  }

  /* ---------- connection ---------- */
  function renderConnection() {
    clear(connection);
    const srv = S.server;
    connection.append(h("p", { class: "hint" }, srv ? (srv.ready ? `Generating through ${srv.providerLabel || srv.provider} with ${srv.model}. Products and drafts ${store.keptNote()}` : (srv.settingsEnabled ? "Generation is off: add an API key or pick a provider in Settings." : `Generation is off: configure ${srv.keySetting || "the provider key"} on the server.`)) : S.backend === "db" ? "Running in the Claude app." : "No Cold server found. Run it with npm start, or open Cold in the Claude app, to generate drafts."));
    if (srv && srv.settingsEnabled) connection.append(h("p", { class: "hint" }, "Change the provider, model or API keys in ", h("a", { href: "#/settings" }, "Settings"), "."));
    if (srv && srv.provider === "ai-gateway" && !srv.settingsEnabled) connection.append(h("div", { class: "field" }, h("label", { for: "gatewayModel" }, "AI Gateway model"), modelSelect, modelHint));
    if (srv && srv.accessRequired) connection.append(h("div", { class: "field" }, h("label", { for: "accessCode" }, "Access code ", h("span", { class: "req" }, "Required by this server")), h("p", { class: "hint", id: "accessHint" }, "The server checks this code before it will generate. It's kept for this browser tab only."), accessInput));
    if (srv && srv.experimental) connection.append(notice("warn", "Experimental provider: live compatibility is unverified and generation may fail."));
    if (srv && !srv.accessRequired && srv.provider && !srv.settingsEnabled) connection.append(notice("warn", h("strong", {}, "This server has no access code."), h("p", {}, "Anyone who can open this address can generate drafts on your AI credits. Set COLD_ACCESS_TOKEN on the server before sharing the link.")));
  }
  async function loadModels() {
    if (S.server?.provider !== "ai-gateway" || S.server?.settingsEnabled) return;
    modelSelect.append(h("option", { value: "" }, `Server default: ${S.server.model}`));
    modelHint.textContent = "Loading available models…";
    try {
      const models = await platform.api.models();
      const groups = new Map();
      for (const m of models) {
        if (m.id === S.server.model) continue;
        if (!groups.has(m.provider)) { const g = h("optgroup", { label: m.provider }); groups.set(m.provider, g); modelSelect.append(g); }
        groups.get(m.provider).append(h("option", { value: m.id }, `${m.name} (${m.id})`));
      }
      const saved = platform.savedModel();
      if ([...modelSelect.options].some(o => o.value === saved)) modelSelect.value = saved;
      platform.setModel(modelSelect.value);
      modelHint.textContent = modelSelect.value ? `Using ${modelSelect.value}. Model pricing varies.` : "Using the server default. Model pricing varies.";
    } catch { modelHint.textContent = "Couldn't load the model catalog. Using the server default; reload to retry."; }
  }
  modelSelect.addEventListener("change", () => { platform.setModel(modelSelect.value); modelHint.textContent = modelSelect.value ? `Using ${modelSelect.value}. Model pricing varies.` : "Using the server default. Model pricing varies."; });

  /** Why nothing can write yet, and the way out for THIS surface. Knowledge and History keep working either way. */
  function noModelHint() {
    const link = platform.hub && platform.hub.link.state;
    if (S.server?.settingsEnabled) {
      return link && link.conn && !link.online
        ? "No model is set up here, and the Cold desktop app you paired isn't running. Open the app to use its model, or open Settings and choose a model for this one. Your products and drafts are still available."
        : "No provider is set up yet. Open Settings to add a key or pick a local model.";
    }
    return link && link.conn && !link.online
      ? "This site has no model of its own, and the Cold desktop app you paired isn't running. Open the app, or ask whoever runs this site to add a provider. Your products and drafts are still available."
      : "This site has no model yet: whoever runs it adds a provider key on the server (the Cold desktop app can supply one instead; see Settings). Your products and drafts work meanwhile.";
  }

  function renderGenHint() {
    const st = S.sampleState;
    genHint.textContent = S.busy ? "Writing your draft…"
      : st === "pending" ? "Connecting…"
      : st === "none" ? "Generation needs the Cold server (npm start) or the Claude app."
      : st === "noconfig" ? noModelHint()
      : st === "blocked" ? "Claude access was declined for this page. Reload to allow it."
      : "Takes a minute or less: a draft, then an editor pass. You can edit the result.";
    genBtn.disabled = S.busy || ["none", "blocked", "noconfig", "pending"].includes(st);
    genBtn.setAttribute("aria-busy", String(S.busy));
    syncMode();
  }

  /* ---------- validation ---------- */
  function clearErrors() { Object.values(f).forEach(c => c.setError("")); tw.clearErrors(); productFieldWrap.setError(""); errorSummary.hidden = true; clear(errorSummary); }
  function validate(v) {
    const errs = [];
    const need = (ctl, ok, msg, label) => { if (!ok) errs.push({ ctl, msg, label }); else ctl.setError(""); };
    if (v.mode === "email") {
      need(f.name, v.name, "Enter their name.", "Name");
      need(f.company, v.company, "Enter their company.", "Company");
      need(f.why, v.why, "Say why this person should care. Cold won't invent a reason.", "Why should this person care");
      need(f.email, !v.email || isEmail(v.email), "Enter a valid email address, or leave it empty.", "Email address");
      if (v.goal === "other") need(f.goalOther, v.goalOther, "Describe what you want from them.", "What you want");
    } else {
      tw.validate(v, need);
    }
    if (S.products.length === 0) {
      if (v.mode === "email") { need(f.pName, val(f.pName), "Name what you're offering.", "Product or offer name"); need(f.pWhat, val(f.pWhat), "Describe what it does in one sentence.", "What it does"); }
    } else if (v.mode === "email") {
      const p = store.productById(v.productId), r = p && readiness(p);
      need(productFieldWrap, !!p && r.ready, !p ? "Pick the product you're offering." : `Add ${r.blocking.map(b => b.label.toLowerCase()).join(" and ")} to ${p.name || "this product"} in Knowledge first. Cold only writes from facts you've saved.`, "What you're offering");
    }
    return errs;
  }
  function showErrors(errs) {
    errs.forEach(e => e.ctl.setError(e.msg));
    clear(errorSummary).append(h("strong", {}, `Fix ${errs.length} thing${errs.length === 1 ? "" : "s"} to generate:`),
      h("ul", {}, errs.map(e => h("li", {}, h("button", { type: "button", class: "linkbtn", onclick: () => (e.ctl.input || e.ctl).focus() }, e.label), `: ${e.msg}`))));
    errorSummary.hidden = false; errorSummary.focus();
  }

  /* ---------- running ---------- */
  function setBusy(busy, step = 0) { store.set({ busy, step }, "busy"); }
  const setError = e => store.set({ error: e }, "error");

  async function submit({ skipConfirm = false } = {}) {
    if (S.busy) return;                    // prevents duplicate submission
    const v = readForm();
    clearErrors();
    const errs = validate(v);
    if (errs.length) return showErrors(errs);
    if (!S.sample) return;
    if (!skipConfirm && S.current?.edited && !(await confirmDialog({ title: "Replace your edited draft?", body: "Generating writes a new draft. Your edited draft stays in History.", confirmLabel: "Generate new draft" }))) return;
    setError(null);
    setBusy(true, 2); pane.invalidate(); renderAll(); announce("Writing your draft. This can take up to a minute.");
    ctl = new AbortController();
    try {
      let product = store.productById(v.productId);
      if (!product && v.mode === "email" && S.products.length === 0) {
        product = { id: uid("p"), name: val(f.pName), what: val(f.pWhat), order: 0, proof: [], techFacts: [], approved: [], dontSay: [] };
        await store.saveProduct(product);
        renderProduct(); productSelect.value = product.id;
      }
      const rec = v.mode === "email"
        ? await generateEmail({ sample: S.sample, product, form: v, signal: ctl.signal, onStep: n => { store.set({ step: n }, "busy"); pane.render(); } })
        : await generateTweet({ sample: S.sample, product: reasoningProduct(), form: v, tweetLength: t => globalThis.tweetLength(t), signal: ctl.signal });
      store.set({ current: rec, undo: null }, "current");
      try { await store.saveEmail(rec); } catch (e) { toast(e && e.code === "quota_exceeded" ? "Draft shown, but browser storage is full so it isn't in History. Copy it now." : "Draft shown, but couldn't be saved to History."); }
      announce("Draft ready. Review the checks below before sending.");
      setBusy(false); renderAll(); pane.focusResult();
    } catch (e) {
      setBusy(false);
      const d = describeError(e);
      if (d) { setError(d); announce(d.message); }
      renderAll(); if (d) pane.focusResult();
    } finally { ctl = null; }
  }

  async function runImprove(focus) {
    if (S.busy || !S.current || !S.sample) return;
    const product = store.productById(S.current.productId);
    if (!product) { setError({ message: "This product is no longer in Knowledge, so Cold can't improve the draft. Add it back and try again.", retryable: false }); renderAll(); return; }
    const before = JSON.parse(JSON.stringify(S.current));
    setError(null); setBusy(true, 3); pane.invalidate(); renderAll();
    ctl = new AbortController();
    try {
      const rec = await improveEmail({ sample: S.sample, product, current: S.current, focus, signal: ctl.signal, onStep: n => { store.set({ step: n }, "busy"); pane.render(); } });
      store.set({ current: rec, undo: { id: rec.id, rec: before } }, "current");
      try { await store.saveEmail(rec); } catch { toast("Improved draft shown, but couldn't be saved."); }
      announce("Draft improved. You can undo this change.");
      setBusy(false); renderAll(); pane.focusResult();
    } catch (e) {
      setBusy(false); const d = describeError(e); if (d) setError(d); renderAll(); if (d) pane.focusResult();
    } finally { ctl = null; }
  }

  async function undo() {
    if (!S.undo || !S.current) return;
    const rec = { ...S.undo.rec, updatedAt: S.current.updatedAt };   // restoring over the version this client just saved
    store.set({ current: rec, undo: null }, "current");
    try { await store.saveEmail(rec); } catch { toast("Restored, but couldn't save."); }
    pane.invalidate(); renderAll();
  }

  form.addEventListener("submit", e => { e.preventDefault(); submit(); });

  function renderAll() { renderGenHint(); pane.render(); }

  /* ---------- store wiring ---------- */
  store.subscribe(topic => {
    if (topic === "products" || topic === "ready") renderProduct();
    if (topic === "server" || topic === "ready") { renderConnection(); renderGenHint(); }
    if (topic === "current" || topic === "busy" || topic === "error") renderAll();
    if (topic === "settings") { pane.invalidate(); pane.render(); }
  });

  return {
    init() {
      const saved = S.compose;
      fillForm(saved || { goal: "advice" });
      renderProduct(); renderConnection(); loadModels(); renderAll();
    },
    /** Open a history record in Compose (inputs restored, nothing regenerated). */
    open(rec) {
      store.set({ current: JSON.parse(JSON.stringify(rec)), error: null, undo: null }, "current");
      fillForm(formFromRecord(rec)); persistForm(); pane.invalidate(); renderAll();
    },
    /** Set some of the form's values (used by the extension's "Read this page"); anything not given is kept. */
    /** The form as it is right now (so a caller can avoid overwriting what the user typed). */
    read: () => readForm(),
    /** Pre-fill Write from a lead: who they are, why they'd care, their product and goal. Nothing is generated until you press Generate. */
    useLead(lead) {
      const product = lead.product ? S.products.find(p => (p.name || "").toLowerCase() === lead.product.toLowerCase()) : null;
      fillForm({ mode: "email", name: lead.name, role: lead.role, company: lead.company, email: lead.email, why: lead.why, profileUrl: lead.profileUrl, goal: lead.goal || "advice", productId: product ? product.id : productSelect.value, leadId: lead.id });
      store.set({ current: null, undo: null, error: null }, "current"); persistForm(); pane.invalidate(); renderAll(); f.name.input.focus();
    },
    fill(patch) { fillForm({ ...readForm(), ...patch }); persistForm(); },
    suggestReasons() { return assist.suggest({ auto: true }); },
    selectProduct(id) { if (id && S.products.some(p => p.id === id)) { productSelect.value = id; renderProduct(); persistForm(); } },
    focus() { f.name.input.focus(); },
    refreshProducts: renderProduct,
  };
}
