// "This page": the one thing only the extension can do. Reads the tweet or profile in the active tab and fills in the shared Write
// screen with it. The user still reviews everything and presses Generate; nothing is read until they click.
import { h } from "../../src/components/dom.js";
import { button } from "../../src/components/ui.js";
import { extractProfile } from "../../src/services/generation.js";
import { readPage, classify } from "./page.js";

export function mountPageCard(composeRoot, { compose, platform }) {
  const line = h("p", { id: "pageLine" });
  const status = h("p", { class: "hint", role: "status", id: "pageStatus" });
  const readBtn = button("Read this page", { id: "readPage", onclick: () => read() });
  composeRoot.prepend(h("section", { class: "x-page", "aria-label": "This page" }, h("div", { class: "x-pagerow" }, line, readBtn), status));
  let kind = { kind: "other" };

  const activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  async function refresh() {
    const tab = await activeTab();
    kind = tab && tab.url ? classify(tab.url) : { kind: "other" };
    line.textContent = kind.kind === "tweet" ? "You're on a tweet." : kind.kind === "profile" ? `You're on a ${kind.site} profile.` : kind.kind === "compose" ? "You're on X's compose page." : "Open a tweet or a LinkedIn or X profile to read it here.";
    readBtn.disabled = !(kind.kind === "tweet" || kind.kind === "profile");
    return tab;
  }
  chrome.tabs.onActivated.addListener(refresh);
  chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete" || info.url) refresh(); });
  refresh().then(() => { if (kind.kind === "profile") compose.fill({ mode: "email" }); else if (kind.kind === "compose") compose.fill({ mode: "tweet" }); });

  async function read() {
    const tab = await activeTab();
    if (!tab || !tab.id) return;
    readBtn.disabled = true; status.textContent = "Reading the page…";
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage });
      if (kind.kind === "tweet") {
        let t = result.kind === "tweet" ? result : null;
        if (!t) { const r = await platform.api.tweet(result.url); if (!r.ok) { status.textContent = r.message; return; } t = { text: r.text, handle: r.handle ? `@${r.handle}` : "" }; }
        compose.fill({ mode: "reply", tweetUrl: result.url, tweetContext: t.text, tweetAuthor: t.handle || "" });
        status.textContent = `Read ${t.handle || "the"} tweet. Check it, say what you want to say back if you like, then generate.`;
      } else {
        if (!platform.backend.describe()) { status.textContent = "Choose a model in Settings first: Cold uses it to read the page."; return; }
        const p = await extractProfile({ sample: platform.backend.sample, text: `${result.title}\n${result.text}` });
        const cur = compose.read(), patch = { mode: "email", profile: p.notes || "", profileUrl: result.url };
        for (const k of ["name", "role", "company"]) if (p[k] && !cur[k]) patch[k] = p[k];   // never overwrite what was typed
        compose.fill(patch);
        status.textContent = "Read their page. Check the details, then say why they should care.";
        if (!compose.read().why) compose.suggestReasons();
      }
    } catch (e) { status.textContent = (e && e.message) || "Couldn't read this page. Paste the text instead."; }
    finally { readBtn.disabled = false; refresh(); }
  }
}
