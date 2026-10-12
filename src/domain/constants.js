// Fixed vocabulary shared by every layer. Values mirror the saved-data format; do not rename keys.

export const STORAGE_KEYS = {
  products: "cold.products",
  emails: "cold.emails",
  settings: "cold.settings",
  compose: "cold.compose",
  gatewayModel: "cold.gatewayModel",
  sync: "cold.sync",       // what is waiting to reach the desktop app, and when it last synced
  hub: "cold.hub",         // this page's pairing with the desktop app
  access: "cold.access",
};

// The library shared through Cold Desktop is a separate cache from the standalone library above, one per desktop app address, so
// choosing it never moves, merges or rewrites the standalone library (or another app's). A pairing made before this existed keeps
// syncing the standalone keys, as it always did.
export const sharedKeys = origin => { const k = `cold.shared.${encodeURIComponent(origin)}`; return { products: `${k}.products`, emails: `${k}.emails`, settings: `${k}.settings`, compose: `${k}.compose`, sync: `${k}.sync` }; };

export const GOALS = {
  advice:       { label: "Advice",                tpl: "Could I get your take on X?" },
  investment:   { label: "Investment",            tpl: "Would you be open to taking a look at what we're building?" },
  introduction: { label: "Introduction",          tpl: "If X comes to mind, would you introduce us?" },
  customer:     { label: "Customer conversation", tpl: "Would you be willing to tell me whether this is a problem you're seeing?" },
  partnership:  { label: "Partnership",           tpl: "Would you be open to exploring whether this could fit with what you're building?" },
  other:        { label: "Other",                 tpl: "" },
};

export const PROOF_TYPES = ["Customer", "Revenue / growth", "Launch", "Adoption", "Technical", "Institution", "Background"];
export const PROOF_STRENGTHS = ["High", "Medium", "Low"];
export const STATUSES = ["draft", "sent", "replied"];
// What `statusOf` reports for a status this client doesn't recognise (legacy or from a newer Cold). The stored value is never rewritten.
export const UNKNOWN_STATUS = "unknown";

// What each status means in the UI. "sent" and "replied" are always the user's own record.
export const STATUS_COPY = {
  draft:   { label: "Draft", detail: "Not marked as sent" },
  sent:    { label: "Marked sent", detail: "You marked this as sent" },
  replied: { label: "Reply recorded", detail: "You recorded a reply" },
  unknown: { label: "Unknown status", detail: "Saved with a status this version of Cold doesn't recognise. It is kept as it is until you choose one." },
};

// What the Write screen offers. Replies and original tweets are one "tweet" choice with a sub-choice; saved records keep
// the finer-grained FORMATS below ("reply" / "tweet") so History and older drafts read the same as before.
export const FORMAT_CHOICES = { email: { label: "Cold email" }, tweet: { label: "Tweet" } };
export const TWEET_KINDS = { reply: { label: "Reply to a tweet" }, original: { label: "Original tweet" } };
export const TWEET_USE = {
  auto: "Automatic",
  feature: "Feature the product",
  relevant: "Mention it only if it fits",
  none: "Don't mention the product",
};

export const FORMATS = {
  email: { label: "Cold email" },
  reply: { label: "Tweet reply" },
  tweet: { label: "Original tweet" },
};

