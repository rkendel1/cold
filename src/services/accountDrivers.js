// How the page talks to its Cold account, one small interface for all three surfaces:
//   { kind, status(): { state: "signedOut"|"signedIn"|"expired"|"unavailable", account?, csrf?, message? }, signIn(): { pending?: true }, signOut(): { ok, serverConfirmed? } }
// Sign-in is identity only. None of these touch local data, and none of them hands a token to the page: the web app uses an HttpOnly cookie the page can't read, the
// desktop page asks its own local app (which holds the session), and the extension panel asks the extension's background worker.

/** Web (cookie session on the hosted server) and desktop (the local app's /api/account/* routes, same shape). `external` opens Google in the system browser and waits. */
export function cookieDriver({ fetchImpl = (...a) => globalThis.fetch(...a), location = globalThis.location, open = u => globalThis.open && globalThis.open(u, "_blank", "noopener"), external = false, kind = "web" } = {}) {
  let csrf = "";
  const json = r => r.json().catch(() => ({}));
  return {
    kind, external,
    async status() {
      let r; try { r = await fetchImpl("api/account/me", { headers: { accept: "application/json" } }); } catch { return { state: "unavailable" }; }
      const d = await json(r);
      if (r.ok && d.signedIn && d.account) { csrf = d.csrf || ""; return { state: "signedIn", account: d.account, csrf }; }
      if (r.status === 401) return { state: d.error && d.error.code === "session_expired" ? "expired" : "signedOut" };
      return { state: "unavailable", account: d.account || undefined };
    },
    async signIn() {
      const r = await fetchImpl("api/account/login", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ returnTo: "/" }) });
      const d = await json(r);
      if (!r.ok || !d.url) throw { code: (d.error && d.error.code) || "login_failed", message: (d.error && d.error.message) || "Couldn't start sign-in." };
      if (external) { open(d.url); return { pending: true }; }
      location.assign(d.url); return { navigating: true };
    },
    async signOut() {
      const r = await fetchImpl("api/account/logout", { method: "POST", headers: { "content-type": "application/json", "x-cold-csrf": csrf } });
      if (!r.ok) throw new Error("logout");
      const d = await json(r); return { ok: true, serverConfirmed: d.serverConfirmed !== false };
    },
  };
}

/** Extension panel: every call goes to the extension's background worker, which alone holds the session token (see extension/src/account.js). */
export function extensionDriver({ send = m => chrome.runtime.sendMessage(m) } = {}) {
  const ask = async m => { try { return (await send(m)) || { state: "unavailable" }; } catch { return { state: "unavailable" }; } };
  return {
    kind: "extension", external: false,
    status: () => ask({ cold: "account", op: "status" }),
    async signIn() { const r = await ask({ cold: "account", op: "signin" }); if (r.error) throw { code: r.error, message: r.message || "Sign-in didn't complete." }; return {}; },
    async signOut() { const r = await ask({ cold: "account", op: "signout" }); return { ok: r.ok !== false, serverConfirmed: r.serverConfirmed !== false }; },
  };
}
