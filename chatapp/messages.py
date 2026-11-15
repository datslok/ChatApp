"""Messages: saving and editing them, replies, reactions, mentions, pins, search, the chat info panel,
unread counts, muting and the order of the Direct messages list."""

import json
import re

from chatapp.config import HISTORY_LIMIT, MAX_TEXT_LENGTH, SHOWN_TYPES
from chatapp.db import db, iso_time
from chatapp.sessions import is_admin
from chatapp.users import blockers_of, is_bot
from chatapp.access import can_join, group_members, is_dm_or_group, visible_chats
from chatapp.connections import clients, send
from chatapp.files import delete_upload, file_info, files_note
from chatapp.web import PREVIEW_DIR, message_links, preview_info


# ---------- Messages ----------


def save_message(channel, user_id, text, files, reply_to, kind=None, sent_from=None):
    """Save a message (files: claim_attachments' list, or empty; kind: None for a normal one, "call" for a
    call note; sent_from: the device it came from, see device_of). Returns its id and time, so the live
    message matches the history exactly."""
    # "with db" commits the change when the block ends (or undoes it if something fails).
    # The ? placeholders keep user text as data, so it can never be run as SQL.
    with db:
        cursor = db.execute(
            "INSERT INTO messages (channel, user_id, text, reply_to, kind, sent_from) VALUES (?, ?, ?, ?, ?, ?)",
            (channel, user_id, text, reply_to, kind, sent_from),
        )
        message_id = cursor.lastrowid  # the id SQLite gave it
        # Each file points at its message, in the order they were sent (enumerate counts 0, 1, 2...).
        for position, file in enumerate(files):
            db.execute("UPDATE attachments SET message_id = ?, position = ? WHERE id = ?",
                       (message_id, position, file["id"]))
    sent_at = db.execute("SELECT sent_at FROM messages WHERE id = ?", (message_id,)).fetchone()[0]
    return message_id, iso_time(sent_at)


REPLY_PREVIEW_LENGTH = 100


def reply_preview(original_id, user_id, name, text, has_files):
    """The small quote shown above a reply: who wrote the original, and the start of it."""
    if original_id is None:
        return None  # not a reply (or the original no longer exists)
    return {
        "id": original_id,
        "user_id": user_id,
        "name": name,
        # Cut to length, then drop a custom emoji token that got cut in half at the end ("<:1").
        "text": re.sub(r"<:\d*$", "", text[:REPLY_PREVIEW_LENGTH]),
        "file": bool(has_files),  # the page shows "Attachment" if there's no text
    }


def check_reply(reply_to, channel):
    """The id of the message being replied to, if it's valid: a number, of a message that exists
    *in this same channel*. (Otherwise anyone could quote a DM they can't see, just by guessing
    its id.) None if it isn't valid; the message is then sent as a normal one."""
    # bool is a kind of int in Python (True == 1), so it has to be ruled out separately.
    if not isinstance(reply_to, int) or isinstance(reply_to, bool):
        return None
    row = db.execute("SELECT id FROM messages WHERE id = ? AND channel = ?", (reply_to, channel)).fetchone()
    return row[0] if row else None


def live_reply_preview(original_id):
    """The quote for a reply that's being sent right now (the history gets it from its JOIN instead)."""
    if original_id is None:
        return None
    row = db.execute(
        """
        SELECT messages.id, messages.user_id, COALESCE(users.username, messages.legacy_name),
               messages.text, EXISTS (SELECT 1 FROM attachments WHERE attachments.message_id = messages.id)
        FROM messages LEFT JOIN users ON users.id = messages.user_id
        WHERE messages.id = ?
        """,
        (original_id,),
    ).fetchone()
    return reply_preview(*row) if row else None  # *row: the row's five values as five arguments


def reactions_for(message_ids):
    """The reactions on several messages: {message_id: [{"emoji": "👍", "user_ids": [1, 2]}, ...]}.
    One query for all of them, not one per message: running a query for each of 50 messages
    is so common (and slow) that it has a name, the "N+1 problem"."""
    result = {message_id: [] for message_id in message_ids}
    if not message_ids:
        return result
    placeholders = ",".join("?" * len(message_ids))  # "?,?,?" : one ? per id
    rows = db.execute(
        f"SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN ({placeholders}) "
        "ORDER BY created_at, rowid",  # oldest first, so the first emoji used comes first
        list(message_ids),
    )
    by_message = {}  # {message_id: {emoji: [user ids]}}; dicts keep the order things were added in
    for message_id, emoji, user_id in rows:
        by_message.setdefault(message_id, {}).setdefault(emoji, []).append(user_id)
    for message_id, emojis in by_message.items():
        result[message_id] = [{"emoji": emoji, "user_ids": user_ids} for emoji, user_ids in emojis.items()]
    return result


