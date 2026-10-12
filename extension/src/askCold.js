// "Ask Cold" and "Browse With Me": the extension's way of finding opportunities while the user browses. Both call the SAME evaluator
// (src/domain/opportunity.js). Nothing is read until the user asks (Ask Cold) or has started a session (Browse With Me); page text only
// goes to a model this browser reaches on this computer, unless the user says otherwise for this panel session; results are only
// suggestions, and the only things a user can do with one are Save as prospect (the normal library save), Start a draft (fills the
// Write form) and Dismiss. Cold never sends or contacts anyone from here.
import { h, clear } from "../../src/components/dom.js";
import { button, chip, notice, toast } from "../../src/components/ui.js";
import { readPage } from "./page.js";
import { ASK_QUESTIONS, BROWSE_QUESTION, TYPE_LABEL, evaluatePage, localityOf, urlEligibility, createBrowseSession, opportunityKey, prospectRecord, draftPatch } from "../../src/domain/opportunity.js";

const NEXT_LABEL = { save_prospect: "Save as a prospect", draft_outreach: "Start a draft", follow_up: "Follow up with them yourself", none: "Nothing to do yet" };
const sitePattern = url => { const u = new URL(url); return `${u.protocol}//${u.hostname}/*`; };
const hasAccess = url => chrome.permissions.contains({ origins: [sitePattern(url)] }).catch(() => false);

