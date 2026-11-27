# The server

Covers: `server.py`, `chatapp/__init__.py`, `chatapp/config.py`, `chatapp/db.py`, `chatapp/connections.py`, `chatapp/sessions.py`, `chatapp/users.py`, `tests/`, `pytest.ini`, `requirements.txt`, `requirements-dev.txt`, `setup.ps1`, `start.ps1`, `test.ps1`, `dev.env`, `dev-secrets.env.example`

How the Python server is put together: `server.py` and the modules in `chatapp/`, the limits the pages
need, the test suite, and the development settings in `dev.env`.

## server.py

`server.py` puts the server together. It is started with `uvicorn server:app`. It holds only:

- the FastAPI app and its error handler;
- one `app.include_router` line per topic;
- the static mounts (Mounts stay on `app`);
- `LIMITS` (see [Limits](#limits-only-in-the-server) below);
- the `/ws` WebSocket handler.

Everything else is in `chatapp/` (milestone 24, split 2026-11-15).

## The chatapp/ modules

There is one module per topic, arranged in layers. A module imports only from lower layers, never from
server.py, and it imports names explicitly.

The bottom layers have no routes:

| Module | What's in it |
|--------|--------------|
| `config.py` | environment settings, shared limits, HEX_COLOUR |
| `db.py` | `db`, the tables, every migration, `iso_time` |
| `sessions.py` | `current_user`, `logged_in_user`/`_admin`, `is_admin` |
| `users.py` | is_bot, username_of, is_owner, friendships, blocks; befriend_bots/add_bots_to_groups at start |
| `access.py` | read-only: channel visibility, group/DM membership, `can_join`, `visible_chats` |
| `connections.py` | `clients`, `send`/`send_to_*`, nonces, `background_tasks`, "Stuck connections" |

Then come the topics, each with `router = APIRouter()` (lowest first):

| Module | What's in it | Notes |
|--------|--------------|-------|
| `pages.py` | pages, Seasons, static file classes, PAGE_VERSION, downloads, /app-update | [web-page.md](web-page.md), [phone-app.md](phone-app.md) |
| `files.py` | uploads, thumbnails, re-packing, removing metadata, is_video, file_info/files_note, cropping pictures | [files.md](files.md) |
| `web.py` | link previews, GIFs, fetch_url | [messages.md](messages.md) |
| `presence.py` | Statuses, Away from the PC, users_message/announce_users | [people.md](people.md) |
| `push.py` | Web Push, FCM, on_phones | [notifications.md](notifications.md) |
| `messages.py` | no routes: saving, MESSAGES_QUERY, history/around/newer, pins, chat info, search, mentions, muting, recent and pinned DMs, unread, delete_messages_in, announce_new_message | [messages.md](messages.md) |
| `emoji.py` | custom emoji | [messages.md](messages.md) |
| `people.py` | profiles, friends, blocking | [people.md](people.md) |
| `groups.py` | group DMs | [people.md](people.md) |
| `voice.py` | tokens, remove_from_voice, `calls`, ringing | [voice.md](voice.md) |
| `channels.py` | Channels, Who sees which channel, Roles | [channels-and-roles.md](channels-and-roles.md) |
| `accounts.py` | login, sessions, resets, verification, Invites, Settings, Appearance | [accounts.md](accounts.md) |
| `admin.py` | Bans and admins, Feedback | [accounts.md](accounts.md) |

### References to sections

References like `channels.py, "Roles"` in these notes name a module and its `# ---------- Roles ----------`
section.

### Background tasks and routers

- Background starters are functions in their own module (`start_repacking`, `start_watching_presences`), so no
  module reassigns another module's global.
- FastAPI 0.163 keeps an included router whole in app.routes (`_IncludedRouter`, `.original_router.routes`).

## Limits only in the server

Limits the pages need are written only in server.py, in `LIMITS`, and sent in "welcome" as `limits`. That
covers emoji per person, upload and GIF sizes, picture types, group size, and the lengths of names, statuses,
bios, ban reasons and feedback.

- Web: core.js `limits`. `applyLimits` sets the HTML boxes' maxlength from `LIMITED_INPUTS`; there is also
  `megabytes()`. See [web-page.md](web-page.md).
- Phone: `src/limits.js`, filled by connection.js. See [phone-app.md](phone-app.md).

**Never copy such a number into a page: add it to LIMITS.**

Exceptions and details:

- The message length is the older `max_text_length`.
- Page-design numbers stay in the pages.
- The tray holds `files_per_message` files.

## The test suite

Since 2026-10-18; how to run it is in the README, "Running the tests".

- The tests are in `tests/`, run by `test.ps1` (pytest, in `requirements-dev.txt`; settings in `pytest.ini`). A
  whole run then runs the docs check and the tools' tests ([claude-code.md](claude-code.md)).
- `conftest.py` starts a real uvicorn server on port 8011 with:
  - a temporary DATABASE_FILE/UPLOAD_DIR;
  - REQUIRE_INVITE=1;
  - no keys: SECRETS stripped, FIREBASE_KEY_FILE pointed nowhere, test LiveKit/VAPID values.
- The owner registers first.
- `server.person()` = invite + register + the /verify link, read from the server's printed emails (its log).
- Helpers: `Socket.wait_for/nothing/drain/join/say`.
- Fixtures: `channel` (made and deleted: max 50) and `friends`.
- `cf-connecting-ip` varies per person, for the per-IP limits.
- Files by area: accounts, admin, messages, channels, people, files, voice, misc (~170 tests, ~1.5 min).

**Black-box only: never import server.py or chatapp/.** That way the suite proves that a refactor (like the
split into modules) changed nothing.

Connections start with state messages ("unread", "mutes", "pinned_chats"...), so call `drain()` before
expecting an answer.

**Run it after every server change; add tests with features and fixes.**

## dev.env

`dev.env` holds the development settings for start.ps1. It has its own `dev.db` and `dev-uploads/`, so tests
never touch the real chat's `chat.db` and `uploads/`. It has no secrets and is committed (see
[operations.md](operations.md)).
