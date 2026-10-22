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
  `icon-shapes.js` and `icons.js` (the line icons, see "Icons"), `core.js` (elements, connecting, server messages, channels, sidebar), `notifications.js` (and every
  generated sound), `ui.js` (drawers, back button, popups, text box, emoji autocomplete), `voice.js`
  (audio engine, mic, gate, volumes, who's in voice), `video.js` (camera, screen sharing), `rooms.js`
  (joining/leaving, DM calls, call banner, Lounge page), `voice-settings.js`, `settings.js`,
  `people.js` (DM/online lists, friends, profile popup, typing), `video-player.js` (`makeVideoPlayer`: our own control
  bar for chat videos and the viewer's, see "Videos"), `viewer.js` (the picture viewer, see "Several files
  per message"), `chat-info.js` (the chat info panel) and `messages.js` (uploads, messages,
  reactions, replies, editing; ends with `start()`). Code that runs at load time may only use what
  earlier files declare. `appearance.js` alone is loaded in `<head>`, before anything is drawn:
  Settings → Appearance (theme via `data-theme` on `<html>`, picked colours, `--font`, text size),
  theme/colours/font kept with the account (`users.appearance`, `POST /settings/appearance`, checked against the lists in
  server.py, in "welcome" and sent to all the user's pages), with a copy in localStorage for the first paint.
  Text size and scale are per device (since 2026-10-18, the user's wish): only in that localStorage copy
  (`applyAccountAppearance` keeps them when the server's arrive; phone: appearance.json, App.js); the server
  ignores them but keeps the old saved ones in users.appearance for pages from before.
  While it loads, `#page-loading` (index.html's first element: the logo and a bar sliding by `transform`, which the compositor
  runs while scripts load; `left` froze) covers the page until core.js `tellAppReady` (or 10 s) fades it out.
  Every colour in chat.css is a variable in its `:root`, named by role. Both folders are served with `Cache-Control: no-cache` (FreshStaticFiles), as is
  `/`. The server hashes the page's files at startup (`PAGE_VERSION`, sent in "welcome"); a page that
  reconnects to a different one reloads itself (core.js, `reloadIfOutdated`; not in a call, with files
  in any tray, or while sending or editing; every chat's text is kept through sessionStorage "drafts").
  The last open chat (since 2026-10-16, each device its own, the user's choice): core.js `switchChannel` saves
  localStorage "lastChat", `lastChat()` reopens it at start (after a reload's history.state; `stillThere` checks
  both); the phone's App.js writes `last-chat.txt` in go() and opens it after a live update's `restored`, the Lounge
  as a page only. Gone ones (left groups, ex-friends, private channels) are left by the usual checks.
  Each chat keeps its own tray and half-written text, like Discord (the user's wish, 2026-10-15): messages.js
  `trays` / `drafts` by chat key, `tray` = the open chat's list, `switchDraft` (called by switchChannel) swaps
  them; `sendTray` stops if the chat changes mid-upload (messages go to the open chat). The phone app: App.js's
  `trays` / `drafts`, ChatScreen's `setTrayOf` / `setDraftOf`.
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
  used by our button; iPhones get the steps in words), then Turn on (push), until closed. On Android it skips Install:
  `#android-app-dialog` (notifications.js `offerAndroidApp`, after each "welcome") offers the native app instead (the
  user's wish), Download -> /download, Not now or Back = again in a week (localStorage "androidAppAskAgain").
- Next: a native phone app (milestone 22), chosen because the PWA felt janky: React Native with Expo
  (development builds, so native modules like LiveKit's work), in JavaScript (not TypeScript), in
  `mobile/`, Android first (my girlfriend's phone; iPhones maybe later via Expo's cloud builds). It talks
  to the same server: `/login` and its cookie, the same WebSocket messages and endpoints. Native push
  goes through Firebase Cloud Messaging instead of Web Push ("Push notifications" below). The web app and PWA stay meanwhile.
  Setup done (2026-10-12): `mobile/` is the blank JS template (Expo SDK 57, React Native 0.86, React 19,
  Gradle 9.3) plus `expo-dev-client`; `app.json` name "ChatApp", slug "chatapp", Android package
  `no.datslok.chat` (permanent). Android Studio 2026.2 with its SDK in `%LOCALAPPDATA%\Android\Sdk`;
  user variables `ANDROID_HOME`, `JAVA_HOME` = Microsoft OpenJDK 17 (`C:\Program Files\Microsoft\jdk-17...`;
  Java 25 broke CMake's configure step: its "restricted method" warning counts as an error) and
  `platform-tools` on PATH. My phone (Samsung S24 Ultra, SM-S928B) over USB; Metro reaches it over
  Wi-Fi. Running it: README, "The native app (in progress)". The Bash tool doesn't see these user
  variables: use PowerShell and read them with `[Environment]::GetEnvironmentVariable(..., 'User')`.
  `adb shell screencap` shows me the phone's screen. Samsung phones need Samsung's ADB driver (Windows
  Update offers it but Settings hid it on 2026-10-15: installed through the Windows Update COM API, elevated).
  **Design rule (the user's): the app copies the web chat's design, in particular its phone layout (chat.css
  `@media (max-width: 700px)`), and only differs where a phone needs it.** The code: `App.js` is the web
  page's phone layout: `#topbar` (menu · label · users; a red dot on menu when anything else is unread),
  the chat (or People) under it, `src/Drawer.js` (80% / max 280px, slides 0.2 s "ease" with `Animated`, a
  backdrop; `position: absolute` spelled out: `StyleSheet.absoluteFillObject` silently did nothing in RN 0.86),
  `src/Sidebar.js` (left: People + request badge, channels with headings, DMs with pictures and dots, your
  panel), `src/Members.js` (right: Bots, roles, Online, Offline dimmed, like renderMembers); `view` (a key or
  "people"), a history for the back button (closes a drawer first), the first channel at start.
  `src/config.js` (`SERVER`: the dev server at localhost:8001, reached with `adb reverse tcp:8001 tcp:8001`),
  `src/connection.js` (`useConnection`: the WebSocket, reconnecting, "looking" with `mobile: true`, state from
  welcome/my_presence/roles/channels/groups/friends/blocks/users/custom_emoji/unread/history/older/message/
  edited/deleted/reactions/pinned; `openChat`/`closeChat` send "join", `loadOlder`, `lastRead`, `friendAction`
  POSTs /friends/...), `src/LoginScreen.js` (login.html's card; Forgot/Create open the web pages in the
  browser; POST /login, Android keeps the cookie for the WebSocket and images; a 4001 close shows it),
  `src/ChatScreen.js` (messages.js's rules: `buildRows` groups within 5 min, date lines, the NEW line; 40px
  pictures, role colours, "Today at", the reply line, chips; an inverted FlatList with `onEndReached` for
  older; the long-press `MessageMenu` stands in for the hover bar: reactions, Reply, Pin, Edit, Delete;
  editing in the bottom box (phone reason: the keyboard); `#autocomplete`-style @ suggestions; blocked
  messages behind Show), `src/PeopleScreen.js` (renderPeopleList's tabs Friends/Everyone/Requests/Blocked, Everyone's search and
  Online/Offline, Received/Sent, makeFriendButtons; phone reason: the four tabs share the width equally, as
  at the web page's size they wrapped; no Invite someone or profiles yet: their own sub-step). App.js leaves
  a DM whose person is no longer a friend (or a group we left) for the first channel, like the web page.
  Messages like the web (since 2026-10-15): `src/format.js` (messages.js's formatting rules, INLINE_PATTERN
  and all, into a tree; `isOnlyEmoji` for jumbo), `src/MessageText.js` (draws it: code, quotes, spoilers,
  links open in the browser, mentions, custom emoji via React Native's Image (it sends the cookie; expo-image,
  tried first, didn't, so the server 404'd), attachments, link preview cards; a paragraph with $inline maths$
  becomes a wrapping row of words, as Android can't size a view inside a Text; `FittedImage`: `resizeMethod="resize"`, as
  Android decoded network pictures at full size, ~48 MB a photo, pushing each other out of Fresco's memory cache (lag,
  reloading while scrolling), and `naturalSizes` remembers sizes so rows FlatList rebuilds don't jump open), `src/MathView.js` (KaTeX from
  the server's /katex-0.18.9/ in a react-native-webview per formula, which reports its size; containerStyle
  needs the size too or the webview's flex: 1 box collapses), `src/Picker.js` (the phone bottom sheet with
  Emoji | GIF tabs, recently used in memory, custom emoji by owner; GIFs via /gifs/search and /gifs/send),
  ":"/"@" suggestions and the status line ("is typing…", "Sending GIF…") in ChatScreen. `plugins/animated-webp.js`
  (a config plugin in app.json) turns on `expo.webp.animated` for GIPHY's WebP. emoji.json now also has
  "versions" (make_emoji_json.py; Unicode 18.0 on 2026-10-15): the app hides emoji newer than its Android draws
  (`newestEmojiVersion`, API 36 = Emoji 16.0; a cracking face 🫫 showed as a box).
  Pictures and files (since 2026-10-15): `src/files.js` uploads (POST /upload with an expo-file-system `File` as the
  body) and downloads (a stream written piece by piece into `Paths.cache/downloads/<id>/`, with progress) through
  **expo/fetch**, because expo-file-system's own upload/download use an OkHttp client without React Native's
  cookie jar (the server would say "not logged in"); `openFile` (expo-intent-launcher, ACTION_VIEW on the
  `contentUri`, flag 1 = read permission), `shareFile` (expo-sharing). The + by the text box opens `AttachMenu`
  (expo-image-picker's photo picker and camera, which give no real names: named from the EXIF DateTimeOriginal like
  Samsung's camera, `20261014_182205.jpg`, else `photo-<time>.jpg`; real names would need photo access, see ROADMAP's Maybe;
  expo-document-picker for any file, as it asks Android for the real name: `File.pickFileAsync` gave "document:1000006562"),
  the `Tray` above the box (the web's #tray: limits.files_per_message files, 50 MB each, all in one message with the
  caption, failed ones in red), "Uploading x…" on the status line. A tapped picture opens `src/ImageViewer.js` (a Modal with
  its own GestureHandlerRootView: pinch, drag, double tap via react-native-gesture-handler + reanimated; zoom only
  there); a tapped file asks "Download this file?" like the desktop app, shows a bar, saves it in Download straight away (like a browser; the user's wish) and asks Close / Open (opens the
  Download copy by its content:// Uri). The viewer's download button saves too, with a toast; Share is only there. Saving is our own native module `mobile/modules/downloads` (Kotlin, made with
  `create-expo-module --local`, autolinked from `modules/`): `saveAsync` inserts into MediaStore.Downloads with
  IS_PENDING, copies the bytes, and returns {name, uri}: the name MediaStore gave it (it adds " (1)", " (2)" from the clean name;
  after 32 it throws and we add the time). No permission (Android 10+; older ones get an error). expo-media-library
  was tried first and dropped: it only knows Pictures/DCIM. `saveFile` then deletes the app's own copy, and App.js
  empties `Paths.cache/downloads` (and `shared`) at every start (`clearOldCopies`), so nothing stays twice.
  Sharing to the app (since 2026-10-15): `plugins/share-intent.js` adds SEND / SEND_MULTIPLE `*/*` intent filters to
  MainActivity; our module `mobile/modules/shared-files` (Kotlin) reads the Intent: `getInitialShareAsync` (started by
  a share) and an "onShare" event from `OnNewIntent` (already open; singleTask), each `{files: [{uri, name, size, type}],
  text}` with names from OpenableColumns, marked handled (and LAUNCHED_FROM_HISTORY ignored) so it isn't shared twice;
  `copyAsync` copies one into `cache/shared/<uuid>/<name>`. App.js keeps the share through login; a share while the
  app runs (`fromStart` false) goes straight into the open chat (the user's wish), one that started it (or on the
  People page) shows `src/ShareScreen.js` ("Share to…": the sidebar's chats with a search box; back or × cancels).
  ChatScreen gets it as `shared`: text appended to the box, files that fit copied and passed to `addToTray`; until
  it's sent (or another chat opens), back takes it out again and `BackHandler.exitApp()`s to the sending app.
  Development builds can't test a share that starts the app: expo-dev-launcher swallows it (its launcher screen,
  then a MainActivity Intent without action or extras); a release build has no launcher.
  The chat's buttons (since 2026-10-15): `src/ChatHeader.js` (`ChatTitle`: name, a group's members; `ChatButtons`: the
  web's #dm-header buttons, bell (`mutedChats` from "mutes"; muted chats faded, no unread dot, no red dot on the menu),
  search, pin) **in the top bar itself, not a second bar under it (the user's wish)**; App.js keeps `popup`, ChatScreen draws it;
  `src/MessageCard.js` (`Popup`, a Modal like the web's dialogs, and makeMessageCard's cards), `src/PinsScreen.js`
  (`openPins`/`closePins`: asked again on "pinned"/"deleted" while open), `src/SearchScreen.js` (300 ms after typing,
  `search()` returns its `ask`; This chat / Everywhere as two buttons; From is the type-to-search picker, its list a
  child of the popup since Android ignores taps outside a parent's edges). ChatScreen's `jumpTo(chat, id)` (pins,
  results, a reply's quote) opens the chat (App.js `go` as `onOpenChat`), loads older batches (40 at most) until the
  row is there, `scrollToIndex` (`onScrollToIndexFailed` scrolls to a guess and retries) and `Flash` fades it.
  `src/time.js`: dayName, clock, headerTime.
  Calls parity (2026-10-16, needs the APK after 1.0.1): `MicProcessor.kt` has the noise gate after RNNoise and the
  mic volume (`gateDb`, voice-gate.js's 0.3 s hold and 5 ms fade; settings `gate`, default -60) and publishes `level`/
  `open`, read by `getMicLevel()` (our own speaking ring = the gate open; Settings' meter in a call). `CuePlayer.kt`
  plays "ring" in a SoundPool of its own with USAGE_NOTIFICATION_RINGTONE (res/raw/chatapp_ring.wav from
  make_call_sounds.py; `stopRing`); the in-call cues stay signalling. `src/callStats.js` (`measureCall`, the web's
  measuring) every 5 s in voice.js -> `stats`, `pingSamples`, `server`; `src/ConnectionScreen.js` (SignalButton in
  the voice bar, the popup with react-native-svg's graph). Status `detail` (why the mic/camera/share didn't start,
  `callError` under tiles); the voice bar shows `notice` (No answer/Declined) outside calls; CallBanner's grip
  (PanResponder, `bannerHeight`); tiles and CallFloat: long press -> user menu; `ShareMenu` (CallParts, rendered in
  App.js): sizes from SHARE_HEIGHTS up to the screen's short side, made by the sender's `scaleResolutionDownBy`
  (react-native-webrtc always captures the whole screen at 30 fps), H.264 without simulcast.
  Messages parity (2026-10-16): a long press on a reaction chip (Alert with the names), MessageText `onMention`
  (a tapped mention opens the profile), the menu's time (headerTime) and Copy text (expo-clipboard, readableText),
  the counter on the status line (COUNT_FROM 200, `charNote`), the NEW line live (connection.js `myId`/
  `newWhileAway`; ChatScreen `onViewableItemsChanged` scrolls it to the top once per history, viewPosition 1 as
  the list is inverted), an emptied edit = delete (asked; a file's caption may be emptied), `toBottom()` on send,
  @everyone everywhere + status details, `recent-emoji.json` (Picker.js), `replyContent` (quotes with emoji,
  mentions, a paperclip), empty files refused, MessageCard `onUserMenu` (pins, search).
  Bad connections (since 2026-10-16): Android's WebSocket never pings or times out, so a dead connection
  looked open for minutes and messages went into it. connection.js: a heartbeat (`{"type": "ping"}` every
  15 s on screen, at once after sending and on coming back; anything from the server answers; none in 6 s ->
  `connect()` again; retries at most 5 s apart) and the outbox (`sendMessage` -> `{nonce, chat, ...}`, sent
  with `channel` and `nonce`, again at every onopen; gone on "message" with its nonce or "sent"; failed after
  30 s or "not_sent"; ChatScreen `PendingMessage` faded, "Sending…" after 1.5 s, Retry / Delete). server.py:
  "ping" -> "pong", a message may name its `channel`, `recent_nonces` (10 min, memory) confirms a repeat
  without saving it twice, "sent"/"not_sent" to the sending page, `nonce` in "message". The web page doesn't use them.
  Stuck connections (2026-10-19, mongri's report: phones reconnecting in a loop for up to a minute): a connection
  that stops reading fills its buffer and uvicorn's send then waits; we send to everyone one after another, so it
  held up every sender, and new connections hung at `announce_presences` without answering pings. server.py `send`:
  `SEND_TIMEOUT` 5 s, then the client is marked `stuck` (skipped) and its chat() task cancelled (cleaned up like a
  close). tests/test_messages.py `never_reading` reproduces it. The app: `OPEN_WAIT` 10 s for a connection still
  opening (React Native waits for the upgrade's answer for ever), onopen closes one already replaced. Expo's dev-menu gear can cover the top bar's buttons in development builds: drag it.
  The rest of parity (2026-10-16, needs the APK after 1.0.2): `src/VerifyScreen.js` (verify.html; LoginScreen asks
  /verify/status at mount and after logging in, polls every 5 s); `src/MessageBanner.js` (notifications.js `banner` from
  "unread"'s notify and new requests, only while active and not quiet; setting `banner`; tap -> App.js `goToNotice`,
  swipe up, 5 s); App Links (app.json `intentFilters` https chat.datslok.no path "/" autoVerify; App.js `linkTarget`
  via Linking -> `opened`; server `/.well-known/assetlinks.json` from android.json's `package`/`fingerprint`, which
  app-release.ps1 adds from apksigner); the icon badge = Notifications.kt `setNumber` (messages stacked per chat;
  Android has no badge API); appUpdate.js `checkForApk` at every welcome and after a call, `setApkCheckPaused` in
  calls, Later = that version not again until restart; fonts (theme.js `FONT_FAMILIES`: georgia serif, consolas
  monospace, comic casual, calibri/system the phone's; `useStyles`' `withFont` adds fontFamily to every style with a
  fontSize and none of its own); Sidebar's "N members", the empty-DM note, a long press on your panel = your user menu.
  People and groups (since 2026-10-15): App.js's `dialog` state draws them over everything: `src/ProfileScreen.js`
  (#profile: Banner, roles, Activity with activityDuration, bio, the friend buttons), `src/UserMenu.js` (userMenuItems
  as a `src/Sheet.js` bottom sheet; no Call, Ban or Make admin yet; Mention appends "@name " to `drafts` and bumps
  `focusTick`), `src/MeScreen.js` (#me-popup above your panel: Status picker, `setPresence`; no Edit profile/Log out
  yet), `src/GroupScreen.js` (GroupDialog: new group / Add people with a search box over checkboxes; RenameDialog, as
  Android has no prompt(); GroupMenu, the ⋯ in a group's top bar: Add people, Rename, Leave), `src/InviteScreen.js`
  (the People page's green Invite someone; Copy via **expo-clipboard**, New link copies at once). `src/friends.js`:
  friendButtons/askToBlock/askToRemove, shared by People, profile and menu; `src/api.js`: getJson/postJson.
  A tap on a message's picture or name, a member or a People row opens the profile, a long press the user menu (a
  nested Pressable takes the touch before the message's); a DM's long press in the sidebar the menu; + by "Direct
  messages" a new group; your panel your popup. `groupName` leaves bots out ("Just you"), like the web's groupLabel.
  Themes (since 2026-10-15, the user's choice: instant, not an app restart): `src/theme.js` has chat.css's eight themes
  by variable name (--bg-panel -> bgPanel), `makeTheme(appearance)` -> {colors (picked colours on top, accent15/30/35 and
  yellow8 derived, icon/iconStrong by guardIconColours' WCAG 3:1 rule), size(n) (the text size: n * font_size/16),
  presence, light}, and `ThemeContext`. **Every file's styles are `const makeStyles = (colors, size) =>
  StyleSheet.create({...})` with `fontSize: size(16)`, read in each component with `useStyles(makeStyles)`**
  (cached per theme in a WeakMap); colours in JSX come from `useTheme().colors`; never a module-level colour.
  App.js holds the appearance (useMemo -> Provider; `Frame` draws the safe area and a dark/light StatusBar);
  `appearance.json` in Paths.document is the first-paint copy (read with textSync); connection.js's `appearance`
  comes from "welcome" and "appearance". Scale isn't in the app (the Windows app's zoom); fonts are, as near as Android has them (see "The rest of parity").
  Settings (since 2026-10-15): `src/SettingsScreen.js` (full screen, the phone layout's tab row and ×; remembers the
  last tab), `src/AccountSettings.js` (username, email with its pending link, password; /me), `src/ProfileSettings.js`
  (expo-image-picker's own crop, then **expo-image-manipulator** to 256x256 / 960x320 WebP, `uploadPicture` in
  files.js through expo/fetch; DELETE /settings/avatar|banner; status and bio), `src/AppearanceSettings.js` (swatches,
  **reanimated-color-picker** in a popup with its own GestureHandlerRootView, live preview at most every 80 ms and
  saved on Done, Cancel restores; text size with our `src/Slider.js`, a PanResponder slider), `src/SettingsParts.js`
  (Title, Heading, Help, Field, Button, Status, Form). Opened by ⚙️ on your panel and Edit profile in your popup,
  which also has Log out (`connection.logout`: POST /logout, close, me null, the login screen).
  The rest of Settings (since 2026-10-15): `src/PictureEditor.js` (the web's #cropper: `pickPicture()` (quality 1 = the
  file as it is, so a GIF stays one; stills loaded through expo-image-manipulator, which turns EXIF-rotated photos
  upright, and shown as a 2048px copy so what you see is what's cut), pan + pinch (gesture-handler/reanimated) and our
  Slider; Save cuts a still into WebP, a GIF goes whole with ?left&top&width&height like the web), used by Profile and
  `src/EmojiSettings.js`; files.js `uploadPicture(path, picture, extra)`. `src/changelog.js` (`useChangelog`, fetched
  at every connect; the seen count in `changelog-seen.txt`; dots on ⚙️ and the tab) + `src/ChangelogSettings.js`;
  `src/FeedbackSettings.js` (sends `phone: true`: the server marks it "ChatApp Android app", the inbox says Android
  app); `src/AdminSettings.js` (sub-tabs like the web; the inbox fetched by SettingsScreen for "Admin (n)" and again
  when the tab opens; `askToSetAdmin`), `src/BanDialog.js` (`mayBan`; lengths as buttons), `src/PersonPicker.js`
  (type-to-search, suggestions in the flow under the box; `matchPeople` in people.js). The user menu has Edit
  profile, Make/Remove admin and Ban…. `src/SeasonScreen.js`: `SeasonBadge` on your panel picture (a 4px-padded box
  so more of it takes taps) and the video in `src/VideoScreen.js` (our own bar under the video: time
  bar, play, time, mute, volume; Android's controls were a big overlay with no volume; chat videos use it too). dev.db's "phone" is admin and owner (password in my memory).
  Calls (since 2026-10-15): `livekit-client` + `@livekit/react-native` 3.0 + `@livekit/react-native-webrtc` 144 +
  `@livekit/react-native-expo-plugin` 1.0.3 (1.0.2 breaks on SDK 57; audioType communication); `registerGlobals()` in
  `src/livekit-setup.js`, imported first by index.js (imports run before code). `@config-plugins/react-native-webrtc` was
  dropped: LiveKit's own manifest has the permissions, and it would add SYSTEM_ALERT_WINDOW. `src/voice.js` (`useVoice`, in
  App.js's `Screen` so a call outlives Main): join (RECORD_AUDIO asked, `startCallService`, AudioSession communication with
  preferredOutputList bluetooth/headset/speaker, /voice-token, `Room` with micOptions and the Settings camera), leave,
  mute/deafen like the web, volumes (`participant.setVolume`, 0-2), speaking rings from LiveKit's native
  `createVolumeProcessor` straight on `NativeModules.LivekitReactNativeModule` (LK_VOLUME_PROCESSED ~100/s per track,
  checked every 50 ms, -50 dB, 0.3 s; -1 = our own mic), camera (`CAMERA_CAPTURE` 4:3 960x720, the sensor's shape: 16:9 cut the sides off; `CAMERA_PUBLISH` H.264 1.7 Mbit/s, which the phone encodes in hardware, c2.qti.avc.encoder: VP8 was libvpx in software and went blurry now and then; `facingMode`, flip with `restartTrack` passing the size too), screen share
  (react-native-webrtc's MediaProjectionService; no sound), outputs (`AudioSession.getAudioOutputs`/`selectAudioOutput`),
  ringing (`callListener` in connection.js; `outgoing`, `incoming`, `notice`; sounds + `Vibration`, none on dnd),
  `voice-settings.json` in Paths.document (noiseSuppression on/light/off like the web, micVolume, outputVolume,
  personVolumes, screenVolumes, camera user/environment, floatCorner). Mic processing (the user's wish, like the web):
  `MicProcessor.kt` in the call-service module is LiveKit's `audioProcessingController.capturePostProcessor` (set in the
  module's OnCreate; WebRTC hands it 480 floats per 10 ms at 48 kHz, the 16-bit range): RNNoise ("on"; "light" is the
  `noiseSuppression` constraint, micOptions) then the gain; `setAiNoiseSuppression`/`setMicVolume` from voice.js.
  RNNoise 0.2 is C in `src/main/cpp/rnnoise-0.2/` (committed; `tools/get_rnnoise.py`: Xiph's release tarball pinned by
  SHA-256 after checking it against the signed v0.2 tag, plus five headers from commit 372f7b4, since 0.2's ARM code
  includes a missing os_support.h), built by `src/main/cpp/CMakeLists.txt` into libchatappaudio.so (~1.4 MB per ABI,
  16 KB pages) with the JNI bridge `denoiser.c` / `Denoiser.kt`. The mic test meter adds the mic volume in dB.
  Notifications: the module's manifest has POST_NOTIFICATIONS, asked for at each join (Android 13+); without it even the
  foreground service's notification is hidden. Its channel "ongoing_calls" is default importance with no sound and
  VISIBILITY_PUBLIC (the first, low-importance "calls" one, which Samsung hid from the lock screen, is deleted). connection.js: `voiceMembers`, `dmCalls`, `sendVoice` (re-sent at every
  reconnect), `ring`/`answerCall`/`cancelCall`. Screens: `src/CallParts.js` (RoundButton, `makeTiles`, CallTile with
  `<VideoTrack>`, TileGrid = fitTiles, FocusView: a tap on a tile opens it over the screen, and only while it's open the app may rotate (**expo-screen-orientation**: `unlockAsync` = Android's UNSPECIFIED, which follows the phone's auto-rotate; closing locks PORTRAIT_UP again; sideways it fills the screen; the user's wish, 2026-10-21; its ×, name band and volume slider fade out after `CONTROLS_FOR` 3 s, a tap toggles them, so × or back closes it), the screen kept on for the whole call (**expo-keep-awake** in useVoice while `roomName` is set: the window's FLAG_KEEP_SCREEN_ON, only while the app is in front; the user's choice over only in FocusView, 2026-10-21), OutputButton's Sheet,
  CallControls), `src/LoungeScreen.js` (the `voice:lounge` view; App.js `pick` joins it like the web), `src/CallBanner.js`
  (40% of the height above a DM's/group's chat), `src/IncomingCall.js`, the Sidebar's Voice list + VoiceBar + mute/deafen
  in your panel, the green phone in ChatButtons, Call in the user menu, Voice volume in profiles, In voice in MeScreen,
  `src/VoiceSettings.js` (Voice & audio: Choices, Others' volume, the mic test via expo-audio's recorder metering, which
  LiveKit's measuring can't do outside a call; Video: front/back + a preview with react-native-webrtc's RTCView).
  Sounds from `tools/make_call_sounds.py` (rooms.js's tones): the ringtone through **expo-audio** (plugin with
  enableBackgroundPlayback false: no media service of its own; `mobile/assets/sounds/ring.wav`); calling/join/leave through
  the call-service module's `CuePlayer.kt` (SoundPool, USAGE_VOICE_COMMUNICATION_SIGNALLING, res/raw), because media
  sounds waited 5-6 s while Android switched into or out of call mode. Locked phone: our module
  `mobile/modules/call-service` (Kotlin; its own AndroidManifest.xml is merged in: FOREGROUND_SERVICE_MICROPHONE/CAMERA/
  MEDIA_PLAYBACK/MEDIA_PROJECTION, the service with those types): `CallService` (startForeground with the types we have
  permission for, the "Ongoing calls" channel, Hang up -> "onHangUp", a partial wake lock, stops on onTaskRemoved) and a
  **headless JS task** (`ChatAppCall`, registered in index.js of the module) for the call's length, because React Native
  pauses every JS timer in the background unless one runs (JavaTimerManager), which would stop LiveKit's pings and
  negotiation (livekit/client-sdk-react-native#437) and the chat socket's reconnecting. Dev: `voice.ps1 -Dev` listens on
  127.0.0.1:7880 (`adb reverse tcp:7880 tcp:7880`) and UDP 7882 on the LAN address (same Wi-Fi; this PC's firewall allows
  livekit-server.exe).
  `prebuild --clean` failing with EBUSY on `android/`: the adb server started by run:android stands in it (`adb kill-server`).
  Push notifications (since 2026-10-15): Firebase project `chatapp-e2944` (my Google account, Spark plan, no Analytics or
  Gemini); `mobile/google-services.json` (app.json `googleServicesFile`) and the service account key `firebase-key.json`
  in the repo folder (server.py's `FIREBASE_KEY_FILE`), both git-ignored; the key goes with export/import/backup.ps1.
  **The real server doesn't have the key yet** (copy it with scp when the app is distributed). Server: `/push/fcm` stores the
  token in push_subscriptions as `fcm:<token>` (an upsert that keeps the mute), `send_push` sends data messages through
  `send_fcm` (FCM HTTP v1; the access token from an RS256 JWT we sign with `cryptography`, cached an hour; 404 deletes),
  `always=True` (phones only, ignoring looking/mute) for `stop_ringing`'s `call_end` (answer_call, ring_timeout, end_call),
  `/calls/decline`, "welcome" has `phone_push`. "read" (since 2026-10-16; FCM priority NORMAL): `on_phones` (memory) holds
  (user, chat) for every message/friend push a phone got; `clear_on_phones` sends "read" once that chat is seen elsewhere
  (join while looking, "looking" true on it; "friends" = channel None or accept/decline), PushService cancels it (the
  icon's number is the sum of the notifications showing); the app clears "friends" itself on the People page (App.js). App: our module `mobile/modules/push` (Kotlin; firebase-messaging 25.1.3,
  whose getToken/onNewToken are deprecated since 25.1 for installation IDs but still work): `PushService` (Firebase's
  MESSAGING_EVENT), `Notifications.kt` (channels "messages" with the ping and "incoming_calls" with the looping ring
  (FLAG_INSISTENT); MessagingStyle stacked per chat (tag = chat key) with avatars fetched with CookieManager's cookie;
  CallStyle with a full-screen intent), **`IncomingCallActivity`: the only thing ever shown over the lock screen (the
  user's rule: never the app itself; MainActivity showWhenLocked was tried and refused)**, a small centred see-through
  window (picture, "x is calling…", Accept/Decline like IncomingCall.js, its own task); Accept = requestDismissKeyguard
  (unlock) then the app with "accept"; `DeclineReceiver` POSTs /calls/decline with the cookie. `PushModule.kt`: token,
  taps (`getInitialOpenAsync`/"onOpen" like shared-files: {channel, messageId, action open/ring/accept}), clearChat/
  clearCall/isCallShowing, canFillScreen (USE_FULL_SCREEN_INTENT, Android 14+). JS: `src/notifications.js`
  (`useNotifications` in App.js's Screen: notification-settings.json, register at every welcome, asks POST_NOTIFICATIONS
  the first time, mute -> /push/mute, the ping (`assets/sounds/ping.wav`) on "unread"'s notify and new friend requests,
  not in the background while push is on; clears a chat's notification when it's opened; `forgetThisPhone` at logout),
  `src/NotificationSettings.js`, voice.js (no own ringing in the background with push on, nor while the call's
  notification is showing: Android's loop keeps going when the app is paused; `acceptFromNotification`), App.js (`opened`
  -> go/jumpRequest/People's Requests tab). A tap that starts a closed app can't be tested in development builds (the dev
  launcher drops the extras, as with shares). App.js asks `getInitialOpen` again at 0/0.3/1/2.5 s: at a cold
  start the Activity can still be missing (the answer was "none" and it opened #general; fixed 2026-10-16). `adb logcat -d` (read-only) showed what went wrong each time.
  Distribution (since 2026-10-15): the icon is an adaptive icon made by `tools/make_pwa_icons.py` (the drawing on
  transparency, centred on its smallest enclosing circle and scaled to the 66/108 safe zone, the user's wish; app.json
  backgroundColor #0086D7, a monochrome layer). Notifications' small icon (since 2026-10-16, the user's choice: "a little
  thicker", centred, as big as fits): the same script makes `push_cat_icon.png` (modules/push) and `call_notification_icon.png`
  (call-service) in drawable-mdpi..xxxhdpi (24..96 px): the drawing's alpha without its faint specks (<= 32, which
  shifted it off centre), MaxFilter 19 at 1000 px wide, its box filling the 22/24 live area; `setColor` #0086D7.
  `push_call_icon.xml` (the phone) stays for IncomingCallActivity's buttons.
  Every new APK resets "Full screen notifications" (Android 14's USE_FULL_SCREEN_INTENT, for apps not from Play; seen
  2026-10-16, ordinary notifications survive): `src/FillScreenPrompt.js` (in Main) asks once per runtimeVersion
  (`fill-screen-asked.txt`) when push is on and canFillScreen is false; Allow it -> openFillScreenSettings. Release builds are signed by `plugins/release-signing.js` with
  `~/.chatapp-keys/android-release.jks` (password in `~/.gradle/gradle.properties`, CHATAPP_RELEASE_*; see my memory;
  the user keeps a copy). `plugins/dev-variant.js`: debug builds are `no.datslok.chat.dev` "ChatApp Dev" (the user's
  choice: both on the phone; google-services.json has both apps), so `adb shell am start` etc. need the .dev package.
  `config.js` SERVER: `__DEV__` ? localhost:8001 : https://chat.datslok.no. Updates: **expo-updates** with
  runtimeVersion policy appVersion (fingerprint hashed generated folders) against server.py's `/app-update` (Expo's
  protocol 1: newest `releases/app-updates/<version>/*.json`, URLs filled from PUBLIC_URL, 204 when none; files in
  `releases/app-assets/<md5>.<ext>`, immutable; `src/liveUpdates.js` checks at every connect and return to the app and
  switches with Updates.reloadAsync when safe (no call, trays, share or popup; view + drafts kept through cache
  reload-state.json, `restored`), the user's wish, like the desktop's reload), made by `scripts/app-update.ps1` (ends
  with deploy.ps1 so open apps reconnect, then `tools/prune_app_updates.py` here and on the server: the newest 3
  manifests per version and the app-assets they name stay; refuses when mobile/modules,
  plugins, app.json or package*.json changed since android.json's commit) + `tools/make_app_update.py`. New APKs:
  `scripts/app-release.ps1` (bumps version + versionCode, commits "Phone app x", prebuild + gradlew
  app:assembleRelease, apksigner must say CN=ChatApp, `releases/ChatApp-android-<v>.apk` + `releases/android.json`
  {version, versionCode, apk, commit}, scp, removes old APKs; hyphens keep them out of release-upload.ps1's
  `ChatApp_*` clean-up). The app: `src/appUpdate.js` + `src/UpdateScreen.js` (release builds: android.json newer
  than Updates.runtimeVersion (at start, every connect and after calls) -> "A new version" popup, download into cache/apk with a bar, ACTION_VIEW to Android's
  installer; REQUEST_INSTALL_PACKAGES in app.json). `/download/android` redirects to the newest APK (served as
  application/vnd.android.package-archive); download.html shows the Android section on Android (#android/#windows);
  login and landing pages say "Get the Android app" on Android (`data-android`), nothing on iPhones.
  `src/people.js` (Avatar with letter colours, StatusDot with the phone shape, BotBadge, Person, nameColor),
  `src/Icon.js` (react-native-svg's SvgXml with the web page's Lucide shapes from `src/icon-shapes.js`,
  written by tools/make_icons.py too), `src/chats.js` (keys and labels), `src/theme.js` (the theme, see below).
  dev.db has the test accounts "phone", "phone2" and "tester" (phone's friends both). Rules (from the template's AGENTS.md): check Expo's
  docs for SDK 57 specifically, always `npx expo install` for packages, never edit the generated
  `android/` (git-ignored; `npx expo prebuild --clean` after changing `app.json`).
- Limits the pages need (emoji per person, upload and GIF sizes, picture types, group size, name/status/bio/
  ban reason/feedback lengths) are written only in server.py: `LIMITS`, sent in "welcome" as `limits`. Web: core.js
  `limits` (+ `applyLimits` sets the HTML boxes' maxlength from `LIMITED_INPUTS`, `megabytes()`); phone:
  `src/limits.js` (filled by connection.js). Never copy such a number into a page: add it to LIMITS.
  (The message length is the older `max_text_length`; page-design numbers stay in the pages. The tray holds
  `files_per_message`.)
- Several files per message (since 2026-10-18, the user's wish, like Discord): `attachments.message_id` + `position`
  (one-to-many; the old `messages.attachment_id` was moved there and dropped by a migration). A message sends
  `files: [upload ids]` (1 to `MAX_FILES_PER_MESSAGE` 10, different; `claim_attachments` claims all or none, one
  transaction; the old single `file` is still accepted) and comes back with `files: [file_info...]` (`files_for`, one
  query like reactions_for; `with_files` also sets `file` = the first, for phone APKs from before). Chat info's Media and
  Files tabs pick a message if it has any file of that kind (the pages take only those files); `files_note` is the push/
  notify text. Web: `sendTray` uploads all, then one message; messages.js `makeAttachments` (one picture or video as
  before; several: `makeMediaGrid`, a 6-column grid of .media-tile, halves for 2 and 4, else rows of three after a first
  row with the leftovers; other files as links under it). `viewer.js` (#image-viewer): `openViewer(items, index, onJump)`
  with ‹ › and arrow keys, "2 / 5", the file's link (makeFileLink) and Jump (chat info: the whole Media tab), videos too;
  pictures zoom by CSS transform (`zoomAt` keeps the point under the mouse; wheel, ctrl+wheel = touchpad pinch, two-
  pointer pinch, double-click = real size, drag while zoomed, `clampPan`). Phone: MessageText.js `Attachments`/`MediaGrid`
  (videos as ▶ squares), `ImageViewer({files, index})` swipes between pictures (`ZoomablePicture` keyed per file,
  `scheduleOnRN`); connection.js `sendMessage(text, replyTo, files)`. Chattus: `attachments_to_show` counts files
  (with Claude every picture of the target message, `on_target`).
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
- Seasons (server.py, "Seasons"; people.js, "The seasonal easter egg"): `SEASONS` (name, months, emoji or image
  (worn like a hat: `.season-hat`; Christmas, December: static/seasonal/santa-hat.svg, our own drawing), video);
  `current_season()` (this month's, only if `seasonal/<video>` exists) goes in "welcome" as `season`; the page
  puts its emoji on our own picture in #user-panel (`.season-badge`), which opens #season-dialog with the video
  (`/seasonal/<name>`, logged-in only, only names from SEASONS). The videos are git-ignored, copied to the server
  with `scripts/seasonal-upload.ps1`, and in backup.ps1/export/import/backup-fetch. Halloween's is "SpOwOky OwOky
  Pumpkin Song", Christmas's "padowo padowo" (the user's own copies in `external/`). The panel's own picture is 32px (24 elsewhere).
- Icons (since 2026-10-14): the page's buttons use line icons, not emoji. `static/js/icon-shapes.js` holds Lucide's
  shapes (lucide-static 1.48.0, ISC; written by `tools/make_icons.py`, which downloads the npm tarball, checks npm's
  integrity hash and copies the icons in its ICONS list: add a name there and rerun); `static/js/icons.js` (loaded
  before core.js) has `makeIcon(name)`, `setIcon(element, name)` (replaces its icon; "has-label" when there are words)
  and fills every `data-icon="name"` in index.html at load. `.icon` in chat.css: 1.2em, stroke currentColor 1.8.
  Toggles swap icons (mic/mic-off, headphones/headphone-off, bell/bell-off, maximize/minimize). Emoji stay in
  OS notifications, server notes, What's new and anything people write. The smiley (`makeSmileyIcon`) is our own.
  Plain icon buttons use `--icon` / `--icon-strong` (hover), defaulting to --text-muted / --text-strong (a button
  doesn't inherit the text colour by itself: without one they were the browser's dark ButtonText). appearance.js
  `guardIconColours` (in every applyAppearance) measures WCAG contrast against bg-panel-alt, bg-panel, bg-main and
  bg-input and, below 3:1, sets them to the first readable of text-soft/text, else white or black.
- `static/emoji.json`: every emoji for the reaction picker (and the server's list of allowed reactions),
  made from Unicode's `emoji-test.txt` by `tools/make_emoji_json.py`. The page only offers the ones the
  device can draw (messages.js `makeEmojiTester`: drawn on a canvas in black and in white, a colour emoji
  ignores the paint; wider than 1.5 emoji = a ZWJ sequence fallen apart), so new emoji appear as fonts catch up.
  Country flags: Segoe UI Emoji has none (letters), so chat.css's `@font-face` "Twemoji Country Flags"
  (`static/flags-0.1.10/`, the woff2 + LICENSE from npm's country-flag-emoji-polyfill 0.1.10, checked against
  npm's integrity hash; served at `/flags-0.1.10/` like KaTeX) comes first in body's and `.emoji`'s fonts;
  `unicode-range` limits it to the flag characters. The tester `document.fonts.load`s it first.
- Maths in messages (messages.js, `makeMath`): `$...$` inline and `$$...$$` on its own line, with Pandoc's
  rule so money stays text (no space inside the dollars, no digit after the closing one), `\$` a real dollar.
  Drawn by KaTeX: `static/katex-0.18.9/` (`katex.min.js`, `katex.min.css`, the woff2 fonts and LICENSE, from
  npm's tarball, checked against npm's integrity hash; served at `/katex-0.18.9/` with a week's caching,
  `LastingStaticFiles`). Its defaults stay (trust off: no `\href`; maxExpand), plus `maxSize: 20`.
- The first account on an empty server (bots don't count) becomes admin by itself (`/register`, decided inside
  the INSERT). `tools/make_admin.py`: make someone an admin (or `--remove`, or `--list`); `--db dev.db` for development.
  Admins can edit and delete anyone's messages and custom emoji, and manage the channels.
- Channels (server.py, "Channels"): the `channels` table, one ordered list (`position`) of channels and
  headings (`heading` 1; a heading groups the channels below it until the next one). Messages and the rest
  store a channel's `key`, which never changes; renaming changes `name` only. The first three keep their old
  names as keys (general, memes, chattus, seeded when the table is empty); new ones get `c:` + 8 random hex
  (`h:` for headings). Admin-only: `POST /channels` (create, at the bottom), `/channels/{key}/rename`,
  `/channels/order` (the whole list of keys), `/channels/{key}/delete` (a channel with all its messages,
  files and previews; never the last channel). Every change sends `{"type": "channels"}` to every page
  (also sent at each connect); core.js `showChannels` redraws the sidebar, a page in a deleted channel goes
  to the first one. Settings → Admin → Channels (settings.js, admins only): each row a small form (Enter/Save
  renames), ↑ ↓, 🗑 with confirm(). `can_join` uses `is_channel`; push titles use `channel_name`.
  Private channels and limited roles (since 2026-10-16; for my parents: their DMs and #family only):
  `channels.private` + `channel_roles` (channel, role_id), `roles.limited`. `sees_channel`: the owner and bots see all (not other
  admins: the user's wish; they can still give themselves a role; bots are never limited); private = one of its roles (none ticked or its
  role deleted = the owner only, never public); open = not limited (admins never are). Admins only manage the
  channels they see (`managed_channel`; reordering moves only those, around the others). `can_join` ->
  `may_see_channel`, `visible_chats` and "channels" use `channel_list(user_id)` (per person; a heading with nothing
  under it is dropped; GET /channels needs login now), "channels" has `lounge` (`may_use_lounge`; `may_join_voice`
  for /voice-token and "voice"; `voice_members_message(user_id)` is empty for them, `announce_voice_members`).
  `announce_channels` sends each page its own list after channel, role, role-member, limited and admin changes,
  sets a page's channel to None if it lost it and takes them out of the Lounge (remove_from_voice). Admin:
  `POST /channels/{key}/access {private, roles}`, `/roles/{id}/limited {limited}`; Private + role boxes under each
  channel row, Limited under each role (web settings.js `makeChannelAccess`; phone AdminSettings.js `ChannelAccess`).
  Pages: `seesChannel` (people.js; phone chats.js) filters a channel's member list; no channels -> People; the
  Voice section hidden (`loungeAllowed`; phone `connection.lounge`, null until the first "channels").
  Hidden roles (`roles.hidden`, `/roles/{id}/hidden`; the user's wish: nobody but admins should know the Parents
  role): `roles_message(user_id)` leaves them out for non-admins and `users_for` strips them from each person's
  roles (every "users" goes through `announce_users`); so non-admins get a channel's `members` (private) and each
  user's `limited` instead of role ids ("roles" in channel items is admin-only). `topRole` skips hidden roles on
  both pages (no colour or member list section, even for admins; only the profile tag shows, to admins).
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
  changed. dnd: `isMuted()` on every page and no pushes (`send_push`). Phones: "looking" carries `mobile`
  (notifications.js `onPhone`; never the Windows app), `on_phone_only` (every open page a phone, not offline)
  gives "users" a `mobile`, and `makeDot(presence, mobile)` draws `.dot.mobile`, a little phone.
  Phones (since 2026-10-16, the user's rule; PCs unchanged): Android cut a locked phone's connection at once, so it went
  grey. `device_presence`: a phone is online while looking, idle from the moment it's locked/left, gone after
  `PHONE_AWAY_FOR` (10 min) even if still connected (in voice: stays idle); `phones_away` keeps a phone whose connection
  closed while away (from its away_since; a reconnecting phone's "looking" takes it over); each person shows their
  most present device. Page: the picker in #me-popup
  (people.js, `renderPresencePicker`), dots `.dot.online/.idle/.dnd/.invisible` (our own Invisible as a ring).
  The users' "status" field is still the line they write about themselves.
- Recent and pinned DMs (server.py, "Recent and pinned DMs"; since 2026-10-16): the Direct messages list (web
  people.js `sortedDmKeys`/`renderDmList`, phone chats.js `sortedDmKeys` in Sidebar and ShareScreen) is groups and DMs
  mixed: pinned first, then newest message first (no messages: last, alphabetical). "chat_activity" {chats: {key:
  newest message id}}: all at connect, then one from `announce_new_message` (`announce_chat_activity`) to every member's
  pages. `pinned_chats` table, `{"type": "pin_chat", "channel", "pinned"}` (DMs and groups only) -> "pinned_chats" to
  all their pages (also at connect). Pin: the user menu's Pin DM, a group's Pin button (web #group-pin) / GroupMenu
  (phone; also a long press on a group in the sidebar); a pin icon on the row (`.dm-pin`, hidden under a red count).
- Muting (server.py, "Muting"): `chat_mutes` (user_id, channel), set over the WebSocket (`{"type": "mute",
  "channel", "muted"}` -> "mutes" to all their pages; also at connect). `save_mentions` leaves out people who
  muted the chat unless they're named in it (`<@id>`) or the sender is an admin, so no red count, notification
  or push. **Admins can't be muted or blocked** (the user's rule): `can_mute` refuses a DM with an admin, and the
  page hides 🔔 there. Page: `mutedChats` (core.js) fades sidebar items (`.channel.muted`) without unread dots;
  🔔/🔕 in the top bar (rooms.js).
- Blocking (server.py, "Blocking"): `blocks` (blocker_id, blocked_id); `POST /friends/block` (refused for
  admins and bots; deletes the friendship row, so DMs, group invites and DM calls stop) and `/friends/unblock`
  (not friends again: that takes a new request); "blocks" to the blocker's pages (also at connect). Neither
  side can send a request (the blocked one gets a neutral message). `save_mentions` drops the sender's
  blockers, `start_call` doesn't ring them, `search_messages` skips blocked senders. Page: `blockedIds`
  (people.js); their messages drawn as "🚫 A message from someone you blocked · Show" (`shownBlocked`);
  Block / Unblock in `makeFriendButtons` (profile, Friends page), and a Blocked tab on the Friends page.
- Roles (server.py, "Roles"): `roles` (id, name, colour "#rrggbb", position) and `user_roles`; admin-only
  `POST /roles` (create), `/roles/{id}/edit`, `/roles/order` (all ids), `/roles/{id}/delete`, `/roles/{id}/members`
  ({user_id, member}). "roles" (the list, top first; at connect before "users") and "users" (each person's
  `roles`, top first) go to everyone after each change. Page (people.js): `topRole` / `nameColour` colour names
  in messages and lists; `showUsers` gives each role with people online a member list section (#role-sections,
  after Bots); role tags in the profile. Settings → Admin → Roles (settings.js, admins): colour picker, name, ↑ ↓ 🗑,
  members with × and "+ Add someone". core.js redraws messages when the roles or anyone's roles change.
- The right column (#members, people.js `renderMembers` / `chatMembers`) shows the chat's members: everyone in
  a channel (all channels are open to everyone), the two people in a DM, a group's members (bots too); hidden
  on the People page and the Lounge. Everyone is on the People page's Everyone tab (with a filter box). The
  People page was the Friends page: its key (`FRIENDS`, "friends") and ids (#friends-view) keep the old name.
  👥 in #dm-header (ui.js, since 2026-10-18) hides it on wide screens: `#members.closed`, localStorage "membersClosed".
- The chat info panel (since 2026-10-18, the user's wish, like Discord; DMs and groups only, the user's choice): the
  name in #dm-header is a button (disabled in channels, rooms.js) that opens it in #members (`.info-open`, 340px, shown
  even when 👥 closed the list; on phones the right drawer). chat-info.js: tabs Members (#member-lists, renderMembers'
  lists), Media (a grid; a tile opens #image-viewer, which got #viewer-video and #viewer-jump), Pins ("pins", makePinnedItem),
  Links and Files (makeFileLink); Jump = jumpToMessage. Server: WebSocket `{"type": "chat_info", "tab", "before"}` ->
  "chat_info" {items, more, oldest} (server.py "Chat info", `chat_info()`: MESSAGES_QUERY rows with SHOWN_TYPES
  attachments / other attachments / http in the text, 50 per batch, `message_links()` = every link, first_link's rule;
  only `is_dm_or_group` + can_join). core.js calls `chatInfoNews` on message/edited/deleted/preview/pinned (reloads the
  tab if affected) and `closeChatInfo` in joinCurrentChannel. Phone: `src/ChatInfoScreen.js` (full screen, Settings'
  tab row; Members.js, PinsScreen's cards, `FileAttachment`, ImageViewer/VideoScreen with `onJump`; videos as ▶ squares,
  no first frame), opened by ChatTitle's `onInfo` (popup "info", drawn by ChatScreen); connection.js `watchChatInfo`
  ({batch, news}) / `askChatInfo`.
- The scroll-down button (since 2026-10-18): more than 1.5 views above the newest message, `#to-bottom` (in #status-line,
  placed above it; class "shown" fades it) scrolls #messages to the bottom (messages.js "The scroll-down button";
  joinCurrentChannel hides it). Phone: ChatScreen's `farUp` from the inverted FlatList's onScroll offset, `toBottom()`.
- Picking people: anywhere you choose from what could be everyone (or many), a type-to-search picker,
  never a drop-down (the user's rule): `usePersonPicker(input, list, {candidates, onPick, onType})` in people.js
  (search's "From", Settings → Admin → Roles "+ Add someone"); a multi-pick list (the group popup's friends) gets a
  search box on top that filters it (`filterGroupChoices`; ticked ones stay visible).
- The user menu (people.js, "The user menu"): right-click (a long press on phones) on anything with
  `data-user-menu="<id>"` (message picture and name, member list, DM list, Friends page rows, call tiles,
  pins/search card heads, our own panel) opens #context-menu, built by `userMenuItems` from how we stand
  with them (Profile, Mention, Message, Call, friend actions, Mute DM, Block; no Block or Mute DM for
  admins, no Block for bots). One document-level "contextmenu" listener (event delegation). The menu moves
  into an open modal dialog or the fullscreen element, or nothing outside those would show or be clickable.
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
  admin with an email. Admins read them in Settings → Admin → Inbox (settings.js; `GET /feedback` and
  `POST /feedback/{id}/done`, both admin-only on the server), or with `tools/feedback.py`
  (`--all`, `--done ID`, `--undo ID`, `--db dev.db`).
- `uploads/`: uploaded files, saved under random names (git-ignored, like `chat.db`).
  Thumbnails (since 2026-10-22, the user's rule: **a picture loads at the size it's shown; only the viewer loads the
  original**): `/uploads/<id>?size=N` (N in `THUMB_SIZES` 200/400/800/1200, in LIMITS as `thumb_sizes`) sends a WebP
  copy, longest side N, made once by `make_thumbnail` (Pillow, JPEG `draft`, `exif_transpose`, animations stay
  animated up to MAX_THUMB_ANIMATION_PIXELS; one at a time, `thumbnail_lock`) into `uploads/thumbs/<id>-<N>.webp`;
  the original when it's no bigger or can't be shrunk. `delete_upload` removes a file with its thumbnails. Pages:
  messages.js `pictureUrl(file, shown)` (× devicePixelRatio; tiles × `COVER_FACTOR` 1.5), phone files.js
  `pictureUri` (× PixelRatio). Viewer, ImageViewer, links and downloads keep the plain address.
  Videos (since 2026-10-15): `VIDEO_TYPES` (video/mp4, video/webm) are believed only if `is_video` finds the format's
  first bytes ("ftyp" at byte 4; 1A 45 DF A3), served inline like pictures (`SHOWN_TYPES`; FileResponse answers range
  requests for seeking), `file_info` has `"video"`; `mark_old_videos()` at every start turns earlier .mp4/.webm
  downloads that pass into videos. Web: messages.js `makeVideo` (<video preload="metadata"> in our player + the
  `makeFileLink` under it; an unplayable format leaves the link; the name under it downloads, the user's wish).
  The player (since 2026-10-19, the user's wish: Chromium's bar hid fullscreen in ⋮ on narrow videos, and a page can't
  add to it): video-player.js `makeVideoPlayer(video, {arrowKeys})` (no `controls`; the frame `.video-player` with
  `.video-bar` over its bottom: time bar and volume as <input type="range">, play, time, mute, fullscreen of the frame;
  shows only on hover (paused too, the user's wish) or keyboard focus on the frame or a button, in fullscreen hides
  2 s after the mouse stops ("awake") unless paused; click = play/pause,
  double-click = fullscreen, keys space/K, ← →, M, F; `.tall` (videoHeight > videoWidth) makes it at least 1:1, the
  user's wish; container queries on the bar drop volume < 260px and the time < 200px). The 400px limit is on the
  frame, not the video (on the video, the frame came out 533px around a 400px one). The viewer (`#viewer-player`,
  arrowKeys false: ← → stay its stepping) uses it too; the season popup keeps the browser's controls. Volumes (since 2026-10-16, the user's wish): every video starts at 30% and remembers its own
  (web messages.js `videoVolume`/`saveVideoVolume`, localStorage "videoVolumes" by file id or seasonal path, also the
  season dialog; phone VideoScreen.js, `video-volumes.json` by path, saved on close; the newest 200). Phone: expo-video (`VideoAttachment` in
  MessageText.js: the first frame with a play button; a tap opens `src/VideoScreen.js`, the popup with our control bar
  right under the video (the user's wish; Android's full screen had its controls at the screen's bottom); a
  see-through Pressable lies over the VideoView because the native view swallowed taps, so in-message controls never worked); its player downloads with its own OkHttp client without
  React Native's cookies, so `mobile/modules/cookies` (Kotlin, CookieManager.getCookie) hands it the login cookie
  as a header.
- Re-packing videos (server.py, "Re-packing videos"; since 2026-10-15): fragmented MP4s (screen recorders, browser
  recordings) say length 0 in their header; Android's player then shows no length and can't skip. Every uploaded
  video is re-packed by ffmpeg (`-c copy`, `+faststart`, `-map 0:v -map 0:a?`, 60 s limit, in a thread; the original
  stays if it fails) before /upload answers; `attachments.repacked`; `repack_old_videos` (started by the first
  connection) does older ones and fragmented seasonal videos (`mp4_is_fragmented` reads the top-level boxes).
  `find_ffmpeg` also reads PATH from the registry (a running server keeps its old PATH).
  Sound (since 2026-10-19, the user's wish: the player greys out the volume of a silent video): `FFPROBE` (beside
  ffmpeg, e.g. WinGet\Links\ffprobe.exe), `has_audio` (ffprobe -select_streams a; None = can't tell) at upload and for
  `attachments.audio IS NULL` in repack_old_videos; `file_info` gives videos `"audio"` (unknown = true);
  video-player.js `setVideoAudio(frame, hasSound)` disables `.video-mute` and the slider; the phone's VideoScreen
  `audio` prop (MessageText.js, ChatInfoScreen.js pass `file.audio !== false`) fades them with pointerEvents "none". ffmpeg: winget's
  Gyan.FFmpeg (install.ps1 step 1, machine scope; this PC has it per user, its bin folder on the user PATH).
- GIFs (server.py, "GIFs"; messages.js, "GIFs"): the GIF button by the text box opens #gif-picker. `/gifs/search?q=`
  (trending without q) asks GIPHY's API with `GIPHY_API_KEY` (.env; on this PC in the git-ignored `dev-secrets.env`,
  which start.ps1 loads) via `fetch_url`; answers kept an hour in `gif_cache` (the free key: ~100 requests an hour
  for the site), 20 requests per person a minute (`gif_allowed`), rating pg-13, `bundle=messaging_non_clips`.
  The grid shows `fixed_width_downsampled` previews straight from GIPHY's servers (`is_giphy_url`). `/gifs/send {id}`
  downloads the original WebP (or the 200 px one if over 5 MB), checks it with Pillow and saves it as an ordinary
  attachment; the page then sends it as a message with that file. "Powered by GIPHY" is required by GIPHY.
  Tenor was the other option, but Google shut its API down on 2026-06-30.
- Link previews (server.py, "Link previews"): after a message with a link goes out, a background task fetches
  the first link's page, reads its Open Graph tags and saves a card in `link_previews` (one per message) with a
  shrunk WebP copy of its picture in `uploads/previews/` (served at `/previews/<name>` to whoever can see the
  message); then a "preview" WebSocket message adds it. Against SSRF: http/https on ports 80/443 only, every
  address of the host must be public (`ipaddress.is_global`), we connect to the checked address ourselves (no
  DNS rebinding), redirects checked by hand (3 at most), 5 s timeouts, 1 MB HTML, 5 MB pictures, 10 previews per
  person per minute. Not for links in `code`, not on edits.
- The test suite (since 2026-10-18; README "Running the tests"): `tests/`, run by `test.ps1` (pytest, in
  `requirements-dev.txt`; `pytest.ini`). `conftest.py` starts a real uvicorn server on port 8011 with a temporary
  DATABASE_FILE/UPLOAD_DIR, REQUIRE_INVITE=1, no keys (SECRETS stripped, FIREBASE_KEY_FILE pointed nowhere, test
  LiveKit/VAPID values); the owner registers first; `server.person()` = invite + register + the /verify link read
  from the server's printed emails (its log). `Socket.wait_for/nothing/drain/join/say`; fixtures `channel` (made
  and deleted: max 50) and `friends`; `cf-connecting-ip` varies per person for the per-IP limits. **Black-box
  only: never import server.py**, so the suite proves a refactor (the planned split into modules) changed nothing.
  Files by area: accounts, admin, messages, channels, people, files, voice, misc (~170 tests, ~1.5 min). Connections
  start with state messages ("unread", "mutes", "pinned_chats"...): `drain()` before expecting an answer. Run it after
  every server change; add tests with features and fixes.
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
- `.env.example`: template for `.env` (SECURE_COOKIES, the keys). `.env` itself is never committed.
  The git-ignored development files have theirs too: `dev-secrets.env.example` (GIPHY_API_KEY for start.ps1)
  and `dev-chattus.env.example` (chattus.ps1 -Dev). `dev.env` has no secrets, so it's committed as it is.
- Settings → Admin (settings.js, "Admin"; only for `amAdmin()`): one tab ("Admin (n)": open bug reports) whose
  page has sub-tabs (`.admin-tab`, `showAdminSection`) for the sections Inbox, Channels, Roles and Invites
  (everyone's open links with ×, and who joined with whose: `GET /admin/invites`, `/admin/invites/{code}/cancel`,
  `logged_in_admin`). New admin tools go there as another section.
- Bans and the owner (server.py, "Bans and admins"; people.js "Banning"; settings.js "Admin → Bans/Admins"):
  `users.is_owner` (the first account, set in /register's INSERT like is_admin; older servers: the oldest
  non-bot admin), `banned_at`/`banned_until` (NULL = for good; 1, 7 or 30 days)/`banned_by`/`ban_reason`.
  `BANNED_NOW` (SQL) is checked by `session_user` (so banned = logged out), `users_message` (out of the lists)
  and `ban_message` (/login's answer, after the password). `/admin/ban` (`ban_refusal`: not yourself, bots or
  the owner; admins only by the owner; also takes admin away) deletes sessions and open invites, removes
  them from LiveKit rooms (`remove_from_voice`, RoomService/RemoveParticipant with a roomAdmin JWT) and
  closes their pages; `/admin/unban`, `/admin/bans`; `/admin/admins` (owner only). Page: Ban… in the user
  menu (`mayBan`), #ban-dialog, Settings → Admin → Bans and Admins (the owner's sub-tab).
- Invites and email verification (server.py, "Invites" and "Email verification"; since 2026-10-14, replacing the
  old INVITE_CODE): `/register` needs an unused invite (`invites`: code, created_by, used_by; one use,
  `INVITE_DAYS` 7, `MAX_OPEN_INVITES` 10 each), checked and used up in the same transaction as the INSERT, unless
  `REQUIRE_INVITE=0` (dev.env; serve.ps1 refuses it) or nobody has an account yet. `/invite/<code>` sets the HttpOnly
  cookie "invite" (a week) and redirects to the landing page (`https://LANDING_HOST/`, else /welcome; the user's wish:
  people read the features first), whose script asks `/invite-info` (CORS like /whoami) and shows "x invited you" +
  Create your account (`/login?register`). `invite_code` (an explicit code, else the cookie) is used by /invite-info
  and /register, which deletes the cookie; /invite-info's `given` lets login.html say "doesn't work any more". People page → Invite someone (#invite-dialog, people.js
  "Invites"). New accounts get `email_verified` 0 and a link (`email_verifications`, hashed token + the address,
  `VERIFY_HOURS` 24); `user_id_from_token` only accepts verified accounts, so an unverified one is "logged out"
  everywhere except static/verify.html (`/verify-email`, `/verify/status`, `/verify/resend`, `/verify/change`;
  `/` and `/login` redirect there) and missing from `users_message`. Existing accounts and bots count as verified
  (the column's DEFAULT 1). Settings' new email waits in `pending_email` until its link is clicked (then the old
  address gets the security notice). 5 verification emails per account per 15 min (`verify:<id>` in `failures`).
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
  Since 0.1.21 the chat window starts hidden (window-state restores everything but VISIBLE) behind a small
  undecorated `desktop/ui/loading.html` (the cat, "Starting ChatApp…", a sliding bar); main.rs `show_chat` shows it
  and closes the loading window when the page invokes `page_ready` (core.js `tellAppReady`: after the first
  "history", or "users" on the People page/Lounge), after 10 s at the latest, never over an update window.
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
- `static/download.html`: the download page (`/download`, no login), linked from the login page, the landing
  page and the banner above the chat (only in browsers on Windows, notifications.js); not from Settings (removed
  2026-10-14). No Windows app on phones (the user's rule): login.html's `.windows-app-link` says "Get the Android app"
  on Android (`data-android`) and goes on iPhones; the landing page advertises both apps (the user's wish: buttons at
  the top and a "Get the apps" section with a card each), `data-app="windows|android|any"`: Android phones keep only
  Android's, iPhones none. `/download/windows` always redirects to the newest installer.
- `static/landing/`: the landing page (`index.html`, `logo.png` from `icon/chattuschattus_square.png`,
  `screenshot.png`), served at `/` when the Host is `LANDING_HOST` (datslok.no) and always at `/welcome`;
  `{{CHAT}}` in it becomes PUBLIC_URL (server.py, `landing_page`). Its pictures are under `/landing/`.
  The screenshot is of a throwaway server with test accounts (never the real chat): `tools/make_screenshot.py` (port
  8009, a temporary db; accounts with emoji pictures, statuses incl. alex's, activities, roles, the Lounge, a #general
  conversation with LaTeX, a reply, reactions, a custom emoji, a spoiler, code, Chattus's poll; Edge headless over the
  DevTools protocol, 1440x800 at 2x; the Windows banner and What's new dot closed via localStorage: the user's wish). `/login?register`
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
  Push to talk (voice.js, "Push to talk"; voice-settings.js "Input mode"; not on phones): `inputMode` "ptt" sends the
  gate `{ptt, talking}` and the key opens it instead of the line (same 0.3 s hold). The key is kept as `pttKey`
  (event.code, or "Mouse1/3/4"), `pttWindowsKey` (event.keyCode = Windows' virtual-key code for the layout) and
  `pttName`. With focus, the page's own key events count (not letters typed in a text box; blur = released);
  without, the Windows app's: `set_push_to_talk` (main.rs, since 0.1.19) and a thread polling `GetAsyncKeyState`
  (user32, declared by hand; never RegisterHotKey, which would steal the key) every 15 ms, calling
  `pushToTalkFromApp(down)` on changes.
  The floating call window (since 2026-10-15, the user's wish, everywhere): in a call but looking at something else,
  `#call-float` (rooms.js, "The floating call window"; drawn from renderLoungeView, which every call or page change
  reaches, and from showSpeaking when someone else talks) is makeTile's tile of whoever talked last (`lastSpeakerId`;
  in a DM the other one), placed over #messages (or the page showing) in a corner, dragged with pointer events and
  snapped to the nearest corner (localStorage "callFloatCorner"); a click (capture phase, before makeTile's toggleFocus)
  opens the call. Phone: `mobile/src/CallFloat.js` (PanResponder + Animated, the capture variant so a tap stays the
  tile's; 160px 16:9 like the web's phone size; the corner in voice settings' floatCorner; above the text box).
  Speaking rings (voice.js, "Who's talking"): measured in the page, not LiveKit's ActiveSpeakersChanged (only
  loud voices, every 500 ms). rooms.js plugs an AnalyserNode into each remote microphone track
  (`setWebAudioPlugins`, before their volume); `checkSpeaking` every 50 ms: RMS over `SPEAKING_LINE` (-50 dB),
  held `SPEAKING_HOLD_MS`. Our own ring: the gate's `open` report (`gateOpen`), so it matches what we send.
- Activity (since app 0.1.20): `desktop/src-tauri/src/activity.rs` (the `windows` crate 0.62, Tauri's own version)
  looks at visible titled windows every 5 s: a game = a program under a game library folder (`GAME_FOLDERS`:
  steamapps\common, Epic Games, XboxGames, Riot Games, ...; the name is that folder's), Spotify's title "Artist - Song",
  or a program the user added (`list_programs`, by the file's FileDescription). Never other window titles. Calls the
  page's `activityFromApp` on changes; settings.js ("Activity", in App behaviour, hidden until `set_activity_settings`
  works) keeps `activitySettings` (share, on by default; programs) in localStorage and sends `{"type": "activity"}`
  (also at every connect, core.js). server.py: `clean_activity` (kinds playing/listening/using, 100 chars), kept on the
  connection (memory only), `activity_of` (None while shown offline) in "users" with "since"; announce_presences
  compares it too. people.js `activityText` replaces the status line in lists; the profile shows both, with
  `activityDuration`.
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
  Pictures: the target message's (first) picture and the newest one in the 5 messages before it (`attachments_to_show`),
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
  Searching the chat (only with Claude): a `search_chat` field (`CHAT_SEARCH_SCHEMA`: words, from) in
  `CLAUDE_ANSWER_SCHEMA`; `search_chat` (in ask_model's thread) hands `ask_server_search` to the event loop
  (`run_coroutine_threadsafe`; a Future per "ask" in `chat_searches`, completed by handle's "search_results"), the
  same WebSocket "search" as the page's 🔍. Privacy: the results are cut to the open channels (`open_channels`; he's
  in every private one, but #general mustn't hear #family) plus the chat he was asked
  in (never another DM or group of his, which he could read); up to `CHAT_SEARCH_RESULTS` 20 lines "[when] here/in
  #x, name: text" go in as a note, then ANSWER_SCHEMA.
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
  Pictures with Claude: all the target's and up to `CLAUDE_EARLIER_PICTURES` 3 in the `CLAUDE_PICTURE_LOOKBACK` 10
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
  The asker's device (since 2026-10-18, the user's wish): `messages.sent_from` ("android app", "windows app", "phone
  browser", "web browser"; server.py `device_of` from the connection's "looking": `android` (the phone app sends it),
  `app`, `mobile`), saved with each message and **sent to bots only** (`send()` strips it with `without_devices` for
  anyone whose connection isn't `bot`: messages, history/older/pins, search results, chat info items). chattus.py adds
  "(writing from the android app)" to the target's line; MANUAL_PROMPT says to give that device's way (the app's
  layout is in What's new, "On your phone"). Tested in tests/test_devices.py (conftest's `bot` fixture: make_bot.py).
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
