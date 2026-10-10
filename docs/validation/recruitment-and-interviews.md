# Recruitment, interview and offer protocol

## 1. Who and where
Target: bootstrapped B2B founders, live or beta product, fewer than 20 paying customers, with a first-hand customer-acquisition attempt in the last 60 days.

Sources, in order of preference:
1. The operator's existing professional relationships (warm intros). Record as `warm`.
2. Founder communities the operator already belongs to (Indie Hackers, relevant subreddits, Slack/Discord groups).
3. Public posts where a founder describes a recent acquisition attempt, answered with a genuine comment or a single personalized message.

Rules: read each community's current rules first, and skip any that ban solicitation or research requests. No bulk or templated mass messages; every message references something the person actually wrote. One message per person, one follow-up at most. No paid ads. Stop on any "no" and log it. Do not scrape or compile contact lists. The operator sends all messages personally; this package does not send anything.

I have not verified any community's current rules and have not identified individuals.

## 2. Recruitment message (personalize the bracketed parts; 3 sentences)
> Hi [name]. I read your [post/comment] about [specific thing they said about getting customers]. I'm researching how early B2B founders actually find and talk to their first customers, and I'm not selling anything in this conversation. Would you be open to a 25-minute call about what you've tried, with the option to say no at any point?

Follow-up (once, after 4 days): "No pressure; if the timing's bad I'll leave it there."

## 3. Consent (read aloud or send before the call)
"I'll take notes, not a recording unless you agree. I'll store your answers under an anonymous ID without your name or company, and I won't share anything that identifies you. You can skip any question or stop at any time. I may ask later to show how I'd use what you described; that is optional. Is it OK to quote you anonymously?" Record yes/no per participant (`quote_consent`).

## 4. Problem interview (25 min; no pitch of Cold until all nine are done)
1. Describe the last time you tried to acquire a customer.
2. How did you identify whom to approach?
3. How did you decide what to say?
4. How much time did the process take?
5. What response or business outcome did you get?
6. What have you already tried, and what failed?
7. Which tools, services or people do you currently pay for? How much per month?
8. What would happen if the problem remained unsolved for another three months?
9. What have you done about it recently?

Probes: "Can you show me the message you sent, if you're comfortable?" "How many people, over how long?" "What did that cost you?" Do not ask for customer-confidential data or names of customers. Never ask "would you use/pay for X?". Mark each answer observed (seen), self-reported or inferred.

Qualify after question 9 using the definition in `decision-criteria.md`. Unqualified interviews are still logged and counted separately.

## 5. Demo and comparison (only for qualified founders who agree)
Run locally per the README safety note. Do not use real prospect personal data beyond what is publicly available and what the founder supplies.

**Offer A comparison, per founder (target 3 prospects each):**
1. Founder supplies the same inputs for each prospect: product facts, the prospect, the reason, and the goal.
2. Produce three drafts per prospect: (X) Cold, (Y) the founder's usual method, written live or taken from a recent message, (Z) a competent saved prompt in a general assistant. The prompt must be written beforehand, kept in the tracker notes verbatim, and reused for every founder. It must receive the same knowledge and instructions in a comparable form (a fair prompt, not a strawman). Record the model used for both.
3. Randomize the order shown using a fixed draw made before the session (e.g. coin flip logged in advance). Label drafts neutrally (1, 2, 3).
4. Ask: which would you actually send, why, what would you change? Measure: preparation and review minutes (timed), edits made, unsupported or invented claims (check each factual claim against the supplied facts; count them), and whether the founder says it beats their present method.
5. Record preference as preference. It is not evidence of better replies.

**Offers B and C:** show a 3-prospect sample from public sources with the reason each is relevant; record whether each is relevant (founder's yes/no), whether they accept the shortlist, and whether they commit to act on it.

## 6. Presenting an offer
Present only after the interview and demo. Use the frozen text in `offers.md`; do not discount, bundle or pressure. Say: "This is a paid pilot at [price]. You can say no. If it's yes, the next step is [payment/date]."

Record one of: `paid` (money received, date) · `committed` (written terms, date, price; payment not received) · `next_step` (dated action) · `declined` (stated reason, verbatim if consented) · `no_decision` · `no_response`. Verbal interest alone is `interest_only` and does not count toward any pass criterion.

If payment cannot be taken, record the agreed terms and mark payment outstanding. Do not claim payment validation.

## 7. Pilot delivery notes
Use only the founder's supplied or public information. Hours spent per task are logged. Deletion of founder data at the end unless consent to keep. Results are reported as measured counts (messages sent, replies, conversations held) and never as a rate claim from a sample this small.

## 8. Logging
After each session, within 24 hours, fill a row in `tracker/participants.csv`. Contact details go only in `tracker/contacts.private.csv` (git-ignored). Funnel counts go in `tracker/funnel.csv`. No transcripts in the repo.
