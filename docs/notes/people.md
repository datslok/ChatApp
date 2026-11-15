# People

Group DMs, statuses (online, idle, do not disturb, invisible; phones; being away from the PC), blocking, and
activities (games, Spotify, programs) reported by the Windows app.

## Group DMs

Server code: groups.py, "Group DMs". Page code: people.js, "Group DMs".

### The data

- `group_dms`: the key is `g:` + 8 hex characters, and a name, or NULL = the members' names.
- `group_members`.
- A group's messages are saved under its key, so `can_join` (`is_group_member`) is the only gate.

### Routes

Groups have 3–10 people (`MAX_GROUP_SIZE`).

- `POST /groups`: make one with 2 or more of your friends.
- `/groups/{key}/add`: any member may add their own friends.
- `/rename`.
- `/leave`: the last one out deletes it all.

Members needn't be friends with each other. Anyone else gets a 404.

Each member's pages get `{"type": "groups"}`, at connect and after changes (`announce_groups`).

### Mentions and bots

- Every message counts as a mention for the other members, except bots. Chattus only answers @mentions in a
  group; `where()` describes the group to him (see [chattus.md](chattus.md)).
- Every bot is in every group: `create_group` adds them, and `add_bots_to_groups()` at every start fills in
  older groups and new bots.
- Bots never count as people (`group_people`): not for the size limit, the default name, or the last person
  out deleting it. They aren't offered in the page's friend picker.

### On the page

- + next to "Direct messages" opens #group-dialog with friend checkboxes.
- Groups come first in the DM list.
- #dm-header shows the members and Add people / Rename (prompt()) / Leave (confirm()) / 📞 Call.

## Statuses

Server code: presence.py, "Statuses".

### Chosen and shown status

- `users.presence` is the chosen one: online, idle, dnd or invisible.
- It's set over the WebSocket: `{"type": "presence"}` -> "my_presence" to all the person's pages. It's also in
  "welcome".
- "users" has each person's shown `presence` (online, idle, dnd or offline; invisible shows as offline) and
  `online` (not offline).
- The users' "status" field is still the line they write about themselves.

### Going idle

- Online turns idle after `IDLE_AFTER` (10 min) with every page out of sight (`away_since`, from "looking").
  Never for bots.
- `announce_presences` sends "users" only when a shown status changed. It's called by `watch_presences` (every
  30 s, started by the first connection) and by connects, disconnects, "looking" true and status changes.

### Do not disturb

dnd means `isMuted()` on every page and no pushes (`send_push`; see [notifications.md](notifications.md)).

### Phones

- "looking" carries `mobile` (notifications.js `onPhone`; never the Windows app).
- `on_phone_only` (every open page is a phone, and not offline) gives "users" a `mobile`.
- `makeDot(presence, mobile)` then draws `.dot.mobile`, a little phone.

Since 2026-10-16, the user's rule (PCs unchanged): Android cut a locked phone's connection at once, so the
person went grey. Now, in `device_presence`:

- A phone is online while looking.
- It's idle from the moment it's locked or left.
- It's gone after `PHONE_AWAY_FOR` (10 min), even if still connected. In voice it stays idle.
- `phones_away` keeps a phone whose connection closed while away (counting from its away_since). A
  reconnecting phone's "looking" takes it over.
- Each person shows their most present device.

### Away from the PC

Since 2026-11-15, the user's wish.

- The Windows app (0.1.28+) reports how long the PC has had no input: main.rs `seconds_idle` =
  GetLastInputInfo (see [desktop-app.md](desktop-app.md)).
- notifications.js `checkIdle` polls it every 15 s.
- Past the account's `users.idle_minutes`, "looking" carries `idle: true` -> `pc_idle`: that device is not
  looking and not `has_app_open` (so phones get pushes again), and it shows idle.
- The minutes come from `IDLE_MINUTES_CHOICES` (default 10). They're set with `POST /settings/idle` ->
  "idle_minutes", and are in "welcome". The setting is in Settings → Notifications on the web and the phone.

### On the page

- The picker in #me-popup (people.js, `renderPresencePicker`).
- Dots: `.dot.online/.idle/.dnd/.invisible`. Invisible is our own, drawn as a ring.

## Blocking

Server code: people.py, "Blocking".

### Server

- `blocks` (blocker_id, blocked_id).
- `POST /friends/block`: refused for admins and bots. It deletes the friendship row, so DMs, group invites and
  DM calls stop.
- `/friends/unblock`: they're not friends again; that takes a new request.
- "blocks" goes to the blocker's pages (also at connect).
- Neither side can send a friend request. The blocked one gets a neutral message.
- `save_mentions` drops the sender's blockers, `start_call` doesn't ring them, and `search_messages` skips
  blocked senders.

### On the page

- `blockedIds` (people.js).
- Their messages are drawn as "🚫 A message from someone you blocked · Show" (`shownBlocked`).
- Block / Unblock in `makeFriendButtons` (profile, Friends page), and a Blocked tab on the Friends page.

## Activity

Since Windows app 0.1.20: what someone is playing, listening to or using.

### In the Windows app

`desktop/src-tauri/src/activity.rs` (with the `windows` crate 0.62, Tauri's own version) looks at visible
titled windows every 5 s. It reports:

- A game: a program under a game library folder (`GAME_FOLDERS`: steamapps\common, Epic Games, XboxGames,
  Riot Games, ...). The name is that folder's.
- Spotify's title, "Artist - Song".
- A program the user added (`list_programs`, by the file's FileDescription).

Never other window titles. On changes it calls the page's `activityFromApp`.

### On the page

- settings.js ("Activity", in App behaviour; hidden until `set_activity_settings` works) keeps
  `activitySettings` (share, on by default; programs) in localStorage.
- It sends `{"type": "activity"}`, also at every connect (core.js).
- people.js `activityText` replaces the status line in lists. The profile shows both, with
  `activityDuration`.

### Server

presence.py:

- `clean_activity`: kinds playing/listening/using, 100 characters.
- Kept on the connection (memory only).
- `activity_of` (None while shown offline) goes in "users" with "since". announce_presences compares it too.
