# Channels and roles

Covers: `chatapp/channels.py`, `chatapp/access.py`

How channels and their headings are stored and managed, who sees which channel (private channels, limited
roles), roles with their colours and member lists, and hidden roles.

## Channels and headings

Server code: channels.py, "Channels".

### The `channels` table

- The `channels` table is one ordered list (`position`) of channels and headings.
- A heading has `heading` 1. It groups the channels below it until the next heading.
- Messages and everything else store a channel's `key`, which never changes. Renaming changes `name` only.
- The first three channels keep their old names as keys: general, memes and chattus. They're seeded when the
  table is empty.
- New channels get `c:` + 8 random hex characters as their key; new headings get `h:` + 8 random hex.

### Managing them (admins)

The routes are admin-only:

- `POST /channels`: create one (it goes at the bottom).
- `/channels/{key}/rename`.
- `/channels/order`: takes the whole list of keys.
- `/channels/{key}/delete`: deletes a channel with all its messages, files and previews. Never the last channel.

Every change sends `{"type": "channels"}` to every page. It's also sent at each connect. On the web page,
core.js `showChannels` redraws the sidebar, and a page that was in a deleted channel goes to the first one.

Settings → Admin → Channels (settings.js, admins only): each row is a small form (Enter or Save renames),
with ↑ ↓ to move it and 🗑 to delete it (with confirm()).

### Other uses

- `can_join` uses `is_channel`.
- Push notification titles use `channel_name` (see [notifications.md](notifications.md)).
- `delete_messages_in(key)` removes a channel's or group's messages with everything belonging to them.

## Private channels and limited roles

Since 2026-10-16. Made for the owner's parents: they should see only their DMs and #family.

### The data

- `channels.private`: the channel is private.
- `channel_roles` (channel, role_id): which roles may see a private channel.
- `roles.limited`: people with a limited role don't see open channels.

### Who sees what

`sees_channel` decides:

| Who                         | Sees                                                                  |
|-----------------------------|-----------------------------------------------------------------------|
| The owner                   | Every channel                                                         |
| Bots                        | Every channel (bots are never limited)                                |
| Other admins                | Like everyone else, by their roles (never limited)                    |
| Anyone, private channel     | Only if they have one of its roles                                    |
| Anyone, open channel        | Only if they're not limited                                           |

- Other admins don't see everything: the user's wish. They can still give themselves a role.
- A private channel with no role ticked, or whose role was deleted, is visible to the owner only. It never
  becomes public.
- Admins are never limited.

### Managing and listing

- Admins only manage the channels they see (`managed_channel`). Reordering moves only those, around the others.
- `can_join` -> `may_see_channel`.
- `visible_chats` and "channels" use `channel_list(user_id)`, which is per person. A heading with nothing
  under it is dropped. GET /channels needs a login now.
- "channels" has `lounge` (`may_use_lounge`). `may_join_voice` gates /voice-token and "voice". For people who
  may not use the Lounge, `voice_members_message(user_id)` is empty, as sent by `announce_voice_members`
  (see [voice.md](voice.md)).
- `announce_channels` sends each page its own list after channel, role, role-member, limited and admin
  changes. It sets a page's channel to None if the person lost it and takes them out of the Lounge
  (remove_from_voice).

### Admin routes and settings

- `POST /channels/{key}/access {private, roles}`.
- `/roles/{id}/limited {limited}`.
- In the settings: Private + role boxes under each channel row, and Limited under each role. Web: settings.js
  `makeChannelAccess`; phone: AdminSettings.js `ChannelAccess`.

### On the pages

- `seesChannel` (people.js; phone chats.js) filters a channel's member list.
- Someone with no channels lands on People.
- The Voice section is hidden for people who may not use the Lounge (`loungeAllowed`; phone
  `connection.lounge`, which is null until the first "channels").

## Roles

Server code: channels.py, "Roles".

### The data and routes

- `roles` (id, name, colour "#rrggbb", position) and `user_roles`.
- Admin-only routes:
  - `POST /roles`: create.
  - `/roles/{id}/edit`.
  - `/roles/order`: all ids.
  - `/roles/{id}/delete`.
  - `/roles/{id}/members`: ({user_id, member}).
- After each change, "roles" (the list, top first; at connect it's sent before "users") and "users" (each
  person's `roles`, top first) go to everyone.

### On the page

people.js:

- `topRole` / `nameColour` colour names in messages and lists.
- `showUsers` gives each role with people online a member list section (#role-sections, after Bots).
- The profile shows role tags.
- core.js redraws messages when the roles or anyone's roles change.

Settings → Admin → Roles (settings.js, admins): a colour picker, the name, ↑ ↓ 🗑, and the members with × and
"+ Add someone".

## Hidden roles

`roles.hidden`, set with `/roles/{id}/hidden`. The user's wish: nobody but admins should know the Parents role.

- `roles_message(user_id)` leaves hidden roles out for non-admins.
- `users_for` strips them from each person's roles. Every "users" goes through `announce_users`.
- So non-admins get a channel's `members` (for private channels) and each user's `limited` instead of role
  ids. "roles" in channel items is admin-only.
- `topRole` skips hidden roles on both pages (web and phone): no colour and no member list section, even for
  admins. Only the profile tag shows, and only to admins.
