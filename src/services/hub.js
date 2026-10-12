// Pairing with the Cold desktop app (the "hub"). Used by the web app and the browser extension. A page proves itself with the
// pairing code shown in the desktop app's Settings; it only ever talks to the app on this computer (a loopback address), and it
// never receives the app's provider keys, because the app does the model calls.
import { STORAGE_KEYS } from "../domain/constants.js";

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

/** Where a pairing is remembered: the extension's storage or this page's localStorage. { get, set, clear } */
export const chromeHubStore = (key = "cold.connection") => ({
  get: async () => (await chrome.storage.local.get(key))[key] || null,
  set: conn => chrome.storage.local.set({ [key]: conn }),
  clear: () => chrome.storage.local.remove(key),
});
export const localHubStore = (storage = globalThis.localStorage) => ({
  get: async () => { try { const c = JSON.parse(storage.getItem(STORAGE_KEYS.hub) || "null"); return c && c.origin && c.token ? c : null; } catch { return null; } },
  set: async conn => { try { storage.setItem(STORAGE_KEYS.hub, JSON.stringify(conn)); } catch { /* the pairing just won't persist */ } },
  clear: async () => { try { storage.removeItem(STORAGE_KEYS.hub); } catch { /* ignore */ } },
});

/** "127.0.0.1:47821", "localhost:47821" or a full http:// address -> "http://127.0.0.1:47821", else null. */
export function normalizeOrigin(input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(String(input).trim()) ? String(input).trim() : `http://${String(input).trim()}`); } catch { return null; }
  return u.protocol === "http:" && LOOPBACK.test(u.hostname) && u.port ? u.origin : null;
}

/** fetch bound to the hub: relative paths resolve against its address and carry the pairing code. */
export const hubFetch = conn => (path, init = {}) =>
  fetch(new URL(path, `${conn.origin}/`), { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${conn.token}` } });

/** Checks address + code and returns the connection to save, or throws { message }. `who` words the "couldn't reach" hint. */
export async function verifyHub(originInput, tokenInput, { who = "extension" } = {}) {
  const origin = normalizeOrigin(originInput), token = String(tokenInput || "").trim();
  if (!origin) throw { message: "Use the address shown in the Cold desktop app's Settings, like 127.0.0.1:47821." };
  if (!token) throw { message: "Paste the pairing code from the Cold desktop app's Settings." };
  const unreachable = who === "web"
    ? "Couldn't reach the Cold desktop app. Check that it is running, and that this page's address is on its list of allowed web apps (desktop Settings)."
    : "Couldn't reach the Cold desktop app. Open it and check the address.";
  let cfg;
  try { cfg = await (await fetch(`${origin}/api/config`)).json(); } catch { throw { message: unreachable }; }
  if (!cfg || cfg.app !== "cold") throw { message: "That address isn't a Cold app." };
  if (!cfg.dbEnabled) throw { message: "That Cold server doesn't keep a database. Use the Cold desktop app." };
  let r;
  try { r = await fetch(`${origin}/api/data/ping`, { headers: { authorization: `Bearer ${token}` } }); } catch { throw { message: unreachable }; }
  if (!r.ok) throw { message: "The desktop app rejected that pairing code. Copy it again from its Settings, or create a new one." };
  return { origin, token };
}
