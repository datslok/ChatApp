"""Who may see what: which channels someone sees (private channels and limited roles), group and DM
membership, and can_join, the one check every chat, message, file and call goes through. Only reads."""

from chatapp.db import db
from chatapp.sessions import is_admin
from chatapp.users import are_friends, friends_message, is_bot, is_owner, username_of


def visible_chats(user_id):
    """Every chat this person may read (see can_join): the channels, their DMs with friends, their groups."""
    chats = [item["key"] for item in channel_list(user_id) if not item["heading"]]
    chats += [f"dm:{min(user_id, friend)}:{max(user_id, friend)}" for friend in friends_message(user_id)["friends"]]
    chats += [key for (key,) in db.execute("SELECT group_key FROM group_members WHERE user_id = ?", (user_id,))]
    return chats


def channel_list(user_id=None):
    """The sidebar, top to bottom, as this person may see it (None: all of it):
    [{"key": "general", "name": "general", "heading": False, "private": False, "roles": []}, ...]
    "roles" (admins only, as roles can be hidden): the role ids that see a private channel. "members" (private
    channels): the ids of everyone who sees it (the owner and its roles' people), for the member list. A heading
    with nothing visible under it goes too."""
    rows = db.execute("SELECT key, name, heading, private FROM channels ORDER BY position").fetchall()
    roles_of = {}
    for channel, role_id in db.execute("SELECT channel, role_id FROM channel_roles"):
        roles_of.setdefault(channel, []).append(role_id)
    everywhere = {person for (person,) in db.execute("SELECT id FROM users WHERE is_owner = 1 OR is_bot = 1")}  # (in every channel)
    holders = {}  # role id -> its people
    for holder, role_id in db.execute("SELECT user_id, role_id FROM user_roles"):
        holders.setdefault(role_id, set()).add(holder)
    items = []
    for key, name, heading, private in rows:
        item = {"key": key, "name": name, "heading": bool(heading), "private": bool(private), "roles": roles_of.get(key, [])}
        if private:
            item["members"] = sorted(everywhere.union(*(holders.get(r, set()) for r in item["roles"])))
        items.append(item)
    if user_id is None or is_owner(user_id) or is_bot(user_id):
        return items if user_id is None or is_admin(user_id) else [{k: v for k, v in item.items() if k != "roles"} for item in items]
    mine, limited = role_ids_of(user_id), is_limited(user_id)
    shown = []
    for item in items:
        if item["heading"]:
            # Kept for now; dropped below if no channel of its own made it.
            if shown and shown[-1]["heading"]:
                shown.pop()
            shown.append(item)
        elif sees_channel(item["private"], item["roles"], mine, limited):
            shown.append(item)
    if shown and shown[-1]["heading"]:
        shown.pop()
    if is_admin(user_id):
        return shown
    return [{k: v for k, v in item.items() if k != "roles"} for item in shown]  # (the role ids: admins only)


def role_ids_of(user_id):
    return {role_id for (role_id,) in db.execute("SELECT role_id FROM user_roles WHERE user_id = ?", (user_id,))}


def is_limited(user_id):
    """Does this person have a limited role (only their private channels, no Lounge)? Never admins or bots."""
    if is_admin(user_id) or is_bot(user_id):
        return False
    row = db.execute("SELECT 1 FROM user_roles JOIN roles ON roles.id = user_roles.role_id"
                     " WHERE user_roles.user_id = ? AND roles.limited = 1", (user_id,)).fetchone()
    return row is not None


def sees_channel(private, channel_roles, my_roles, limited):
    """The rule (not for the owner, who sees all): a private channel needs one of its roles; an open one
    is for everyone not limited (admins never are)."""
    if private:
        return any(role_id in my_roles for role_id in channel_roles)
    return not limited


def may_see_channel(key, user_id):
    """May this person see this channel (which exists; see is_channel)?"""
    if is_owner(user_id) or is_bot(user_id):
        return True
    private = db.execute("SELECT private FROM channels WHERE key = ?", (key,)).fetchone()[0]
    roles = [role_id for (role_id,) in db.execute("SELECT role_id FROM channel_roles WHERE channel = ?", (key,))]
    return sees_channel(bool(private), roles, role_ids_of(user_id), is_limited(user_id))


def may_use_lounge(user_id):
    return not is_limited(user_id)


