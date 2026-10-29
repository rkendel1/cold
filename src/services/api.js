// Browser-side client for the server API. Credentials never appear here; the optional access code is a
// shared secret the SERVER checks (see server.js), not a client-side gate.
import { parseLooseJson } from "../domain/email.js";

const ACCESS_HEADER = "x-cold-access";

export function createApi({ fetchImpl = (...a) => globalThis.fetch(...a), getAccess = () => "", getModel = () => undefined, remote = false } = {}) {
  const headers = () => ({ "content-type": "application/json", accept: "application/json", ...(getAccess() ? { [ACCESS_HEADER]: getAccess() } : {}) });

  async function config() {
    if (!remote && !/^https?:$/.test(globalThis.location?.protocol || "")) return null;
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

  async function settingsCall(path, init = {}) {
    const r = await fetchImpl(path, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: (data.error && data.error.code) || "api_error", message: (data.error && data.error.message) || `The server returned ${r.status}.` };
    return data;
  }
  /** Import product knowledge from a repository. The server streams newline-delimited JSON: {step}… then {done,result} or {error}. */
  async function importStream(path, init, { onStep = () => {}, signal } = {}) {
    let r;
    try { r = await fetchImpl(path, { ...init, signal }); }
    catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled" }; throw { code: "network", message: "Couldn't reach the Cold server." }; }
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw { code: (d.error && d.error.code) || (r.status === 429 ? "rate_limited" : "api_error"), message: (d.error && d.error.message) || `The server returned ${r.status}.` }; }
    let result = null, failure = null;
    const line = raw => {
      if (!raw.trim()) return;
      let o; try { o = JSON.parse(raw); } catch { return; }
      if (o.step) onStep(o.step); else if (o.done) result = o.result; else if (o.error) failure = o.error;
    };
    try {
      if (r.body && r.body.getReader) {
        const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
        }
        line(buf);
      } else (await r.text()).split("\n").forEach(line);
    } catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled" }; throw { code: "network", message: "The connection dropped while reading the project." }; }
    if (failure) throw { code: failure.code || "api_error", message: failure.message || "The import failed." };
    if (!result) throw { code: "network", message: "The import ended before it finished. Try again." };
    return result;
  }
  const importRepo = (url, { previous, ...o } = {}) => importStream("api/import/repo", { method: "POST", headers: headers(), body: JSON.stringify({ url, previous }) }, o);
  const importZip = (file, { previous, ...o } = {}) => {
    const meta = new TextEncoder().encode(JSON.stringify({ name: file.name, previous })), len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, meta.length);
    return importStream("api/import/zip", { method: "POST", headers: { ...headers(), "content-type": "application/octet-stream" }, body: new Blob([len, meta, file]) }, o);
  };
  // A folder on this computer, already read in the browser: [{ path, text }]. The server re-applies its own file filters.
  const importFolder = (name, files, { previous, ...o } = {}) => importStream("api/import/folder", { method: "POST", headers: headers(), body: JSON.stringify({ name, files, previous }) }, o);
  const profile = url => settingsCall("api/profile", { method: "POST", body: JSON.stringify({ url }) });
  // Email lookup (treg). The server holds the token; these send one person's details and get a candidate back, never a saved result.
  const findEmail = input => settingsCall("api/people/email/find", { method: "POST", body: JSON.stringify(input) });
  const verifyEmail = input => settingsCall("api/people/email/verify", { method: "POST", body: JSON.stringify(input) });
  const tweet = url => settingsCall("api/tweet", { method: "POST", body: JSON.stringify({ url }) });
  const setWebOrigins = origins => settingsCall("api/settings/web-origins", { method: "PUT", body: JSON.stringify({ origins }) });
  const getExtension = () => settingsCall("api/settings/extension");
  const rotateExtension = () => settingsCall("api/settings/extension", { method: "POST" });
  const getSettings = () => settingsCall("api/settings");
  const saveSettings = patch => settingsCall("api/settings", { method: "PUT", body: JSON.stringify(patch) });
  const providerModels = id => settingsCall(`api/settings/models?provider=${encodeURIComponent(id)}`).then(d => d.models || []);

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

  return { googleCall: settingsCall, config, models, sample, importRepo, importZip, importFolder, profile, tweet, findEmail, verifyEmail, getExtension, rotateExtension, setWebOrigins, getSettings, saveSettings, providerModels };
}
