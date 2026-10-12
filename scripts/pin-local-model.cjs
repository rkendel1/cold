// Records WHERE the on-device model comes from, exactly: for every model Cold can download it pins the repository to an immutable commit and every
// file the runtime needs to its SHA-256 and size, writing extension/src/modelPins.json. Run it on a machine that can reach huggingface.co, review the
// diff, and commit it. The build copies it into the extension; an extension without a complete pin refuses to download the model.
//
//   npm run pin:local-model                 resolve the current commit of each repository and pin it
//   npm run verify:local-model              re-download the PINNED revision and check every byte against the committed pins (and against Hugging Face's metadata)
//   options: --only=<model id>              limit to one model id   (env: HF_ENDPOINT overrides https://huggingface.co; COLD_PINS_FILE overrides the output path)
//
// Two independent sources must agree before anything is written, for every file:
//   1. the bytes this script downloads and hashes itself (SHA-256, size), and
//   2. Hugging Face's own record of that file at that commit: the LFS object id (a SHA-256) for large files, or the git blob id (SHA-1 of "blob <n>\0<bytes>")
//      for small ones. If they disagree the script stops and writes nothing.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const verifyMode = process.argv.includes("--verify");
const only = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7);
const ENDPOINT = (process.env.HF_ENDPOINT || "https://huggingface.co").replace(/\/+$/, "");
const FILE = process.env.COLD_PINS_FILE || path.join(__dirname, "../extension/src/modelPins.json");
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
const gitBlobSha1 = buf => crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");
const fail = msg => { throw new Error(msg); };

async function getJson(url) { const r = await fetch(url, { redirect: "follow" }); if (!r.ok) fail(`${url}: HTTP ${r.status}`); return { json: await r.json(), link: r.headers.get("link") || "" }; }
async function getBytes(url) { const r = await fetch(url, { redirect: "follow" }); if (!r.ok) fail(`${url}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
async function listTree(repo, sha) {
  let url = `${ENDPOINT}/api/models/${repo}/tree/${sha}?recursive=true`; const out = [];
  for (let i = 0; i < 50 && url; i++) { const { json, link } = await getJson(url); out.push(...json); const next = /<([^>]+)>;\s*rel="next"/.exec(link); url = next ? new URL(next[1], ENDPOINT).href : null; }
  return out.filter(e => e.type === "file");
}

async function pinModel(repo, revisionHint, expected) {
  const sha = revisionHint || (await getJson(`${ENDPOINT}/api/models/${repo}/revision/main`)).json.sha;
  if (!/^[0-9a-f]{40}$/.test(sha || "")) fail(`${repo}: could not resolve a commit (got "${sha}")`);
  const tree = Object.fromEntries((await listTree(repo, sha)).map(e => [e.path, e]));
  const base = `${ENDPOINT}/${repo}/resolve/${sha}/`;
  const need = new Set(["mlc-chat-config.json", "tensor-cache.json"]);
  const cfgBytes = await getBytes(base + "mlc-chat-config.json"), cacheBytes = await getBytes(base + "tensor-cache.json");
  for (const t of JSON.parse(cfgBytes.toString()).tokenizer_files || []) need.add(t);
  for (const r of JSON.parse(cacheBytes.toString()).records || []) need.add(r.dataPath);
  const files = {}; let bytes = 0;
  for (const p of [...need].sort()) {
    const meta = tree[p] || fail(`${repo}@${sha.slice(0, 12)}: ${p} is not in the repository tree`);
    const buf = p === "mlc-chat-config.json" ? cfgBytes : p === "tensor-cache.json" ? cacheBytes : await getBytes(base + p);
    const digest = sha256(buf), size = buf.length;
    // source 2: Hugging Face's own record
    if (meta.lfs) {
      if (meta.lfs.oid !== digest) fail(`${repo}/${p}: downloaded SHA-256 ${digest} does not match Hugging Face's LFS object id ${meta.lfs.oid}`);
      if ((meta.lfs.size ?? meta.size) !== size) fail(`${repo}/${p}: downloaded ${size} bytes but the repository records ${meta.lfs.size ?? meta.size}`);
    } else {
      if (meta.oid !== gitBlobSha1(buf)) fail(`${repo}/${p}: downloaded content does not match the repository's git blob id ${meta.oid}`);
      if (meta.size !== undefined && meta.size !== size) fail(`${repo}/${p}: downloaded ${size} bytes but the repository records ${meta.size}`);
    }
    if (expected) {   // --verify: and against what is committed
      const e = expected.files[p]; if (!e) fail(`${repo}/${p}: not in the committed pins`);
      if (e.sha256 !== digest || e.size !== size) fail(`${repo}/${p}: committed pin (${e.sha256.slice(0, 12)}…, ${e.size} bytes) differs from the bytes at the pinned revision (${digest.slice(0, 12)}…, ${size} bytes)`);
    }
    files[p] = { sha256: digest, size }; bytes += size;
  }
  if (expected) for (const p of Object.keys(expected.files)) if (!files[p]) fail(`${repo}/${p}: pinned but no longer required by the model`);
  return { repo, revision: sha, files, bytes };
}

(async () => {
  const { MODELS, MODEL_SOURCE } = await import(pathToFileURL(path.join(__dirname, "../extension/src/localModels.js")).href);
  const current = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { models: {} };
  const out = { schema: 1, status: "pinned", generatedAt: new Date().toISOString(), source: ENDPOINT, models: {} };
  let failures = 0;
  for (const m of MODELS) for (const v of Object.values(m.variants)) {
    if (only && v.id !== only) continue;
    const repo = `${MODEL_SOURCE.org}/${v.id}`;
    try {
      if (verifyMode) {
        const exp = current.models && current.models[v.id];
        if (!exp || !exp.revision) fail(`${v.id}: not pinned`);
        const r = await pinModel(repo, exp.revision, exp); console.log(`ok   ${v.id} @ ${exp.revision.slice(0, 12)}: ${Object.keys(r.files).length} files, ${(r.bytes / 1e6).toFixed(1)} MB match`);
      } else {
        const r = await pinModel(repo);
        out.models[v.id] = { repo, revision: r.revision, files: r.files };
        console.log(`pin  ${v.id} @ ${r.revision.slice(0, 12)}: ${Object.keys(r.files).length} files, ${(r.bytes / 1e6).toFixed(1)} MB`);
      }
    } catch (e) { failures++; console.error(`FAIL ${v.id}: ${e.message}`); }
  }
  if (failures) { console.error(`\n${failures} model(s) failed; ${verifyMode ? "the committed pins no longer match" : "nothing was written"}.`); process.exit(1); }
  if (!verifyMode) { fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + "\n"); console.log(`\nWrote ${path.relative(process.cwd(), FILE)}. Review the diff and commit it, then rebuild the extension.`); }
})().catch(e => { console.error(e.message); process.exit(1); });
