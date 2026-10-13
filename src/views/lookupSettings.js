// Settings > Email lookup (treg). The token is saved only by a server that keeps secrets (the desktop app or a local server), is never
// shown again and never reaches the page; an extension never stores one.
import { h } from "../components/dom.js";
import { button } from "../components/ui.js";

export function lookupSection({ platform, field }) {
  const ts = platform.tregSettings, host = h("div", { class: "form", id: "lookupBox" }), msg = h("p", { class: "hint", role: "status", id: "lookupMsg" });
  const about = h("p", { class: "hint" }, "Find email on a lead asks treg (treg.to) for a work email. It sends the person's name and company domain, or their LinkedIn link, and treg may pass them to other data providers it chooses. Nothing is looked up until you press Find email, each lookup is capped at about $0.05, and nothing is saved until you accept it. Not every address returned is accurate.");
  if (!ts) {
    const on = platform.people && platform.people.available();
    return h("div", { class: "form" }, about, h("p", { id: "lookupState" }, on ? "Email lookup is on through the Cold desktop app." : "Email lookup runs through the Cold desktop app, which keeps the treg token. This extension never stores one."));
  }
  const key = h("input", { type: "password", id: "tregKey", autocomplete: "off", spellcheck: "false", placeholder: "treg token" });
  const state = h("p", { id: "lookupState" });
  const paint = st => { state.textContent = st.hasKey ? (st.keyFromEnv ? "A token is set by the server (TREG_TOKEN)." : `A token is saved (ending ${st.keyHint}). It can't be shown again.`) : "No token yet."; };
  const apply = async (v, done) => { try { const st = await ts.save(v); paint(st); key.value = ""; msg.textContent = done; if (platform.refresh) await platform.refresh(); } catch (e) { msg.textContent = (e && e.message) || "Couldn't save."; } };
  ts.status().then(paint).catch(() => { state.textContent = "Couldn't read the lookup status."; });
  host.append(about, field("treg token", key), state,
    h("div", { class: "actions" }, button("Save token", { kind: "primary", id: "tregSave", onclick: () => (key.value.trim() ? apply(key.value, "Saved. It stays on this computer and is never sent to the page.") : (msg.textContent = "Paste a token first.")) }),
      button("Remove token", { kind: "ghost danger", id: "tregRemove", onclick: () => apply(null, "Removed.") })), msg);
  return host;
}
