# Cold on Ubuntu (desktop app)

This is the canonical guide for installing, running, backing up and removing the **Cold desktop app on Ubuntu**. It is the same Electron app as on macOS, with the same local SQLite library; only the package and the data folder differ.

> **Verification status, stated plainly.**
> * **Built and tested automatically (CI):** the workflow's `linux-deb` job builds the package, verifies it, installs it with `apt` on an Ubuntu 24.04 runner and runs the installed app. Its result is on the pull request's checks; this document does not claim it is green.
> * **Installed and run on Ubuntu 24.04.5 LTS (amd64), in a container with a virtual display, as an unprivileged user, by the author of this change:** passed (details in the [verification record](#verification-record)).
> * **Installed on a real Ubuntu desktop by the pilot user:** **not done yet.** Use the [pilot checklist](#pilot-checklist) and record the result at the bottom of this file.
> * **Not verified anywhere:** a real model draft, Google Sheets, pairing with the browser extension or a web app, the launcher icon in a desktop session, Ubuntu 22.04, arm64.

## What you need

| | |
|---|---|
| Ubuntu | **24.04 LTS** (the version it was built and tested on). 22.04 should work but is untested (the AppArmor profile that 24.04 needs is skipped there automatically). |
| CPU | **amd64 / x86-64** only (`uname -m` prints `x86_64`). There is no arm64 package. |
| Privileges | `sudo` to **install**. Cold itself never needs root and writes only to your home folder. |
| System libraries | None to install by hand: `apt` pulls in what the package declares (GTK 3, NSS, libsecret, X libraries…). |
| A model | Cold needs a model provider key (or a local Ollama) to write drafts: Settings > Model. |

## Install

```bash
sudo apt install ./cold_0.1.0_amd64.deb
```

Use `apt install ./file`, not `dpkg -i`, so dependencies are installed too. Installing again over an older version upgrades it and **does not touch your data**.

## Start, quit, remove

* **Start:** open **Activities** and search for **Cold**, or run `cold` in a terminal. Cold shows one window; starting it a second time brings the first to the front.
* **Quit:** **File > Quit** (Ctrl+Q) or close the window. Cold closes its database on a normal quit.
* **Remove the program:** `sudo apt remove cold`. **Your library is kept** (`~/.config/Cold` is not touched by removal, upgrade or `apt purge`).
* **Remove your data too (permanent):** make a [backup](#backing-up-and-restoring) first, then `rm -r ~/.config/Cold`.

## Where your data is

| What | Path |
|---|---|
| Folder (private, mode `0700`) | `~/.config/Cold` (more exactly `$XDG_CONFIG_HOME/Cold` if you set that variable) |
| Library: products, drafts, leads, outreach history (SQLite, mode `0600`) | `~/.config/Cold/cold.db` |
| Provider keys and Google sign-in (mode `0600`; encrypted with the desktop keyring when one is available, otherwise stored as a private plain file) | `~/.config/Cold/settings.json` |
| Browser cache, crash reports (not your data) | the rest of `~/.config/Cold` (for example `Crashpad/`) |

**Settings > Browser extension & web apps** shows the exact path of `cold.db` on your machine; it is authoritative. If Cold cannot open that library at start-up it shows a message with the folder and the reason, changes nothing, and does **not** start a new library somewhere else.

## Backing up and restoring

Cold stores its library in SQLite's write-ahead-log mode. After a **normal quit** Cold closes the database, so `cold.db` is complete on its own, but a crash, a power loss or `kill` can leave `cold.db-wal` and `cold.db-shm` next to it, and those files then hold your latest records. So always copy **all** files whose names start with `cold.db`.

```bash
# 1. Quit Cold completely (File > Quit). Check nothing is left:  pgrep -a -f /opt/Cold/cold   (prints nothing)
# 2. Copy every cold.db* file in one go:
mkdir -p ~/cold-backup-$(date +%F) && cp -a ~/.config/Cold/cold.db* ~/cold-backup-$(date +%F)/
# 3. Check the copy exists:
ls -l ~/cold-backup-$(date +%F)/
```

Optionally also copy `~/.config/Cold/settings.json` if you want to keep your provider keys; it contains secrets, so store it like a password file.

**Restore:** quit Cold; move the current `cold.db*` files into another folder (do not delete them); copy the backed-up `cold.db*` files into `~/.config/Cold`; start Cold and check your products, drafts and leads. Never delete a `-wal` or `-shm` file while Cold is running, and do not delete one to "tidy up": if it exists, it may hold records that are in no other file.

## Logs and reporting a problem

Cold does not write a log file of its own. To see its messages, start it from a terminal (`cold`). Chromium crash reports, if any, are in `~/.config/Cold/Crashpad`.

To report an installation problem, open an issue at <https://github.com/rkendel1/cold/issues> and include: `lsb_release -d`, `uname -m`, `dpkg -s cold`, the output of running `cold` in a terminal, and what you expected. **Do not paste your library, your keys, or real prospect data.**

## Pilot checklist

Run this on the pilot's Ubuntu machine. Use **made-up** data only (no real prospects), and tick or note each step.

1. [ ] Install: `sudo apt install ./cold_0.1.0_amd64.deb` finishes without errors.
2. [ ] Open **Activities**, search **Cold**, start it. A window opens (no `sudo`).
3. [ ] Leads > add a test lead (for example *Test Lead, Example Co, test@example.invalid*).
4. [ ] Settings > Model: choose a provider you have a key for (or Ollama), then **Write** > generate a draft for the test lead. *(This uses your real model; send nothing real.)*
5. [ ] Copy the draft or **Open in email** (this records an outreach-history event; Cold never sends anything).
6. [ ] Quit with **File > Quit**.
7. [ ] Start Cold again: the lead, the draft and its history are still there.
8. [ ] Find the database: `ls -l ~/.config/Cold/cold.db`. Settings shows the same path.
9. [ ] Back it up (commands above) and check the copy exists.
10. [ ] `sudo apt remove cold`; confirm Cold is gone from Activities and `ls ~/.config/Cold/cold.db` still exists. Reinstall if you want to keep using it.

## Build it yourself

```bash
git clone https://github.com/rkendel1/cold && cd cold
npm ci                # Node 22 recommended; installs Electron
npm run desktop:deb   # builds the app bundle, then dist/cold_<version>_amd64.deb
npm run verify:deb    # checks name, version, architecture, files, no credentials/user data, maintainer scripts
```

Requirements: an amd64 Linux machine or CI runner with Node 22, network access to download Electron and the packaging tools the first time, and `dpkg-deb` (preinstalled on Ubuntu/Debian) for `verify:deb`. Other targets are unchanged: `npm run desktop:build` still produces the macOS/Windows installers (and a Linux AppImage on Linux), and `npm run desktop:pack` an unpacked build.

The package never contains `desktop/google.json` (a local Google OAuth client secret). Google Sheets sign-in is therefore off in the `.deb`; see [google-sheets.md](google-sheets.md).

To test the installed app yourself under a virtual display: `sudo apt install xvfb`, then `xvfb-run -a node scripts/smoke-deb.cjs --exe /opt/Cold/cold` (synthetic data; throwaway home folder).

## Known limitations

* amd64 only; Ubuntu 24.04 only is tested; the package is **unsigned** and there is **no auto-update**: install a newer `.deb` over the old one.
* No AppImage, Snap or Flatpak is provided for Linux by this change (the repository's older AppImage target exists but is not verified).
* The package's `License` field says `unknown`: the repository has no licence file yet.
* Provider keys are encrypted only when the desktop keyring (GNOME Keyring or KWallet) is available; without one they are stored in a private (0600) plain file. Settings shows which.
* Cold uses the fixed local port **47821** for its built-in server; if another program has it, Cold says so and does not start.

## Verification record

| Environment | Result | Evidence |
|---|---|---|
| CI (GitHub Actions, `ubuntu-24.04`, job `linux-deb`) | See the pull request's checks | `.github/workflows/ci.yml` |
| Ubuntu 24.04.5 LTS amd64 **container** (virtual display, unprivileged user `pilot`), 2026-10-14, by the author | **Passed:** `.deb` built; `apt install` resolved dependencies; `scripts/verify-deb.cjs` 24/24; `scripts/smoke-deb.cjs` 13/13 (launch, per-user library `0700/0600`, save a lead and a draft with a handoff, normal quit leaves no `-wal`/`-shm`, relaunch keeps every record and the same database file; launched with no flags so Chromium's sandbox is on; SIGTERM ends it cleanly); `apt remove` and `apt purge` kept `~/.config/Cold/cold.db` and a reinstall opened it | recorded in the pull request |
| **Pilot user's real Ubuntu desktop** | **Not yet run** | fill in below |

**Pilot result (to be filled in):** date ____ · Ubuntu version ____ · `uname -m` ____ · checklist steps passed ____ / 10 · problems ____
