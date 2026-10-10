// Browser-side client for the server API. Credentials never appear here; the optional access code is a
// shared secret the SERVER checks (see server.js), not a client-side gate.
import { parseLooseJson } from "../domain/email.js";

const ACCESS_HEADER = "x-cold-access";

export function createApi({ fetchImpl = (...a) => globalThis.fetch(...a), getAccess = () => "", getModel = () => undefined } = {}) {
  const headers = () => ({ "content-type": "application/json", accept: "application/json", ...(getAccess() ? { [ACCESS_HEADER]: getAccess() } : {}) });

  async function config() {
    if (!/^https?:$/.test(globalThis.location?.protocol || "")) return null;
    try {
      const r = await fetchImpl("api/config", { headers: { accept: "application/json" } });
      if (!r.ok) return null;
      const c = await r.json();
      return c && c.app === "cold" ? c : null;
    } catch { return null; }
  }

  async function models() {
    const r = await fetchImpl("api/models", { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("catalog");
    const { models } = await r.json();
    return Array.isArray(models) ? models : [];
  }

  async function sample(prompt, opts = {}) {
    let r;
    try {
      r = await fetchImpl("api/generate", { method: "POST", headers: headers(), signal: opts.signal, body: JSON.stringify({ prompt, model: getModel() || undefined }) });
    } catch (e) {
      if (e && e.name === "AbortError") throw { code: "cancelled" };
      throw { code: "network", message: "Couldn't reach the Cold server." };
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: (data.error && data.error.code) || (r.status === 429 ? "rate_limited" : "api_error"), status: r.status, message: (data.error && data.error.message) || `The server returned ${r.status}.` };
    return { text: data.text || "", truncated: !!data.truncated };
  }
  sample.json = async (prompt, opts) => parseLooseJson((await sample(prompt, opts)).text);

  return { config, models, sample };
}
