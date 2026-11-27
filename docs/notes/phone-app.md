# The phone app

How the native Android app in `mobile/` (milestone 22) is built: setup, layout, how it talks to the server,
and what each part does and why. Messages, files and people: [phone-messages.md](phone-messages.md); calls and
push: [phone-calls.md](phone-calls.md). The server side of the shared features is in the other notes files.

Covers: `mobile/`, `tools/make_app_update.py`, `tools/prune_app_updates.py`

## Overview

- The phone app was chosen because the PWA felt janky. It's React Native with Expo (development builds, so
  native modules like LiveKit's work), in JavaScript (not TypeScript), in `mobile/`.
- Android first (my girlfriend's phone). iPhones maybe later, via Expo's cloud builds.
- It talks to the same server as the web page: `/login` and its cookie, the same WebSocket messages and
  endpoints.
- Native push goes through Firebase Cloud Messaging instead of Web Push (see
  [Push notifications](phone-calls.md#push-notifications-fcm), and [notifications.md](notifications.md)).
- The web app and PWA stay meanwhile.

## Setup and toolchain

Setup was done on 2026-10-12.

- `mobile/` is the blank JS template (Expo SDK 57, React Native 0.86, React 19, Gradle 9.3) plus
  `expo-dev-client`.
- `app.json`: name "ChatApp", slug "chatapp", Android package `no.datslok.chat` (permanent).
- Android Studio 2026.2, with its SDK in `%LOCALAPPDATA%\Android\Sdk`.
- User environment variables: `ANDROID_HOME`, `JAVA_HOME` = Microsoft OpenJDK 17
  (`C:\Program Files\Microsoft\jdk-17...`), and `platform-tools` on PATH. Java 25 broke CMake's configure
  step: its "restricted method" warning counts as an error.
- The Bash tool doesn't see these user variables: use PowerShell and read them with
  `[Environment]::GetEnvironmentVariable(..., 'User')`.
- The phone: a Samsung S24 Ultra (SM-S928B), over USB. Metro reaches it over Wi-Fi.
- Samsung phones need Samsung's ADB driver. Windows Update offers it, but Settings hid it on 2026-10-15, so it
  was installed through the Windows Update COM API, elevated.
- `adb shell screencap` shows me the phone's screen.
- How to run it: README, "The native app (in progress)".

### Rules from the template's AGENTS.md

- Check Expo's docs for SDK 57 specifically.
- Always `npx expo install` for packages.
- Never edit the generated `android/` (git-ignored). Run `npx expo prebuild --clean` after changing `app.json`.

## The design rule

**Design rule (the user's): the app copies the web chat's design, in particular its phone layout (chat.css
`@media (max-width: 700px)`), and only differs where a phone needs it.** Where it differs, the notes below
say "phone reason".

## Code layout

`App.js` is the web page's phone layout:

- `#topbar` on top: menu · label · users, with a red dot on the menu when anything else is unread.
- The chat (or People) under it.
- `view` is a chat key or "people". A history drives the back button (which closes a drawer first). The first
  channel opens at start.
- App.js leaves a DM whose person is no longer a friend (or a group we left) for the first channel, like the
  web page.

| File | What it does |
|------|--------------|
| `src/Drawer.js` | The side drawers: 80% / max 280px, slides 0.2 s "ease" with `Animated`, a backdrop. `position: absolute` is spelled out: `StyleSheet.absoluteFillObject` silently did nothing in RN 0.86. |
| `src/Sidebar.js` | The left drawer: People + request badge, channels with headings, DMs with pictures and dots, your panel. |
| `src/Members.js` | The right drawer: Bots, roles, Online, Offline dimmed, like renderMembers. |
| `src/config.js` | `config.js`'s `SERVER`: `__DEV__` ? the dev server at localhost:8001 (reached with `adb reverse tcp:8001 tcp:8001`) : https://chat.datslok.no. |
| `src/connection.js` | `useConnection`: the WebSocket and its state (see [The connection](#the-connection)). |
| `src/LoginScreen.js` | login.html's card (see [Logging in](#logging-in-and-verifying)). |
| `src/ChatScreen.js` | The messages (see [Messages](phone-messages.md#messages)). |
| `src/PeopleScreen.js` | The People page (see [People and groups](phone-messages.md#people-and-groups)). |
| `src/people.js` | Avatar with letter colours, StatusDot with the phone shape, BotBadge, Person, nameColor; `matchPeople`. |
| `src/Icon.js` | react-native-svg's SvgXml with the web page's Lucide shapes from `src/icon-shapes.js` (written by tools/make_icons.py too). |
| `src/chats.js` | Chat keys and labels; `sortedDmKeys`; `seesChannel`. |
| `src/theme.js` | The themes (see [Themes](#themes)). |
| `src/time.js` | dayName, clock, headerTime. |
| `src/api.js` | getJson/postJson. |
| `src/friends.js` | friendButtons/askToBlock/askToRemove, shared by People, profile and menu. |
| `src/limits.js` | The server's limits, filled by connection.js. |

## The connection

`src/connection.js`, `useConnection`:

- The WebSocket, reconnecting, and "looking" with `mobile: true`.
- State from welcome/my_presence/roles/channels/groups/friends/blocks/users/custom_emoji/unread/history/older/
  message/edited/deleted/reactions/pinned.
- `openChat`/`closeChat` send "join"; `loadOlder`, `lastRead`; `friendAction` POSTs /friends/....

### Bad connections

Since 2026-10-16. Android's WebSocket never pings or times out, so a dead connection looked open for minutes
and messages went into it. connection.js has two answers:

- **A heartbeat.** `{"type": "ping"}` every 15 s while on screen, at once after sending, and on coming back.
  Anything from the server counts as an answer. None in 6 s -> `connect()` again. Retries are at most 5 s apart.
- **The outbox.** `sendMessage` -> `{nonce, chat, ...}`, sent with `channel` and `nonce`, and sent again at
  every onopen. It's gone on a "message" with its nonce or on "sent". It has failed after 30 s or on "not_sent".
  ChatScreen's `PendingMessage` is faded, says "Sending…" after 1.5 s, and offers Retry / Delete.

The server side (server.py): "ping" -> "pong"; a message may name its `channel`; `recent_nonces` (10 min, in
memory) confirms a repeat without saving it twice; "sent"/"not_sent" go to the sending page; `nonce` is in
"message". The web page doesn't use them.

### Stuck connections

2026-10-19, mongri's report: phones reconnecting in a loop for up to a minute.

- The cause: a connection that stops reading fills its buffer, and uvicorn's send then waits. We send to
  everyone one after another, so it held up every sender, and new connections hung at `announce_presences`
  without answering pings.
- The fix, connections.py `send`: after `SEND_TIMEOUT` 5 s the client is marked `stuck` (skipped) and its chat()
  task cancelled (cleaned up like a close). tests/test_messages.py `never_reading` reproduces it.
- The app: `OPEN_WAIT` 10 s for a connection still opening (React Native waits for the upgrade's answer for
  ever), and onopen closes one that was already replaced.

## Logging in and verifying

- `src/LoginScreen.js` is login.html's card. Forgot/Create open the web pages in the browser. It does POST
  /login; Android keeps the cookie for the WebSocket and images. A 4001 close shows the login screen.
- `src/VerifyScreen.js` is verify.html (since 2026-10-16, "the rest of parity", needs the APK after 1.0.2).
  LoginScreen asks /verify/status at mount and after logging in, and polls every 5 s.
- Log out is in your popup: `connection.logout` (POST /logout, close, me null, the login screen).

## Themes

Since 2026-10-15, the user's choice: instant, not an app restart.

- `src/theme.js` has chat.css's eight themes by variable name (--bg-panel -> bgPanel).
- `makeTheme(appearance)` -> {colors, size(n), presence, light}:
  - colors: picked colours on top; accent15/30/35 and yellow8 derived; icon/iconStrong by guardIconColours' WCAG
    3:1 rule.
  - size(n): the text size, n * font_size/16.
- `ThemeContext` provides it. App.js holds the appearance (useMemo -> Provider). `Frame` draws the safe area and
  a dark/light StatusBar.
- `appearance.json` in Paths.document is the first-paint copy (read with textSync). connection.js's `appearance`
  comes from "welcome" and "appearance".
- **Every file's styles are `const makeStyles = (colors, size) => StyleSheet.create({...})` with
  `fontSize: size(16)`, read in each component with `useStyles(makeStyles)`** (cached per theme in a WeakMap).
  Colours in JSX come from `useTheme().colors`. Never a module-level colour.
- Fonts (2026-10-16): theme.js `FONT_FAMILIES`: georgia serif, consolas monospace, comic casual, calibri/system
  the phone's. `useStyles`' `withFont` adds fontFamily to every style with a fontSize and none of its own.
- Scale isn't in the app (it's the Windows app's zoom); fonts are, as near as Android has them.

## Settings

Since 2026-10-15.

| File | What it does |
|------|--------------|
| `src/SettingsScreen.js` | Full screen, the phone layout's tab row and ×; remembers the last tab. Fetches the inbox for "Admin (n)". |
| `src/AccountSettings.js` | Username, email with its pending link, password; /me. |
| `src/ProfileSettings.js` | Picture and banner via `src/PictureEditor.js`, then **expo-image-manipulator** to 256x256 / 960x320 WebP, `uploadPicture` in files.js through expo/fetch; DELETE /settings/avatar\|banner; status and bio. |
| `src/AppearanceSettings.js` | Swatches; **reanimated-color-picker** in a popup with its own GestureHandlerRootView, live preview at most every 80 ms, saved on Done, Cancel restores; text size with our `src/Slider.js` (a PanResponder slider). |
| `src/SettingsParts.js` | Title, Heading, Help, Field, Button, Status, Form. |
| `src/PictureEditor.js` | The web's #cropper (see below). Used by Profile and `src/EmojiSettings.js`. |
| `src/changelog.js` | `useChangelog`, fetched at every connect; the seen count in `changelog-seen.txt`; dots on ⚙️ and the tab. Shown by `src/ChangelogSettings.js`. |
| `src/FeedbackSettings.js` | Sends `phone: true`: the server marks it "ChatApp Android app", the inbox says Android app. |
| `src/AdminSettings.js` | Sub-tabs like the web; the inbox fetched again when the tab opens; `askToSetAdmin`; `ChannelAccess`. |
| `src/BanDialog.js` | `mayBan`; lengths as buttons. |
| `src/PersonPicker.js` | Type-to-search, suggestions in the flow under the box; `matchPeople` in people.js. |
| `src/NotificationSettings.js` | Notifications (see [Push notifications](phone-calls.md#push-notifications-fcm)). |
| `src/VoiceSettings.js` | Voice & audio and Video (see [Calls](phone-calls.md#calls)). |

- Settings opens from ⚙️ on your panel and from Edit profile in your popup (and in the user menu).
- Profile pictures first used expo-image-picker's own crop; `src/PictureEditor.js` replaced it:
  - `pickPicture()` uses quality 1 = the file as it is, so a GIF stays one.
  - Stills are loaded through expo-image-manipulator, which turns EXIF-rotated photos upright, and shown as a
    2048px copy so what you see is what's cut.
  - Pan + pinch (gesture-handler/reanimated) and our Slider.
  - Save cuts a still into WebP; a GIF goes whole with ?left&top&width&height, like the web.
- The season easter egg: `src/SeasonScreen.js`, `SeasonBadge` on your panel picture (a 4px-padded box so more of it
  takes taps), and the video in `src/VideoScreen.js`.
- dev.db's "phone" account is admin and owner (password in my memory).

## App Links

Since 2026-10-16. app.json `intentFilters`: https chat.datslok.no, path "/", autoVerify. App.js `linkTarget` via
Linking -> `opened`. The server's `/.well-known/assetlinks.json` comes from android.json's `package`/`fingerprint`,
which app-release.ps1 adds from apksigner.

## Distribution and updates

Since 2026-10-15.

### Icons

- The app icon is an adaptive icon made by `tools/make_pwa_icons.py`: the drawing on transparency, centred on its
  smallest enclosing circle and scaled to the 66/108 safe zone (the user's wish). app.json backgroundColor
  #0086D7, a monochrome layer.
- Notifications' small icon (since 2026-10-16, the user's choice: "a little thicker", centred, as big as fits):
  the same script makes `push_cat_icon.png` (modules/push) and `call_notification_icon.png` (call-service) in
  drawable-mdpi..xxxhdpi (24..96 px). It's the drawing's alpha without its faint specks (<= 32, which shifted it
  off centre), MaxFilter 19 at 1000 px wide, its box filling the 22/24 live area. `setColor` #0086D7.
- `push_call_icon.xml` (the phone) stays for IncomingCallActivity's buttons.

### Signing and the dev variant

- Release builds are signed by `plugins/release-signing.js` with `~/.chatapp-keys/android-release.jks` (password in
  `~/.gradle/gradle.properties`, CHATAPP_RELEASE_*; see my memory; the user keeps a copy).
- `plugins/dev-variant.js`: debug builds are `no.datslok.chat.dev` "ChatApp Dev" (the user's choice: both on the
  phone; google-services.json has both apps), so `adb shell am start` etc. need the .dev package.

### Live updates (expo-updates)

- **expo-updates** with runtimeVersion policy appVersion (fingerprint hashed generated folders), against
  pages.py's `/app-update`: Expo's protocol 1, the newest `releases/app-updates/<version>/*.json`, URLs filled
  from PUBLIC_URL, 204 when none. Files are in `releases/app-assets/<md5>.<ext>`, immutable.
- `src/liveUpdates.js` checks at every connect and on return to the app, and switches with Updates.reloadAsync
  when safe (no call, trays, share or popup). The view and drafts are kept through cache reload-state.json
  (`restored`). The user's wish, like the desktop's reload.
- Made by `scripts/app-update.ps1` + `tools/make_app_update.py`. The script refuses when mobile/modules, plugins,
  app.json or package*.json changed since android.json's commit (those need a new APK). It ends with deploy.ps1 so
  open apps reconnect, then runs `tools/prune_app_updates.py` here and on the server: the newest 3 manifests per
  version and the app-assets they name stay.
- **The reload loop (2026-11-23).** An update made a minute after APK 1.0.12, with no change in mobile/, was the
  APK's own bundle under another id. Phones downloaded nothing (every file was already theirs: no
  /app-update/assets requests), reloaded, still ran the APK's bundle (`Updates.updateId` not the update's), so the
  next check offered it again: a reload every few seconds, the call banner flashing (dmCalls emptied at each
  connect). Stopped by moving the server's `releases/app-updates/1.0.12` to `releases/app-updates-held-1.0.12`
  (/app-update -> 204). Not a version mix-up (1.0.11 -> 1.0.12 was right) nor the server split (app_update is
  unchanged). Two guards since:
  - app-update.ps1 makes no update when nothing in mobile/ changed since android.json's commit; it only deploys.
  - liveUpdates.js writes the id it switches to in `tried-update.txt` (Paths.document). At the next start, if
    `Updates.updateId` isn't that id, the update didn't take and is never switched to again; if it is, the file
    goes. It also skips an "available" update whose id is the one running. So a bad update costs one reload.
- **The same update again (2026-11-26).** The check above compares with the APK, so once anything in mobile/
  changed after it (liveUpdates.js, here), every app-update.ps1 made another update of the same JavaScript: three
  for 1.0.12, all with the id 7a17f5f2. Harmless (phones running that id skip it), but an export and ~6 MB uploaded
  each time. The id is the SHA-256 of Expo's metadata.json, which names the bundle by a fingerprint of the source,
  so the same source gives the same id, while the compiled .hbc came out different at every export (Hermes isn't
  byte for byte the same). Now make_app_update.py makes none when the newest manifest for that version has the
  same id ("No new update: ..."), and app-update.ps1 then only deploys.

### New APKs

- `scripts/app-release.ps1`: bumps version + versionCode, commits "Phone app x", prebuild + gradlew
  app:assembleRelease, checks that apksigner says CN=ChatApp, writes `releases/ChatApp-android-<v>.apk` +
  `releases/android.json` {version, versionCode, apk, commit}, scp, removes old APKs. The hyphens keep them out of
  release-upload.ps1's `ChatApp_*` clean-up.
- In the app: `src/appUpdate.js` + `src/UpdateScreen.js` (release builds only). When android.json is newer than
  Updates.runtimeVersion (checked at start, every connect and after calls), a "A new version" popup; the download
  goes into cache/apk with a bar, then ACTION_VIEW to Android's installer (REQUEST_INSTALL_PACKAGES in app.json).
  - `checkForApk` runs at every welcome and after a call; `setApkCheckPaused` in calls; Later = that version not
    again until restart.
- `/download/android` redirects to the newest APK (served as application/vnd.android.package-archive).
  download.html shows the Android section on Android (#android/#windows). Login and landing pages say "Get the
  Android app" on Android (`data-android`), nothing on iPhones.

## Development gotchas

- dev.db has the test accounts "phone", "phone2" and "tester" (phone's friends both).
- `prebuild --clean` failing with EBUSY on `android/`: the adb server started by run:android stands in it
  (`adb kill-server`).
- Expo's dev-menu gear can cover the top bar's buttons in development builds: drag it.
- Development builds can't test a share or a notification tap that starts the app: the dev launcher drops it.
