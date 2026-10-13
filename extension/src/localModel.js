// The on-device model, behind the same boundary every model has: sample(prompt) -> { text }. It is set up only when the user asks (lazily), loaded
// once and reused, can be cancelled, removed and retried, and when it can't run it SAYS so: it never hands the prompt to another model.
// Page text and library data only ever reach `engine.generate` in this browser. The only network traffic this can cause is downloading the
// PINNED model files (modelPins.js) from MODEL_SOURCE: plain GET requests, each file checked against its SHA-256 before it is accepted.
import { parseLooseJson } from "../../src/domain/email.js";
import { MODELS, MODEL_SOURCE, DEFAULT_MODEL, modelByKey, pickVariant, appConfigFor, classifyLoadError } from "./localModels.js";
import { pinFor, pinProblem, downloadPinned, isDownloaded, removePinned, totalBytes } from "./modelPins.js";

/**
 * @param {object} o
 * @param {() => Promise<object>} o.loadRuntime  lazily loads the WebLLM bundle: { create({modelId, appConfig, onProgress, signal}) -> engine}
 * @param {() => Promise<object>} o.loadPins     the model pins shipped with this build (dist/model-pins.json)
 * @param {() => any} [o.gpu]                    navigator.gpu (injectable for tests)
 * @param {(path: string) => string} [o.libUrl]  URL of a file packaged in the extension
 * @param {(scope: string) => Promise<Cache>} [o.openCache]
 * @param {typeof fetch} [o.fetchImpl]
 */
