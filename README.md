<p align="center"><img src="static/landing/logo.png" alt="ChatApp's cat" width="128"></p>

# ChatApp

**ChatApp is a lightweight chat app, inspired by Discord, that you can host yourself.** Text
channels and DMs, voice and video calls, screen sharing, and a Windows app, for a group of friends
(it's made for about 5–20 people), running on an ordinary PC at home.

The original runs at https://chat.datslok.no for a group of friends. It started as a learning project,
and is still small and readable on purpose: one Python file for the server, plain HTML, CSS and
JavaScript for the page, no frameworks.

![ChatApp: channels on the left, messages in the middle, who's online on the right](static/landing/screenshot.png)

## Features

- **Messages:** text channels and direct messages, replies, reactions (every emoji, plus 12 custom
  emoji per person, animated too), @mentions and @everyone, editing and deleting, formatting
  (`**bold**`, `*italic*`, `` `code` ``, code blocks, quotes, `||spoilers||`), link previews,
  pictures and files (drag, drop or paste), unread dots, and history that loads as you scroll up.
- **People:** accounts with an invite code, friends and friend requests, profiles (picture, banner,
  status, bio; GIFs too), who's online and who's typing, admins who can tidy up.
- **Voice and video:** a voice channel everyone can join and calls in DMs, with cameras, AI noise
  suppression (RNNoise), a noise gate and a volume per person. **Screen sharing** up to 1440p at
  60 fps with sound, encoded on the graphics card where possible.
- **Notifications** for DMs and mentions, with sounds and muting. Clicking one goes to the message.
- **A Windows app** (optional) with real Windows notifications and automatic updates. Everything also
  works in the browser, and on phones it installs as an app of its own (a PWA).
- **For the people running it:** a "What's new" page you write yourself, bug reports and ideas sent
  to the admins, nightly backups, and one-command updates.

## How it's built

| Part | What |
|------|------|
| Server | Python: [FastAPI](https://fastapi.tiangolo.com/) with WebSockets, all in `server.py`. SQLite for the data. |
| Page | Plain HTML, CSS and JavaScript (`static/`), no framework and no build step. |
| Voice, video, screen sharing | A self-hosted [LiveKit](https://livekit.io/) server (WebRTC). |
| Reaching it from the internet | A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), so no ports need opening for the chat itself. |
| Desktop app | [Tauri](https://tauri.app/) (`desktop/`): a small window around the site. |
| AI bot (optional) | Chattus (`chattus.py`), an account that talks over the same WebSocket, with a language model on the server's graphics card ([llama.cpp](https://github.com/ggml-org/llama.cpp)), or Claude through Anthropic's API. |
| Phone app (in progress) | [React Native](https://reactnative.dev/) with [Expo](https://expo.dev/) (`mobile/`), Android first. Until it's ready, the site installs as a PWA. |

**Windows only, for now.** The server itself is plain Python, but the scripts that install and run it
are PowerShell scripts for Windows 10/11. Linux support is planned for later.

---

## Contents

- [Try it on your own PC](#try-it-on-your-own-pc) (10 minutes)
- [Host your own](#host-your-own): from nothing to your own chat on the internet
- [Running it](#running-it): updating, What's new, handy commands, backups, moving to another PC, a shared window going black
- [The phone app](#the-phone-app): installing the chat on a phone, and the native app in progress
- [The desktop app](#the-desktop-app) (optional)
- [Working on the code](#working-on-the-code)
- [Credits](#credits) and [License](#license)

## Scripts at a glance

Run them in PowerShell, from the project folder. Each one also explains itself in comments at its top.
"Your PC" is where you work on the code; "the server" is the PC that runs the real chat (they can be
the same PC, but the scripts assume two).

| Script | Where | What it does |
|--------|-------|--------------|
| `setup.ps1` | your PC | makes a conda environment and installs the Python packages |
| `start.ps1` | your PC | the chat for trying and developing (http://localhost:8001, its own `dev.db`) |
| `voice.ps1 -Dev` | your PC | voice for development (only reachable from this PC) |
| `scripts\server\install.ps1` | server (as admin) | installs and sets up everything; safe to run again (`-AI`: also the AI bot's model) |
| `serve.ps1`, `voice.ps1` | server | the chat and voice; scheduled tasks start them at boot |
| `llama.ps1` | server | the AI bot's language model (optional); a scheduled task starts it at boot |
| `chattus.ps1` | server | the AI bot, Chattus (optional); a scheduled task starts it at boot (`-Dev`: on your PC, with `start.ps1`) |
| `tools\make_bot.py` | either | makes the bot's account, or gives it a new password (then restart the bot) |
| `scripts\server\update.ps1` | server (as admin) | gets the newest code and restarts the chat (`-Voice`, `-AI`: also those) |
| `scripts\server\backup.ps1` | server | the nightly backup (also by hand) |
| `scripts\server\usage.ps1` | server | how much space everything takes (only reads) |
| `scripts\server\export.ps1` / `import.ps1` | old / new server | pack and unpack the data, to move the server |
| `scripts\server-connect.ps1` | your PC | once: SSH access to the server, named `chatserver` |
| `scripts\deploy.ps1` | your PC | pushes your code and runs `update.ps1` on the server (`-Voice`, `-AI`: also restarts those) |
| `scripts\usage.ps1` | your PC | runs `usage.ps1` on the server |
| `scripts\backup-fetch.ps1` | your PC | copies the server's newest backup here (`-Install`: every day) |
| `scripts\release-upload.ps1` | your PC | puts a new desktop app version on the server |
| `scripts\refresh-icons.bat` | any Windows PC | double-click: Windows shows programs' new icons (after a new app icon) |
| `tools\make_admin.py` | either | make someone an admin, or take it away |
| `tools\feedback.py` | either | read the bug reports and ideas, mark them done |
| `tools\make_pwa_icons.py` | your PC | makes the phone app's icons from the app icon |
| `tools\make_vapid_keys.py` | either | once: the key pair for push notifications, for `.env` |
| `npx expo run:android` (in `mobile\`) | your PC | builds the native phone app, installs it on a phone over USB and starts Metro |
| `npx expo start` (in `mobile\`) | your PC | only Metro, for an app already installed by `run:android` |

---

## Try it on your own PC

You need [Git](https://git-scm.com/) and [Anaconda](https://www.anaconda.com/) or Miniconda (for
Python). In PowerShell:

```powershell
git clone https://github.com/datslok/ChatApp.git
cd ChatApp
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # once: lets PowerShell run scripts you have locally
.\setup.ps1          # makes the "chatapp" conda environment and installs the packages
.\start.ps1          # the chat, on http://localhost:8001, restarting when you change the code (Ctrl+C stops it)
```

Open http://localhost:8001, click **Create one**, and make an account (no invite code is needed
here). Open a second browser window (a private one, so it has its own login) to make a second account
and chat between them. This uses its own database (`dev.db`) and upload folder (`dev-uploads/`), set in
`dev.env`.

To make your account an admin: `python tools\make_admin.py yourname --db dev.db` (with the `chatapp`
environment active: `conda activate chatapp`).

**Voice and video** need LiveKit's server program: download `livekit_<version>_windows_amd64.zip`
from [LiveKit's releases](https://github.com/livekit/livekit/releases) (the version in
`scripts\server\install.ps1`, `$LiveKitVersion`), and put `livekit-server.exe` in a `livekit\` folder
here. Then, in a second PowerShell window: `.\voice.ps1 -Dev`.

---

## Host your own

What you'll end up with: your chat at `https://chat.<your domain>`, running on a PC at home,
starting by itself when that PC starts, with voice and video, nightly backups, and updates with one
command.

### What you need

- **A Windows 10 or 11 PC that's always on.** An old laptop is plenty for a group of friends: any
  4-core CPU, 4–8 GB of memory, an SSD, and **a network cable** (not Wi-Fi, for voice). A second disk
  (or a USB disk that stays plugged in) for the nightly backups is recommended.
- **A domain name, with its DNS on Cloudflare** (the free plan is enough). The chat will live at a
  subdomain like `chat.example.com`, and voice at `voice.example.com`.
- **Access to your router's settings**, to forward two ports for voice. Without that, everything
  except voice, video and screen sharing still works.
- **Optional: an email service with SMTP** (Resend, Brevo, Mailgun, or your own email provider), for
  "forgot password" emails and bug reports to admins. Without it, emails are only written to the log.

In the steps below, replace `example.com` with your domain.

### 1. Cloudflare: a tunnel with two addresses

The tunnel is a program (`cloudflared`) on your server that keeps a connection open to Cloudflare.
Visitors go to Cloudflare, and Cloudflare passes them through that connection, so the chat is
reachable without opening ports for it, and you get HTTPS for free.

1. Add your domain to [Cloudflare](https://dash.cloudflare.com/) if it isn't there yet (Cloudflare
   explains how to point your domain's nameservers to it).
2. In the [Zero Trust dashboard](https://one.dash.cloudflare.com/): **Networks → Tunnels → Create a
   tunnel**, choose **Cloudflared**, and give it a name (like `chatapp`).
3. It shows an install command with a long **token** starting with `eyJ`. Copy just the token and
   keep it for step 4 (it's a password: don't share it).
4. Add two **public hostnames** (also called published application routes) to the tunnel:

   | Hostname | Service |
   |----------|---------|
   | `chat.example.com` | `HTTP` → `localhost:8000` |
   | `voice.example.com` | `HTTP` → `localhost:7880` |

   Cloudflare makes the DNS records for them by itself.

### 2. The server: get the code

On the server PC, open PowerShell and install Git with Windows' own installer:

```powershell
winget install --exact --id Git.Git
# close PowerShell and open it again, so it finds git
cd C:\
git clone https://github.com/datslok/ChatApp.git    # or your own fork
cd C:\ChatApp
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

`C:\ChatApp` is where the scripts on your other PC expect it (`$ServerFolder` in `scripts\deploy.ps1`
and `scripts\usage.ps1`). Somewhere else works too, if you change those two lines.

If you keep your fork **private**, the server needs a way in that works without anyone logged in:
make an SSH key on the server (`ssh-keygen -t ed25519 -f "$HOME\.ssh\github_chatapp" -N '""'`), add
its `.pub` file on GitHub as a **deploy key** (the repository → Settings → Deploy keys, read-only),
point `github.com` at that key in `$HOME\.ssh\config`, and clone with `git@github.com:you/ChatApp.git`.

### 3. The server: settings (`.env`)

```powershell
Copy-Item .env.example .env
notepad .env
```

Every setting is explained in the file. The ones to change:

| Setting | What to put |
|---------|-------------|
| `INVITE_CODE` | The code people need to create an account. Something hard to guess. |
| `PUBLIC_URL` | `https://chat.example.com` |
| `LIVEKIT_URL` | `wss://voice.example.com` |
| `LIVEKIT_API_SECRET` | A long random secret (see below). |
| `SMTP_*`, `MAIL_FROM` | Your email service's details, or leave `SMTP_HOST` empty. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | For notifications on phones while the chat is closed: the two lines `python tools\make_vapid_keys.py` prints (on your PC after `setup.ps1`, or on the server after step 4, with `.venv\Scripts\python.exe`). Empty: no push notifications. |

A random secret, made by PowerShell itself:

```powershell
$bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes); [Convert]::ToBase64String($bytes)
```

`.env` holds your secrets: it's in `.gitignore`, so it never ends up on GitHub.

### 4. The server: install everything

Open PowerShell **as administrator** (right-click it, "Run as administrator"), then:

```powershell
cd C:\ChatApp
.\scripts\server\install.ps1
```

It installs Python (with the packages, in `.venv`), LiveKit and `cloudflared`, adds firewall rules for
voice, sets the power options (never sleep while plugged in; closing the lid does nothing), switches
on Windows' SSH server (only reachable from your home network, for updating from your other PC), and
makes scheduled tasks that start the chat and voice at boot (and again within 5 minutes if they ever
stop). It asks for:

- **The tunnel's token** from step 1.
- **Your Windows password**, so the tasks can start at boot before anyone logs in. With a Microsoft
  account, that's the account's password, not the PIN.
- **The backup disk's drive letter** (Enter for `E`). The backups go into `ChatApp-backups` there,
  every night at 04:00. No second disk? Type a letter that doesn't exist to skip it for now.

At the end it starts the chat and voice and checks they answer. It's safe to run again (for example
after changing your answers); every step checks what's already done.

### 5. The router: two ports for voice

The tunnel carries the chat, but not voice's audio and video (they use UDP, which the tunnel can't
carry). So your router has to send two ports straight to the server:

1. Find the server's local address: `ipconfig` in PowerShell, "IPv4 Address" (like `192.168.1.50`).
   The router's address is the "Default Gateway" on the same screen: open it in a browser.
2. In the router's **port forwarding** settings, forward to the server's address:
   - **UDP 7882** (the normal way for audio and video)
   - **TCP 7881** (the fallback, for networks that block UDP)
3. Give the server a **DHCP reservation** in the router, so its address never changes.

### 6. Your account, and making yourself admin

Open `https://chat.example.com`, click **Create one**, and make your account with the invite code.
Then, on the server, make yourself an admin (admins can edit and delete anyone's messages and
custom emoji, and read the bug reports):

```powershell
cd C:\ChatApp
.venv\Scripts\python.exe tools\make_admin.py yourname
```

### 7. Check

- `https://chat.example.com` works, and you can make an account and chat.
- Voice: join the **Lounge** with someone (or from your phone, off Wi-Fi) and hear each other. In
  `logs\voice.log` near the top, LiveKit should say *"using external IPs"* with your public address.
  If it says *"could not validate external IP"*, the router's forwarding isn't right yet.
- Restart the server without logging in, and wait a minute: the chat should come back by itself.

Then share the address and the invite code with your friends.

**Make it your own:** the channels are a list at the top of `server.py` (`CHANNELS = ["general",
"memes", "chattus"]`; #chattus is the AI bot's, see below) and the voice channel is `VOICE_ROOMS`; change them and update (see below). The "What's
new" page is yours to write (see [What's new](#whats-new)), and the icon should be your own too (see
[License](#license)).

### Optional: a landing page

`static/landing/` is a page about ChatApp (what it is, a screenshot, the features, and buttons to the
chat, the Windows app and creating an account). It's always at `https://chat.example.com/welcome`. To
show it on your main domain (`https://example.com`) instead:

1. In `.env`: `LANDING_HOST=example.com`, then restart the chat (`Stop-ScheduledTask ChatApp;
   Start-ScheduledTask ChatApp`).
2. In the Zero Trust dashboard, add a third public hostname to your tunnel: `example.com` →
   `HTTP` → `localhost:8000` (the same as the chat: the server looks at which address was asked for).
   If Cloudflare says a DNS record for it already exists, delete that record first (and any Redirect
   Rule for it, under your domain → Rules).

The page's buttons lead to your `PUBLIC_URL` by themselves. Someone logged in to the chat sees their
name and **Log out** at the top (the page asks the chat's `/whoami`, which only answers your
`LANDING_HOST`; this needs the main domain and the chat to be the same site, like `example.com` and
`chat.example.com`). Its texts and pictures (`logo.png`,
`screenshot.png`) are yours to change.

### Optional: an AI bot

**Chattus** is a friendly AI cat in the chat: an account like everyone's, which answers every message
in **#chattus**, anything that mentions **@Chattus** elsewhere (as a reply), and DMs to him (he
accepts friend requests by himself). He reads the channel's last 20 messages. In a DM between two
people, a mention invites him in: he may then read and write there for an hour (never join its
calls), and only answers mentions. He can react instead of (or as well as) answering, and knows the
chat's custom emoji by name. He sees pictures: the one in the message he answers and the newest one
just before it (shrunk to 768 pixels first). He looks at each custom emoji once, and keeps a note of
what it shows in `chattus-emoji.json` (git-ignored; delete it to make him look again). The server knows he's a bot from `users.is_bot`, which only
`tools\make_bot.py` sets, so nobody can get this by naming themselves Chattus.

He writes maths as LaTeX ($...$), which the chat draws. He rolls dice ("roll a d20", or "roll: 2d6" without
the model; up to 20 dice and a modifier like `1d20+3`): the model only reads which dice, and Python rolls them. He
makes polls ("poll: Friday dinner? pizza, sushi, tacos", or in his own words): a message with up to 10 numbered
options, and the numbers as reactions under it, so voting is a click and the counts are the result. He searches the web when he needs fresh facts
("search: ..." makes him; "wiki: ..." searches only Wikipedia), at most 100 times a day:
with [Exa](https://exa.ai) through its MCP server, which works without an account but only allows a
few searches now and then from one internet address. When it says no, he searches Wikipedia instead.
For your own, bigger allowance, make a free account at exa.ai and put its key in `.env` as
`EXA_API_KEY`. Only the search words leave the server, never the chat's messages. (With Claude instead of the
local model, see below, he searches with Claude's own web search tool instead of Exa, paid per search.)

His language model runs on the server's own graphics card, with
[llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`): Qwen 3.5 9B, shrunk to 4 bits
per number, which also understands pictures. Nothing goes to an AI company. It needs an **NVIDIA
graphics card with 8 GB** (a GTX 1070 is enough: about 25 tokens, or 18 words, a second) with a driver
from 2024 or newer, and 7 GB of disk. In PowerShell as administrator:

```powershell
cd C:\ChatApp
.\scripts\server\install.ps1 -AI
```

It runs all of step 4 again (same questions), and then step 9: it downloads llama.cpp into `llama\`
and the model into `llama\models\` (6.3 GB; both checked against their published checksums), puts a
key for it (`LLAMA_API_KEY`) in `.env`, makes the bot's account (`tools\make_bot.py`: the account
**Chattus** with the app icon as its picture, and a random password in `.env` as `CHATTUS_PASSWORD`),
and makes two scheduled tasks: **ChatApp AI** runs `llama.ps1` (the model) and **ChatApp bot** runs
`chattus.ps1` (the bot, `chattus.py`), both at boot. The model is only reachable from the server
itself (`http://127.0.0.1:8080`), and only with that key. The bot connects to the chat on the server
too (`http://127.0.0.1:8000`), and logs in again by itself whenever the chat restarts.

The channel **#chattus** is in `CHANNELS` in `server.py`; without the bot, it's just a quiet channel
(take it out if you don't use the bot). His personality is `SYSTEM_PROMPT` at the top of
`chattus.py`.

The model lives on the graphics card the whole time (about 7 GB of its memory). The CPU stays nearly
free, so calls aren't affected. While it writes an answer, the graphics card works at full power for
a few seconds and the laptop gets warmer.

To talk to the model directly: llama-server has its own chat page. From your PC, open a tunnel to it
with `ssh -L 8080:127.0.0.1:8080 chatserver`, leave that window open, and go to http://localhost:8080.
It asks for the key: on the server, `Select-String LLAMA_API_KEY .env` shows it.

**Or Claude instead of the local model** (no graphics card needed): with `CHATTUS_MODEL` in `.env`, his
answers come from Anthropic's API, through its `anthropic` package. Make an account at
[platform.claude.com](https://platform.claude.com), add a little credit (and a monthly spending limit),
create an API key, and add two lines to `.env`, then restart the bot (`Stop-ScheduledTask "ChatApp bot";
Start-ScheduledTask "ChatApp bot"`):

```
CHATTUS_MODEL=claude-haiku-5-5
ANTHROPIC_API_KEY=sk-ant-...
```

Claude Haiku 5.5 is small, quick and cheap: a group of friends chatting with him costs well under a
dollar a month. **But then the chat's messages leave your server:** to answer, he sends Anthropic the
channel's last 20 messages and the pictures he looks at, so tell your friends. Without `CHATTUS_MODEL`
(or with the line empty), he uses the local model again.

With Claude he also keeps **reminders** ("remind me tomorrow at 9 to call mum", "in 20 minutes", or
"remind: ..."): the model copies the words into fields (a day, a time, or an amount and a unit) and Python
works out the moment; he confirms the time he saved, and then mentions the person where they asked (a DM
between friends: in their DM with him). They're kept in `chattus-reminders.json` (git-ignored), so restarts
don't lose them; times are the server's clock, up to a year ahead, at most 20 waiting per person. (The local
model got the times wrong too often, so it has no reminders.) With Claude, the ChatApp AI task (the local
model) isn't needed; disable it to free the graphics card (`Disable-ScheduledTask "ChatApp AI";
Stop-ScheduledTask "ChatApp AI"`).

**Working on the bot** on your PC, with the development chat (`start.ps1`) and the server's model
through that same tunnel:

```powershell
python tools\make_bot.py --db dev.db --uploads dev-uploads --env dev-chattus.env   # once: Chattus in dev.db
# then add the server's key to dev-chattus.env (git-ignored), as a line LLAMA_API_KEY=...
.\chattus.ps1 -Dev    # with start.ps1 running, and the tunnel open in another window
```

With Claude, put `CHATTUS_MODEL` and `ANTHROPIC_API_KEY` in `dev-chattus.env` instead; no tunnel needed.

### 8. Optional: update from your other PC

So you can work on the code on your own PC and update the server without walking over to it. Step 4
printed a line for this at its end; run it here, in the project folder:

```powershell
.\scripts\server-connect.ps1 192.168.1.50 yourname    # the server's address and your Windows username there
```

It makes an SSH key on this PC (if you don't have one), puts it on the server (asking for your
password there once), and names the server **chatserver**: after that, `ssh chatserver` logs in
without a password, and `scripts\deploy.ps1` works.

---

## Running it

### Updating

From your own PC, after committing your changes:

```powershell
.\scripts\deploy.ps1          # pushes to GitHub if needed, then updates the server and restarts the chat
.\scripts\deploy.ps1 -Voice   # also restart LiveKit (after changing voice.ps1 or livekit.yaml); ends ongoing calls
.\scripts\deploy.ps1 -AI      # also restart the AI bot's llama-server (after changing llama.ps1)
```

The AI bot (if you set it up) restarts with every update, so it always runs the newest `chattus.py`.

Or on the server itself (PowerShell as administrator, in `C:\ChatApp`): `.\scripts\server\update.ps1`.
Both fetch the newest code from GitHub, install any new packages and restart the chat. Calls carry on
(unless you restart voice too).

Open pages and apps reload themselves within a few seconds after an update that changed the page:
nobody needs to press F5. Someone in a call, with files waiting to be sent, or editing a message gets
the new version once they're done; a half-typed message is kept.

If your internet provider changes your home's public IP address, restart voice
(`.\scripts\deploy.ps1 -Voice`, or restart the server): LiveKit looks up the address when it starts.

### What's new

Settings → **What's new** shows `static/changelog.json`, which you write by hand, in two parts:
`changes` (what changed when, newest day first) and `features` (an overview of everything the chat can
do, by topic). Both are short lines for the people using it, and can use the chat's formatting
(`**bold**`, `` `code` `` and so on). Any change to `changes` (a new line, or an edited one) puts a red
dot on everyone's ⚙️ until they've opened the page.

```json
{
  "features": [
    {"topic": "💬 Messages", "items": ["Enter sends, Shift+Enter starts a new line", "..."]}
  ],
  "changes": [
    {"date": "2026-10-13", "items": ["Something new", "And something else"]},
    {"date": "2026-10-12", "items": ["..."]}
  ]
}
```

The file in this repository describes the original's history: for your own chat, you may want to
start `changes` from scratch.

### Handy commands (on the server)

From your PC, `ssh chatserver` gives you a PowerShell on the server; then `cd C:\ChatApp`. Or sit at
the server itself, in PowerShell as administrator.

```powershell
# Admins.
.venv\Scripts\python.exe tools\make_admin.py --list              # who's an admin?
.venv\Scripts\python.exe tools\make_admin.py alex                # make alex an admin
.venv\Scripts\python.exe tools\make_admin.py alex --remove       # take it away again

# Bug reports and ideas (Settings → Bugs & ideas). Each one is also emailed to every admin with an
# email address. Admins can read them and tick them off in the chat too: Settings → Inbox.
.venv\Scripts\python.exe tools\feedback.py                       # the ones not done yet
.venv\Scripts\python.exe tools\feedback.py --done 12             # tick off #12 (--undo 12: back again)
.venv\Scripts\python.exe tools\feedback.py --all                 # every one, done ones too

# Is everything running? (ChatApp, voice, AI and bot: Running. ChatApp backup: Ready.)
Get-ScheduledTask ChatApp*

# The logs. chat.log: starts and errors; chat.out.log: every request; voice.log: LiveKit;
# ai.log: llama-server (the AI bot's model); bot.log: what the bot answered, bot.errors.log: its crashes.
Get-Content logs\chat.log -Tail 30
Get-Content logs\chat.log -Tail 30 -Wait                         # keep following it (Ctrl+C stops)
Get-Content logs\backup.log -Tail 5

# Restart by hand (update.ps1 does this too).
Stop-ScheduledTask ChatApp; Start-ScheduledTask ChatApp
Stop-ScheduledTask "ChatApp voice"; Start-ScheduledTask "ChatApp voice"
Stop-ScheduledTask "ChatApp AI"; Start-ScheduledTask "ChatApp AI"
Stop-ScheduledTask "ChatApp bot"; Start-ScheduledTask "ChatApp bot"

# The graphics card: its memory in use, how busy it is, its temperature (for the AI bot).
nvidia-smi

# The tasks start again by themselves within 5 minutes when they aren't running. To keep one off
# for a while, disable it, and enable it again afterwards:
Disable-ScheduledTask "ChatApp voice"; Stop-ScheduledTask "ChatApp voice"
Enable-ScheduledTask "ChatApp voice"

# What Task Scheduler did (started, stopped, failed), newest first. Also in taskschd.msc, History.
Get-WinEvent Microsoft-Windows-TaskScheduler/Operational -MaxEvents 20 | Format-Table TimeCreated, Message -Wrap

# A backup now, besides the nightly one.
.\scripts\server\backup.ps1 -Destination E:\ChatApp-backups

# How much space everything takes, and how much is free (only reads).
.\scripts\server\usage.ps1
```

(Stopping a task can leave its program running; if a restart doesn't seem to take, use
`.\scripts\server\update.ps1`, which also ends those.) On your own PC, `tools\make_admin.py` and
`tools\feedback.py` work the same with `--db dev.db`, for the development chat.

### Backups

Every night at 04:00 the server backs itself up onto its backup disk (`E:\ChatApp-backups` by default;
the scheduled task **ChatApp backup**):

- `2026-10-11\chat.db` and `.env`: a safe copy of the database (and the settings) per day, the last 30 kept
- `uploads\` and `releases\`: every file, new ones added each night, nothing deleted

Your own PC can fetch the newest one too, so there's a copy outside the server:

```powershell
.\scripts\backup-fetch.ps1 -Install    # a daily task (05:00, or as soon as this PC is on)
.\scripts\backup-fetch.ps1             # fetch now
```

That copy goes into `~\ChatApp-backups` (your user folder). Logs: `logs\backup.log` on the server,
`~\ChatApp-backups\fetch.log` on your PC.

**Restoring** (on the server, PowerShell as administrator, in `C:\ChatApp`):

```powershell
Stop-ScheduledTask ChatApp                               # stop the chat (voice can keep running)
Copy-Item E:\ChatApp-backups\2026-10-11\chat.db chat.db  # the day to go back to
robocopy E:\ChatApp-backups\uploads uploads /E           # brings back missing uploads
Start-ScheduledTask ChatApp
```

Everything after that day's 04:00 is lost (messages, accounts, settings changed since).

### Moving to another PC

1. **On the old server:** `.\scripts\server\export.ps1` makes `chatapp-data.zip` with `chat.db` (a safe
   copy, even while the chat runs), `uploads\`, `releases\` and `.env`. Copy it to a USB stick. **It
   holds your secrets and everyone's messages**: delete it everywhere once the move is done.
2. **On the new PC:** steps 2 and 4 of [Host your own](#host-your-own), but instead of writing `.env`
   (step 3), unpack the data before installing: `.\scripts\server\import.ps1 D:\chatapp-data.zip`.
   For the tunnel's token, use the same tunnel: in the Zero Trust dashboard, your tunnel → **Add a
   connector** (or Configure) shows it.
3. **On the old server**, as administrator: `cloudflared service uninstall` (otherwise the tunnel sends
   some visitors to the old PC), and stop its scheduled tasks.
4. **The router:** change the two port forwardings to the new PC's address, and give it a DHCP reservation.
5. **On your PC:** `.\scripts\server-connect.ps1` with the new address, then check as in step 7.

### A shared window goes black

Sharing a single browser window (say, YouTube in Chrome) and then covering it with another window
makes the share go black, and it comes back as soon as a bit of the window shows again. That's the
browser, not the chat: Chrome and Edge stop drawing a window that's completely covered, to save
power, without knowing that another program is capturing it. Ways around it, for whoever shares:

- Share the **entire screen** instead of the window (the others then see whatever is on top).
- Keep the shared window uncovered, for example on a second screen.
- Start Chrome or Edge with `--disable-features=CalculateNativeWinOcclusion` (right-click its
  shortcut, Properties, add it to the end of Target after a space; close every window of it first).

---

## The phone app

The chat installs on phones as a **PWA** ("progressive web app"): its own icon on the home screen and
its own window without the browser's address bar, straight from the website, with no app store. It's
the same page as in the browser, so it's always up to date. What makes it installable:
`static/manifest.json` (its name, icons and colours), the icons in `static/icons/` (made by
`python tools\make_pwa_icons.py` from the app icon) and a service worker, `static/sw.js`.

To install it: open the chat on the phone. A banner above the messages offers **Install** (Chrome on
Android opens its install dialog), and in the installed app then **Turn on** for notifications. By hand:
Chrome's ⋮ menu, **Install app** (or "Add to Home screen"); on an **iPhone**: Safari, the Share
button, **Add to Home Screen**.

**Notifications while the chat is closed** (push notifications): Settings → Notifications → "Notifications
on this device when the chat is closed", on each phone (or browser) that should get them. They come for
DMs, mentions and calls, only while you're not looking at the chat on any device, and follow "Mute
notifications". The server needs the VAPID keys in `.env` for this (see "The server: settings"). On an
iPhone they only work in the installed app (Add to Home Screen), not in Safari itself.

If the microphone or camera "isn't allowed" although the site allows it, Android may be blocking the
browser itself: Settings, Apps, Chrome (and the installed ChatApp), Permissions, Microphone and Camera.

Calls keep going with the screen off on most Android phones. If a call stops when the phone is in a
pocket, set the browser's battery use to "Unrestricted" in Android's app settings. iPhones often stop
web pages when they're locked, calls included.

### The native app (in progress)

A real Android app is being built in `mobile\` with [React Native](https://reactnative.dev/) and
[Expo](https://expo.dev/), talking to the same server. It can't do anything useful yet; the PWA above
is the phone app for now. To work on it:

1. Install [Node.js](https://nodejs.org/) (LTS), [Android Studio](https://developer.android.com/studio)
   (`winget install Google.AndroidStudio`; open it once and let it install the Android SDK) and a
   Java 17 (`winget install Microsoft.OpenJDK.17`; newer Java versions break the build).
2. Set two user environment variables (Windows search, "Edit environment variables for your account"):
   `ANDROID_HOME` to `%LOCALAPPDATA%\Android\Sdk` and `JAVA_HOME` to the Java 17 folder (in
   `C:\Program Files\Microsoft\`), and add `%LOCALAPPDATA%\Android\Sdk\platform-tools` to `Path`.
3. On the phone: turn on Developer options (Settings, About phone, Software information, tap
   "Build number" seven times), then USB debugging in them. Plug it in and allow the PC.
   `adb devices` should list it.
4. In PowerShell:

```powershell
cd mobile
npm install
npx expo run:android
```

The first build downloads a lot (Gradle, the NDK) and takes a while. It installs a **development
build** on the phone: the native part is built once, and the JavaScript comes live from **Metro**
on your PC, so saving `App.js` changes the app within a second. The phone needs to be on the same
network as the PC. Shake the phone for the developer menu (Reload, DevTools).

Later, when only JavaScript changed, `npx expo start` is enough. Run `npx expo run:android` again
after adding a package with native code. Add packages with `npx expo install <name>` (not
`npm install`), so you get the version that matches Expo. The `android\` folder is generated from
`app.json` (and not in git): never edit it by hand. After changing `app.json`, run
`npx expo prebuild --clean` first, which makes it again, then `npx expo run:android`.

---

## The desktop app

Optional: everything works in the browser. The Windows app (`desktop\`, made with
[Tauri](https://tauri.app/)) is a small window around your site, with real Windows notifications,
links opening in the default browser, automatic updates, and (Settings → App behaviour, off by default)
starting when Windows starts. Changes to the chat reach it through the
site; a new app version is only needed when the app itself changes (its Rust code, plugins, the icon).
People download it from `https://chat.example.com/download`.

Building it needs [Node.js](https://nodejs.org/) and [Rust](https://rustup.rs/). In `desktop\`,
`npm install` once, then `npm run tauri dev` opens the app straight from the code.

### Making it yours

The app in this repository points at the original chat and is signed with its key. For your own:

1. **Your address**, in three places: `desktop\src-tauri\tauri.conf.json` (`app.windows[0].url`, and
   `plugins.updater.endpoints`: `https://chat.example.com/releases/latest.json`) and
   `desktop\src-tauri\capabilities\default.json` (`remote.urls`: `https://chat.example.com/*`).
2. **Your own app id**: `identifier` in `tauri.conf.json` (like `com.example.chat`), so it doesn't
   collide with the original's app on someone's PC.
3. **Your own signing key.** Updates are only installed if they're signed with the key the app was
   built with. Make one (press Enter twice when it asks for a password, for none), and put the
   **public** key it prints in `tauri.conf.json` (`plugins.updater.pubkey`):
   ```powershell
   npm run tauri signer generate -- -w "$HOME\.tauri\chatapp.key"
   ```
   Keep the private key safe and never commit it: without it, installed apps can't update any more,
   and everyone would have to reinstall by hand.
4. **Your own icon** (see [Changing the icon](#changing-the-icon)).

### Releasing a version

Everyone's app installs a new version by itself (open apps when they reconnect after the server
restarts, or after their call; the others at their next start).

1. Raise `"version"` in `desktop\src-tauri\tauri.conf.json` (like 0.1.8 → 0.1.9).
2. Build and sign it, in `desktop\`:
   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = "$HOME\.tauri\chatapp.key"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   npm run tauri build
   ```
3. Copy `ChatApp_<version>_x64-setup.exe` and its `.sig` from
   `desktop\src-tauri\target\release\bundle\nsis\` into `releases\` (in the project folder).
4. Write `releases\latest.json` (what the apps and the download page read):
   ```json
   {
     "version": "0.1.9",
     "platforms": {
       "windows-x86_64": {
         "url": "https://chat.example.com/releases/ChatApp_0.1.9_x64-setup.exe",
         "signature": "the whole contents of the .sig file"
       }
     }
   }
   ```
5. Commit the version change, then put it on the server:
   ```powershell
   git add desktop; git commit -m "Desktop app 0.1.9: ..."
   .\scripts\release-upload.ps1
   ```
   It copies the installer and `latest.json` into the server's `releases\`, deletes the older versions
   there and in your own `releases\` (the apps only ever update upwards; the nightly backup keeps every
   version), and then runs `deploy.ps1`, whose restart makes open apps look for the new version.

**Testing the update window** (what people see while the app updates): in `desktop\`, make a file
`pretend.json` containing `{"version": "0.1.0"}`, then `npm run tauri dev -- --config pretend.json`.
The app then believes it's old, finds the live version, and updates to it.

### Changing the icon

Put the new picture (a 1024×1024 PNG) in `icon\`, then in `desktop\`:
`npm run tauri icon ../icon/<file>.png` (delete the `android`, `ios`, `Square*`/`StoreLogo` and
`icon.icns` files it also makes), copy `desktop\src-tauri\icons\icon.ico` to `static\favicon.ico`
(the browser tab's icon; also raise the number in the pages' `favicon.ico?v=` links, so browsers fetch
the new one instead of keeping the old one for a day), point `tools\make_installer_images.py` at the
new file (its `ICON` line), run `python tools\make_installer_images.py` (the installer's pictures and the
update window's cat), and release a new version. The phone app's icons: `python tools\make_pwa_icons.py`
(it reads the same `ICON` file name; change it there too).

### The old icon is still showing after an update

Windows keeps a cache of every icon it has shown, and doesn't always notice when a program's icon
changes: the taskbar, Start menu or desktop can keep showing the old one after the app has updated.
**`scripts\refresh-icons.bat`** fixes that: double-click it. It stops Explorer (the taskbar and desktop
disappear for a moment; nothing else closes), deletes the icon cache, and starts Explorer again, which
then reads every icon fresh. If a program pinned to the taskbar still shows its old icon, unpin it and
pin it again.

It's a plain `.bat` file, so you can send it to the people using your chat (in the chat itself, for
example) and they can run it with a double-click. Downloaded files make Windows ask first: choose
**Run** (or **More info → Run anyway**).

---

## Working on the code

- `server.py`: the whole server: accounts, messages, channels, uploads, link previews, voice tickets,
  the WebSocket. Sections are marked with `# ---------- Name ----------` comments.
- `static/index.html`, `static/css/chat.css` and `static/js/`: the chat page. The scripts are plain
  scripts sharing one global scope, loaded in the order listed in `index.html`.
- `static/login.html`, `reset.html`, `download.html`: the other pages.
- `chattus.py`: the AI bot (optional), a separate program that talks to the server like a browser.
- `livekit.yaml`: LiveKit's settings. `desktop/`: the Windows app. `mobile/`: the native phone app
  (in progress). `tools/`: small helper programs.
- [ROADMAP.md](ROADMAP.md): what's done and what's planned.

The code is written to be read: comments explain the *why*, and there are no build steps. Develop
with `start.ps1` (it restarts when you save), and try things in two browser windows.

**CLAUDE.md** is the original author's instruction file for [Claude Code](https://claude.com/claude-code),
the AI assistant this project was built with: how they like to work (small steps, explained first)
and notes about their setup. If you use Claude Code with your copy and want a different workflow,
write your own `CLAUDE.md`.

## Credits

The app icons (the cats) are made by Niamh Hannon.

## License

The code is under the [MIT license](LICENSE): use it, change it and run your own copy. The cat icon
isn't: it belongs to Niamh Hannon, so a copy of your own should use its own icon. LiveKit's browser
library and the RNNoise files keep their own licenses (see [LICENSE](LICENSE)).
