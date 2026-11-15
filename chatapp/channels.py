"""Channels and headings (and private ones) and roles: the admin's tools for both."""

import asyncio
import secrets

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from chatapp.config import HEX_COLOUR, MAX_CHANNELS, MAX_CHANNEL_NAME
from chatapp.db import db
from chatapp.sessions import is_admin, logged_in_admin, logged_in_user
from chatapp.users import username_of
from chatapp.access import channel_list, is_channel, may_see_channel, may_use_lounge
from chatapp.connections import clients, send
from chatapp.presence import announce_users
from chatapp.messages import delete_messages_in
from chatapp.voice import VOICE_ROOMS, announce_voice_members, remove_from_voice

router = APIRouter()


# ---------- Channels ----------
#
# The sidebar is one list, top to bottom, of channels and headings: a heading groups the channels
# under it, until the next heading. Admins change it in Settings → Channels; every change goes
# out to every open page at once ({"type": "channels"}), which redraws its sidebar.
#
# Who sees which channel: a channel is open (everyone sees it) or private (only people with one of
# its roles, in channel_roles). A role can be "limited": whoever has one sees only the private
# channels their roles open, no open channel and no Lounge (for parents, say: their DMs and a
# family channel). The owner sees everything, and bots (Chattus) every channel too, though never
# limited; other admins see open channels, and a private one only with one of its roles (in Settings too: only those who see a private channel can rename or delete it).
# Each person's pages get only the channels they may see, and can_join checks the same rule, so a page
# asking for another channel by hand gets nothing.


def channels_message(user_id):
    """{"type": "channels", "channels": [...], "lounge": True}: their sidebar, and whether it has the Lounge."""
    return {"type": "channels", "channels": channel_list(user_id), "lounge": may_use_lounge(user_id)}


async def announce_channels():
    """After any change to the channels, roles or who has which: each page gets its own list. A page
    in a channel it may no longer see stops getting its messages (and moves to the first channel when
    it hears), and someone who lost the Lounge is taken out of it."""
    lounge_changed = False
    for websocket, client in list(clients.items()):
        user_id = client["user_id"]
        if is_channel(client["channel"]) and not may_see_channel(client["channel"], user_id):
            client["channel"] = None
        if client["voice"] in VOICE_ROOMS and not may_use_lounge(user_id):
            client["voice"] = None
            lounge_changed = True
            asyncio.create_task(asyncio.to_thread(remove_from_voice, "lounge", user_id))
        await send(websocket, channels_message(user_id))
    if lounge_changed:
        await announce_voice_members()


def clean_channel_name(name):
    """A name as typed, tidied: spaces at the ends and line breaks gone, runs of spaces made one."""
    name = " ".join(name.split())
    if not name:
        raise HTTPException(400, "Give it a name.")
    if len(name) > MAX_CHANNEL_NAME:
        raise HTTPException(400, f"That's a bit long: at most {MAX_CHANNEL_NAME} characters.")
    return name


def managed_channel(admin_id, key):
    """Like existing_channel, for an admin changing it: one they can't see (private) is a 404 to them too."""
    if key not in [item["key"] for item in channel_list(admin_id)]:
        raise HTTPException(404, "That channel doesn't exist (any more).")
    return existing_channel(key)


def existing_channel(key):
    """(is it a heading?) for a channel or heading that exists, or a 404."""
    row = db.execute("SELECT heading FROM channels WHERE key = ?", (key,)).fetchone()
    if row is None:
        raise HTTPException(404, "That channel doesn't exist (any more).")
    return bool(row[0])


@router.get("/channels")
async def channels(request: Request):
    """The sidebar's channels, as this person may see them (for the page's first draw)."""
    user_id = logged_in_user(request)[0]
    return channel_list(user_id)


class NewChannel(BaseModel):
    name: str
    heading: bool = False  # True: a heading instead of a channel


@router.post("/channels")
async def create_channel(request: Request, data: NewChannel):
    """A new channel or heading, at the bottom of the list (admins only)."""
    logged_in_admin(request)
    name = clean_channel_name(data.name)
    if db.execute("SELECT COUNT(*) FROM channels").fetchone()[0] >= MAX_CHANNELS:
        raise HTTPException(400, f"That's the most there can be ({MAX_CHANNELS}).")
    # A key that's never been used: "c:" (or "h:" for a heading) and 8 random hex digits. Not the
    # name, which can change, and never clashing with "dm:3:7", "voice:..." or the page's "friends".
    key = ("h:" if data.heading else "c:") + secrets.token_hex(4)
    with db:
        db.execute(
            "INSERT INTO channels (key, name, position, heading) "
            "VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM channels), ?)",
            (key, name, int(data.heading)),
        )
    await announce_channels()
    return {"key": key}


class ChannelRename(BaseModel):
    name: str


