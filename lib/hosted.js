// /api/hosted/*: the hosted library of the signed-in Cold account. It speaks the same wire protocol as the desktop app's /api/data (so the page's existing database client is
// reused) but is a separate, account-scoped store (lib/hostedDb.js) in its own SQLite file. The account is whoever the validated session says it is, and nothing in the
// request can change that: a cookie session (web) or a bearer token (desktop app, extension worker), exactly as lib/auth.js defines them.
const { openHostedDb } = require("./hostedDb");

function createHosted({ auth, send, readBody, file }) {
  if (!auth.enabled || !file) {
    return { enabled: false, handle: async (req, res, url) => (url.pathname.startsWith("/api/hosted") ? (send(res, 404, { error: { code: "hosted_disabled", message: "Hosted libraries aren't available here. Cold works without them." } }), true) : false), close() {} };
  }
  const store = openHostedDb(file);
  const out = (req, res, status, body) => send(res, status, body, undefined, auth.corsFor(req));       // CORS only for the registered extension origins
  const err = (req, res, status, code, message, extra = {}) => out(req, res, status, { error: { code, message }, ...extra });
  const fail = (req, res, e) => {
    if (e.code === "conflict") return err(req, res, 409, "conflict", e.message, { current: e.current });
    if (e.status) return err(req, res, e.status, e.code || "bad_request", e.message);
    if (e instanceof SyntaxError) return err(req, res, 400, "bad_request", "Bad request.");
    return err(req, res, 500, "storage_failed", "Couldn't save. Nothing was changed.");                // never the database's own message
  };

  async function handle(req, res, url) {
    if (!(url.pathname === "/api/hosted" || url.pathname.startsWith("/api/hosted/"))) return false;
    if (req.method === "OPTIONS") {
      if (!auth.extOrigins.has(req.headers.origin || "")) return err(req, res, 403, "bad_origin", "Not allowed."), true;
      return send(res, 204, "", "text/plain", auth.corsFor(req)), true;
    }
    const session = auth.authenticate(req);
    if (!session) return err(req, res, 401, "not_signed_in", "You're signed out or your session ended, so nothing was saved to your hosted library. Sign in again."), true;
    const denied = auth.guard(req, session, req.method !== "GET");
    if (denied) return err(req, res, denied.status, denied.code, denied.message), true;
    const account = session.account.id;                                    // from the session, nowhere else
    const parts = url.pathname.split("/").filter(Boolean).slice(2);        // after /api/hosted
    try {
      if (parts[0] === "library" && parts.length === 1) {
        if (req.method === "GET") return out(req, res, 200, store.summary(account)), true;
        if (req.method === "POST") { const r = store.create(account); return out(req, res, 200, { ...r, ...store.summary(account) }), true; }
      }
      if (parts[0] === "data") {
        const rest = parts.slice(1);
        if (req.method === "GET" && rest.length === 0) return out(req, res, 200, store.snapshot(account)), true;
        if (req.method === "GET" && rest[0] === "version" && rest.length === 1) return out(req, res, 200, { version: store.version(account) }), true;
        const bq = url.searchParams.get("base"), base = bq === null ? undefined : bq === "new" ? "new" : /^\d{1,16}$/.test(bq) ? Number(bq) : NaN;
        if (Number.isNaN(base)) return err(req, res, 400, "bad_request", "Bad request."), true;
        let id; try { id = rest.length === 2 ? decodeURIComponent(rest[1]) : undefined; } catch { return err(req, res, 400, "bad_request", "Bad request."), true; }
        if (req.method === "DELETE" && rest.length === 2) return out(req, res, 200, { ok: true, ...store.remove(account, rest[0], id, { base }) }), true;
        if (req.method === "PUT" && (rest.length === 1 || rest.length === 2)) {
          const doc = JSON.parse(await readBody(req, 600 * 1024));
          return out(req, res, 200, { ok: true, ...(rest.length === 2 ? store.put(account, rest[0], id, doc, { base }) : store.putMeta(account, rest[0], doc)) }), true;
        }
      }
    } catch (e) { return fail(req, res, e), true; }
    return err(req, res, 404, "not_found", "Not found"), true;
  }
  return { enabled: true, handle, store, close: () => store.close() };
}
module.exports = { createHosted };
