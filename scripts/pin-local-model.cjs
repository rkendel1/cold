// Run this on a machine that can reach huggingface.co, then commit the result. It looks up the CURRENT commit of each model repository and
// computes SRI hashes for the small files the runtime can verify (the model config and tokenizer), and prints the values to put into
// MODEL_SOURCE in extension/src/localModels.js. Cold ships with revision "main" until this has been done, which is a known gap.
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const sri = buf => `sha256-${crypto.createHash("sha256").update(buf).digest("base64")}`;
(async () => {
  const { MODELS, MODEL_SOURCE } = await import(pathToFileURL(path.join(__dirname, "../extension/src/localModels.js")).href);
  const out = { revision: null, integrity: {} };
  for (const m of MODELS) for (const v of Object.values(m.variants)) {
    const api = await fetch(`${MODEL_SOURCE.origin}/api/models/${MODEL_SOURCE.org}/${v.id}`);
    if (!api.ok) throw new Error(`${v.id}: HTTP ${api.status}`);
    const sha = (await api.json()).sha;
    const base = `${MODEL_SOURCE.origin}/${MODEL_SOURCE.org}/${v.id}/resolve/${sha}/`;
    const get = async f => Buffer.from(await (await fetch(base + f)).arrayBuffer());
    const cfg = await get("mlc-chat-config.json");
    const tok = {};
    for (const f of JSON.parse(cfg.toString()).tokenizer_files || []) tok[f] = sri(await get(f));
    out.integrity[v.id] = { config: sri(cfg), tokenizer: tok, revision: sha };
  }
  console.log(JSON.stringify(out, null, 2));
  console.log("\nPut each model's revision into the model URL (one commit per repository) and the hashes into MODEL_SOURCE.integrity, then rebuild.");
})().catch(e => { console.error(e.message); process.exit(1); });
