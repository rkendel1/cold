// Browser-side client for the app's SQLite database (served by the local Cold server).
// It exposes the same small collection/doc/onSnapshot interface the store already uses for the Claude-app database, so the
// store and every view are unchanged. Writes show up immediately, are saved to SQLite in order, and a write that fails is undone.
const POLL_MS = 3000;

export function createRemoteDb({ fetchImpl = (...a) => globalThis.fetch(...a), headers = () => ({}), readLocal = () => null, poll = true, migrate = true } = {}) {
  const cache = { products: new Map(), emails: new Map(), settings: null, compose: null };
  const listeners = { products: new Set(), emails: new Set(), "settings/me": new Set() };
  let version = -1, timer = null;
  const queue = { tail: Promise.resolve() };

  async function call(path, init = {}) {
    let r;
    try { r = await fetchImpl(path, { ...init, headers: { "content-type": "application/json", accept: "application/json", ...headers(), ...(init.headers || {}) } }); }
    catch { throw { code: "storage_unavailable", message: "Couldn't reach the Cold app's database." }; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: "storage_unavailable", message: (data.error && data.error.message) || "Couldn't save." };
    return data;
  }

  function adopt(snap) {
    cache.products = new Map(snap.products.map(p => [p.id, p]));
    cache.emails = new Map(snap.emails.map(e => [e.id, e]));
    cache.settings = snap.settings && Object.keys(snap.settings).length ? snap.settings : null;
    cache.compose = snap.compose || null;
    version = snap.version;
  }

  const docs = name => [...cache[name].entries()].map(([id, d]) => ({ id, data: () => ({ ...d }) }));
  const settingsSnap = () => ({ exists: !!cache.settings, data: () => ({ ...(cache.settings || {}) }) });
  function notify(which) {
    for (const name of which ? [which] : Object.keys(listeners)) for (const fn of listeners[name]) fn();
  }

  async function refresh() { adopt(await call("api/data")); notify(); }

  /** Loads everything. On the very first run, copies any data found in this browser's storage into SQLite (once). */
  async function load() {
    let snap = await call("api/data");
    if (!snap.migrated && migrate) {   // only the app itself imports; the extension never does
      const local = readLocal();
      await call("api/data/import", { method: "POST", body: JSON.stringify(local || {}) });
      snap = await call("api/data");
    }
    adopt(snap);
  }

  function startPolling() {
    if (!poll || timer) return;
    timer = setInterval(async () => {
      if (globalThis.document && document.hidden) return;
      try { const { version: v } = await call("api/data/version"); if (v !== version) await refresh(); } catch { /* try again next tick */ }
    }, POLL_MS);
  }

  /** Optimistic write: apply now, save in order, undo and report if it fails. */
  function write(apply, undo, save, which) {
    apply(); notify(which);
    const job = queue.tail.catch(() => {}).then(async () => {
      try {
        const res = await save();
        if (res.version !== version + 1) await refresh(); else version = res.version;   // someone else wrote in between: re-read
      } catch (e) { undo(); notify(which); throw e; }
    });
    queue.tail = job;
    return job;
  }

  const sortBy = (arr, field, dir) => arr.sort((a, b) => { const x = a.data()[field], y = b.data()[field]; return (x < y ? -1 : x > y ? 1 : 0) * (dir === "desc" ? -1 : 1); });

  function collection(name) {
    const q = { field: null, dir: "asc", n: Infinity };
    const api = {
      orderBy(field, dir = "asc") { q.field = field; q.dir = dir; return api; },
      limit(n) { q.n = n; return api; },
      onSnapshot(cb) {
        const fire = () => { let d = docs(name); if (q.field) sortBy(d, q.field, q.dir); cb({ docs: d.slice(0, q.n) }); };
        listeners[name].add(fire); fire(); startPolling();
        return () => listeners[name].delete(fire);
      },
    };
    return api;
  }

  function doc(path) {
    const [name, id] = path.split("/");
    if (name === "settings") return {
      set: data => { const prev = cache.settings; return write(() => { cache.settings = { ...data }; }, () => { cache.settings = prev; }, () => call("api/data/settings", { method: "PUT", body: JSON.stringify(data) }), "settings/me"); },
      onSnapshot(cb) { const fire = () => cb(settingsSnap()); listeners["settings/me"].add(fire); fire(); return () => listeners["settings/me"].delete(fire); },
    };
    if (name === "compose") return {
      // Form scratch space: saved quietly, never re-read by other windows.
      set: data => { cache.compose = { ...data }; return call("api/data/compose", { method: "PUT", body: JSON.stringify(data) }).then(() => {}); },
    };
    return {
      set: data => { const prev = cache[name].get(id); return write(() => cache[name].set(id, { ...data, id }), () => (prev ? cache[name].set(id, prev) : cache[name].delete(id)), () => call(`api/data/${name}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(data) }), name); },
      delete: () => { const prev = cache[name].get(id); return write(() => cache[name].delete(id), () => prev && cache[name].set(id, prev), () => call(`api/data/${name}/${encodeURIComponent(id)}`, { method: "DELETE" }), name); },
    };
  }

  return { kind: "sqlite", load, collection, doc, get initialCompose() { return cache.compose; }, stop() { clearInterval(timer); timer = null; } };
}
