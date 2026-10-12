// SQLite storage for products, drafts and app state (node:sqlite, built into Node 22.13+ and Electron).
// Documents keep their full JSON in `data` (so the tolerant normalisers in the app still apply) and the fields people
// filter or search by are also real columns, so the file is useful to other tools: `sqlite3 cold.db "select * from emails"`.
const fs = require("node:fs");
const path = require("node:path");

const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const KINDS = { products: "products", emails: "emails" };
const META_DOCS = new Set(["settings", "compose"]);
const MAX_DOC = 512 * 1024;

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

  const q = {
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    delMeta: db.prepare("DELETE FROM meta WHERE key = ?"),
    putProduct: db.prepare("INSERT INTO products(id, name, position, data, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, position=excluded.position, data=excluded.data, updated_at=excluded.updated_at"),
    putEmail: db.prepare("INSERT INTO emails(id, created_at, status, mode, product_id, recipient_name, recipient_company, subject, data, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, status=excluded.status, mode=excluded.mode, product_id=excluded.product_id, recipient_name=excluded.recipient_name, recipient_company=excluded.recipient_company, subject=excluded.subject, data=excluded.data, updated_at=excluded.updated_at"),
    delProduct: db.prepare("DELETE FROM products WHERE id = ?"),
    delEmail: db.prepare("DELETE FROM emails WHERE id = ?"),
    products: db.prepare("SELECT id, data FROM products ORDER BY position, name"),
    emails: db.prepare("SELECT id, data FROM emails ORDER BY created_at DESC LIMIT 5000"),
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
    else {
      const r = doc.recipient && typeof doc.recipient === "object" ? doc.recipient : {};
      q.putEmail.run(id, num(doc.createdAt, now), text(doc.status) || "draft", text(doc.mode) || "email", text(doc.productId), text(r.name), text(r.company), text(doc.subject), json, num(doc.updatedAt, now));
    }
  }
  const parse = rows => rows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);

  return {
    file,
    get version() { return version; },
    close() { db.close(); },
    snapshot() {
      return { version, migrated: meta("migrated") === "1", products: parse(q.products.all()), emails: parse(q.emails.all()), settings: metaJson("settings", {}), compose: metaJson("compose", null) };
    },
    put(kind, id, doc) { check(kind, id, doc); tx(() => { write(kind, id, doc); bump(); }); },
    remove(kind, id) { check(kind, id, {}); tx(() => { (kind === "products" ? q.delProduct : q.delEmail).run(id); bump(); }); },
    putMeta(name, doc) {
      if (!META_DOCS.has(name)) throw Object.assign(new Error("Unknown document."), { status: 404 });
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw Object.assign(new Error("Body must be an object."), { status: 400 });
      tx(() => { q.setMeta.run(name, JSON.stringify(doc)); if (name === "settings") bump(); });   // compose is scratch space: it must not make other windows reload
    },
    /** One-time import of browser data. Only runs while the database is empty and has never been imported into. */
    importOnce(payload) {
      return tx(() => {
        if (meta("migrated") === "1") return { imported: false, products: 0, emails: 0 };
        let products = 0, emails = 0;
        if (q.count("products") === 0 && q.count("emails") === 0) {
          for (const p of Array.isArray(payload.products) ? payload.products : []) if (p && ID.test(p.id || "")) { write("products", p.id, p); products++; }
          for (const e of Array.isArray(payload.emails) ? payload.emails : []) if (e && ID.test(e.id || "")) { write("emails", e.id, e); emails++; }
          if (payload.settings && typeof payload.settings === "object") q.setMeta.run("settings", JSON.stringify(payload.settings));
          if (payload.compose && typeof payload.compose === "object") q.setMeta.run("compose", JSON.stringify(payload.compose));
        }
        q.setMeta.run("migrated", "1"); bump();
        return { imported: products + emails > 0, products, emails };
      });
    },
    /** Pairing token for the browser extension. Created on first use; `rotate` replaces it. */
    extensionToken(rotate = false) {
      let t = meta("extension_token");
      if (!t || rotate) { t = require("node:crypto").randomBytes(24).toString("base64url"); q.setMeta.run("extension_token", t); }
      return t;
    },
    peekExtensionToken() { return meta("extension_token"); },
  };
}

module.exports = { createDb, ID };
