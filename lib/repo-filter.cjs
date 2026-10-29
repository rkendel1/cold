// Which project files the importer reads. Shared by the server (lib/repoSource.js) and the browser (src/views/importKnowledge.js,
// which uses it to skip node_modules and the like before reading a chosen local folder), so both apply the same rules.
"use strict";

const MAX_ARCHIVE = 40 * 1024 * 1024;       // compressed bytes accepted (download or upload); also the cap on a chosen folder's text
const MAX_FILE = 400 * 1024;                // a single text file larger than this is skipped
const MAX_FILES = 6000;

const SKIP_DIRS = /(^|\/)(node_modules|vendor|dist|build|out|target|coverage|\.git|\.github\/workflows|\.next|\.nuxt|__pycache__|\.venv|venv|third_party|bower_components|\.idea|\.vscode)(\/|$)/i;
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.(min\.js|min\.css|map|svg|png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|tar|wasm|woff2?|ttf|eot|mp[34]|mov|bin|exe|dll|so|dylib|class|jar|lock)$/i;

/** Is `path` (relative, forward slashes) a file the importer would read? */
function keep(path, size) {
  if (!path || path.endsWith("/")) return false;
  if (/(^|\/)\.\.(\/|$)/.test(path) || path.startsWith("/")) return false;
  if (SKIP_DIRS.test(path) || SKIP_FILES.test(path)) return false;
  return size <= MAX_FILE;
}

module.exports = { MAX_ARCHIVE, MAX_FILE, MAX_FILES, SKIP_DIRS, SKIP_FILES, keep };
