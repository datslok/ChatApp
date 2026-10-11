# ChatApp

A small Discord-style chat app for me and my friends, built as a learning project. It runs at
https://chat.datslok.no, served from a PC at home.

Backend in Python ([FastAPI](https://fastapi.tiangolo.com/) with WebSockets, SQLite), frontend in
plain HTML, CSS and JavaScript. Voice, video and screen sharing go through a self-hosted
[LiveKit](https://livekit.io/) server. There's also a Windows desktop app ([Tauri](https://tauri.app/)).

**Features:** text channels and direct messages, friends, accounts with profiles (pictures, banners,
status), replies, reactions and custom emoji, @mentions, unread dots, notifications, image and file
uploads, a Lounge voice channel and calls in DMs (with a noise gate and volume per person), cameras,
screen sharing (up to 1440p60), and a desktop app that updates itself.

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
.\server-export.ps1
```

That makes `chatapp-data.zip` with `chat.db` (a safe copy, even while the chat runs), `uploads/`,
`releases/` and `.env`. Copy it to a USB stick. **It holds the secrets and everyone's messages**:
delete it everywhere once the move is done.

### 2. On the new PC: get the code

Open PowerShell and install Git (Windows' own `winget` does it), then fetch the code:

```powershell
winget install --exact --id Git.Git
# close PowerShell and open it again, so it finds git
cd C:\
git clone https://github.com/datslok/ChatApp.git
cd C:\ChatApp
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # once: lets you run scripts from this PC
```

(Windows doesn't run PowerShell scripts at all out of the box. `RemoteSigned` lets your own run,
while scripts downloaded from the internet still need a signature.)

### 3. On the new PC: unpack the data

Put `chatapp-data.zip` in `C:\ChatApp` (or point to it on the stick), then:

```powershell
.\server-import.ps1                        # or: .\server-import.ps1 E:\chatapp-data.zip
```

### 4. On the new PC: install everything

Open PowerShell **as administrator** (right-click it, "Run as administrator"), then:

```powershell
cd C:\ChatApp
.\server-install.ps1
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
.\server-connect.ps1 192.168.10.123 yourname    # the server PC's address and your username there
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
.\deploy.ps1                 # pushes to GitHub if needed, then updates the server and restarts the chat
.\deploy.ps1 -Voice          # also restart LiveKit (after changes to voice.ps1 or livekit.yaml)
.\release-upload.ps1         # after building a new desktop app version: copy it to the server
ssh chatserver               # a PowerShell on the server (type exit to leave)
ssh chatserver "Get-Content C:\ChatApp\logs\chat.log -Tail 30"   # the chat's latest log lines
```

On the server itself, in `C:\ChatApp` (as administrator): `.\server-update.ps1` does what
`deploy.ps1` does, `Get-ScheduledTask ChatApp*` shows whether the tasks run, and
`Get-Content logs\chat.log -Tail 30 -Wait` follows the log (Ctrl+C to stop watching).

After the internet provider changes your home IP, restart voice (`.\deploy.ps1 -Voice`, or restart
the server PC): LiveKit looks up the IP when it starts.

New desktop app versions are still built on the development PC (it has the signing key), then
`release-upload.ps1` puts them on the server (see CLAUDE.md, "Releasing").

## Roadmap

See [ROADMAP.md](ROADMAP.md) for what's planned and what's done.

## Credits

The app icon (the black cat) is made by Niamh Hannon.
