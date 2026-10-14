# Troubleshooting

Only failure modes that were observed in the code and tests are listed, with the app's own wording. If yours isn't here, the data is almost certainly still where it was: Cold never deletes entries it can't read.

## Generate draft is disabled

* **"Writing drafts isn't available on this site yet"** (web; shown above the disabled **Generate draft** button, with *Why*, *Who can change it* and *What you can do now*). The site has no AI model connected, and only whoever runs it can add one, from the server: a visitor can't do it from the page. If you run it: add your provider's key to `.env` (names in [configuration.md](configuration.md)) and restart. If you don't: use the Cold desktop app (it works with your own model or one on your computer) or run Cold yourself. Your products, drafts and leads keep working meanwhile.
* **"The Cold desktop app isn't running and no other model is set up here yet."** (extension/web paired to the app). Open the desktop app, or choose a provider in Settings > Model.
* **The server asks for an access code.** `COLD_ACCESS_TOKEN` is set on that server; enter it in the field the page shows.

## "Some saved data couldn't be read" (desktop)

A notice such as **"2 saved items were unreadable and left out of this view (1 draft, 1 lead)"** means the SQLite database holds rows whose contents Cold can't parse (for example a damaged write or a hand edit). **Cold has not deleted or changed them**; it only leaves them out of what you see, so everything else keeps working. The notice shows counts only, never the content.

1. **Make a backup first**: follow [Backing up the desktop library](getting-started.md#backing-up-the-desktop-library-do-this-before-anything-risky) (quit Cold, copy all the `cold.db*` files).
2. *(Optional, to see which rows.)* With a SQLite tool such as `sqlite3` open on the **backup copy**, list the row ids (not their content) of each table:
   `sqlite3 cold.db "SELECT id FROM emails WHERE NOT json_valid(data)"`, and the same for `leads` and `products`. (This query was tested on a database with a deliberately corrupted row.)
3. Decide: you can leave things as they are (the notice stays), or, only after the backup, repair or remove those rows with a SQLite tool, then start Cold again. A change made outside the app shows the next time the page loads; the notice goes when nothing is unreadable.
4. If you think Cold caused it, [open an issue](https://github.com/rkendel1/cold/issues/new/choose) with the counts and what you were doing. **Do not paste the row contents** if they include real people's details.

Automated repair is not built.

## A draft failed to generate

Your inputs are kept and a retry is offered. Provider outages, rate limits and bad keys show the provider's own message. Nothing partial is saved to History.

## Google sign-in (hosted web)

Background: [google-sign-in.md](google-sign-in.md). No account section in Settings means the operator hasn't configured sign-in (Cold works the same without it).

* **"Google sign-in didn't complete, so you're not signed in."** Any check failed (expired or reused link, a different browser finishing it, an ID token that didn't verify, Google refusing the code). No session was created. Start again from Settings > Cold account. Operators: the page deliberately doesn't say which check failed; confirm the client id/secret, that the redirect URI matches Google Cloud exactly, the server clock, and that you opened the site at the same host as `COLD_AUTH_REDIRECT_URI`.
* **"You chose not to sign in with Google."** Consent was declined; nothing changed. A *Testing* consent screen only allows listed test users.
* **"That sign-in link expired or was already used."** Sign-in must finish within 10 minutes in the same browser, and a link works once. Don't use the back button on Google's page.
* **"Your session ended."** It expired (default 7 days) or you signed out elsewhere. Sign in again; local data is unaffected.
* **"Couldn't confirm that you signed out, so assume you're still signed in."** The sign-out request failed. Try again; closing the browser doesn't end a server session.
* **Server won't start: "Cold sign-in is configured incompletely".** The message names each missing or invalid variable. Fix or unset `COLD_AUTH_GOOGLE_CLIENT_ID` to turn sign-in off.
* **Signed in on one host, signed out on another** (for example 127.0.0.1 vs localhost): cookies are per host; use the host in the redirect URI.

## Export, restore and erase

Background: [data-portability.md](data-portability.md).

* **"There's nothing to export yet"**: the library is empty; no file is made.
* **"Couldn't create the export, so no file was made."** Cold checks its own export before offering it. Nothing was downloaded. Try again; if it repeats, copy the records you need by hand and report it.
* **"Can't restore …  Nothing was changed."** The file failed the check; the list says why, with positions and field names but never your content. Typical causes and fixes: *isn't valid JSON* (cut off in a download or copy: export again); *newer Cold* (update Cold); *has a missing or invalid id*, *repeats the id*, *may be truncated or edited* (the file was changed by hand: use the original). Cold never restores part of a file.
* **"N kept your version"** (add mode): a record with the same id but different content exists here. Yours was kept and the file's was not applied. Use **Replace** only if you want the file's version, and read the list of what it will delete first.
* **Replace is greyed out.** This library is paired with the desktop app or stored in Google Sheets, where replacing could delete records elsewhere. The reason is shown next to the option.
* **"The restore failed, and your library has been put back exactly as it was."** Something failed part-way and Cold undid it and checked. **"…could not confirm that your library is exactly as it was"**: check your drafts and leads, and restore the `cold-backup-before-restore-…` file Cold downloaded first.
* **"Erasing didn't finish" / "Don't treat it as erased".** Cold read the storage back and some of it was still there, or the storage refused. Nothing is claimed as deleted; the page is writable again. Try again, or clear it by hand: web, the site's data in browser settings; extension, remove and reinstall (this also removes its pairing); desktop, quit Cold and move the `cold.db*` files aside.
* **"Your data was erased on this device. Reload Cold to continue."** After an erase the page refuses writes so nothing old can come back. Reload.
* **Erase is greyed out.** Paired or Google Sheets library; the message names the next step. Erase never touches Google or the desktop app's data from here.

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

Copying or opening an email sets a reminder because Cold can't tell whether you sent it, and the follow-up says so: *"You copied this on {date}. Copying an email doesn't prove it was sent. If you haven't sent it, send it first, then mark it as sent."* (It uses the handoff Cold actually recorded; with none, it says the draft is still marked Draft.) Send it and press **Mark sent** (the date restarts from then, and the guidance goes away), or choose **No follow-up** on that draft. See [getting-started.md](getting-started.md#5-record-what-happened-history).

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