@router.post("/channels/{key}/rename")
async def rename_channel(request: Request, key: str, data: ChannelRename):
    """A new name for a channel or heading (admins only). Its messages keep pointing to its key."""
    managed_channel(logged_in_admin(request), key)
    name = clean_channel_name(data.name)
    with db:
        db.execute("UPDATE channels SET name = ? WHERE key = ?", (name, key))
    await announce_channels()
    return {"ok": True}


class ChannelAccess(BaseModel):
    private: bool          # False: everyone (not limited) sees it
    roles: list[int] = []  # a private one: the roles that see it (none: only admins)


@router.post("/channels/{key}/access")
async def set_channel_access(request: Request, key: str, data: ChannelAccess):
    """Who can see a channel (admins only): everyone, or only some roles."""
    if managed_channel(logged_in_admin(request), key):
        raise HTTPException(400, "Headings can't be private, only channels.")
    existing = {role_id for (role_id,) in db.execute("SELECT id FROM roles")}
    roles = set(data.roles) if data.private else set()
    if not roles <= existing:  # (<= on sets: "is a subset of")
        raise HTTPException(409, "The roles changed meanwhile. Try again.")
    with db:
        db.execute("UPDATE channels SET private = ? WHERE key = ?", (int(data.private), key))
        db.execute("DELETE FROM channel_roles WHERE channel = ?", (key,))
        db.executemany("INSERT INTO channel_roles (channel, role_id) VALUES (?, ?)", [(key, role_id) for role_id in roles])
    await announce_channels()
    return {"ok": True}


class ChannelOrder(BaseModel):
    keys: list[str]  # every channel and heading, in their new order


@router.post("/channels/order")
async def reorder_channels(request: Request, data: ChannelOrder):
    """Put the channels and headings in a new order (admins only). The page sends the whole list,
    so it must have exactly the keys they see: no more, no fewer, none twice. (An admin who can't see a
    private channel moves only the others: theirs take the places those had, the private one keeps its own.)"""
    admin_id = logged_in_admin(request)
    seen = [item["key"] for item in channel_list(admin_id)]
    if sorted(data.keys) != sorted(seen):
        raise HTTPException(409, "The channels changed meanwhile. Try again.")
    everything = [key for (key,) in db.execute("SELECT key FROM channels ORDER BY position")]
    new_order = iter(data.keys)
    order = [next(new_order) if key in seen else key for key in everything]
    with db:
        # enumerate gives each key its place: (0, "general"), (1, "memes"), ...
        db.executemany("UPDATE channels SET position = ? WHERE key = ?",
                       [(position, key) for position, key in enumerate(order)])
    await announce_channels()
    return {"ok": True}


@router.post("/channels/{key}/delete")
async def delete_channel(request: Request, key: str):
    """Delete a heading, or a channel with every message in it (admins only). There's no undo,
    except a backup, so the page asks first."""
    if not managed_channel(logged_in_admin(request), key):
        if db.execute("SELECT COUNT(*) FROM channels WHERE heading = 0").fetchone()[0] <= 1:
            raise HTTPException(400, "That's the last channel: there must always be one.")
    with db:
        db.execute("DELETE FROM channels WHERE key = ?", (key,))
        db.execute("DELETE FROM channel_roles WHERE channel = ?", (key,))
    delete_messages_in(key)
    for client in clients.values():
        if client["channel"] == key:
            client["channel"] = None  # (their page moves to the first channel when it hears)
    await announce_channels()
    return {"ok": True}


# ---------- Roles ----------
#
# Admins make roles (a name and a colour) in Settings → Roles and give them to people. Someone's top
# role (the highest in the list) colours their name and gives them a section in the member list.
# Every change goes to every page: "roles" (the list) and "users" (who has which).

MAX_ROLES = 20
MAX_ROLE_NAME = 30


def roles_message(user_id):
    """{"type": "roles", "roles": [{"id": 1, "name": "Gamers", "colour": "#3ba55c", "limited": False, "hidden": False}, ...]},
    the top one first. "limited": its people only see the private channels their roles open (see "Channels").
    "hidden": only admins know it exists (no colour, member list section or profile tag): everyone else's
    pages never get it, nor see anyone have it (users_for)."""
    rows = db.execute("SELECT id, name, colour, limited, hidden FROM roles ORDER BY position").fetchall()
    admin = is_admin(user_id)
    return {"type": "roles", "roles": [
        {"id": role_id, "name": name, "colour": colour, "limited": bool(limited), "hidden": bool(hidden)}
        for role_id, name, colour, limited, hidden in rows if admin or not hidden
    ]}


async def announce_roles():
    for websocket, client in list(clients.items()):
        await send(websocket, roles_message(client["user_id"]))
    await announce_users()
    await announce_channels()  # (who sees which channel can depend on the roles)


