# Host your own

What you'll end up with: your chat at `https://chat.<your domain>`, running on a PC at home,
starting by itself when that PC starts, with voice and video, nightly backups, and updates with one
command.

## What you need

- **A Windows 10 or 11 PC that's always on.** An old laptop is plenty for a group of friends: any
  4-core CPU, 4–8 GB of memory, an SSD, and **a network cable** (not Wi-Fi, for voice). A second disk
  (or a USB disk that stays plugged in) for the nightly backups is recommended.
- **A domain name, with its DNS on Cloudflare** (the free plan is enough). The chat will live at a
  subdomain like `chat.example.com`, and voice at `voice.example.com`.
- **Access to your router's settings**, to forward two ports for voice. Without that, everything
  except voice, video and screen sharing still works.
- Nothing else to download by hand: `install.ps1` gets Python, LiveKit, `cloudflared` and **ffmpeg**
  (which re-packs uploaded videos so phones can tell how long they are and skip in them).
- **Optional: an email service with SMTP** (Resend, Brevo, Mailgun, or your own email provider), for
  "forgot password" emails and bug reports to admins. Without it, emails are only written to the log.

In the steps below, replace `example.com` with your domain.

## 1. Cloudflare: a tunnel with two addresses

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

## 2. The server: get the code

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

## 3. The server: settings (`.env`)

```powershell
Copy-Item .env.example .env
notepad .env
```

Every setting is explained in the file. The ones to change:

| Setting | What to put |
|---------|-------------|
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

## 4. The server: install everything

Open PowerShell **as administrator** (right-click it, "Run as administrator"), then:

```powershell
cd C:\ChatApp
.\scripts\server\install.ps1
```

It installs Python (with the packages, in `.venv`), ffmpeg, LiveKit and `cloudflared`, adds firewall rules for
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

## 5. The router: two ports for voice

The tunnel carries the chat, but not voice's audio and video (they use UDP, which the tunnel can't
carry). So your router has to send two ports straight to the server:

1. Find the server's local address: `ipconfig` in PowerShell, "IPv4 Address" (like `192.168.1.50`).
   The router's address is the "Default Gateway" on the same screen: open it in a browser.
2. In the router's **port forwarding** settings, forward to the server's address:
   - **UDP 7882** (the normal way for audio and video)
   - **TCP 7881** (the fallback, for networks that block UDP)
3. Give the server a **DHCP reservation** in the router, so its address never changes.

## 6. Your account (the admin)

Open `https://chat.example.com`, click **Create one**, and make your account. The very first account
needs no invite link (everyone after you does), and becomes the admin and the **owner** by itself:
admins can edit and delete anyone's messages and custom emoji, manage channels and roles, read the bug
reports and ban people (Settings → Admin), and the owner can also make others admins there, or ban an
admin. Nobody can ban the owner. Click
the link in the email you get to verify your address (without `SMTP_HOST`, it's in `logs\chat.log`
instead).

To make someone an admin from the server instead (or yourself, on a server from before owners existed):

```powershell
cd C:\ChatApp
.venv\Scripts\python.exe tools\make_admin.py theirname
```

## 7. Check

- `https://chat.example.com` works, and you can make an account and chat.
- Voice: join the **Lounge** with someone (or from your phone, off Wi-Fi) and hear each other. In
  `logs\voice.log` near the top, LiveKit should say *"using external IPs"* with your public address.
  If it says *"could not validate external IP"*, the router's forwarding isn't right yet.
- Restart the server without logging in, and wait a minute: the chat should come back by itself.

Then invite your friends: **People** (top left) → **Invite someone** makes a link that lets one person make
an account, within a week. Anyone in the chat can make them, so friends can invite their friends too, and
the `invites` table remembers who invited whom. Opening a link shows the landing page first (or `/welcome`
without `LANDING_HOST`), with "*name* invited you" and a **Create your account** button: the browser keeps
the invite as a cookie for a week, so people can read about the chat before signing up. New accounts confirm their email address with a link before
they get in (and so does a new address from Settings), so password resets always reach them.

