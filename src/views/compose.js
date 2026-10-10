// Compose: the primary workspace. Form on the left, result on the right (stacked on narrow screens).
import { h, $, $$, clear } from "../components/dom.js";
import { field, textInput, textArea, button, notice, chip, announce, toast } from "../components/ui.js";
import { confirmDialog } from "../components/dialog.js";
import { GOALS, FORMATS } from "../domain/constants.js";
import { readiness } from "../domain/knowledge.js";
import { uid } from "../domain/ids.js";
import { generateEmail, improveEmail, generateTweet, describeError } from "../services/generation.js";
import { createDraftPane } from "./draft.js";

const TWEET_URL = /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+(?:[/?#].*)?$/;

export function mountCompose(root, { store, platform, navigate }) {
  const S = store.state;
  let ctl = null;

  /* ---------- form ---------- */
  const f = {
    name: field({ id: "rName", label: "Name", required: true, control: textInput({ placeholder: "e.g. Sarah Chen" }) }),
    company: field({ id: "rCompany", label: "Company", required: true, control: textInput({ placeholder: "e.g. Acme" }) }),
    role: field({ id: "rRole", label: "Role", control: textInput({ placeholder: "e.g. CTO" }) }),
    why: field({ id: "rWhy",
      label: "Why should this person care?", required: true,
      hint: "The specific reason you're contacting them: something they wrote, built or said. Cold uses this as the only connection between you and won't invent one.",
      control: textArea({ rows: 3, placeholder: "e.g. They've written about how hard it is to move workloads between cloud and edge." }),
    }),
    goalOther: field({ id: "goalOther", label: "Describe what you want from them", required: true, control: textInput({}), className: "goal-other" }),
    convey: field({ id: "rConvey", label: "Anything specific to get across?", hint: "A point you want in the draft. Cold treats it as a fact you supplied.", control: textArea({ rows: 2 }) }),
    tweetUrl: field({ id: "tweetUrl", label: "Tweet link", hint: "Optional, for replies. Links are saved as a reference only; Cold doesn't fetch them.", control: textInput({ placeholder: "https://x.com/username/status/123" }) }),
    tweetContext: field({ id: "tweetContext", label: "Tweet to reply to, or your topic", required: true, hint: "Paste the tweet text (replies) or describe what you want to say (original tweet).", control: textArea({ rows: 4 }) }),
    pName: field({ id: "pName", label: "Product or offer name", required: true, control: textInput({}) }),
    pWhat: field({ id: "pWhat", label: "What it does, in one plain sentence", required: true, hint: "Sentence 1 of the draft is built from this. It's saved to Knowledge, so you only enter it once.", control: textArea({ rows: 2 }) }),
  };
  const formatRadios = Object.entries(FORMATS).map(([k, v]) => h("label", {}, h("input", { type: "radio", name: "format", value: k, id: `fmt-${k}` }), v.label));
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

  const socialGroup = h("div", { class: "form", id: "socialGroup" }, f.tweetUrl, f.tweetContext, h("p", { class: "hint" }, "Drafts stay within X's 280 weighted-character limit. You review and post it yourself."));
  const emailGroup = h("div", { class: "form", id: "emailGroup" },
    h("fieldset", {}, h("legend", {}, "Who are you writing to?"), h("div", { class: "row3" }, f.name, f.company, f.role)),
    f.why,
    h("fieldset", {}, h("legend", {}, "What do you want from them?"), h("div", { class: "pills" }, goalRadios), f.goalOther),
  );
  const productGroup = h("div", { class: "form", id: "productGroup" },
    h("div", { class: "group-title" }, "What are you offering?"),
    h("div", { id: "inlineProduct", class: "form" }, f.pName, f.pWhat,
      h("p", { class: "hint" }, "Want to add proof, who it's for, or phrases to avoid? Do that in Knowledge after your first draft.")),
    h("div", { id: "pickProduct", class: "form" }, productFieldWrap, productReady));

  const form = h("form", { class: "form", id: "composeForm", novalidate: true, autocomplete: "off" },
    h("div", { class: "view-head" },
      h("h1", { id: "compose-title", tabindex: "-1" }, "Write an outreach draft"),
      h("p", { class: "lede" }, "Tell Cold who you're writing to and why they should care. It drafts a short, editable message from the product facts you've saved. It never sends anything.")),
    errorSummary,
    h("fieldset", {}, h("legend", { class: "sr-only" }, "Format"), h("div", { class: "pills", role: "radiogroup", "aria-label": "Format" }, formatRadios)),
    emailGroup, socialGroup, productGroup,
    h("details", { class: "panel" }, h("summary", {}, "More context ", h("span", { class: "opt" }, "(optional)")), h("div", { class: "in" }, f.convey)),
    h("details", { class: "panel", id: "connectionPanel" }, h("summary", {}, "Connection and model"), connection),
    h("div", { class: "actions" }, genBtn, button("Clear form", { kind: "ghost", id: "clearBtn", onclick: () => { clearForm(); f.name.input.focus(); } })),
    genHint);

  const pane = createDraftPane({
    store,
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
      mode: checked("format") || "email", tweetUrl: val(f.tweetUrl), tweetContext: val(f.tweetContext),
      name: val(f.name), role: val(f.role), company: val(f.company), productId: productSelect.value,
      why: val(f.why), goal: checked("goal") || "advice", goalOther: val(f.goalOther), convey: val(f.convey),
    };
  }
  function fillForm(d) {
    radio("format", FORMATS[d.mode] ? d.mode : "email");
    f.tweetUrl.input.value = d.tweetUrl || ""; f.tweetContext.input.value = d.tweetContext || "";
    f.name.input.value = d.name || ""; f.role.input.value = d.role || ""; f.company.input.value = d.company || "";
    f.why.input.value = d.why || ""; f.convey.input.value = d.convey || ""; f.goalOther.input.value = d.goalOther || "";
    radio("goal", GOALS[d.goal] ? d.goal : "advice");
    if (d.productId && [...productSelect.options].some(o => o.value === d.productId)) productSelect.value = d.productId;
    syncMode(); renderProduct();
  }
  const formFromRecord = e => e.mode && e.mode !== "email"
    ? { mode: e.mode, tweetUrl: e.tweetUrl, tweetContext: e.tweetContext, productId: e.productId, goal: e.goal, convey: e.convey }
    : ({ mode: e.mode, tweetUrl: e.tweetUrl, tweetContext: e.tweetContext, name: e.recipient.name, role: e.recipient.role, company: e.recipient.company, why: e.recipient.why, productId: e.productId, goal: e.goal, goalOther: e.goalOther, convey: e.convey });
  function clearForm() { fillForm({ goal: "advice", productId: productSelect.value }); clearErrors(); persistForm(); }
  const persistForm = () => store.saveCompose(readForm());

  function syncMode() {
    const social = (checked("format") || "email") !== "email";
    emailGroup.hidden = social; socialGroup.hidden = !social;
    f.goalOther.hidden = checked("goal") !== "other";
    genBtn.textContent = S.busy ? "Generating…" : social ? "Generate tweet" : "Generate draft";
  }
  form.addEventListener("input", () => { persistForm(); });
  form.addEventListener("change", e => { if (e.target.name === "format" || e.target.name === "goal") syncMode(); if (e.target === productSelect) { if (productSelect.value === "__new") { productSelect.value = S.products[0]?.id || ""; navigate("knowledge", { newProduct: true }); return; } renderProduct(); } persistForm(); });

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
    connection.append(h("p", { class: "hint" }, srv ? (srv.ready ? `Generating through ${srv.provider} with ${srv.model}. Products and drafts are saved in this browser only; they are not backed up or synced.` : `Generation is off: configure ${srv.keySetting || "the provider key"} on the server.`) : S.backend === "db" ? "Running in the Claude app." : "No Cold server found. Run it with npm start, or open Cold in the Claude app, to generate drafts."));
    if (srv && srv.provider === "ai-gateway") connection.append(h("div", { class: "field" }, h("label", { for: "gatewayModel" }, "AI Gateway model"), modelSelect, modelHint));
    if (srv && srv.accessRequired) connection.append(h("div", { class: "field" }, h("label", { for: "accessCode" }, "Access code ", h("span", { class: "req" }, "Required by this server")), h("p", { class: "hint", id: "accessHint" }, "The server checks this code before it will generate. It's kept for this browser tab only."), accessInput));
    if (srv && srv.experimental) connection.append(notice("warn", "Experimental provider: live compatibility is unverified and generation may fail."));
    if (srv && !srv.accessRequired && srv.provider) connection.append(notice("warn", h("strong", {}, "This server has no access code."), h("p", {}, "Anyone who can open this address can generate drafts on your AI credits. Set COLD_ACCESS_TOKEN on the server before sharing the link.")));
  }
  async function loadModels() {
    if (S.server?.provider !== "ai-gateway") return;
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

  function renderGenHint() {
    const st = S.sampleState;
    genHint.textContent = S.busy ? "Writing your draft…"
      : st === "pending" ? "Connecting…"
      : st === "none" ? "Generation needs the Cold server (npm start) or the Claude app."
      : st === "noconfig" ? "The server has no provider key yet. See “Connection and model”."
      : st === "blocked" ? "Claude access was declined for this page. Reload to allow it."
      : "Takes a minute or less: a draft, then an editor pass. You can edit the result.";
    genBtn.disabled = S.busy || ["none", "blocked", "noconfig", "pending"].includes(st);
    genBtn.setAttribute("aria-busy", String(S.busy));
    syncMode();
  }

  /* ---------- validation ---------- */
  function clearErrors() { Object.values(f).forEach(c => c.setError("")); productFieldWrap.setError(""); errorSummary.hidden = true; clear(errorSummary); }
  function validate(v) {
    const errs = [];
    const need = (ctl, ok, msg, label) => { if (!ok) errs.push({ ctl, msg, label }); else ctl.setError(""); };
    if (v.mode === "email") {
      need(f.name, v.name, "Enter their name.", "Name");
      need(f.company, v.company, "Enter their company.", "Company");
      need(f.why, v.why, "Say why this person should care. Cold won't invent a reason.", "Why should this person care");
      if (v.goal === "other") need(f.goalOther, v.goalOther, "Describe what you want from them.", "What you want");
    } else {
      need(f.tweetContext, v.tweetContext, v.mode === "reply" ? "Paste the tweet you're replying to. A link alone can't be read." : "Add a topic or rough draft.", "Tweet or topic");
      need(f.tweetUrl, !v.tweetUrl || TWEET_URL.test(v.tweetUrl), "Use a valid x.com or twitter.com status link, or leave it empty.", "Tweet link");
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
        : await generateTweet({ sample: S.sample, product: store.productById(v.productId) || null, form: v, tweetLength: t => globalThis.tweetLength(t), signal: ctl.signal });
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
    const rec = S.undo.rec;
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
    selectProduct(id) { if (id && S.products.some(p => p.id === id)) { productSelect.value = id; renderProduct(); persistForm(); } },
    focus() { f.name.input.focus(); },
    refreshProducts: renderProduct,
  };
}
