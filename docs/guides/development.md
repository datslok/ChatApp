# Working on the code

## More for trying it on your PC

**GIF search** needs a GIPHY key (see [Optional: GIF search](hosting.md#optional-gif-search)). Copy
`dev-secrets.env.example` to `dev-secrets.env` and put the key in it: start.ps1 reads it, and git
ignores it, so the key is never committed. Without it the GIF button says GIF search isn't set up.

**Videos** are re-packed by ffmpeg when they're uploaded (the same picture and sound, with their length
and index at the start, so the phone app's player can show the length and skip), and ffprobe (which comes
with it) checks whether they have sound, so the player greys out the volume of a silent one. Without ffmpeg they're
kept as they are and the server says so when it starts. To install it: `winget install Gyan.FFmpeg`
(the server finds it without restarting PowerShell). Videos uploaded before are re-packed once, in the
background, after the server starts; so are the seasonal videos.

The first account in a new `dev.db` is the admin by itself. To make another one an admin:
`python tools\make_admin.py theirname --db dev.db` (with the `chatapp` environment active: `conda activate chatapp`).

**Voice and video** need LiveKit's server program: download `livekit_<version>_windows_amd64.zip`
from [LiveKit's releases](https://github.com/livekit/livekit/releases) (the version in
`scripts\server\install.ps1`, `$LiveKitVersion`), and put `livekit-server.exe` in a `livekit\` folder
here. Then, in a second PowerShell window: `.\voice.ps1 -Dev`.

- `server.py`: puts the server together: the FastAPI app, the routes of every part, the static folders,
  the limits the pages are told (`LIMITS`) and the WebSocket (`/ws`). Start it with `uvicorn server:app`
  (start.ps1 and serve.ps1 do).
- `chatapp/`: the rest of the server, one module per topic. Inside each, sections are marked with
  `# ---------- Name ----------` comments; elsewhere a reference like `channels.py, "Roles"` means that
  section. They're in layers: a module only imports from the ones before it in this list, never from
  server.py, so there are no circular imports.
  - The shared bottom: `config.py` (settings from the environment, shared limits), `db.py` (the database,
    its tables and migrations), `sessions.py` (who is logged in), `users.py` (small facts about people:
    bots, names, friendships, blocks), `access.py` (who may see which channel, group, DM or message) and
    `connections.py` (open WebSockets and sending to them).
  - The topics, each with its own routes (a FastAPI `APIRouter` that server.py adds with
    `app.include_router`): `pages.py` (the HTML pages, static files, seasons, downloads, the phone app's
    updates), `files.py` (uploads, thumbnails, videos, removing metadata, cropping pictures), `web.py`
    (link previews and GIFs), `presence.py` (statuses and the list of everyone), `push.py` (push
    notifications), `messages.py` (saving messages, replies, reactions, mentions, pins, search, chat info,
    unread), `emoji.py` (custom emoji), `people.py` (profiles, friends, blocking), `groups.py` (group DMs),
    `voice.py` (voice tokens, the Lounge, calls and ringing), `channels.py` (channels, private channels,
    roles), `accounts.py` (registering, logging in, invites, email, passwords, account settings) and
    `admin.py` (bans, admins, the bug reports inbox).
- `static/index.html`, `static/css/chat.css` and `static/js/`: the chat page. The scripts are plain
  scripts sharing one global scope, loaded in the order listed in `index.html`.
- `static/login.html`, `reset.html`, `download.html`: the other pages.
- `chattus.py`: the AI bot (optional), a separate program that talks to the server like a browser.
- `livekit.yaml`: LiveKit's settings. `desktop/`: the Windows app. `mobile/`: the native phone app
  (in progress). `tools/`: small helper programs.
- `tests/`: the test suite (see below).
- [ROADMAP.md](../../ROADMAP.md): what's done and what's planned.

The code is written to be read: comments explain the *why*, and there are no build steps. Develop
with `start.ps1` (it restarts when you save), and try things in two browser windows.

## Running the tests

```powershell
.\test.ps1                        # everything (about a minute and a half)
.\test.ps1 tests\test_people.py   # one file
.\test.ps1 -k block               # only the tests with "block" in their name
```

The tests start a server of their own on port 8011, with an empty database and uploads folder in a
temporary folder, so they never touch `chat.db` or `dev.db`, and they can run while `start.ps1` does.
They use it only from the outside, like the web page and the phone app: HTTP requests and WebSocket
messages, never the server's own functions. So they keep passing however the server's code is arranged,
which is what makes them useful before and after moving code around.

`tests/conftest.py` has the shared parts: the server, `server.person()` (a new account: invited by the
owner, registered, its email verified, from the link the server prints since there's no mail server),
and `person.connect()`, the WebSocket (`ws.join("general")`, `ws.say("hi")`, `ws.wait_for("message")`,
`ws.nothing(...)` for what must not arrive). Outside services stay out: no Firebase, GIPHY or Anthropic
keys reach the test server, and voice tokens are made without a LiveKit server. Run it after every change
to the server, and add a test with every new feature or fixed bug. `setup.ps1` installs pytest
(`requirements-dev.txt`).

A whole run (`.\test.ps1` with nothing after it) then also runs the docs check, `tools\docs_check.py`: broken
links, file names that no longer exist, docs over their size, scripts missing from
[Scripts at a glance](scripts.md). After it come the tests of the tools below.

## The git hooks

Once per clone, turn on the repo's git hooks:

```powershell
git config core.hooksPath tools/githooks
```

Then every commit is checked for personal details before it's made: home folders with a name in them
(`C:\Users\<name>`) and email addresses, since the repo is public. To refuse your own words too (your username,
your router's and server's local addresses), put them one per line in `~\.chatapp-private.txt`, which stays
outside the repo. A commit it refuses prints each find; take it out and commit again.

**CLAUDE.md** is the original author's instruction file for [Claude Code](https://claude.com/claude-code),
the AI assistant this project was built with: how they like to work (small steps, explained first)
and notes about their setup. Rules for one part of the app are in `.claude/rules/`, procedures in
`.claude/skills/`, and `.claude/settings.json` runs hooks that check some rules while Claude works
(`tools/hooks/claude_hooks.py`). If you use Claude Code with your copy and want a different workflow, write your
own `CLAUDE.md` and change or remove those.
