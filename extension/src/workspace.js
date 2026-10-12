// The extension workspace: read the page you're on, then write a reply, an original tweet or a cold email with your
// products and the app's model. Drafts are saved to the app's database, so they show up in Cold's History.
import twitterText from "twitter-text";
import { h, clear } from "../../src/components/dom.js";
import { button, notice, chip, field, textInput, textArea, toast, announce } from "../../src/components/ui.js";
import { GOALS, TWEET_USE } from "../../src/domain/constants.js";
import { readiness } from "../../src/domain/knowledge.js";
import { emailText } from "../../src/domain/email.js";
import { generateEmail, generateTweet, extractProfile, suggestReasons, describeError } from "../../src/services/generation.js";
import { copyText } from "../../src/services/clipboard.js";
import { readPage, insertIntoBox, classify } from "./page.js";

const MODES = { reply: "Reply", tweet: "Tweet", email: "Email" };
const tweetLength = t => twitterText.parseTweet(t);

export function mountWorkspace(root, { api, store, config, onDisconnect }) {
  const S = store.state;
  let mode = "reply", busy = false, ctl = null, current = null, pageKind = { kind: "other" };
  const val = c => c.input.value.trim();

  /* ---------- fields ---------- */
  const f = {
    tweetText: field({ id: "xText", label: "The tweet you're replying to", required: null, control: textArea({ rows: 4 }) }),
    point: field({ id: "xPoint", label: "What do you want to say back?", required: null, hint: "Optional. Leave it blank and Cold replies from the tweet alone.", control: textArea({ rows: 2 }) }),
    name: field({ id: "xName", label: "Name", required: null, control: textInput({}) }),
    company: field({ id: "xCompany", label: "Company", required: null, control: textInput({}) }),
    role: field({ id: "xRole", label: "Role", required: null, control: textInput({}) }),
    profile: field({ id: "xProfile", label: "What Cold learned from their page", required: null, hint: "Facts you can edit. Cold uses them as facts you supplied.", control: textArea({ rows: 3 }) }),
    why: field({ id: "xWhy", label: "Why should this person care?", required: null, control: textArea({ rows: 3 }) }),
  };
  let tweetAuthor = "", pageUrl = "";
  const productSel = h("select", { id: "xProduct", "aria-label": "Product" });
  const useSel = h("select", { id: "xUse", "aria-label": "Product in this tweet" }, Object.entries(TWEET_USE).map(([k, l]) => h("option", { value: k === "auto" ? "" : k }, l)));
  const goalSel = h("select", { id: "xGoal", "aria-label": "What you want from them" }, Object.entries(GOALS).filter(([k]) => k !== "other").map(([k, g]) => h("option", { value: k }, g.label)));
  const reasonBox = h("div", { "aria-live": "polite" });
  const suggestBtn = button("Suggest reasons", { onclick: () => suggest() });
  const pageStatus = h("p", { class: "hint", role: "status" });
  const pageBtn = button("Read this page", { onclick: () => readCurrent() });
  const pageLine = h("p", {});
  const out = h("div", { "aria-live": "polite" });
  const genBtn = h("button", { type: "button", class: "btn primary", onclick: () => generate() }, "Write it");
  const stopBtn = button("Stop", { kind: "ghost", onclick: () => ctl && ctl.abort(), hidden: true });
  const recent = h("ul", { class: "x-recent" });

  const tabs = Object.entries(MODES).map(([k, label]) => h("label", {}, h("input", { type: "radio", name: "xmode", value: k, checked: k === mode, onchange: () => setMode(k) }), label));
  const replyFields = h("div", { class: "x-stack" }, f.tweetText, f.point);
  const tweetFields = h("div", { class: "x-stack" });
  const emailFields = h("div", { class: "x-stack" }, h("div", { class: "row3" }, f.name, f.company, f.role), f.profile, f.why, h("div", { class: "actions" }, suggestBtn), reasonBox,
    h("div", { class: "field" }, h("label", { for: "xGoal" }, "What do you want from them?"), goalSel));
  const productRow = h("div", { class: "field" }, h("label", { for: "xProduct" }, "Product"), productSel);
  const useRow = h("div", { class: "field" }, h("label", { for: "xUse" }, "Product in this tweet"), useSel);

  const head = h("div", { class: "x-head" }, h("strong", {}, "Cold"),
    config.ready ? chip("good", `${config.providerLabel || config.provider} · ${config.model}`, { glyph: false }) : chip("warn", "No model set up"),
    h("span", { class: "grow" }), button("Disconnect", { kind: "ghost", onclick: onDisconnect }));
  const setup = config.ready ? null : notice("warn", h("strong", {}, "Pick a model in the Cold app."), h("p", {}, "Open Cold, go to Settings, and choose a provider and model. The extension uses whatever you select there."));

  root.append(head, setup, h("div", { class: "x-page" }, pageLine, h("div", { class: "actions" }, pageBtn), pageStatus),
    h("div", { class: "pills", role: "radiogroup", "aria-label": "What to write" }, tabs),
    h("div", { class: "x-stack", style: "margin-top:14px" }, replyFields, tweetFields, emailFields, productRow, useRow,
      h("div", { class: "actions" }, genBtn, stopBtn), out),
    h("div", { class: "x-card", style: "margin-top:18px" }, h("h2", {}, "Recent drafts"), recent));

  /* ---------- products + recent ---------- */
  function renderProducts() {
    const keep = productSel.value; clear(productSel);
    productSel.append(h("option", { value: "" }, S.products.length ? "No product" : "No products yet: add one in the Cold app"));
    S.products.forEach(p => productSel.append(h("option", { value: p.id }, p.name || "Untitled")));
    productSel.value = S.products.some(p => p.id === keep) ? keep : (S.products[0]?.id || "");
  }
  function renderRecent() {
    clear(recent);
    const items = S.emails.slice(0, 5);
    if (!items.length) return recent.append(h("li", {}, h("span", { class: "hint" }, "Nothing yet. Drafts you write here also appear in the Cold app.")));
    for (const e of items) recent.append(h("li", {}, h("span", { class: "who" }, e.mode && e.mode !== "email" ? `${e.mode === "reply" ? "Reply" : "Tweet"}: ${e.what.slice(0, 50)}` : `${e.recipient?.name || "Email"}: ${e.subject || ""}`),
      button("Copy", { kind: "ghost", onclick: async () => toast((await copyText(emailText(e, S.settings.signature))) ? "Copied" : "Couldn't copy") })));
  }
  store.subscribe(t => { if (t === "products" || t === "ready") renderProducts(); if (t === "emails" || t === "ready") renderRecent(); });
  renderProducts(); renderRecent();

  /* ---------- mode ---------- */
  function setMode(m) {
    mode = m; clear(out);
    replyFields.hidden = m !== "reply"; tweetFields.hidden = m !== "tweet"; emailFields.hidden = m !== "email"; useRow.hidden = m === "email";
    f.tweetText.querySelector("label").firstChild.textContent = "The tweet you're replying to";
    if (m === "tweet") { clear(tweetFields).append(f.tweetText); f.tweetText.querySelector("label").firstChild.textContent = "What do you want to say?"; }
    else if (m === "reply") replyFields.prepend(f.tweetText);
    f.point.hidden = m !== "reply";
    genBtn.textContent = m === "email" ? "Write the email" : m === "reply" ? "Write a reply" : "Write the tweet";
    productRow.hidden = false;
  }
  setMode("reply");

  /* ---------- reading the page ---------- */
  async function activeTab() { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return t; }
  async function refreshPage() {
    const tab = await activeTab();
    pageKind = tab && tab.url ? classify(tab.url) : { kind: "other" };
    pageLine.textContent = pageKind.kind === "tweet" ? "You're on a tweet." : pageKind.kind === "profile" ? `You're on a ${pageKind.site} profile.` : pageKind.kind === "compose" ? "You're on X's compose page." : "Open a tweet or a LinkedIn or X profile to read it here.";
    pageBtn.disabled = !(pageKind.kind === "tweet" || pageKind.kind === "profile");
    return tab;
  }
  chrome.tabs.onActivated.addListener(refreshPage);
  chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete" || info.url) refreshPage(); });
  refreshPage().then(() => { if (pageKind.kind === "profile") { document.querySelector('input[value="email"]').click(); } else if (pageKind.kind === "compose") document.querySelector('input[value="tweet"]').click(); });

  async function readCurrent() {
    const tab = await activeTab();
    if (!tab || !tab.id) return;
    pageBtn.disabled = true; pageStatus.textContent = "Reading the page…";
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage });
      pageUrl = result.url;
      if (pageKind.kind === "tweet") {
        let t = result.kind === "tweet" ? result : null;
        if (!t) { const r = await api.tweet(result.url); if (r.ok) t = { text: r.text, handle: r.handle ? `@${r.handle}` : "" }; else { pageStatus.textContent = r.message; return; } }
        f.tweetText.input.value = t.text; tweetAuthor = t.handle || "";
        document.querySelector('input[value="reply"]').click();
        pageStatus.textContent = `Read ${tweetAuthor || "the"} tweet. Check it, then write your reply.`;
      } else {
        if (!S.sample && !api.sample) throw { code: "none" };
        const p = await extractProfile({ sample: api.sample, text: `${result.title}\n${result.text}` });
        for (const k of ["name", "role", "company"]) if (p[k] && !val(f[k])) f[k].input.value = p[k];
        f.profile.input.value = p.notes || "";
        document.querySelector('input[value="email"]').click();
        pageStatus.textContent = "Read their page. Check the details, then say why they should care.";
        if (!val(f.why)) suggest({ auto: true });
      }
      announce(pageStatus.textContent);
    } catch (e) { pageStatus.textContent = friendly(e) || "Couldn't read this page. Paste the text instead."; }
    finally { pageBtn.disabled = false; refreshPage(); }
  }

  /* ---------- reasons ---------- */
  const productFor = () => store.productById(productSel.value) || null;
  async function suggest({ auto = false } = {}) {
    const product = productFor();
    if (!product) { if (!auto) clear(reasonBox).append(h("p", { class: "hint" }, "Pick a product first so Cold can tell what would matter to them.")); return; }
    if (!config.ready) return;
    suggestBtn.disabled = true; suggestBtn.textContent = "Thinking…";
    try {
      const res = await suggestReasons({ sample: api.sample, product, form: formValues() });
      clear(reasonBox);
      if (res.who) reasonBox.append(h("p", {}, h("strong", {}, "Who they are: "), res.who));
      if (!res.suggestions.length) reasonBox.append(h("p", { class: "hint" }, "Nothing on their page connects clearly to your product. Write the reason yourself; Cold won't invent one."));
      res.suggestions.forEach(s => reasonBox.append(h("div", { class: "x-card" }, h("p", {}, s.why), h("p", { class: "hint" }, `Based on: “${s.basis}”`), button("Use this reason", { onclick: () => { f.why.input.value = s.why; } }))));
    } catch (e) { clear(reasonBox).append(h("p", { class: "hint" }, friendly(e))); }
    finally { suggestBtn.disabled = false; suggestBtn.textContent = "Suggest reasons"; }
  }

  /* ---------- generating ---------- */
  function formValues() {
    return { mode: mode === "reply" ? "reply" : mode === "tweet" ? "tweet" : "email", tweetContext: val(f.tweetText), tweetUrl: pageUrl, tweetAuthor, tweetPoint: mode === "reply" ? val(f.point) : "", tweetUse: useSel.value,
      name: val(f.name), company: val(f.company), role: val(f.role), why: val(f.why), goal: goalSel.value || "advice", goalOther: "", convey: "", profile: val(f.profile), profileUrl: pageUrl, productId: productSel.value };
  }
  function friendly(e) {
    if (e && (e.status === 403 || e.code === "bad_origin")) return "The app rejected this extension's pairing code. Disconnect, then connect again with the current code.";
    if (e && e.code === "network") return "Couldn't reach the Cold app. Is it running?";
    const d = describeError(e); return d ? d.message : "";
  }
  function setBusy(b) { busy = b; genBtn.disabled = b || !config.ready; stopBtn.hidden = !b; genBtn.setAttribute("aria-busy", String(b)); }
  setBusy(false);

  async function generate() {
    if (busy) return;
    const v = formValues(), product = productFor();
    if (mode !== "email" && !v.tweetContext) { clear(out).append(notice("bad", mode === "reply" ? "Read the tweet from the page, or paste its text." : "Say what the tweet should be about.")); return; }
    if (mode === "email") {
      if (!v.name || !v.company || !v.why) { clear(out).append(notice("bad", "Add their name, company and why they should care.")); return; }
      if (!product) { clear(out).append(notice("bad", "Pick a product. Add products in the Cold app, under Knowledge.")); return; }
      const r = readiness(product);
      if (!r.ready) { clear(out).append(notice("bad", `${product.name || "This product"} needs ${r.blocking.map(b => b.label.toLowerCase()).join(" and ")} in the Cold app first.`)); return; }
    }
    setBusy(true); ctl = new AbortController(); clear(out).append(h("p", { class: "hint" }, "Writing…"));
    try {
      const rec = mode === "email"
        ? await generateEmail({ sample: api.sample, product, form: v, signal: ctl.signal })
        : await generateTweet({ sample: api.sample, product, form: v, tweetLength, signal: ctl.signal });
      current = rec;
      try { await store.saveEmail(rec); } catch { toast("Written, but couldn't save to the Cold app."); }
      renderResult(rec); announce("Draft ready.");
    } catch (e) { const m = friendly(e); clear(out); if (m) out.append(notice("bad", m)); }
    finally { setBusy(false); ctl = null; }
  }

  /* ---------- result ---------- */
  let saveT = null;
  const queueSave = rec => { clearTimeout(saveT); saveT = setTimeout(() => store.saveEmail(rec).catch(() => toast("Couldn't save your edits.")), 600); };
  function renderResult(rec) {
    clear(out);
    if (rec.mode && rec.mode !== "email") {
      const ta = h("textarea", { rows: 5, id: "xDraft", "aria-label": "Draft" }); ta.value = rec.what;
      const count = h("p", { class: "hint", role: "status" });
      const copy = button("Copy", { kind: "primary", onclick: async () => toast((await copyText(rec.what)) ? "Copied" : "Couldn't copy") });
      const upd = () => { const p = tweetLength(rec.what); count.textContent = `${p.weightedLength} / 280 characters${p.valid ? "" : ". Too long: shorten it."}`; copy.disabled = !p.valid; };
      ta.addEventListener("input", () => { rec.what = ta.value; rec.edited = true; upd(); queueSave(rec); }); upd();
      out.append(h("div", { class: "x-card" }, h("h2", {}, rec.mode === "reply" ? "Your reply" : "Your tweet"), ta, count,
        (rec.warnings || []).length ? notice("warn", h("strong", {}, "Check before posting"), h("ul", {}, rec.warnings.map(w => h("li", {}, w)))) : null,
        h("div", { class: "actions" }, copy, button("Put it in the tweet box", { onclick: () => insertDraft(rec.what) }), button("Write another", { kind: "ghost", onclick: () => generate() })),
        h("p", { class: "hint" }, "Saved to your Cold history. Cold never posts: you do.")));
      return;
    }
    const bind = (key, rows) => { const t = h(rows === 1 ? "input" : "textarea", { type: "text", rows, "aria-label": key }); t.value = rec[key] || ""; t.addEventListener("input", () => { rec[key] = t.value; rec.edited = true; queueSave(rec); }); return t; };
    out.append(h("div", { class: "x-card" }, h("h2", {}, `Email to ${rec.recipient.name}`),
      h("div", { class: "field" }, h("label", {}, "Subject"), bind("subject", 1)), h("div", { class: "field" }, h("label", {}, "Sentence 1"), bind("what", 3)),
      h("div", { class: "field" }, h("label", {}, "Sentence 2"), bind("why", 3)), h("div", { class: "field" }, h("label", {}, "Sentence 3"), bind("ask", 2)),
      h("div", { class: "actions" }, button("Copy email", { kind: "primary", onclick: async () => toast((await copyText(`Subject: ${rec.subject}\n\n${emailText(rec, S.settings.signature)}`)) ? "Copied" : "Couldn't copy") }), button("Write another", { kind: "ghost", onclick: () => generate() })),
      h("p", { class: "hint" }, "Saved to your Cold history. Open the Cold app for the full checklist.")));
  }
  async function insertDraft(text) {
    const tab = await activeTab();
    try { const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: insertIntoBox, args: [text] }); toast(result.message); }
    catch { toast("Couldn't reach the page. Copy the text instead."); }
  }
}
