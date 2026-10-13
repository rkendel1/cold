# Getting started

Cold helps you write short, specific outreach drafts from facts you've saved. **It never sends anything**: you copy a draft or open it in your own email app and send it yourself, then record what happened. Each surface is complete on its own; use the one that suits you.

> **Honest status.** Cold is pre-1.0 and has not been approved for general release ([audit](audit/README.md)). There are no packaged installers or store listings yet: the desktop app and extension are built from source.

## 1. Pick a surface

| You want… | Use | How |
|---|---|---|
| Everything on your computer, your own model key, nothing hosted | **Desktop app** | `npm install` then `npm run desktop` (package an installer with `npm run desktop:build`; unsigned). |
| To try it in a browser you control | **Web (self-hosted)** | `cp .env.example .env`, add a provider key, `npm start`, open `http://127.0.0.1:3000` |
| To write from the page you're on (tweets, LinkedIn/X profiles) | **Browser extension** | `npm run build:extension`; Chrome → `chrome://extensions` → Developer mode → Load unpacked → the `extension/` folder |
| To share one library between them | **Pairing** | Desktop app: Settings > Browser extension & web apps. Web/extension: Settings > Cold desktop app |

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

The footer and **Settings > Your data** say where your library lives: this browser (web), a SQLite file (desktop), the extension's storage, or a shared library if paired. Back up the desktop library by copying `cold.db` (path in Settings). **Leads → Export CSV** exports leads only. There is no export for products or drafts other than the database file, and no "erase everything" button: delete records one by one, or remove the browser data / database file.

**Optional: Google Sheets.** If your copy of Cold has it enabled, **Settings > Google Sheets** keeps leads and outreach in a spreadsheet in your own Google Drive. It is a preview feature that has not been tested with a real Google account: read [google-sheets.md](google-sheets.md) first.

## Next

[Troubleshooting](troubleshooting.md) · [Configuration reference](configuration.md) · [Privacy and data flow](privacy-and-data-flow.md) · [How the three surfaces relate](standalone-surfaces.md)
