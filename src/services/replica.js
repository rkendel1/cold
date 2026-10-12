// A local copy of your products and drafts that works with nothing else running. Whenever the Cold desktop app (the "hub") is
// reachable it sends what you changed here and takes what changed there, and it retries after outages. Used by the web app and
// the browser extension; the desktop app talks to its own database directly. Same collection/doc/onSnapshot interface as the other
// stores, so the store and every view are unchanged.
//
// Sync rules: the hub is the source of truth. Local changes wait in an "outbox", each remembering the version (and copy) it was
// based on. If the hub's copy changed after that version, a change to DIFFERENT fields is merged; a change to the SAME field keeps
// the hub's copy and puts this one in `conflicts` (kept, not discarded) for the user to review. Nothing newer is ever overwritten,
// and every write to the hub names the version it saw, so the hub also refuses a write that raced with another one.
// Deleting happens at the hub and is copied here.
import { versionOf, nextVersion, applySave, saveWithMerge } from "../domain/library.js";
import { queryCollection } from "./collection.js";

const KINDS = ["products", "emails"];
const MAX_CONFLICTS = 50;

/** @param {{ storage: { get(): Promise<object|null>, set(data: object): Promise<void> } }} opts */
export function createReplica({ storage, keepCompose = false, pushLocalFirst = true }) {
  let data = { products: {}, emails: {}, settings: null, outbox: [], lastSync: 0, conflicts: [] };
  let extra = { warnings: [], compose: undefined };
  const listeners = { products: new Set(), emails: new Set(), "settings/me": new Set() };
  let app = null, syncing = null, again = false;

  const notify = which => { for (const name of which ? [which] : Object.keys(listeners)) for (const fn of listeners[name]) fn(); };
  const docs = kind => Object.entries(data[kind]).map(([id, d]) => ({ id, data: () => ({ ...d }) }));
  const snapshot = () => JSON.parse(JSON.stringify(data));
  const payload = () => (keepCompose ? { ...data, compose: extra.compose } : data);

  const adopt = saved => {
    data = { products: saved.products || {}, emails: saved.emails || {}, settings: saved.settings || null, outbox: Array.isArray(saved.outbox) ? saved.outbox : [], lastSync: saved.lastSync || 0, appVersion: saved.appVersion, conflicts: Array.isArray(saved.conflicts) ? saved.conflicts : [] };
  };
  async function load() {
    const saved = await storage.get();
    if (saved && typeof saved === "object") { adopt(saved); extra = { warnings: saved.warnings || [], compose: saved.compose }; }
  }

  /** Remember a change for the hub. A later change to the same item replaces the earlier one but keeps its original base. */
  function enqueue(kind, id, op, base, baseDoc) {
    const i = data.outbox.findIndex(o => o.kind === kind && o.id === id);
    const keep = i >= 0 ? data.outbox[i] : null;
    if (i >= 0) data.outbox.splice(i, 1);
    data.outbox.push({ kind, id, op, base: keep ? keep.base : base, baseDoc: keep ? keep.baseDoc : baseDoc, at: Date.now() });
  }
  const keepConflict = c => { data.conflicts = [...data.conflicts.filter(x => !(x.kind === c.kind && x.id === c.id)), { ...c, at: Date.now() }].slice(-MAX_CONFLICTS); };

  /**
   * Apply a change, save it, and undo it (and say so) if it can't be saved. Never reports a save that didn't happen.
   * Changes run one at a time, each starting from what storage holds NOW, so a copy held by another panel or tab (or a sync) that
   * is older than what was saved can't write the whole list back over it.
   */
  let chain = Promise.resolve();
  function commit(which, mutate) {
    const run = chain.catch(() => {}).then(async () => {
      const saved = await storage.get();
      if (saved && typeof saved === "object") adopt(saved);
      const before = snapshot();
      try { mutate(); } catch (e) { data = before; notify(which); throw e; }
      notify(which);
      try { await storage.set(payload()); }
      catch (e) { data = { ...before }; notify(which); throw e; }
      kick();
    });
    chain = run;
    return run;
  }
  /** `opts.expected` (the version the caller's copy was based on) makes the write conditional, exactly like the app's database. */
  const write = (kind, id, doc, opts = {}) => commit(kind, () => {
    const prev = data[kind][id];
    let rec = { ...doc, id };
    if (opts.expected !== undefined) {
      const out = applySave({ id, mine: rec, stored: prev, expected: opts.expected, base: opts.base });
      if (!out.ok) throw out.error;
      rec = out.record;
    }
    data[kind][id] = rec;
    enqueue(kind, id, "put", versionOf(prev), prev ? JSON.parse(JSON.stringify(prev)) : undefined);
    return rec;
  }).then(() => ({ updatedAt: data[kind][id] && data[kind][id].updatedAt }));
  const remove = (kind, id) => commit(kind, () => { const prev = data[kind][id]; delete data[kind][id]; enqueue(kind, id, "delete", versionOf(prev), prev ? JSON.parse(JSON.stringify(prev)) : undefined); });
  const writeSettings = s => commit("settings/me", () => { data.settings = { ...s }; enqueue("settings", "me", "put", 0); });

  /** Called after every local change: if the hub is reachable, send it now. */
  function kick() { if (app) sync().catch(() => {}); }

  const url = (o, base) => `api/data/${o.kind}/${encodeURIComponent(o.id)}?base=${base === null ? "new" : base}`;
  const isConflict = e => !!(e && e.status === 409 && e.body && e.body.current);

  /**
   * Send one queued change, naming the hub version it is based on so the hub refuses it if that moved. If the hub's copy changed
   * since this edit began, merge when the changes are to different fields; otherwise keep the hub's copy and set this edit aside
   * in `conflicts`. Network failures throw (the change stays queued); conflicts never lose the local copy.
   */
  async function push(o, remote) {
    if (o.op === "delete") {
      if (!remote) return;
      if (versionOf(remote) > o.base) { keepConflict({ kind: o.kind, id: o.id, fields: ["(deleted here, changed there)"], mine: o.baseDoc || null, theirs: remote }); return; }
      try { await app.del(url(o, versionOf(remote))); } catch (e) { if (!isConflict(e)) throw e; keepConflict({ kind: o.kind, id: o.id, fields: ["(deleted here, changed there)"], mine: o.baseDoc || null, theirs: e.body.current }); }
      return;
    }
    const mine = data[o.kind][o.id];
    if (!mine) return;                                                               // removed again before it was sent
    const r = await saveWithMerge({
      send: (body, exp) => app.put(url(o, exp), body), conflictOf: e => (isConflict(e) ? e.body.current : null),
      base: o.baseDoc, mine, expected: remote ? versionOf(remote) : null,
      current: remote && versionOf(remote) > o.base ? remote : null,                 // the hub moved on after this edit began: merge first
    });
    if (!r.ok) keepConflict({ kind: o.kind, id: o.id, fields: r.error.conflicts, mine, theirs: r.error.current });
  }

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
          if (pushLocalFirst && !data.lastSync) for (const kind of KINDS) for (const [id, d] of Object.entries(data[kind])) if (!data.outbox.some(o => o.kind === kind && o.id === id)) enqueue(kind, id, "put", d.updatedAt || 0);
          const done = new Set();
          try {
            for (const o of [...data.outbox]) {
              if (o.kind === "settings") { await app.put("api/data/settings", data.settings || {}); done.add(o); continue; }
              await push(o, (snap[o.kind] || []).find(x => x.id === o.id) || null);
              done.add(o);
            }
          } finally { data.outbox = data.outbox.filter(o => !done.has(o)); }   // keeps changes made while this ran, and those not yet sent
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

  const collection = name => queryCollection(listeners[name], () => docs(name));
  function doc(path) {
    const [name, id] = path.split("/");
    if (name === "settings") return {
      set: async s => writeSettings(s),
      onSnapshot(cb) { const fire = () => cb({ exists: !!data.settings, data: () => ({ ...(data.settings || {}) }) }); listeners["settings/me"].add(fire); fire(); return () => listeners["settings/me"].delete(fire); },
    };
    if (name === "compose") return { set: async () => {} };
    return { set: (d, opts) => write(name, id, d, opts), delete: () => remove(name, id) };
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
    /** Edits made here that could not be merged with a newer change at the app: { kind, id, fields, mine, theirs, at }. The app's copy was kept. */
    get conflicts() { return data.conflicts.slice(); },
    /** Dismiss a set-aside edit, or (restore) put it back as a deliberate new edit on top of the app's current copy. */
    async resolveConflict(kind, id, { restore = false } = {}) {
      const c = data.conflicts.find(x => x.kind === kind && x.id === id); if (!c) return;
      await commit(kind, () => {
        data.conflicts = data.conflicts.filter(x => !(x.kind === kind && x.id === id));   // by key: the commit re-read storage
        if (restore && c.mine) { const prev = data[kind][id]; data[kind][id] = { ...c.mine, id, updatedAt: nextVersion(prev) }; enqueue(kind, id, "put", versionOf(prev), prev ? JSON.parse(JSON.stringify(prev)) : undefined); }
      });
    },
    get lastSync() { return data.lastSync; },
    get appVersion() { return data.appVersion; },
  };
}
