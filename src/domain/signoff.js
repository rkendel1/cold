// The sign-off under an email: the sender's name (set once, in Settings) followed by the details of the product the email is about
// (its name and the "Links and social" chosen in that product's profile). One function, used to copy, to open in an email app, and to
// record what was sent, so they can never disagree.
import { productLinks } from "./knowledge.js";

/** Identifies one of a product's links so a profile can say "leave this one out of the sign-off". */
export const linkKey = ([label, value]) => `${label}|${value}`;

/** How a link reads in a sign-off: the website on its own, everything else as "Label: value" ("X handle" reads as "X"). */
const lineFor = ([label, value]) => (label === "Website" ? value : `${label === "X handle" ? "X" : label}: ${value}`);

/** Sign-off order: the website first, then X, then everything else as listed. The profile's checklist uses the same order. */
export function orderLinks(links) {
  const rank = ([label]) => (label === "Website" ? 0 : label === "X handle" ? 1 : 2);
  return links.map((l, i) => [l, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
}

/** The product's links that go in the sign-off: all of them, minus any the user unchecked in the product profile. */
export function signoffLinks(product) {
  const skip = new Set((product && product.signoffSkip) || []);
  return orderLinks(productLinks(product || {})).filter(l => !skip.has(linkKey(l)));
}

/**
 * @param {{ settings?: { signature?: string, signoffProduct?: boolean }, product?: object|null }} o
 * @returns {string} "" when no name is set (no name, no sign-off); otherwise the name, plus the product block when it has anything to show:
 *   Randy Kendel
 *   FeltDB
 *   https://feltdb.com
 *   X: @feltdb
 */
export function signoffBlock({ settings = {}, product = null } = {}) {
  const name = String(settings.signature || "").trim();
  if (!name) return "";
  if (settings.signoffProduct === false || !product) return name;
  const links = signoffLinks(product);
  if (!links.length) return name;
  return [name, String(product.name || "").trim(), ...links.map(lineFor)].filter(Boolean).join("\n");
}
