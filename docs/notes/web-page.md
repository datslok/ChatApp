# The web page

How the chat's web page is built: its markup and scripts, appearance and loading, caching and reloads, what
it remembers per chat, the smaller pages (login, reset, download, landing), What's new, seasons, icons, emoji,
maths, and the parts of the page around the messages (member list, chat info, user menu, pickers).

## Files and load order

`static/index.html` is the chat page's markup. Its styles are in `static/css/chat.css`, its script in
`static/js/`. The scripts are plain scripts (not ES modules) sharing one global scope, loaded in this order:

| Order | File | What's in it |
|------:|------|--------------|
| 1 | `icon-shapes.js` | the line icons' shapes (see [Icons](#icons)) |
| 2 | `icons.js` | making and filling icons (see [Icons](#icons)) |
| 3 | `core.js` | elements, connecting, server messages, channels, sidebar |
| 4 | `notifications.js` | notifications, and every generated sound ([notifications.md](notifications.md)) |
| 5 | `ui.js` | drawers, back button, popups, text box, emoji autocomplete |
| 6 | `voice.js` | audio engine, mic, gate, volumes, who's in voice ([voice.md](voice.md)) |
| 7 | `video.js` | camera, screen sharing |
| 8 | `rooms.js` | joining/leaving, DM calls, call banner, Lounge page |
| 9 | `voice-settings.js` | voice settings |
| 10 | `settings.js` | Settings |
| 11 | `people.js` | DM/online lists, friends, profile popup, typing ([people.md](people.md)) |
| 12 | `video-player.js` | `makeVideoPlayer`: our own control bar for chat videos and the viewer's (see "Videos" in [files.md](files.md)) |
| 13 | `viewer.js` | the picture viewer (see "Several files per message" in [files.md](files.md)) |
| 14 | `chat-info.js` | the chat info panel (below) |
| 15 | `messages.js` | uploads, messages, reactions, replies, editing ([messages.md](messages.md)); ends with `start()` |

**Code that runs at load time may only use what earlier files declare.**

`appearance.js` is the exception: it alone is loaded in `<head>`, before anything is drawn (see below).

Every colour in chat.css is a variable in its `:root`, named by role.

## Appearance

`appearance.js` is Settings → Appearance: the theme (via `data-theme` on `<html>`), picked colours, `--font`
and the text size.

- Theme, colours and font are kept with the account: `users.appearance`, saved with `POST /settings/appearance`,
  checked against the lists in accounts.py. They come in "welcome" and are sent to all the user's pages.
- A copy is kept in localStorage for the first paint.
- Text size and scale are per device (since 2026-10-18, the user's wish). They live only in that localStorage
  copy: `applyAccountAppearance` keeps them when the server's settings arrive. (Phone: appearance.json, App.js;
  see [phone-app.md](phone-app.md).) The server ignores them, but keeps the old saved ones in users.appearance
  for pages from before.

## The loading cover

While the page loads, `#page-loading` covers it. It is index.html's first element: the logo and a bar that
slides by `transform`, because the compositor runs that animation while scripts load (animating `left` froze).
core.js `tellAppReady` fades it out, or it goes after 10 s.

## Caching and reloading on a new version

Both folders (`static/css/` and `static/js/`) are served with `Cache-Control: no-cache` (FreshStaticFiles), as
is `/`.

The server hashes the page's files at startup (`PAGE_VERSION`, sent in "welcome"). A page that reconnects to a
server with a different one reloads itself (core.js, `reloadIfOutdated`). It doesn't reload:

- in a call,
- with files in any tray,
- while sending or editing.

Every chat's text is kept through the reload in sessionStorage "drafts".

## The last open chat

Since 2026-10-16, each device remembers its own last chat (the user's choice).

- Web: core.js `switchChannel` saves localStorage "lastChat", and `lastChat()` reopens it at start (after a
  reload's history.state, which comes first). `stillThere` checks both.
- Phone: App.js writes `last-chat.txt` in go() and opens it after a live update's `restored`; the Lounge only
  as a page.

Chats that are gone (left groups, ex-friends, private channels) are left by the usual checks.

## Trays and drafts per chat

Each chat keeps its own tray and half-written text, like Discord (the user's wish, 2026-10-15).

- messages.js keeps `trays` / `drafts` by chat key; `tray` is the open chat's list.
- `switchDraft` (called by switchChannel) swaps them.
- `sendTray` stops if the chat changes mid-upload (messages go to the open chat).
- The phone app: App.js's `trays` / `drafts`, ChatScreen's `setTrayOf` / `setDraftOf`.

## Login and reset pages

- `static/login.html`: the login / create account page. `/login?register` opens it in register mode.
- `static/reset.html`: "forgot password" (asks for a reset link) and, with `?token=`, choosing a new password.

See [accounts.md](accounts.md) for what's behind them.

## What's new (changelog.json)

`static/changelog.json` is Settings → "What's new" (settings.js), written by hand. It has two parts:

- `features`: everything the chat can do, by topic, with how to use it.
- `changes`: newest day first.

They're shown in two `<details>` sections: Changes (open) and features (closed).

More lines in `changes` than localStorage "changelogSeenCount" puts a red dot on ⚙️ and the tab. The count is
saved when What's new opens; edited lines don't count.

**The rule: in the same commit as every feature friends would notice, add a line in `changes` (on the same day:
add to that day's entry) and update `features`.** Keep it short, for friends, with no technical details, and say
where things are, like "Settings → Notifications". Chattus reads `features` as the chat's manual (see
[chattus.md](chattus.md)).

changelog.json is part of `PAGE_VERSION`, so a changelog-only deploy reloads open pages.

## Seasons (the seasonal easter egg)

Server: pages.py, "Seasons". Page: people.js, "The seasonal easter egg".

- `SEASONS` lists each season: name, months, an emoji or an image, and a video. An image is worn like a hat
  (`.season-hat`); Christmas, in December, uses static/seasonal/santa-hat.svg, our own drawing.
- `current_season()` gives this month's season, but only if `seasonal/<video>` exists. It goes in "welcome" as
  `season`.
- The page puts its emoji on our own picture in #user-panel (`.season-badge`). That opens #season-dialog with
  the video (`/seasonal/<name>`: logged-in only, and only names from SEASONS).
- The panel's own picture is 32px (24 elsewhere).

The videos are git-ignored. They're copied to the server with `scripts/seasonal-upload.ps1`, and are included in
backup.ps1/export/import/backup-fetch (see [operations.md](operations.md)). Halloween's is "SpOwOky OwOky
Pumpkin Song", Christmas's "padowo padowo" (the user's own copies in `external/`).

## Icons

Since 2026-10-14 the page's buttons use line icons, not emoji.

- `static/js/icon-shapes.js` holds Lucide's shapes (lucide-static 1.48.0, ISC). It is written by
  `tools/make_icons.py`, which downloads the npm tarball, checks npm's integrity hash and copies the icons in its
  ICONS list. To add an icon: add its name there and rerun.
- `static/js/icons.js` (loaded before core.js) has `makeIcon(name)` and `setIcon(element, name)` (replaces an
  element's icon; adds "has-label" when there are words). At load it fills every `data-icon="name"` in index.html.
- `.icon` in chat.css: 1.2em, stroke currentColor 1.8.
- Toggles swap icons: mic/mic-off, headphones/headphone-off, bell/bell-off, maximize/minimize.
- The smiley (`makeSmileyIcon`) is our own.
- Emoji stay in OS notifications, server notes, What's new and anything people write.

### Icon colours

Plain icon buttons use `--icon` / `--icon-strong` (on hover), defaulting to --text-muted / --text-strong. A
button doesn't inherit the text colour by itself: without these they were the browser's dark ButtonText.

appearance.js `guardIconColours` (run in every applyAppearance) measures WCAG contrast against bg-panel-alt,
bg-panel, bg-main and bg-input. Below 3:1 it sets them to the first readable of text-soft/text, else white or
black.

## Emoji and country flags

`static/emoji.json` holds every emoji for the reaction picker, and is also the server's list of allowed
reactions. It's made from Unicode's `emoji-test.txt` by `tools/make_emoji_json.py`.

The page only offers the emoji the device can draw: messages.js `makeEmojiTester` draws each on a canvas in
black and in white (a colour emoji ignores the paint), and one wider than 1.5 emoji is a ZWJ sequence that fell
apart. So new emoji appear as fonts catch up.

Country flags: Segoe UI Emoji has none (it shows letters). So chat.css's `@font-face` "Twemoji Country Flags"
comes first in body's and `.emoji`'s fonts, with `unicode-range` limiting it to the flag characters.

- The font is in `static/flags-0.1.10/`: the woff2 + LICENSE from npm's country-flag-emoji-polyfill 0.1.10,
  checked against npm's integrity hash.
- It's served at `/flags-0.1.10/`, like KaTeX.
- The tester `document.fonts.load`s it first.

## Maths in messages

messages.js, `makeMath`.

- `$...$` is inline maths and `$$...$$` maths on its own line.
- Pandoc's rule keeps money as text: no space just inside the dollars, and no digit after the closing one.
- `\$` is a real dollar.

It's drawn by KaTeX: `static/katex-0.18.9/` (`katex.min.js`, `katex.min.css`, the woff2 fonts and LICENSE, from
npm's tarball, checked against npm's integrity hash). Served at `/katex-0.18.9/` with a week's caching
(`LastingStaticFiles`). Its defaults stay (trust off, so no `\href`; maxExpand), plus `maxSize: 20`.

## The right column (member list)

The right column (#members, people.js `renderMembers` / `chatMembers`) shows the chat's members:

- in a channel, everyone who sees it (written when all channels were open to everyone; since private
  channels and limited roles, `seesChannel` filters the list: see
  [channels-and-roles.md](channels-and-roles.md));
- in a DM, the two people;
- in a group, its members (bots too).

It's hidden on the People page and the Lounge. Everyone is on the People page's Everyone tab (with a filter
box).

The People page was the Friends page: its key (`FRIENDS`, "friends") and ids (#friends-view) keep the old name.

👥 in #dm-header (ui.js, since 2026-10-18) hides the column on wide screens: `#members.closed`, remembered in
localStorage "membersClosed".

## The chat info panel

Since 2026-10-18, the user's wish, like Discord. DMs and groups only (the user's choice).

The name in #dm-header is a button (disabled in channels, rooms.js) that opens the panel in #members
(`.info-open`, 340px). It shows even when 👥 closed the list; on phones it's the right drawer.

chat-info.js has these tabs:

- **Members**: #member-lists, renderMembers' lists.
- **Media**: a grid. A tile opens #image-viewer, which got #viewer-video and #viewer-jump for it.
- **Pins**: "pins", makePinnedItem.
- **Links** and **Files**: makeFileLink.

Jump = jumpToMessage.

core.js calls `chatInfoNews` on message/edited/deleted/preview/pinned (it reloads the tab if affected), and
`closeChatInfo` in joinCurrentChannel.

### Server side

WebSocket `{"type": "chat_info", "tab", "before"}` -> "chat_info" {items, more, oldest}. In messages.py,
"Chat info", `chat_info()`:

- MESSAGES_QUERY rows with SHOWN_TYPES attachments (Media), other attachments (Files), or http in the text
  (Links);
- 50 per batch;
- `message_links()` = every link, by first_link's rule;
- only for `is_dm_or_group` + can_join.

### Phone

`src/ChatInfoScreen.js`: full screen with Settings' tab row; Members.js, PinsScreen's cards, `FileAttachment`,
ImageViewer/VideoScreen with `onJump`. Videos are ▶ squares, with no first frame. It's opened by ChatTitle's
`onInfo` (popup "info", drawn by ChatScreen); connection.js has `watchChatInfo` ({batch, news}) /
`askChatInfo`. See [phone-app.md](phone-app.md).

## The scroll-down button

Since 2026-10-18. More than 1.5 views above the newest message, `#to-bottom` appears. It lives in #status-line,
placed above it, and the class "shown" fades it in. It scrolls #messages to the bottom (messages.js, "The
scroll-down button"); joinCurrentChannel hides it.

Phone: ChatScreen's `farUp`, from the inverted FlatList's onScroll offset, and `toBottom()`.

## Picking people

**The user's rule: anywhere you choose from what could be everyone (or many), use a type-to-search picker,
never a drop-down.**

- `usePersonPicker(input, list, {candidates, onPick, onType})` in people.js: used by search's "From" and
  Settings → Admin → Roles "+ Add someone".
- A multi-pick list (the group popup's friends) gets a search box on top that filters it
  (`filterGroupChoices`; ticked ones stay visible).

## The user menu

people.js, "The user menu". Right-click (a long press on phones) on anything with `data-user-menu="<id>"` opens
#context-menu. That's the message picture and name, the member list, the DM list, Friends page rows, call
tiles, pins/search card heads, and our own panel.

- It's built by `userMenuItems` from how we stand with them: Profile, Mention, Message, Call, friend actions,
  Mute DM, Block.
- No Block or Mute DM for admins, no Block for bots.
- There's one document-level "contextmenu" listener (event delegation).
- The menu moves into an open modal dialog or the fullscreen element; otherwise nothing outside those would show
  or be clickable.

## The download page

`static/download.html` is the download page (`/download`, no login). It's linked from:

- the login page,
- the landing page,
- the banner above the chat (only in browsers on Windows, notifications.js).

It's not linked from Settings (removed 2026-10-14). `/download/windows` always redirects to the newest
installer.

**No Windows app on phones (the user's rule):**

- login.html's `.windows-app-link` says "Get the Android app" on Android (`data-android`) and goes away on
  iPhones.
- The landing page advertises both apps (the user's wish: buttons at the top and a "Get the apps" section with
  a card each), marked `data-app="windows|android|any"`: Android phones keep only Android's, iPhones none.

## The landing page

`static/landing/` is the landing page: `index.html`, `logo.png` (from `icon/chattuschattus_square.png`) and
`screenshot.png`. It's served at `/` when the Host is `LANDING_HOST` (datslok.no), and always at `/welcome`.
`{{CHAT}}` in it becomes PUBLIC_URL (pages.py, `landing_page`). Its pictures are under `/landing/`.

### The screenshot

The screenshot is of a throwaway server with test accounts, never the real chat. `tools/make_screenshot.py`
makes it:

- port 8009, a temporary db;
- accounts with emoji pictures, statuses incl. alex's, activities, roles, the Lounge;
- a #general conversation with LaTeX, a reply, reactions, a custom emoji, a spoiler, code, Chattus's poll;
- Edge headless over the DevTools protocol, 1440x800 at 2x;
- the Windows banner and What's new dot closed via localStorage (the user's wish).

### Logged in to the chat?

The landing page asks `PUBLIC_URL/whoami` (name and picture only) with the cookie, and shows the name and
"Log out" (`POST /logout`). Both answer with CORS headers for exactly `https://LANDING_HOST`
(`allow_landing_page`). The cookie stays host-only; SameSite=Lax lets it through because datslok.no and
chat.datslok.no are the same site.
