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
- **The README is the manual.** Everything I might want to do by hand (scripts, releasing the app,
  server commands, restoring backups) must be described in README.md, not only here: when adding or
  changing a script or a manual step, update the README too (including "Scripts at a glance").
  The repo is public: the README is written for anyone hosting their own copy (example.com addresses,
  "your PC" and "the server"), so our own specifics (datslok.no, Cloudflare redirects, addresses) belong
  here in CLAUDE.md, not in the README.
- **Security basics still matter**, since friends will use this for real: never insert user text with
  `innerHTML`, hash passwords with a proper library, never commit secrets.

## Stack

| Part      | Choice                                      |
|-----------|---------------------------------------------|
| Backend   | Python, FastAPI, WebSockets                 |
| Frontend  | Plain HTML/CSS/JavaScript (no framework yet) |
| Database  | SQLite (once we need persistence)           |
| Voice     | WebRTC via LiveKit (later)                  |

## Layout

- `server.py`: FastAPI app. Serves the page and the `/ws` WebSocket endpoint that broadcasts messages.
- `static/index.html`: the chat page's markup. Its styles are in `static/css/chat.css`, its script in
  `static/js/`: plain scripts (not ES modules) sharing one global scope, loaded in this order:
  `core.js` (elements, connecting, server messages, channels, sidebar), `notifications.js` (and every
  generated sound), `ui.js` (drawers, back button, popups, text box, emoji autocomplete), `voice.js`
  (audio engine, mic, gate, volumes, who's in voice), `video.js` (camera, screen sharing), `rooms.js`
  (joining/leaving, DM calls, call banner, Lounge page), `voice-settings.js`, `settings.js`,
  `people.js` (DM/online lists, friends, profile popup, typing) and `messages.js` (uploads, messages,
  reactions, replies, editing; ends with `start()`). Code that runs at load time may only use what
  earlier files declare. `appearance.js` alone is loaded in `<head>`, before anything is drawn:
  Settings → Appearance (theme via `data-theme` on `<html>`, picked colours, `--font`, text size),
  kept with the account (`users.appearance`, `POST /settings/appearance`, checked against the lists in
  server.py, in "welcome" and sent to all the user's pages), with a copy in localStorage for the first paint.
  Every colour in chat.css is a variable in its `:root`, named by role. Both folders are served with `Cache-Control: no-cache` (FreshStaticFiles), as is
  `/`. The server hashes the page's files at startup (`PAGE_VERSION`, sent in "welcome"); a page that
  reconnects to a different one reloads itself (core.js, `reloadIfOutdated`; not in a call, with files
  in the tray, or while sending or editing; the text box is kept through sessionStorage).
- The phone app is a PWA: `static/manifest.json` (served at `/manifest.json`), `static/sw.js` (the service
  worker, at `/sw.js` so it covers the whole site; registered by notifications.js; deliberately no offline
  copies), icons in `static/icons/` (at `/icons/`, made by `tools/make_pwa_icons.py`). Linked from
  index.html and login.html. My girlfriend's phone is Android, so Android comes first.
  Push notifications (Web Push, `pywebpush`): VAPID keys in `.env` (`tools/make_vapid_keys.py`; made on the
  server itself so the private key never left it; development ones in `dev.env`), the `push_subscriptions`
  table (one row per device), `/push/subscribe` and `/push/unsubscribe` (only https endpoints at the known
  push services, against SSRF), the switch in Settings → Notifications (notifications.js; not in the
  Windows app). Sent by server.py's `send_push` (in a thread, in the background; 404/410 deletes the
  subscription) for new messages to `save_mentions`' people (DMs, mentions, @everyone) and for DM calls
  (ttl 30 s, urgency high), but never to someone "looking" at the chat on any device (each page sends
  `{"type": "looking"}` on focus/visibility changes), nor while they have the Windows app open at all (the
  page adds `app: inDesktopApp` to "looking"; `has_app_open`), nor to a muted device (`/push/mute`). sw.js shows them
  (one per channel, `tag`) and on a tap focuses an open chat (postMessage "open") or opens
  `/?channel=..&message=..` (core.js reads it). A device with push on doesn't notify by itself (`pushOn`).
  On phones, a banner (`#phone-banner`, notifications.js) offers Install (Chrome's `beforeinstallprompt`, kept and
  used by our button; iPhones get the steps in words), then Turn on (push), until closed.
- Next: a native phone app (milestone 22), chosen because the PWA felt janky: React Native with Expo
  (development builds, so native modules like LiveKit's work), in JavaScript (not TypeScript), in
  `mobile/`, Android first (my girlfriend's phone; iPhones maybe later via Expo's cloud builds). It talks
  to the same server: `/login` and its cookie, the same WebSocket messages and endpoints. Native push
  will go through Firebase Cloud Messaging instead of Web Push. The web app and PWA stay meanwhile.
  Setup done (2026-10-12): `mobile/` is the blank JS template (Expo SDK 57, React Native 0.86, React 19,
  Gradle 9.3) plus `expo-dev-client`; `app.json` name "ChatApp", slug "chatapp", Android package
  `no.datslok.chat` (permanent). Android Studio 2026.2 with its SDK in `%LOCALAPPDATA%\Android\Sdk`;
  user variables `ANDROID_HOME`, `JAVA_HOME` = Microsoft OpenJDK 17 (`C:\Program Files\Microsoft\jdk-17...`;
  Java 25 broke CMake's configure step: its "restricted method" warning counts as an error) and
  `platform-tools` on PATH. My phone (Samsung S24 Ultra, SM-S928B) over USB; Metro reaches it over
  Wi-Fi. Running it: README, "The native app (in progress)". The Bash tool doesn't see these user
  variables: use PowerShell and read them with `[Environment]::GetEnvironmentVariable(..., 'User')`.
  `adb shell screencap` shows me the phone's screen. Rules (from the template's AGENTS.md): check Expo's
  docs for SDK 57 specifically, always `npx expo install` for packages, never edit the generated
  `android/` (git-ignored; `npx expo prebuild --clean` after changing `app.json`).
- `static/login.html`: the login / create account page.
- `static/reset.html`: "forgot password" (asks for a reset link) and, with `?token=`, choosing a new password.
- Emails (reset links) go out through Resend's SMTP server, configured in `.env`. Without `SMTP_HOST`
  (as in development) they're printed in the server window instead.
- `static/changelog.json`: Settings → "What's new" (settings.js), written by hand: `features` (everything the
  chat can do, by topic, with how to use it) and `changes` (newest day first). More lines in `changes` than
  localStorage "changelogSeenCount" (saved when What's new opens; edited lines don't count) puts a red dot on ⚙️ and the tab; shown in two `<details>`
  sections, Changes (open) and features (closed). **In the same commit
  as every feature friends would notice: a line in `changes` (same day: add to that day's entry) and update
  `features`** (short, for friends, no technical details; say where things are, like "Settings → Notifications":
  Chattus reads `features` as the chat's manual, see below). Part of `PAGE_VERSION`, so a changelog-only
  deploy reloads open pages.
- `static/emoji.json`: every emoji for the reaction picker (and the server's list of allowed reactions),
  made from Unicode's `emoji-test.txt` by `tools/make_emoji_json.py`.
- Maths in messages (messages.js, `makeMath`): `$...$` inline and `$$...$$` on its own line, with Pandoc's
  rule so money stays text (no space inside the dollars, no digit after the closing one), `\$` a real dollar.
  Drawn by KaTeX: `static/katex-0.18.9/` (`katex.min.js`, `katex.min.css`, the woff2 fonts and LICENSE, from
  npm's tarball, checked against npm's integrity hash; served at `/katex-0.18.9/` with a week's caching,
  `LastingStaticFiles`). Its defaults stay (trust off: no `\href`; maxExpand), plus `maxSize: 20`.
- `tools/make_admin.py`: make someone an admin (or `--remove`, or `--list`); `--db dev.db` for development.
  Admins can edit and delete anyone's messages and custom emoji, and manage the channels.
- Channels (server.py, "Channels"): the `channels` table, one ordered list (`position`) of channels and
  headings (`heading` 1; a heading groups the channels below it until the next one). Messages and the rest
  store a channel's `key`, which never changes; renaming changes `name` only. The first three keep their old
  names as keys (general, memes, chattus, seeded when the table is empty); new ones get `c:` + 8 random hex
  (`h:` for headings). Admin-only: `POST /channels` (create, at the bottom), `/channels/{key}/rename`,
  `/channels/order` (the whole list of keys), `/channels/{key}/delete` (a channel with all its messages,
  files and previews; never the last channel). Every change sends `{"type": "channels"}` to every page
  (also sent at each connect); core.js `showChannels` redraws the sidebar, a page in a deleted channel goes
  to the first one. Settings → Channels (settings.js, admins only): each row a small form (Enter/Save
  renames), ↑ ↓, 🗑 with confirm(). `can_join` uses `is_channel`; push titles use `channel_name`.
  `delete_messages_in(key)` removes a channel's or group's messages with everything belonging to them.
- Group DMs (server.py, "Group DMs"; people.js, "Group DMs"): `group_dms` (key `g:` + 8 hex, name or NULL =
  the members' names) and `group_members`. Their messages are saved under the key, so `can_join`
  (`is_group_member`) is the only gate. 3–10 people (`MAX_GROUP_SIZE`): `POST /groups` (2+ of your friends),
  `/groups/{key}/add` (any member, their own friends), `/rename`, `/leave` (the last one out deletes it all);
  members needn't be friends with each other; others get a 404. Each member's pages get `{"type": "groups"}`
  (at connect and after changes, `announce_groups`). Every message counts as a mention for the other members
  except bots (Chattus only answers @mentions there; `where()` describes the group). Every bot is in every
  group: `create_group` adds them, `add_bots_to_groups()` at every start fills in older groups and new bots;
  bots never count as people (`group_people`: the size limit, the default name, the last person out deletes
  it) and aren't offered in the page's friend picker.
  Page: + next to "Direct messages" (#group-dialog with friend checkboxes), groups first in the DM list,
  #dm-header shows members and Add people / Rename (prompt()) / Leave (confirm()) / 📞 Call.
- Statuses (server.py, "Statuses"): `users.presence` is the chosen one (online, idle, dnd, invisible), set over
  the WebSocket (`{"type": "presence"}` -> "my_presence" to all their pages; also in "welcome"). "users" has
  each one's shown `presence` (online, idle, dnd, offline; invisible shows offline) and `online` (not offline).
  Online turns idle after `IDLE_AFTER` (10 min) with every page out of sight (`away_since`, from "looking";
  never for bots); `watch_presences` (every 30 s, started by the first connection) and connects, disconnects,
  "looking" true and status changes call `announce_presences`, which sends "users" only when a shown status
  changed. dnd: `isMuted()` on every page and no pushes (`send_push`). Page: the picker in #me-popup
  (people.js, `renderPresencePicker`), dots `.dot.online/.idle/.dnd/.invisible` (our own Invisible as a ring).
  The users' "status" field is still the line they write about themselves.
- Muting (server.py, "Muting"): `chat_mutes` (user_id, channel), set over the WebSocket (`{"type": "mute",
  "channel", "muted"}` -> "mutes" to all their pages; also at connect). `save_mentions` leaves out people who
  muted the chat unless they're named in it (`<@id>`) or the sender is an admin, so no red count, notification
  or push. **Admins can't be muted or blocked** (the user's rule): `can_mute` refuses a DM with an admin, and the
  page hides 🔔 there. Page: `mutedChats` (core.js) fades sidebar items (`.channel.muted`) without unread dots;
  🔔/🔕 in the top bar (rooms.js).
- Pinned messages: `messages.pinned_at` / `pinned_by` (NULL = not pinned); anyone who can see a message
  (`can_join`) may pin or unpin it over the WebSocket (`{"type": "pin", "message_id", "pinned"}`), never a
  note (`kind` set); `MAX_PINS` 100 per chat (else "pins_full"). Everyone in the chat gets "pinned"; a pin also
  saves a note (`kind` "pin", "📌 pinned a message.", `reply_to` the message: drawn like call notes).
  `{"type": "pins"}` answers with `pinned_messages(channel)`. `MESSAGES_QUERY` + `message_dicts` build both
  the history and that list (every message has "pinned"). Page: 📌 in each message's hover bar, and in the
  top bar (#dm-header, now on every chat; the call button only in DMs and groups), #pins-dialog with Jump and
  Unpin. `jumpToMessage` loads older batches by itself (`jumpLoading`, up to 40 x 50) to reach an old message.
- Search: `messages_fts`, an FTS5 index of `messages.text` (external content, `content_rowid='id'`, unicode61
  with remove_diacritics), filled once with 'rebuild' and kept in step by three triggers (insert, delete,
  update of text). WebSocket `{"type": "search", "query", "channel" (or null: everywhere), "from" (a user id
  or null), "ask"}` -> "search_results" (`ask` echoed; handled before core.js's channel filter).
  `search_messages` only looks in `visible_chats` (channels, DMs with current friends, own groups), takes
  only `\w+` words (max 10) as `"word"*` (no FTS5 syntax gets through), skips notes, newest 50 first, and
  adds each message's "channel". Page: 🔍 in the top bar, #search-dialog (searches 300 ms after typing
  stops); its results and the pinned list share `makeMessageCard`; Jump uses `openMessage`.
- Calls in DMs and groups (server.py, "Calls in DMs and group DMs"): the room is the DM's or group's key;
  `is_call_member` (never bots) gates /voice-token and "voice"; `calls[channel]["ringing"]` is the set still
  being rung (a DM: the other one). Group: everyone else rings, a decline only stops your own ringing
  (`call_answered` to you), the first accept starts it, the rest stop ringing after 30 s, it ends when the
  room empties. "dm_call" (who's in it) goes to `call_people`. Page (rooms.js `renderCallPanel`): a group's
  banner draws everyone in the call like the Lounge (`renderGroupCallTiles`), a DM's stays two tiles;
  📞 Call joins without ringing when a call is already going. FastAPI's TestClient loses messages between
  connections (one event loop per connection): test ringing against real uvicorn + websockets clients.
- Settings → "Bugs & ideas": `/feedback` saves a report in the `feedback` table and emails it to every
  admin with an email. Admins read them in Settings → "Inbox" (settings.js; `GET /feedback` and
  `POST /feedback/{id}/done`, both admin-only on the server), or with `tools/feedback.py`
  (`--all`, `--done ID`, `--undo ID`, `--db dev.db`).
- `uploads/`: uploaded files, saved under random names (git-ignored, like `chat.db`).
- Link previews (server.py, "Link previews"): after a message with a link goes out, a background task fetches
  the first link's page, reads its Open Graph tags and saves a card in `link_previews` (one per message) with a
  shrunk WebP copy of its picture in `uploads/previews/` (served at `/previews/<name>` to whoever can see the
  message); then a "preview" WebSocket message adds it. Against SSRF: http/https on ports 80/443 only, every
  address of the host must be public (`ipaddress.is_global`), we connect to the checked address ourselves (no
  DNS rebinding), redirects checked by hand (3 at most), 5 s timeouts, 1 MB HTML, 5 MB pictures, 10 previews per
  person per minute. Not for links in `code`, not on edits.
- `ROADMAP.md`: the milestones, ticked off as they're done.
- `setup.ps1`: creates the `chatapp` conda environment and installs `requirements.txt`.
- `start.ps1`: activates the environment and starts the server with auto-reload (development).
- `serve.ps1`: runs the real site for chat.datslok.no: no reload, localhost only, settings from `.env`.
  Uses `.venv` if there is one (the server PC), else the conda environment. `-LogFile` (used by the
  scheduled tasks) writes everything to a log instead of the window; `voice.ps1` has the same.
- Setting up and moving the server (README, "Host your own" and "Moving to another PC"): `scripts\server\export.ps1`
  (old PC: `chatapp-data.zip` with chat.db, uploads/, releases/, .env), `scripts\server\import.ps1` (new PC),
  `scripts\server\install.ps1` (new PC, as admin: Python + `.venv`, LiveKit, cloudflared service, firewall,
  power settings, scheduled tasks "ChatApp" and "ChatApp voice" at boot and every 5 minutes if not
  running, Task Scheduler's history on, logs in `logs\`), and
  `scripts\server\update.ps1` (git pull, packages, restart the chat; `-Voice` also LiveKit).
  `tools/copy_db.py` makes a safe copy of a live database (SQLite's backup function).
- Backups: on the server PC, `scripts/server/backup.ps1` (scheduled task "ChatApp backup", 04:00, from
  install.ps1 step 8) puts a dated `chat.db` + `.env` (last 30 days) and all of `uploads/` and `releases/`
  (robocopy, nothing deleted) in `E:\ChatApp-backups` on its second disk; log `logs/backup.log`. On the
  development PC, `scripts/backup-fetch.ps1` (task "ChatApp backup fetch", 05:00, from `-Install`) copies
  the newest one to `~\ChatApp-backups` over SSH. Restoring: README, "Backups".
- From the development PC (after `scripts\server-connect.ps1` once: an SSH key and the name `chatserver` in
  `~/.ssh/config`): `scripts\deploy.ps1` pushes if needed and runs `scripts\server\update.ps1` on the server over SSH;
  `scripts\release-upload.ps1` copies a new desktop app release into the server's `releases\`, deletes
  the older installers there and locally (only the one latest.json names stays), and then runs deploy.ps1 (the restart makes open apps reconnect and update);
  `scripts\usage.ps1` shows the space used there (runs `scripts\server\usage.ps1`: database, uploads by
  kind, releases, logs, leftover .db/.zip files, backups, free disk; only reads). The server
  PC's SSH server (step 7 of scripts\server\install.ps1) only accepts the home network.
- `.env.example`: template for `.env` (INVITE_CODE, SECURE_COOKIES). `.env` itself is never committed.
- `desktop/`: the Windows app (Tauri). A window around https://chat.datslok.no, with real Windows
  notifications (notification plugin, allowed for the site in `src-tauri/capabilities/default.json`)
  automatic updates at startup and when the page asks (updater plugin; `check_for_update` in main.rs, called by core.js after a reconnect and after leaving a call), the zoom of Settings → Appearance's scale (`set_zoom` in main.rs, called by appearance.js; since 0.1.15),
  starting with Windows (Settings → App behaviour, a tab only the app shows: `get_autostart` /
  `set_autostart` in main.rs with `tauri-plugin-autostart`, an entry in HKCU's ...\CurrentVersion\Run; since 0.1.16;
  on by default since 0.1.17: `turn_on_autostart_once` enables it at the first run, existing installs included, and
  leaves the marker `autostart-default-done` in %APPDATA%\no.datslok.chat so a later "off" sticks; not in dev builds), and links opening in the default browser (opener plugin,
  used only by main.rs's new-window handler, not by the page). Downloads: the page fetches a file itself
  with a progress bar (messages.js, only in the app) and main.rs's download handler then runs
  `explorer.exe /select,` on it (the opener plugin's reveal_item_in_dir silently did nothing).
  Notification clicks: the plugin's stand-in `Notification` has no click event, so the page puts
  `extra: {channel, messageId}` in it and main.rs's `on_action` ("tap") focuses the window and calls the
  page's `openMessage` (notifications.js) with them. Windows only reports clicks while the toast is on screen. `npm run tauri dev` in `desktop/` to try it.
  localStorage lives in WebView2's LevelDB (`%LOCALAPPDATA%\no.datslok.chat\EBWebView\Default\Local Storage`);
  a write cut off by a kill leaves its log damaged, and LevelDB then drops everything written after it at each
  start (its `leveldb\LOG`: "Corruption: checksum mismatch"), so nothing was remembered (2026-10-14, after the
  0.1.17 update). Since 0.1.18, `repair_local_storage` moves a damaged one aside ("Local Storage.broken")
  before the window opens, and `update()` downloads, destroys the chat window, waits 2 s, then installs.
  Updates install silently (installMode "quiet") while our own window, `desktop/ui/update.html`
  (bundled in the app), shows the progress. To test it: `npm run tauri dev -- --config pretend.json`
  with `{"version": "0.1.0"}` in pretend.json, so the live version counts as an update.
- `tools/make_installer_images.py`: makes the installer's pictures (`desktop/src-tauri/installer/`)
  and the update window's cat (`desktop/ui/cat.png`) from the icon, at twice NSIS's sizes so they stay sharp
  with Windows scaling (`installer/hooks.nsh` keeps their shape). Run it again after changing the icon.
- `icon/`: the app icon, made by Niamh Hannon (1024×1024). In use since desktop app 0.1.14:
  `chattuschattus_square.png`, her line drawing `chattuschattus.png` centred in a blue rounded square
  (`_centered` and `_round` are the versions not chosen). The earlier black cat was `fin2.png` / `fin2_round.png`.
  `npm run tauri icon ../icon/chattuschattus_square.png` in `desktop/` makes every size (delete the android/ios/Store/Mac ones and 64x64.png); `static/favicon.ico` is a copy of
  the resulting `icon.ico`, served at `/favicon.ico` for the browser tab and linked from every page as
  `/favicon.ico?v=2` (raise the number with each new icon: browsers and Cloudflare keep it a day).
  `scripts\refresh-icons.bat` (double-click; a .bat so it runs when downloaded too, CRLF kept by
  `.gitattributes`) clears Windows' icon cache when the taskbar or Start menu still shows an old icon.
- `static/download.html`: the download page (`/download`, no login), linked from the login page and
  Settings (hidden inside the app). `/download/windows` always redirects to the newest installer.
- `static/landing/`: the landing page (`index.html`, `logo.png` from `icon/chattuschattus_square.png`,
  `screenshot.png`), served at `/` when the Host is `LANDING_HOST` (datslok.no) and always at `/welcome`;
  `{{CHAT}}` in it becomes PUBLIC_URL (server.py, `landing_page`). Its pictures are under `/landing/`.
  The screenshot is of a throwaway server with test accounts (never the real chat). `/login?register`
  opens the login page in register mode.
  Logged in to the chat? The page asks `PUBLIC_URL/whoami` (name and picture only) with the cookie, and
  shows the name and "Log out" (`POST /logout`). Both answer with CORS headers for exactly
  `https://LANDING_HOST` (`allow_landing_page`); the cookie stays host-only, SameSite=Lax lets it through
  because datslok.no and chat.datslok.no are the same site.
- `releases/`: the app's installers and `latest.json`, served without login at `/releases/` (git-ignored).
  The app checks `latest.json` at startup and installs a newer version by itself.
- The updates' private signing key is `~\.tauri\chatapp.key` in the user folder (no password, never commit
  it; losing it means friends must reinstall by hand). The public key is in `tauri.conf.json`.
- `dev.env`: development settings for start.ps1: its own `dev.db` and `dev-uploads/`, so tests never
  touch the real chat's `chat.db` and `uploads/`.
- Voice runs on a self-hosted LiveKit server: `livekit/livekit-server.exe` (downloaded from
  github.com/livekit/livekit/releases, the windows_amd64 zip, checked against `checksums.txt`; git-ignored;
  the server PC gets it from scripts\server\install.ps1, whose `$LiveKitVersion` should match this PC's),
  settings in `livekit.yaml`, started by `voice.ps1`. Its key and secret are `LIVEKIT_API_KEY` and
  `LIVEKIT_API_SECRET` in `.env`. Ports: 7880 signalling (through the tunnel), 7881 TCP and 7882 UDP
  for the audio (forwarded on the router). The page uses LiveKit's browser library, `static/livekit-client-<version>.umd.js`
  (the UMD build from npm, checked against npm's integrity hash; served at `/livekit-client-<version>.umd.js`).
  The microphone goes through Web Audio (noise suppression, mic volume, then the noise gate
  `static/voice-gate.js`, an AudioWorklet) before LiveKit sends it. Noise suppression "On" (the default)
  is RNNoise: `static/rnnoise-0.4.1/` (worklet + `rnnoise_simd.wasm`, from npm's
  `@sapphi-red/web-noise-suppressor` 0.4.1, checked against npm's integrity hash; served at `/rnnoise-0.4.1/`);
  "Light" is the browser's own, "Off" neither. The AudioContext runs at 48 kHz for RNNoise; voice settings are kept in the browser (localStorage "voiceSettings").
- Screen shares (video.js): H.264, no simulcast, `maintain-framerate` at 60 fps. Chromium on Windows only uses the
  graphics card (Media Foundation, e.g. NVENC) for H.264 profile `42001f`; for LiveKit's default `42e01f` it uses
  OpenH264 on the CPU. So `livekit.yaml`'s `enabled_codecs` adds the `42001f` fmtp line, and must keep plain
  `video/h264` too (LiveKit checks the name alone first; without it, it falls back to VP8). Changing it needs
  `deploy.ps1 -Voice`, which ends ongoing calls. The connection popup (voice.js) shows each share's encoder,
  profile and "held back by", to check.
- The AI bot Chattus (milestone 23, in progress; English, friendly, short chat-sized answers). His model runs
  on the server's GTX 1070 (8 GB; i7-6700HQ, 16 GB RAM): llama.cpp's `llama-server` (`llama/`, git-ignored;
  version `$LlamaVersion` in install.ps1, the CUDA 12.4 build + cudart zip, checked against GitHub's digests)
  with Qwen 3.5 9B Q4_K_M + its mmproj (pictures) from `unsloth/Qwen3.5-9B-GGUF` in `llama/models/`. Started
  by `llama.ps1` (task "ChatApp AI", logs\ai.log; `install.ps1 -AI` sets it all up, `deploy.ps1 -AI`
  restarts it): all layers on the GPU, 8K context, 1 slot, 4 threads, thinking off, only 127.0.0.1:8080,
  key `LLAMA_API_KEY` in `.env` (made on the server). Measured: ~25 tokens/s, 7.1 GB VRAM, ~13% CPU, ~110 W.
  Ollama was tried first and dropped: 0.40's GPU discovery crashes (0xc0000005, ollama#16957, not Python's
  vcruntime on PATH), and 0.24 found the GPU but couldn't pull Qwen 3.5. Gemma 4 E4B was faster (38/s) but
  Qwen won on tools and tone. A system prompt asking for 1–3 short sentences keeps answers chat-sized.
  The bot is `chattus.py` (task "ChatApp bot" via `chattus.ps1`, logs\bot.log; `update.ps1` restarts it on
  every deploy): the account Chattus (`tools/make_bot.py`: no email, random password in `.env` as
  `CHATTUS_PASSWORD`, `icon/chattuschattus_square.png` as picture) logs in with `/login` and uses the normal
  WebSocket at 127.0.0.1:8000, no server changes but the channel with key `"chattus"` (`HOME`; names come from "channels" messages). A connection is in one
  channel at a time, so on an "unread" for #chattus, a DM or with "notify"/"mentions" (a mention) he
  "join"s it and uses its "history". Answers the newest message after his own last one (`answered` ids
  against double answers), never messages over 1 h old, one at a time (a queue), "typing" every 2 s,
  `reply_to` in shared channels (and in #chattus/DMs when someone wrote after it), auto-accepts friend
  requests (rarely needed now: server.py's `befriend_bots` makes everyone a bot's friend at every start and at
  /register; /friends/remove refuses for bots and the page shows no Remove for them), defuses @everyone/@here,
  max 400 tokens. DMs between friends: `users.is_bot` (set only by
  make_bot.py) lets a bot into a DM for an hour after a member names it there (`bot_invited`, `BOT_INVITE_TIME`;
  `save_mentions` saves a bot's DM mention by name, never via @everyone); calls use the strict
  `is_dm_member` (not `can_join`), so a bot never gets into DM calls. "users" has `"bot"`, so the page's @
  suggestions in a DM offer bots, the member list puts bots in a "Bots" section at the top (`#bots-list`,
  people.js `showUsers`), and `makeBotBadge` adds a "BOT" tag (`--bot-badge`, the theme's accent) after a bot's
  name in the lists, above its messages and in its profile. Chattus answers everything only in #chattus and his own DMs
  (`answers_everything`); in friends' DMs only mentions, as replies. Context: the last 20 messages (with Claude 200: `CLAUDE_CONTEXT_MESSAGES`, `join()` asks for "older" 50 at a time like scrolling up) as "name: text"
  (`<@id>` -> @name, `<:id>` -> :name:, files as "[sent a picture]"). Personality: `SYSTEM_PROMPT`.
  Development: `.\chattus.ps1 -Dev` with start.ps1 and `ssh -L 8080:127.0.0.1:8080 chatserver`; its
  `dev-chattus.env` (git-ignored) has a dev.db Chattus password and the server's LLAMA_API_KEY.
  Reactions: every answer is JSON `{"reaction", "reply"}` (`ANSWER_SCHEMA`, llama-server's
  `response_format` json_schema, enforced by grammar), either empty; the prompt asks for a reaction only
  when it adds something, reaction-only for thanks/goodbyes, at most one emoji per message.
  `reaction_code` checks it against `/emoji.json` (fetched at start; with/without U+FE0F) or a custom
  emoji's name (-> `custom:<id>`); anything else is dropped. Up to 50 custom emoji names are in the prompt.
  Pictures: the target message's picture and the newest one in the 5 messages before it (`attachments_to_show`),
  fetched from `/uploads/<id>` with his cookie, flattened on white, shrunk to 768 px JPEG, sent as a data URL
  in an `image_url` content part (~600 tokens, ~6 s). Custom emoji: a `LOOK_AT_EMOJI` job in the same queue
  describes each new picture once (256 px, 8 words) into `chattus-emoji.json` (git-ignored, keyed by file
  name); the prompt lists ":name: (note)". A message he reacted to counts as answered (after restarts too).
  Known quirks: he used to think any cat picture was him; since 2026-10-13 `SYSTEM_PROMPT` describes his own icon (black line-drawn cat face, pink tongue, blue rounded square), and Haiku tells it from other cats, blue ones too.
  Web search: the first model call uses `ANSWER_OR_SEARCH_SCHEMA` (a `search` field); if he fills it (or the
  message starts with "search:"; "wiki:" = Wikipedia only, no Exa), `search()` runs it and the results go in as a user note, then a second call
  with `ANSWER_SCHEMA` (no more searching). `exa_search` is a hand-written MCP client (JSON-RPC over HTTP
  POSTs: initialize, notifications/initialized, tools/call web_search_exa; SSE "data:" lines; needs a
  User-Agent) to `https://mcp.exa.ai/mcp`, keyless by default: its free limit is per IP and tight (often
  refuses a second search within seconds; "rate limit" text -> `SearchRefused`). Then `wikipedia_search`
  (en.wikipedia.org API, search + intro extracts). Optional `EXA_API_KEY` in .env (`?exaApiKey=`). Max 100
  searches a day (`searches_today`, kept across reconnects). Tavily was dropped for Exa (no account needed).
  The prompt tells him the chat draws LaTeX ($...$, $$...$$), so he writes formulas that way.
  Dice: a `roll` field in `ANSWER_OR_SEARCH_SCHEMA` (dice notation like "2d6", "1d20+3"), or a message starting
  with "roll:" (checked first in `ask_model`, no model call); `roll_dice` reads the notation anywhere in the text,
  rolls with `random` (1–20 dice, 2–1000 sides) and its text ("🎲 2d6: 4 + 2 = **6**") is the reply.
  Polls: a `poll` object (`POLL_SCHEMA`: question, options with maxItems 10) in the same schema, or "poll:"
  (`ONLY_POLL_SCHEMA`: the model only picks out question and options); `ask_model` returns (reaction, reply, poll);
  `poll_text` writes "📊 **question**" + 1️⃣..🔟 lines (fewer than 2 options: how to make one); `answer()` sends it,
  waits for the server's copy (`my_message`, a Future `handle()` completes) for its id and reacts with each number.
  No end and no server changes: the reactions' counts are the result (his own counts one, said in the poll).
  Context lines are "[09:43] name: text" (local time; with the date when not today; `when()`), and the prompt
  says he only sees those (up to 20) and should say when something is further back; `clean_answer` strips a
  copied "[time]"/"Chattus:". A search he chooses himself that names a chat member isn't sent (the web
  knows nothing about them; forced search:/wiki: always go): the 9B model ignored the prompt's rule.
  Possible later: letting him page back through a chat ("older", 50 at a time) for questions about it.
  Since 2026-10-13 he runs on **Claude Haiku 5.5** (`CHATTUS_MODEL=claude-haiku-5-5` and `ANTHROPIC_API_KEY` in
  the server's `.env`; the `anthropic` package), until a better model is found; without `CHATTUS_MODEL` he's back
  on llama-server. `ask()` is the one place that calls a model: for Claude, `for_claude` turns the OpenAI-shaped
  conversation into `system` + messages (image blocks from the data URLs; no leading or trailing assistant
  message) and `claude_schema` closes every object (`additionalProperties: false`) and drops `maxItems` etc.;
  `output_config` effort `low` + `format` json_schema, `CLAUDE_MAX_TOKENS` 2000 (its thinking counts), no
  temperature. My API key (platform.claude.com) expires 2026-11-12: replace it in `.env` before then. While on
  Claude, the task "ChatApp AI" (llama-server) is disabled on the server, freeing the GPU; to go back to Qwen:
  `Enable-ScheduledTask "ChatApp AI"; Start-ScheduledTask "ChatApp AI"`, empty `CHATTUS_MODEL`, restart the bot. The friends
  were told in What's new that what he reads goes to Anthropic. The prompt makes him catlike (puns, nyan, ^-^,
  :3) and says to search when unsure instead of saying he doesn't know. With Claude, `search()` uses
  `claude_search` instead of Exa: a separate small request with Claude's server-side `web_search_20250305` tool
  (Haiku's version; `_20260209` is Opus/Sonnet only; `max_uses` 3), asking for a summary with links, plus the
  result pages' titles and URLs (separate, so search citations can't clash with the answer's JSON shape); Wikipedia
  when it fails; "wiki:" stays Wikipedia. Exa is only for llama-server.
  Reading links, only with Claude: a `read` field (a link from the chat) in `CLAUDE_ANSWER_SCHEMA`; `claude_read` is a
  separate request with Claude's `web_fetch_20250910` (Haiku's version; `max_uses` 1, `max_content_tokens`
  `READ_PAGE_TOKENS` 10,000), asking for what matters for the question; the result goes in as a note and he answers
  with `ANSWER_SCHEMA` (one page per question). Anthropic fetches it, not the server (no SSRF here). Big sites that
  block AI fetchers (BBC Good Food, Allrecipes, NRK) answer "no permission": he says he couldn't read it.
  Reading files, only with Claude: `file_kind` (PDFs up to `MAX_PDF_SIZE` 5 MB, text files by suffix in `TEXT_FILES`,
  their first `MAX_TEXT_FILE` 50,000 characters); `attachments_to_show(..., file_kind, FILE_LOOKBACK 10,
  MAX_EARLIER_FILES 3)` picks the target's file and up to 3 in the 10 messages before. A PDF becomes our own
  `{"type": "pdf", "data": base64}` part, which `for_claude` turns into a `document` block; a text file goes into
  the message's text between "[sent the file x:]" and "[end of the file]". Too-big PDFs are named as such.
  Pictures with Claude: the target's and up to `CLAUDE_EARLIER_PICTURES` 3 in the `CLAUDE_PICTURE_LOOKBACK` 10
  messages before, shrunk to `CLAUDE_PICTURE_SIZE` 1568 px (Claude's best size; ~2,500 tokens each) instead of 1 at 768.
  Posting pictures, only with Claude: a `pictures` field (a search) in `CLAUDE_ANSWER_SCHEMA`; `commons_pictures`
  searches Wikimedia Commons (api.php, generator=search in File:, `filetype:bitmap`, imageinfo with a 1280 px
  `thumburl`, Artist/LicenseShortName/ObjectName) and downloads up to 8 JPEG/PNG, only from `COMMONS_FILE_HOSTS`
  (upload./thumb.wikimedia.org: no SSRF). `find_pictures` shows them to Claude at 384 px, numbered, and
  `PICK_SCHEMA` gets "pick" (numbers, checked by Python; at most 3) and the reply; private things ("my cousin's
  party") get none. Counts toward `MAX_SEARCHES_PER_DAY`. `answer()` sends the reply, then each picture
  (`upload`: POST /upload with his cookie) as its own message, "📷 title · author · licence · Wikimedia Commons"
  (no link in it: that would make a preview card). Commons has no memes; a paid image search could replace it.
  The chat's manual, with Claude: `load_manual` fetches `/changelog.json` at every start and puts its `features`
  ("## topic" / "- item") into `{manual}` (`MANUAL_PROMPT`: answer how-to and where-is questions from it, with the
  way there, and don't make up settings). ~2,000 tokens; the whole prompt ~2,800.
  Reminders, only with Claude (Qwen 9B got times wrong; tried and removed on 2026-10-13): `CLAUDE_TOOLS_PROMPT` (put into
  `{claude_tools}` only with Claude; single braces, as a format value) and `remind` in `CLAUDE_ANSWER_SCHEMA`
  ("remind:" -> `ONLY_REMIND_SCHEMA`): what, day (today/tomorrow/weekday/MM-DD), time (HH:MM), in (amount + unit),
  in that order because the model writes fields in order. `reminder_moment` / timedelta work out the moment (no
  model arithmetic). `save_reminder` checks it (future, a year, 20 each; up to 5 min past = next minute) and
  confirms the saved time; from a DM between friends to his own DM (no reply_to). `chattus-reminders.json`
  (git-ignored, loaded only with Claude); `watch_reminders` (30 s) queues `DELIVER_REMINDERS`, `deliver_reminders`
  joins and sends "@name ⏰ what" as a reply ("(sorry, a bit late)" after 10 min). `ask_model` returns a dict.

## Hosting

The live site is https://chat.datslok.no, served from the separate server PC (`ssh chatserver`; set
up with `scripts\server\install.ps1`) through a Cloudflare Tunnel (`cloudflared` runs there as a
Windows service and forwards to http://localhost:8000). The domain is
registered at domene.shop with its DNS on Cloudflare. `datslok.no` itself is the landing page: a third
route on the tunnel (`datslok.no` → http://localhost:8000) and `LANDING_HOST=datslok.no` in the server's
`.env`. Two Cloudflare Redirect Rules (302): "www to datslok.no" (`www.datslok.no` → https://datslok.no)
and "app to download" (`app.datslok.no` → https://chat.datslok.no/download); their DNS records are
proxied placeholders (A, 192.0.2.1), which must stay for the rules to work.

Voice: the tunnel also carries `voice.datslok.no` → http://localhost:7880 (LiveKit's signalling; a
"published application route" in Cloudflare's Zero Trust dashboard, Networks → Tunnels → chatapp).
The audio can't go through the tunnel (UDP), so the router forwards UDP 7882 (`livekit_udp`) and
TCP 7881 (`livekit_tcp`) to the server PC (which has a DHCP reservation there), and two Windows
Firewall rules ("LiveKit voice (UDP 7882)" / "(TCP 7881)") let them in, only to `livekit\livekit-server.exe`.
The router's and the server PC's local addresses aren't written here (the repo is public): look them
up on the server (`ipconfig`, "Default Gateway" is the router) when needed.

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

## Releasing a new version of the desktop app

Only when the app itself changes (icon, plugins, Rust code). The steps (build and sign, `releases/`,
`latest.json`, `scripts\release-upload.ps1`) are in README.md, "The desktop app", along with trying the
app, testing the update window and changing the icon.

## Roadmap

The milestones live in `ROADMAP.md`. Tick them off there as they're finished.
