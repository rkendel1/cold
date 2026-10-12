// Public-profile lookup for LinkedIn and X. Only those hosts are ever fetched (no arbitrary URLs), and only the page's
// public metadata is read: the same name/headline/description a link preview shows. Both sites often hide profiles from
// logged-out visitors; when they do, we say so instead of guessing, and the UI falls back to pasted text.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const X_RESERVED = new Set(["home", "i", "search", "explore", "settings", "notifications", "messages", "login", "signup", "intent", "share", "hashtag", "compose", "tos", "privacy", "about"]);

/** Returns { site, url, handle } for a LinkedIn /in/ or X profile link, else null. Accepts links without a scheme. */
function parseProfileUrl(input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(String(input).trim()) ? String(input).trim() : `https://${String(input).trim()}`); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (/^([a-z]{2,3}\.)?(www\.)?linkedin\.com$/.test(host) && parts[0] === "in" && /^[^/\s]{2,100}$/.test(parts[1] || ""))
    return { site: "linkedin", handle: parts[1], url: `https://www.linkedin.com/in/${encodeURIComponent(decodeURIComponent(parts[1]))}` };
  if (/^(www\.|mobile\.)?(x|twitter)\.com$/.test(host) && /^[A-Za-z0-9_]{1,15}$/.test(parts[0] || "") && !X_RESERVED.has(parts[0].toLowerCase()))
    return { site: "x", handle: parts[0], url: `https://x.com/${parts[0]}` };
  return null;
}

const ALLOWED_FINAL = /^([a-z0-9-]+\.)*(linkedin\.com|x\.com|twitter\.com)$/;
const decode = s => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/\s+/g, " ").trim();

function meta(html, key) {
  for (const re of [new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i"), new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, "i")]) {
    const m = html.match(re); if (m) return decode(m[1]);
  }
  return "";
}

function jsonLdPerson(html) {
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = n => Array.isArray(n) ? n.map(walk).find(Boolean) : n && typeof n === "object" ? (n["@type"] === "Person" ? n : walk(n["@graph"] || Object.values(n))) : null;
      const p = walk(JSON.parse(m[1]));
      if (p) return p;
    } catch { /* ignore malformed JSON-LD */ }
  }
  return null;
}

/** Pure parser: page HTML -> labelled plain text for the model, or "" when the page carries no profile data. */
function extractProfileText(html, site) {
  const lines = [];
  const title = meta(html, "og:title") || meta(html, "twitter:title");
  const desc = meta(html, "og:description") || meta(html, "twitter:description") || meta(html, "description");
  const person = jsonLdPerson(html);
  const generic = /^(x|twitter|linkedin)( \/ [a-z]+)?$|log in|sign up|sign in|join linkedin|something went wrong|javascript is (not available|disabled)/i;
  if (person) {
    if (person.name) lines.push(`Name: ${decode(person.name)}`);
    if (person.jobTitle) lines.push(`Job title: ${decode([].concat(person.jobTitle).join(", "))}`);
    const org = person.worksFor && (Array.isArray(person.worksFor) ? person.worksFor[0] : person.worksFor);
    if (org && org.name) lines.push(`Works for: ${decode(org.name)}`);
    if (person.description) lines.push(`About: ${decode(person.description)}`);
  }
  if (title && !generic.test(title)) lines.push(`Page title: ${title}`);
  if (desc && !generic.test(desc)) lines.push(`Page description: ${desc}`);
  const text = lines.join("\n");
  // A page that only repeats its own site name carries nothing about the person.
  return text.length > 12 ? text.slice(0, 4000) : "";
}

