// The on-device model's worker gets NO network. Everything it needs is already in this browser: the compiled library ships inside the
// extension and the model files were downloaded and checked by the panel before the worker was given them. So the worker can read
// extension files and the cache, and nothing else: it cannot fetch, open a socket, load a script, or beacon anything out, whatever it is
// handed. (If the runtime ever tried to download something itself, that would fail here and be reported, not silently allowed.)
export function installNetworkGuard(scope = globalThis) {
  const isExtension = input => { try { return new URL(typeof input === "string" ? input : (input && input.url) || String(input), (scope.location && scope.location.href) || "chrome-extension://self/").protocol === "chrome-extension:"; } catch { return false; } };
  const deny = what => new TypeError(`Cold's on-device model has no network access (${what}).`);
  const realFetch = scope.fetch && scope.fetch.bind(scope);
  if (realFetch) scope.fetch = (input, init) => (isExtension(input) ? realFetch(input, init) : Promise.reject(deny("fetch")));
  if (scope.Cache && scope.Cache.prototype) {
    const add = scope.Cache.prototype.add, addAll = scope.Cache.prototype.addAll;
    scope.Cache.prototype.add = function (req) { return isExtension(req) ? add.call(this, req) : Promise.reject(deny("cache.add " + String(req && req.url || req).slice(0, 200))); };
    scope.Cache.prototype.addAll = function (reqs) { return [...reqs].every(isExtension) ? addAll.call(this, reqs) : Promise.reject(deny("cache.addAll")); };
  }
  for (const name of ["XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts"]) {
    if (name in scope) { try { scope[name] = function () { throw deny(name); }; } catch { /* not writable here */ } }
  }
  return true;
}
