// A local copy of your products and drafts that works with nothing else running. Whenever the Cold desktop app (the "hub") is
// reachable it sends what you changed here and takes what changed there, and it retries after outages. Used by the web app and
// the browser extension; the desktop app talks to its own database directly. Same collection/doc/onSnapshot interface as the other
// stores, so the store and every view are unchanged.
//
// Sync rules: the hub is the source of truth. Local changes wait in an "outbox"; if the hub's copy changed after the version a
// change was based on, the hub's newer copy wins (nothing newer is ever overwritten). Deleting happens at the hub and is copied here.
const KINDS = ["products", "emails"];

/** @param {{ storage: { get(): Promise<object|null>, set(data: object): Promise<void> } }} opts */
export function createReplica({ storage, keepCompose = false }) {
  let data = { products: {}, emails: {}, settings: null, outbox: [], lastSync: 0 };
  let extra = { warnings: [], compose: undefined };
  const listeners = { products: new Set(), emails: new Set(), "settings/me": new Set() };
  let app = null, syncing = null, again = false;

  const notify = which => { for (const name of which ? [which] : Object.keys(listeners)) for (const fn of listeners[name]) fn(); };
  const docs = kind => Object.entries(data[kind]).map(([id, d]) => ({ id, data: () => ({ ...d }) }));
  const snapshot = () => JSON.parse(JSON.stringify(data));
  const payload = () => (keepCompose ? { ...data, compose: extra.compose } : data);

  async function load() {
    const saved = await storage.get();
    if (saved && typeof saved === "object") {
      data = { products: saved.products || {}, emails: saved.emails || {}, settings: saved.settings || null, outbox: Array.isArray(saved.outbox) ? saved.outbox : [], lastSync: saved.lastSync || 0, appVersion: saved.appVersion };
      extra = { warnings: saved.warnings || [], compose: saved.compose };
    }
  }

  /** Remember a change for the hub. A later change to the same item replaces the earlier one but keeps its original base. */
  function enqueue(kind, id, op, base) {
    const i = data.outbox.findIndex(o => o.kind === kind && o.id === id);
    const keepBase = i >= 0 ? data.outbox[i].base : base;
    if (i >= 0) data.outbox.splice(i, 1);
    data.outbox.push({ kind, id, op, base: keepBase, at: Date.now() });
  }

  /** Apply a change, save it, and undo it (and say so) if it can't be saved. Never reports a save that didn't happen. */
  async function commit(which, mutate) {
    const before = snapshot();
    mutate(); notify(which);
    try { await storage.set(payload()); }
    catch (e) { data = { ...before }; notify(which); throw e; }
    kick();
  }
  const write = (kind, id, doc) => commit(kind, () => { const prev = data[kind][id]; data[kind][id] = { ...doc, id }; enqueue(kind, id, "put", prev ? prev.updatedAt || 0 : 0); });
  const remove = (kind, id) => commit(kind, () => { const prev = data[kind][id]; delete data[kind][id]; enqueue(kind, id, "delete", prev ? prev.updatedAt || 0 : 0); });
  const writeSettings = s => commit("settings/me", () => { data.settings = { ...s }; enqueue("settings", "me", "put", 0); });

  /** Called after every local change: if the hub is reachable, send it now. */
  function kick() { if (app) sync().catch(() => {}); }

  /** Send queued changes, then adopt the hub's data. Safe to call often; overlapping calls are merged. */
  async function sync() {
    if (!app) return;
    if (syncing) { again = true; return syncing; }
    syncing = (async () => {
      try {
        do {
          again = false;
          let snap = await app.get("api/data");
          // First contact: everything that exists only here is new to the hub. Offer it all; the newer copy of anything in both wins.
          if (!data.lastSync) for (const kind of KINDS) for (const [id, d] of Object.entries(data[kind])) if (!data.outbox.some(o => o.kind === kind && o.id === id)) enqueue(kind, id, "put", d.updatedAt || 0);
          const remain = [];
          for (const o of [...data.outbox]) {
            if (o.kind === "settings") { await app.put("api/data/settings", data.settings || {}); continue; }
            const remote = (snap[o.kind] || []).find(x => x.id === o.id);
            if (remote && (remote.updatedAt || 0) > (o.base || 0)) continue;       // the hub has something newer: it wins
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
          await storage.set(payload()); notify();
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
    return { set: d => write(name, id, d), delete: () => remove(name, id) };
  }

  return {
    kind: "replica", load, collection, doc, sync, stop() {},
    /** The half-written Write form, kept across reopening the panel. Only for stores that opt in (the extension). */
    ...(keepCompose ? { saveCompose(form) { extra.compose = form; return storage.set(payload()).catch(() => {}); } } : {}),
    get initialCompose() { return extra.compose; },
    get warnings() { return extra.warnings; },
    /** Plug in (or remove with null) a reachable hub: { get, put, del } returning parsed JSON. */
    attach(a) { app = a; if (a) sync().catch(() => {}); },
    get pending() { return data.outbox.length; },
    get lastSync() { return data.lastSync; },
    get appVersion() { return data.appVersion; },
  };
}
