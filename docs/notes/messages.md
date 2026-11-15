# Messages

How messages carry several files and how the picture viewer shows them; the order of the Direct messages list
and pinned DMs; muting chats; pinned messages and jumping to a message; and searching messages. For uploads,
thumbnails and videos themselves, see [files.md](files.md).

## Several files per message

Since 2026-10-18, the user's wish, like Discord.

### The database and the server

- `attachments.message_id` + `position`: one message, many attachments. The old `messages.attachment_id` was
  moved there and dropped by a migration.
- A message sends `files: [upload ids]`: 1 to `MAX_FILES_PER_MESSAGE` (10), all different. The old single `file`
  is still accepted.
- `claim_attachments` claims all of them or none, in one transaction.
- It comes back with `files: [file_info...]`, made by `files_for` (one query, like reactions_for).
- `with_files` also sets `file` = the first file, for phone APKs from before.
- Chat info's Media and Files tabs pick a message if it has any file of that kind; the pages then take only
  those files.
- `files_note` is the text for pushes and notifications (see [notifications.md](notifications.md)).

### The web page

- `sendTray` uploads all the files, then sends one message.
- messages.js `makeAttachments`: one picture or video is drawn as before. Several go through `makeMediaGrid`, a
  6-column grid of .media-tile: halves for 2 and 4, otherwise rows of three after a first row with the
  leftovers. Other files are links under it.

### The picture viewer (web)

`viewer.js` (#image-viewer), `openViewer(items, index, onJump)`:

- ‹ › and the arrow keys step between files, with "2 / 5".
- The file's link (makeFileLink) and Jump (from chat info: the whole Media tab).
- Videos too (see [files.md](files.md), "Our video player").
- Pictures zoom by CSS transform. `zoomAt` keeps the point under the mouse. Wheel, ctrl+wheel (= touchpad
  pinch), two-pointer pinch, double-click = real size, drag while zoomed; `clampPan` keeps it in bounds.

### The phone

See [phone-app.md](phone-app.md).

- MessageText.js `Attachments`/`MediaGrid` (videos as ▶ squares).
- `ImageViewer({files, index})` swipes between pictures (`ZoomablePicture` keyed per file, `scheduleOnRN`).
- connection.js `sendMessage(text, replyTo, files)`.

### Chattus

`attachments_to_show` counts files; with Claude it takes every picture of the target message (`on_target`). See
[chattus.md](chattus.md).

## Recent and pinned DMs

messages.py, "Recent and pinned DMs"; since 2026-10-16.

The Direct messages list mixes groups and DMs: pinned first, then newest message first. Chats with no messages
come last, alphabetically. It's sorted by:

- Web: people.js `sortedDmKeys`/`renderDmList`.
- Phone: chats.js `sortedDmKeys`, in Sidebar and ShareScreen.

"chat_activity" `{chats: {key: newest message id}}`:

- All of them at connect.
- Then one from `announce_new_message` (`announce_chat_activity`) to every member's pages.

Pinning:

- The `pinned_chats` table. `{"type": "pin_chat", "channel", "pinned"}` (DMs and groups only) sends
  "pinned_chats" to all their pages (also sent at connect).
- Where: the user menu's Pin DM, a group's Pin button (web #group-pin) / GroupMenu (phone; also a long press on a
  group in the sidebar).
- A pin icon on the row (`.dm-pin`), hidden under a red count.

## Muting

messages.py, "Muting".

- `chat_mutes` (user_id, channel), set over the WebSocket: `{"type": "mute", "channel", "muted"}` sends "mutes"
  to all their pages (also sent at connect).
- `save_mentions` leaves out people who muted the chat, unless they're named in it (`<@id>`) or the sender is an
  admin. So no red count, notification or push.
- **Admins can't be muted or blocked** (the user's rule): `can_mute` refuses a DM with an admin, and the page
  hides 🔔 there. (Blocking: [people.md](people.md).)
- Page: `mutedChats` (core.js) fades sidebar items (`.channel.muted`), without unread dots. 🔔/🔕 in the top bar
  (rooms.js).

## Pinned messages

### The server

- `messages.pinned_at` / `pinned_by` (NULL = not pinned).
- Anyone who can see a message (`can_join`) may pin or unpin it over the WebSocket:
  `{"type": "pin", "message_id", "pinned"}`. Never a note (`kind` set).
- `MAX_PINS` 100 per chat, else "pins_full".
- Everyone in the chat gets "pinned".
- A pin also saves a note: `kind` "pin", "📌 pinned a message.", `reply_to` the message. It's drawn like call
  notes.
- `{"type": "pins"}` answers with `pinned_messages(channel)`.
- `MESSAGES_QUERY` + `message_dicts` build both the history and that list, so every message has "pinned".

### The page

- 📌 in each message's hover bar, and in the top bar (#dm-header, now on every chat; the call button only in DMs
  and groups).
- #pins-dialog, with Jump and Unpin.

## Jumping to a message that isn't loaded

Since 2026-10-29. Before, it loaded 40 older batches with a full redraw each, which lagged.

- `{"type": "around", "id"}` answers "around" (messages.py `messages_around`: `AROUND_EACH_SIDE` 25 messages
  each side, with `more`/`newer`). It replaces what's shown with that stretch.
- `atPresent` is then false (web core.js; phone connection.js) until `{"type": "newer", "after"}` batches reach
  the newest message. Those come from scrolling down; on the phone from `onStartReached`, with the inverted
  list's `maintainVisibleContentPosition`.
- Meanwhile live messages aren't drawn. They're in the database, so the batches bring them.
- ↓ (always shown then) and sending a message call `backToPresent` (a fresh "join").

## Search

### The index

`messages_fts` is an FTS5 index of `messages.text`:

- External content, `content_rowid='id'`, the unicode61 tokenizer with remove_diacritics.
- Filled once with 'rebuild', then kept in step by three triggers (insert, delete, update of text).

### Asking

The WebSocket `{"type": "search", "query", "channel" (or null: everywhere), "from" (a user id or null), "ask"}`
answers "search_results", with `ask` echoed. It's handled before core.js's channel filter.

`search_messages`:

- Only looks in `visible_chats` (channels, DMs with current friends, your own groups).
- Takes only `\w+` words (max 10), each as `"word"*`, so no FTS5 syntax gets through.
- Skips notes.
- Returns the newest 50 first, and adds each message's "channel".

### The page

- 🔍 in the top bar opens #search-dialog, which searches 300 ms after typing stops.
- Its results and the pinned list share `makeMessageCard`.
- Jump uses `openMessage`.
