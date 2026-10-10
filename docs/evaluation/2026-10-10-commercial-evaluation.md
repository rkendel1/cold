# Cold: commercial evaluation (2026-10-10)

**Scope:** evaluation only. No product code was changed. The only additions are this report and `e2e-mock-check.cjs` (a reproducible check; no new dependencies).
**Evaluator limits, stated up front:**
- No customer was contacted. There are **no interviews, no payments and no pilots**. Every claim about demand below is a hypothesis or a secondary-source observation.
- The deployed demo (`https://cold-gamma.vercel.app/`) **could not be reached** from the evaluation sandbox (DNS failure; proxy returned 403). Nothing here claims the production deployment works. All verification is of the repository code, run locally.
- Market sources came from web search snippets. Several fetches (e.g. Indie Hackers) failed from the sandbox. Most pricing pages are third-party guides and vendor blogs, not first-party pages. Every price is marked **secondary, re-verify before use**.

Evidence labels used throughout: **[F]** fact (code, test, or cited source), **[S]** customer statement (secondhand, unverified), **[H]** hypothesis.

---

## A. Current-state audit

### What Cold is
A single-file browser app (`index.html`, ~1,270 lines) plus a dependency-free Node server (`server.js`, 187 lines). The only runtime dependency is `twitter-text`, used for the tweet counter. It writes one three-sentence cold email per request. Sending is manual (copy/paste). There is no auth, no database, and no enrichment.

### Tests run
| Command | Result |
|---|---|
| `node --test test/*.test.js` | 9/9 pass. These cover the provider adapter (credentials stay server-side, response normalization, model allow-listing), the HF-SSH experiment (mocked), and the tweet length rule. |
| `node docs/evaluation/e2e-mock-check.cjs` (Chromium + a **mock** Anthropic endpoint) | Passes. It proves the UI, server, two-call pipeline, local persistence and status tracking are wired together. It does **not** test output quality. |

The unit tests cover server/provider plumbing only. **No test covers the email prompt, the 20-rule engine, `buildKnowledge`, or the claim-tracing logic.** The E2E check is mine, not part of the repo's own suite.

### Capability matrix
| Capability | Status | Evidence |
|---|---|---|
| Product knowledge: description, audience, problem, proof (type/strength/external flag), tech facts, approved language, do-not-say | **Verified** (storage and prompt inclusion) | E2E: seeded product reaches the prompt; the internal-only proof item is excluded from the prompt (`buildKnowledge`, `index.html:653`). |
| Recipient and company context (name, role, company) | **Verified** as free-text fields | Required fields are name, company and why-them. Nothing is fetched or enriched. Cold knows only what the user types. |
| User's reason for contacting ("Why them") | **Verified** as a required text input | Generation is blocked without it. The prompt says it is "the only connection you may use". |
| Desired outcome / constraints | **Verified** (6 fixed goals plus "other") | Each goal maps to an ask template. The no-meeting-request constraint is hard-coded and cannot be changed. |
| Two-stage email generation (draft, then editor against 20 rules) | **Partially implemented** | Plumbing is verified with a mock. Real model output was **not** evaluated (no model credentials or budget in this PR). |
| "Every claim traced to a knowledge record" (README) | **Partially implemented / overstated** | The model itself self-reports `claims[].source`. Nothing in code verifies those claims against the facts. Local rules check only length, sentence count, stock openers, banned words, do-not-say phrases, question mark, meeting regex and subject. The "no invented facts" rule is a **model self-grade**. |
| Quality score 0–100 | **Partially implemented** | About 55% of the weight (rules 1–3, 8, 10–15, 17) is model self-assessment. The score is not validated against replies. |
| Tweet reply / original tweet | **Partially implemented** | Valid 280-weighted-char counter (tested). Source tweet must be pasted. Drafts are not scored. Out of scope for the commercial question. |
| Model/provider selection | **Verified** (mocked) | AI Gateway (default) or Anthropic, chosen via env var. The Gateway model dropdown is fed from the live catalog. The HF-SSH provider is an explicitly unverified experiment that must be enabled (`provider-config.json` currently selects it in Vercel *preview* only). |
| Persistence | **Verified**, browser localStorage only | E2E: draft saved with 26 fields. Single device and single browser. Clearing site data loses the knowledge base and history. There is no export. In Claude-artifact mode it uses `window.claude` db (not tested). |
| History + outcome tracking | **Partially implemented** | The status enum is `draft/sent/replied`. `sentAt` is stamped; **no `repliedAt`**, no reply content, no outcome (call booked, trial, paid), no follow-up, no per-segment view. |
| Error handling | **Verified** for provider errors (401/404/429/5xx map to messages, tested); invalid-JSON failure is a user-facing message only, with no automatic retry | Tests in `test/provider.test.js` |
| Onboarding | **Minimal** | "Load starter set" inserts the author's own five products (Compute, FeltDB, AppPort, AppBoundry, Attn). There is no guided first-run flow. |
| Deployment / cost | **Unverified in production** | Needs a Gateway key or Vercel OIDC and credits. README warns there is **no app auth**, so anyone with the URL can spend credits. Cost per email = 2 LLM calls (about 2k max tokens each; actual dollar cost not measured). |
| Prospect identification / list building | **Missing** | |
| Positioning / ICP discovery | **Missing** (Cold takes positioning as input) | |
| Sending, sequencing, follow-ups, inbox sync | **Missing** (deliberate: "Cold never sends") | |
| Multi-user / team / auth / billing | **Missing** | |

