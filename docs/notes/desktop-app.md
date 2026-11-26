# The Windows app

How the Windows app in `desktop/` works (Tauri): what it adds around the web page, its updates, the loading
window, the installer's pictures, the app icon, and where releases and the signing key live. The steps for
releasing a new version are in README.md, "The desktop app". The app's call features (push to talk, a shared
window's sound, the share bar) are in [voice.md](voice.md); its activity detection is in [people.md](people.md).

## What the app is

A window around https://chat.datslok.no. On top of the web page it adds:

- **Real Windows notifications**: the notification plugin, allowed for the site in
  `src-tauri/capabilities/default.json`.
- **Automatic updates** at startup and when the page asks: the updater plugin; `check_for_update` in main.rs,
  called by core.js after a reconnect and after leaving a call (see "Updates" below).
- **Zoom**: Settings → Appearance's scale, via `set_zoom` in main.rs, called by appearance.js (since 0.1.15).
- **Starting with Windows** (see below).
- **Links open in the default browser**: the opener plugin, used only by main.rs's new-window handler, not by
  the page.
- **Fullscreen in a window of its own** (see below), so the chat window keeps its place.

To try it: `npm run tauri dev` in `desktop/`.

## Starting with Windows

- Settings → App behaviour, a tab only the app shows.
- `get_autostart` / `set_autostart` in main.rs with `tauri-plugin-autostart`: an entry in HKCU's
  ...\CurrentVersion\Run. Since 0.1.16.
- On by default since 0.1.17: `turn_on_autostart_once` enables it at the first run (existing installs
  included) and leaves the marker `autostart-default-done` in %APPDATA%\no.datslok.chat, so a later "off"
  sticks. Not in dev builds.

## Downloads

