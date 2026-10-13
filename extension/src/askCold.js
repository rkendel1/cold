// "Ask Cold" and "Browse With Me": the extension's way of finding opportunities while the user browses. Both call the SAME evaluator
// (src/domain/opportunity.js). Nothing is read until the user asks (Ask Cold) or has started a session (Browse With Me); page text only
// goes to a model this browser reaches on this computer, unless the user says otherwise for this panel session; results are only
// suggestions, and the only things a user can do with one are Save as prospect (the normal library save), Start a draft (fills the
// Write form) and Dismiss. Cold never sends or contacts anyone from here.
import { h, clear, revealAndFocus } from "../../src/components/dom.js";
import { button, chip, notice, toast } from "../../src/components/ui.js";
import { confirmDialog } from "../../src/components/dialog.js";
import { MODELS, MODEL_SOURCE, modelByKey } from "./localModels.js";
import { readPage } from "./page.js";
import { verifyResult, SIGNAL_LABEL, ROLE_LABEL } from "../../src/domain/jevChecks.js";
import { ASK_QUESTIONS, MORE_QUESTIONS, BROWSE_QUESTION, TYPE_LABEL, evaluatePage, localityOf, staysOnThisComputer, isLoopbackUrl, urlEligibility, createBrowseSession, opportunityKey, prospectRecord, draftPatch } from "../../src/domain/opportunity.js";

const NEXT_LABEL = { save_prospect: "Save as a prospect", draft_outreach: "Start a draft", follow_up: "Follow up with them yourself", none: "Nothing to do yet" };
const sitePattern = url => { const u = new URL(url); return `${u.protocol}//${u.hostname}/*`; };
const hasAccess = url => chrome.permissions.contains({ origins: [sitePattern(url)] }).catch(() => false);

/**
 * Builds the pieces of Ask Cold and Browse With Me and says where each one lives (see index.js of the panel):
 *   settings.discovery  Settings > Opportunity discovery: which model checks pages (when there is a choice) and what Browse With Me will and won't read
 *   settings.local      Settings > Privacy and local models: the on-device model (download, source, checksums, set up, cancel, remove)
 *   actions             Write, one collapsed row: the question and its answers, the model line, and starting a session
 *   bar                 the shell, on every tab while a session is running or paused: its state and Pause / Resume / Stop / Allow, so a
 *                       running session can always be stopped without finding the right tab first
 * The behaviour, ids and restrictions are unchanged; only where the controls sit has moved.
 */
