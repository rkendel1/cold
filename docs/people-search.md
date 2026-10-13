# Find email (treg People Search)

Cold can look for a **missing work email** for a lead you already saved. It asks [treg](https://treg.to) (an API registry that routes
the request to one of many data providers) when, and only when, you press **Find email** on that lead.

> A found address is a **candidate**, not a confirmed identity. A deliverable address is not necessarily the right person's.
> Cold keeps these facts separate and saves nothing until you accept.

## The workflow

Leads → a lead with no email → **Find email** → review the candidate → *Verify deliverability* (optional) → **Accept** or **Reject**.

- The panel appears on a saved lead that has **no email**. A lead that has one is never offered a replacement; change it yourself in the form.
- Cold needs either the lead's **LinkedIn profile link**, or their **name plus a company domain** (typed in the panel for this lookup only and
  not saved). It never guesses a domain or an address. If neither is present it says what to add and sends nothing.
- A candidate shows, as separate things: who found it (the provider treg names), the **source** (treg's routed answer carries none, so Cold says
  so instead of inventing one), the **person-match confidence** exactly as the provider scored it (not proof of identity), whether the provider
  **says** it checked the mailbox (its claim, not a Cold verification), and the **deliverability** result, which stays "Not checked yet" until you ask.
- **Verify** calls treg's verification operation and shows treg's own word with what it does and doesn't mean:
  `valid` (accepts mail; says nothing about who owns it), `invalid`, `accept_all`/`catch_all` (the domain accepts everything, so the mailbox can't be
  confirmed), `risky`, `unknown`/missing (left unknown). A word Cold doesn't know is shown as given and never as success. A failed check is reported as a failure.
- **Accept** saves the address into that lead through the normal lead storage and nothing else changes on the lead. It then flows to *Write* /
  *Open in email* like any typed address. **Reject** discards the candidate and leaves the lead untouched. **Search again** is a new explicit,
  possibly billable request: Cold never retries on its own.
- Cold does not write, send or open anything because an address was found. Drafting, Gmail/Outlook hand-off, and sent/reply tracking are unchanged.

## What is sent, and to whom

Only the details needed for the lookup you started: the lead's name, the company domain you typed, and/or the lead's LinkedIn link, for *Find*; and the one
email address, for *Verify*. Nothing else: no page contents, browsing history, drafts, notes or other leads. The request goes to your Cold server (desktop
app / local server), which calls `https://treg.to` with the token. **treg may pass the details to upstream providers it selects**; the provider that
served the answer is shown. Check treg's [privacy](https://treg.to) and terms before relying on any statement about where data is processed: Cold
makes none. Using the hosted API does not make the lookup local, and treg being open source does not remove third-party processing.

## Credentials

The treg token lives only on the server side: saved in the desktop app's (or a local server's) **Settings → Email lookup** (encrypted with the OS keychain when
available, else a private file, shown afterwards only as its last four characters), or set as `TREG_TOKEN` in a server's environment. It is never put in the web
bundle, extension storage, a lead, a prompt, a URL or a message. The extension has no token: it uses the paired desktop app. If a hosted web server has
`TREG_TOKEN` set, set `COLD_ACCESS_TOKEN` too, or anyone who can reach it can spend that balance.

## Cost and routing controls

Cold calls only `treg.people.email.find` and `treg.people.email.verify` (fixed in `lib/treg.js`; no other operation, URL or header is reachable). Each call sends
`X-Treg-Route-Max-Cost`: **$0.05** for find (operators may lower or raise it with `COLD_TREG_MAX_COST`, $0.001–$1) and **$0.02** for verify, instead of treg's $1 default.
Routing and provider choice are treg's; Cold has no second router. treg bills misses from some providers, so a miss can cost money. If treg answers *pending*
(HTTP 202) Cold refuses another search for the same person for 15 minutes, and refuses a duplicate while one is running. No automatic retries.

## The treg contract used (from the live catalog and treg's API docs)

`POST https://treg.to/call/treg.people.email.find`, header `X-Treg-Token`, JSON body with any of `full_name`, `domain`, `linkedin_url`. Response
`{ output: { email, confidence (0..1), verified, first_name, last_name }, raw, _treg: { served_by, tried, charged_micro } }`; a miss is `output.email == null`.
`POST https://treg.to/call/treg.people.email.verify` with `{ email }` → `output: { valid, status, score }`. Cold keeps `email`, `confidence`, `verified`, the
name, `served_by`, `tried` and `charged_micro`, and discards `raw`.

## Testing status (what was and wasn't run)

- **Mocked** (automated, `test/people.test.js`): request mapping, cost header, evidence wording, verification words, pending/duplicate handling, error handling
  without leaking the token, token absent from bundles, server routes and settings, and the browser flow (find, verify, accept, reject, miss, error, missing
  information, pending) against a stand-in for treg.to. These prove Cold's behaviour, not treg's or any provider's accuracy.
- **Real service:** not performed in this change. It needs a treg token with balance and a prospect you are authorised to look up. The live *catalog* (public) was read
  to confirm the operations, inputs and outputs above, but no billable call was made. No real provider, result, verification outcome or cost has been observed.

## Known limits

treg's routed answer gives no source and a provider-scaled confidence; accuracy is the provider's. `verified: true` from a provider is its own claim. The
company domain is typed per lookup because leads don't store one. Only single lookups: no bulk or background enrichment.
