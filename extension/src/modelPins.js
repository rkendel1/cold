// Model provenance: which exact files the on-device model is allowed to consist of, and the code that downloads and checks them.
// A pin is { repo, revision (a 40-hex git commit), files: { path: { sha256, size, required } } }. Nothing is downloaded, cached or loaded unless
// it is listed here, comes from the pinned revision, and matches its size and SHA-256. Pure functions plus injected fetch/cache, so Node can test them.

const HEX40 = /^[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/;
/** WebLLM 0.2.86 reads only mlc-chat-config.json (and a package manifest, which these models do not have) from the "config" cache; the tokenizer, tensor-cache.json and shards all come from the "model" cache. */
export const CONFIG_SCOPE = "webllm/config", MODEL_SCOPE = "webllm/model";
export const scopeOf = path => (path === "mlc-chat-config.json" ? CONFIG_SCOPE : MODEL_SCOPE);

export function parsePins(json) {
  if (!json || typeof json !== "object" || json.schema !== 1 || typeof json.models !== "object") throw new Error("model-pins.json is not in the expected format");
  return json;
}
/** The pin for a model id, or null. */
export const pinFor = (pins, modelId) => (pins && pins.models && pins.models[modelId]) || null;

/** Why this model can't be used as pinned, or null if it can. Fails closed on anything not fully specified. */
export function pinProblem(entry) {
  if (!entry) return "There are no recorded checksums for this model in this build.";
  if (!HEX40.test(String(entry.revision || ""))) return "The model isn't pinned to an exact revision.";
  const files = entry.files && typeof entry.files === "object" ? Object.entries(entry.files) : [];
  if (!files.length) return "No model files are listed.";
  for (const [p, f] of files) { if (!HEX64.test(String(f && f.sha256 || "")) || !(f.size >= 0) || /^\/|\.\.|\\/.test(p)) return `The entry for ${p} is invalid.`; }
  for (const need of ["mlc-chat-config.json", "tensor-cache.json"]) if (!entry.files[need]) return `${need} is not pinned.`;
  return null;
}
export const requiredFiles = entry => Object.entries(entry.files).filter(([, f]) => f.required !== false).map(([path, f]) => ({ path, ...f }));
export const totalBytes = entry => requiredFiles(entry).reduce((n, f) => n + f.size, 0);
export const artifactUrl = (source, entry, path) => `${source.origin}/${entry.repo}/resolve/${entry.revision}/${path.split("/").map(encodeURIComponent).join("/")}`;
export const modelBaseUrl = (source, entry) => `${source.origin}/${entry.repo}/resolve/${entry.revision}/`;
/** hex digest -> the "sha256-BASE64" form WebLLM's own integrity check takes */
export const toSri = hex => `sha256-${btoa(String.fromCharCode(...hex.match(/../g).map(h => parseInt(h, 16))))}`;

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, b => b.toString(16).padStart(2, "0")).join("");
}

const integrity = (path, expected, actual, extra = "") => Object.assign(new Error(`${path} did not match its pinned checksum${extra}`), { name: "IntegrityError", code: "integrity_failed", file: path, expected, actual,
  message: `The downloaded file “${path}” didn't match its pinned checksum${extra}, so it was discarded and nothing was loaded. Try again; if it keeps happening, the source may have changed or this build's checksums are out of date.` });

/** Read a response body fully, enforcing the pinned size as we go and reporting bytes. */
async function readBounded(res, path, size, signal, onBytes) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) { const b = new Uint8Array(await res.arrayBuffer()); if (b.length !== size) throw integrity(path, size, b.length, " (wrong size)"); onBytes(b.length); return b; }
  const out = new Uint8Array(size); let n = 0;
  for (;;) {
    if (signal && signal.aborted) { try { await reader.cancel(); } catch { /* gone */ } throw { code: "cancelled" }; }
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > size) { try { await reader.cancel(); } catch { /* gone */ } throw integrity(path, size, `more than ${size} bytes`, " (too large)"); }
    out.set(value, n); n += value.length; onBytes(value.length);
  }
  if (n !== size) throw integrity(path, size, n, " (wrong size)");
  return out;
}

/**
 * Download every required file of a pinned model, check each one's size and SHA-256, and only then put it in the cache WebLLM reads from.
 * A file already in the cache under its pinned URL was put there by this function, so it is reused. Nothing unverified is ever cached.
 * @param {{ entry, source, fetchImpl?, openCache(scope): Promise<Cache>, signal?, onProgress?({file,index,count,bytes,total}) }} o
 */
export async function downloadPinned({ entry, source, fetchImpl = (...a) => globalThis.fetch(...a), openCache, signal, onProgress = () => {} }) {
  const problem = pinProblem(entry); if (problem) throw { code: "unpinned_model", message: problem };
  const files = requiredFiles(entry), total = files.reduce((n, f) => n + f.size, 0);
  let done = 0, fetched = 0;
  files.forEach(f => f.url = artifactUrl(source, entry, f.path));
  for (const [i, f] of files.entries()) {
    const cache = await openCache(scopeOf(f.path));
    if (await cache.match(f.url)) { done += f.size; onProgress({ file: f.path, index: i + 1, count: files.length, bytes: done, total, reused: true }); continue; }
    if (signal && signal.aborted) throw { code: "cancelled" };
    let res;
    try { res = await fetchImpl(f.url, { signal, credentials: "omit", cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer" }); }
    catch (e) { if (signal && signal.aborted) throw { code: "cancelled" }; throw { code: "download_failed", message: `Couldn't download “${f.path}” (${(e && e.message) || "network error"}). Check your connection and try again; nothing you were reading was sent.` }; }
    if (!res.ok) throw { code: "download_failed", message: `The model host answered ${res.status} for “${f.path}”. Try again later; nothing you were reading was sent.` };
    const start = done;
    const bytes = await readBounded(res, f.path, f.size, signal, n => { done += n; onProgress({ file: f.path, index: i + 1, count: files.length, bytes: done, total }); });
    const actual = await sha256Hex(bytes);
    if (actual !== f.sha256) throw integrity(f.path, f.sha256, actual);                       // never cached, never loaded
    await cache.put(f.url, new Response(bytes, { status: 200, headers: { "content-type": /\.json$/.test(f.path) ? "application/json" : "application/octet-stream", "content-length": String(f.size) } }));
    done = start + f.size; fetched++;
  }
  return { fetched, reused: files.length - fetched, files: files.length, bytes: total };
}

/** Are all required files already stored (verified) under their pinned URLs? */
export async function isDownloaded({ entry, source, openCache }) {
  if (pinProblem(entry)) return false;
  for (const f of requiredFiles(entry)) { const c = await openCache(scopeOf(f.path)); if (!(await c.match(artifactUrl(source, entry, f.path)))) return false; }
  return true;
}
/** Delete every pinned file from the cache. Returns how many entries were removed. */
export async function removePinned({ entry, source, openCache }) {
  let n = 0;
  for (const path of Object.keys((entry && entry.files) || {})) { const c = await openCache(scopeOf(path)); if (await c.delete(artifactUrl(source, entry, path))) n++; }
  return n;
}
