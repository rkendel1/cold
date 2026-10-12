// The WebLLM runtime, loaded on demand (llm-client.js is only fetched when the user first asks for the on-device model, so opening the
// panel never pays for it). It talks to llm-worker.js; model execution happens in that worker, on this computer's GPU.
import { CreateWebWorkerMLCEngine, hasModelInCache, deleteModelAllInfoInCache } from "@mlc-ai/web-llm";

globalThis.coldWebLLM = {
  version: "web-llm",
  hasModelInCache: (id, appConfig) => hasModelInCache(id, appConfig),
  deleteModelAllInfoInCache: (id, appConfig) => deleteModelAllInfoInCache(id, appConfig),
  /** Starts a worker and loads a model into it. Aborting the signal terminates the worker, which stops any download in progress. */
  async create({ modelId, appConfig, onProgress, signal }) {
    const worker = new Worker(globalThis.chrome.runtime.getURL("dist/llm-worker.js"));
    let aborted = false, onAbort;
    const cancelled = new Promise((_, reject) => { onAbort = () => { aborted = true; worker.terminate(); reject({ code: "cancelled" }); }; if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); } });
    let eng;
    try {
      eng = await Promise.race([CreateWebWorkerMLCEngine(worker, modelId, { appConfig, initProgressCallback: p => onProgress && onProgress({ progress: p.progress, text: p.text }) }), cancelled]);
    } catch (e) { worker.terminate(); throw aborted ? { code: "cancelled" } : e; }
    finally { if (signal) signal.removeEventListener("abort", onAbort); }
    return {
      async generate({ prompt, maxTokens, signal: s }) {
        const stop = () => eng.interruptGenerate();
        if (s) s.addEventListener("abort", stop, { once: true });
        try {
          const r = await eng.chat.completions.create({ messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens, response_format: { type: "json_object" } });
          const c = r.choices[0];
          return { text: (c.message && c.message.content) || "", truncated: c.finish_reason === "length" };
        } finally { if (s) s.removeEventListener("abort", stop); }
      },
      async unload() { try { await eng.unload(); } finally { worker.terminate(); } },
    };
  },
};
