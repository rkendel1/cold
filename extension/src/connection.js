// Pairing with the Cold desktop app. The extension talks only to the app on this computer (a loopback address), proves
// itself with the pairing code, and never receives provider keys: the app does the model calls.
const KEY = "cold.connection";
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

export const getConnection = async () => (await chrome.storage.local.get(KEY))[KEY] || null;
export const saveConnection = conn => chrome.storage.local.set({ [KEY]: conn });
export const clearConnection = () => chrome.storage.local.remove(KEY);

/** "127.0.0.1:47821", "localhost:47821" or a full http:// address -> "http://127.0.0.1:47821", else null. */
export function normalizeOrigin(input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(String(input).trim()) ? String(input).trim() : `http://${String(input).trim()}`); } catch { return null; }
  return u.protocol === "http:" && LOOPBACK.test(u.hostname) && u.port ? u.origin : null;
}

/** fetch bound to the app: relative paths resolve against its address and carry the pairing code. */
export const appFetch = conn => (path, init = {}) =>
  fetch(new URL(path, `${conn.origin}/`), { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${conn.token}` } });

/** Checks address + code and returns the connection to save, or throws { message }. */
export async function verify(originInput, tokenInput) {
  const origin = normalizeOrigin(originInput), token = String(tokenInput || "").trim();
  if (!origin) throw { message: "Use the address shown in Cold's Settings, like 127.0.0.1:47821." };
  if (!token) throw { message: "Paste the pairing code from Cold's Settings." };
  let cfg;
  try { cfg = await (await fetch(`${origin}/api/config`)).json(); } catch { throw { message: "Couldn't reach Cold. Open the Cold app and check the address." }; }
  if (!cfg || cfg.app !== "cold") throw { message: "That address isn't a Cold app." };
  if (!cfg.dbEnabled) throw { message: "This Cold server doesn't use the app database. Use the Cold desktop app." };
  let r;
  try { r = await fetch(`${origin}/api/data/ping`, { headers: { authorization: `Bearer ${token}` } }); } catch { throw { message: "Couldn't reach Cold." }; }
  if (!r.ok) throw { message: "The app rejected that pairing code. Copy it again from Settings, or create a new one." };
  return { origin, token };
}