The page fetches a file itself, with a progress bar (messages.js, only in the app). main.rs's download handler
then runs `explorer.exe /select,` on it. (The opener plugin's reveal_item_in_dir silently did nothing.)

## Fullscreen in a window of its own

Since 0.1.29 (fullscreen.rs, the page's side is ui.js `goFullscreen`, used by video-player.js and rooms.js).

- **The problem:** when a page goes fullscreen, Tauri (tauri-runtime-wry's ContainsFullScreenElementChanged
  handler) makes its window fullscreen, and tao saves and restores it with `GetWindowPlacement` /
  `SetWindowPlacement`. For a snapped window that's the size and place from *before* the snap, and Windows no
  longer counts it as snapped. Putting the rect back afterwards was rejected: the window would look right but
  not be snapped any more (no snap group, dragging it out keeps the snapped size).
- **What it does:** before `requestFullscreen`, the page invokes `fullscreen_window {on: true}`. The app makes a
  hidden, borderless, taskbar-less window `fullscreen` exactly over the chat's page, moves the page into it
  (`Webview::reparent`) and shows it. Tauri then makes that window fullscreen; the chat window is never
  touched. When it stops being fullscreen (its `Resized` with `is_fullscreen()` false, after having been true),
  the page moves back and the window is destroyed. The same page, so videos and calls go on.
- **Needs** tauri's `unstable` feature (reparent, plain `WindowBuilder`, `add_child`).
- **The chat window is made with `WindowBuilder` + `add_child`** (a page with `auto_resize`), not
  `WebviewWindowBuilder`. Tried first with the latter: Tauri gives a webview window's fullscreen handler its own
  copy of the window id, which reparent doesn't update, so the *chat* window went fullscreen and the page sat
  in the small window (with an old-style frame; `set_decorations(false)` is now called again after building).
  A child webview's handler shares the dispatcher's id. Its labels are both "main", so it still counts as a
  webview window (`get_webview_window("main")`), but only while the page is in it: code that must work during a
  fullscreen uses `get_webview("main")` for the page (eval, navigate) and `get_window("main")` for the window
  (show, focus, the unread dot). Commands take `Webview` or `AppHandle`, never `WebviewWindow`, and the
  capability names the page (`"webviews": ["main"]`) as well as the window.
- Moving the page waits for Tauri's main thread, so it never runs there: the command is `async`, and the window
  events start a thread.
- Alt+F4 on the fullscreen window leaves fullscreen instead of closing it (closing would close the page). The
  chat window's taskbar button while it's empty brings the fullscreen window to the front.
- An older app doesn't know the command: the invoke fails and fullscreen works the old way.
- Trying it with a dev build next to the installed app: `npm run tauri dev -- --config dev-local.json` with a
  config that sets another `identifier` (own storage and single-instance lock), the window `url`
  `http://localhost:8001`, and an inline capability in `app.security.capabilities` allowing that address.

## Notification clicks

- The plugin's stand-in `Notification` has no click event.
- So the page puts `extra: {channel, messageId}` in it, and main.rs's `on_action` ("tap") focuses the window
  and calls the page's `openMessage` (notifications.js) with them. See [notifications.md](notifications.md).
- Windows only reports clicks while the toast is on screen.

## localStorage and the LevelDB repair

- localStorage lives in WebView2's LevelDB (`%LOCALAPPDATA%\no.datslok.chat\EBWebView\Default\Local Storage`).
- A write cut off by a kill leaves its log damaged. LevelDB then drops everything written after it at each
  start (its `leveldb\LOG` says "Corruption: checksum mismatch"), so nothing was remembered. This happened on
  2026-10-14, after the 0.1.17 update.
- Since 0.1.18, `repair_local_storage` moves a damaged one aside ("Local Storage.broken") before the window
  opens.
- Also since 0.1.18, `update()` downloads, destroys the chat window, waits 2 s, then installs.

## Updates

- Updates install silently (installMode "quiet") while our own window, `desktop/ui/update.html` (bundled in
  the app), shows the progress.
- To test it: `npm run tauri dev -- --config pretend.json` with `{"version": "0.1.0"}` in pretend.json, so the
  live version counts as an update.
- `releases/` holds the app's installers and `latest.json`, served without login at `/releases/`
  (git-ignored). The app checks `latest.json` at startup and installs a newer version by itself.

### The signing key

- The updates' private signing key is `~\.tauri\chatapp.key` in the user folder. It has no password.
- Never commit it. Losing it means friends must reinstall by hand.
- The public key is in `tauri.conf.json`.

## The loading window

Since 0.1.21:

- The chat window starts hidden (window-state restores everything but VISIBLE) behind a small undecorated
  `desktop/ui/loading.html`: the cat, "Starting ChatApp…", a sliding bar.
- main.rs `show_chat` shows the chat window and closes the loading window when the page invokes `page_ready`
  (core.js `tellAppReady`: after the first "history", or "users" on the People page/Lounge).
- After 10 s at the latest, and never over an update window.

## The installer's pictures

`tools/make_installer_images.py` makes the installer's pictures (`desktop/src-tauri/installer/`) and the
update window's cat (`desktop/ui/cat.png`) from the icon:

- At twice NSIS's sizes, so they stay sharp with Windows scaling (`installer/hooks.nsh` keeps their shape).
- Run it again after changing the icon.

## The app icon

`icon/` holds the app icon, made by Niamh Hannon (1024×1024).

| File | What it is |
|------|------------|
| `chattuschattus_square.png` | In use since desktop app 0.1.14: her line drawing centred in a blue rounded square |
| `chattuschattus.png` | Her line drawing |
| `_centered`, `_round` versions | Versions not chosen |
| `fin2.png` / `fin2_round.png` | The earlier black cat |

Changing the icon:

- `npm run tauri icon ../icon/chattuschattus_square.png` in `desktop/` makes every size. Delete the
  android/ios/Store/Mac ones and 64x64.png.
- `static/favicon.ico` is a copy of the resulting `icon.ico`, served at `/favicon.ico` for the browser tab and
  linked from every page as `/favicon.ico?v=2`. Raise the number with each new icon: browsers and Cloudflare
  keep it a day.
- Then run `tools/make_installer_images.py` again (above).
- `scripts\refresh-icons.bat` clears Windows' icon cache when the taskbar or Start menu still shows an old
  icon. Double-click it; it's a .bat so it runs when downloaded too, and `.gitattributes` keeps its CRLF.
