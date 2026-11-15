# Running it

## Updating

From your own PC, after committing your changes:

```powershell
.\scripts\deploy.ps1          # pushes to GitHub if needed, then updates the server and restarts the chat
.\scripts\deploy.ps1 -Voice   # also restart LiveKit (after changing voice.ps1 or livekit.yaml); ends ongoing calls
.\scripts\deploy.ps1 -AI      # also restart the AI bot's llama-server (after changing llama.ps1)
```

The AI bot (if you set it up) restarts with every update, so it always runs the newest `chattus.py`.

`deploy.ps1` updates the server, the web page and the Windows app's pages, but not the phone app: its code goes
out separately. If people use the phone app, run `.\scripts\app-update.ps1` instead (it deploys too), so a change
goes live everywhere at once rather than on PCs first (see [the phone app's guide](phone-app.md)). If the phone
part needs a new APK, it says so. Changes to the Windows app itself need a release of their own
([desktop-app.md](desktop-app.md)).

Or on the server itself (PowerShell as administrator, in `C:\ChatApp`): `.\scripts\server\update.ps1`.
Both fetch the newest code from GitHub, install any new packages and restart the chat. Calls carry on
(unless you restart voice too).

Open pages and apps reload themselves within a few seconds after an update that changed the page:
nobody needs to press F5. Someone in a call, with files waiting to be sent, or editing a message gets
the new version once they're done; a half-typed message is kept.

If your internet provider changes your home's public IP address, restart voice
(`.\scripts\deploy.ps1 -Voice`, or restart the server): LiveKit looks up the address when it starts.

## Updating cloudflared

The tunnel program doesn't update itself. Update it when Cloudflare asks (they email the account's owner
about security fixes), or now and then. On the server, in PowerShell as administrator:

```powershell
cloudflared --version                                    # the version you have
winget upgrade --exact --id Cloudflare.cloudflared       # install.ps1 installed it with winget
Restart-Service cloudflared
```

winget can lag a few days behind a release. If it says there's nothing newer, take the
`cloudflared-windows-amd64.msi` from [cloudflared's releases](https://github.com/cloudflare/cloudflared/releases),
check it against the SHA-256 GitHub shows next to it (`Get-FileHash <file>`), install it with
`msiexec /i <file> /quiet`, and restart the service.

The restart cuts the site off for about half a minute (cloudflared lets open connections finish first, so
`Restart-Service` may say it couldn't stop the service: wait, then `Start-Service cloudflared`). Pages and
apps reconnect by themselves; a call going on at that moment may stutter, so pick a time nobody is in voice.

## What's new

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

## Handy commands (on the server)

From your PC, `ssh chatserver` gives you a PowerShell on the server; then `cd C:\ChatApp`. Or sit at
the server itself, in PowerShell as administrator.

```powershell
# Admins.
.venv\Scripts\python.exe tools\make_admin.py --list              # who's an admin?
.venv\Scripts\python.exe tools\make_admin.py alex                # make alex an admin
.venv\Scripts\python.exe tools\make_admin.py alex --remove       # take it away again

# Bug reports and ideas (Settings → Bugs & ideas). Each one is also emailed to every admin with an
# email address. Admins can read them and tick them off in the chat too: Settings → Admin → Inbox.
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

## Backups

Every night at 04:00 the server backs itself up onto its backup disk (`E:\ChatApp-backups` by default;
the scheduled task **ChatApp backup**):

- `2026-10-11\chat.db` and `.env` (and `firebase-key.json`): a safe copy of the database (and the settings) per day, the last 30 kept
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

## Moving to another PC

1. **On the old server:** `.\scripts\server\export.ps1` makes `chatapp-data.zip` with `chat.db` (a safe
   copy, even while the chat runs), `uploads\`, `releases\`, `.env` and `firebase-key.json`. Copy it to a USB stick. **It
   holds your secrets and everyone's messages**: delete it everywhere once the move is done.
2. **On the new PC:** steps 2 and 4 of [Host your own](hosting.md), but instead of writing `.env`
   (step 3), unpack the data before installing: `.\scripts\server\import.ps1 D:\chatapp-data.zip`.
   For the tunnel's token, use the same tunnel: in the Zero Trust dashboard, your tunnel → **Add a
   connector** (or Configure) shows it.
3. **On the old server**, as administrator: `cloudflared service uninstall` (otherwise the tunnel sends
   some visitors to the old PC), and stop its scheduled tasks.
4. **The router:** change the two port forwardings to the new PC's address, and give it a DHCP reservation.
5. **On your PC:** `.\scripts\server-connect.ps1` with the new address, then check as in step 7.

## A shared window goes black

Sharing a single browser window (say, YouTube in Chrome) and then covering it with another window
makes the share go black, and it comes back as soon as a bit of the window shows again. That's the
browser, not the chat: Chrome and Edge stop drawing a window that's completely covered, to save
power, without knowing that another program is capturing it. Ways around it, for whoever shares:

- Share the **entire screen** instead of the window (the others then see whatever is on top).
- Keep the shared window uncovered, for example on a second screen.
- Start Chrome or Edge with `--disable-features=CalculateNativeWinOcclusion` (right-click its
  shortcut, Properties, add it to the end of Target after a space; close every window of it first).
