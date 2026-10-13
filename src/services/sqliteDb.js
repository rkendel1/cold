// Browser-side client for the app's SQLite database (served by the local Cold server).
// It exposes the same small collection/doc/onSnapshot interface the store already uses for the Claude-app database, so the
// store and every view are unchanged. Writes show up immediately, are saved to SQLite in order, and a write that fails is undone.
import { saveWithMerge } from "../domain/library.js";
import { queryCollection } from "./collection.js";

const POLL_MS = 3000;

export function createRemoteDb({ fetchImpl = (...a) => globalThis.fetch(...a), headers = () => ({}), readLocal = () => null, poll = true, migrate = true } = {}) {
  const cache = { products: new Map(), emails: new Map(), leads: new Map(), settings: null, compose: null, unreadable: {} };
  const listeners = { products: new Set(), emails: new Set(), leads: new Set(), "settings/me": new Set() };
  let version = -1, timer = null;
  const queue = { tail: Promise.resolve() };

  async function call(path, init = {}) {
    let r;
    try { r = await fetchImpl(path, { ...init, headers: { "content-type": "application/json", accept: "application/json", ...headers(), ...(init.headers || {}) } }); }
    catch { throw { code: "storage_unavailable", message: "Couldn't reach the Cold app's database." }; }
    const data = await r.json().catch(() => ({}));
    if (r.status === 409 && data.current) throw { code: "conflict", status: 409, current: data.current, message: (data.error && data.error.message) || "Changed somewhere else." };
    if (!r.ok) throw { code: "storage_unavailable", message: (data.error && data.error.message) || "Couldn't save." };
    return data;
  }

  function adopt(snap) {
    cache.products = new Map(snap.products.map(p => [p.id, p]));
    cache.emails = new Map(snap.emails.map(e => [e.id, e]));
    cache.leads = new Map((snap.leads || []).map(l => [l.id, l]));
    cache.settings = snap.settings && Object.keys(snap.settings).length ? snap.settings : null;
    cache.compose = snap.compose || null;
    cache.unreadable = snap.unreadable || {};
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
        return res;
      } catch (e) { if (e && e.code === "conflict" && e.current) cache[which].set(e.current.id, e.current); else undo(); notify(which); throw e; }   // a conflict shows the newer stored record, not the stale one
    });
    queue.tail = job;
    return job;
  }

  const collection = name => queryCollection(listeners[name], () => docs(name));

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
    const url = `api/data/${name}/${encodeURIComponent(id)}`;
    const baseQ = expected => (expected === undefined ? "" : `?base=${expected === null ? "new" : expected}`);
    /**
     * Save `data`. With `{ expected, base }` the save is conditional on the stored record still being at version `expected`
     * (null: a new record); `base` is the copy that version had. If it moved on, a change to different fields is merged and
     * retried, and a change to the same field is refused with a "conflict" error that carries both versions.
     */
    async function put(data, { expected, base = null } = {}) {
      const send = (body, exp) => call(url + baseQ(exp), { method: "PUT", body: JSON.stringify(body) });
      if (expected === undefined) return { ...(await send(data)), record: data };              // an unversioned save, as older callers make
      const r = await saveWithMerge({ send, conflictOf: e => (e && e.code === "conflict" ? e.current : null), base, mine: data, expected });
      if (!r.ok) throw { ...r.error, status: 409 };
      return { ...r.value, record: r.record };
    }
    return {
      set: (data, opts = {}) => {
        const prev = cache[name].get(id);
        return write(() => cache[name].set(id, { ...data, id }), () => (prev ? cache[name].set(id, prev) : cache[name].delete(id)), async () => {
          const res = await put(data, opts);
          if (res.updatedAt !== undefined) { cache[name].set(id, { ...res.record, id, updatedAt: res.updatedAt }); notify(name); }
          return res;
        }, name).then(res => ({ updatedAt: res && res.updatedAt }));
      },
      delete: (opts = {}) => { const prev = cache[name].get(id); return write(() => cache[name].delete(id), () => prev && cache[name].set(id, prev), () => call(url + baseQ(opts.expected), { method: "DELETE" }), name); },
    };
  }

  /** Save or delete many records (a CSV import) with one screen update, then re-read what the database really holds. */
  function many(name, apply, undoAll, send) {
    apply(); notify(name);
    const job = queue.tail.catch(() => {}).then(async () => {
      try { await send(); await refresh(); }
      catch (e) { undoAll(); notify(name); await refresh().catch(() => {}); throw e; }   // whatever was saved before the failure stays; the screen shows the truth
    });
    queue.tail = job;
    return job;
  }
  const url = (name, id) => `api/data/${name}/${encodeURIComponent(id)}`;
  const setMany = (name, docs) => { const prev = docs.map(d => [d.id, cache[name].get(d.id)]);
    return many(name, () => docs.forEach(d => cache[name].set(d.id, { ...d })), () => prev.forEach(([id, p]) => (p ? cache[name].set(id, p) : cache[name].delete(id))), async () => { for (const d of docs) await call(url(name, d.id), { method: "PUT", body: JSON.stringify(d) }); }); };
  const deleteMany = (name, ids) => { const prev = ids.map(id => [id, cache[name].get(id)]);
    return many(name, () => ids.forEach(id => cache[name].delete(id)), () => prev.forEach(([id, p]) => p && cache[name].set(id, p)), async () => { for (const id of ids) await call(url(name, id), { method: "DELETE" }); }); };

  /** The notice for rows the database holds but this view can't show; [] when there are none. Counts only: no row content, no database detail. */
  const warnings = () => {
    const u = cache.unreadable || {}, parts = [["draft", u.emails], ["lead", u.leads], ["product", u.products]].filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`);
    const total = (u.emails || 0) + (u.leads || 0) + (u.products || 0);
    return total ? [`${total} saved item${total === 1 ? " was" : "s were"} unreadable and left out of this view (${parts.join(", ")}). ${total === 1 ? "It is" : "They are"} still in the database file and nothing was deleted. Back up the file before changing anything; see docs/troubleshooting.md.`] : [];
  };
  return { kind: "sqlite", load, collection, doc, setMany, deleteMany, get warnings() { return warnings(); }, get initialCompose() { return cache.compose; }, stop() { clearInterval(timer); timer = null; } };
}
