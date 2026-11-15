# The phone app

How the native Android app in `mobile/` (milestone 22) is built: setup, layout, how it talks to the server,
and what each part does and why. The server side of the shared features is in the other notes files.

## Overview

- The phone app was chosen because the PWA felt janky. It's React Native with Expo (development builds, so
  native modules like LiveKit's work), in JavaScript (not TypeScript), in `mobile/`.
- Android first (my girlfriend's phone). iPhones maybe later, via Expo's cloud builds.
- It talks to the same server as the web page: `/login` and its cookie, the same WebSocket messages and
  endpoints.
- Native push goes through Firebase Cloud Messaging instead of Web Push (see
  [Push notifications](#push-notifications-fcm) below, and [notifications.md](notifications.md)).
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
| `src/ChatScreen.js` | The messages (see [Messages](#messages)). |
| `src/PeopleScreen.js` | The People page (see [People and groups](#people-and-groups)). |
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

## Messages

### ChatScreen

`src/ChatScreen.js` follows messages.js's rules:

- `buildRows` groups messages within 5 min, adds date lines and the NEW line.
- 40px pictures, role colours, "Today at", the reply line, chips.
- An inverted FlatList with `onEndReached` for older messages.
- The long-press `MessageMenu` stands in for the hover bar: reactions, Reply, Pin, Edit, Delete.
- Editing happens in the bottom box (phone reason: the keyboard).
- `#autocomplete`-style @ suggestions; ":"/"@" suggestions and the status line ("is typing…", "Sending GIF…").
- Blocked messages are behind Show.

### Formatting (since 2026-10-15)

- `src/format.js`: messages.js's formatting rules, INLINE_PATTERN and all, into a tree; `isOnlyEmoji` for jumbo
  emoji.
- `src/MessageText.js` draws it: code, quotes, spoilers, links (open in the browser), mentions, custom emoji,
  attachments, link preview cards.
  - Custom emoji use React Native's Image, which sends the cookie. expo-image was tried first and didn't, so the
    server 404'd.
  - A paragraph with $inline maths$ becomes a wrapping row of words, as Android can't size a view inside a Text.
  - `FittedImage` uses `resizeMethod="resize"`: Android decoded network pictures at full size, ~48 MB a photo,
    pushing each other out of Fresco's memory cache (lag, reloading while scrolling). `naturalSizes` remembers
    sizes so rows that FlatList rebuilds don't jump open.
- `src/MathView.js`: KaTeX from the server's /katex-0.18.9/ in a react-native-webview per formula, which reports
  its size. containerStyle needs the size too, or the webview's flex: 1 box collapses.

### Emoji and GIFs

- `src/Picker.js`: the phone bottom sheet with Emoji | GIF tabs, recently used (`recent-emoji.json`), custom
  emoji by owner. GIFs via /gifs/search and /gifs/send.
- `plugins/animated-webp.js` (a config plugin in app.json) turns on `expo.webp.animated` for GIPHY's WebP.
- emoji.json also has "versions" (make_emoji_json.py; Unicode 18.0 on 2026-10-15). The app hides emoji newer than
  its Android draws (`newestEmojiVersion`; API 36 = Emoji 16.0). A cracking face 🫫 showed as a box.

### Messages parity (2026-10-16)

- A long press on a reaction chip shows an Alert with the names.
- MessageText `onMention`: a tapped mention opens the profile.
- The menu shows the time (headerTime) and has Copy text (expo-clipboard, readableText).
- The character counter on the status line (COUNT_FROM 200, `charNote`).
- The NEW line live: connection.js `myId`/`newWhileAway`. ChatScreen's `onViewableItemsChanged` scrolls it to the
  top once per history, with viewPosition 1 as the list is inverted.
- An emptied edit = delete (asked). A file's caption may be emptied.
- `toBottom()` on send.
- @everyone everywhere, plus status details.
- `replyContent`: quotes with emoji, mentions, a paperclip.
- Empty files are refused.
- MessageCard `onUserMenu` (pins, search).

## Pictures and files

Since 2026-10-15. See [files.md](files.md) for the server side.

### Uploads and downloads go through expo/fetch

`src/files.js` uploads (POST /upload with an expo-file-system `File` as the body) and downloads (a stream written
piece by piece into `Paths.cache/downloads/<id>/`, with progress) through **expo/fetch**. That's because
expo-file-system's own upload/download use an OkHttp client without React Native's cookie jar, so the server
would say "not logged in".

- `openFile`: expo-intent-launcher, ACTION_VIEW on the `contentUri`, flag 1 = read permission.
- `shareFile`: expo-sharing.
- `uploadPicture(path, picture, extra)`: profile pictures, banners and emoji, through expo/fetch.
- `pictureUri`: thumbnail addresses (× PixelRatio).

### Attaching

- The + by the text box opens `AttachMenu`:
  - expo-image-picker's photo picker and camera. They give no real names, so a picture is named from the EXIF
    DateTimeOriginal like Samsung's camera (`20261014_182205.jpg`), else `photo-<time>.jpg`. Real names would
    need photo access (see ROADMAP's Maybe).
  - expo-document-picker for any file, as it asks Android for the real name. `File.pickFileAsync` gave
    "document:1000006562".
- The `Tray` above the box is the web's #tray: limits.files_per_message files, limits.upload_size each, all in one
  message with the caption, failed ones in red. "Uploading x…" shows on the status line.

### Viewing and saving

- A tapped picture opens `src/ImageViewer.js`: a Modal with its own GestureHandlerRootView. Pinch, drag and double
  tap via react-native-gesture-handler + reanimated; zoom only there. The viewer's download button saves too, with
  a toast; Share is only there.
- A tapped file asks "Download this file?" like the desktop app, shows a bar, saves it in Download straight away
  (like a browser; the user's wish) and asks Close / Open (Open opens the Download copy by its content:// Uri).

### The downloads module

Saving is our own native module `mobile/modules/downloads` (Kotlin, made with `create-expo-module --local`,
autolinked from `modules/`).

- `saveAsync` inserts into MediaStore.Downloads with IS_PENDING, copies the bytes, and returns {name, uri, type}.
- The name is the one MediaStore gave it: it adds " (1)", " (2)" from the clean name. After 32 it throws and we
  add the time.
- The type is the one for the name's ending (`typeFor`, MimeTypeMap), else the given one. With the server's
  application/octet-stream, MediaStore counted ".pdf" as part of the name and made "x.pdf (1)" (fixed 2026-11-02).
- No permission needed (Android 10+; older ones get an error).
- expo-media-library was tried first and dropped: it only knows Pictures/DCIM.

### Cleaning up copies

- `saveFile` deletes the app's own copy after saving, and App.js empties `Paths.cache/downloads` (and `shared`) at
  every start (`clearOldCopies`), so nothing stays twice.
- The pickers copy what's picked into the cache too and never delete it (the user's phone had ~1 GB,
  2026-11-15). So files.js `COPY_FOLDERS` adds ImagePicker, DocumentPicker, ImageManipulator and Audio
  (expo-audio's recordings) to clearOldCopies, and ChatScreen's sendTray calls `forgetCopies` on the sent items
  (only files under Paths.cache).

### Videos

- `src/VideoScreen.js` has our own bar under the video: time bar, play, time, mute, volume. Android's controls
  were a big overlay with no volume. Chat videos use it too, as does the season video (`src/SeasonScreen.js`).

## Sharing to the app

Since 2026-10-15.

- `plugins/share-intent.js` adds SEND / SEND_MULTIPLE `*/*` intent filters to MainActivity.
- Our module `mobile/modules/shared-files` (Kotlin) reads the Intent:
  - `getInitialShareAsync` when the app was started by a share, and an "onShare" event from `OnNewIntent` when
    it's already open (singleTask).
  - Each is `{files: [{uri, name, size, type}], text}`, with names from OpenableColumns.
  - Marked handled (and LAUNCHED_FROM_HISTORY ignored) so it isn't shared twice.
  - `copyAsync` copies one into `cache/shared/<uuid>/<name>`.
- App.js keeps the share through login.
  - A share while the app runs (`fromStart` false) goes straight into the open chat (the user's wish).
  - One that started it (or on the People page) shows `src/ShareScreen.js`: "Share to…", the sidebar's chats with
    a search box; back or × cancels.
- ChatScreen gets it as `shared`: text appended to the box, files that fit copied and passed to `addToTray`.
  Until it's sent (or another chat opens), back takes it out again and `BackHandler.exitApp()`s to the sending app.
- Development builds can't test a share that starts the app: expo-dev-launcher swallows it (its launcher screen,
  then a MainActivity Intent without action or extras). A release build has no launcher.

## The chat's buttons, pins and search

Since 2026-10-15. See [messages.md](messages.md) for pins, search and "around" on the server.

- `src/ChatHeader.js`:
  - `ChatTitle`: the name, a group's members; `onInfo` opens the chat info.
  - `ChatButtons`: the web's #dm-header buttons: bell (`mutedChats` from "mutes"; muted chats faded, no unread
    dot, no red dot on the menu), search, pin, and the green phone for calls.
  - **They're in the top bar itself, not a second bar under it (the user's wish).**
- App.js keeps `popup`; ChatScreen draws it.
- `src/MessageCard.js`: `Popup` (a Modal like the web's dialogs) and makeMessageCard's cards.
- `src/PinsScreen.js`: `openPins`/`closePins`; asked again on "pinned"/"deleted" while open.
- `src/SearchScreen.js`: searches 300 ms after typing; `search()` returns its `ask`. This chat / Everywhere are two
  buttons. From is the type-to-search picker; its list is a child of the popup since Android ignores taps outside
  a parent's edges.
- Jumping: ChatScreen's `jumpTo(chat, id)` (from pins, results, a reply's quote) opens the chat (App.js `go` as
  `onOpenChat`), asks connection.js `jumpAround` (the server's "around") unless it's loaded, then `scrollToIndex`
  (`onScrollToIndexFailed` scrolls to a guess and retries), and `Flash` fades it.
- The chat info panel: `src/ChatInfoScreen.js`, see [messages.md](messages.md).

## People and groups

Since 2026-10-15. See [people.md](people.md).

- `src/PeopleScreen.js`: renderPeopleList's tabs Friends/Everyone/Requests/Blocked, Everyone's search and
  Online/Offline, Received/Sent, makeFriendButtons. Phone reason: the four tabs share the width equally, as at
  the web page's size they wrapped. (At first there was no Invite someone or profiles yet: their own sub-step.)
- App.js's `dialog` state draws these over everything:
  - `src/ProfileScreen.js`: #profile: Banner, roles, Activity with activityDuration, bio, the friend buttons.
  - `src/UserMenu.js`: userMenuItems as a `src/Sheet.js` bottom sheet. At first no Call, Ban or Make admin; it has
    since got Call, Edit profile, Make/Remove admin and Ban…. Mention appends "@name " to `drafts` and bumps
    `focusTick`.
  - `src/MeScreen.js`: #me-popup above your panel: Status picker, `setPresence`, In voice; later Edit profile and
    Log out.
  - `src/GroupScreen.js`: GroupDialog (new group / Add people, with a search box over checkboxes); RenameDialog,
    as Android has no prompt(); GroupMenu, the ⋯ in a group's top bar: Add people, Rename, Leave.
  - `src/InviteScreen.js`: the People page's green Invite someone. Copy via **expo-clipboard**; New link copies at
    once.
- Taps and long presses:
  - A tap on a message's picture or name, a member or a People row opens the profile; a long press opens the user
    menu (a nested Pressable takes the touch before the message's).
  - A DM's long press in the sidebar opens the menu.
  - + by "Direct messages" makes a new group.
  - Your panel opens your popup; a long press on it is your user menu.
- `groupName` leaves bots out ("Just you"), like the web's groupLabel.
- Sidebar shows "N members" and the empty-DM note.

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
| `src/NotificationSettings.js` | Notifications (see [Push notifications](#push-notifications-fcm)). |
| `src/VoiceSettings.js` | Voice & audio and Video (see [Calls](#calls)). |

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

## Calls

Since 2026-10-15. See [voice.md](voice.md) for LiveKit, the web's calls and the server's ringing.

### Packages

- `livekit-client` + `@livekit/react-native` 3.0 + `@livekit/react-native-webrtc` 144 +
  `@livekit/react-native-expo-plugin` 1.0.3 (1.0.2 breaks on SDK 57; audioType communication).
- `registerGlobals()` is in `src/livekit-setup.js`, imported first by index.js (imports run before code).
- `@config-plugins/react-native-webrtc` was dropped: LiveKit's own manifest has the permissions, and it would add
  SYSTEM_ALERT_WINDOW.

### `src/voice.js`

`useVoice` lives in App.js's `Screen`, so a call outlives Main.

- **Join**: RECORD_AUDIO asked, `startCallService`, AudioSession communication with preferredOutputList
  bluetooth/headset/speaker, /voice-token, `Room` with micOptions and the Settings camera. Then leave.
- **Mute/deafen** like the web. **Volumes**: `participant.setVolume`, 0-2.
- **Speaking rings**: from LiveKit's native `createVolumeProcessor`, straight on
  `NativeModules.LivekitReactNativeModule` (LK_VOLUME_PROCESSED ~100/s per track, checked every 50 ms, -50 dB,
  0.3 s; -1 = our own mic). Our own ring = the gate open (see below).
- **Camera**: `CAMERA_CAPTURE` 4:3 960x720, the sensor's shape (16:9 cut the sides off). `CAMERA_PUBLISH` H.264
  1.7 Mbit/s, which the phone encodes in hardware (c2.qti.avc.encoder); VP8 was libvpx in software and went blurry
  now and then. `facingMode`; flipping uses `restartTrack`, passing the size too.
- **Screen share**: react-native-webrtc's MediaProjectionService; no sound. `ShareMenu` (CallParts, rendered in
  App.js) offers sizes from SHARE_HEIGHTS up to the screen's short side, made by the sender's
  `scaleResolutionDownBy` (react-native-webrtc always captures the whole screen at 30 fps); H.264 without
  simulcast.
- **Outputs**: `AudioSession.getAudioOutputs`/`selectAudioOutput`.
- **Ringing**: `callListener` in connection.js; `outgoing`, `incoming`, `notice`; sounds + `Vibration`, none on
  dnd. No own ringing in the background with push on, nor while the call's notification is showing (Android's loop
  keeps going when the app is paused); `acceptFromNotification`.
- **The screen stays on** for the whole call: **expo-keep-awake** in useVoice while `roomName` is set (the
  window's FLAG_KEEP_SCREEN_ON, only while the app is in front). The user's choice over only in FocusView,
  2026-10-21.
- `voice-settings.json` in Paths.document: noiseSuppression on/light/off like the web, micVolume, outputVolume,
  personVolumes, screenVolumes, camera user/environment, floatCorner.
- connection.js: `voiceMembers`, `dmCalls`, `sendVoice` (re-sent at every reconnect), `ring`/`answerCall`/
  `cancelCall`.

### Mic processing

The user's wish, like the web.

- `MicProcessor.kt` in the call-service module is LiveKit's `audioProcessingController.capturePostProcessor`
  (set in the module's OnCreate). WebRTC hands it 480 floats per 10 ms at 48 kHz, in the 16-bit range.
- It runs RNNoise ("on"; "light" is the `noiseSuppression` constraint, in micOptions), then the gain.
  `setAiNoiseSuppression`/`setMicVolume` are called from voice.js.
- Calls parity (2026-10-16, needs the APK after 1.0.1): after RNNoise and the mic volume comes the noise gate
  (`gateDb`; voice-gate.js's 0.3 s hold and 5 ms fade; setting `gate`, default -60). It publishes `level`/`open`,
  read by `getMicLevel()`: our own speaking ring = the gate open, and Settings' meter in a call.
- RNNoise 0.2 is C in `src/main/cpp/rnnoise-0.2/` (committed). `tools/get_rnnoise.py` fetches it: Xiph's release
  tarball pinned by SHA-256 after checking it against the signed v0.2 tag, plus five headers from commit 372f7b4,
  since 0.2's ARM code includes a missing os_support.h.
- `src/main/cpp/CMakeLists.txt` builds it into libchatappaudio.so (~1.4 MB per ABI, 16 KB pages) with the JNI
  bridge `denoiser.c` / `Denoiser.kt`.

### Sounds

From `tools/make_call_sounds.py` (rooms.js's tones).

- The ringtone at first went through **expo-audio** (plugin with enableBackgroundPlayback false: no media service
  of its own; `mobile/assets/sounds/ring.wav`). Since calls parity (2026-10-16) `CuePlayer.kt` plays "ring" in a
  SoundPool of its own with USAGE_NOTIFICATION_RINGTONE (res/raw/chatapp_ring.wav from make_call_sounds.py;
  `stopRing`).
- Calling/join/leave go through the call-service module's `CuePlayer.kt` (SoundPool,
  USAGE_VOICE_COMMUNICATION_SIGNALLING, res/raw), because media sounds waited 5-6 s while Android switched into or
  out of call mode. The in-call cues stay signalling.

### The call service (locked phone)

Our module `mobile/modules/call-service` (Kotlin). Its own AndroidManifest.xml is merged in:
FOREGROUND_SERVICE_MICROPHONE/CAMERA/MEDIA_PLAYBACK/MEDIA_PROJECTION, and the service with those types.

- `CallService`: startForeground with the types we have permission for, the "Ongoing calls" channel, Hang up ->
  "onHangUp", a partial wake lock; stops on onTaskRemoved.
- A **headless JS task** (`ChatAppCall`, registered in index.js of the module) runs for the call's length, because
  React Native pauses every JS timer in the background unless one runs (JavaTimerManager). That would stop
  LiveKit's pings and negotiation (livekit/client-sdk-react-native#437) and the chat socket's reconnecting.
- Notifications: the module's manifest has POST_NOTIFICATIONS, asked for at each join (Android 13+). Without it
  even the foreground service's notification is hidden.
- Its channel "ongoing_calls" is default importance with no sound and VISIBILITY_PUBLIC. The first, low-importance
  "calls" one, which Samsung hid from the lock screen, is deleted.

### Call screens

- `src/CallParts.js`: RoundButton, `makeTiles`, CallTile with `<VideoTrack>`, TileGrid = fitTiles, OutputButton's
  Sheet, CallControls, `ShareMenu`.
  - FocusView: a tap on a tile opens it over the screen. Only while it's open may the app rotate
    (**expo-screen-orientation**: `unlockAsync` = Android's UNSPECIFIED, which follows the phone's auto-rotate;
    closing locks PORTRAIT_UP again; sideways it fills the screen; the user's wish, 2026-10-21). Its ×, name band
    and volume slider fade out after `CONTROLS_FOR` 3 s; a tap toggles them, so × or back closes it.
- `src/LoungeScreen.js`: the `voice:lounge` view; App.js `pick` joins it like the web.
- `src/CallBanner.js`: 40% of the height above a DM's/group's chat; its grip (PanResponder, `bannerHeight`).
- `src/IncomingCall.js`.
- `mobile/src/CallFloat.js`: the floating call window (see [voice.md](voice.md)).
- Tiles and CallFloat: a long press opens the user menu.
- Elsewhere: the Sidebar's Voice list + VoiceBar + mute/deafen in your panel, the green phone in ChatButtons, Call
  in the user menu, Voice volume in profiles, In voice in MeScreen.
- Status `detail` says why the mic/camera/share didn't start (`callError` under tiles). The voice bar shows
  `notice` (No answer/Declined) outside calls.
- `src/callStats.js` (`measureCall`, the web's measuring) every 5 s in voice.js -> `stats`, `pingSamples`,
  `server`. `src/ConnectionScreen.js`: SignalButton in the voice bar, the popup with react-native-svg's graph.
- `src/VoiceSettings.js`: Voice & audio (Choices, Others' volume, the mic test via expo-audio's recorder metering,
  which LiveKit's measuring can't do outside a call; the meter adds the mic volume in dB) and Video (front/back +
  a preview with react-native-webrtc's RTCView).

### Developing calls

`voice.ps1 -Dev` listens on 127.0.0.1:7880 (`adb reverse tcp:7880 tcp:7880`) and UDP 7882 on the LAN address
(same Wi-Fi; this PC's firewall allows livekit-server.exe).

## Push notifications (FCM)

Since 2026-10-15. See [notifications.md](notifications.md) for the server's push and Web Push.

### Firebase

- Firebase project `chatapp-e2944` (my Google account, Spark plan, no Analytics or Gemini).
- `mobile/google-services.json` (app.json `googleServicesFile`; it has both the release and dev apps) and the
  service account key `firebase-key.json` in the repo folder (config.py's `FIREBASE_KEY_FILE`), both git-ignored.
  The key goes with export/import/backup.ps1.
- The real server has had the key since 2026-10-15 (`C:\ChatApp\firebase-key.json`, the default path; checked
  2026-11-15). A new server gets it with the rest of the data (export/import).

### The server side

- `/push/fcm` stores the token in push_subscriptions as `fcm:<token>` (an upsert that keeps the mute).
- `send_push` sends data messages through `send_fcm` (FCM HTTP v1; the access token from an RS256 JWT we sign with
  `cryptography`, cached an hour; 404 deletes).
- `always=True` (phones only, ignoring looking/mute) for `stop_ringing`'s `call_end` (answer_call, ring_timeout,
  end_call). `/calls/decline`. "welcome" has `phone_push`.
- "read" (since 2026-10-16; FCM priority NORMAL): `on_phones` (memory) holds (user, chat) for every message/friend
  push a phone got. `clear_on_phones` sends "read" once that chat is seen elsewhere (join while looking, "looking"
  true on it; "friends" = channel None or accept/decline), and PushService cancels it (the icon's number is the sum
  of the notifications showing). The app clears "friends" itself on the People page (App.js).

### The push module

Our module `mobile/modules/push` (Kotlin; firebase-messaging 25.1.3, whose getToken/onNewToken are deprecated
since 25.1 for installation IDs but still work).

- `PushService`: Firebase's MESSAGING_EVENT.
- `Notifications.kt`: channels "messages" (with the ping) and "incoming_calls" (with the looping ring,
  FLAG_INSISTENT). MessagingStyle stacked per chat (tag = chat key) with avatars fetched with CookieManager's
  cookie. CallStyle with a full-screen intent. The icon badge is `setNumber` (messages stacked per chat; Android has
  no badge API).
- **`IncomingCallActivity`: the only thing ever shown over the lock screen (the user's rule: never the app itself;
  MainActivity showWhenLocked was tried and refused).** A small centred see-through window (picture, "x is
  calling…", Accept/Decline like IncomingCall.js, its own task). Accept = requestDismissKeyguard (unlock), then the
  app with "accept".
- `DeclineReceiver` POSTs /calls/decline with the cookie.
- `PushModule.kt`: the token; taps (`getInitialOpenAsync`/"onOpen" like shared-files: {channel, messageId, action
  open/ring/accept}); clearChat/clearCall/isCallShowing; canFillScreen (USE_FULL_SCREEN_INTENT, Android 14+).

### The JS side

- `src/notifications.js`, `useNotifications` in App.js's Screen:
  - notification-settings.json; registers at every welcome; asks POST_NOTIFICATIONS the first time; mute ->
    /push/mute.
  - The ping (`assets/sounds/ping.wav`) on "unread"'s notify and new friend requests, but not in the background
    while push is on.
  - Clears a chat's notification when it's opened. `forgetThisPhone` at logout.
- `src/NotificationSettings.js`.
- App.js: `opened` -> go/jumpRequest/People's Requests tab. App.js asks `getInitialOpen` again at 0/0.3/1/2.5 s: at
  a cold start the Activity can still be missing (the answer was "none" and it opened #general; fixed 2026-10-16).
- `src/MessageBanner.js` (2026-10-16): the in-app banner, from notifications.js `banner` on "unread"'s notify and
  new requests, only while active and not quiet; setting `banner`. A tap -> App.js `goToNotice`; swipe up; 5 s.
- A tap that starts a closed app can't be tested in development builds (the dev launcher drops the extras, as
  with shares).
- `adb logcat -d` (read-only) showed what went wrong each time.

### Full screen notifications

Every new APK resets "Full screen notifications" (Android 14's USE_FULL_SCREEN_INTENT, for apps not from Play;
seen 2026-10-16; ordinary notifications survive). `src/FillScreenPrompt.js` (in Main) asks once per
runtimeVersion (`fill-screen-asked.txt`) when push is on and canFillScreen is false. Allow it ->
openFillScreenSettings.

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
