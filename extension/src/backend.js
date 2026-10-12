// Picks, per call, where the model runs and where lookups happen: the Cold app when it is running (and preferred), otherwise the
// extension's own model connection. If the app disappears mid-use, the next attempt falls back automatically.
import lookups from "../../lib/profile.js";
import { parseLooseJson } from "../../src/domain/email.js";
import { resolveOwn, directSample } from "./model.js";

export function createBackend({ link, getConfig }) {
  const own = () => resolveOwn(getConfig());
  const ownSample = directSample(own);
  const appReady = () => link.state.online && link.state.config && link.state.config.ready;
  const ownReady = () => { const o = own(); return !!(o && o.ready); };
  function choice() {
    const prefer = getConfig().prefer || "app";
    if (appReady() && (prefer === "app" || !ownReady())) return "app";
    return ownReady() ? "own" : null;
  }

  async function sample(prompt, opts) {
    const c = choice();
    if (!c) throw { code: "no_model", message: link.state.conn && !link.state.online ? "The Cold app isn't running and this extension has no model of its own yet. Choose one in Settings, or open the app." : "Choose a model in Settings first." };
    if (c === "own") return ownSample(prompt, opts);
    try { return await link.api.sample(prompt, opts); }
    catch (e) {
      if (e && e.code === "network" && ownReady()) { link.check(); return ownSample(prompt, opts); }   // the app went away: use our own model
      throw e;
    }
  }
  sample.json = async (prompt, opts) => parseLooseJson((await sample(prompt, opts)).text);

  const direct = fn => (url) => fn(url, (...a) => fetch(...a));
  return {
    sample,
    async tweet(url) { if (link.state.online) { try { return await link.api.tweet(url); } catch { /* fall through to a direct lookup */ } } return direct(lookups.lookupTweet)(url); },
    async profile(url) { if (link.state.online) { try { return await link.api.profile(url); } catch { /* fall through */ } } return direct(lookups.lookupProfile)(url); },
    /** { kind: "app" | "own", label } or null when nothing can generate. */
    describe() {
      const c = choice();
      if (c === "app") return { kind: "app", label: `Cold app · ${link.state.config.model}` };
      if (c === "own") { const o = own(); return { kind: "own", label: `${o.label} · ${o.model}` }; }
      return null;
    },
  };
}
