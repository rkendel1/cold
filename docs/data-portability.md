# Export, restore and erase your data

**Settings > Your data** has three separate actions. None of them runs by itself: not at start-up, not when you choose a file, not when you change a setting.

| Action | What it does | Changes your data? |
|---|---|---|
| **Export my data** | Downloads one JSON file with your products, drafts and leads | No |
| **Restore from an export…** | Reads a file, shows what it would do, then does it when you press the button | Yes, only after you confirm |
| **Erase my data on this device…** | Deletes Cold's records and saved settings from this device | Yes, only after you type the word *erase* |

## What an export contains

File name: `cold-export-YYYY-MM-DD.json` (your local date). It is plain JSON you can open in any text editor.

```json
{ "format": "cold-export", "version": 1, "exportedAt": "…", "source": "web | desktop | extension",
  "counts": { "products": 0, "emails": 0, "leads": 0 },
  "data": { "products": [], "emails": [], "leads": [], "settings": {} } }
```

* **Products** (what you offer), **drafts / outreach records** (recipient, subject, text, status, notes, sent copy, sent and replied times, hand-off history, follow-up dates), and **leads** (including extra fields you added).
* Ids and the links between records are kept as they are. Fields Cold doesn't know about are kept too, so a file made by a newer build of the same format version still carries them.
* **Settings** that belong to your library only: sign-off, "add sign-off", email app, Gmail account name, follow-up rules.
* `counts` lets Cold notice a file that was cut off or edited by hand.

**Never exported:** provider API keys, the Google refresh token, session or pairing tokens, the extension's pairing, the desktop `settings.json`, model configuration, or anything whose field name looks like a credential (`apiKey`, `secret`, `token`, `password`, `authorization`, `credential`). Such fields are removed even if they sit inside a draft you wrote. The export also holds nothing that lives in another service: a Google Sheet's contents are not downloaded from Google (only what Cold shows you is written), and email you sent is not in Cold at all.

The file contains the people you wrote to. Keep it private. It is not encrypted.

An empty library says "There's nothing to export yet" and downloads nothing. If the export can't be built, Cold says so and creates no file. "Exported…" appears only after the file was handed to your browser; Cold can't see where your browser saved it.

## Restoring

Cold reads and checks the **whole file** before changing anything. A file is refused, with nothing changed, when it is empty, isn't JSON (including a file cut off part-way), isn't a Cold export, is a **newer version** than this Cold reads (version 1), is over 50 MB or 100,000 records per list, has a record with a missing, unsafe or repeated id, a wrong-typed field, or a `counts` line that disagrees with the content. Messages name the position and field, never your content.

Then you choose a mode. The review screen says exactly what it will do.

**Add what's new** (default, keeps everything you have):

* A record whose id isn't here yet is added.
* Same id and identical content: skipped ("already here").
* Same id but **different content**: a **conflict**. Your copy is kept, the file's copy is not applied, and it is listed. Cold never merges two versions field by field and never silently overwrites.
* A lead whose email, profile link or name and company matches a lead you already have under another id is skipped as the same person.
* Settings are not changed.

**Replace my library with this file** (destructive):

* Needs an explicit confirmation. Before it deletes anything, Cold **downloads a backup** (`cold-backup-before-restore-…json`) of what you have now.
* Makes your products, drafts and leads equal to the file: everything not in the file is deleted, everything in it is written, and the file's settings are applied.
* Things a file never holds (pairing, provider keys, other libraries) are untouched.
* **Not available** when this library is paired with the desktop app or stored in Google Sheets (the deletes would be copied elsewhere). The screen says why.

Restoring is not one database transaction on every surface, so Cold does three things: it validates and plans first; it keeps the previous copy of every record it will touch in memory; and after writing it reads everything back. If any step fails, or the read-back doesn't match, it puts the touched records back and checks that too. The result screen says either "Restored … every record was read back" or that the restore failed and whether your library was put back. If Cold *cannot* confirm the put-back, it says so and points you to the backup file. Restoring the same file twice changes nothing the second time.

Timestamps `createdAt`, `sentAt`, `repliedAt` and follow-up dates are restored as in the file. The internal version stamp (`updatedAt`) is assigned fresh when a record is saved.

## Erasing

The confirmation lists what will be deleted (with counts) and what will not, and the **Erase** button stays disabled until you type `erase`. Cancelling, pressing Escape or closing the dialog changes nothing.

| Surface | What erase deletes | How it is checked |
|---|---|---|
| **Web** (this browser) | The library's `localStorage` keys (products, drafts, leads, settings, Write form, sync queue) for this library | The storage is read back; "Erased…" is shown only when nothing is left. Other sites' and other libraries' data are untouched |
| **Extension** | The library entry in `chrome.storage.local` (which also holds the sync queue) | Read back the same way. Provider settings and pairing are kept |
| **Desktop** | Products, drafts, leads, saved settings and the Write form in `cold.db`; the old browser copy inside the app. Then the database is compacted (`secure_delete`, WAL checkpoint, `VACUUM`) so deleted text isn't left in `cold.db` or `cold.db-wal` | The database is counted afterwards, and a test searches the raw `cold.db*` bytes for deleted text |

After an erase the page is locked against writes: a stale screen, a timer or the Write form's autosave can't put the data back. Reload Cold to start fresh. If anything couldn't be removed the message says so ("Erasing didn't finish…", "Don't treat it as erased") and the lock is lifted so you can retry.

**Erase does not touch:** the desktop pairing code, provider keys and `settings.json` (including the saved Google sign-in), files you exported, any copy of `cold.db*` you made, browser or operating-system backups and sync, Google Drive or a Google Sheet, other libraries, or Cold's program files. It does **not** revoke Google's authorization and does **not** delete a spreadsheet; do both yourself at myaccount.google.com and Drive.

**Not available (and why):**
* **Paired or shared libraries.** Erasing the web or extension copy would be sent to the desktop app as deletes. Erase in the desktop app, or disconnect first.
* **Google Sheets storage.** The data is in your sheet, not on the device. Stop using Sheets (which copies it back), erase, then delete the sheet in Drive.

## How this relates to the SQLite backup

[Backing up the desktop library](getting-started.md#backing-up-the-desktop-library-do-this-before-anything-risky) copies the database files and keeps everything, including data a JSON export doesn't carry. An export is portable between surfaces and readable; a file backup is exact. Use the export to move data or keep a readable copy, and the file backup for a full-fidelity copy. After an erase, old file backups still contain the old data.

## Known limitations

* **Web and extension erase is not a secure wipe.** Browsers decide when storage is physically overwritten, and profile sync or backups may hold older copies.
* **Desktop erase compacts the database only.** Older `cold.db` copies, OS snapshots and backups are not touched.
* **Restore is not atomic.** It is validated, rolled back on failure and verified, not transactional.
* Replace and erase are refused for paired/shared and Sheets libraries.
* Imports are limited to 50 MB and 100,000 records per list.
* The export format is version 1. A newer version is refused, not guessed at. There is no migration framework.
* Downloads go through the browser's normal download. Tested in Chromium (web and the extension panel); not checked in a packaged desktop build, in Firefox or Safari, or in a Chrome Web Store build.
* Real Google, packaged installers and manual screen-reader use were not part of this verification.
