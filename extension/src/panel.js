// Cold side panel. It runs the SAME app as the web and desktop surfaces (src/app.js: Write, Knowledge, History, Settings) on the
// extension's own storage and model. The only extension-specific screen part is the "This page" card.
import "../../src/styles/tokens.css";
import "../../src/styles/layout.css";
import "../../src/styles/components.css";
import "./panel.css";
import twitterText from "twitter-text";
import { h } from "../../src/components/dom.js";
import { createStore } from "../../src/state/store.js";
import { startApp } from "../../src/app.js";
import { createExtensionPlatform } from "./platform.js";
import { mountPageCard } from "./pageCard.js";

// The web page loads X's character counter as a global (public/tweet-counter.js); the shared screens expect it.
globalThis.tweetLength = twitterText.parseTweet;

async function boot() {
  const platform = await createExtensionPlatform();
  const store = createStore({ storage: {} });
  const app = await startApp(document.getElementById("app"), {
    store, platform,
  });
  mountPageCard(app.views.compose, { compose: app.compose, platform });
  // Page-driven mode changes need the shared form, so expose it for tests and debugging in one clearly named place.
  globalThis.__cold = { store, platform };
}

boot().catch(e => { document.getElementById("app").append(h("p", {}, `Cold couldn't start: ${e && e.message ? e.message : e}`)); });