### Technical risks
1. **Prompt-injection and fabrication surface.** Product and recipient text go straight into prompts. No post-hoc fact check exists.
2. **Open endpoint.** `/api/generate` is unauthenticated and spends credits. This is a blocker for any paid pilot hosted on that deployment.
3. **Data is local-only.** A founder who clears the browser loses their knowledge base.
4. **Hard-coded opinion.** Exactly 3 sentences, 40–80 words, and "no meeting request" are fixed. That is strong for peer-style asks and wrong for founders whose goal is a booked demo.
5. **Score ≠ outcome.** There is no data connecting a "Ready to send 92" score to replies.

---

## B. Customer and market evidence

### Interview results
**None.** Zero interviews were run by this PR. Section F specifies the experiment.

### Dated secondary findings (all re-verify before relying on them)
- **[S] Prospect identification is often the real blocker.** A founder post surfaced in search ("what 2 months of cold outreach taught me…", Indie Hackers) argues the real blocker was not knowing who to email and that "a sequencer with a bad ICP is just scaled spam". It was paraphrased in the search result; the page itself could not be fetched. Single anecdote; the author may sell a tool.
- **[S] Specificity beats generic AI copy.** Another Indie Hackers founder post (via search snippet) reports replies when the email named a playbook the prospect had probably already built, versus none for "Save 10 hours a week". Single anecdote.
- **[S] Recipients reject text that reads as AI-generated.** A vendor blog quotes a Reddit user: AI cold mails "go directly to the trash". This is secondhand, from a vendor with an interest.
- **[S] Willingness to pay for a thin AI-writer looks low.** One validation post for an AI personalization tool received mixed replies, "mostly at <$20/month pricing" (Indie Hackers, via snippet).
- **[F, weak] Unverified statistic.** A vendor-cited "56% higher reply rate with two custom attributes" appeared in results. It is **not used** in this analysis because it could not be traced to a primary study.

None of these shows demand for Cold. They show a pain consistent with the hypothesis and a warning that the email-writing step is the cheapest, most commoditised part.

---

## C. Competitive assessment

Prices are monthly USD, **secondary sources (search results, July–Oct 2026)**, which often disagree. Product capability claims below are what vendors market, not tested by me.

