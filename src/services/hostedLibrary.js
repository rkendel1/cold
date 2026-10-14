// The hosted library: one library per Cold account, kept on the Cold server (lib/hosted.js). On the page it is the SAME database client the desktop app uses, pointed at
// /api/hosted/*. It is opened only by an explicit action (or by remembering that the person chose it on this device), never by signing in, and nothing is copied into it or out of
// it. A failed, unreachable or unauthorised write rejects; it is never redirected to the local library. How a request reaches the server depends on the surface:
//   web         fetch with the HttpOnly session cookie and the session's CSRF token
//   desktop     fetch to this app's own local server, which adds its in-memory bearer token (the page never holds one)
//   extension   a message to the background worker, which adds the bearer token (the panel never holds one)
import { createRemoteDb } from "./sqliteDb.js";
import { queryCollection } from "./collection.js";

const CHOICE_KEY = "cold.library.choice";   // "hosted" once the person has opened their hosted library on this device; absent means local
const safe = fn => { try { return fn(); } catch { return null; } };

/** Where the choice is remembered: this device only (localStorage here; the extension supplies its own, in extension storage). Never sent anywhere. */
export const localChoice = (storage = globalThis.localStorage) => ({
  get: async () => safe(() => storage.getItem(CHOICE_KEY)) === "hosted",
  set: async on => { safe(() => (on ? storage.setItem(CHOICE_KEY, "hosted") : storage.removeItem(CHOICE_KEY))); },
});

/** Does this surface's server offer a hosted library? Web: the server says so. Desktop and extension: signed-in access is via the account service, which answers for itself. */
export const hostedOffered = server => !!(server && server.account && server.account.enabled && (server.account.hosted || server.account.mode === "native"));

/** What to tell the person when the hosted library can't be used. */
const REASON = { session_expired: "You're signed out, so the hosted library can't be used. Sign in to open it, or switch to your local library.", storage_unavailable: "Your hosted library can't be reached right now. Nothing is shown from it and nothing can be saved to it. Try again, or switch to your local library.",
  no_library: "You haven't created a hosted library with this account yet. Create it in Settings > Cold account, or switch to your local library.", hosted_disabled: "This Cold server doesn't offer hosted libraries." };
export const hostedReason = (code, fallback = "") => REASON[code] || fallback || REASON.storage_unavailable;

const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

/** Web: the cookie rides along; writes also carry the session's CSRF token (read once from /api/account/me). */
export function webTransport({ fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  let csrf = "";
  return async (path, init = {}) => {
    const write = init.method && init.method !== "GET";
    if (write && !csrf) { const r = await fetchImpl("api/account/me", { headers: { accept: "application/json" } }); if (r.ok) csrf = (await r.json().catch(() => ({}))).csrf || ""; }
    return fetchImpl(path, { ...init, headers: { accept: "application/json", "content-type": "application/json", ...(csrf ? { "x-cold-csrf": csrf } : {}), ...(init.headers || {}) } });
  };
}
/** Extension: ask the background worker to make the call (extension/src/account.js). The worker adds the token; this side never sees it. */
export function workerTransport({ send = m => chrome.runtime.sendMessage(m) } = {}) {
  return async (path, init = {}) => {
    let r; try { r = await send({ cold: "account", op: "hosted", method: init.method || "GET", path: `/${String(path).replace(/^\//, "")}`, body: init.body ? JSON.parse(init.body) : undefined }); } catch { r = null; }
    if (!r || typeof r.status !== "number") return reply(503, { error: { code: "storage_unavailable", message: "Couldn't reach your hosted library. Nothing was saved there." } });
    return reply(r.status, r.data || {});
  };
}

export function createHostedLibrary({ transport, onSessionEnded = () => {} }) {
  let ended = false;
  const call = async (path, init = {}) => {
    let r; try { r = await transport(path, init); } catch { throw { code: "storage_unavailable", message: "Couldn't reach your hosted library. Nothing was saved there." }; }
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { if (!ended) { ended = true; onSessionEnded(); } throw { code: "session_expired", message: (d.error && d.error.message) || "You're signed out." }; }
    if (r.status === 404 && d.error && d.error.code === "hosted_disabled") throw { code: "hosted_disabled", message: d.error.message };
    if (!r.ok) throw { code: (d.error && d.error.code) || "storage_unavailable", status: r.status, message: (d.error && d.error.message) || "Couldn't reach your hosted library." };
    ended = false; return d;
  };
  // The page's database client speaks /api/data; the hosted library lives under /api/hosted. Only the path moves.
  const hostedFetch = (path, init = {}) => transport(String(path).replace(/^api\/data/, "api/hosted/data"), init).then(r => { if (r.status === 401 && !ended) { ended = true; onSessionEnded(); } return r; });
  return {
    summary: () => call("api/hosted/library"),
    create: () => call("api/hosted/library", { method: "POST", body: "{}" }),
    /** Loads the existing hosted library and returns a database for the store. Rejects (never falls back): session_expired, no_library, storage_unavailable. */
    async open() {
      const info = await call("api/hosted/library");
      if (!info.exists) throw { code: "no_library", message: "You haven't created a hosted library yet." };
      const inner = createRemoteDb({ fetchImpl: hostedFetch, poll: true, migrate: false, where: "your hosted library" });
      await inner.load();
      return {
        ...inner, kind: "hosted",
        // The Write form can hold a person's details half-typed; it is device state and is neither uploaded nor kept in hosted mode.
        saveCompose: () => {}, get initialCompose() { return null; }, get warnings() { return inner.warnings; },
      };
    },
  };
}

/**
 * Stands in for the hosted library when it was chosen but can't be used right now (signed out, unreachable, not created). It shows NOTHING (never the local library's data) and
 * every write is refused with the reason, so nothing can be saved to the wrong place or reported as saved.
 */
export function unavailableDb({ code, message }) {
  const refuse = () => Promise.reject({ code: code === "session_expired" ? "session_expired" : "storage_unavailable", message });
  const none = () => ({ exists: false, data: () => ({}) });
  return {
    kind: "hosted", unavailable: { code, message }, load: async () => {}, stop() {}, initialCompose: null, saveCompose: () => {}, warnings: [],
    collection: () => queryCollection(new Set(), () => []),
    doc: path => ({ set: refuse, delete: refuse, onSnapshot(cb) { if (path.startsWith("settings")) cb(none()); return () => {}; } }),
    setMany: refuse, deleteMany: refuse, erase: refuse,
  };
}