def clean_role(name, colour):
    """A role's name, tidied, and its colour, checked: or a 400."""
    name = " ".join(name.split())
    if not name:
        raise HTTPException(400, "Give it a name.")
    if len(name) > MAX_ROLE_NAME:
        raise HTTPException(400, f"That's a bit long: at most {MAX_ROLE_NAME} characters.")
    if not HEX_COLOUR.fullmatch(colour):
        raise HTTPException(400, "That's not a colour.")
    return name, colour.lower()


def existing_role(role_id):
    if db.execute("SELECT 1 FROM roles WHERE id = ?", (role_id,)).fetchone() is None:
        raise HTTPException(404, "That role doesn't exist (any more).")


class RoleData(BaseModel):
    name: str
    colour: str  # "#3ba55c"


@router.post("/roles")
async def create_role(request: Request, data: RoleData):
    """A new role, at the bottom of the list (admins only)."""
    logged_in_admin(request)
    name, colour = clean_role(data.name, data.colour)
    if db.execute("SELECT COUNT(*) FROM roles").fetchone()[0] >= MAX_ROLES:
        raise HTTPException(400, f"That's the most there can be ({MAX_ROLES}).")
    with db:
        db.execute("INSERT INTO roles (name, colour, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM roles))",
                   (name, colour))
    await announce_roles()
    return {"ok": True}


@router.post("/roles/{role_id}/edit")
async def edit_role(request: Request, role_id: int, data: RoleData):
    """A new name or colour for a role (admins only)."""
    logged_in_admin(request)
    existing_role(role_id)
    name, colour = clean_role(data.name, data.colour)
    with db:
        db.execute("UPDATE roles SET name = ?, colour = ? WHERE id = ?", (name, colour, role_id))
    await announce_roles()
    return {"ok": True}


class RoleOrder(BaseModel):
    ids: list[int]  # every role, in the new order


@router.post("/roles/order")
async def reorder_roles(request: Request, data: RoleOrder):
    """Put the roles in a new order (admins only): the whole list, like the channels."""
    logged_in_admin(request)
    existing = [role_id for (role_id,) in db.execute("SELECT id FROM roles")]
    if sorted(data.ids) != sorted(existing):
        raise HTTPException(409, "The roles changed meanwhile. Try again.")
    with db:
        db.executemany("UPDATE roles SET position = ? WHERE id = ?", [(position, role_id) for position, role_id in enumerate(data.ids)])
    await announce_roles()
    return {"ok": True}


@router.post("/roles/{role_id}/delete")
async def delete_role(request: Request, role_id: int):
    """Delete a role, and take it from everyone who had it (admins only)."""
    logged_in_admin(request)
    existing_role(role_id)
    with db:
        db.execute("DELETE FROM user_roles WHERE role_id = ?", (role_id,))
        # (A private channel that only this role saw stays private: then only the owner sees it.)
        db.execute("DELETE FROM channel_roles WHERE role_id = ?", (role_id,))
        db.execute("DELETE FROM roles WHERE id = ?", (role_id,))
    await announce_roles()
    return {"ok": True}


class RoleLimited(BaseModel):
    limited: bool


@router.post("/roles/{role_id}/limited")
async def set_role_limited(request: Request, role_id: int, data: RoleLimited):
    """Make a role limited (its people only see their private channels, no Lounge), or not (admins only)."""
    logged_in_admin(request)
    existing_role(role_id)
    with db:
        db.execute("UPDATE roles SET limited = ? WHERE id = ?", (int(data.limited), role_id))
    await announce_roles()
    return {"ok": True}


class RoleHidden(BaseModel):
    hidden: bool


@router.post("/roles/{role_id}/hidden")
async def set_role_hidden(request: Request, role_id: int, data: RoleHidden):
    """Hide a role from everyone but admins (no colour, section or tag; see roles_message), or show it (admins only)."""
    logged_in_admin(request)
    existing_role(role_id)
    with db:
        db.execute("UPDATE roles SET hidden = ? WHERE id = ?", (int(data.hidden), role_id))
    await announce_roles()
    return {"ok": True}


class RoleMember(BaseModel):
    user_id: int
    member: bool  # True: give them the role; False: take it away


@router.post("/roles/{role_id}/members")
async def set_role_member(request: Request, role_id: int, data: RoleMember):
    """Give someone a role, or take it from them (admins only)."""
    logged_in_admin(request)
    existing_role(role_id)
    if username_of(data.user_id) is None:
        raise HTTPException(404, "That person doesn't exist.")
    with db:
        if data.member:
            db.execute("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", (data.user_id, role_id))
        else:
            db.execute("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?", (data.user_id, role_id))
    await announce_users()
    await announce_channels()  # (their roles may open or close channels for them)
    return {"ok": True}