| Alternative | Job / target | Price evidence (secondary) | Gap or complaint evidence | What Cold could do better | What Cold can't do that it can |
|---|---|---|---|---|---|
| ChatGPT / Claude with a saved prompt or Project | General assistant; any founder | Plus and Claude Pro about $20/mo; $100–$200 tiers (conflicting sources) | Output quality depends on the user's prompt and knowledge | Persistent structured knowledge base, enforced truth rules, local lint, history | Web research on the recipient, free-form strategy and positioning chat, no extra cost if already subscribed |
| Lavender | Email coaching and AI personalization in the inbox | Free (5/mo); Starter about $27–29; Pro about $45–49; Team $69–99/seat (sources conflict) | Review sites flag price-vs-value questions | Product-grounded claims; opinionated structure | Works inside Gmail/Outlook; scores any email; some social/prospect context |
| Instantly | High-volume cold email sending infrastructure | Growth about $37.60–47; Hypergrowth about $77.60–97; lead credits and bundles extra, working setup about $94–194+ | Competes on sending and deliverability, not writing | Better per-email relevance (hypothesis) | Sending, warm-up, mailboxes, sequences, lead data |
| Lemlist | Multichannel sequences and personalization | About $69–79 (email) and $99–109 (multichannel) per user; estimates of $130–160 all-in | Seat price understates real cost per several guides | Simpler and cheaper for a founder sending dozens of emails | Sequencing, LinkedIn, images/video personalisation, enrichment |
| Apollo | Prospect database plus sequencing | Free; Basic about $49–59, Pro about $79–99, Org about $119–149 per user | Credit limits; sources conflict on free-tier terms | Nothing on data | Finds prospects: the thing Cold does not do |
| Clay | Research/enrichment workflows with AI | Free (100 credits); Launch about $185; Growth about $495; Enterprise about $30k/yr | Credit consumption can balloon; overage reported at +50% | Far simpler | Programmatic prospect research and signals at scale |
| Fractional CMO / outbound agency | Done-for-you | Fractional CMO about $5k–15k/mo (vendor-published); appointment setting about $3k–8k/mo or $150–750 per appointment | Cost per *qualified* meeting reported as often 2×+ headline | Not a replacement | The whole job, with a human judging fit |
| Manual (founder alone) | — | $0 cash | Time and inconsistency (the hypothesis) | — | — |

**Strongest reason a prospect picks an alternative over Cold:** for under about $20–30/month they get a general assistant (or Lavender) that already writes emails. For prospecting they need Apollo/Clay, which Cold lacks. Cold's moat is structured, enforced grounding, and the editor-pass rule engine is easy to replicate in a saved prompt.

---

## D. Commercial assessment

### Segments ranked (confidence is in the *ranking*, not in demand)
| # | Segment | Urgency / frequency | $ consequence | Existing spend | Reachability | Fit with Cold today | Time to value | Why they might not buy | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Bootstrapped B2B founders seeking first 5–20 customers** | High, but episodic | Direct: no customers means no revenue | Low-moderate (Apollo, ChatGPT, maybe a VA) | Medium (IH, founder communities, YC/indie forums) | **Best**: customer-conversation goal, advice goal, "no meeting" peer-style asks fit discovery outreach | Days (first replies within a week of sending 20–30) | They don't know whom to email (Cold can't help); $20 ChatGPT is "good enough" | **Low–Medium** |
| 2 | Founders already doing outbound | High, continuous | Moderate | **Highest** ($50–$500/mo stacks) | Medium | Medium: they need volume, sequencing and data, which Cold has none of | Fast but incremental | Already own Lemlist/Instantly + Clay; Cold is a smaller step | Low–Medium |
| 3 | Technical founders who avoid marketing | High | Direct | Low | **Good** (communities, dev Twitter) | Good: product facts are strong; they dislike writing | Days | Won't pay for "copy"; will build a script | Low |
| 4 | Independent consultants / small service businesses | High, recurring | High per client | Moderate | Good | Weaker: product-centric "proof/tech facts" fit poorly; need service positioning | Days | Referral-driven; may need warm-intro writing | Low |
| 5 | Solo founders with no channel | Medium | Unclear | Lowest | Easy but low-intent | Poor: need positioning and ICP before copy | Weeks | Problem is upstream of email | Low |

Ranking rests on fit with the existing implementation and plausible spend. No behavioural evidence yet supports any ordering.

### Which problem is actually being purchased away?
Of the six candidates in the brief, Cold today touches **only 5 (outbound) in part** and, via its goal templates, a thin slice of **2 (customer discovery)**. It does not do positioning (1), distribution (3), founder-led content (4) or conversion (6) in any meaningful way; it does not help choose *who* to contact.