def is_channel(key):
    """Is this a channel that exists? (Headings aren't: nobody can join one.)"""
    if not isinstance(key, str):
        return False  # (the page could send anything as a channel, a list say)
    return db.execute("SELECT 1 FROM channels WHERE key = ? AND heading = 0", (key,)).fetchone() is not None


def channel_name(key):
    """A channel's name, for notifications ("kari in #memes"). Its key if it's gone."""
    row = db.execute("SELECT name FROM channels WHERE key = ?", (key,)).fetchone()
    return row[0] if row else key


def hidden_role_ids():
    return {role_id for (role_id,) in db.execute("SELECT id FROM roles WHERE hidden = 1")}


def group_members(key):
    """A group's members' ids, bots included, in the order they joined."""
    rows = db.execute("SELECT user_id FROM group_members WHERE group_key = ? ORDER BY rowid", (key,))
    return [user_id for (user_id,) in rows]


def group_people(key):
    """A group's members without the bots."""
    return [user_id for user_id in group_members(key) if not is_bot(user_id)]


def is_group_member(key, user_id):
    if not isinstance(key, str) or not key.startswith("g:"):
        return False
    row = db.execute("SELECT 1 FROM group_members WHERE group_key = ? AND user_id = ?", (key, user_id)).fetchone()
    return row is not None


def group_title(key):
    """What a group is called in notifications: its name, or its people's names ("axel, kari, ola")."""
    row = db.execute("SELECT name FROM group_dms WHERE key = ?", (key,)).fetchone()
    if row and row[0]:
        return row[0]
    return ", ".join(username_of(user_id) for user_id in group_people(key))


def is_dm_or_group(channel):
    return isinstance(channel, str) and (channel.startswith("dm:") or channel.startswith("g:"))


def can_mute(channel, user_id):
    """May this person mute this chat? Any they can see, except a DM with an admin."""
    if not can_join(channel, user_id):
        return False
    people = dm_people(channel)
    return people is None or not any(is_admin(person) for person in people if person != user_id)


BOT_INVITE_TIME = "-1 hour"  # how long a mention lets a bot into a DM (SQLite's way of writing it)


def dm_people(channel):
    """The two user ids of a DM's name ("dm:3:7" -> (3, 7)), or None if it isn't exactly the
    shape the page builds (smallest first, no leading zeros)."""
    if not isinstance(channel, str) or not channel.startswith("dm:"):
        return None
    parts = channel.split(":")[1:]  # "dm:3:7" -> ["3", "7"]
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        return None
    first, second = int(parts[0]), int(parts[1])
    if channel != f"dm:{first}:{second}" or first >= second:
        return None
    return first, second


def is_dm_member(channel, user_id):
    """Is this one of the two people of this DM, and are they still friends? (Calls only ever
    use this: a bot invited to read a DM is never let into its calls.)"""
    people = dm_people(channel)
    if people is None or user_id not in people:
        return False
    other = people[1] if user_id == people[0] else people[0]
    return are_friends(user_id, other)  # (a friendship also means the other person exists)


def bot_invited(channel, user_id):
    """A bot may read and write in someone else's DM for an hour after one of them mentions it
    there (that's how you invite it). Only a bot (users.is_bot), and only while they're friends."""
    people = dm_people(channel)
    if people is None or not is_bot(user_id) or not are_friends(*people):
        return False
    row = db.execute(
        """
        SELECT 1 FROM mentions JOIN messages ON messages.id = mentions.message_id
        WHERE mentions.user_id = ? AND messages.channel = ? AND messages.sent_at > datetime('now', ?)
        LIMIT 1
        """,
        (user_id, channel, BOT_INVITE_TIME),
    ).fetchone()
    return row is not None


def can_join(channel, user_id):
    """May this user read and write in this channel? Normal channels: anyone logged in.
    DMs ("dm:3:7", the two user ids, smallest first): the two people in it, while they're
    friends; and the AI bot for an hour after one of them mentioned it there."""
    if is_channel(channel):
        return may_see_channel(channel, user_id)  # (a private channel: only its roles; see "Channels")
    if is_dm_member(channel, user_id) or is_group_member(channel, user_id):
        return True
    people = dm_people(channel)  # (a member who's no longer friends stays out, even a bot)
    return people is not None and user_id not in people and bot_invited(channel, user_id)