export function mountAskCold(composeRoot, { store, platform, compose }) {
  const S = store.state;
  let allowRemote = false;                      // this panel session only; never saved
  let busy = false, tick = null, timer = null;

  const modelLine = h("p", { class: "hint", id: "askModelLine" });
  const question = h("input", { type: "text", id: "askQuestion", value: ASK_QUESTIONS[0], "aria-label": "Your question about this page", maxlength: "200" });
  const askBtn = button("Ask about this page", { kind: "primary", id: "askRun", onclick: () => ask() });
  const status = h("p", { class: "hint", role: "status", id: "askStatus" });
  const result = h("div", { id: "askResult" });
  const consent = h("div", { id: "askConsent" });
  const quick = h("div", { class: "actions" }, ASK_QUESTIONS.map(q => button(q, { kind: "ghost", class: "askQuick", onclick: () => { question.value = q; question.focus(); } })));

  const bwmState = h("p", { id: "bwmState", role: "status" });
  const bwmNote = h("p", { class: "hint" }, "Browse With Me looks only at the page you are on, only while it is running, only on sites you have allowed, and never on mail, sign-in, payment or private pages. Nothing is kept when you stop.");
  const bwmStatus = h("p", { class: "hint", role: "status", id: "bwmStatus" });
  const bwmList = h("div", { id: "bwmList" });
  const startBtn = button("Start Browse With Me", { kind: "primary", id: "bwmStart", onclick: () => startSession() });
  const pauseBtn = button("Pause", { id: "bwmPause", onclick: () => { session.pause(); paintSession(); } });
  const resumeBtn = button("Resume", { id: "bwmResume", onclick: () => { session.resume(); paintSession(); schedule(); } });
  const stopBtn = button("Stop", { kind: "danger", id: "bwmStop", onclick: () => stopSession("") });
  const allowBtn = button("Allow Cold on this site", { kind: "ghost", id: "bwmAllow", onclick: () => allowSite() });

  composeRoot.prepend(h("section", { class: "x-page x-ask", "aria-label": "Ask Cold" },
    h("h2", {}, "Ask Cold"), modelLine, consent,
    h("div", { class: "field" }, h("label", { for: "askQuestion" }, "Ask about the page you are on"), question), quick,
    h("div", { class: "actions" }, askBtn), status, result,
    h("h3", {}, "Browse With Me"), bwmNote, bwmState,
    h("div", { class: "actions" }, startBtn, pauseBtn, resumeBtn, stopBtn, allowBtn), bwmStatus, bwmList));

  const activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

  // ---- where page text may go ---------------------------------------------------------------------------------------------------
  function plan() {
    const { cfg, sample } = platform.ownModel();
    const d = platform.backend.describe();
    const loc = localityOf({ own: cfg, appAvailable: !!d && d.kind === "app" });
    if (loc.kind === "local") return { ok: true, sample, loc };
    if (allowRemote && d) return { ok: true, sample: platform.backend.sample, loc: { ...loc, label: d.label }, remote: true };
    return { ok: false, loc };
  }
  function paintModel() {
    const p = plan(); clear(consent);
    if (p.ok && !p.remote) modelLine.textContent = `Uses ${p.loc.label}, which this browser reaches on this computer${p.loc.host ? ` (${p.loc.host})` : ""}. The page text is sent to that model and nowhere else.`;
    else if (p.ok) { modelLine.textContent = `Using ${p.loc.label} because you allowed it for this session. Page text is sent to that model.`; consent.append(button("Turn that off", { kind: "ghost", id: "askRemoteOff", onclick: () => { allowRemote = false; if (session.state !== "idle" && session.state !== "stopped") stopSession("Hosted model turned off."); paintModel(); } })); }
    else modelLine.textContent = "";
    return p;
  }
  /** The clear failure state: says why nothing was read, and offers the user's choices. Never silently uses another model. */
  function blocked(loc) {
    clear(consent);
    const d = platform.backend.describe();
    const why = loc.kind === "remote" ? `Your model (${loc.label}) is at ${loc.host}, not on this computer.`
      : loc.kind === "unverified" ? "The only model available is the Cold desktop app's. From here Cold can't tell whether it runs on this computer."
      : "No model on this computer is set up.";
    consent.append(notice("warn", h("strong", {}, "Nothing was read."), h("p", {}, `${why} Cold keeps page text on this computer unless you say otherwise. Set up a local model (for example Ollama) in Settings, or choose to use the available one for this panel session.`),
      d ? h("div", { class: "actions" }, button(`Use ${d.label} for these checks`, { id: "askRemoteOn", onclick: () => { allowRemote = true; paintModel(); status.textContent = "Allowed for this panel session. Page text will be sent to that model when you ask."; } })) : null));
    modelLine.textContent = "";
  }

  // ---- reading and evaluating ---------------------------------------------------------------------------------------------------
  async function readTab(tab) {
    const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage });
    return page;
  }
  const evaluateWith = (p, q) => page => evaluatePage({ sample: p.sample, question: q, page, products: S.products, emails: S.emails });

  async function ask() {
    if (busy) return;
    const p = plan();
    if (!p.ok) { blocked(p.loc); status.textContent = "Nothing was read."; return; }          // before the page is touched
    busy = true; askBtn.disabled = true; clear(result); paintModel();
    try {
      const tab = await activeTab();
      if (!tab || !tab.url) { status.textContent = "There's no page to look at."; return; }
      const el = urlEligibility(tab.url, { incognito: tab.incognito });
      if (!el.ok) { status.textContent = `Cold doesn't look at this page (${el.reason}).`; return; }
      if (!(await hasAccess(tab.url)) && !(await chrome.permissions.request({ origins: [sitePattern(tab.url)] }).catch(() => false))) { status.textContent = `Cold needs your permission to read ${new URL(tab.url).hostname}. Nothing was read.`; return; }
      status.textContent = "Reading this page and checking it against your products…";
      const page = await readTab(tab);
      const r = await evaluateWith(p, question.value.trim() || ASK_QUESTIONS[0])(page);
      status.textContent = "";
      renderResult(result, r, page, null);
    } catch (e) { status.textContent = (e && e.message) || "Couldn't check this page."; }
    finally { busy = false; askBtn.disabled = false; }
  }

  // ---- results and the only three things a user can do with one ------------------------------------------------------------------
  function renderResult(host, r, page, key) {
    clear(host);
    if (r.verdict === "none") { host.append(h("div", { class: "card ask-card", dataset: { verdict: "none" } }, h("strong", {}, "No meaningful opportunity found"), h("p", {}, r.summary || "Nothing on this page points to an opportunity for what you sell."), r.dropped ? h("p", { class: "hint" }, "Some suggestions were discarded because the page didn't back them up.") : null, button("Dismiss", { kind: "ghost", class: "askDismiss", onclick: () => clear(host) }))); return; }
    if (r.verdict === "uncertain") host.append(notice("warn", h("strong", {}, "Uncertain."), h("p", {}, "The page only weakly suggests this. Treat it as a lead to check, not a finding.")));
    for (const o of r.opportunities) host.append(card(o, page, r.verdict, key ? opportunityKey(o, page) : null, host));
  }
  function card(o, page, verdict, key, host) {
    const el = h("div", { class: "card ask-card", dataset: { verdict, type: o.type } });
    const who = [o.who.name, o.who.role, o.who.company].filter(Boolean).join(", ");
    const remove = () => { el.remove(); if (key) session.dismiss(key); };
    el.append(
      h("div", { class: "ask-head" }, h("strong", {}, TYPE_LABEL[o.type] || "Opportunity"), " ", chip(o.confidence === "high" ? "good" : o.confidence === "medium" ? "accent" : "neutral", `${o.confidence} confidence`, { glyph: false })),
      who ? h("p", {}, who) : null,
      o.relationship ? h("p", { class: "hint" }, `You already know ${o.relationship.name || o.relationship.company} (${o.relationship.status === "draft" ? "a draft" : o.relationship.status === "sent" ? "marked sent" : "reply recorded"} in History).`) : null,
      h("p", { class: "hint ask-label" }, "On the page (quoted):"),
      h("ul", { class: "ask-facts" }, o.facts.map(q => h("li", {}, h("q", {}, q)))),
      h("p", { class: "hint ask-label" }, "Cold's inference (not stated on the page):"),
      h("p", { class: "ask-inference" }, o.inference || "—"),
      o.uncertainty ? h("p", { class: "hint" }, `Not known: ${o.uncertainty}`) : null,
      h("p", { class: "hint" }, `Suggested next step: ${NEXT_LABEL[o.nextAction]}. Cold does not contact anyone.`),
      h("div", { class: "actions" },
        button("Save as prospect", { class: "askSave", disabled: !(o.who.name || o.who.company), onclick: async ev => {
          try { await store.saveEmail(prospectRecord(o, page, { products: S.products })); if (key) session.saved(key); toast("Saved to History as a draft-status prospect"); ev.target.disabled = true; }
          catch { toast("Couldn't save that."); } } }),
        button("Start a draft", { class: "askDraft", disabled: !(o.who.name || o.who.company), onclick: () => { compose.fill(draftPatch(o, page)); toast("Filled in the Write form. Add your reason, then generate when you're ready."); compose.focus(); } }),
        button("Dismiss", { kind: "ghost", class: "askDismiss", onclick: remove })));
    return el;
  }

  // ---- Browse With Me ------------------------------------------------------------------------------------------------------------
  let session = createBrowseSession({ read: readTab, evaluate: async () => ({ opportunities: [] }), allowed: hasAccess });
  let currentPlan = null;
  const onChangeStates = { idle: "Not running", active: "Active", paused: "Paused", stopped: "Stopped" };
  function paintSession() {
    const st = session.state;
    bwmState.textContent = `Browse With Me: ${onChangeStates[st]}${st === "active" || st === "paused" ? ` · ${session.checked} page${session.checked === 1 ? "" : "s"} checked` : ""}${st === "stopped" && session.stopReason ? `. ${session.stopReason}` : ""}`;
    bwmState.dataset.state = st;
    startBtn.hidden = st === "active" || st === "paused"; pauseBtn.hidden = st !== "active"; resumeBtn.hidden = st !== "paused"; stopBtn.hidden = !(st === "active" || st === "paused");
    allowBtn.hidden = !(st === "active" || st === "paused");
  }
  async function startSession() {
    const p = plan();
    if (!p.ok) { blocked(p.loc); bwmStatus.textContent = "Browse With Me didn't start: no local model."; return; }
    currentPlan = paintModel();
    session = createBrowseSession({ read: readTab, evaluate: page => evaluateWith(currentPlan, BROWSE_QUESTION)(page), allowed: hasAccess, onChange: paintSession });
    clear(bwmList); bwmStatus.textContent = "";
    session.start();
    chrome.tabs.onUpdated.addListener(onUpdated); chrome.tabs.onActivated.addListener(onActivated);
    schedule(0);
  }
  function stopSession(why) {
    session.stop(why); chrome.tabs.onUpdated.removeListener(onUpdated); chrome.tabs.onActivated.removeListener(onActivated);
    clearTimeout(timer); paintSession(); bwmStatus.textContent = "";
  }
  const onUpdated = (_id, info, tab) => { if (info.status === "complete" && tab.active) schedule(); };
  const onActivated = () => schedule();
  /** Let a page settle, then offer the active tab to the session. One at a time; the session decides whether anything is read. */
  function schedule(delay = 1500) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (session.state !== "active" || busy) return;
      busy = true;
      try {
        const tab = await activeTab();
        if (!tab || !tab.url) return;
        const r = await session.offer({ id: tab.id, url: tab.url, incognito: tab.incognito });
        if (r.status === "surfaced") { bwmStatus.textContent = `New opportunity on ${new URL(tab.url).hostname}.`; for (const it of r.items) bwmList.prepend(card(it.opportunity, it.page, "opportunity", it.key, bwmList)); }
        else if (r.status === "skipped") bwmStatus.textContent = `Skipped ${new URL(tab.url).hostname || "this page"}: ${r.reason}.`;
        else if (r.status === "error") bwmStatus.textContent = (r.error && r.error.message) || "Couldn't check that page.";
        else if (r.status === "throttled") timer = setTimeout(() => schedule(0), 4000);
        else if (r.status === "none" || r.status === "duplicate") bwmStatus.textContent = `Checked ${new URL(tab.url).hostname}: nothing new.`;
        else if (r.status === "limit") stopSession(session.stopReason);
      } catch (e) { bwmStatus.textContent = (e && e.message) || "Couldn't check that page."; }
      finally { busy = false; paintSession(); }
    }, delay);
  }
  async function allowSite() {
    const tab = await activeTab();
    if (!tab || !tab.url) return;
    const el = urlEligibility(tab.url, { incognito: tab.incognito });
    if (!el.ok) { bwmStatus.textContent = `Cold won't look at this page (${el.reason}).`; return; }
    const ok = await chrome.permissions.request({ origins: [sitePattern(tab.url)] }).catch(() => false);
    bwmStatus.textContent = ok ? `Cold may now read ${new URL(tab.url).hostname} while Browse With Me is running.` : "Permission wasn't granted.";
    if (ok) schedule(0);
  }

  paintModel(); paintSession();
  platform.subscribe(() => { if (!consent.firstChild || plan().ok) paintModel(); });
  return { get session() { return session; } };
}
