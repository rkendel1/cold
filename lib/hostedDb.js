// Hosted libraries: the same records as the desktop database (products, drafts, leads, settings), one library per Cold account, in one SQLite file
// (node:sqlite, as lib/db.js). Every row carries the owning account's id and EVERY statement here filters on it, so an id supplied by a client can only ever
// name a row inside the caller's own library: two accounts can even use the same record id without touching each other.
// The account id comes from the server-side session (lib/auth.js). Nothing in this file reads it from a request.
// Records keep their full JSON in `data`, as in lib/db.js, so supported and unknown fields are preserved; the searchable fields are also real columns.
const fs = require("node:fs");
const path = require("node:path");
const { ID } = require("./db");
const { versionOf, nextVersion, isStale, compareEmails, compareProducts, compareLeads } = require("./library-rules.cjs");

const KINDS = new Set(["products", "emails", "leads"]);
const META_DOCS = new Set(["settings"]);                                      // the Write form ("compose") is device state and is never stored here
const SETTINGS_KEYS = ["signature", "signoffProduct", "followUp"];             // the rest of Settings (email app, accounts, provider, keys) stays on the device
const MAX_DOC = 512 * 1024;
const MAX_PER_KIND = 50000;
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// What a hosted record may not carry: a client-named owner (ownership is the session's, never the record's) and anything credential-like (those stay on the device).
const OWNER_KEY = /^(account|account_?id|owner|owner_?id|user|user_?id|tenant)$/i;
const SECRET_KEY = /api[-_]?key|secret|token|passw|authorization|bearer|credential/i;
const FIELD_TYPES = {
  products: { name: "string" },
  emails: { createdAt: "number", status: "string", recipient: "object", handoffs: "array", followUp: "object", note: "string", subject: "string", what: "string", why: "string", ask: "string", sentAt: "number", repliedAt: "number", sentCopy: "object" },
  leads: { name: "string", company: "string", email: "string", list: "string", custom: "object", createdAt: "number" },
};
const typeOf = v => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
function scan(v, depth = 0) {
  if (depth > 12) throw httpError(400, "That record is nested too deeply.", { code: "bad_record" });
  if (Array.isArray(v)) { for (const x of v) scan(x, depth + 1); return; }
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") throw httpError(400, "That record has a field name that isn't allowed.", { code: "bad_record" });
    if (depth === 0 && OWNER_KEY.test(k)) throw httpError(400, `Records can't name an owner (“${k}”): ownership comes from your sign-in.`, { code: "bad_record" });
    if (SECRET_KEY.test(k)) throw httpError(400, `Records can't hold credentials (“${k}”). Keys and tokens stay on your device.`, { code: "bad_record" });
    scan(x, depth + 1);
  }
}
/** Shape rules, the same as the app's own record checks (src/domain/dataExport.js). Unknown extra fields are kept, as locally; malformed known fields are refused. */
function validate(kind, id, doc) {
  scan(doc);
  if (doc.id !== undefined && doc.id !== id) throw httpError(400, "The record's id doesn't match its address.", { code: "bad_record" });
  for (const [f, t] of Object.entries(FIELD_TYPES[kind])) if (doc[f] !== undefined && typeOf(doc[f]) !== t && !(t === "object" && doc[f] === null)) throw httpError(400, `“${f}” should be ${t === "array" ? "a list" : t === "object" ? "an object" : `a ${t}`}.`, { code: "bad_record" });
  if ((kind === "products" || kind === "leads") && (typeof doc.name !== "string" || !doc.name.trim())) throw httpError(400, "A name is required.", { code: "bad_record" });
  if (kind === "emails" && doc.recipient === undefined && !(doc.mode && doc.mode !== "email")) throw httpError(400, "A draft needs a recipient.", { code: "bad_record" });
}