def files_for(message_ids):
    """The files of several messages, in order: {message_id: [file_info, ...]} (an empty list: none).
    One query for all of them, like reactions_for."""
    result = {message_id: [] for message_id in message_ids}
    if not message_ids:
        return result
    placeholders = ",".join("?" * len(message_ids))
    rows = db.execute(
        f"SELECT message_id, id, filename, size, content_type, audio FROM attachments WHERE message_id IN ({placeholders})"
        " ORDER BY message_id, position",
        list(message_ids),
    )
    for message_id, file_id, filename, size, content_type, audio in rows:
        result[message_id].append(file_info(file_id, filename, size, content_type, audio))
    return result


def with_files(message, files):
    """Put a message's files in it: "files", the list, and "file", the first one (or None), which the
    phone apps from before several files per message (2026-10-18) still read."""
    message["files"] = files
    message["file"] = files[0] if files else None
    return message


# Everything the page needs about messages, for the history and for the pinned list (each adds its
# own WHERE and ORDER BY). LEFT JOINs: each message, plus its sender's *current* username.
# COALESCE(a, b) means "a, or b if a is NULL": for messages from before accounts existed, there's no
# user, so we show the name that was typed back then. (The files come separately: files_for.)
#
# For replies, the messages table is joined with *itself*: "original" is a second copy of it
# (an alias), holding the message being replied to, and "original_sender" its sender; EXISTS (...) is
# 1 if the original has any file. And its link preview, if it got one (link_previews).
MESSAGES_QUERY = """
    SELECT messages.id, messages.sent_at, messages.edited_at, messages.reply_to, messages.kind,
           messages.pinned_at, messages.sent_from, messages.user_id, COALESCE(users.username, messages.legacy_name), messages.text,
           link_previews.url, link_previews.site, link_previews.title, link_previews.description,
           link_previews.image,
           original.id, original.user_id, COALESCE(original_sender.username, original.legacy_name),
           original.text, EXISTS (SELECT 1 FROM attachments WHERE attachments.message_id = original.id)
    FROM messages
    LEFT JOIN users ON users.id = messages.user_id
    LEFT JOIN messages AS original ON original.id = messages.reply_to
    LEFT JOIN users AS original_sender ON original_sender.id = original.user_id
    LEFT JOIN link_previews ON link_previews.message_id = messages.id
"""


def message_dicts(rows):
    """Rows from MESSAGES_QUERY in the same shape as live messages."""
    reactions = reactions_for([row[0] for row in rows])  # all the reactions, in one query
    files = files_for([row[0] for row in rows])  # and all the files, in another
    return [
        with_files({
            "id": message_id,
            "sent_at": iso_time(sent_at),
            "edited_at": iso_time(edited_at) if edited_at else None,
            "user_id": user_id,  # None for messages from before accounts existed
            "name": name,
            "text": text,
            # A reply whose original has been deleted: reply_to is still set, but the JOIN found nothing.
            "reply": reply_preview(*rest[5:]) or ({"id": reply_to, "deleted": True} if reply_to else None),
            "reactions": reactions[message_id],
            "kind": kind,  # None, "call" for a call note, "pin" for a pin note
            "pinned": pinned_at is not None,
            "preview": preview_info(*rest[:5]) if rest[0] else None,  # rest: the preview, then the original
            "sent_from": sent_from,  # (bots only: send() takes it out for everyone else)
        }, files[message_id])
        for (message_id, sent_at, edited_at, reply_to, kind, pinned_at, sent_from, user_id, name, text,
             *rest) in rows
    ]


def recent_messages(channel, before=None):
    """The channel's newest messages, oldest first, in the same shape as live messages.
    With `before` (a message id): the newest ones *older* than that message instead, for
    scrolling up. Ids only ever grow, so "older" simply means "a smaller id"."""
    rows = db.execute(
        MESSAGES_QUERY + " WHERE messages.channel = ? AND messages.id < ? ORDER BY messages.id DESC LIMIT ?",
        # No `before`: SQLite's biggest whole number, so the condition lets every message through.
        (channel, before if before is not None else 2**63 - 1, HISTORY_LIMIT),
    ).fetchall()
    rows.reverse()  # we fetched newest-first; chat reads oldest-first
    return message_dicts(rows)


