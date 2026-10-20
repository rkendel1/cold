// Repository ingestion: turn a GitHub repository address or an uploaded ZIP into a flat list of readable text files.
// This module only OBTAINS and ENUMERATES files. It makes no judgement about what they mean (see productImport.js).
//
// GitHub access is deliberately narrow: two fixed hosts, owner/repo names validated, and the commit is resolved to an
// immutable SHA first so every piece of evidence can point at exactly the revision that was read.
const zlib = require("node:zlib");

const MAX_ARCHIVE = 40 * 1024 * 1024;       // compressed bytes accepted (download or upload)
const MAX_UNPACKED = 120 * 1024 * 1024;     // total uncompressed bytes we will walk (zip-bomb guard)
const MAX_FILE = 400 * 1024;                // a single text file larger than this is skipped
const MAX_FILES = 6000;

const SKIP_DIRS = /(^|\/)(node_modules|vendor|dist|build|out|target|coverage|\.git|\.github\/workflows|\.next|\.nuxt|__pycache__|\.venv|venv|third_party|bower_components|\.idea|\.vscode)(\/|$)/i;
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.(min\.js|min\.css|map|svg|png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|tar|wasm|woff2?|ttf|eot|mp[34]|mov|bin|exe|dll|so|dylib|class|jar|lock)$/i;

const fail = (code, message) => Object.assign(new Error(message), { code });

