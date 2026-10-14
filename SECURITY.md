# Security policy

## Reporting a vulnerability (private)

**Do not open a public issue, pull request or discussion for a security problem.**

1. **Preferred: GitHub private vulnerability reporting.** On the repository's **Security** tab choose **Report a vulnerability** (direct link: <https://github.com/rkendel1/cold/security/advisories/new>). If that button is not there, the repository owner has not enabled the feature yet (see "Status of this policy" below): use step 2.
2. **Fallback: email the maintainer** at the address published as the package author in [`package.json`](package.json) (`Kendel Consulting`, `randy@kendelconsulting.com`). Use the subject line `Cold security report`. Please do not include live credentials in the email; describe where they appear instead.

There is no bug bounty and no guaranteed response time: Cold is pre-1.0 and maintained by a small group. You will get an acknowledgement when a maintainer reads the report.

### What to include

* What you found and where (file, route, setting, screen) and which surface: web, desktop app or browser extension.
* Steps to reproduce, with the smallest example you can make, and what you expected instead.
* The version or commit (`git rev-parse HEAD`, or the app's version) and your operating system and browser.
* What an attacker could do with it (read data, spend someone's provider credit, run code…).
* Whether it involves Google Sheets sign-in, the pairing code between the desktop app and web/extension, a provider key, or the Open-in-email handoff, if so.

### Please do not

* Post API keys, tokens, pairing codes, Google credentials, or other people's data in an issue, a pull request, a screenshot, or a log you share publicly. If you already did, revoke the credential first, then tell us privately.
* Access, change or delete data that isn't yours while testing, or test against a deployment you don't operate without its operator's permission.

## Ordinary bugs and feedback (public)

Open a [GitHub issue](https://github.com/rkendel1/cold/issues/new/choose): something broken, confusing, or missing. Include the surface, the steps, what you saw, and what you expected. Check [`docs/troubleshooting.md`](docs/troubleshooting.md) first. **Remove any key, token, email address or lead data from logs and screenshots before posting.** If you're not sure whether something is a security problem, report it privately.

## What is in scope

* **Hosted Google sign-in, including desktop and extension sign-in** (`lib/auth.js`, `lib/accounts.js`, `lib/accountClient.js`, `extension/src/account.js`): ID-token validation, state/PKCE/nonce handling, session cookies, CSRF on logout, account resolution. Please report session fixation, account takeover or cross-account access, open redirects, and any way to obtain a session without a verified Google identity. Design and limits: [docs/google-sign-in.md](docs/google-sign-in.md).

The Cold source in this repository: the web server, the desktop app, the browser extension, and the shared UI. Out of scope: vulnerabilities in third-party services Cold talks to (model providers, Google, treg), in your browser or operating system, or in a self-hosted deployment's own infrastructure.

How Cold handles data, and what it does not claim, is in [`docs/privacy-and-data-flow.md`](docs/privacy-and-data-flow.md) and [`docs/audit/07-security-privacy-data-authority.md`](docs/audit/07-security-privacy-data-authority.md).

## Status of this policy

* The private route in step 1 **depends on a repository setting only the owner can change** (Settings → Security → Private vulnerability reporting). This policy was written without being able to read that setting, so it does not claim the feature is on.
* The email fallback uses the contact already published in `package.json`. **The owner should confirm that mailbox is the intended private contact**, or replace it here, before Cold is promoted beyond a supervised pilot.