# Jumping to an old message (a search result, a pin, a reply's quote): instead of loading older
# batches until it's there (slow: 40 trips and a redraw each), the page asks for the messages around it
# and shows that stretch of the chat on its own. Scrolling down from there loads newer batches until it
# reaches the present again.
AROUND_EACH_SIDE = 25  # messages before and after the one jumped to


def messages_around(channel, message_id):
    """The stretch of a channel around one message, oldest first: up to AROUND_EACH_SIDE before it, the
    message itself (if it still exists) and up to AROUND_EACH_SIDE after it. Also whether there may be
    more above ("more") and below ("newer"): a full side means there may be."""
    before = db.execute(
        MESSAGES_QUERY + " WHERE messages.channel = ? AND messages.id < ? ORDER BY messages.id DESC LIMIT ?",
        (channel, message_id, AROUND_EACH_SIDE),
    ).fetchall()
    before.reverse()
    after = db.execute(  # the message itself and the ones after it (one more than a side, for itself)
        MESSAGES_QUERY + " WHERE messages.channel = ? AND messages.id >= ? ORDER BY messages.id LIMIT ?",
        (channel, message_id, AROUND_EACH_SIDE + 1),
    ).fetchall()
    newer = len([row for row in after if row[0] != message_id]) == AROUND_EACH_SIDE
    return message_dicts(before + after), len(before) == AROUND_EACH_SIDE, newer


def newer_messages(channel, after):
    """The HISTORY_LIMIT messages just after message `after`, oldest first (scrolling down from a jump)."""
    rows = db.execute(
        MESSAGES_QUERY + " WHERE messages.channel = ? AND messages.id > ? ORDER BY messages.id LIMIT ?",
        (channel, after, HISTORY_LIMIT),
    ).fetchall()
    return message_dicts(rows)


MAX_PINS = 100  # pinned messages per channel, DM or group (Discord allows 50)


def pinned_messages(channel):
    """A channel's pinned messages, the most recently pinned first."""
    rows = db.execute(
        MESSAGES_QUERY + " WHERE messages.channel = ? AND messages.pinned_at IS NOT NULL"
        " ORDER BY messages.pinned_at DESC, messages.id DESC",
        (channel,),
    ).fetchall()
    return message_dicts(rows)


# ---------- Chat info (a DM's or group's Media, Links and Files tabs) ----------
#
# Clicking a DM's or group's name opens a panel with tabs (the page's chat-info.js; the phone's
# ChatInfoScreen.js). Members and Pins come from what the page already has and from "pins"; these three
# are asked for here: {"type": "chat_info", "tab": "media", "before": null}. The newest CHAT_INFO_BATCH
# messages with a picture or video ("media"), another file ("files") or a link ("links"; each with its
# "links"), newest first. `before` (a message id) pages on, like scrolling up in the chat: ids only grow,
# so "older" is "a smaller id". Only for the chat the connection is in, so can_join is the one gate.

CHAT_INFO_BATCH = 50
CHAT_INFO_TABS = {"media", "files", "links"}


def chat_info(channel, tab, before=None):
    """One batch of a chat's media, files or links: {"items": [messages], "more": True if there may be
    more, "oldest": the id to ask `before` next}."""
    shown = ", ".join("?" * len(SHOWN_TYPES))  # one "?" per type: "?, ?, ?" (the types go in as values)
    # A message with any file of the kind (it may have others too: the page picks out the right ones).
    has_file = "EXISTS (SELECT 1 FROM attachments WHERE attachments.message_id = messages.id AND attachments.content_type"
    if tab == "media":
        what, values = f"{has_file} IN ({shown}))", list(SHOWN_TYPES)
    elif tab == "files":
        what, values = f"{has_file} NOT IN ({shown}))", list(SHOWN_TYPES)
    else:  # links: a quick first look in SQL, then message_links finds the real ones
        what, values = "(messages.text LIKE '%http://%' OR messages.text LIKE '%https://%')", []
    rows = db.execute(
        MESSAGES_QUERY + f" WHERE messages.channel = ? AND messages.id < ? AND messages.kind IS NULL AND {what}"
        " ORDER BY messages.id DESC LIMIT ?",
        # No `before`: SQLite's biggest whole number, so every message gets through (like recent_messages).
        [channel, before if before is not None else 2**63 - 1, *values, CHAT_INFO_BATCH],
    ).fetchall()
    items = message_dicts(rows)
    if tab == "links":
        for item in items:
            item["links"] = message_links(item["text"])
        # ("https://" only inside `code`: no links after all. It still counts for "more": it was a row.)
        items = [item for item in items if item["links"]]
    # oldest: the next batch's `before` (the last row's id, even if links left it out).
    return {"items": items, "more": len(rows) == CHAT_INFO_BATCH, "oldest": rows[-1][0] if rows else None}


