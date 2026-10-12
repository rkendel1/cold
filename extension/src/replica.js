// The extension's own copy of your products and drafts. It works with no app running; whenever the Cold app is reachable it
// pushes what you changed here and pulls what changed there. Exposes the same collection/doc/onSnapshot interface the store
// already uses, so the store and views don't care where data lives.
//
// Sync rules: the app is the source of truth. Local changes wait in an "outbox" and are sent when the app is reachable; if the
// app's copy was changed after the version this change was based on, the app's copy wins (nothing newer is ever overwritten).
const KINDS = ["products", "emails"];

export function createReplica({ storage }) {
  let data = { products: {}, emails: {}, settings: null, outbox: [], lastSync: 0 };
  const listeners = { products: new Set(), emails: new Set(), "settings/me": new Set() };
  let app = null, syncing = null, again = false;

  const notify = which => { for (const name of which ? [which] : Object.keys(listeners)) for (const fn of listeners[name]) fn(); };
  const persist = () => storage.set(data);
  const docs = kind => Object.entries(data[kind]).map(([id, d]) => ({ id, data: () => ({ ...d }) }));

  async function load() {
    const saved = await storage.get();
    if (saved && typeof saved === "object") data = { products: saved.products || {}, emails: saved.emails || {}, settings: saved.settings || null, outbox: Array.isArray(saved.outbox) ? saved.outbox : [], lastSync: saved.lastSync || 0 };
  }

  /** Remember a change for the app. A later change to the same item replaces the earlier one but keeps its original base. */
  function enqueue(kind, id, op, base) {
    const i = data.outbox.findIndex(o => o.kind === kind && o.id === id);
    const keepBase = i >= 0 ? data.outbox[i].base : base;
    if (i >= 0) data.outbox.splice(i, 1);
    data.outbox.push({ kind, id, op, base: keepBase, at: Date.now() });
  }

  function write(kind, id, doc) {
    const prev = data[kind][id];
    data[kind][id] = { ...doc, id };
    enqueue(kind, id, "put", prev ? prev.updatedAt || 0 : 0);
    persist(); notify(kind); kick();
  }
  function remove(kind, id) {
    const prev = data[kind][id];
    delete data[kind][id];
    enqueue(kind, id, "delete", prev ? prev.updatedAt || 0 : 0);
    persist(); notify(kind); kick();
  }
  function writeSettings(s) {
    data.settings = { ...s };
    enqueue("settings", "me", "put", 0);
    persist(); notify("settings/me"); kick();
  }

  /** Called after every local change: if the app is reachable, send it now. */
  function kick() { if (app) sync().catch(() => {}); }

  /** Send queued changes, then adopt the app's data. Safe to call often; overlapping calls are merged. */
  async function sync() {
    if (!app) return;
    if (syncing) { again = true; return syncing; }
    syncing = (async () => {
      try {
        do {
          again = false;
          let snap = await app.get("api/data");
          const remain = [];
          for (const o of [...data.outbox]) {
            if (o.kind === "settings") { await app.put("api/data/settings", data.settings || {}); continue; }
            const remote = (snap[o.kind] || []).find(x => x.id === o.id);
            if (remote && (remote.updatedAt || 0) > (o.base || 0)) continue;       // the app has something newer: it wins
            try {
              if (o.op === "delete") { if (remote) await app.del(`api/data/${o.kind}/${encodeURIComponent(o.id)}`); }
              else if (data[o.kind][o.id]) await app.put(`api/data/${o.kind}/${encodeURIComponent(o.id)}`, data[o.kind][o.id]);
            } catch (e) { remain.push(o); throw e; }
          }
          data.outbox = remain;
          snap = await app.get("api/data");
          const pending = new Set(data.outbox.map(o => `${o.kind}/${o.id}`));
          for (const kind of KINDS) {
            const next = {};
            for (const d of snap[kind] || []) if (!pending.has(`${kind}/${d.id}`)) next[d.id] = d;
            for (const id of Object.keys(data[kind])) if (pending.has(`${kind}/${id}`)) next[id] = data[kind][id];
            data[kind] = next;
          }
          if (!data.outbox.some(o => o.kind === "settings") && snap.settings && Object.keys(snap.settings).length) data.settings = snap.settings;
          data.lastSync = Date.now(); data.appVersion = snap.version;
          persist(); notify();
        } while (again);
      } finally { syncing = null; }
    })();
    return syncing;
  }

  function collection(name) {
    const q = { field: null, dir: "asc", n: Infinity };
    const api = {
      orderBy(field, dir = "asc") { q.field = field; q.dir = dir; return api; },
      limit(n) { q.n = n; return api; },
      onSnapshot(cb) {
        const fire = () => {
          const d = docs(name);
          if (q.field) d.sort((a, b) => { const x = a.data()[q.field], y = b.data()[q.field]; return (x < y ? -1 : x > y ? 1 : 0) * (q.dir === "desc" ? -1 : 1); });
          cb({ docs: d.slice(0, q.n) });
        };
        listeners[name].add(fire); fire();
        return () => listeners[name].delete(fire);
      },
    };
    return api;
  }
  function doc(path) {
    const [name, id] = path.split("/");
    if (name === "settings") return {
      set: async s => writeSettings(s),
      onSnapshot(cb) { const fire = () => cb({ exists: !!data.settings, data: () => ({ ...(data.settings || {}) }) }); listeners["settings/me"].add(fire); fire(); return () => listeners["settings/me"].delete(fire); },
    };
    if (name === "compose") return { set: async () => {} };
    return { set: async d => write(name, id, d), delete: async () => remove(name, id) };
  }

  return {
    kind: "replica", load, collection, doc, sync, initialCompose: null, stop() {},
    /** Plug in (or remove with null) a reachable app: { get, put, del } returning parsed JSON. */
    attach(a) { app = a; if (a) sync().catch(() => {}); },
    get pending() { return data.outbox.length; },
    get lastSync() { return data.lastSync; },
    get appVersion() { return data.appVersion; },
  };
}