function openHostedDb(file) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch { throw new Error("Hosted libraries need Node 22.13 or newer."); }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");

  // Migrations: each step runs once, in one transaction, and records itself in user_version, so starting twice (or two processes starting at once) is safe.
  const MIGRATIONS = [
    `CREATE TABLE libraries (account_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0);
     CREATE TABLE products (account_id TEXT NOT NULL REFERENCES libraries(account_id), id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0, data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, id));
     CREATE TABLE emails (account_id TEXT NOT NULL REFERENCES libraries(account_id), id TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', mode TEXT NOT NULL DEFAULT 'email', product_id TEXT NOT NULL DEFAULT '', recipient_name TEXT NOT NULL DEFAULT '', recipient_company TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, id));
     CREATE TABLE leads (account_id TEXT NOT NULL REFERENCES libraries(account_id), id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', list TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, id));
     CREATE TABLE meta (account_id TEXT NOT NULL REFERENCES libraries(account_id), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (account_id, key));
     CREATE INDEX emails_account_created ON emails(account_id, created_at DESC);`,
  ];
  db.exec("BEGIN IMMEDIATE");
  try {
    let v = db.prepare("PRAGMA user_version").get().user_version;
    if (v > MIGRATIONS.length) throw new Error("This hosted database was made by a newer Cold. Update Cold; nothing was changed.");
    for (; v < MIGRATIONS.length; v++) { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); }
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* nothing open */ } db.close(); throw e; }

  const tables = { products: "products", emails: "emails", leads: "leads" };
  const q = {
    lib: db.prepare("SELECT created_at, version FROM libraries WHERE account_id = ?"),
    newLib: db.prepare("INSERT OR IGNORE INTO libraries(account_id, created_at, version) VALUES (?, ?, 0)"),
    bump: db.prepare("UPDATE libraries SET version = version + 1 WHERE account_id = ?"),
    getMeta: db.prepare("SELECT value FROM meta WHERE account_id = ? AND key = ?"),
    setMeta: db.prepare("INSERT INTO meta(account_id, key, value) VALUES (?,?,?) ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value"),
    putProduct: db.prepare("INSERT INTO products(account_id, id, name, position, data, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id, id) DO UPDATE SET name=excluded.name, position=excluded.position, data=excluded.data, updated_at=excluded.updated_at"),
    putLead: db.prepare("INSERT INTO leads(account_id, id, name, company, email, list, created_at, data, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id, id) DO UPDATE SET name=excluded.name, company=excluded.company, email=excluded.email, list=excluded.list, created_at=excluded.created_at, data=excluded.data, updated_at=excluded.updated_at"),
    putEmail: db.prepare("INSERT INTO emails(account_id, id, created_at, status, mode, product_id, recipient_name, recipient_company, subject, data, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id, id) DO UPDATE SET created_at=excluded.created_at, status=excluded.status, mode=excluded.mode, product_id=excluded.product_id, recipient_name=excluded.recipient_name, recipient_company=excluded.recipient_company, subject=excluded.subject, data=excluded.data, updated_at=excluded.updated_at"),
    get: Object.fromEntries(Object.keys(tables).map(k => [k, db.prepare(`SELECT data FROM ${k} WHERE account_id = ? AND id = ?`)])),
    del: Object.fromEntries(Object.keys(tables).map(k => [k, db.prepare(`DELETE FROM ${k} WHERE account_id = ? AND id = ?`)])),
    count: Object.fromEntries(Object.keys(tables).map(k => [k, db.prepare(`SELECT COUNT(*) AS n FROM ${k} WHERE account_id = ?`)])),
    all: { products: db.prepare("SELECT id, data FROM products WHERE account_id = ?"), emails: db.prepare("SELECT id, data FROM emails WHERE account_id = ?"),
      leads: db.prepare("SELECT id, name, company, email, list, data FROM leads WHERE account_id = ?") },
    has: Object.fromEntries(Object.keys(tables).map(k => [k, db.prepare(`SELECT 1 AS x FROM ${k} WHERE account_id = ? AND id = ?`)])),
  };
  const tx = fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; } };
  const num = (x, d = 0) => (Number.isFinite(x) ? x : d);
  const text = x => (typeof x === "string" ? x : "");
  const plain = v => !!v && typeof v === "object" && !Array.isArray(v);
  const needLib = account => { const l = q.lib.get(account); if (!l) throw httpError(404, "You haven't created a hosted library yet.", { code: "no_library" }); return l; };
  const stored = (kind, account, id) => { const r = q.get[kind].get(account, id); try { return r ? JSON.parse(r.data) : null; } catch { return null; } };
  const readRows = (rows, shape = x => x) => { const items = []; let unreadable = 0; for (const r of rows) { let v = null; try { v = JSON.parse(r.data); } catch { /* counted */ } if (plain(v)) items.push(shape(v, r)); else unreadable++; } return { items, unreadable }; };

  function check(kind, id, doc) {
    if (!KINDS.has(kind)) throw httpError(404, "Unknown collection.");
    if (typeof id !== "string" || !ID.test(id)) throw httpError(400, "Invalid id.");
    if (!plain(doc)) throw httpError(400, "Body must be an object.");
    if (JSON.stringify(doc).length > MAX_DOC) throw httpError(413, "Document too large.");
    if (Object.keys(doc).length) validate(kind, id, doc);
  }
  function write(kind, account, id, doc) {
    const json = JSON.stringify({ ...doc, id }), now = Date.now();
    if (kind === "products") q.putProduct.run(account, id, text(doc.name), num(doc.order), json, num(doc.updatedAt, now));
    else if (kind === "leads") q.putLead.run(account, id, text(doc.name), text(doc.company), text(doc.email), text(doc.list), num(doc.createdAt, now), json, num(doc.updatedAt, now));
    else { const r = plain(doc.recipient) ? doc.recipient : {}; q.putEmail.run(account, id, num(doc.createdAt, now), text(doc.status) || "draft", text(doc.mode) || "email", text(doc.productId), text(r.name), text(r.company), text(doc.subject), json, num(doc.updatedAt, now)); }
  }

  function snapshotIn(account) {
    const l = needLib(account), products = readRows(q.all.products.all(account)), emails = readRows(q.all.emails.all(account)),
      leads = readRows(q.all.leads.all(account), (v, r) => ({ ...v, id: r.id, name: r.name, company: r.company, email: r.email, list: r.list }));
    const meta = (k, d) => { const r = q.getMeta.get(account, k); try { return r ? JSON.parse(r.value) : d; } catch { return d; } };
    return { version: l.version, migrated: true, products: products.items.sort(compareProducts), emails: emails.items.sort(compareEmails).slice(0, 5000), leads: leads.items.sort(compareLeads), settings: meta("settings", {}), compose: null,
      unreadable: { products: products.unreadable, emails: emails.unreadable, leads: leads.unreadable } };
  }
  /** Every operation takes the account id as its first argument, from the session. There is no operation without one. */
  return {
    file,
    close() { db.close(); },
    exists: account => !!q.lib.get(account),
    /** Creating twice is harmless: the second call changes nothing. */
    create(account) { return tx(() => { const had = !!q.lib.get(account); q.newLib.run(account, Date.now()); return { created: !had }; }); },
    summary(account) { const l = q.lib.get(account); return l ? { exists: true, products: q.count.products.get(account).n, emails: q.count.emails.get(account).n, leads: q.count.leads.get(account).n } : { exists: false }; },
    version(account) { return needLib(account).version; },
    snapshot(account) {
      db.exec("BEGIN");                                                  // one read transaction: records and version come from the same moment
      try { return snapshotIn(account); } finally { try { db.exec("COMMIT"); } catch { /* nothing open */ } }
    },
    put(account, kind, id, doc, { base } = {}) {
      check(kind, id, doc);
      return tx(() => {
        needLib(account);
        const cur = base === undefined ? null : stored(kind, account, id);
        if (isStale(cur, base)) throw httpError(409, "This was changed somewhere else. Nothing was overwritten.", { code: "conflict", current: cur });
        if (!q.has[kind].get(account, id) && q.count[kind].get(account).n >= MAX_PER_KIND) throw httpError(413, "This hosted library has reached its size limit.", { code: "library_full" });
        const asked = num(doc.updatedAt, 0), updatedAt = base === undefined ? num(doc.updatedAt, Date.now()) : asked > versionOf(cur) ? asked : nextVersion(cur);
        write(kind, account, id, { ...doc, updatedAt }); q.bump.run(account);
        return { updatedAt, version: q.lib.get(account).version };
      });
    },
    remove(account, kind, id, { base } = {}) {
      check(kind, id, {});
      return tx(() => {
        needLib(account);
        if (base !== undefined && base !== "new") { const cur = stored(kind, account, id); if (isStale(cur, base)) throw httpError(409, "This was changed somewhere else. Nothing was overwritten.", { code: "conflict", current: cur }); }
        q.del[kind].run(account, id); q.bump.run(account);
        return { version: q.lib.get(account).version };
      });
    },
    putMeta(account, name, doc) {
      if (!META_DOCS.has(name)) throw httpError(404, "Unknown document.");
      if (!plain(doc)) throw httpError(400, "Body must be an object.");
      if (JSON.stringify(doc).length > MAX_DOC) throw httpError(413, "Document too large.");
      scan(doc);
      const kept = Object.fromEntries(SETTINGS_KEYS.filter(k => doc[k] !== undefined).map(k => [k, doc[k]]));   // only the library's own settings are stored
      return tx(() => { needLib(account); q.bump.run(account); q.setMeta.run(account, name, JSON.stringify(kept)); return { version: q.lib.get(account).version }; });   // the version moves and the document changes together or not at all
    },
    /** For tests and diagnostics: totals across all accounts, never content. */
    totals: () => ({ libraries: db.prepare("SELECT COUNT(*) n FROM libraries").get().n, emails: db.prepare("SELECT COUNT(*) n FROM emails").get().n }),
  };
}
module.exports = { openHostedDb, MAX_PER_KIND };
