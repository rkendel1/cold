// Application bootstrap: builds the shell, creates the store and platform, mounts views, starts routing.
import { h, $ } from "./components/dom.js";
import { notice } from "./components/ui.js";
import { createStore } from "./state/store.js";
import { createPlatform } from "./services/platform.js";
import { createRouter } from "./navigation.js";
import { mountCompose } from "./views/compose.js";
import { mountKnowledge } from "./views/knowledge.js";
import { mountHistory } from "./views/history.js";

export async function startApp(rootEl = document.getElementById("app")) {
  const store = createStore();
  const platform = createPlatform();
  const S = store.state;

  const views = {
    compose: h("section", { id: "view-compose", "aria-labelledby": "compose-title" }),
    knowledge: h("section", { id: "view-knowledge", "aria-labelledby": "knowledge-title", hidden: true }),
    history: h("section", { id: "view-history", "aria-labelledby": "history-title", hidden: true }),
  };
  const links = [["compose", "Write"], ["knowledge", "Knowledge"], ["history", "History"]].map(([r, label]) => h("a", { href: `#/${r}`, dataset: { route: r }, id: `nav-${r}` }, label));
  const notices = h("div", { id: "notices", class: "notices" });
  rootEl.append(
    h("a", { class: "skip", href: "#main" }, "Skip to content"),
    h("header", { class: "app-header" }, h("div", { class: "brand" }, "Cold"), h("nav", { class: "primary-nav", "aria-label": "Primary" }, links)),
    h("main", { id: "main", tabindex: "-1" }, notices, views.compose, views.knowledge, views.history),
    h("footer", { class: "app-footer" }, "Cold writes drafts; you send them. Products and drafts are saved in this browser only and are not backed up or synced to other devices."));

  const router = createRouter({ views, links });
  let compose, knowledge;
  const navigate = (route, opts = {}) => {
    router.go(route);
    if (route === "knowledge") knowledge.show(opts);
    if (route === "compose" && opts.productId) compose.selectProduct(opts.productId);
  };

  compose = mountCompose(views.compose, { store, platform, navigate });
  knowledge = mountKnowledge(views.knowledge, { store, navigate });
  const history = mountHistory(views.history, { store, openRecord: rec => { if (rec) compose.open(rec); navigate("compose"); } });

  const renderNotices = () => {
    while (notices.firstChild) notices.removeChild(notices.firstChild);
    S.warnings.forEach(w => notices.append(notice("warn", h("strong", {}, "Some saved data couldn't be read"), h("p", {}, w))));
    if (S.notice) notices.append(notice("info", S.notice));
  };
  store.subscribe(t => { if (t === "ready" || t === "notice") renderNotices(); });

  const boot = await platform.detect();
  store.start({ db: boot.db });
  store.set({ server: boot.server, sample: boot.sample, sampleState: boot.sampleState }, "server");
  compose.init(); knowledge.init(); history.init();
  router.start();
  return { store, platform, router };
}
