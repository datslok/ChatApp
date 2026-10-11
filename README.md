# ChatApp

A small Discord-style chat app for me and my friends, built as a learning project. It runs at
https://chat.datslok.no, served from a PC at home.

Backend in Python ([FastAPI](https://fastapi.tiangolo.com/) with WebSockets, SQLite), frontend in
plain HTML, CSS and JavaScript. Voice, video and screen sharing go through a self-hosted
[LiveKit](https://livekit.io/) server. There's also a Windows desktop app ([Tauri](https://tauri.app/)).

**Features:** text channels and direct messages, friends, accounts with profiles (pictures, banners,
status), replies, reactions and custom emoji, @mentions, unread dots, notifications, image and file
uploads, a Lounge voice channel and calls in DMs (with AI noise suppression, a noise gate and volume per person), cameras,
screen sharing (up to 1440p60), and a desktop app that updates itself.

## Scripts at a glance

Run them in PowerShell, from the project folder (`E:\Code\ChatApp` on the development PC,
`C:\ChatApp` on the server PC). Each one also explains itself in comments at its top.

| Script | Where | What it does | More |
|--------|-------|--------------|------|
| `setup.ps1` | development PC | makes the conda environment, installs the packages | [Development](#running-it-for-development) |
| `start.ps1` | development PC | the chat for development (http://localhost:8001, `dev.db`) | [Development](#running-it-for-development) |
| `voice.ps1 -Dev` | development PC | voice for development (localhost only) | [Development](#running-it-for-development) |
| `scripts\deploy.ps1` | development PC | puts the newest code on the server and restarts the chat (`-Voice`: also voice) | [Day to day](#day-to-day) |
| `scripts\release-upload.ps1` | development PC | puts a new desktop app version on the server and restarts the chat (open apps update) | [The desktop app](#the-desktop-app) |
| `scripts\backup-fetch.ps1` | development PC | fetches the server's newest backup (`-Install`: every day) | [Backups](#backups) |
| `scripts\usage.ps1` | development PC | how much space the chat takes on the server (database, uploads, backups, free disk) | [Day to day](#day-to-day) |
| `scripts\server-connect.ps1` | development PC | once: SSH access to the server (`ssh chatserver`) | [4b](#4b-on-the-development-pc-connect-to-the-new-one) |
| `scripts\server\export.ps1` | old server PC | packs the data for moving the server | [1](#1-on-the-old-pc-pack-the-data) |
| `scripts\server\import.ps1` | new server PC | unpacks it | [3](#3-on-the-new-pc-unpack-the-data) |
| `scripts\server\install.ps1` | server PC (as admin) | installs and sets up everything; safe to run again | [4](#4-on-the-new-pc-install-everything) |
| `scripts\server\update.ps1` | server PC (as admin) | what `deploy.ps1` runs there: newest code, restart | [Day to day](#day-to-day) |
| `scripts\server\backup.ps1` | server PC | the nightly backup (also by hand) | [Handy commands](#handy-commands-on-the-server) |
| `scripts\server\usage.ps1` | server PC | what `usage.ps1` runs there: the sizes, only reading | [Handy commands](#handy-commands-on-the-server) |
| `serve.ps1`, `voice.ps1` | server PC | the chat and voice; the scheduled tasks start them | [Day to day](#day-to-day) |
| `tools\make_admin.py` | server PC | make someone an admin (or take it away) | [Handy commands](#handy-commands-on-the-server) |

## Running it for development

You need [Anaconda](https://www.anaconda.com/) (or Miniconda). In PowerShell:

```powershell
.\setup.ps1          # first time: creates the "chatapp" environment and installs packages
.\start.ps1          # the chat, on http://localhost:8001, restarting when you save (Ctrl+C to stop)
.\voice.ps1 -Dev     # voice, in a second window (only needed to try voice)
```

Then open http://localhost:8001 in two browser tabs and chat between them. Development uses its
own `dev.db` and `dev-uploads/` (from `dev.env`), so it never touches the real chat.

## Running the server on its own PC

The real chat can run on any Windows 10/11 PC that's always on: an old laptop is plenty for ~10
people (any 4-core CPU, 4–8 GB of memory, an SSD, and **a network cable**, not Wi-Fi). Three
scripts do almost everything; the rest is a few clicks on the router and in Cloudflare.

What runs on that PC:

| Part | Started by | Log |
|------|-----------|-----|
| The chat (`serve.ps1`, port 8000) | scheduled task **ChatApp**, at boot | `logs\chat.log` |
| Voice (`voice.ps1`, LiveKit, ports 7880–7882) | scheduled task **ChatApp voice**, at boot | `logs\voice.log` |
| The Cloudflare Tunnel (`cloudflared`) | Windows service **Cloudflared** | — |

### 1. On the old PC: pack the data

In this folder, in PowerShell:

```powershell
.\scripts\server\export.ps1
```

That makes `chatapp-data.zip` with `chat.db` (a safe copy, even while the chat runs), `uploads/`,
`releases/` and `.env`. Copy it to a USB stick. **It holds the secrets and everyone's messages**:
delete it everywhere once the move is done.

### 2. On the new PC: get the code

Open PowerShell and install Git (Windows' own `winget` does it):

```powershell
winget install --exact --id Git.Git
# close PowerShell and open it again, so it finds git
```

The repository is private, so this PC needs a way in. Not your GitHub login: `deploy.ps1` later
runs `git pull` here over SSH, with nobody at this PC, and Windows doesn't unlock stored logins in
such a session (nor can git ask for one). Instead, a **deploy key**: an SSH key GitHub accepts for
this one repository, read-only. Make it and tell SSH to use it for GitHub:

```powershell
ssh-keygen -t ed25519 -f "$HOME\.ssh\github_chatapp" -N '""' -C "chatapp server (deploy key)"
"Host github.com`n    IdentityFile ~/.ssh/github_chatapp`n    IdentitiesOnly yes`n    StrictHostKeyChecking accept-new`n" |
    Out-File -Encoding ascii -Append "$HOME\.ssh\config"
Get-Content "$HOME\.ssh\github_chatapp.pub"    # copy this line
```

On GitHub: the repository → **Settings** → **Deploy keys** → **Add deploy key**. Paste the line,
call it "laptop server" or similar, and leave *Allow write access* **off**. Then fetch the code
(the `git@github.com:` address goes through SSH, with that key):

```powershell
cd C:\
git clone git@github.com:datslok/ChatApp.git
cd C:\ChatApp
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # once: lets you run scripts from this PC
```

(Windows doesn't run PowerShell scripts at all out of the box. `RemoteSigned` lets your own run,
while scripts downloaded from the internet still need a signature.)

Already cloned with `https://` (and logged in)? Then make the deploy key as above, and switch:
`git remote set-url origin git@github.com:datslok/ChatApp.git`.

### 3. On the new PC: unpack the data

Put `chatapp-data.zip` in `C:\ChatApp` (or point to it on the stick), then:

```powershell
.\scripts\server\import.ps1                        # or: .\scripts\server\import.ps1 E:\chatapp-data.zip
```

### 4. On the new PC: install everything

Open PowerShell **as administrator** (right-click it, "Run as administrator"), then:

```powershell
cd C:\ChatApp
.\scripts\server\install.ps1
```

It installs Python (and the packages, in `.venv`), LiveKit and `cloudflared`, adds the firewall
rules, sets the power options (never sleep on the charger, closing the lid does nothing), and
makes the two scheduled tasks. It asks for two things:

- **The tunnel's token.** In Cloudflare's [Zero Trust dashboard](https://one.dash.cloudflare.com/):
  Networks → Tunnels → **chatapp** → *Add a connector* (or *Configure*). The command shown there
  ends with a long token starting with `eyJ`: paste just the token.
- **Your Windows password**, so the tasks can start at boot before anyone logs in. With a Microsoft
  account, that's the account's password, not the PIN.

At the end it starts both and checks they answer. It's safe to run again. It also switches on
Windows' SSH server (only reachable from your home network), and prints a line for the next step.

### 4b. On the development PC: connect to the new one

So you can update the server from your development PC, without walking over to it. Run the line
the install printed at its end, in this folder on the development PC:

```powershell
.\scripts\server-connect.ps1 192.168.10.123 yourname    # the server PC's address and your username there
```

It makes an SSH key on the development PC (if you don't have one), puts it on the server (asking
for your password there once), and names the server **chatserver**: after that, `ssh chatserver`
logs in without a password.

### 5. Turn off the old PC's server

Otherwise the tunnel sends some visitors to the old PC. On the old PC, as administrator:

```powershell
cloudflared service uninstall
```

…and stop `serve.ps1` and `voice.ps1` there (Ctrl+C in their windows).

### 6. The router

Voice's audio doesn't go through the tunnel, so the router has to send it to the new PC
(http://192.168.10.1 → port forwarding). First find the new PC's address: `ipconfig` in
PowerShell, "IPv4 Address" (like `192.168.10.123`).

- Change the two rules **livekit_udp** (UDP 7882) and **livekit_tcp** (TCP 7881) to the new address.
- Add a **DHCP reservation** for the new PC, so it keeps that address.

### 7. Check

- https://chat.datslok.no works, with the old messages.
- Join Lounge with someone: you should hear each other. In `logs\voice.log`, near the top, LiveKit
  should say *"using external IPs"* with your public IP (not *"could not validate external IP"*:
  that means the router's forwarding isn't right yet).
- Restart the new PC without logging in, wait a minute: the chat should come back by itself.

### Day to day

Develop and test on the development PC as before (`start.ps1`, `voice.ps1 -Dev`: its own ports
and `dev.db`, so it never touches the real chat). The real chat only changes when you deploy:

```powershell
# On the development PC:
.\scripts\deploy.ps1                 # pushes to GitHub if needed, then updates the server and restarts the chat
.\scripts\deploy.ps1 -Voice          # also restart LiveKit (after changes to voice.ps1 or livekit.yaml)
.\scripts\release-upload.ps1         # after building a new desktop app version: copy it to the server, restart the chat
.\scripts\usage.ps1                  # how much space the database, uploads, releases, logs and backups take
ssh chatserver               # a PowerShell on the server (type exit to leave)
ssh chatserver "Get-Content C:\ChatApp\logs\chat.log -Tail 30"   # the chat's latest log lines
```

After a deploy that changed the page (`static/index.html`, `static/js/`, `static/css/`), open pages
and apps reload themselves within a few seconds: nobody needs to press F5. Someone in a call, with
files waiting to be sent, or editing a message gets it once that's done; a half-typed message is kept.

On the server itself, in `C:\ChatApp` (as administrator): `.\scripts\server\update.ps1` does what
`scripts\deploy.ps1` does, `Get-ScheduledTask ChatApp*` shows whether the tasks run, and
`Get-Content logs\chat.log -Tail 30 -Wait` follows the log (Ctrl+C to stop watching).

After the internet provider changes your home IP, restart voice (`.\scripts\deploy.ps1 -Voice`, or restart
the server PC): LiveKit looks up the IP when it starts.

New desktop app versions are built on the development PC (it has the signing key), then
`scripts\release-upload.ps1` puts them on the server: see [The desktop app](#the-desktop-app).

### Handy commands (on the server)

From the development PC, `ssh chatserver` gives you a PowerShell on the server (already as
administrator); then `cd C:\ChatApp`. Or sit at the server PC itself, in PowerShell as administrator.

```powershell
# Admins can edit and delete anyone's messages and custom emoji.
.venv\Scripts\python.exe tools\make_admin.py --list              # who's an admin?
.venv\Scripts\python.exe tools\make_admin.py mongri              # make mongri an admin
.venv\Scripts\python.exe tools\make_admin.py mongri --remove     # take it away again

# Is everything running? (ChatApp and ChatApp voice: Running. ChatApp backup: Ready.)
Get-ScheduledTask ChatApp*

# The logs. chat.log: starts and errors; chat.out.log: every request; voice.log: LiveKit.
Get-Content logs\chat.log -Tail 30
Get-Content logs\chat.out.log -Tail 30
Get-Content logs\backup.log -Tail 5

# Restart by hand (deploy.ps1 does this too).
Stop-ScheduledTask ChatApp; Start-ScheduledTask ChatApp
Stop-ScheduledTask "ChatApp voice"; Start-ScheduledTask "ChatApp voice"

# A backup now, besides the nightly one.
.\scripts\server\backup.ps1 -Destination E:\ChatApp-backups

# How much space everything takes, and how much is free (only reads). "Leftovers": other .db
# and .zip files in C:\ChatApp, like an old export or a copy made before a fix: safe to delete
# once you're sure you don't need them.
.\scripts\server\usage.ps1
```

(Stopping a task can leave its program running; if a restart doesn't seem to take, use
`.\scripts\server\update.ps1`, which also ends those.) On the development PC, `tools\make_admin.py`
works the same with `--db dev.db`, for the development chat.

### Backups

Every night at 04:00 the server PC backs itself up onto its second disk (`E:\ChatApp-backups`; the
scheduled task **ChatApp backup**, from step 8 of `install.ps1`):

- `2026-10-11\chat.db` and `.env`: a safe copy of the database (and the settings) per day, the last 30 kept
- `uploads\` and `releases\`: every file, new ones added each night, nothing deleted

And the development PC fetches the newest one, so there's a copy outside the server PC too. Once:

```powershell
.\scripts\backup-fetch.ps1 -Install    # a daily task (05:00, or as soon as this PC is on)
.\scripts\backup-fetch.ps1             # fetch now
```

That copy is in `~\ChatApp-backups` (your user folder). Logs: `logs\backup.log` on the server,
`~\ChatApp-backups\fetch.log` here.

**Restoring** (on the server PC, PowerShell as administrator, in `C:\ChatApp`):

```powershell
Stop-ScheduledTask ChatApp                               # stop the chat (voice can keep running)
Copy-Item E:\ChatApp-backups\2026-10-11\chat.db chat.db  # the day to go back to
robocopy E:\ChatApp-backups\uploads uploads /E           # brings back missing uploads
Start-ScheduledTask ChatApp
```

Everything after that day's 04:00 is lost (messages, accounts, settings changed since).

## The desktop app

The Windows app (`desktop\`, made with [Tauri](https://tauri.app/)) is a window around
https://chat.datslok.no (links in it open in the default browser): changes to the chat reach it
through the site, no new app needed. A new
version is only needed when the app itself changes (its Rust code, plugins, the icon). Building it
needs [Node.js](https://nodejs.org/) and [Rust](https://rustup.rs/) on the development PC, and the
**signing key** `C:\Users\axelk\.tauri\chatapp.key` (never commit it; without it, the installed apps
can't update themselves any more).

**Trying it:** in `desktop\`, `npm run tauri dev` opens the app straight from the code.

**Releasing a new version** (everyone's app installs it by itself: open apps when they reconnect after
the restart in step 5, or after their call, the others at their next start):

1. Raise `"version"` in `desktop\src-tauri\tauri.conf.json` (e.g. 0.1.8 → 0.1.9).
2. Build and sign it, in `desktop\`:
   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = "C:\Users\axelk\.tauri\chatapp.key"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   npm run tauri build
   ```
3. Copy `ChatApp_<version>_x64-setup.exe` and its `.sig` from
   `desktop\src-tauri\target\release\bundle\nsis\` into `releases\`.
4. In `releases\latest.json`, set `version`, the installer's `url`
   (`https://chat.datslok.no/releases/ChatApp_<version>_x64-setup.exe`), and `signature` (the whole
   contents of the `.sig` file).
5. Commit the version change, then put it on the server. `release-upload.ps1` ends by running
   `scripts\deploy.ps1` (which pushes the commit and restarts the chat), so every open app reconnects
   and looks for the new version (someone in a call: once they leave it):
   ```powershell
   git add desktop; git commit -m "Desktop app <version>: ..."
   .\scripts\release-upload.ps1
   ```

**Testing the update window** (what people see while the app updates): in `desktop\`, make a file
`pretend.json` containing `{"version": "0.1.0"}`, then `npm run tauri dev -- --config pretend.json`.
The app then believes it's old, finds the live version, and updates to it.

**Changing the icon:** put the new picture (1024×1024 PNG) in `icon\`, then in `desktop\`:
`npm run tauri icon ../icon/<file>.png` (delete the `android`, `ios`, `Square*`/`StoreLogo` and
`icon.icns` files it also makes), copy `desktop\src-tauri\icons\icon.ico` to `static\favicon.ico`
(the browser tab), run `python tools\make_installer_images.py` (the installer's pictures and the
update window's cat), and release a new version.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for what's planned and what's done.

## Credits

The app icon (the black cat) is made by Niamh Hannon.
