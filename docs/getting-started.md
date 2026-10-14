# Getting started

Cold helps you write short, specific outreach drafts from facts you've saved. **It never sends anything**: you copy a draft or open it in your own email app and send it yourself, then record what happened. Each surface is complete on its own; use the one that suits you.

> **Honest status.** Cold is pre-1.0 and has not been approved for general release ([audit](audit/README.md)). There are no store listings. The desktop app and extension are built from source; an **Ubuntu `.deb`** can be built with `npm run desktop:deb` (see [ubuntu.md](ubuntu.md); built and tested in CI and in an Ubuntu container, **not yet on a pilot's own machine**).

## 1. Pick a surface

| You want… | Use | How |
|---|---|---|
| Everything on your computer, your own model key, nothing hosted | **Desktop app** | `npm install` then `npm run desktop` (package an installer with `npm run desktop:build`; unsigned). On Ubuntu: [ubuntu.md](ubuntu.md) (`npm run desktop:deb`, then `sudo apt install ./dist/cold_*_amd64.deb`). |
| To try it in a browser you control | **Web (self-hosted)** | `cp .env.example .env`, add a provider key, `npm start`, open `http://127.0.0.1:3000` |
| To write from the page you're on (tweets, LinkedIn/X profiles) | **Browser extension** | `npm run build:extension`; Chrome → `chrome://extensions` → Developer mode → Load unpacked → the `extension/` folder |
| To share one library between them | **Pairing** | Desktop app: Settings > Browser extension & web apps. Web/extension: Settings > Cold desktop app |

**Optional sign-in.** A hosted deployment may show **Settings > Cold account**: *Sign in with Google* identifies you to Cold (name and email only; no Gmail or Sheets access) and nothing else changes: you never need it, your library isn't moved, and cross-device sync isn't available yet. The desktop app and extension don't offer it. See [Google sign-in](google-sign-in.md).

If you only see a disabled **Generate draft** with "This site has no model yet", the server has no provider key: see [troubleshooting](troubleshooting.md#generate-draft-is-disabled).

## 2. Set up a model

* **Desktop / extension:** Settings > Model → choose a provider (Anthropic, OpenAI, Gemini, OpenRouter, Groq, Mistral, AI Gateway, Ollama, or any OpenAI-compatible server), paste a key if it needs one, choose a model.
* **Web (self-hosted):** put the provider's key in `.env` (names in [configuration.md](configuration.md)) and restart.

## 3. Write your first draft (about five minutes)

1. **Write** → under *What are you offering?* type your product's name and one plain sentence about what it does. It is saved to **Knowledge** so you enter it once.
2. Under *Who are you writing to?* enter a name and company, and the real reason you're contacting them (something they wrote, built or said). Cold uses only what you give it and won't invent a connection.
3. Pick what you want from them (advice, introduction, customer conversation…), then **Generate draft**.
4. Edit the text. Read the checks under *Check before you send*: they compare the draft with your saved facts; they can't tell whether a claim is true.
5. **Copy email** (or **Open in email**) and send it from your own account.

## 4. Bring in the people you already have

1. **Leads → Download template**, fill it in a spreadsheet, save as CSV. (`name` is the only required column.)
2. **Import CSV**. Nothing is saved yet: the review shows how many are new, which rows can't be imported and why, and which already exist.
3. If your file uses other column names, open **Match your columns to Cold's fields**: choose what each column becomes, or keep a column as your own **extra field**.
4. **Add N leads**. Importing the same file again adds nothing.
5. On a lead, **Write** opens a draft already filled in.

## 5. Record what happened (History)

Cold can't see your inbox. After you send, open **History** and press **Mark sent**; when someone replies, **Record reply**. Copying or opening an email sets a **follow-up reminder** (default: 3 working days, then weekly, up to 3, at 09:00; change it in **Settings > Follow-ups**). Due ones appear under **History > Follow-up due**; use **Add to calendar** if you want an actual alert. A follow-up can be due for a draft you only copied and never sent: send it first, or choose **No follow-up**.

## 6. Where your data is, and keeping a copy

On a new, empty install, **Write** shows a short **Get started** checklist (connect a model, add what you offer, generate and copy a first draft, optionally import leads). Each step turns to *Done* only when it has really happened; **Hide this checklist** removes it for good.

The footer and **Settings > Your data** say where your library lives: this browser (web), a SQLite file (desktop), the extension's storage, or a shared library if paired. **Leads → Export CSV** exports leads only. For everything else, **Settings > Your data** has **Export my data** (one JSON file with products, drafts and leads, never keys), **Restore from an export…** (checked before anything changes; add what's new, or replace after a confirmation and an automatic backup) and **Erase my data on this device…** (typed confirmation). See [Export, restore and erase](data-portability.md) for exactly what each includes and what it leaves alone.

### Backing up the desktop library (do this before anything risky)

The desktop library is the SQLite database in the app's data folder. It runs in write-ahead-log (WAL) mode, so **recent changes live in a separate `cold.db-wal` file until SQLite merges them**. On a normal quit Cold now closes the database, which merges them and removes the extra files; after a crash, a power loss or a killed process they are still there and still hold your latest records. **Copying `cold.db` by itself can silently leave out your latest records** (a test copied just that file after 5 saves and got 0 of the 5 back).

1. **Quit Cold completely** (menu **Cold > Quit**, or ⌘Q; on Windows and Linux close every Cold window and check no Cold process remains). Do not copy files while the app is running.
2. **Find the data folder.** The exact path is shown in **Settings > Browser extension & web apps**. By Electron's convention for an app named Cold it is `~/Library/Application Support/Cold` on macOS, `%APPDATA%\Cold` on Windows and `~/.config/Cold` on Linux (the path in Settings is authoritative; the Linux path was checked on Ubuntu 24.04, the macOS and Windows ones were not re-checked). Ubuntu commands: [ubuntu.md](ubuntu.md#backing-up-and-restoring).
3. **Copy every file whose name starts with `cold.db`** (`cold.db`, plus `cold.db-wal` and `cold.db-shm` if they exist) into a new folder, in one go, for example `cold-backup-2026-10-14`.
4. Keep `settings.json` separately only if you want to keep your provider keys and Google sign-in; it contains secrets, so store it as carefully as you would a password file. It is not part of the library backup.

### Restoring

1. Quit Cold completely.
2. **Move the current `cold.db*` files aside into another folder (do not delete them).**
3. Copy your backed-up `cold.db*` files into the data folder.
4. Start Cold and check your products, drafts and leads.

**What has and hasn't been verified.** An automated test (`test/db-backup.test.js`) checks the database layer: that copying `cold.db` alone loses recent records, that copying all of the `cold.db*` files together preserves them (including after a process exits without closing the database), and that restoring such a set opens with every record. It has **not** been verified with a real quit of the packaged desktop app on macOS, Windows or Linux, through the app's own interface, or for the default folder paths above. Treat your first backup as unproven until you have restored it once into a spare copy of the app's data folder.

**Optional: Google Sheets.** If your copy of Cold has it enabled, **Settings > Google Sheets** keeps leads and outreach in a spreadsheet in your own Google Drive. It is a preview feature that has not been tested with a real Google account: read [google-sheets.md](google-sheets.md) first.

## Next

[Troubleshooting](troubleshooting.md) · [Configuration reference](configuration.md) · [Privacy and data flow](privacy-and-data-flow.md) · [How the three surfaces relate](standalone-surfaces.md)
