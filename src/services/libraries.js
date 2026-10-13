// Which library this surface shows, and how the choice is kept. Two libraries can exist side by side:
//   standalone  what this browser/extension has always kept on its own (never synced, never touched by pairing)
//   shared      a working copy of the Cold Desktop library (the desktop SQLite is authoritative); it reads and writes through the same
//               replica + version-checked protocol as always, so it also works while the app is closed and catches up afterwards
//   synced      a pairing made before shared mode existed: the standalone library kept in sync with the app (unchanged behaviour)
// Connecting makes the shared library active. Nothing is copied between libraries except by an explicit import the user confirms.
// The choice is saved with the pairing (conn.library), so web and extension use the same rule.

/**
 * @param {object} o
 * @param {{ get(): Promise<object|null>, set(c: object): Promise<void>, clear(): Promise<void> }} o.hubStore   where the pairing is kept
 * @param {object} o.link                                                                                        the hub link
 * @param {(kind: "standalone"|"shared", origin?: string) => object} o.makeReplica                                builds that library's replica
 */
export function createLibraries({ hubStore, link, makeReplica }) {
  const replicas = new Map();
  let kind = "standalone", origin = "";
  const ensure = async (k, o) => {
    const key = k === "shared" ? `shared:${o}` : "standalone";
    if (!replicas.has(key)) { const r = makeReplica(k, o); await r.load(); replicas.set(key, r); }
    return replicas.get(key);
  };
  const kindOf = conn => (!conn ? "standalone" : conn.library === "shared" ? "shared" : conn.library === "standalone" ? "standalone" : "synced");

  /** Reads the saved pairing and returns the active library: { kind, db } (db is a replica). Call once at boot. */
  async function init() {
    const conn = await hubStore.get();
    kind = kindOf(conn); origin = conn ? conn.origin : "";
    const db = await ensure(kind === "shared" ? "shared" : "standalone", origin);
    link.setReplica(kind === "standalone" ? null : db);                                     // a standalone library never syncs
    return { kind, db, conn };
  }
  async function activate(conn, library) {
    const next = { ...conn, library };
    await hubStore.set(next);
    kind = library; origin = conn.origin;
    const db = await ensure(library === "shared" ? "shared" : "standalone", origin);
    link.setReplica(library === "standalone" ? null : db);
    return { kind, db };
  }
  return {
    init,
    get kind() { return kind; },
    get db() { return replicas.get(kind === "shared" ? `shared:${origin}` : "standalone"); },
    get standalone() { return replicas.get("standalone"); },
    /** A deliberate connection: the desktop library becomes the active one. The standalone library is left exactly as it is. */
    connect: async conn => activate(conn, "shared"),
    /** Switch the active library for an existing pairing ("shared" or "standalone"). Nothing is copied or deleted. */
    use: async library => { const conn = await hubStore.get(); if (!conn) throw { message: "Connect the Cold desktop app first." }; return activate(conn, library); },
    /** Forget the pairing. Both libraries stay in storage; this surface goes back to its standalone library. */
    async disconnect() { await hubStore.clear(); kind = "standalone"; origin = ""; const db = await ensure("standalone"); link.setReplica(null); return { kind, db }; },
    /** The standalone library's contents, read-only, for the import preview. */
    async readStandalone() { return readAll(await ensure("standalone")); },
  };
}

/** Everything in a replica as plain records, without changing it. */
export function readAll(db) {
  const get = name => { let docs = []; const off = db.collection(name).onSnapshot(s => { docs = s.docs.map(d => ({ ...d.data(), id: d.id })); }); off(); return docs; };
  return { products: get("products"), emails: get("emails"), leads: get("leads") };
}
