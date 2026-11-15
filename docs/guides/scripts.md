# Scripts at a glance

Run them in PowerShell, from the project folder. Each one also explains itself in comments at its top.
"Your PC" is where you work on the code; "the server" is the PC that runs the real chat (they can be
the same PC, but the scripts assume two).

| Script | Where | What it does |
|--------|-------|--------------|
| `setup.ps1` | your PC | makes a conda environment and installs the Python packages |
| `start.ps1` | your PC | the chat for trying and developing (http://localhost:8001, its own `dev.db`; keys from `dev-secrets.env` if there is one) |
| `voice.ps1 -Dev` | your PC | voice for development (only reachable from this PC) |
| `test.ps1` | your PC | runs the test suite against a throwaway server of its own (see [Running the tests](development.md#running-the-tests)) |
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
| `scripts\set-server-secret.ps1` | your PC | a new API key for Chattus (or, with a name after it, any value in the server's `.env`): asks for it without showing it, sends it over SSH, restarts the chat and the bot |
| `scripts\backup-fetch.ps1` | your PC | copies the server's newest backup here (`-Install`: every day) |
| `scripts\release-upload.ps1` | your PC | puts a new desktop app version on the server |
| `scripts\app-release.ps1` | your PC | a new version of the phone app (the APK, when its native side changed): builds, signs, uploads; phones offer it when they next connect |
| `scripts\app-update.ps1` | your PC | the phone app's JavaScript only: phones fetch it by themselves, no new APK |
| `-ViaGitHub` (on the three above) | your PC | away from home: the big files go through a temporary GitHub release instead of the slow tunnel (see [Releasing from away](hosting.md#reaching-the-server-from-outside-your-home-network)); `scripts\send-to-server.ps1` does it |
| `scripts\seasonal-upload.ps1` | your PC | puts a seasonal easter egg's video on the server (see [Optional: a seasonal easter egg](hosting.md#optional-a-seasonal-easter-egg)) |
| `scripts\refresh-icons.bat` | any Windows PC | double-click: Windows shows programs' new icons (after a new app icon) |
| `tools\make_admin.py` | either | make someone an admin, or take it away (the owner can also do it in Settings → Admin → Admins) |
| `tools\feedback.py` | either | read the bug reports and ideas, mark them done |
| `tools\make_pwa_icons.py` | your PC | makes the phone app's icons from the app icon (its notification icon too) |
| `tools\make_emoji_json.py` | your PC | makes `static\emoji.json` (every emoji, for the pickers and the server's list of allowed reactions) from Unicode's `emoji-test.txt`: `curl.exe -L -o emoji-test.txt https://unicode.org/Public/emoji/latest/emoji-test.txt`, then `python tools\make_emoji_json.py emoji-test.txt`; run it when a new emoji version comes out |
| `tools\make_icons.py` | your PC | makes `static\js\icon-shapes.js`, the buttons' line icons (Lucide's), and the same for the phone app (`mobile\src\icon-shapes.js`); add an icon's name in it and run it again |
| `tools\get_rnnoise.py` | your PC | puts RNNoise (the AI noise suppression, Xiph's C library) into the phone app's native code (`mobile\modules\call-service\android\src\main\cpp\rnnoise-0.2\`), checked against pinned hashes; only needed to change its version |
| `tools\make_call_sounds.py` | your PC | makes the phone app's sounds from the web page's tones: the ringtone and message ping (`mobile\assets\sounds\`), the notifications' ping and ring (`mobile\modules\push\...\res\raw\`) and the in-call calling, join and leave sounds (`mobile\modules\call-service\...\res\raw\`); run it again after changing one |
| `tools\make_screenshot.py` | your PC | the landing page's screenshot, on a throwaway chat with test accounts (never the real one); run it again when the chat's look changes |
| `tools\make_app_update.py` | your PC | used by `app-update.ps1`: turns `npx expo export` into an update for the server |
| `tools\prune_app_updates.py` | either | used by `app-update.ps1` (on both): deletes all but the newest 3 phone updates per version, and the files only they used (`--keep N` for another number) |
| `tools\make_vapid_keys.py` | either | once: the key pair for push notifications (the web page's), for `.env` |
| `npx expo run:android` (in `mobile\`) | your PC | builds the native phone app, installs it on a phone over USB and starts Metro |
| `npx expo start` (in `mobile\`) | your PC | only Metro, for an app already installed by `run:android` |
