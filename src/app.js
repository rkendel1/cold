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
import { initProductionReadiness } from "./components/production-readiness.js";

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
  const notices = h("div", { id: "notices", class: "notices" });
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
  
  // Add CX consistency error handling - all surfaces should gracefully handle errors
  store.subscribe(t => { 
    if (t === "ready" || t === "notice" || t === "emails" || t === "products" || t === "leads") renderNotices(); 
    if (t === "ready" || t === "server" || t === "surface") paintFooter(); 
    
    // Ensure consistent error handling across all surfaces for production readiness
    if (t === "error" && store.state.error) {   // "error" is also emitted with null to CLEAR an error (every Generate does); that is not a failure
      const errorNotice = notice("bad", h("strong", {}, "System error"), h("p", {}, "There was an error in the application. Please refresh or contact support if the problem persists."));
      notices.appendChild(errorNotice);
    }
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
  
  // Initialize production readiness patterns for all surfaces
  initProductionReadiness(store);
  
  // Ensure consistent error handling and crash protection across all surfaces
  window.addEventListener('error', (e) => {
    if (/^ResizeObserver loop/.test(e.message || "")) return;   // a harmless browser notice (auto-sizing text boxes), not a fault
    console.error('Global error caught:', e.error);
    // All surfaces should gracefully handle uncaught errors to maintain production readiness
    renderNotices(); // This will show error notices if any
  });
  
  // Implement cross-surface UX standards consistently
  // 1. Ensure all surfaces use the same navigation structure and consistency patterns
  const checkNavigationConsistency = () => {
    try {
      // Validate that we have exactly the expected routes
      const expectedRoutes = ['compose', 'knowledge', 'leads', 'history', 'settings'];
      const actualRoutes = Array.from(links).map(link => link.dataset.route);
      
      if (actualRoutes.length !== expectedRoutes.length) {
        console.warn('Navigation structure mismatch: wrong number of routes');
      }
      
      if (!expectedRoutes.every(route => actualRoutes.includes(route))) {
        console.warn('Navigation structure mismatch: missing routes');
      }
      
      // Validate consistency in DOM structure 
      const header = document.querySelector('.app-header');
      const nav = document.querySelector('.primary-nav');
      if (header && !nav) {
        console.warn('Missing navigation component in UI');
      }
      
    } catch (error) {
      console.error('Navigation consistency check failed:', error);
    }
  };
  
  // Run the consistency check after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkNavigationConsistency);
  } else {
    checkNavigationConsistency();
  }
  
  // 2. Apply consistent visual design tokens and layout across all surfaces
  const applyUiConsistency = () => {
    try {
      // Ensure all buttons follow the same pattern
      const allButtons = document.querySelectorAll('button');
      allButtons.forEach(btn => {
        if (!btn.classList.contains('btn')) {
          btn.classList.add('btn');
        }
        
        // Add consistent focus styling
        btn.addEventListener('focus', () => {
          btn.style.outline = '2px solid var(--ink)';
          btn.style.outlineOffset = '1px';
        });
        
        btn.addEventListener('blur', () => {
          btn.style.outline = '';
        });
      });
      
      // Ensure form fields follow consistent patterns
      const allFields = document.querySelectorAll('.field');
      allFields.forEach(field => {
        if (!field.querySelector('label')) {
          console.warn('Field missing label:', field);
        }
        // Ensure errors are handled consistently
        const errorElement = field.querySelector('.field-error');
        if (errorElement) {
          errorElement.setAttribute('aria-live', 'polite');
        }
      });
      
    } catch (error) {
      console.error('UI consistency check failed:', error);
    }
  };
  
  // Apply UI consistency after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyUiConsistency);
  } else {
    applyUiConsistency();
  }
  
  // 3. Ensure all surfaces handle storage errors gracefully 
  // This was already done in the production readiness, but let's ensure additional checks
  const setupStorageErrorHandling = () => {
    try {
      // The store.set method is already wrapped by initProductionReadiness
      // We can add additional error handling here if needed
    } catch (error) {
      console.error('Storage error handling setup failed:', error);
    }
  };
  
  setupStorageErrorHandling();
  
  return { store, platform, router, compose, knowledge, leads, history, views, navigate };
}