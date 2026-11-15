"""Group DMs: making them, adding people, renaming and leaving."""

import secrets

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from chatapp.config import MAX_CHANNEL_NAME
from chatapp.db import db
from chatapp.sessions import current_user
from chatapp.users import are_friends, is_bot
from chatapp.access import group_members, group_people, is_group_member
from chatapp.connections import clients, send_to_user
from chatapp.messages import delete_messages_in

router = APIRouter()


# ---------- Group DMs ----------
#
# Private chats for 3 to 10 people. Anyone can start one with their friends; any member can add
# more of their own friends and rename it; anyone can leave, and the last one out deletes it.
# The members don't have to be friends with each other (as in Discord). Calls: see "Calls in DMs
# and group DMs". Every bot is in every group too (add_bots_to_groups), answering @mentions, but
# bots don't count as people: not for the size, and the last *person* out deletes the group.
# Each member's pages get {"type": "groups"} with their groups at the start and after every change.

MAX_GROUP_SIZE = 10  # people in a group, its starter included (bots not counted)


def groups_message(user_id):
    """One person's groups, oldest first: {"type": "groups", "groups": [{"key", "name", "members"}, ...]}"""
    rows = db.execute(
        "SELECT key, name FROM group_dms JOIN group_members ON group_members.group_key = group_dms.key"
        " WHERE group_members.user_id = ? ORDER BY group_dms.created_at, group_dms.rowid",
        (user_id,),
    ).fetchall()
    return {"type": "groups", "groups": [
        {"key": key, "name": name, "members": group_members(key)} for key, name in rows
    ]}


async def announce_groups(user_ids):
    """Send these people their groups again (each their own list), after a change."""
    for user_id in set(user_ids):
        await send_to_user(user_id, groups_message(user_id))


def logged_in_member(request, key):
    """The logged-in user's id if they're in this group, or an error. A 404 also for groups that
    exist but aren't theirs: nobody can find out about other people's groups by trying keys."""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    if not is_group_member(key, user_id):
        raise HTTPException(404, "That group doesn't exist (any more).")
    return user_id


def new_group_members(user_id, wanted, already):
    """The people to add (sorted, without those already in it): each must be a friend of whoever adds
    them, and the group may not grow past MAX_GROUP_SIZE people. (Bots are in every group already.)"""
    new = sorted(set(wanted) - set(already))
    if any(other == user_id or not are_friends(user_id, other) or is_bot(other) for other in new):
        raise HTTPException(400, "You can only add your friends.")
    if len([member for member in already if not is_bot(member)]) + len(new) > MAX_GROUP_SIZE:
        raise HTTPException(400, f"A group has at most {MAX_GROUP_SIZE} people.")
    return new


def clean_group_name(name):
    """A group's name as typed, tidied like a channel's; empty means none (called after its members)."""
    name = " ".join(name.split())
    if len(name) > MAX_CHANNEL_NAME:
        raise HTTPException(400, f"That's a bit long: at most {MAX_CHANNEL_NAME} characters.")
    return name or None


class NewGroup(BaseModel):
    user_ids: list[int]  # the friends to start it with (not yourself)
    name: str = ""


@router.post("/groups")
async def create_group(request: Request, data: NewGroup):
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    others = new_group_members(user_id, data.user_ids, [user_id])
    if len(others) < 2:
        raise HTTPException(400, "Pick at least two friends (for one, send them a DM).")
    name = clean_group_name(data.name)
    key = "g:" + secrets.token_hex(4)  # random, like a new channel's key
    bots = [bot for (bot,) in db.execute("SELECT id FROM users WHERE is_bot = 1")]  # in every group
    with db:
        db.execute("INSERT INTO group_dms (key, name) VALUES (?, ?)", (key, name))
        db.executemany("INSERT INTO group_members (group_key, user_id) VALUES (?, ?)",
                       [(key, member) for member in [user_id, *others, *bots]])  # (*: the list's items, one by one)
    await announce_groups([user_id, *others, *bots])
    return {"key": key}


class GroupName(BaseModel):
    name: str  # "" = no name (called after its members)


@router.post("/groups/{key}/rename")
async def rename_group(request: Request, key: str, data: GroupName):
    logged_in_member(request, key)
    with db:
        db.execute("UPDATE group_dms SET name = ? WHERE key = ?", (clean_group_name(data.name), key))
    await announce_groups(group_members(key))
    return {"ok": True}


class GroupAdd(BaseModel):
    user_ids: list[int]


@router.post("/groups/{key}/add")
async def add_to_group(request: Request, key: str, data: GroupAdd):
    """Add some of your friends to a group you're in. They see its whole history, as in Discord."""
    user_id = logged_in_member(request, key)
    members = group_members(key)
    new = new_group_members(user_id, data.user_ids, members)
    if not new:
        raise HTTPException(400, "Pick someone to add.")
    with db:
        db.executemany("INSERT INTO group_members (group_key, user_id) VALUES (?, ?)", [(key, other) for other in new])
    await announce_groups(members + new)
    return {"ok": True}


@router.post("/groups/{key}/leave")
async def leave_group(request: Request, key: str):
    user_id = logged_in_member(request, key)
    with db:
        db.execute("DELETE FROM group_members WHERE group_key = ? AND user_id = ?", (key, user_id))
        db.execute("DELETE FROM last_read WHERE user_id = ? AND channel = ?", (user_id, key))
        db.execute("DELETE FROM chat_mutes WHERE user_id = ? AND channel = ?", (user_id, key))
        db.execute("DELETE FROM pinned_chats WHERE user_id = ? AND channel = ?", (user_id, key))
    remaining = group_members(key)
    if not group_people(key):  # the last person out (only bots left): nobody will see it again, so it goes
        with db:
            db.execute("DELETE FROM group_members WHERE group_key = ?", (key,))
            db.execute("DELETE FROM group_dms WHERE key = ?", (key,))
        delete_messages_in(key)
    for client in clients.values():
        if client["user_id"] == user_id and client["channel"] == key:
            client["channel"] = None  # (their page moves to the first channel when it hears)
    await announce_groups([user_id, *remaining])
    return {"ok": True}
