# The phone app: messages, files and people

Covers: `mobile/src/Chat`, `mobile/src/Message`, `mobile/src/MathView.js`, `mobile/src/ImageViewer.js`, `mobile/src/PictureEditor.js`, `mobile/src/VideoScreen.js`, `mobile/src/ShareScreen.js`, `mobile/src/PinsScreen.js`, `mobile/src/SearchScreen.js`, `mobile/src/PeopleScreen.js`, `mobile/src/PersonPicker.js`, `mobile/src/Picker.js`, `mobile/src/GroupScreen.js`, `mobile/src/Members.js`, `mobile/src/UserMenu.js`, `mobile/src/ProfileScreen.js`, `mobile/src/InviteScreen.js`, `mobile/src/chats.js`, `mobile/src/files.js`, `mobile/src/format.js`, `mobile/src/friends.js`, `mobile/src/people.js`, `mobile/modules/downloads/`, `mobile/modules/shared-files/`

The native app's messages, pictures and files, sharing to the app, the chat's buttons, and people and groups. Setup, layout, the connection, settings and releases: [phone-app.md](phone-app.md); calls and push: [phone-calls.md](phone-calls.md).

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
    Since 2026-11-15 also MutualFriends (connection.js `mutualFriends`, asked again when `friends` changes;
    a tap calls App.js `openProfile`). See [people.md](people.md), "Mutual friends".
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
