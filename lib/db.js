// SQLite storage for products, drafts and app state (node:sqlite, built into Node 22.13+ and Electron).
// Documents keep their full JSON in `data` (so the tolerant normalisers in the app still apply) and the fields people
// filter or search by are also real columns, so the file is useful to other tools: `sqlite3 cold.db "select * from emails"`.
const fs = require("node:fs");
const path = require("node:path");

const { versionOf, nextVersion, isStale, compareEmails, compareProducts, compareLeads } = require("./library-rules.cjs");

const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const KINDS = { products: "products", emails: "emails", leads: "leads" };
const META_DOCS = new Set(["settings", "compose"]);
const MAX_DOC = 512 * 1024;

/** "https://cold.example.com/" -> "https://cold.example.com"; anything that isn't a plain http(s) origin -> null. */
function normalizeWebOrigin(input) {
  let u; try { u = new URL(String(input || "").trim()); } catch { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/") || /[*\s]/.test(String(input))) return null;
  return u.origin;
}

function createDb(file) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); }
  catch { throw new Error("SQLite storage needs Node 22.13 or newer (or the Cold desktop app)."); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;");

  const v = db.prepare("PRAGMA user_version").get().user_version;
  if (v < 1) db.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0,
      data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE emails (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', mode TEXT NOT NULL DEFAULT 'email',
      product_id TEXT NOT NULL DEFAULT '', recipient_name TEXT NOT NULL DEFAULT '', recipient_company TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX emails_created ON emails(created_at DESC);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 1;`);
  // Version 2: the leads list. Added in place; nothing existing is touched. The columns are the ones people search and edit by
  // (`sqlite3 cold.db "select name, company, email, list from leads"`); the JSON in `data` is the record.
  if (v < 2) db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
      list TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS leads_list ON leads(list);
    PRAGMA user_version = 2;`);

  const q = {
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    delMeta: db.prepare("DELETE FROM meta WHERE key = ?"),
    putProduct: db.prepare("INSERT INTO products(id, name, position, data, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, position=excluded.position, data=excluded.data, updated_at=excluded.updated_at"),
    putEmail: db.prepare("INSERT INTO emails(id, created_at, status, mode, product_id, recipient_name, recipient_company, subject, data, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, status=excluded.status, mode=excluded.mode, product_id=excluded.product_id, recipient_name=excluded.recipient_name, recipient_company=excluded.recipient_company, subject=excluded.subject, data=excluded.data, updated_at=excluded.updated_at"),
    putLead: db.prepare("INSERT INTO leads(id, name, company, email, list, created_at, data, updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, company=excluded.company, email=excluded.email, list=excluded.list, created_at=excluded.created_at, data=excluded.data, updated_at=excluded.updated_at"),
    getLead: db.prepare("SELECT data FROM leads WHERE id = ?"),
    delLead: db.prepare("DELETE FROM leads WHERE id = ?"),
    leads: db.prepare("SELECT id, name, company, email, list, data FROM leads"),
    getProduct: db.prepare("SELECT data FROM products WHERE id = ?"),
    getEmail: db.prepare("SELECT data FROM emails WHERE id = ?"),
    delProduct: db.prepare("DELETE FROM products WHERE id = ?"),
    delEmail: db.prepare("DELETE FROM emails WHERE id = ?"),
    products: db.prepare("SELECT id, data FROM products"),
    emails: db.prepare("SELECT id, data FROM emails"),
    count: t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n,
  };

  const meta = key => { const r = q.getMeta.get(key); return r ? r.value : null; };
  const metaJson = (key, fallback) => { try { const m = meta(key); return m == null ? fallback : JSON.parse(m); } catch { return fallback; } };
  let version = parseInt(meta("version") || "0", 10) || 0;
  const bump = () => { version++; q.setMeta.run("version", String(version)); };
  const tx = fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  const num = (x, d = 0) => (Number.isFinite(x) ? x : d);
  const text = x => (typeof x === "string" ? x : "");

  function check(kind, id, doc) {
    if (!KINDS[kind]) throw Object.assign(new Error("Unknown collection."), { status: 404 });
    if (!ID.test(id || "")) throw Object.assign(new Error("Invalid id."), { status: 400 });
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw Object.assign(new Error("Body must be an object."), { status: 400 });
    if (JSON.stringify(doc).length > MAX_DOC) throw Object.assign(new Error("Document too large."), { status: 413 });
  }
  function write(kind, id, doc) {
    const json = JSON.stringify({ ...doc, id }), now = Date.now();
    if (kind === "products") q.putProduct.run(id, text(doc.name), num(doc.order), json, num(doc.updatedAt, now));
    else if (kind === "leads") q.putLead.run(id, text(doc.name), text(doc.company), text(doc.email), text(doc.list), num(doc.createdAt, now), json, num(doc.updatedAt, now));
    else {
      const r = doc.recipient && typeof doc.recipient === "object" ? doc.recipient : {};
      q.putEmail.run(id, num(doc.createdAt, now), text(doc.status) || "draft", text(doc.mode) || "email", text(doc.productId), text(r.name), text(r.company), text(doc.subject), json, num(doc.updatedAt, now));
    }
  }
  const stored = (kind, id) => { const r = (kind === "products" ? q.getProduct : kind === "leads" ? q.getLead : q.getEmail).get(id); try { return r ? JSON.parse(r.data) : null; } catch { return null; } };
  /**
   * Optimistic concurrency. `base` is the version (updatedAt) the caller's copy was based on, or "new" for a record it believes
   * doesn't exist yet; undefined means an unconditional write (older clients). A mismatch throws a 409 carrying the stored record.
   */
  function expect(kind, id, base) {
    const cur = base === undefined ? null : stored(kind, id);
    if (isStale(cur, base)) throw Object.assign(new Error("This was changed somewhere else. Nothing was overwritten."), { status: 409, code: "conflict", current: cur });
    return cur;
  }
  /** Leads as stored, except that the searchable columns win over the JSON: a name, company, email or list fixed with a SQLite tool is what Cold shows. */
  // A row whose JSON can't be read is never deleted or rewritten here: it is left in the file, left out of what is returned, and COUNTED, so the app can tell the
  // person (see `unreadable` in snapshot()). Its contents are never put in a message.
  const plain = v => !!v && typeof v === "object" && !Array.isArray(v);
  const readRows = (rows, shape = x => x) => {
    const items = []; let unreadable = 0;
    for (const r of rows) { let v = null; try { v = JSON.parse(r.data); } catch { /* counted below */ } if (plain(v)) items.push(shape(v, r)); else unreadable++; }
    return { items, unreadable };
  };
  const leadShape = (v, r) => ({ ...v, id: r.id, name: r.name, company: r.company, email: r.email, list: r.list });

  return {
    file,
    get version() { return version; },
    close() { db.close(); },
    snapshot() {
      const products = readRows(q.products.all()), emails = readRows(q.emails.all()), leads = readRows(q.leads.all(), leadShape);
      return { version, migrated: meta("migrated") === "1", products: products.items.sort(compareProducts), emails: emails.items.sort(compareEmails).slice(0, 5000), leads: leads.items.sort(compareLeads), settings: metaJson("settings", {}), compose: metaJson("compose", null),
        unreadable: { products: products.unreadable, emails: emails.unreadable, leads: leads.unreadable } };
    },
    /** Returns the stored `updatedAt`. With `base`, the write only happens if the stored record is still at that version. */
    put(kind, id, doc, { base } = {}) {
      check(kind, id, doc);
      return tx(() => {
        const cur = expect(kind, id, base);
        // A conditional write is versioned strictly after whatever was stored, so the next writer can tell it apart. A sender that already
        // stamped a newer version (the replica does, domain/library.js nextVersion) keeps it, so the same record carries the same
        // version on every surface instead of being renumbered here.
        const asked = num(doc.updatedAt, 0);
        const updatedAt = base === undefined ? num(doc.updatedAt, Date.now()) : asked > versionOf(cur) ? asked : nextVersion(cur);
        write(kind, id, { ...doc, updatedAt }); bump();
        return { updatedAt };
      });
    },
    remove(kind, id, { base } = {}) { check(kind, id, {}); tx(() => { if (base !== undefined && base !== "new") expect(kind, id, base); (kind === "products" ? q.delProduct : kind === "leads" ? q.delLead : q.delEmail).run(id); bump(); }); },
    putMeta(name, doc) {
      if (!META_DOCS.has(name)) throw Object.assign(new Error("Unknown document."), { status: 404 });
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw Object.assign(new Error("Body must be an object."), { status: 400 });
      tx(() => { q.setMeta.run(name, JSON.stringify(doc)); if (name === "settings") bump(); });   // compose is scratch space: it must not make other windows reload
    },
    /** One-time import of browser data. Only runs while the database is empty and has never been imported into. */
    importOnce(payload) {
      return tx(() => {
        if (meta("migrated") === "1") return { imported: false, products: 0, emails: 0, leads: 0 };
        let products = 0, emails = 0, leads = 0;
        if (q.count("products") === 0 && q.count("emails") === 0 && q.count("leads") === 0) {
          for (const p of Array.isArray(payload.products) ? payload.products : []) if (p && ID.test(p.id || "")) { write("products", p.id, p); products++; }
          for (const e of Array.isArray(payload.emails) ? payload.emails : []) if (e && ID.test(e.id || "")) { write("emails", e.id, e); emails++; }
          for (const l of Array.isArray(payload.leads) ? payload.leads : []) if (l && ID.test(l.id || "")) { write("leads", l.id, l); leads++; }
          if (payload.settings && typeof payload.settings === "object") q.setMeta.run("settings", JSON.stringify(payload.settings));
          if (payload.compose && typeof payload.compose === "object") q.setMeta.run("compose", JSON.stringify(payload.compose));
        }
        q.setMeta.run("migrated", "1"); bump();
        return { imported: products + emails + leads > 0, products, emails, leads };
      });
    },
    /** Pairing token for the browser extension. Created on first use; `rotate` replaces it. */
    extensionToken(rotate = false) {
      let t = meta("extension_token");
      if (!t || rotate) { t = require("node:crypto").randomBytes(24).toString("base64url"); q.setMeta.run("extension_token", t); }
      return t;
    },
    peekExtensionToken() { return meta("extension_token"); },
    /** Web pages (other than the extension) that may sync with this app once they hold the pairing code. Managed in the app's Settings. */
    webOrigins() { return metaJson("web_origins", []).filter(o => normalizeWebOrigin(o) === o); },
    setWebOrigins(list) {
      const clean = [...new Set((Array.isArray(list) ? list : []).map(normalizeWebOrigin))];
      if (clean.includes(null) || clean.length > 10) throw Object.assign(new Error("Each entry must be a web address like https://cold.example.com (no path, no wildcards); up to 10."), { status: 400 });
      tx(() => q.setMeta.run("web_origins", JSON.stringify(clean)));
      return clean;
    },
  };
}

module.exports = { createDb, ID, normalizeWebOrigin };