MAX_SEARCH_RESULTS = 50
MAX_SEARCH_WORDS = 10


def search_messages(user_id, text, chat=None, author=None):
    """The newest messages (at most MAX_SEARCH_RESULTS) this person can see with every word of `text`,
    each also as the start of a longer word ("hunt" finds "hunter2"); in one chat or in all of them,
    from anyone or from one person. Like the history, plus each message's "channel". Text or author
    may be left out, not both."""
    words = re.findall(r"\w+", text)[:MAX_SEARCH_WORDS]  # letters and digits only: no FTS5 syntax gets in
    chats = visible_chats(user_id)  # never anything else: someone else's DM stays out of reach
    if chat is not None:
        chats = [chat] if chat in chats else []
    if not chats or (not words and author is None):
        return []
    conditions = [f"messages.channel IN ({','.join('?' * len(chats))})", "messages.kind IS NULL",  # (no notes)
                  # nor anything from someone we blocked (the page hides those too). "IS NULL OR": in SQL,
                  # NULL NOT IN (...) isn't true, so messages from before accounts existed would vanish.
                  "(messages.user_id IS NULL OR messages.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?))"]
    params = [*chats, user_id]
    if words:
        # '"pizza"* "fred"*': every word must be there ("..." keeps it a plain word, * = or longer).
        conditions.append("messages.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)")
        params.append(" ".join(f'"{word}"*' for word in words))
    if author is not None:
        conditions.append("messages.user_id = ?")
        params.append(author)
    rows = db.execute(
        MESSAGES_QUERY + " WHERE " + " AND ".join(conditions) + " ORDER BY messages.id DESC LIMIT ?",
        (*params, MAX_SEARCH_RESULTS),
    ).fetchall()
    found = message_dicts(rows)
    if found:
        # Which chat each one is in (the page shows it, and Jump goes there).
        ids = [message["id"] for message in found]
        chat_of = dict(db.execute(f"SELECT id, channel FROM messages WHERE id IN ({','.join('?' * len(ids))})", ids))
        for message in found:
            message["channel"] = chat_of[message["id"]]
    return found


