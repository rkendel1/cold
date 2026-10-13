# Troubleshooting

Only failure modes that were observed in the code and tests are listed, with the app's own wording. If yours isn't here, the data is almost certainly still where it was: Cold never deletes entries it can't read.

## Generate draft is disabled

* **"This site has no model yet: whoever runs it adds a provider key on the server…"** (web). The server has no provider key. If you run it: add the key for your provider to `.env` (names in [configuration.md](configuration.md)) and restart. If you don't: use the Cold desktop app, or ask the operator. Your products, drafts and leads keep working meanwhile.
* **"The Cold desktop app isn't running and no other model is set up here yet."** (extension/web paired to the app). Open the desktop app, or choose a provider in Settings > Model.
* **The server asks for an access code.** `COLD_ACCESS_TOKEN` is set on that server; enter it in the field the page shows.

## A draft failed to generate

Your inputs are kept and a retry is offered. Provider outages, rate limits and bad keys show the provider's own message. Nothing partial is saved to History.

## "Draft shown, but browser storage is full" / "Not saved: browser storage is full"

The browser refused the write; nothing was reported as saved. Delete old drafts in History (or use the desktop app, whose SQLite file has no such limit), then save again. Copy the draft now if it only exists on screen.

## "Not saved: this draft was changed somewhere else, so the newer version was kept"

Two places edited the same field (for example the extension and the desktop app, or two devices on the same Google Sheet). Cold keeps the newer stored value and leaves your text on screen: copy it, reopen the draft from History, and re-apply it.

## CSV import

* **0 new, N sample rows from the template skipped.** Only the template's own three example people (`jordan.rivera@example.com`, `priya.nair@example.org`, `sam.okafor@example.net`) are skipped. Other `@example.com` addresses import normally.
* **"already in your leads or repeated".** Cold treats people with the same email (else the same LinkedIn/X link, else the same name and company) as the same person. Choose *Fill in their blank fields from this file* to update them, or leave them as they are.
* **A column wasn't picked up.** Open *Match your columns to Cold's fields* and choose what it should become; unrecognised columns stay as "Don't import" until you do.
* **"Choose which column holds the name."** No column was recognised as the person's name; choose one (or first and last name) in the mapper.
* **"That doesn't look like a text CSV file."** Save the spreadsheet as CSV (comma separated), not Excel `.xlsx`.
* **"A quoted cell that starts on line N never closes."** A stray quote mark in that cell.
* **Too big.** Up to 2 MB and 5,000 rows per import; split the file.

## Open in email does nothing

A browser can't tell whether a mail window opened. Check, in Settings > Email app, that the chosen app is right (the computer's default `mailto:` app only works if one is registered; Gmail/Outlook open a compose tab, which a pop-up blocker can stop). Use **Try it** to test the choice, or **Copy email** and paste. A message over about 2,000 characters (mail apps) or 6,000 (web compose) is refused rather than cut: use Copy.

## "Follow-up due" but I never sent it

Copying or opening an email sets a reminder because Cold can't tell whether you sent it. Send it and press **Mark sent** (the date restarts from then), or choose **No follow-up** on that draft. See [getting-started.md](getting-started.md#5-record-what-happened-history).

## Desktop app

* **"Cold can't start… Port 47821 is already in use."** Quit the other copy of Cold or whatever holds the port. You can set `COLD_PORT`, but saved data is tied to the port, so keep it stable.
* **My data isn't in the web page I opened.** The desktop app's library is in its SQLite file, not in a browser. Pair the web page or extension to share it (Settings > Browser extension & web apps).

## Extension

* **Can't reach the desktop app.** The app must be running and the address and pairing code current (Settings > Cold desktop app). The extension keeps working on its own copy and syncs when the app returns.
* **Provider key.** Stored in the extension's storage, not encrypted. Remove it in Settings > Model if you stop using the extension.

## Google Sheets (preview)

* **A banner: "Couldn't read your Google Sheet, so your leads and drafts are not shown right now. Nothing is lost."** Open Settings > Google Sheets. *Reconnect Google* if it says "Google needs you to sign in again."; *Refresh from the sheet* once it's reachable.
* **"That spreadsheet wasn't found. It may have been deleted, or it isn't one Cold created for you."** Cold can only open spreadsheets it created for you. If the sheet is gone, *Stop using Google Sheets* (copies back what Cold last read) and set up again.
* **"Google is limiting requests right now."** Wait a minute; Cold retries on its own.
* **A column I added to the sheet.** On the Leads tab it becomes an extra field; elsewhere Cold leaves your cells alone. Don't rename or delete Cold's own columns (`id`, `name`, `status`, `data`, …).
* **Leads or drafts differ between devices.** Each device must use the same sheet. Leads don't merge: if two devices edit the same lead, the later save wins.
* **I want to stop.** Settings > Google Sheets > *Stop using Google Sheets*. It copies everything back, signs out and asks Google to revoke access; the spreadsheet stays in your Drive.
