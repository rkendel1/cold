// Cold accounts: the smallest durable record that lets future hosted data belong to someone. Three tables in one SQLite file (Node's built-in node:sqlite,
// the same engine lib/db.js uses): accounts, the Google identities that belong to them, and server-side sessions. Sign-in transactions (state, nonce, PKCE
// verifier) live here too so a callback is single-use and works whichever process receives it.
// The external identity key is Google's `sub`; an email address is only a profile attribute and is never used to find or merge accounts.
// Sessions and sign-in states are stored as keyed hashes, so reading this file does not reveal a usable session id.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createAccounts({ file, secret, now = () => Date.now() }) {
  const { DatabaseSync } = require("node:sqlite");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") { try { fs.chmodSync(file, 0o600); } catch { /* best effort: some file systems have no modes */ } }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, display_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject));
    CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sign_in (state_hash TEXT PRIMARY KEY, binder_hash TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);`);
  // Added for desktop and extension sign-in. Older files get the columns in place; existing rows keep working as 'web' sessions and sign-in states.
  const addColumn = (table, name, ddl) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } } };
  addColumn("sessions", "kind", "TEXT NOT NULL DEFAULT 'web'");
  addColumn("sign_in", "client", "TEXT NOT NULL DEFAULT 'web'");
  addColumn("sign_in", "redirect_uri", "TEXT NOT NULL DEFAULT ''");
  addColumn("sign_in", "proof_hash", "TEXT NOT NULL DEFAULT ''");

  const mac = (kind, value) => crypto.createHmac("sha256", secret).update(`${kind}:${value}`).digest("hex");
  const rand = n => crypto.randomBytes(n).toString("base64url");
  const q = {
    identity: db.prepare("SELECT account_id FROM identities WHERE provider = ? AND subject = ?"),
    newAccount: db.prepare("INSERT INTO accounts(id, created_at, display_name, email, updated_at) VALUES (?, ?, ?, ?, ?)"),
    newIdentity: db.prepare("INSERT INTO identities(provider, subject, account_id, created_at) VALUES (?, ?, ?, ?)"),
    profile: db.prepare("UPDATE accounts SET display_name = ?, email = ?, updated_at = ? WHERE id = ? AND (display_name <> ? OR email <> ?)"),
    account: db.prepare("SELECT id, display_name, email FROM accounts WHERE id = ?"),
    newSession: db.prepare("INSERT INTO sessions(id_hash, account_id, created_at, expires_at, kind) VALUES (?, ?, ?, ?, ?)"),
    session: db.prepare("SELECT s.account_id, s.expires_at, s.kind FROM sessions s WHERE s.id_hash = ?"),
    delSession: db.prepare("DELETE FROM sessions WHERE id_hash = ?"),
    purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    newTxn: db.prepare("INSERT INTO sign_in(state_hash, binder_hash, nonce, verifier, return_to, expires_at, client, redirect_uri, proof_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    txn: db.prepare("SELECT binder_hash, nonce, verifier, return_to, expires_at, client, redirect_uri, proof_hash FROM sign_in WHERE state_hash = ?"),
    delTxn: db.prepare("DELETE FROM sign_in WHERE state_hash = ?"),
    purgeTxn: db.prepare("DELETE FROM sign_in WHERE expires_at <= ?"),
  };
  const tx = fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; } };
  const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);

  return {
    /** Start a sign-in: returns the secrets the browser round trip needs. Only hashes of state and binder are kept. */
    beginSignIn({ returnTo, ttlMs }) {
      const t = now(); q.purgeTxn.run(t);
      const state = rand(24), binder = rand(24), nonce = rand(24), verifier = rand(48);
      q.newTxn.run(mac("state", state), mac("binder", binder), nonce, verifier, returnTo, t + ttlMs, "web", "", "");
      return { state, binder, nonce, verifier };
    },
    /**
     * Start a sign-in for the desktop app or the extension. There is no cookie to bind it to, so the client keeps a random `proof` and sends only its hash now;
     * completing needs the proof itself. The Google PKCE verifier and nonce stay on the server.
     */
    beginNativeSignIn({ client, redirectUri, proofHash, ttlMs }) {
      const t = now(); q.purgeTxn.run(t);
      const state = rand(24), nonce = rand(24), verifier = rand(48);
      q.newTxn.run(mac("state", state), "", nonce, verifier, "", t + ttlMs, client, redirectUri, proofHash);
      return { state, nonce, verifier };
    },
    /** Single use, like takeSignIn: the state is gone after this call whatever the outcome. Returns null unless known, unexpired, started by a native client and the proof matches. */
    takeNativeSignIn({ state, proof }) {
      if (!state || typeof state !== "string" || typeof proof !== "string" || proof.length < 32 || proof.length > 200) { if (typeof state === "string") this.discard(state); return null; }
      const key = mac("state", state);
      const row = tx(() => { const r = q.txn.get(key); q.delTxn.run(key); return r; });
      if (!row || row.client === "web" || row.expires_at <= now()) return null;
      const want = Buffer.from(row.proof_hash), got = Buffer.from(crypto.createHash("sha256").update(proof).digest("base64url"));
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
      return { nonce: row.nonce, verifier: row.verifier, redirectUri: row.redirect_uri, client: row.client };
    },
    discard(state) { if (typeof state === "string") q.delTxn.run(mac("state", state)); },
    /** Single use: the transaction is deleted whether or not it is valid. Returns null unless the state is known, unexpired and the same browser started it. */
    takeSignIn({ state, binder }) {
      if (!state || typeof state !== "string") return null;
      const key = mac("state", state);
      const row = tx(() => { const r = q.txn.get(key); q.delTxn.run(key); return r; });
      if (!row || row.expires_at <= now()) return null;
      if (row.client !== "web") return null;                                           // a desktop or extension sign-in can't be finished through the browser callback
      const want = Buffer.from(row.binder_hash), got = Buffer.from(mac("binder", String(binder || "")));
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
      return { nonce: row.nonce, verifier: row.verifier, returnTo: row.return_to };
    },
    /**
     * Find or create the account for a verified Google identity. Matching is by (provider, subject) only. Concurrent first sign-ins for one subject end
     * with one account: the write is one immediate transaction and the primary key refuses a second identity row. Profile fields are refreshed; the id never changes.
     */
    resolveAccount({ provider = "google", subject, name, email }) {
      if (!subject || typeof subject !== "string") throw new Error("missing subject");
      const display = clean(name, 120), mail = clean(email, 254), t = now();
      return tx(() => {
        let row = q.identity.get(provider, subject), id;
        if (row) { id = row.account_id; q.profile.run(display, mail, t, id, display, mail); }
        else { id = `acc_${rand(18)}`; q.newAccount.run(id, t, display, mail, t); q.newIdentity.run(provider, subject, id, t); }
        return { id, created: !row };
      });
    },
    /** A new session for the account. The id is random and only its keyed hash is stored. */
    createSession(accountId, ttlMs, kind = "web") {
      const t = now(), id = rand(32); q.purgeSessions.run(t);
      q.newSession.run(mac("session", id), accountId, t, t + ttlMs, kind);
      return { id, expiresAt: t + ttlMs };
    },
    /** The account for a session id, or null (unknown, expired, or its account gone). Expired rows are removed. */
    sessionAccount(id, kind = "web") {
      if (!id || typeof id !== "string" || id.length > 200) return null;
      const key = mac("session", id), row = q.session.get(key);
      if (!row || row.kind !== kind) return null;                                      // a cookie session is not a bearer token, and the other way round
      if (row.expires_at <= now()) { q.delSession.run(key); return null; }
      const a = q.account.get(row.account_id);
      return a ? { id: a.id, name: a.display_name, email: a.email, expiresAt: row.expires_at } : null;
    },
    destroySession(id) { if (id && typeof id === "string") q.delSession.run(mac("session", id)); },
    csrfFor: id => mac("csrf", id),
    /** For tests and diagnostics only: counts, never content. */
    counts: () => ({ accounts: db.prepare("SELECT COUNT(*) n FROM accounts").get().n, identities: db.prepare("SELECT COUNT(*) n FROM identities").get().n, sessions: db.prepare("SELECT COUNT(*) n FROM sessions").get().n }),
    close() { db.close(); },
  };
}
module.exports = { createAccounts };
