// Hash-based navigation: works on any static host or serverless entry point because the server never sees the route.
export const ROUTES = ["compose", "knowledge", "history"];
const TITLES = { compose: "Write", knowledge: "Knowledge", history: "History" };

export function parseRoute(hash) {
  const m = String(hash || "").match(/^#\/?([a-z]+)/);
  return m && ROUTES.includes(m[1]) ? m[1] : "compose";
}

export function createRouter({ views, links, onChange }) {
  let current = null;
  function show(route, { focus = true } = {}) {
    if (route === current) return;
    current = route;
    ROUTES.forEach(r => { views[r].hidden = r !== route; });
    links.forEach(a => { if (a.dataset.route === route) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    document.title = `${TITLES[route]} · Cold`;
    onChange?.(route);
    if (focus) views[route].querySelector("h1")?.focus({ preventScroll: false });
  }
  const sync = (opts) => show(parseRoute(location.hash), opts);
  window.addEventListener("hashchange", () => sync());
  return {
    start() { sync({ focus: false }); },
    go(route) { if (parseRoute(location.hash) === route) { current = null; show(route); } else location.hash = `#/${route}`; },
    get current() { return current; },
  };
}
