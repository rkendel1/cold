// Talking to a model provider: request building, response parsing and error wording. Shared by the Cold server and the browser
// extension (which calls providers directly when the desktop app isn't running), so both behave identically.
const SYSTEM = "You are the writing engine inside Cold, a cold-email generator. Follow the instructions in the user message exactly. When asked for JSON, reply with only the JSON value: no preamble, no code fence.";

/** cfg = { id, kind: "openai" | "anthropic", baseUrl, def: { chatPath, modelsPath }, key, ... } */
function authHeaders(cfg, { browser = false } = {}) {
  if (cfg.kind === "anthropic") return { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", ...(browser ? { "anthropic-dangerous-direct-browser-access": "true" } : {}) };
  return cfg.key ? { authorization: `Bearer ${cfg.key}` } : {};
}

/** Everything needed to call fetch for one generation. */
function chatRequest(cfg, { model, prompt, maxTokens = 2000, browser = false }) {
  const openai = cfg.kind === "openai";
  return {
    url: cfg.baseUrl + cfg.def.chatPath,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(cfg, { browser }) },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(openai
          // Ollama: skip hidden "thinking" (it can burn the whole token budget) and force valid JSON.
          ? { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], stream: false, ...(cfg.id === "ollama" ? { reasoning_effort: "none", response_format: { type: "json_object" } } : {}) }
          : { system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
      }),
    },
  };
}

/** Provider JSON -> { text, truncated, model }, or null when it carried no text. */
function parseChat(cfg, data) {
  const openai = cfg.kind === "openai";
  const choice = data && data.choices && data.choices[0];
  const text = openai ? choice && choice.message && choice.message.content : ((data && data.content) || []).filter(b => b.type === "text").map(b => b.text).join("");
  if (typeof text !== "string" || !text.trim()) return null;
  return { text, truncated: openai ? choice.finish_reason === "length" : data.stop_reason === "max_tokens", model: data.model };
}

function apiErrorMessage(status, data, cfg, model = cfg.model) {
  const msg = data && data.error && data.error.message;
  if (status === 401 || status === 403) return `Authentication was rejected. Check ${cfg.keySetting}.`;
  if (status === 404) return `Model "${model}" wasn't found. Check ${cfg.modelSetting}.`;
  if (status === 429) return "Rate limited by the API. Wait a minute and try again.";
  if (status === 529 || status >= 500) return "The API is overloaded or unavailable right now. Try again shortly.";
  return typeof msg === "string" && msg ? `API error: ${msg}` : `API error (${status}).`;
}

const unreachable = (cfg, model, where = "from the server") => (cfg.id === "ollama"
  ? `Couldn't reach Ollama at ${cfg.baseUrl}. Is it running (ollama serve) and is "${model}" pulled?`
  : `Couldn't reach ${cfg.label} ${where}.`);

/** Provider model-list JSON -> sorted, de-duplicated [{ id, name }]. */
function parseModels(data) {
  const rows = Array.isArray(data && data.models) ? data.models : Array.isArray(data && data.data) ? data.data : [];
  const seen = new Set();
  return rows.map(m => {
    const raw = typeof m === "string" ? m : m && (m.id || m.name || m.model);
    if (typeof raw !== "string") return null;
    const id = raw.replace(/^models\//, "");
    return { id, name: (m && m.display_name) || id };
  }).filter(m => m && !seen.has(m.id) && seen.add(m.id)).sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { SYSTEM, authHeaders, chatRequest, parseChat, apiErrorMessage, unreachable, parseModels };
