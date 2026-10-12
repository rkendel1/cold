// The on-device model, behind the same boundary every model has: sample(prompt) -> { text }. It is loaded only when the user asks (lazily),
// loaded once and reused, can be cancelled, removed and retried, and when it can't run it SAYS so: it never hands the prompt to another
// model. Page text and library data only ever reach `engine.generate` in this browser; the only network traffic it can cause is the weights
// download from MODEL_SOURCE, which carries nothing but the request for model files.
import { parseLooseJson } from "../../src/domain/email.js";
import { MODELS, DEFAULT_MODEL, modelByKey, pickVariant, appConfigFor, classifyLoadError } from "./localModels.js";

/**
 * @param {object} o
 * @param {() => Promise<object>} o.loadRuntime  lazily loads the WebLLM bundle: { create({modelId, appConfig, onProgress, signal}) -> engine, hasModelInCache, deleteModelAllInfoInCache }
 * @param {() => any} [o.gpu]                    navigator.gpu (injectable for tests)
 * @param {(path: string) => string} [o.libUrl]  URL of a file packaged in the extension
 */
export function createLocalModel({ loadRuntime, gpu = () => globalThis.navigator && globalThis.navigator.gpu, libUrl = p => globalThis.chrome.runtime.getURL(p), models = MODELS }) {
  let state = { phase: "unloaded", modelKey: DEFAULT_MODEL, variant: null, progress: 0, text: "", error: null, cached: null };
  let runtime = null, engine = null, loading = null, ctl = null, chain = Promise.resolve();
  const subs = new Set();
  const set = patch => { state = { ...state, ...patch }; subs.forEach(fn => fn(state)); };

  /** Can this browser run a model at all, and which build of it? Never loads anything. */
  async function support() {
    const g = gpu();
    if (!g) return { ok: false, code: "unsupported_webgpu", message: "This browser doesn't offer WebGPU, which the on-device model needs. Use Chrome 114 or newer on a computer with a supported graphics card, or use a model server on this computer." };
    let adapter = null;
    try { adapter = await g.requestAdapter(); } catch { adapter = null; }
    if (!adapter) return { ok: false, code: "no_adapter", message: "WebGPU is present but no graphics adapter is available (a remote session, a blocked driver, or no supported GPU). The on-device model can't run here." };
    return { ok: true, variant: pickVariant(adapter.features), adapter };
  }
  const configFor = (key, variant) => { const m = modelByKey(key); return { m, variant, config: appConfigFor(m, variant, { libUrl }), id: m.variants[variant].id }; };
  async function rt() { if (!runtime) runtime = await loadRuntime(); return runtime; }

  /** Is this model already stored in the browser (so loading it downloads nothing)? Loads the runtime only if there is something to ask about. */
  async function isCached(key = state.modelKey) {
    const sup = await support(); if (!sup.ok) return false;
    const { config, id } = configFor(key, sup.variant);
    try { const c = await (await rt()).hasModelInCache(id, config); set({ cached: !!c }); return !!c; } catch { return false; }
  }

  /** Load (or reuse) the model. Safe to call repeatedly: a loaded model is reused, a load in progress is joined. */
  function load({ modelKey = state.modelKey } = {}) {
    if (engine && state.phase === "ready" && state.modelKey === modelKey) return Promise.resolve(state);
    if (loading) return loading;
    ctl = new AbortController();
    const mine = ctl;
    set({ phase: "checking", modelKey, error: null, progress: 0, text: "Checking this computer…" });
    loading = (async () => {
      const sup = await support();
      if (!sup.ok) throw { code: sup.code, message: sup.message };
      const { config, id } = configFor(modelKey, sup.variant);
      set({ variant: sup.variant, phase: "loading", text: "Starting…" });
      const r = await rt();
      const eng = await r.create({ modelId: id, appConfig: config, signal: mine.signal, onProgress: p => { if (!mine.signal.aborted) set({ progress: Math.max(0, Math.min(1, +p.progress || 0)), text: String(p.text || "").slice(0, 200) }); } });
      if (mine.signal.aborted) { try { await eng.unload(); } catch { /* gone */ } throw { code: "cancelled" }; }
      engine = eng;
      set({ phase: "ready", progress: 1, text: "Ready", cached: true });
      return state;
    })().catch(e => {
      engine = null;
      const err = mine.signal.aborted ? { code: "cancelled", message: "Cancelled." } : classifyLoadError(e);
      if (err.code === "cancelled") set({ phase: "unloaded", error: null, text: "Cancelled. Files already downloaded are kept." });
      else set({ phase: err.code === "unsupported_webgpu" || err.code === "no_adapter" ? "unsupported" : "error", error: err, text: err.message });
      throw err;
    }).finally(() => { loading = null; });
    return loading;
  }
  /** Stop a load in progress (the download resumes from the browser's cache next time). */
  function cancel() { if (loading && ctl) ctl.abort(); }

  /** Forget the loaded model (frees graphics memory); downloaded files stay cached. */
  async function unload() { cancel(); const e = engine; engine = null; if (e) { try { await e.unload(); } catch { /* ignore */ } } set({ phase: "unloaded", text: "", error: null, progress: 0 }); }
  /** Delete the downloaded files for this model from the browser. */
  async function remove(key = state.modelKey) {
    await unload();
    const sup = await support();
    if (sup.ok) { const { config, id } = configFor(key, sup.variant); try { await (await rt()).deleteModelAllInfoInCache(id, config); } catch { /* nothing cached */ } }
    set({ cached: false, text: "Removed from this browser." });
  }

  /**
   * sample(prompt) like every other model. It does NOT start a load by itself: if the model isn't ready it fails, so a missing model is
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
    models, support, isCached, load, cancel, unload, remove, sample,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** Choose which model to set up. Disposes a different loaded one; does nothing while a load is in progress. */
    select(key) { if (loading || key === state.modelKey) return; const e = engine; engine = null; if (e) e.unload().catch(() => {}); set({ modelKey: key, phase: "unloaded", cached: null, error: null, text: "", progress: 0 }); },
  };
}
