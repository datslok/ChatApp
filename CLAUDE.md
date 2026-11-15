# ChatApp: a small Discord-style app

A chat app for me, my girlfriend and our friends (about 5–20 people). It's a **fun learning project**:
the point is for me to understand how it works, not just to have it done.

## How to work with me

- **You write all the code, but teach as you go.** Work in small steps. Before each step, explain the
  logic and concepts behind it (WebSockets, databases, auth, …) *before* writing anything. After
  writing it, explain what each part does and why. Don't leave exercises for me.
- **Always push after committing.** Every commit goes straight to GitHub (`git push`).
- **Wait for my go-ahead.** After explaining a step, ask if I want clarification or have questions,
  then wait for me to say go before writing any code or making changes.
- **Keep it simple.** Prefer the standard library and a few well-known packages over frameworks and
  abstractions. Readable code beats clever code. Don't add features I didn't ask for.
- **Explain any new dependency** before adding it: what it does and why it's needed.
- I know Python. I'm learning JavaScript/HTML/CSS along the way, so explain frontend code in more detail.
- **The README and docs/guides/ are the manual.** Everything I might want to do by hand (scripts,
  releasing the apps, server commands, restoring backups) must be described in a guide, not only here:
  when adding or changing a script or a manual step, update its guide too (and
  `docs/guides/scripts.md`, "Scripts at a glance"). The README itself stays short: what it is, how to
  try it, and links to the guides. The repo is public: the guides are written for anyone hosting their
  own copy (example.com addresses, "your PC" and "the server"), so our own specifics (datslok.no,
  Cloudflare redirects, addresses) belong here in CLAUDE.md, not in the guides.
- **docs/notes/ is how it works inside.** Before changing an area, read its notes file (index below).
  In the same commit as a change, update that file: what the code does, why, and what was tried. This
  file only keeps what every session needs.
- **Security basics still matter**, since friends will use this for real: never insert user text with
  `innerHTML`, hash passwords with a proper library, never commit secrets.

## Stack

| Part      | Choice                                                         |
|-----------|----------------------------------------------------------------|
| Backend   | Python, FastAPI, WebSockets (`server.py` + `chatapp/`)         |
| Frontend  | Plain HTML/CSS/JavaScript (`static/`, no framework)            |
| Database  | SQLite (`chat.db`; `dev.db` in development)                    |
| Voice     | WebRTC via a self-hosted LiveKit server                        |
| Phone app | React Native with Expo (`mobile/`), Android                    |
| Windows   | Tauri (`desktop/`), a window around the site                   |
| AI bot    | `chattus.py`, on Claude Haiku (llama-server as the fallback)   |

## The developer notes (docs/notes/)

| File | Covers |
|------|--------|
| [server.md](docs/notes/server.md) | server.py and the `chatapp/` modules and their layers, `LIMITS`, the test suite, dev.env |
| [operations.md](docs/notes/operations.md) | the scripts, setting up and moving the server, backups, deploying, the .env files |
| [accounts.md](docs/notes/accounts.md) | emails, admins and the owner, invites, email verification, bans, feedback, Settings → Admin |
| [people.md](docs/notes/people.md) | group DMs, statuses (phones, away from the PC), mutual friends, blocking, activity |
| [channels-and-roles.md](docs/notes/channels-and-roles.md) | channels and headings, private channels, limited and hidden roles, roles |
| [messages.md](docs/notes/messages.md) | several files per message, the viewer, recent and pinned DMs, muting, pins, jumping, search |
| [files.md](docs/notes/files.md) | uploads, thumbnails, videos and our player, re-packing, removing metadata, GIFs, link previews |
| [web-page.md](docs/notes/web-page.md) | the page's scripts and load order, appearance, caching and reloads, trays and drafts, What's new, seasons, icons, emoji, maths, member list, chat info, user menu, download and landing pages |
| [voice.md](docs/notes/voice.md) | LiveKit, calls in DMs and groups, mic processing and noise suppression, push to talk, the floating call window, speaking rings, screen shares |
| [notifications.md](docs/notes/notifications.md) | the PWA, Web Push, the phone banner |
| [phone-app.md](docs/notes/phone-app.md) | the native app: setup, code layout, connection, messages, files, sharing, settings, calls, FCM push, releases and live updates |
| [desktop-app.md](docs/notes/desktop-app.md) | the Windows app: notifications, downloads, updates, LevelDB repair, loading window, icon |
| [chattus.md](docs/notes/chattus.md) | the AI bot: models, prompt, reactions, pictures, search, reading links and files, polls, dice, reminders |