**Make it your own:** a new chat starts with #general, #memes and #chattus (the AI bot's, see below).
Admins (`tools/make_admin.py`) add, rename, move and delete channels, and headings to group them, in
Settings → Admin → Channels. A channel ticked **Private** there is only for the roles ticked under it (and the owner and bots: other admins
don't see it unless they have one of its roles), and a
role ticked **Limited** (Settings → Admin → Roles) sees nothing but its private channels, DMs and groups
(no other channels, no Lounge): for family who only need one channel with you, say. A role ticked **Hidden**
is only known to admins (no name colour, member list section or profile tag for anyone else). The voice channel is `VOICE_ROOMS` in `chatapp/voice.py`; change it and update (see below). The "What's
new" page is yours to write (see [What's new](running.md#whats-new)), and the icon should be your own too (see
[License](../../README.md#license)).

## Optional: a landing page

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
`screenshot.png`) are yours to change. `python tools\make_screenshot.py` makes a new screenshot on a
throwaway chat of its own (test accounts, a conversation showing the maths, a poll and the rest, never
your real chat), photographed with Edge; change its conversation to your liking.

## Optional: GIF search

The **GIF** button next to the text box searches [GIPHY](https://giphy.com). It needs a key, which
is free: make an account at [developers.giphy.com](https://developers.giphy.com), click **Create an
App**, choose **API**, and give it a name and description. Put the key in `.env` as
`GIPHY_API_KEY=...`, then restart the chat (`Stop-ScheduledTask ChatApp; Start-ScheduledTask ChatApp`).

How it works: the page asks your server, and your server asks GIPHY, so the key stays on the server.
The free key allows about 100 searches an hour for the whole site, which is plenty for a group of
friends: the server remembers each search's answer for an hour, and each person can make 20 requests
a minute. A GIF someone sends is downloaded by the server and saved like an uploaded picture (an
animated WebP, usually a few hundred KB), so it stays even if GIPHY removes it, and only the person
searching ever loads anything from GIPHY. The age rating is `pg-13` (`GIF_RATING` in chatapp/web.py).

## Optional: a seasonal easter egg

During a season, a small emoji sits on the corner of everyone's own picture at the bottom left, and
clicking it plays that season's video. The seasons are `SEASONS` in `chatapp/pages.py` (Halloween: October, 🎃,
`halloween.mp4`; Christmas: December, a Santa hat, `christmas.mp4`); add one with a line there. The videos aren't in git: they go in a `seasonal\` folder on
the server, from your PC with

```powershell
.\scripts\seasonal-upload.ps1 path\to\video.mp4 halloween
```

Any MP4 works: the server re-packs a fragmented one by itself (see **Videos** under
[Try it on your own PC](../../README.md#try-it-on-your-own-pc)), so the phone app can show its length. A season whose video isn't there shows nothing. The videos are only sent to people who are logged in,
and the nightly backup and `export.ps1` include them.

## 8. Optional: update from your other PC

So you can work on the code on your own PC and update the server without walking over to it. Step 4
printed a line for this at its end; run it here, in the project folder:

```powershell
.\scripts\server-connect.ps1 192.168.1.50 yourname    # the server's address and your Windows username there
```

It makes an SSH key on this PC (if you don't have one), puts it on the server (asking for your
password there once), and names the server **chatserver**: after that, `ssh chatserver` logs in
without a password, and `scripts\deploy.ps1` works.

### Reaching the server from outside your home network

The server only accepts SSH from its own network, and that's worth keeping: no port on your router has to
open. The Cloudflare Tunnel already leaves the server on its own, so SSH can travel through it too, with a
Cloudflare login in front. The server sees the connection coming from itself, so its firewall rule stays as it is.

Do this while your PC is still at home, because the first step needs the home network:

- **Give this PC its key:** run `server-connect.ps1` as above.
- **Add the login first:** in Cloudflare's Zero Trust dashboard, add a self-hosted Access application for
  `ssh.example.com`. Allow only your own email address, and turn on One-time PIN as a login method. Set the
  session as long as you'll be away. Do this before the next step, so SSH is never exposed without it.
- **Add the route:** on the tunnel, add a published application route from `ssh.example.com` to
  `ssh://localhost:22`.
- **Install `cloudflared` on this PC,** and point `chatserver` at the tunnel in `~\.ssh\config`, with the
  real path to `cloudflared.exe`:

  ```
  Host chatserver
      HostName ssh.example.com
      User yourname
      IdentityFile ~/.ssh/id_ed25519
      ProxyCommand "C:\path\to\cloudflared.exe" access ssh --hostname %h
  ```

- **Log in once:** `cloudflared access login https://ssh.example.com`. Do it before running any script,
  because the scripts use SSH without a terminal to log in from. When the session runs out, log in again.

To check it, connect your PC to a phone's hotspot and run `ssh chatserver "Write-Output ok"`.

**Releasing from away.** Big files crawl through the tunnel (around 70 KB/s) and the copy can break off, so
the release scripts have a `-ViaGitHub` switch: `scripts\app-release.ps1 -ViaGitHub`,
`scripts\release-upload.ps1 -ViaGitHub` and `scripts\app-update.ps1 -ViaGitHub`. The big files then go into
a temporary release of your GitHub repository, the server downloads them from there and checks each one's
SHA-256 before putting it in place, and the GitHub release is deleted again. Only small files and commands
go through the tunnel. It needs GitHub's `gh` command, logged in (`winget install GitHub.cli`, then
`gh auth login`), and a public repository, since the server downloads without logging in. For that minute
anyone could download the files, but they're the same ones `/download` hands out. At home, leave the switch
off: scp over the home network is quicker.