def parse_json(raw):
    """Turn raw text from a client into a dict, or None if it isn't a JSON object.

    Never trust what clients send: anyone can connect to /ws with their own script.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return data


def clean_text(data):
    """Get the message text out of a client's "message" (maybe empty), or None if it's invalid.

    The sender is NOT taken from here; it comes from their login session.
    """
    text = data.get("text")
    if not isinstance(text, str):
        return None
    text = text.strip()
    if len(text) > MAX_TEXT_LENGTH:
        return None
    return text


# ---------- Mentions (@name, @everyone) ----------

# "@kari" in a message: an @ at the start or after a space ((?<!\S) = "not right after a non-space"),
# so email addresses like me@gmail.com stay text. Then a username's characters.
MENTION_CODE = re.compile(r"(?<!\S)@([A-Za-z0-9_-]{1,32})")


def expand_mentions(text):
    """Turn "@kari" into <@2> (her user id) and "@everyone" into <@everyone>, like custom emoji:
    by id, so a renamed person's old mentions show their new name. Returns the new text,
    the ids mentioned by name, and whether @everyone was used."""
    ids = {name.lower(): user_id for user_id, name in db.execute("SELECT id, username FROM users")}
    mentioned = set()
    everyone = False

    def replace(match):
        nonlocal everyone  # (lets this inner function change `everyone` from the outer one)
        name = match[1].lower()
        if name == "everyone":
            everyone = True
            return "<@everyone>"
        if name in ids:
            mentioned.add(ids[name])
            return f"<@{ids[name]}>"
        return match[0]  # not a user: stays text

    return MENTION_CODE.sub(replace, text), mentioned, everyone


def save_mentions(message_id, channel, sender_id, mentioned, everyone):
    """Remember who a message mentions (replacing what was there, for edits). Only people who can
    see the channel, and never the sender themselves. @everyone = everyone who can see it.
    A bot named in a DM counts too: its mention is what invites it in (see bot_invited)."""
    invited = {user_id for user_id in mentioned if channel.startswith("dm:") and is_bot(user_id)}  # (by name: not @everyone)
    named = set(mentioned)  # the people named in it (@kari), before @everyone and DMs add the rest
    if everyone:
        mentioned = {user_id for (user_id,) in db.execute("SELECT id FROM users")}
    if channel.startswith("dm:"):
        # In a DM, every message counts as mentioning the other person (like Discord): it gets a
        # red number and a notification. "dm:3:7" -> both ids; the sender is left out below.
        mentioned = set(mentioned) | {int(part) for part in channel.split(":")[1:]}
    elif channel.startswith("g:"):
        # A group DM: the same, for every member but a bot (Chattus only wants his @mentions there).
        mentioned = set(mentioned) | {member for member in group_members(channel) if not is_bot(member)}
    people = [user_id for user_id in mentioned
              if user_id != sender_id and (can_join(channel, user_id) or user_id in invited)]
    # Who muted this chat only hears about it when named in it, or when an admin wrote it (admins
    # can't be muted). Leaving them out here means no red count, notification or push for them.
    if not is_admin(sender_id):
        muted = {user_id for (user_id,) in db.execute("SELECT user_id FROM chat_mutes WHERE channel = ?", (channel,))}
        people = [user_id for user_id in people if user_id not in muted or user_id in named]
    blockers = blockers_of(sender_id)  # who blocked the sender never hears from them
    people = [user_id for user_id in people if user_id not in blockers]
    with db:
        db.execute("DELETE FROM mentions WHERE message_id = ?", (message_id,))
        db.executemany(  # executemany: the same INSERT once for each item in the list
            "INSERT INTO mentions (message_id, user_id) VALUES (?, ?)", [(message_id, user_id) for user_id in people]
        )
    return people


def unread_mentions(user_id, channel=None):
    """How many unread messages mention this user, per channel: {"memes": 2, ...}.
    Unread = newer than the last message they've seen there (last_read), like the unread dots."""
    rows = db.execute(
        """
        SELECT messages.channel, COUNT(*)
        FROM mentions
        JOIN messages ON messages.id = mentions.message_id
        LEFT JOIN last_read ON last_read.user_id = mentions.user_id AND last_read.channel = messages.channel
        WHERE mentions.user_id = ? AND messages.id > COALESCE(last_read.message_id, 0)
        GROUP BY messages.channel
        """,
        (user_id,),
    )
    counts = {name: count for name, count in rows if can_join(name, user_id)}
    return counts if channel is None else {channel: counts.get(channel, 0)}


# ---------- Deleting a whole chat ----------

def delete_messages_in(key):
    """Delete every message in a channel or group, with its reactions, mentions, previews and files,
    and everyone's read marker there. (For a deleted channel, and a group its last member left.)"""
    files = [file for (file,) in db.execute("SELECT id FROM attachments WHERE channel = ?", (key,))]
    previews = [image for (image,) in db.execute(
        "SELECT image FROM link_previews WHERE image IS NOT NULL"
        " AND message_id IN (SELECT id FROM messages WHERE channel = ?)", (key,))]
    # Everything that belongs to its messages, then the messages, in one transaction: all or nothing.
    with db:
        for table in ("reactions", "mentions", "link_previews"):
            db.execute(f"DELETE FROM {table} WHERE message_id IN (SELECT id FROM messages WHERE channel = ?)", (key,))
        db.execute("DELETE FROM messages WHERE channel = ?", (key,))
        db.execute("DELETE FROM attachments WHERE channel = ?", (key,))
        db.execute("DELETE FROM last_read WHERE channel = ?", (key,))
        db.execute("DELETE FROM chat_mutes WHERE channel = ?", (key,))
        db.execute("DELETE FROM pinned_chats WHERE channel = ?", (key,))
    # The files on disk, only once the database change has been saved (as for one message).
    for file in files:
        delete_upload(file)
    for image in previews:
        (PREVIEW_DIR / image).unlink(missing_ok=True)


# ---------- Muting ----------
#
# Anyone can mute a chat (channel, DM or group) for themselves: no unread dot (the page), and no
# notifications, red counts or pushes, except when they're named in a message, or an admin wrote it
# (save_mentions). Admins can't be muted: a DM with an admin can't be muted at all.