/** Fetches one public profile. Never throws; returns { ok, site, url, text } or { ok:false, code, message }. */
async function lookupProfile(input, fetchImpl = globalThis.fetch) {
  const p = parseProfileUrl(input);
  if (!p) return { ok: false, code: "unsupported", message: "Use a LinkedIn profile link (linkedin.com/in/…) or an X profile link (x.com/handle)." };
  const siteName = p.site === "linkedin" ? "LinkedIn" : "X";
  const blocked = { ok: false, code: "blocked", site: p.site, url: p.url, message: `${siteName} wouldn't show this profile without signing in. Paste the profile text instead and Cold will read that.` };
  let r, html;
  try {
    r = await fetchImpl(p.url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
    let finalHost = ""; try { finalHost = new URL(r.url || p.url).hostname.toLowerCase(); } catch { /* keep empty */ }
    if (!ALLOWED_FINAL.test(finalHost)) return blocked;
    if (/\/(authwall|login|checkpoint|uas\/login)/.test(new URL(r.url || p.url).pathname)) return blocked;
    if (!r.ok) return r.status === 404 ? { ok: false, code: "not_found", site: p.site, url: p.url, message: `${siteName} says that profile doesn't exist. Check the link.` } : blocked;
    html = (await r.text()).slice(0, 2 * 1024 * 1024);
  } catch { return { ok: false, code: "unreachable", site: p.site, url: p.url, message: `Couldn't reach ${siteName}. Check your connection, or paste the profile text instead.` }; }
  const text = extractProfileText(html, p.site);
  if (!text) return blocked;
  return { ok: true, site: p.site, url: p.url, text };
}

/** Returns { handle, id } for an x.com / twitter.com status link, else null. */
function parseTweetUrl(input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(String(input).trim()) ? String(input).trim() : `https://${String(input).trim()}`); } catch { return null; }
  if (!/^(www\.|mobile\.)?(x|twitter)\.com$/.test(u.hostname.toLowerCase())) return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/|$)/);
  return m ? { handle: m[1], id: m[2] } : null;
}

/**
 * Reads one public tweet through X's public embed endpoint (the one embedded tweets use). Only that fixed host is contacted.
 * Never throws; returns { ok, text, author, handle, url } or { ok:false, code, message }.
 */
async function lookupTweet(input, fetchImpl = globalThis.fetch) {
  const t = parseTweetUrl(input);
  if (!t) return { ok: false, code: "unsupported", message: "Use a link to a single tweet, like x.com/username/status/123." };
  const url = `https://x.com/${t.handle}/status/${t.id}`;
  const token = ((Number(t.id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const blocked = { ok: false, code: "blocked", url, message: "X wouldn't show that tweet (it may be private, deleted, or hidden from logged-out visitors). Paste the tweet text instead." };
  let data;
  try {
    const r = await fetchImpl(`https://cdn.syndication.twimg.com/tweet-result?id=${t.id}&lang=en&token=${token}`, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    if (r.status === 404) return { ok: false, code: "not_found", url, message: "X says that tweet doesn't exist. Check the link, or paste the tweet text." };
    if (!r.ok) return blocked;
    data = await r.json();
  } catch { return { ok: false, code: "unreachable", url, message: "Couldn't reach X. Check your connection, or paste the tweet text instead." }; }
  if (!data || data.__typename === "TweetTombstone" || typeof data.text !== "string" || !data.text.trim()) return blocked;
  let text = data.text;
  for (const e of (data.entities && data.entities.urls) || []) if (e && e.url && e.expanded_url) text = text.split(e.url).join(e.expanded_url);
  for (const e of (data.entities && data.entities.media) || []) if (e && e.url) text = text.split(e.url).join("");
  text = decode(text).replace(/\s+\n/g, "\n").trim();
  const user = data.user || {};
  return { ok: true, url, text: text.slice(0, 1200), author: typeof user.name === "string" ? decode(user.name) : "", handle: /^[A-Za-z0-9_]{1,15}$/.test(user.screen_name || "") ? user.screen_name : t.handle };
}

module.exports = { parseProfileUrl, extractProfileText, lookupProfile, parseTweetUrl, lookupTweet };