**Narrowest credible job (hypothesis [H]):** "Get from a short list of people I already believe are relevant to a few real conversations this week, without sounding like a mass email." The founder would pay to save time and reduce embarrassment, not for the text itself.

### Pricing hypotheses (all [H], none tested)
| Offer | Price | Support | Contradiction |
|---|---|---|---|
| Self-serve tool | $15–29/mo | Lavender Starter $27–29; one thread saw "<$20" interest | Competes directly with a $20 general assistant; weak margin after LLM cost |
| Founder pilot: "20 researched prospects and drafts in 2 weeks, reviewed with you" | $300–$750 fixed | Between a tool and agency ($3k–8k/mo); buys an *outcome* | Delivering it manually is a service business, and the research is the human's work |
| Tool + weekly prospect/review loop | $79–149/mo | Between Lemlist/Apollo tiers | Requires the missing prospecting and tracking pieces |

---

## E. Product gap analysis

| Gap | Customer problem | Evidence | Cost of leaving | Smallest intervention | Test before building | Confidence / priority |
|---|---|---|---|---|---|---|
| **No help deciding who to contact** | "I don't know who to email" | [S] one founder post; segment logic | Cold is reduced to a better prompt | None yet. Founder supplies a list; the pilot manually supplies 20 names | Do the research by hand for 5 pilot founders; measure whether they would have found them, and whether replies result | Medium / **P1** |
| **No outcome capture** (no repliedAt, reply text, next step) | Can't tell if it worked | [F] code | No learning loop; cannot prove value or retention | Add timestamp and a one-line outcome to the existing status control | Track the pilot in a spreadsheet and see whether founders keep it up to date | High / **P1** |
| **Grounding is self-reported by the model** | Trust: "does it invent things?" | [F] code (`claims` from model) | A single fabricated claim destroys trust | Deterministic check: any number/name in the output must appear in the knowledge or why-them text | Run 30 generations across 5 real knowledge bases; hand-count fabrications | High / **P1** (cheap, pre-pilot) |
| **No quality evidence vs plain ChatGPT** | "Why not a prompt?" | [F] none gathered | No differentiation story | None | Blind A/B: Cold vs a good saved prompt, same inputs, 3+ founders pick | Medium / **P1** |
| **Persistence is browser-only; no export** | Data loss; no multi-device | [F] code | Lose pilot data | Export/import JSON | Ask pilot founders whether they would be blocked | Medium / P2 |
| **Open unauthenticated endpoint** | Cost and abuse | [F] README | Surprise bill | Don't host the pilot publicly; run locally or add a shared password | n/a (hygiene) | High / P2 |
| **Fixed no-meeting, 3-sentence style** | Founders often want a demo or call | [F] code | May fail for sales-oriented founders | Make it a toggle | Show the output to 5 founders and see whether they edit the ask | Low / P3 |
| **No first-run onboarding** | Setup cost before first value | [F] code | Drop-off | Interview-led setup by the evaluator | Time setup in pilot sessions | Low / P3 |
| Sending/sequencing, enrichment, team features | Competitors have them | [F] competitor docs | n/a | **Do not build**: it would erase the differentiator without proof of demand | n/a | n/a / out of scope |

---

## F. Validation experiment (2 weeks, time-boxed)

**Who to approach (real places, none contacted yet):** Indie Hackers "launches/asking for feedback" threads; r/SaaS and r/startups; founder Slack/Discord communities the author belongs to; warm network of B2B bootstrapped founders with fewer than 20 customers. Target: 25 outreach messages, 8–10 interviews.

**Screening:** B2B product, live or beta, under 20 paying customers, founder does their own outreach, posted about customer acquisition within the last 60 days.

**Problem-interview script (no pitch, 25 minutes):**
1. Tell me about the last time you tried to get a customer conversation. What exactly did you do?
2. How many people did you contact, how did you pick them, how long did it take?
3. What happened? Replies, calls, trials, revenue?
4. What have you tried that failed? Why?
5. What tools or people do you use now, and what do they cost per month?
6. What did the last month of this effort cost you in time and money?
7. If it kept going like this for 3 more months, what would happen?
8. What did you do about it this week?

