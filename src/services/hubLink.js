// The (optional) link to the Cold desktop app. Web and the extension work without it; when the app is running and paired, the link
// attaches it to the local copy so changes sync both ways, and the app's model can be used.
import { createApi } from "./api.js";
import { hubFetch } from "./hub.js";

const CHECK_MS = 4000;

export function createLink({ replica }) {
  const state = { conn: null, online: false, config: null, rejected: false };
  const subs = new Set();
  let api = null, timer = null, checking = false;
  const emit = () => subs.forEach(fn => fn(state));

  function appData(conn) {
    const f = hubFetch(conn);
    const call = async (path, init) => { const r = await f(path, { ...init, headers: { "content-type": "application/json", ...(init && init.headers) } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
    return { get: p => call(p), put: (p, b) => call(p, { method: "PUT", body: JSON.stringify(b) }), del: p => call(p, { method: "DELETE" }) };
  }

  function set(online, config, rejected = false) {
    const changed = online !== state.online || rejected !== state.rejected || (online && config && state.config && config.model !== state.config.model);
    state.online = online; state.config = config; state.rejected = rejected;
    if (online && !api) { api = createApi({ fetchImpl: hubFetch(state.conn), remote: true }); replica.attach(appData(state.conn)); }
    if (!online && api) { api = null; replica.attach(null); }
    if (changed) emit();
  }

  async function check() {
    if (checking) return; checking = true;
    try {
      if (!state.conn) return set(false, null);
      const origin = state.conn.origin;
      try {
        const cfg = await (await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(2500) })).json();
        if (!cfg || cfg.app !== "cold" || !cfg.dbEnabled) return set(false, null);
        const ping = await fetch(`${origin}/api/data/ping`, { headers: { authorization: `Bearer ${state.conn.token}` }, signal: AbortSignal.timeout(2500) });
        if (ping.status === 403) return set(false, null, true);       // the app is up but this pairing code is no longer valid
        if (!ping.ok) return set(false, null);
        const { version } = await ping.json();
        set(true, cfg);
        if (version !== replica.appVersion) replica.sync().catch(() => {});   // something changed in the app (or we've never synced)
      } catch { set(false, null); }
    } finally { checking = false; }
  }

  return {
    state,
    get api() { return api; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    check,
    start() { if (!timer) { timer = setInterval(check, CHECK_MS); } return check(); },
    stop() { clearInterval(timer); timer = null; },
    async connect(conn) { state.conn = conn; api = null; replica.attach(null); state.online = false; await check(); emit(); },
    disconnect() { state.conn = null; api = null; replica.attach(null); state.online = false; state.config = null; state.rejected = false; emit(); },
  };
}
