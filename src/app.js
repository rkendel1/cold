// Application bootstrap: builds the shell, creates the store and platform, mounts views, starts routing.
import { h, $ } from "./components/dom.js";
import { notice } from "./components/ui.js";
import { createStore } from "./state/store.js";
import { createPlatform } from "./services/platform.js";
import { createRouter } from "./navigation.js";
import { mountCompose } from "./views/compose.js";
import { mountKnowledge } from "./views/knowledge.js";
import { mountHistory } from "./views/history.js";
import { mountLeads } from "./views/leads.js";
import { mountSettings } from "./views/settings.js";
import { installGlobalErrorLogging } from "./components/global-errors.js";

/**
 * Builds the shell and every screen. The extension runs this same function with its own storage and platform, so Write, Knowledge,
 * History and Settings are one implementation on every surface. `runtime` only changes wording that is about where data lives.
 */
export async function startApp(rootEl = document.getElementById("app"), { store = createStore(), platform = createPlatform() } = {}) {
  const S = store.state;

  const views = {
    compose: h("section", { id: "view-compose", "aria-labelledby": "compose-title" }),
    knowledge: h("section", { id: "view-knowledge", "aria-labelledby": "knowledge-title", hidden: true }),
    leads: h("section", { id: "view-leads", "aria-labelledby": "leads-title", hidden: true }),
    history: h("section", { id: "view-history", "aria-labelledby": "history-title", hidden: true }),
    settings: h("section", { id: "view-settings", "aria-labelledby": "settings-title", hidden: true }),
  };
  const links = [["compose", "Write"], ["knowledge", "Knowledge"], ["leads", "Leads"], ["history", "History"], ["settings", "Settings"]].map(([r, label]) => h("a", { href: `#/${r}`, dataset: { route: r }, id: `nav-${r}` }, label));
  const footer = h("footer", { class: "app-footer" });
  const notices = h("div", { id: "notices", class: "notices", role: "status", "aria-live": "polite" });   // announced politely when a notice appears (e.g. unreadable saved items)
  rootEl.append(
    h("a", { class: "skip", href: "#main" }, "Skip to content"),
    h("header", { class: "app-header" }, platform.hostShowsBrand ? null : h("div", { class: "brand" }, h("img", { class: "brand-mark", src: "brand/logo-96.png", alt: "", width: 28, height: 32 }), h("span", {}, "Cold")), h("nav", { class: "primary-nav", "aria-label": "Primary" }, links)),
    h("main", { id: "main", tabindex: "-1" }, notices, views.compose, views.knowledge, views.leads, views.history, views.settings),
    footer);

  const router = createRouter({ views, links });
  let compose, knowledge;
  const navigate = (route, opts = {}) => {
    router.go(route);
    if (route === "knowledge") knowledge.show(opts);
    if (route === "compose" && opts.lead) compose.useLead(opts.lead);
    else if (route === "compose" && opts.productId) compose.selectProduct(opts.productId);
  };

  compose = mountCompose(views.compose, { store, platform, navigate });
  knowledge = mountKnowledge(views.knowledge, { store, navigate });
  const leads = mountLeads(views.leads, { store, navigate, platform });
  const history = mountHistory(views.history, { store, openRecord: rec => { if (rec) compose.open(rec); navigate("compose"); } });

  const settings = mountSettings(views.settings, { store, platform });
  const paintFooter = () => { footer.textContent = `Cold writes drafts; you send them. Products, drafts and leads ${store.keptNote()}`; };
  const syncSurface = () => store.set({ surface: platform.hub ? platform.hub.kind : S.backend === "sqlite" ? "desktop" : "web", paired: !!platform.hub && platform.hub.libs.kind === "synced", library: platform.hub ? platform.hub.libs.kind : S.backend === "sqlite" ? "desktop" : "standalone" }, "surface");

  const renderNotices = () => {
    while (notices.firstChild) notices.removeChild(notices.firstChild);
    S.warnings.forEach(w => notices.append(notice("warn", h("strong", {}, "Some saved data couldn't be read"), h("p", {}, w))));
    if (S.notice) notices.append(notice("info", S.notice));
    const held = platform.hub ? platform.hub.replica.conflicts : [];
    if (held.length) notices.append(notice("warn", h("strong", {}, `${held.length} edit${held.length === 1 ? "" : "s"} made here couldn't be merged with a newer change in the Cold desktop app`), h("p", {}, "The app's newer version was kept and your edit was set aside, not lost. Review it in Settings.")));
  };
  
  store.subscribe(t => {
    if (t === "ready" || t === "notice" || t === "emails" || t === "products" || t === "leads") renderNotices();
    if (t === "ready" || t === "server" || t === "surface") paintFooter();
  });

  const boot = await platform.detect();
  store.start({ db: boot.db });
  syncSurface();
  if (boot.warning) store.set({ notice: boot.warning }, "notice");
  store.set({ server: boot.server, sample: boot.sample, sampleState: boot.sampleState }, "server");
  // Generation or the desktop app's availability can change while the page is open: keep every screen in step.
  platform.subscribe(() => { const s = platform.snapshot(); store.set({ server: s.server, sample: s.sample, sampleState: s.sampleState }, "server"); syncSurface(); });
  compose.init(); knowledge.init(); leads.init(); history.init(); settings.init();
  router.start();
  
  installGlobalErrorLogging(window);   // log-only: operations handle their own expected failures

  return { store, platform, router, compose, knowledge, leads, history, views, navigate };
}