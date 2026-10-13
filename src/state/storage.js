// localStorage access with validation. Reads never throw; writes report failure instead of swallowing it.
import { STORAGE_KEYS } from "../domain/constants.js";
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

import mailto from "../../lib/mailto.js";

/** The saved email-app choice, or the default when it is missing or not one we know. */
export const emailApp = v => (mailto.APPS.includes(v) ? v : "mailto");
/** An optional Gmail address (for people with several Google accounts); anything that isn't an address is dropped. */
export const emailAccount = v => (mailto.isEmail(v) ? String(v).trim() : "");

const str = v => (typeof v === "string" ? v : v == null ? "" : String(v));

export function normalizeEmail(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = str(raw.id).trim();
  if (!id) return null;
  const rec = raw.recipient && typeof raw.recipient === "object" ? raw.recipient : {};
  return {
    ...raw, id,
    status: raw.status == null || raw.status === "" ? "draft" : raw.status,   // only a MISSING status gets the legacy default; an unfamiliar one is kept as is
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    recipient: { ...rec, name: str(rec.name), role: str(rec.role), company: str(rec.company), why: str(rec.why), profileUrl: str(rec.profileUrl), profile: str(rec.profile), email: str(rec.email) },
    productName: str(raw.productName), goal: str(raw.goal) || "advice",
    subject: str(raw.subject), what: str(raw.what), why: str(raw.why), ask: str(raw.ask),
    note: str(raw.note),
    sentCopy: raw.sentCopy && typeof raw.sentCopy === "object" && !Array.isArray(raw.sentCopy) ? { ...raw.sentCopy, subject: str(raw.sentCopy.subject), text: str(raw.sentCopy.text), at: Number.isFinite(raw.sentCopy.at) ? raw.sentCopy.at : 0 } : undefined,
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
export function loadAll(storage = globalThis.localStorage, keys = STORAGE_KEYS) {
  const products = readList(keys.products, normalizeProduct, storage);
  const emails = readList(keys.emails, normalizeEmail, storage);
  const s = readJson(keys.settings, {}, storage);
  const settings = s.value && typeof s.value === "object" && !Array.isArray(s.value) ? s.value : {};
  const c = readJson(keys.compose, null, storage);
  const compose = c.value && typeof c.value === "object" && !Array.isArray(c.value) ? c.value : null;
  return {
    products: products.items, emails: emails.items,
    settings: { signature: str(settings.signature), signoffProduct: settings.signoffProduct !== false, emailApp: emailApp(settings.emailApp), gmailAccount: emailAccount(settings.gmailAccount) },
    compose,
    warnings: [products.warning, emails.warning, s.warning, c.warning].filter(Boolean),
  };
}
