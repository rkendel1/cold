// The library rules that BOTH the server (lib/db.js, CommonJS, packaged with the desktop app) and the app code (src/, ES modules,
// re-exported from src/domain/library.js) must apply identically: a record's version, the stale-write test, and list order.
// This is the single definition; nothing else restates them.
"use strict";

/** A record's version is its `updatedAt`; records saved before versions existed count as 0. */
const versionOf = r => (r && Number.isFinite(r.updatedAt) ? r.updatedAt : 0);

/** Strictly newer than the stored record, so two saves in the same millisecond still get different versions. */
const nextVersion = (stored, now = Date.now()) => Math.max(now, versionOf(stored) + 1);

/**
 * Would a save based on `base` overwrite something newer? `base` is the version the caller last saw, or "new" for a record it
 * believes doesn't exist yet. Nothing stored means nothing to overwrite.
 */
const isStale = (stored, base) => !!stored && (base === "new" || versionOf(stored) !== base);

/** Newest draft first; products by their own order, then name. */
const compareEmails = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
const compareProducts = (a, b) => (a.order ?? 99) - (b.order ?? 99) || String(a.name).localeCompare(String(b.name));

module.exports = { versionOf, nextVersion, isStale, compareEmails, compareProducts };
