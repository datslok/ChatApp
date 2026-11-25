"""Statuses (online, idle, do not disturb, invisible), phones and idle PCs, activities, and the list of
everyone ("users") every page gets."""

import asyncio
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from chatapp.db import BANNED_NOW, db
from chatapp.sessions import is_admin, logged_in_user
from chatapp.access import hidden_role_ids
from chatapp.connections import clients, send, send_to_user

router = APIRouter()


# ---------- Who is online ----------

def online_user_ids():
    """The ids of everyone with at least one open tab. A set, so two tabs count once."""
    return {client["user_id"] for client in clients.values()}


# ---------- Statuses ----------
#
# Each person chooses Online, Idle, Do Not Disturb or Invisible (users.presence; the popup at the bottom
# left). What the others see: "offline" without an open tab, and when Invisible; "dnd" and "idle" as
# chosen; and Online turns "idle" by itself when none of their pages has been looked at for IDLE_AFTER
# (each page says when it's in sight: "looking"). Do Not Disturb also stops every notification.
#
# Phones have their own rule (the user's wish, 2026-10-16): Android cuts a locked phone's connection
# within moments, so it went grey at once. Now a phone counts as online while the app is on screen, idle
# from the moment it's locked or left, and gone PHONE_AWAY_FOR after that, whether its connection is still
# open or not: phones_away remembers a phone whose connection closed while it was away. (In a call it
# stays idle: the call keeps the connection, and they're clearly there.) Each person shows the most
# present of their devices: a PC in use keeps them online with the phone locked. PCs are as before.

PRESENCES = ["online", "idle", "dnd", "invisible"]
IDLE_AFTER = 10 * 60  # seconds without looking at the chat anywhere
PHONE_AWAY_FOR = 10 * 60  # seconds a locked (or left) phone still shows its person as idle

phones_away = {}  # {user_id: since when}: a phone whose connection closed while away (see above)


def device_presence(client, now, bot=False):
    """What one open page or app says about its person: "online", "idle" or None (nothing: a phone
    away for too long)."""
    if bot:  # (bots never "look", and are always there)
        return "online"
    if client["pc_idle"]:  # the Windows app, with nobody at the PC (see "Away from the PC")
        return "idle"
    if client["away_since"] is None:
        return "online"
    away = now - client["away_since"]
    if client["mobile"]:
        return "idle" if away < PHONE_AWAY_FOR or client["voice"] else None
    return "online" if away < IDLE_AFTER else "idle"


def shown_presence(user_id, chosen, bot=False):
    """What the others see of this person: "online", "idle", "dnd" or "offline"."""
    now = time.time()
    seen = {device_presence(client, now, bot) for client in clients.values() if client["user_id"] == user_id}
    away_since = phones_away.get(user_id)
    if away_since is not None:
        if now - away_since < PHONE_AWAY_FOR:
            seen.add("idle")
        else:
            phones_away.pop(user_id, None)  # (over: forgotten)
    seen.discard(None)
    if not seen or chosen == "invisible":
        return "offline"
    if chosen in ("idle", "dnd"):
        return chosen
    return "online" if "online" in seen else "idle"


def on_phone_only(user_id, presence):
    """Is this person only here on a phone (every open page of theirs says it's one, or the phone that
    just left is all there is)? Then the others see a little phone instead of their dot. Not when they
    show as offline (Invisible gives nothing away)."""
    tabs = [client for client in clients.values() if client["user_id"] == user_id]
    if presence == "offline":
        return False
    if not tabs:
        return user_id in phones_away
    return all(client["mobile"] for client in tabs)


# Away from the PC (since 2026-11-15, the user's wish): with the Windows app left open, the phones got no
# pushes at all (push.py, why_no_push), even with nobody at the PC. Now the app asks Windows how long the keyboard
# and mouse have gone unused (main.rs, seconds_idle), and after the person's own number of minutes the
# page says "idle" in its "looking" messages (notifications.js). Then that app no longer counts as
# looking or as open (so the phones get pushes again), and it shows its person as idle.
IDLE_MINUTES_CHOICES = [1, 2, 5, 10, 15, 30, 60]  # Settings → Notifications (also in LIMITS)


def idle_minutes_of(user_id):
    return db.execute("SELECT idle_minutes FROM users WHERE id = ?", (user_id,)).fetchone()[0]


class IdleMinutes(BaseModel):
    minutes: int


@router.post("/settings/idle")
async def change_idle_minutes(data: IdleMinutes, request: Request):
    user_id, username, password_hash, email = logged_in_user(request)
    if data.minutes not in IDLE_MINUTES_CHOICES:
        raise HTTPException(400, "Not one of the choices.")
    with db:
        db.execute("UPDATE users SET idle_minutes = ? WHERE id = ?", (data.minutes, user_id))
    # Every page of theirs: the Windows app does the measuring, wherever it was changed.
    await send_to_user(user_id, {"type": "idle_minutes", "minutes": data.minutes})
    return {"ok": True}


# What someone is doing (the Windows app sees it: desktop/src-tauri/src/activity.rs; the page sends it
# with {"type": "activity"}). Kept only in memory, with the connection that sent it: when that page
# closes, it's gone. Never shown while they show as offline (Invisible).
ACTIVITY_KINDS = ("playing", "listening", "using")


