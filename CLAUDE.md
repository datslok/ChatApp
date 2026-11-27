# ChatApp: a small Discord-style app

A chat app for me, my girlfriend and our friends (about 5–20 people). It's a **fun learning project**:
the point is for me to understand how it works, not just to have it done.

## How to work with me

- **You write all the code, but teach as you go.** Before each step, explain the logic and concepts behind it
  (WebSockets, databases, auth, …) *before* writing anything; after, explain what each part does and why. No
  exercises for me. I know Python; I'm learning JavaScript/HTML/CSS, so explain frontend code in more detail.
- **Wait for my go-ahead** after explaining, and ask if I have questions. A go for a roadmap item covers all its
  steps: do the whole item, tick it in ROADMAP.md, then ask before starting the next one.
- **Two failed tries, then stop and ask me:** say what failed and why it might, and suggest research or another
  approach. Never a third blind attempt.
- **Always push after committing** (`git push`). My own uncommitted ROADMAP.md edits may always be committed too.
- **Keep it simple:** the standard library and a few well-known packages over frameworks. Readable beats clever.
  No features I didn't ask for. **Explain any new dependency** before adding it.
- **Work from the dev PC:** do server work over `ssh chatserver`; hand me a command only when it truly needs me.
- **Never play sound, open windows, take focus or close programs on this PC, or touch the phone, without asking
  first:** `drive-desktop` and `drive-phone` skills.
- **Security basics matter**, since friends use this for real: never insert user text with `innerHTML`, hash
  passwords with a proper library, never commit secrets.

## Docs

- **The README and docs/guides/ are the manual:** everything I might do by hand (scripts, releases, server commands,
  backups) is in a guide, for anyone hosting their own copy. **docs/notes/ is how it works inside:** read an area's
  notes before changing it, update them in the same commit.
- **Where each fact goes, how docs are written, budgets:** `.claude/rules/docs.md`. This file keeps only what every
  session needs, our own hosting, and how we work together.
- **Rules for one part of the app** are in `.claude/rules/` (server, web-page, phone-app, desktop-app, whats-new,
  chattus) and load when its files are touched. What a script can check, the hooks check (`docs/notes/claude-code.md`).
- **A rule, not a memory:** before saving a memory, ask whether it could be a rule instead (CLAUDE.md, a rule in
  `.claude/rules/`, a skill, or a hook if a script can check it). If so, write it there. Memory keeps only dated
  reminders and private facts that can't go in the public repo.
- **What's new:** every feature friends would notice gets a `static/changelog.json` line in the same commit
  (`.claude/rules/whats-new.md`; the commit hook reminds).

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
| [server.md](docs/notes/server.md) | server.py, the `chatapp/` modules and their layers, `LIMITS`, the tests, dev.env |
| [operations.md](docs/notes/operations.md) | the scripts, setting up and moving the server, backups, deploying, .env |
| [accounts.md](docs/notes/accounts.md) | emails, admins and the owner, invites, verification, bans, feedback, Settings → Admin |
| [people.md](docs/notes/people.md) | group DMs, statuses, mutual friends, blocking, activity |
| [channels-and-roles.md](docs/notes/channels-and-roles.md) | channels and headings, private channels, limited and hidden roles |
| [messages.md](docs/notes/messages.md) | files per message, the viewer, recent and pinned DMs, muting, pins, search |
| [files.md](docs/notes/files.md) | uploads, thumbnails, videos and our player, metadata, GIFs, link previews |
| [web-page.md](docs/notes/web-page.md) | the page's scripts, appearance, caching, drafts, What's new, seasons, icons, emoji, maths, member list, landing pages |
| [voice.md](docs/notes/voice.md) | LiveKit, calls and where they ring, mic processing, push to talk, the call window, screen shares |
| [notifications.md](docs/notes/notifications.md) | the PWA, Web Push, the phone banner |
| [phone-app.md](docs/notes/phone-app.md) | the native app: setup, code layout, connection, themes, settings, releases and live updates |
| [phone-messages.md](docs/notes/phone-messages.md) | the native app's messages, files, sharing, buttons, people and groups |
| [phone-calls.md](docs/notes/phone-calls.md) | the native app's calls, the locked-phone call service, FCM push |
| [desktop-app.md](docs/notes/desktop-app.md) | the Windows app: notifications, downloads, updates, LevelDB repair, icon |
| [chattus.md](docs/notes/chattus.md) | the AI bot: models, prompt, reactions, pictures, search, links, polls, reminders |
| [claude-code.md](docs/notes/claude-code.md) | Claude's own setup: rules, skills, hooks, the docs and personal checks |

References like `channels.py, "Roles"` name a module in `chatapp/` and its `# ---------- Roles ----------` section.

## Rules that apply everywhere

- **Going live:** a feature goes live everywhere at once, with `scripts\app-update.ps1` (it deploys too), plus a
  desktop release when its code changed; say so if the phone part needs a new APK. How: `go-live` skill.
- **Admins can't be muted or blocked; bots can't be blocked.**
- **The owner and bots see every channel, other admins don't.** A private channel with no role (or a deleted one) is
  the owner's only, never public. Hidden roles never reach non-admins.
- **The landing page's screenshot** is only ever of a throwaway server with test accounts, never the real chat.
- **No Windows app on phones:** phones are offered the Android app (Android first: my girlfriend's phone).
- **Keys never pass through you:** I run `scripts\set-server-secret.ps1`. `.env` is never committed. The desktop
  updates' signing key and the Android release key are never committed or regenerated.

## Hosting

The live site is https://chat.datslok.no, on the separate server PC (`ssh chatserver`), through a Cloudflare Tunnel;
from away, SSH goes through the tunnel too and every release script runs with `-ViaGitHub`. The whole setup (domains,
redirects, LiveKit's ports, SSH from outside): `.claude/rules/hosting.md`, loaded for the scripts and hosting docs.

## Running it

`.\setup.ps1` once (or after changing `requirements.txt`), then `.\start.ps1` (development, auto-reload, on
http://localhost:8001: open two tabs and chat between them), `.\voice.ps1 -Dev` for voice, `.\test.ps1` for the
tests. Port 8000 is the real site's (`serve.ps1`, which the tunnel forwards to). Python comes from conda; in Claude's
own shells, see CLAUDE.local.md. The milestones live in `ROADMAP.md`: tick them off as they're finished.