References like `channels.py, "Roles"` name a module in `chatapp/` and its `# ---------- Roles ----------`
section.

## Rules that apply everywhere

Gathered from the notes; the notes have the details and the reasons.

**Code and checks**
- Server: a `chatapp/` module imports only from lower layers, never `server.py`; names are imported
  explicitly; no module reassigns another's global (background starters are functions in their module).
- Limits the pages need are written only in the server's `LIMITS` (sent in "welcome"). Never copy such a
  number into a page: add it to `LIMITS`. (Page-design numbers stay in the pages.)
- Run `test.ps1` after every server change; add tests with features and fixes. The tests are black-box
  only: never import `server.py` or `chatapp/`.
- Web page scripts: code that runs at load time may only use what earlier files declare. Every colour in
  chat.css is a variable in its `:root`, named by role. Buttons use line icons, not emoji (emoji stay in OS
  notifications, server notes, What's new and anything people write).
- Phone app: check Expo's docs for SDK 57 specifically, always `npx expo install` for packages, never edit
  the generated `android/`. Styles are `const makeStyles = (colors, size) => StyleSheet.create({...})`,
  never a module-level colour. Changes in `mobile/modules`, `mobile/plugins`, `app.json` or `package*.json`
  need a new APK (`app-update.ps1` refuses them), so leave those alone unless the APK is changing.
- Windows API or unsafe Rust in the desktop app: test it in a small debug program first.
- The Bash tool doesn't see user environment variables (ANDROID_HOME, JAVA_HOME): use PowerShell and
  `[Environment]::GetEnvironmentVariable(..., 'User')`.

**Going live**
- A feature that goes live goes live everywhere, in the same go: deploying the server (web page and Windows
  app pages) always comes with the phone app's live update (`scripts\app-update.ps1`, which also deploys), and
  changed desktop app code with a desktop release. If the phone part needs a new APK (native changes,
  app-update.ps1 refuses), say so rather than leaving it out silently. From away: `-ViaGitHub`.

**What's new**
- In the same commit as every feature friends would notice: a line in `static/changelog.json`'s `changes`
  (same day: add to that day's entry) and an updated `features` (short, for friends, no technical details;
  say where things are, like "Settings → Notifications": Chattus reads `features` as the chat's manual).

**The user's design rules**
- The phone app copies the web chat's design, in particular its phone layout (chat.css
  `@media (max-width: 700px)`), and only differs where a phone needs it.
- Nothing of the app is ever shown over the lock screen; only the minimal incoming-call screen
  (`IncomingCallActivity`: caller, Accept/Decline) may be.
- Choosing from what could be everyone (or many): a type-to-search picker, never a drop-down.
- A picture loads at the size it's shown; only the viewer loads the original.
- No Windows app on phones: phones are offered the Android app (Android first: my girlfriend's phone).

**Privacy and rights**
- Admins can't be muted or blocked; bots can't be blocked.
- The owner and bots see every channel, other admins don't. A private channel with no role (or a deleted
  one) is the owner's only, never public. Hidden roles never reach non-admins.
- The device a message was sent from (`sent_from`) goes to bots only.
- Activity never reports window titles other than games, Spotify and programs the user added.
- The landing page's screenshot is only ever of a throwaway server with test accounts, never the real chat.
- Keys never pass through me: the user runs `scripts\set-server-secret.ps1`. `.env` is never committed.
  The desktop updates' signing key (`~\.tauri\chatapp.key`) and the Android release key are never
  committed or regenerated.

## Hosting

The live site is https://chat.datslok.no, served from the separate server PC (`ssh chatserver`; set
up with `scripts\server\install.ps1`) through a Cloudflare Tunnel (`cloudflared` runs there as a
Windows service and forwards to http://localhost:8000; 2026.10.3 since 2026-10-26, for Cloudflare's emailed
eMudhra certificate fix: winget still offered 2026.10.0, so GitHub's MSI, checksum-checked; docs/guides/running.md,
"Updating cloudflared"). The domain is registered at domene.shop with its DNS on Cloudflare. `datslok.no`
itself is the landing page: a third route on the tunnel (`datslok.no` → http://localhost:8000) and
`LANDING_HOST=datslok.no` in the server's `.env`. Two Cloudflare Redirect Rules (302): "www to datslok.no"
(`www.datslok.no` → https://datslok.no) and "app to download" (`app.datslok.no` →
https://chat.datslok.no/download); their DNS records are proxied placeholders (A, 192.0.2.1), which must
stay for the rules to work.

Voice: the tunnel also carries `voice.datslok.no` → http://localhost:7880 (LiveKit's signalling; a
"published application route" in Cloudflare's Zero Trust dashboard, Networks → Tunnels → chatapp).
The audio can't go through the tunnel (UDP), so the router forwards UDP 7882 (`livekit_udp`) and
TCP 7881 (`livekit_tcp`) to the server PC (which has a DHCP reservation there), and two Windows
Firewall rules ("LiveKit voice (UDP 7882)" / "(TCP 7881)") let them in, only to `livekit\livekit-server.exe`.
The router's and the server PC's local addresses aren't written here (the repo is public): look them
up on the server (`ipconfig`, "Default Gateway" is the router) when needed.

SSH from outside the home network (set up 2026-11-08 for the laptop, for the UK trip): the server's firewall
allows port 22 only from `LocalSubnet` and the router doesn't forward it, so SSH goes through the tunnel:
route `ssh.datslok.no` → `ssh://localhost:22` (a loopback hop, so the firewall rule is unchanged), behind a
Cloudflare Access self-hosted application `ssh` (the user's email only, One-time PIN, 1-month session; the
"Cloudflare" login method failed with "Failed to fetch user/group information"). The laptop's `Host chatserver` uses
`ProxyCommand "C:\Users\axelk\bin\cloudflared.exe" access ssh --hostname %h` (copied from the server, 2026.10.3,
hash and signature checked, while GitHub was down). When the session expires:
`cloudflared access login https://ssh.datslok.no`, interactively. The dev PC keeps its LAN-only entry.
From away, every release script runs with `-ViaGitHub` (since 2026-11-15; scp through the tunnel crawled and broke
off): `scripts/send-to-server.ps1` `Send-ToServer` puts the big files in a temporary pre-release `upload-<time>`,
the server curls them into .tmp, checks SHA-256, then moves them in place; the release is deleted in `finally`.

## Running it

Python comes from Anaconda; conda is already hooked into PowerShell. First time (or after changing
`requirements.txt`):

```powershell
.\setup.ps1
```

Then start the server with:

```powershell
.\start.ps1     # development, with auto-reload
.\serve.ps1     # the real site (needs .env)
.\voice.ps1     # LiveKit, for voice (add -Dev for development: localhost only, test keys)
```

For development, open http://localhost:8001 (start.ps1) in two browser tabs and chat between them.
Port 8000 is reserved for serve.ps1, because the tunnel forwards the public site there.
`.\scripts\deploy.ps1` puts what's pushed on the server (see [operations.md](docs/notes/operations.md)).

## Releasing a new version of the desktop app

Only when the app itself changes (icon, plugins, Rust code). The steps (build and sign, `releases/`,
`latest.json`, `scripts\release-upload.ps1`) are in [docs/guides/desktop-app.md](docs/guides/desktop-app.md),
along with trying the app, testing the update window and changing the icon.

## Roadmap

The milestones live in `ROADMAP.md`. Tick them off there as they're finished.
