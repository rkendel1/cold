// Picks, per call, where the model runs and where lookups happen: this surface's own model (the web server's, or the extension's
// direct connection) or the Cold desktop app's, when it is running. If the app disappears mid-use the next attempt falls back
// automatically. The only thing that crosses to the app is the prompt: provider keys never leave where they are stored.
import { parseLooseJson } from "../domain/email.js";

/**
 * @param {object} o
 * @param {object} o.link        the hub link (state.online, state.config, api)
 * @param {() => object} o.getConfig  { prefer: "app" | "own" }
 * @param {{ ready(): boolean, sample: Function, label(): string, lookups?: { tweet(url): Promise<object>, profile(url): Promise<object> }, people?: { available(): boolean, findEmail(i): Promise<object>, verifyEmail(i): Promise<object> } }} o.own
 */
export function createBackend({ link, getConfig, own }) {
  const appReady = () => !!(link.state.online && link.state.config && link.state.config.ready);
  function choice() {
    const prefer = (getConfig() || {}).prefer || "app";
    if (appReady() && (prefer === "app" || !own.ready())) return "app";
    return own.ready() ? "own" : null;
  }

  async function sample(prompt, opts) {
    const c = choice();
    if (!c) throw { code: "no_model", message: link.state.conn && !link.state.online ? "The Cold desktop app isn't running and no other model is set up here yet. Choose one in Settings, or open the app." : "Choose a model in Settings first." };
    if (c === "own") return own.sample(prompt, opts);
    try { return await link.api.sample(prompt, opts); }
    catch (e) {
      if (e && e.code === "network" && own.ready()) { link.check(); return own.sample(prompt, opts); }   // the app went away: use our own model
      throw e;
    }
  }
  sample.json = async (prompt, opts) => parseLooseJson((await sample(prompt, opts)).text);

  const lookup = name => async url => {
    if (link.state.online) { try { return await link.api[name](url); } catch { /* fall through to a direct lookup */ } }
    if (own.lookups) return own.lookups[name](url);
    throw { code: "network", message: "Lookups need this app's server or the Cold desktop app." };
  };
  // Email lookup is billable, so unlike the free lookups above it never falls through to a second route after a failure: one request, one place.
  const people = name => async input => {
    if (link.state.online && link.state.config && link.state.config.peopleSearch) return link.api[name](input);
    if (own.people && own.people.available()) return own.people[name](input);
    throw { code: "not_configured", message: link.state.conn && !link.state.online ? "The Cold desktop app isn't running. Open it to look up emails." : "Email lookup isn't set up. Add a treg token in the Cold desktop app's Settings (or set TREG_TOKEN on the server)." };
  };
  return {
    sample, tweet: lookup("tweet"), profile: lookup("profile"),
    findEmail: people("findEmail"), verifyEmail: people("verifyEmail"),
    /** True when a treg token is saved where a lookup would run (the desktop app when it is connected, else this server). */
    peopleAvailable: () => !!((link.state.online && link.state.config && link.state.config.peopleSearch) || (own.people && own.people.available())),
    /** { kind: "app" | "own", label } or null when nothing can generate. */
    describe() {
      const c = choice();
      if (c === "app") return { kind: "app", label: `Cold desktop app · ${link.state.config.model}` };
      if (c === "own") return { kind: "own", label: own.label() };
      return null;
    },
    choice,
  };
}
