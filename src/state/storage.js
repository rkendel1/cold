// localStorage access with validation. Reads never throw; writes report failure instead of swallowing it.
import { STORAGE_KEYS, STATUSES } from "../domain/constants.js";
import { normalizeProduct } from "../domain/knowledge.js";

/** Returns { value, warning } where warning is set when stored data existed but could not be used. */
export function readJson(key, fallback, storage = globalThis.localStorage) {
  let raw;
  try { raw = storage.getItem(key); } catch { return { value: fallback, warning: null }; }
  if (raw == null || raw === "") return { value: fallback, warning: null };
  try { return { value: JSON.parse(raw), warning: null }; }
  catch { return { value: fallback, warning: `Saved data under “${key}” was unreadable and was ignored (it was not deleted).` }; }
}

/** Throws { code: "quota_exceeded" | "storage_unavailable" } so callers can tell the user the truth. */
export function writeJson(key, value, storage = globalThis.localStorage) {
  try { storage.setItem(key, JSON.stringify(value)); }
  catch (e) {
    const quota = e && (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014);
    throw { code: quota ? "quota_exceeded" : "storage_unavailable", message: quota ? "Browser storage is full." : "Browser storage is unavailable." };
  }
}

const str = v => (typeof v === "string" ? v : v == null ? "" : String(v));

export function normalizeEmail(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = str(raw.id).trim();
  if (!id) return null;
  const rec = raw.recipient && typeof raw.recipient === "object" ? raw.recipient : {};
  return {
    ...raw, id,
    status: STATUSES.includes(raw.status) ? raw.status : "draft",
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    recipient: { name: str(rec.name), role: str(rec.role), company: str(rec.company), why: str(rec.why) },
    productName: str(raw.productName), goal: str(raw.goal) || "advice",
    subject: str(raw.subject), what: str(raw.what), why: str(raw.why), ask: str(raw.ask),
    checks: Array.isArray(raw.checks) ? raw.checks.filter(c => c && typeof c === "object") : [],
    claims: Array.isArray(raw.claims) ? raw.claims.filter(c => c && typeof c === "object") : [],
    retrieved: Array.isArray(raw.retrieved) ? raw.retrieved.filter(c => c && typeof c === "object") : [],
    draftFailures: Array.isArray(raw.draftFailures) ? raw.draftFailures.map(str) : [],
    facts: raw.facts && typeof raw.facts === "object" && !Array.isArray(raw.facts) ? raw.facts : {},
  };
}

function readList(key, normalize, storage) {
  const { value, warning } = readJson(key, [], storage);
  if (!Array.isArray(value)) return { items: [], warning: warning || `Saved data under “${key}” had an unexpected shape and was ignored (it was not deleted).` };
  const items = value.map((x, i) => normalize(x, i)).filter(Boolean);
  const dropped = value.length - items.length;
  return { items, warning: warning || (dropped ? `${dropped} saved item${dropped === 1 ? " was" : "s were"} unreadable and skipped.` : null) };
}

/** Load everything once at boot. `warnings` is shown to the user; nothing is deleted from storage. */
export function loadAll(storage = globalThis.localStorage) {
  const products = readList(STORAGE_KEYS.products, normalizeProduct, storage);
  const emails = readList(STORAGE_KEYS.emails, normalizeEmail, storage);
  const s = readJson(STORAGE_KEYS.settings, {}, storage);
  const settings = s.value && typeof s.value === "object" && !Array.isArray(s.value) ? s.value : {};
  const c = readJson(STORAGE_KEYS.compose, null, storage);
  const compose = c.value && typeof c.value === "object" && !Array.isArray(c.value) ? c.value : null;
  return {
    products: products.items, emails: emails.items,
    settings: { signature: str(settings.signature) },
    compose,
    warnings: [products.warning, emails.warning, s.warning, c.warning].filter(Boolean),
  };
}