/** "https://github.com/o/r", ".../r.git", ".../r/tree/ref/dir", "git@github.com:o/r.git" or "o/r" -> { owner, repo, ref } or null. */
function parseGithubUrl(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  s = s.replace(/^git@github\.com:/i, "https://github.com/").replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "").replace(/^\/+/, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;             // some other scheme or host
  const parts = s.split(/[?#]/)[0].split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0], repo = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") return null;
  let ref = "";
  if ((parts[2] === "tree" || parts[2] === "commit") && parts[3]) ref = decodeURIComponent(parts[3]);   // a ref with a slash in it resolves to HEAD; the SHA is what counts
  if (ref && !/^[A-Za-z0-9._\-/]{1,200}$/.test(ref)) return null;
  return { owner, repo, ref };
}

async function readCapped(res, limit) {
  const len = Number(res.headers.get("content-length"));
  if (len > limit) throw fail("too_large", `That repository archive is larger than ${Math.round(limit / 1048576)} MB.`);
  const chunks = []; let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { reader.cancel().catch(() => {}); throw fail("too_large", `That repository archive is larger than ${Math.round(limit / 1048576)} MB.`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch a GitHub repository at an immutable commit.
 * Resolves to { identity: { host, owner, repo, url, ref, commit }, files }. `token` (optional) enables private repositories.
 * Everything else about the source is deliberately not trusted: the archive is only ever read in memory.
 */
async function fetchGithub(input, { token = "", fetchImpl = fetch, signal } = {}) {
  const p = parseGithubUrl(input);
  if (!p) throw fail("bad_source", "Paste a GitHub repository address like https://github.com/owner/name.");
  const headers = { "user-agent": "cold-product-import", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const api = `https://api.github.com/repos/${p.owner}/${p.repo}`;
  const shaRes = await fetchImpl(`${api}/commits/${encodeURIComponent(p.ref || "HEAD")}`, { headers: { ...headers, accept: "application/vnd.github.sha" }, signal }).catch(() => { throw fail("unreachable", "Couldn't reach GitHub."); });
  if (shaRes.status === 404) throw fail("not_found", token ? "That repository or ref wasn't found." : "That repository wasn't found, or it is private. For a private repository, upload a ZIP of it instead.");
  if (shaRes.status === 403 || shaRes.status === 429) throw fail("rate_limited", "GitHub is rate-limiting requests from this server. Try again later, or upload a ZIP of the project.");
  if (!shaRes.ok) throw fail("unreachable", `GitHub returned ${shaRes.status}.`);
  const commit = (await shaRes.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw fail("unreachable", "GitHub returned an unexpected answer.");
  const tarRes = await fetchImpl(`${api}/tarball/${commit}`, { headers: { ...headers, accept: "application/vnd.github+json" }, signal, redirect: "follow" }).catch(() => { throw fail("unreachable", "Couldn't reach GitHub."); });
  if (!tarRes.ok) throw fail("unreachable", `GitHub returned ${tarRes.status} for the archive.`);
  const files = readTarGz(await readCapped(tarRes, MAX_ARCHIVE));
  return { identity: { host: "github.com", owner: p.owner, repo: p.repo, url: `https://github.com/${p.owner}/${p.repo}`, ref: p.ref || "", commit }, files };
}

/* ---------- archive readers (no dependencies; in memory only) ---------- */

function keep(path, size) {
  if (!path || path.endsWith("/")) return false;
  if (/(^|\/)\.\.(\/|$)/.test(path) || path.startsWith("/")) return false;
  if (SKIP_DIRS.test(path) || SKIP_FILES.test(path)) return false;
  return size <= MAX_FILE;
}

function asText(buf) {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return null;                           // binary
  return buf.toString("utf8");
}

/** Strip the single wrapper directory GitHub and most ZIP tools add ("repo-main/..."). */
function stripWrapper(entries) {
  if (!entries.length) return entries;
  const first = entries[0].path.split("/")[0];
  if (!entries.every(e => e.path.includes("/") && e.path.split("/")[0] === first)) return entries;
  return entries.map(e => ({ ...e, path: e.path.slice(first.length + 1) })).filter(e => e.path);
}

function readTarGz(gz) {
  let tar;
  try { tar = zlib.gunzipSync(gz, { maxOutputLength: MAX_UNPACKED }); } catch { throw fail("bad_archive", "The repository archive couldn't be read."); }
  const out = []; let off = 0, longName = "", paxPath = "";
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const name = h.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = h.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const size = parseInt(h.toString("utf8", 124, 136).replace(/\0.*$/, "").trim() || "0", 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { const m = body.toString("utf8").match(/\d+ path=([^\n]+)\n/); paxPath = m ? m[1] : ""; continue; }
    if (type === "g") continue;
    if (type === "L") { longName = body.toString("utf8").replace(/\0.*$/, ""); continue; }
    const path = paxPath || longName || (prefix ? `${prefix}/${name}` : name);
    paxPath = ""; longName = "";
    if (type !== "0" && type !== "\0") continue;
    out.push({ path, buf: body });
    if (out.length > MAX_FILES * 4) throw fail("too_large", "That repository has too many files.");
  }
  return finish(stripWrapper(out.map(e => ({ path: e.path, size: e.buf.length, read: () => e.buf }))));
}

/** Minimal ZIP reader: central directory, stored + deflated entries. */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw fail("bad_archive", "That doesn't look like a ZIP file.");
  if (buf.length > MAX_ARCHIVE) throw fail("too_large", `That ZIP is larger than ${Math.round(MAX_ARCHIVE / 1048576)} MB.`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw fail("bad_archive", "That doesn't look like a ZIP file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = []; let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw fail("bad_archive", "That ZIP is damaged.");
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nlen).replace(/\\/g, "/");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
    total += usize;
    if (total > MAX_UNPACKED) throw fail("too_large", "That ZIP is too large once unpacked.");
    entries.push({
      path: name, size: usize, read: () => {
        if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) return null;
        const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return raw;
        if (method === 8) { try { return zlib.inflateRawSync(raw, { maxOutputLength: MAX_FILE + 1 }); } catch { return null; } }
        return null;
      },
    });
  }
  return finish(stripWrapper(entries));
}

function finish(entries) {
  const files = [];
  for (const e of entries) {
    if (files.length >= MAX_FILES) break;
    if (!keep(e.path, e.size)) continue;
    const buf = e.read();
    if (!buf) continue;
    const text = asText(buf);
    if (text == null) continue;
    files.push({ path: e.path, text });
  }
  return files;
}

/** An uploaded ZIP has no remote identity or commit; it is identified by what was in it. */
function fromZip(buf, { name = "" } = {}) {
  const files = readZip(buf);
  const crypto = require("node:crypto");
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) h.update(f.path).update("\0").update(f.text).update("\0");
  return { identity: { host: "upload", owner: "", repo: String(name || "").replace(/\.zip$/i, "").slice(0, 100), url: "", ref: "", commit: `zip-sha256:${h.digest("hex").slice(0, 16)}` }, files };
}

module.exports = { parseGithubUrl, fetchGithub, fromZip, readZip, readTarGz, MAX_ARCHIVE };