export function createLocalModel({ loadRuntime, loadPins, gpu = () => globalThis.navigator && globalThis.navigator.gpu, libUrl = p => globalThis.chrome.runtime.getURL(p),
  openCache = scope => globalThis.caches.open(scope), fetchImpl = (...a) => globalThis.fetch(...a), models = MODELS }) {
  let state = { phase: "unloaded", modelKey: DEFAULT_MODEL, variant: null, progress: 0, text: "", error: null, cached: null, loads: 0, pinned: null, revision: "", totalBytes: 0 };
  let runtime = null, engine = null, loading = null, ctl = null, chain = Promise.resolve();
  const subs = new Set();
  const set = patch => { state = { ...state, ...patch }; subs.forEach(fn => fn(state)); };

  /** Can this browser run a model at all, and which build of it? Never loads anything. */
  async function support() {
    const g = gpu();
    if (!g) return { ok: false, code: "unsupported_webgpu", message: "This browser doesn't offer WebGPU, which the on-device model needs. Use Chrome 114 or newer on a computer with a supported graphics card, or use a model server on this computer." };
    let adapter = null;
    // The browser may only hand one out for a particular power preference, so ask for the default, then each preference, before giving up.
    for (const opts of [undefined, { powerPreference: "high-performance" }, { powerPreference: "low-power" }]) {
      try { adapter = await g.requestAdapter(opts); } catch { adapter = null; }
      if (adapter) break;
    }
    if (!adapter) return { ok: false, code: "no_adapter", message: "WebGPU is present but no graphics adapter is available, so the on-device model can't run here. The most common cause is that Chrome turned graphics acceleration off after its graphics process crashed: quit Chrome completely (all windows) and reopen it, then try again. To check, open chrome://gpu: “WebGPU: Hardware accelerated” means it can work; “Disabled”, or “GPU access is disabled due to frequent crashes”, means restart, and if it keeps happening update Chrome and macOS. Remote sessions and some work-managed computers offer no GPU at all. You can also use a model server on this computer instead." };
    return { ok: true, variant: pickVariant(adapter.features), adapter };
  }
  /** The pin for this model and build, and whether it is complete. A model without a complete pin is never downloaded. */
  async function pinInfo(key, variant) {
    const id = modelByKey(key).variants[variant].id;
    let pins = null; try { pins = await loadPins(); } catch { pins = null; }
    const entry = pinFor(pins, id), problem = pinProblem(entry);
    const info = { id, entry: problem ? null : entry, problem: problem ? `${problem} ${pins && pins.status === "unpinned" ? "This build was made before the model files were pinned" : "This build can't verify the model files"}, so it won't download them (npm run pin:local-model records the exact revision and checksums).` : null };
    set({ pinned: !problem, revision: problem ? "" : entry.revision, totalBytes: problem ? 0 : totalBytes(entry) });
    return info;
  }
  const configFor = (key, variant, entry) => ({ m: modelByKey(key), variant, config: appConfigFor(modelByKey(key), variant, { libUrl, entry }), id: modelByKey(key).variants[variant].id });
  async function rt() { if (!runtime) runtime = await loadRuntime(); return runtime; }

  /** Is this model already stored (verified) in the browser, so loading it downloads nothing? Does not load the runtime. */
  async function isCached(key = state.modelKey) {
    const sup = await support(); if (!sup.ok) return false;
    const { entry } = await pinInfo(key, sup.variant);
    const c = entry ? await isDownloaded({ entry, source: MODEL_SOURCE, openCache }) : false;
    set({ cached: c }); return c;
  }

  /** Download (verified) and load, or reuse. Safe to call repeatedly: a loaded model is reused, a load in progress is joined. */
  function load({ modelKey = state.modelKey } = {}) {
    if (engine && state.phase === "ready" && state.modelKey === modelKey) return Promise.resolve(state);
    if (loading) return loading;
    ctl = new AbortController();
    const mine = ctl;
    set({ phase: "checking", modelKey, error: null, progress: 0, text: "Checking this computer…" });
    loading = (async () => {
      const sup = await support();
      if (!sup.ok) throw { code: sup.code, message: sup.message };
      const info = await pinInfo(modelKey, sup.variant);
      if (!info.entry) throw { code: "unpinned_model", message: info.problem };                       // fail closed: nothing is requested
      const { config, id } = configFor(modelKey, sup.variant, info.entry);
      set({ variant: sup.variant, phase: "loading", text: "Starting…" });
      const dl = await downloadPinned({ entry: info.entry, source: MODEL_SOURCE, fetchImpl, openCache, signal: mine.signal,
        onProgress: p => { if (!mine.signal.aborted) set({ progress: Math.min(0.85, (p.bytes / Math.max(1, p.total)) * 0.85), text: `${p.reused ? "Found" : "Downloading and checking"} file ${p.index} of ${p.count} (${p.file})` }); } });
      if (mine.signal.aborted) throw { code: "cancelled" };
      set({ cached: true, text: dl.fetched ? "Files downloaded and checked. Starting the model…" : "Files found in this browser. Starting the model…" });
      const r = await rt();
      const eng = await r.create({ modelId: id, appConfig: config, signal: mine.signal, onProgress: p => { if (!mine.signal.aborted) set({ progress: 0.85 + Math.max(0, Math.min(1, +p.progress || 0)) * 0.15, text: String(p.text || "").slice(0, 200) }); } });
      if (mine.signal.aborted) { try { await eng.unload(); } catch { /* gone */ } throw { code: "cancelled" }; }
      engine = eng;
      set({ phase: "ready", progress: 1, text: "Ready", cached: true, loads: state.loads + 1 });
      return state;
    })().catch(e => {
      engine = null;
      const err = mine.signal.aborted ? { code: "cancelled", message: "Cancelled." } : { ...classifyLoadError(e), detail: String((e && e.message) || e).slice(0, 300) };
      if (err.code === "cancelled") set({ phase: "unloaded", error: null, text: "Cancelled. Files already downloaded and checked are kept." });
      else set({ phase: err.code === "unsupported_webgpu" || err.code === "no_adapter" ? "unsupported" : "error", error: err, text: err.message });
      throw err;
    }).finally(() => { loading = null; });
    return loading;
  }
  /** Stop a setup in progress (verified files stay; the next attempt only fetches what is missing). */
  function cancel() { if (loading && ctl) ctl.abort(); }

  /** Forget the loaded model (frees graphics memory); downloaded files stay cached. */
  async function unload() { cancel(); const e = engine; engine = null; if (e) { try { await e.unload(); } catch { /* ignore */ } } set({ phase: "unloaded", text: "", error: null, progress: 0 }); }
  /** Delete this model's files from the browser: every pinned file, plus whatever the runtime itself cached for it. */
  async function remove(key = state.modelKey) {
    await unload();
    const sup = await support();
    if (sup.ok) {
      const info = await pinInfo(key, sup.variant);
      if (info.entry) await removePinned({ entry: info.entry, source: MODEL_SOURCE, openCache });
      // The runtime's own delete is deliberately not used: it re-reads tensor-cache.json (and would re-download it) to find the shards. Every file the runtime can hold was put there by the verified downloader, so deleting the pinned URLs is complete.
    }
    set({ cached: false, text: "Removed from this browser." });
  }

  /**
   * sample(prompt) like every other model. It does NOT start a download or a load by itself: if the model isn't ready it fails, so a missing model is
   * never papered over (and nothing is ever re-routed to another provider).
   */
  async function sample(prompt, opts = {}) {
    if (!engine || state.phase !== "ready") throw { code: "local_not_ready", message: "The on-device model isn't ready. Set it up first; nothing was sent anywhere." };
    const run = chain.catch(() => {}).then(async () => {
      if (opts.signal && opts.signal.aborted) throw { code: "cancelled" };
      try { return await engine.generate({ prompt, maxTokens: 700, signal: opts.signal }); }
      catch (e) { if (opts.signal && opts.signal.aborted) throw { code: "cancelled" }; throw { code: "api_error", message: `The on-device model failed while reading the page${e && e.message ? `: ${String(e.message).slice(0, 120)}` : ""}.` }; }
    });
    chain = run;
    const out = await run;
    return { text: out.text, truncated: !!out.truncated };
  }
  sample.json = async (prompt, opts) => parseLooseJson((await sample(prompt, opts)).text);

  return {
    get state() { return state; }, get ready() { return !!engine && state.phase === "ready"; },
    get label() { const m = modelByKey(state.modelKey); return `${m.name} (on this device)`; },
    models, support, pinInfo, isCached, load, cancel, unload, remove, sample,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** Choose which model to set up. Disposes a different loaded one; does nothing while a load is in progress. */
    select(key) { if (loading || key === state.modelKey) return; const e = engine; engine = null; if (e) e.unload().catch(() => {}); set({ modelKey: key, phase: "unloaded", cached: null, error: null, text: "", progress: 0 }); },
  };
}