**Demo (only after question 8):** show Cold with their product (knowledge entered live, about 10 min) and 3 of their real prospects. Record: which output they edited, which they would send, and whether they asked "where do I find these people?"

**Paid-pilot offer to test:** *"For $500, over two weeks, I'll help you run 20 outreach attempts to prospects you pick, using Cold for drafts. We review replies together at day 7 and day 14."* Success outcome: at least 2 real conversations. Price anchors: between ChatGPT and agencies. Refund guarantee is an option to test.

**Follow-up log:** for each prospect record date, interview source, current spend, pain evidence, offer shown, response (paid / committed / next step / declined), objection verbatim, and reason for declining.

**Evidence ladder (strongest first):** 1) paid pilot; 2) specific paid commitment with terms; 3) concrete next step after seeing the offer; 4) shows problem plus spend, declines; 5) interest only. Compliments and free sign-ups count as zero.

**Pre-registered criteria**
| Outcome | Criteria (of ~10 qualified interviews) |
|---|---|
| **Pass** | ≥2 pay for the pilot, or ≥4 commit to specific paid terms; at least 6 describe a failed acquisition effort in the last 60 days; a majority prefer Cold's output over their own saved prompt in the blind A/B |
| **Uncertain** | 1 payment or 2–3 commitments, or strong pain but the objection is "I don't know whom to contact" |
| **Fail** | 0 payments and <2 commitments, or most say ChatGPT or a similar tool is enough, or fewer than 5 qualified interviews can be recruited in 2 weeks |

Also record the **pilot outcome**: reply rate from the 20 attempts and count of real conversations. This is behavioural evidence on whether the product works at all.

---

## G. Recommendation: **Narrow and retest**

- **Best initial customer:** bootstrapped B2B founders seeking their first 5–20 customers through peer-style conversation outreach (confidence: low–medium).
- **What they would be paying to accomplish:** turning a list of relevant people they already have into actual customer-discovery conversations this week, without the work of drafting each message. The email text itself is not the purchase.
- **Why not "Proceed":** there is zero behavioural evidence. The writing step overlaps with a $20 general assistant. Cold has nothing for prospect selection. The README's claim of traced, non-invented facts depends on model self-reporting.
- **Why not "Pivot" or "Stop":** the code is clean and honest about its limits, a reproducible pilot is cheap, and the cost to learn is a few weeks of founder conversations rather than engineering.
- **Do before the experiment (no feature work):** the deterministic fabrication check and outcome fields are the only changes worth considering, and only if pilot founders ask for them; start with hand-tracking.

**Evidence that would change the recommendation**
- *Toward Proceed:* ≥2 paid pilots, and pilot founders report real conversations that they credit to the loop, not the prose.
- *Toward Pivot (prospecting, positioning or tracking):* most interviewees say "who to contact" or "what to say" is the pain and show spend on tools for that. Rebuild the proposition around that step.
- *Toward Stop:* the fail criteria above, or blind A/B shows no preference over a saved ChatGPT prompt.

## Answers to the acceptance questions
1. **What does Cold do today?** It turns founder-entered product facts and a founder-entered reason into one three-sentence email, scored against 20 rules, saved locally with manual sent/replied status. See section A.
2. **Who has the most urgent reason to pay?** Hypothesis: bootstrapped B2B founders chasing their first 5–20 customers. Not validated.
3. **What are they paying to accomplish?** Real conversations with relevant people, not email text.
4. **Evidence for and against:** section B (weak, secondary, anecdotal). The only direct evidence is the code audit.
5. **Paid pilot:** section F.
6. **What's missing for that customer?** Prospect selection, outcome capture, verified grounding, and evidence of beating a saved prompt (section E).
7. **What next, and what would justify building?** Run section F; build only what the pass criteria and the interviews call for.

## Reproducing this evaluation
```sh
npm ci
node --test test/*.test.js
PLAYWRIGHT_MODULE=<path to playwright> CHROMIUM=<chrome binary> node docs/evaluation/e2e-mock-check.cjs
```
The E2E script uses a mock LLM and no real credentials.