def mutes_message(user_id):
    """Someone's muted chats, for their pages: {"type": "mutes", "channels": ["memes", "dm:3:7"]}."""
    rows = db.execute("SELECT channel FROM chat_mutes WHERE user_id = ?", (user_id,))
    return {"type": "mutes", "channels": [channel for (channel,) in rows]}


# ---------- Recent and pinned DMs ----------
#
# The Direct messages list (the sidebar, on the web page and the phone) is sorted by when each DM or group
# last had a message, newest first, with the ones someone pinned on top. The pages learn the newest message
# id of each of their DMs and groups at connect ("chat_activity" with all of them), and after each new
# message in one ("chat_activity" with that one, to every member's pages, their own other devices too).
# Ids only grow, so a bigger id is a more recent chat: no times needed. Pins are kept per person, like mutes.


def chat_activity_message(user_id):
    """{"type": "chat_activity", "chats": {"dm:3:7": 512, "g:5f3a9b21": 498}}: the newest message in each of
    this person's DMs and groups (those without messages are left out: they go at the bottom)."""
    rows = db.execute(
        "SELECT channel, MAX(id) FROM messages WHERE channel LIKE 'dm:%' OR channel LIKE 'g:%' GROUP BY channel"
    )
    return {"type": "chat_activity", "chats": {channel: newest for channel, newest in rows if can_join(channel, user_id)}}


async def announce_chat_activity(channel):
    """A new message in a DM or group: every member's pages move it up their list."""
    if not is_dm_or_group(channel):
        return
    newest = db.execute("SELECT MAX(id) FROM messages WHERE channel = ?", (channel,)).fetchone()[0]
    if newest is None:
        return
    update = {"type": "chat_activity", "chats": {channel: newest}}
    for websocket, client in list(clients.items()):
        if can_join(channel, client["user_id"]):
            await send(websocket, update)


def pinned_chats_message(user_id):
    """Someone's pinned DMs and groups, for their pages: {"type": "pinned_chats", "channels": ["dm:3:7"]}."""
    rows = db.execute("SELECT channel FROM pinned_chats WHERE user_id = ?", (user_id,))
    return {"type": "pinned_chats", "channels": [channel for (channel,) in rows]}


# ---------- Unread ----------

def mark_read(user_id, channel):
    """Remember that this user has now seen everything in this channel."""
    newest = db.execute("SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel = ?", (channel,)).fetchone()[0]
    # An "upsert": insert a new row, or if this user already has one for this channel,
    # update it instead. "excluded" means the values we just tried to insert.
    with db:
        db.execute(
            """
            INSERT INTO last_read (user_id, channel, message_id) VALUES (?, ?, ?)
            ON CONFLICT (user_id, channel) DO UPDATE SET message_id = excluded.message_id
            """,
            (user_id, channel, newest),
        )


def unread_channels(user_id):
    """Every channel and DM this user can see that has messages newer than the last one they saw."""
    # GROUP BY: one row per channel, with the newest message id in it.
    newest = dict(db.execute("SELECT channel, MAX(id) FROM messages GROUP BY channel"))
    seen = dict(db.execute("SELECT channel, message_id FROM last_read WHERE user_id = ?", (user_id,)))
    return [
        channel
        for channel, newest_id in newest.items()
        if newest_id > seen.get(channel, 0) and can_join(channel, user_id)
    ]


async def announce_new_message(channel, mentioned=(), message=None):
    """After a new message: it counts as read for whoever is looking at the channel, and
    everyone else who can see the channel gets an "unread" for it. People it mentioned also
    get their new count of unread mentions there, and a short preview for a notification."""
    await announce_chat_activity(channel)  # (a DM or group: up to the top of its members' lists)
    viewers = {client["user_id"] for client in clients.values() if client["channel"] == channel}
    for user_id in viewers:
        mark_read(user_id, channel)
    for websocket, client in list(clients.items()):
        if client["user_id"] not in viewers and can_join(channel, client["user_id"]):
            update = {"type": "unread", "channels": [channel]}
            if client["user_id"] in mentioned:
                update["mentions"] = unread_mentions(client["user_id"], channel)  # {"memes": 2}
                if message:
                    update["notify"] = {
                        "channel": channel,
                        "id": message["id"],  # so clicking the notification can jump to the message
                        "user_id": message["user_id"],
                        "name": message["name"],
                        # The start of the text (a token cut in half at the end dropped), or a file.
                        "text": re.sub(r"<(:\d*|@\w*)?$", "", message["text"][:100]) or files_note(message["files"]),
                    }
            await send(websocket, update)
