// The Tweet half of Write: one mode with two kinds, "reply to a tweet" (link and/or pasted text) and "original tweet".
// Product use is chosen here; the product itself comes from the shared product picker in Write.
import { h } from "../components/dom.js";
import { field, textInput, textArea, button, announce } from "../components/ui.js";
import { TWEET_KINDS, TWEET_USE } from "../domain/constants.js";
import { describeError } from "../services/generation.js";

const TWEET_URL = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+(?:[/?#].*)?$/i;

export function createTweetForm({ platform, persist }) {
  const tweetUrl = field({ id: "tweetUrl", label: "Tweet link", hint: "Paste the link and use “Fetch tweet” to read its text, or just paste the text below.", control: textInput({ placeholder: "https://x.com/username/status/123", inputmode: "url" }) });
  const tweetContext = field({ id: "tweetContext", label: "", hint: "-", required: true, control: textArea({ rows: 4 }) });
  const tweetPoint = field({ id: "tweetPoint", label: "What do you want to say back?", required: null, hint: "Your point, angle or answer, in your own words: “agree, and add that…”, “push back on…”, “ask how they…”. Leave it blank and Cold writes a reply from the tweet alone.", control: textArea({ rows: 3, placeholder: "e.g. Agree, and mention we hit the same problem moving batch jobs" }) });
  const use = h("select", { id: "tweetUse" }, Object.entries(TWEET_USE).map(([k, label]) => h("option", { value: k === "auto" ? "" : k }, label)));
  const useField = h("div", { class: "field" }, h("label", { for: "tweetUse" }, "Product in this tweet"), h("p", { class: "hint" }, "Automatic features the product in an original tweet and mentions it in a reply only when it fits. Its X handle and website come from Knowledge."), use);
  const kinds = Object.entries(TWEET_KINDS).map(([k, v]) => h("label", {}, h("input", { type: "radio", name: "tweetKind", value: k, id: `tk-${k}` }), v.label));
  const status = h("p", { class: "hint", id: "tweetStatus", role: "status" });
  const fetchBtn = button("Fetch tweet", { id: "fetchTweetBtn", onclick: () => fetchTweet() });
  const linkRow = h("div", { class: "field", id: "tweetLinkRow" },
    h("label", { for: "tweetUrl" }, "Tweet link ", h("span", { class: "opt" }, "Optional")),
    h("p", { class: "hint", id: "tweetUrl-hint" }, "Paste the link and use “Fetch tweet” to read its text, or paste the text below."),
    h("div", { class: "actions inline-input" }, tweetUrl.input, fetchBtn), h("p", { class: "field-error", id: "tweetUrl-err", hidden: true }), status);
  tweetUrl.input.setAttribute("aria-describedby", "tweetUrl-hint tweetUrl-err tweetStatus");
  let author = "";

  const el = h("div", { class: "form", id: "socialGroup" },
    h("fieldset", {}, h("legend", {}, "What kind of tweet?"), h("div", { class: "pills", role: "radiogroup", "aria-label": "Tweet kind" }, kinds)),
    linkRow, tweetContext, tweetPoint,
    h("p", { class: "hint" }, "Drafts stay within X's 280 weighted-character limit. You review and post it yourself."));

  const kind = () => (el.querySelector('input[name="tweetKind"]:checked') || {}).value || "reply";
  const val = c => c.input.value.trim();

  async function fetchTweet() {
    const link = val(tweetUrl);
    if (!TWEET_URL.test(link)) { status.textContent = "Paste a link to a single tweet, like x.com/username/status/123."; tweetUrl.input.focus(); return; }
    fetchBtn.disabled = true; fetchBtn.textContent = "Fetching…"; status.textContent = "Reading the tweet…";
    try {
      const res = await platform.api.tweet(link);
      if (!res.ok) status.textContent = res.message;
      else {
        tweetContext.input.value = res.text; author = res.handle ? `@${res.handle}` : "";
        status.textContent = `Got ${author ? author + "'s" : "the"} tweet. Check the text below.`; persist();
      }
    } catch (e) { const d = describeError(e); status.textContent = d ? d.message : ""; }
    finally { fetchBtn.disabled = false; fetchBtn.textContent = "Fetch tweet"; announce(status.textContent); }
  }
  tweetUrl.input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); fetchTweet(); } });
  tweetUrl.input.addEventListener("input", () => { author = ""; });

  function sync() {
    const reply = kind() === "reply";
    linkRow.hidden = !reply; tweetPoint.hidden = !reply;
    tweetContext.querySelector("label").firstChild.textContent = reply ? "The tweet you're replying to" : "What you want to say";
    tweetContext.querySelector(".hint").textContent = reply ? "The tweet's text. “Fetch tweet” fills this in from the link; you can also paste it or edit it." : "A topic, a rough draft, or the point you want to make. Cold writes the tweet you'll post.";
    tweetContext.input.placeholder = reply ? "Paste the tweet text" : "e.g. We just shipped scheduled jobs on edge servers";
  }

  return {
    el, sync, useField,
    /** { mode: "reply" | "tweet", ... } uses the same mode names as saved records. */
    read: () => ({ mode: kind() === "reply" ? "reply" : "tweet", tweetUrl: val(tweetUrl), tweetContext: val(tweetContext), tweetAuthor: author, tweetUse: use.value, tweetPoint: val(tweetPoint) }),
    fill(d = {}) {
      const r = el.querySelector(`#tk-${d.mode === "tweet" ? "original" : "reply"}`); if (r) r.checked = true;
      tweetUrl.input.value = d.tweetUrl || ""; tweetContext.input.value = d.tweetContext || ""; author = d.tweetAuthor || ""; tweetPoint.input.value = d.tweetPoint || "";
      use.value = [...use.options].some(o => o.value === d.tweetUse) ? d.tweetUse : ""; status.textContent = ""; sync();
    },
    validate(v, need) {
      need(tweetContext, v.tweetContext, v.mode === "reply" ? "Paste the tweet you're replying to, or use “Fetch tweet” with its link." : "Say what the tweet should be about.", v.mode === "reply" ? "Tweet to reply to" : "What you want to say");
      need(tweetUrl, !v.tweetUrl || TWEET_URL.test(v.tweetUrl), "Use a valid x.com or twitter.com status link, or leave it empty.", "Tweet link");
    },
    clearErrors() { tweetUrl.setError(""); tweetContext.setError(""); tweetPoint.setError(""); },
  };
}