def clean_activity(value):
    """An activity from a page, checked: {"kind": "listening", "name": "Song", "details": "Artist"}
    ("details" only if there is one), or None for nothing (or anything odd)."""
    if not isinstance(value, dict) or value.get("kind") not in ACTIVITY_KINDS:
        return None
    name, details = value.get("name"), value.get("details")
    if not isinstance(name, str) or not name.strip():
        return None
    activity = {"kind": value["kind"], "name": name.strip()[:100]}
    if isinstance(details, str) and details.strip():
        activity["details"] = details.strip()[:100]
    return activity


def activity_of(user_id, presence):
    """What the others see this person doing (with "since", when it started), or None."""
    if presence == "offline":
        return None
    for client in clients.values():
        if client["user_id"] == user_id and client["activity"] is not None:
            return client["activity"]
    return None


def presence_of(user_id):
    """The status this person chose (for their own pages, and for notifications)."""
    row = db.execute("SELECT presence FROM users WHERE id = ?", (user_id,)).fetchone()
    return row[0] if row else "online"


def users_message():
    """Every account with its profile and what the others see of their status:
    [{"id": 3, "name": "axel", "presence": "idle", "online": True, "avatar": "Xk9...webp", "status": "...", ...}]
    ("status" is the line people write about themselves, "playing Minecraft"; "online" is "not offline".)"""
    rows = db.execute(
        "SELECT id, username, avatar_id, banner_id, status, bio, is_admin, is_bot, presence, is_owner FROM users"
        " WHERE email_verified = 1"  # (a new account joins the lists once its email is verified)
        f" AND NOT {BANNED_NOW}"     # (and a banned one leaves them)
        " ORDER BY username COLLATE NOCASE"
    ).fetchall()
    # Everyone's roles, in one query: the top one first (the list's order), so the page takes roles[0].
    roles_of = {}
    for user_id, role_id in db.execute(
        "SELECT user_roles.user_id, user_roles.role_id FROM user_roles"
        " JOIN roles ON roles.id = user_roles.role_id ORDER BY roles.position"
    ):
        roles_of.setdefault(user_id, []).append(role_id)
    # Who has a limited role (not admins): left out of open channels' member lists (see channels.py, "Channels").
    limited = {user_id for (user_id,) in db.execute(
        "SELECT user_roles.user_id FROM user_roles JOIN roles ON roles.id = user_roles.role_id"
        " JOIN users ON users.id = user_roles.user_id WHERE roles.limited = 1 AND users.is_admin = 0 AND users.is_bot = 0"
    )}
    users = []
    for user_id, name, avatar, banner, status, bio, admin, bot, chosen, owner in rows:
        presence = shown_presence(user_id, chosen, bool(bot))
        users.append({
            "id": user_id, "name": name, "presence": presence, "online": presence != "offline",
            "mobile": on_phone_only(user_id, presence),  # only on a phone: a little phone for a dot
            "activity": activity_of(user_id, presence),  # playing, listening to, using (or None)
            "avatar": avatar, "banner": banner, "status": status, "bio": bio, "admin": bool(admin),
            "bot": bool(bot),  # the AI bot: the page offers it in DMs' @ suggestions too
            "owner": bool(owner),  # the server's owner (see admin.py, "Bans and admins")
            "roles": roles_of.get(user_id, []),  # role ids, the top one first (see "roles"; hidden: users_for)
            "limited": user_id in limited,  # sees only their private channels (see channels.py, "Channels")
        })
    return {"type": "users", "users": users}


def users_for(user_id, message):
    """The users message as this person may see it: hidden roles (see channels.py, "Roles") left out, but for admins."""
    if is_admin(user_id):
        return message
    hidden = hidden_role_ids()
    if not hidden:
        return message
    return {**message, "users": [{**user, "roles": [r for r in user["roles"] if r not in hidden]} for user in message["users"]]}


async def announce_users(message=None):
    """Send every page the users list (each its own, see users_for)."""
    message = message or users_message()
    for websocket, client in list(clients.items()):
        await send(websocket, users_for(client["user_id"], message))


shown_presences = {}  # what everyone was last told: {user_id: ("idle", False, None), ...} (see announce_presences)


async def announce_presences():
    """Send everyone the users list again, if anyone's status (phone, activity) looks different from last time."""
    global shown_presences  # (this function gives the name a new dict, so it must say it means the global one)
    message = users_message()
    now = {user["id"]: (user["presence"], user["mobile"], user["activity"]) for user in message["users"]}
    if now != shown_presences:
        shown_presences = now
        await announce_users(message)


async def watch_presences():
    """Going idle isn't an event, it's time passing: so look every 30 seconds. Runs as long as the server."""
    while True:
        await asyncio.sleep(30)
        try:
            await announce_presences()
        except Exception as error:  # (one bad round must not stop it for good)
            print(f"Couldn't update statuses: {error!r}", flush=True)


presence_watcher = None  # the task above, started by the first connection (it needs the running loop)


def start_watching_presences():
    """Start watch_presences once: called by every new connection, only the first one starts it."""
    global presence_watcher
    if presence_watcher is None:
        presence_watcher = asyncio.create_task(watch_presences())
