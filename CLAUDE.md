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
- `static/index.html`: the chat page (markup, styles and script in one file for now).
- `static/login.html`: the login / create account page.
- `static/reset.html`: "forgot password" (asks for a reset link) and, with `?token=`, choosing a new password.
- Emails (reset links) go out through Resend's SMTP server, configured in `.env`. Without `SMTP_HOST`
  (as in development) they're printed in the server window instead.
- `static/emoji.json`: every emoji for the reaction picker (and the server's list of allowed reactions),
  made from Unicode's `emoji-test.txt` by `tools/make_emoji_json.py`.
- `tools/make_admin.py`: make someone an admin (or `--remove`, or `--list`); `--db dev.db` for development.
  Admins can edit and delete anyone's messages and custom emoji.
- `uploads/`: uploaded files, saved under random names (git-ignored, like `chat.db`).
- `ROADMAP.md`: the milestones, ticked off as they're done.
- `setup.ps1`: creates the `chatapp` conda environment and installs `requirements.txt`.
- `start.ps1`: activates the environment and starts the server with auto-reload (development).
- `serve.ps1`: runs the real site for chat.datslok.no: no reload, localhost only, settings from `.env`.
- `.env.example`: template for `.env` (INVITE_CODE, SECURE_COOKIES). `.env` itself is never committed.
- `desktop/`: the Windows app (Tauri). A window around https://chat.datslok.no, with real Windows
  notifications (notification plugin, allowed for the site in `src-tauri/capabilities/default.json`)
  and automatic updates at startup (updater plugin). `npm run tauri dev` in `desktop/` to try it.
- `icon/`: the app icon, made by Niamh Hannon (1024×1024). `fin2.png` is her drawing; `fin2_round.png`
  is the one in use (the oval made a circle, stray marks outside it removed; `fin_icon.png` is an older
  version). `npm run tauri icon ../icon/fin2_round.png` in `desktop/` makes every size (delete the android/ios/Store/Mac ones); `static/favicon.ico` is a copy of
  the resulting `icon.ico`, served at `/favicon.ico` for the browser tab.
- `static/download.html`: the download page (`/download`, no login), linked from the login page and
  Settings (hidden inside the app). `/download/windows` always redirects to the newest installer.
- `releases/`: the app's installers and `latest.json`, served without login at `/releases/` (git-ignored).
  The app checks `latest.json` at startup and installs a newer version by itself.
- The updates' private signing key is `C:\Users\axelk\.tauri\chatapp.key` (no password, never commit
  it; losing it means friends must reinstall by hand). The public key is in `tauri.conf.json`.
- `dev.env`: development settings for start.ps1: its own `dev.db` and `dev-uploads/`, so tests never
  touch the real chat's `chat.db` and `uploads/`.

## Hosting

The live site is https://chat.datslok.no, served from this PC through a Cloudflare Tunnel
(`cloudflared` runs as a Windows service and forwards to http://localhost:8000). The domain is
registered at domene.shop with its DNS on Cloudflare. `datslok.no` and `www.datslok.no` redirect (302) to
the chat through a Cloudflare Redirect Rule (their DNS records are proxied placeholders, 192.0.2.1).
`app.datslok.no` redirects (302) the same way, to https://chat.datslok.no/download.

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
```

For development, open http://localhost:8001 (start.ps1) in two browser tabs and chat between them.
Port 8000 is reserved for serve.ps1, because the tunnel forwards the public site there.

## Releasing a new version of the desktop app

Only needed when the app itself changes (icon, plugins, Rust code); chat changes reach it through the site.

1. Raise `"version"` in `desktop/src-tauri/tauri.conf.json` (e.g. 0.1.1 → 0.1.2).
2. Build and sign it, in `desktop/`:
   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = "C:\Users\axelk\.tauri\chatapp.key"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   npm run tauri build
   ```
3. Copy `ChatApp_<version>_x64-setup.exe` and its `.sig` from `desktop/src-tauri/target/release/bundle/nsis/`
   into `releases/`.
4. In `releases/latest.json`, set `version`, the installer's `url`, and `signature` (the .sig file's contents).

## Roadmap

The milestones live in `ROADMAP.md`. Tick them off there as they're finished.
