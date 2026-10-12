// Functions injected into the active tab. Each one must be fully self-contained (it is serialised and run in the page).
// They only read what the signed-in user can already see, or type into the page's own text box. They never click Post.

/** What is on screen: a tweet (text + handle) or the page's main text for the model to read. */
export function readPage() {
  const clean = s => String(s || "").replace(/\n{3,}/g, "\n\n").trim();
  const url = location.href, host = location.hostname.replace(/^www\./, "");
  if (/(^|\.)(x|twitter)\.com$/.test(host)) {
    const article = document.querySelector('article[data-testid="tweet"]');
    const body = article && article.querySelector('[data-testid="tweetText"]');
    if (/\/status\/\d+/.test(location.pathname) && body) {
      const who = article.querySelector('[data-testid="User-Name"]');
      const handle = who && (who.innerText.match(/@\w{1,15}/) || [])[0];
      return { kind: "tweet", url, text: clean(body.innerText), handle: handle || "", author: who ? who.innerText.split("\n")[0] : "" };
    }
  }
  const main = document.querySelector("main") || document.body;
  return { kind: "page", url, title: document.title, text: clean(main.innerText).slice(0, 6000) };
}

/** Types text into the page's tweet / reply box. Returns { ok, message }. Does not post. */
export function insertIntoBox(text) {
  const box = document.querySelector('[data-testid="tweetTextarea_0"] [contenteditable="true"], [data-testid="tweetTextarea_0"][contenteditable="true"], div[role="textbox"][contenteditable="true"]');
  if (!box) return { ok: false, message: "Couldn't find the tweet box on this page. Copy the text instead." };
  box.focus();
  document.execCommand("selectAll", false);
  const done = document.execCommand("insertText", false, text);
  return done ? { ok: true, message: "Inserted. Review it and post it yourself." } : { ok: false, message: "The page wouldn't accept the text. Copy it instead." };
}

/** Classifies a URL so the panel can suggest the right mode. */
export function classify(url) {
  let u; try { u = new URL(url); } catch { return { kind: "other" }; }
  const host = u.hostname.replace(/^www\./, "");
  if (/(^|\.)(x|twitter)\.com$/.test(host)) return /^\/[^/]+\/status\/\d+/.test(u.pathname) ? { kind: "tweet", site: "X" } : /^\/(home|compose|i)(\/|$)/.test(u.pathname) ? { kind: "compose", site: "X" } : /^\/[A-Za-z0-9_]{1,15}\/?$/.test(u.pathname) ? { kind: "profile", site: "X" } : { kind: "other", site: "X" };
  if (host === "linkedin.com") return /^\/in\/[^/]+/.test(u.pathname) ? { kind: "profile", site: "LinkedIn" } : { kind: "other", site: "LinkedIn" };
  return { kind: "other" };
}