// kind: "local" = computed in the browser, "model" = the model's own self-assessment, "both" = either can fail it.
export const RULES = [
  { n: 1,  label: "Opens with what you do",              kind: "model", w: 8 },
  { n: 2,  label: "Says why it matters to them",          kind: "model", w: 4 },
  { n: 3,  label: "Third sentence is the ask",            kind: "model", w: 4 },
  { n: 4,  label: "Three sentences",                      kind: "local", w: 4 },
  { n: 5,  label: "40–80 words",                          kind: "local", w: 4 },
  { n: 6,  label: "Under a minute to read",               kind: "local", w: 4 },
  { n: 7,  label: "No stock opener",                      kind: "local", w: 4 },
  { n: 8,  label: "Plain English, no needless jargon",    kind: "model", w: 4 },
  { n: 9,  label: "No marketing or corporate language",   kind: "both",  w: 4 },
  { n: 10, label: "Sounds like a person said it",         kind: "model", w: 4 },
  { n: 11, label: "Specific reason for contacting them",  kind: "model", w: 8 },
  { n: 12, label: "No manufactured commonality",          kind: "model", w: 8 },
  { n: 13, label: "One proof point, not five",            kind: "model", w: 4 },
  { n: 14, label: "Proof comes from your knowledge base", kind: "model", w: 8 },
  { n: 15, label: "No invented facts",                    kind: "model", w: 8 },
  { n: 16, label: "Respects do-not-say rules",            kind: "both",  w: 8 },
  { n: 17, label: "One goal",                             kind: "model", w: 4 },
  { n: 18, label: "Explicit ask",                         kind: "both",  w: 8 },
  { n: 19, label: "No meeting request",                   kind: "both",  w: 8 },
  { n: 20, label: "Subject a human would type",           kind: "local", w: 4 },
];

export const RULE_TEXT = {
  1: "Sentence 1 explains, in plain English, what the product does / what the sender does.",
  2: "Sentence 2 says why it matters to this specific person.",
  3: "Sentence 3 is the ask, on its own line.",
  4: "Exactly three sentences in the body.",
  5: "40–80 words in the body.",
  6: "Readable in well under 60 seconds.",
  7: "Never opens with pleasantries: no 'Hope you're doing well', 'I wanted to reach out', 'I've been following your work', 'My name is'.",
  8: "Plain English; no technical terms the recipient wouldn't use themselves.",
  9: "No marketing or corporate language (revolutionize, seamless, leverage, cutting-edge, unlock, synergy, etc.).",
  10: "No AI-sounding phrasing; direct, conversational, confident, understated. Something you'd say standing next to them.",
  11: "The reason for contacting them is specific to them (their problem, work or writing), not generic (their title or company).",
  12: "Any commonality or connection comes only from what the sender supplied. Nothing manufactured.",
  13: "Uses at most one proof point.",
  14: "Any proof used is a KNOWLEDGE proof item allowed for external use.",
  15: "No invented customers, revenue, users, partners, investors, capabilities, relationships or commonalities.",
  16: "Honors every DO NOT SAY rule.",
  17: "Pursues exactly one goal.",
  18: "The ask is explicit and phrased as a question matching the chosen goal.",
  19: "Does not ask for a meeting, call, chat, demo or calendar time. The recipient picks the next step.",
  20: "Subject is 1–6 words and reads like a person typed it (not 'Exciting opportunity', 'Introducing X', 'Following up', 'AI-powered').",
};

export const MARKETING = ["revolutioniz", "cutting-edge", "cutting edge", "game-chang", "game chang", "seamless", "leverag", "synerg", "best-in-class", "world-class", "innovative", "disrupt", "unlock", "empower", "next-generation", "next-gen", "paradigm", "delve", "transformative", "state-of-the-art", "thrilled", "excited to", "touch base", "circle back", "value proposition", "supercharge", "unparalleled", "elevate", "streamline", "harness", "i hope this", "reach out"];
export const OPENERS = [/hope (you('|’)re|you are|this (email |note )?finds)/i, /wanted to reach out/i, /(i('|’)m|i am) reaching out/i, /(i('|’)ve|i have) been following/i, /\bmy name is\b/i, /just wanted to/i, /quick intro/i];
export const MEETING = /\b(meeting|meet up|meet with|(a|quick|short|brief|\d+)[- ]?(min(ute)?s?[- ])?(call|chat)|jump on|hop on|calendar|calendly|zoom|book (a |some )?time|schedule (a|some)|grab (a )?coffee|find (a |some )?time|demo)\b/i;
export const BAD_SUBJECT = /(revolutioniz|exciting opportunity|partnership opportunity|^introducing\b|following up|follow[- ]up|ai[- ]powered|game[- ]chang|!)/i;