export function createAskCold({ store, platform, getCompose }) {
  const S = store.state;
  const compose = { fill: patch => getCompose().fill(patch), focus: () => getCompose().focus() };
  const lm = platform.localModel;
  let engine = "auto";                          // auto | device | loopback | hosted: this panel session only, never saved. "hosted" is the user's explicit choice.
  let busy = false, tick = null, timer = null;

  const modelLine = h("p", { class: "hint", id: "askModelLine" });
  const question = h("input", { type: "text", id: "askQuestion", value: ASK_QUESTIONS[0], "aria-label": "Your question about this page", maxlength: "200" });
  const askBtn = button("Ask about this page", { kind: "primary", id: "askRun", onclick: () => ask() });
  const status = h("p", { class: "hint", role: "status", id: "askStatus" });
  const result = h("div", { id: "askResult" });
  const consent = h("div", { id: "askConsent" });
  const engineSel = h("select", { id: "askEngine", "aria-label": "Which model checks the page" }, h("option", { value: "device" }, "On-device model (in this browser)"), h("option", { value: "loopback" }, "Model server on this computer"));
  engineSel.addEventListener("change", () => { engine = engineSel.value; paintModel(); paintLocal(); });
  const engineField = h("div", { class: "field", id: "askEngineField", hidden: true }, h("label", { for: "askEngine" }, "Model for these checks"), engineSel);
  const localInfo = h("p", { class: "hint", id: "localInfo" });
  const localState = h("p", { role: "status", id: "localState" });
  const localSelect = h("select", { id: "localModel", "aria-label": "On-device model size" }, MODELS.map(m => h("option", { value: m.key }, `${m.name} (about ${m.approxDownloadMB >= 1000 ? `${m.approxDownloadMB / 1000} GB` : `${m.approxDownloadMB} MB`})`)));
  localSelect.addEventListener("change", () => { lm.select(localSelect.value); paintLocal(); });
  const setupBtn = button("Set up the on-device model", { kind: "primary", id: "localSetup", onclick: () => setupDevice() });
  const cancelBtn = button("Cancel", { id: "localCancel", onclick: () => lm.cancel() });
  const removeBtn = button("Remove downloaded model", { kind: "ghost danger", id: "localRemove", onclick: async () => { await lm.remove(localSelect.value); paintModel(); toast("The on-device model was removed from this browser."); } });
  const smallBtn = button("Use the smaller model", { id: "localSmall", onclick: () => { localSelect.value = "qwen2.5-0.5b"; lm.select("qwen2.5-0.5b"); setupDevice(); } });
  const localBlock = h("div", { class: "x-local", id: "localBlock" }, h("strong", {}, "On-device model"), localInfo, h("div", { class: "field" }, h("label", { for: "localModel" }, "Model"), localSelect), localState,
    h("div", { class: "actions" }, setupBtn, cancelBtn, smallBtn, removeBtn));
  const quickBtn = q => button(q, { kind: "ghost", class: "askQuick", onclick: () => { question.value = q; question.focus(); } });
  const quick = h("div", {}, h("div", { class: "actions" }, ASK_QUESTIONS.map(quickBtn)),
    h("details", { class: "panel", id: "askMore" }, h("summary", {}, "More questions"), h("div", { class: "in" }, h("div", { class: "actions" }, MORE_QUESTIONS.map(quickBtn)))));

  const bwmState = h("p", { id: "bwmState", role: "status" });
  const bwmNote = h("p", { class: "hint" }, "Browse With Me looks only at the page you are on, only while it is running, only on sites you have allowed, and never on mail, sign-in, payment or private pages. Nothing is kept when you stop.");
  const bwmStatus = h("p", { class: "hint", role: "status", id: "bwmStatus" });
  const bwmList = h("div", { id: "bwmList" });
  const startBtn = button("Start Browse With Me", { kind: "primary", id: "bwmStart", onclick: () => startSession() });
  const pauseBtn = button("Pause", { id: "bwmPause", onclick: () => { session.pause(); paintSession(); } });
  const resumeBtn = button("Resume", { id: "bwmResume", onclick: () => { session.resume(); paintSession(); schedule(); } });
  const stopBtn = button("Stop", { kind: "danger", id: "bwmStop", onclick: () => stopSession("") });
  const allowBtn = button("Allow Cold on this site", { kind: "ghost", id: "bwmAllow", onclick: () => allowSite() });

  const discoverState = h("span", { class: "opt", id: "discoverState" });
  const actions = h("details", { class: "x-discover", id: "discover" },
    h("summary", {}, "Ask about this page ", discoverState),
    h("div", { class: "in" }, modelLine, consent,
      h("div", { class: "field" }, h("label", { for: "askQuestion" }, "Your question"), question), quick,
      h("div", { class: "actions" }, askBtn), status, result,
      h("div", { class: "x-bwm" }, bwmState, h("div", { class: "actions" }, startBtn), bwmStatus, bwmList)));
  const barState = h("span", { id: "bwmBarState" });
  const bar = h("div", { class: "x-bar", id: "bwmBar", role: "region", "aria-label": "Browse With Me session", hidden: true }, barState, h("div", { class: "actions" }, pauseBtn, resumeBtn, stopBtn, allowBtn));
  const discovery = h("div", { class: "form", id: "discoverySettings" },
    h("p", { class: "hint" }, "Pages are checked on this device: with the on-device model, or a model server on this computer if you've set one up."),
    engineField, bwmNote);

  const activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

  const openLocalSettings = () => { location.hash = "#/settings"; setTimeout(() => revealAndFocus("localModel"), 250); };
  const settingsLink = () => h("div", { class: "actions" }, button("Open the on-device model settings", { kind: "ghost", id: "askOpenSettings", onclick: openLocalSettings }));

  // ---- where page text may go ---------------------------------------------------------------------------------------------------
  const loopbackReady = () => { const { cfg } = platform.ownModel(); return !!cfg && cfg.ready && isLoopbackUrl(cfg.baseUrl); };
  const wantsDevice = () => engine === "device" || (engine === "auto" && !loopbackReady());
  /** The model for a check, or why there isn't one. An explicit choice of the on-device model never falls back to anything else. */
  function plan() {
    const { cfg, sample } = platform.ownModel();
    const d = platform.backend.describe();
    if (engine === "hosted") return d ? { ok: true, sample: platform.backend.sample, loc: { kind: "hosted", label: d.label, verified: false }, remote: true } : { ok: false, loc: localityOf({ own: cfg }) };
    if (wantsDevice()) return lm.ready ? { ok: true, sample: lm.sample, loc: localityOf({ device: { ready: true, label: lm.label } }), device: true } : { ok: false, device: true, loc: { kind: "device_pending", verified: false } };
    const loc = localityOf({ own: cfg, appAvailable: !!d && d.kind === "app" });
    return staysOnThisComputer(loc) ? { ok: true, sample, loc } : { ok: false, loc };
  }
  function paintModel() {
    const p = plan(); clear(consent);
    engineField.hidden = !loopbackReady(); if (loopbackReady()) engineSel.value = engine === "device" ? "device" : "loopback";
    if (p.ok && p.device) modelLine.textContent = `Uses the on-device model (${lm.label}), running in this browser. Page text is processed on this device and is not sent anywhere.`;
    else if (p.ok && !p.remote) modelLine.textContent = `Uses ${p.loc.label}, which this browser reaches on this computer${p.loc.host ? ` (${p.loc.host})` : ""}. Page text goes only to that address, but Cold can't verify what that server does with it.`;
    else if (p.ok) { modelLine.textContent = `Using ${p.loc.label} because you allowed it for this session. Page text is sent to that model.`; consent.append(button("Turn that off", { kind: "ghost", id: "askRemoteOff", onclick: () => { engine = "auto"; if (session.state !== "idle" && session.state !== "stopped") stopSession("Hosted model turned off."); paintModel(); paintLocal(); } })); }
    else modelLine.textContent = "";
    return p;
  }
  /** The clear failure state: says why nothing was read, and offers the user's choices. Never silently uses another model. */
  function blocked(loc) {
    clear(consent);
    const d = platform.backend.describe();
    const why = loc.kind === "remote" ? `Your model (${loc.label}) is at ${loc.host}, not on this computer.`
      : loc.kind === "unverified" ? "The only other model available is the Cold desktop app's. From here Cold can't tell whether it runs on this computer."
      : loc.kind === "device_pending" ? "The on-device model isn't ready." : "No model on this computer is set up.";
    consent.append(notice("warn", h("strong", {}, "Nothing was read."), h("p", {}, `${why} Cold keeps page text on this computer unless you say otherwise. You can set up the on-device model in Settings > Privacy and local models (no extra software), use a model server on this computer such as Ollama, or choose to use the available model for this panel session.`),
      d && loc.kind !== "device_pending" ? h("div", { class: "actions" }, button(`Use ${d.label} for these checks`, { id: "askRemoteOn", onclick: () => { engine = "hosted"; paintModel(); paintLocal(); status.textContent = "Allowed for this panel session. Page text will be sent to that model when you ask."; } })) : null));
    consent.append(settingsLink());
    modelLine.textContent = "";
  }

  // ---- the on-device model: set up on request, reused afterwards ------------------------------------------------------------------
  const sizeText = m => (m.approxDownloadMB >= 1000 ? `about ${m.approxDownloadMB / 1000} GB` : `about ${m.approxDownloadMB} MB`);
  const mb = bytes => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`);
  function paintLocal() {
    const st = lm.state, m = modelByKey(localSelect.value || st.modelKey);
    const where = `${new URL(MODEL_SOURCE.origin).host} (${MODEL_SOURCE.org})`;
    const provenance = st.pinned === false ? " This build has no verified checksums for the model yet, so it will not download it."
      : st.pinned ? ` Pinned to revision ${st.revision.slice(0, 12)}; every file is checked against its SHA-256 before it is used.` : "";
    localInfo.textContent = `Runs in this browser on your graphics hardware (WebGPU), so no model server is needed. The first time, it downloads the model files (${st.pinned ? `${mb(st.totalBytes)}, exact` : `${sizeText(m)}, estimated`}) from ${where} and keeps them in this browser. License: ${m.license}. Pages and your library are never part of that download.${provenance} ${m.note}`;
    const busy = st.phase === "checking" || st.phase === "loading";
    localState.textContent = busy ? `${st.text || "Working…"}${st.phase === "loading" && st.progress ? ` (${Math.round(st.progress * 100)}%)` : ""}`
      : st.phase === "ready" ? `Ready: ${lm.label}.` : st.phase === "error" || st.phase === "unsupported" ? st.text : st.text || "Not loaded yet.";
    localState.dataset.phase = st.phase; localState.dataset.code = (st.error && st.error.code) || "";
    setupBtn.hidden = busy || st.phase === "ready"; setupBtn.textContent = st.phase === "error" ? "Try again" : "Set up the on-device model";
    cancelBtn.hidden = !busy; removeBtn.hidden = !(st.cached || st.phase === "ready"); localSelect.disabled = busy;
    smallBtn.hidden = !(st.error && st.error.code === "insufficient_memory" && localSelect.value !== "qwen2.5-0.5b");
    if (!localSelect.value || localSelect.value !== st.modelKey) localSelect.value = st.modelKey;
  }
  lm.subscribe(() => { paintLocal(); paintModel(); });

  /** Explicit setup: says what will be downloaded (source, exact revision, licence, size) and asks first, unless the verified files are already here. */
  async function setupDevice() {
    engine = "device"; paintModel();
    const key = localSelect.value, m = modelByKey(key);
    lm.select(key);
    const sup = await lm.support();
    if (!sup.ok) { status.textContent = sup.message; try { await lm.load({ modelKey: key }); } catch { /* the state shows why */ } return false; }
    const info = await lm.pinInfo(key, sup.variant);
    if (!info.entry) { status.textContent = info.problem; try { await lm.load({ modelKey: key }); } catch { /* the state shows why */ } return false; }       // fail closed: no dialog, no request
    if (!(await lm.isCached(key))) {
      const ok = await confirmDialog({ title: "Download the on-device model?", confirmLabel: "Download",
        body: `${m.name}: ${info.entry.repo} at revision ${info.entry.revision.slice(0, 12)}, ${mb(lm.state.totalBytes)} in ${Object.values(info.entry.files).filter(f => f.required !== false).length} files, from ${new URL(MODEL_SOURCE.origin).host}. License: ${m.license}. Each file is checked against its pinned SHA-256 before it is used, and discarded if it doesn't match. It needs about ${(m.variants[sup.variant].vramMB / 1000).toFixed(1)} GB of graphics memory. Only model files are requested: your pages and library are not part of the download.` });
      if (!ok) return false;
    }
    try { await lm.load({ modelKey: key }); paintModel(); return true; } catch (e) { return false; }
  }
  /** The on-device model can't be used right now: say why, and list the other choices. Nothing is chosen for the user. */
  function deviceProblem(message) {
    clear(consent);
    const d = platform.backend.describe();
    consent.append(notice("warn", h("strong", {}, "Nothing was read."), h("p", {}, `${message} Cold keeps page text on this computer unless you choose otherwise.`),
      h("p", { class: "hint" }, "Your choices: fix the problem above, use a model server on this computer such as Ollama (Settings)" + (d && !loopbackReady() ? `, or use ${d.label} for these checks.` : ".")),
      d && !loopbackReady() ? h("div", { class: "actions" }, button(`Use ${d.label} for these checks`, { id: "askRemoteOn", onclick: () => { engine = "hosted"; paintModel(); paintLocal(); status.textContent = "Allowed for this panel session. Page text will be sent to that model when you ask."; } })) : null));
    consent.append(settingsLink());
    modelLine.textContent = ""; status.textContent = "Nothing was read.";
  }
  /** Make the on-device model ready for a check WITHOUT downloading anything unasked: load it only if it is already stored in this browser. */
  async function ensureDevice() {
    if (lm.ready) return true;
    if (lm.state.phase === "loading" || lm.state.phase === "checking") { status.textContent = "The on-device model is still loading."; return false; }
    const sup = await lm.support();
    if (!sup.ok) { try { await lm.load(); } catch { /* the state shows why */ } deviceProblem(sup.message); return false; }
    if (!(await lm.isCached())) { deviceProblem(lm.state.pinned === false ? (await lm.pinInfo(lm.state.modelKey, sup.variant)).problem : "The on-device model hasn't been downloaded to this browser yet. Choose “Set up the on-device model” in Settings > Privacy and local models; it asks before downloading."); return false; }
    status.textContent = "Loading the on-device model from this browser…";
    try { await lm.load(); return true; } catch (e) { deviceProblem(lm.state.text); return false; }
  }

  // ---- reading and evaluating ---------------------------------------------------------------------------------------------------
  async function readTab(tab) {
    const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage });
    return page;
  }
  // The evaluator, then (only when it found something) one more call: typed questions that can only lower confidence, never raise it (see jevChecks.js).
  const evaluateWith = (p, q) => async page => verifyResult({ sample: p.sample, page, products: S.products, result: await evaluatePage({ sample: p.sample, question: q, page, products: S.products, emails: S.emails }) });

  async function ask() {
    if (busy) return;
    let p = plan();
    if (!p.ok && p.device) { busy = true; askBtn.disabled = true; const ready = await ensureDevice(); busy = false; askBtn.disabled = false; if (!ready) { if (!status.textContent) status.textContent = "Nothing was read."; return; } p = plan(); }
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
    clear(host); actions.open = true;
    if (r.verdict === "none") { host.append(h("div", { class: "card ask-card", dataset: { verdict: "none" } }, h("strong", {}, "No meaningful opportunity found"), h("p", {}, r.summary || "Nothing on this page points to an opportunity for what you sell."), r.dropped ? h("p", { class: "hint" }, "Some suggestions were discarded because the page didn't back them up.") : null, button("Dismiss", { kind: "ghost", class: "askDismiss", onclick: () => clear(host) }))); return; }
    if (r.verdict === "uncertain") host.append(notice("warn", h("strong", {}, "Uncertain."), h("p", {}, "The page only weakly suggests this. Treat it as a lead to check, not a finding.")));
    for (const o of r.opportunities) host.append(card(o, page, r.verdict, key ? opportunityKey(o, page) : null, host));
    if (r.opportunities.length && r.secondCheck === "unavailable") host.append(h("p", { class: "hint", id: "askNoSecond" }, "The second check couldn't run with this model, so these results haven't been double-checked."));
  }
  /** What the second check said, in plain words: signal, fit, role and any caution. Nothing here is a fact about the page; it is a model's second opinion. */
  function reviewLine(o) {
    const r = o.review; if (!r || !r.checked) return null;
    const bits = [r.supported === true ? "the page supports the conclusion" : r.supported === false ? "the page may not support the conclusion" : "", r.signal && r.signal !== "none" ? `the organization ${SIGNAL_LABEL[r.signal]}` : "",
      r.fit ? `fit with your product: ${r.fit}` : "", r.role && r.role !== "other" ? ROLE_LABEL[r.role] : "", r.current === "dated" ? "the page may be out of date" : ""].filter(Boolean);
    return h("div", { class: "ask-review", dataset: { checked: "1" } }, h("p", { class: "hint ask-label" }, "Second check (another pass by your model, which can be wrong):"),
      bits.length ? h("p", {}, bits.join("; ")) : null, ...r.notes.map(n => h("p", { class: "hint" }, n)));
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
      reviewLine(o),
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
    // The session controls follow you to every tab while a session exists, so it can always be paused or stopped.
    const live = st === "active" || st === "paused";
    bar.hidden = !live;
    barState.textContent = live ? `Browse With Me ${st === "active" ? "is on" : "is paused"} · ${session.checked} page${session.checked === 1 ? "" : "s"} checked` : "";
    discoverState.textContent = live ? `· Browse With Me ${st === "active" ? "on" : "paused"}` : "";
  }
  async function startSession() {
    let p = plan();
    if (!p.ok && p.device) { bwmStatus.textContent = "Getting the on-device model ready…"; if (!(await ensureDevice())) { bwmStatus.textContent = "Browse With Me didn't start: the on-device model isn't ready."; return; } p = plan(); }
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
        if (r.status === "surfaced") { actions.open = true; bwmStatus.textContent = `New opportunity on ${new URL(tab.url).hostname}.`; for (const it of r.items) bwmList.prepend(card(it.opportunity, it.page, "opportunity", it.key, bwmList)); }
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

  paintModel(); paintLocal(); paintSession();
  platform.subscribe(() => { if (!consent.firstChild || plan().ok) paintModel(); });
  return { actions, bar, settings: { discovery, local: localBlock }, get session() { return session; } };
}
