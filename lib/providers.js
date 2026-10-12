// Provider registry. `kind` picks the wire format: "openai" = /chat/completions, "anthropic" = /v1/messages.
// Every entry here can be configured from the desktop Settings screen; env vars still work and act as defaults.
const PROVIDERS = [
  { id: "ollama", label: "Ollama (local)", kind: "openai", baseUrl: "http://127.0.0.1:11434", chatPath: "/v1/chat/completions", modelsPath: "/api/tags", needsKey: false, editableUrl: true, defaultModel: "llama3.1", env: { url: "OLLAMA_BASE_URL", model: "OLLAMA_MODEL" } },
  { id: "anthropic", label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", chatPath: "/v1/messages", modelsPath: "/v1/models", needsKey: true, defaultModel: "claude-sonnet-5-5", env: { key: "ANTHROPIC_API_KEY", url: "ANTHROPIC_BASE_URL", model: "ANTHROPIC_MODEL" } },
  { id: "openai", label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", chatPath: "/chat/completions", modelsPath: "/models", needsKey: true, defaultModel: "gpt-4o-mini", env: { key: "OPENAI_API_KEY", model: "OPENAI_MODEL" } },
  { id: "google", label: "Google Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", chatPath: "/chat/completions", modelsPath: "/models", needsKey: true, defaultModel: "gemini-2.0-flash", env: { key: "GEMINI_API_KEY", model: "GEMINI_MODEL" } },
  { id: "openrouter", label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", chatPath: "/chat/completions", modelsPath: "/models", needsKey: true, defaultModel: "anthropic/claude-sonnet-4.5", env: { key: "OPENROUTER_API_KEY", model: "OPENROUTER_MODEL" } },
  { id: "groq", label: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", chatPath: "/chat/completions", modelsPath: "/models", needsKey: true, defaultModel: "llama-3.3-70b-versatile", env: { key: "GROQ_API_KEY", model: "GROQ_MODEL" } },
  { id: "mistral", label: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1", chatPath: "/chat/completions", modelsPath: "/models", needsKey: true, defaultModel: "mistral-large-latest", env: { key: "MISTRAL_API_KEY", model: "MISTRAL_MODEL" } },
  { id: "ai-gateway", label: "Vercel AI Gateway", kind: "openai", baseUrl: "https://ai-gateway.vercel.sh/v1", chatPath: "/chat/completions", modelsPath: "/models", needsKey: true, defaultModel: "anthropic/claude-sonnet-4.5", env: { key: "AI_GATEWAY_API_KEY", model: "AI_GATEWAY_MODEL" } },
  { id: "custom", label: "Custom (OpenAI-compatible)", kind: "openai", baseUrl: "", chatPath: "/chat/completions", modelsPath: "/models", needsKey: false, editableUrl: true, defaultModel: "", env: { key: "CUSTOM_API_KEY", url: "CUSTOM_BASE_URL", model: "CUSTOM_MODEL" } },
];
const BY_ID = Object.fromEntries(PROVIDERS.map(p => [p.id, p]));

module.exports = { PROVIDERS, BY_ID };
