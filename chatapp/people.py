"""Profiles (pictures, banners, status, bio), friends and friend requests, and blocking."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from chatapp.config import MAX_BIO_LENGTH, MAX_STATUS_LENGTH, PICTURE_EXTENSIONS, PICTURE_KINDS
from chatapp.db import db
from chatapp.sessions import current_user, is_admin, logged_in_user
from chatapp.users import friends_message, friendship, has_blocked, is_bot, pair, username_of
from chatapp.connections import clients, send, send_to_user
from chatapp.files import receive_picture
from chatapp.presence import announce_users
from chatapp.push import clear_on_phones, push_in_background

router = APIRouter()


# ---------- Profiles ----------

# Profile pictures and banners work the same way; `kind` ("avatar" or "banner") picks the
# column, folder and size limit from PICTURE_KINDS. The column names in the SQL below come from
# that table of ours, never from a request, so putting them into the SQL text is safe.


async def set_picture(request, kind):
    """A new profile picture or banner."""
    user_id, username, password_hash, email = logged_in_user(request)
    settings = PICTURE_KINDS[kind]
    picture_id = await receive_picture(request, kind)

    old = db.execute(f"SELECT {settings['column']} FROM users WHERE id = ?", (user_id,)).fetchone()[0]
    with db:
        db.execute(f"UPDATE users SET {settings['column']} = ? WHERE id = ?", (picture_id, user_id))
    if old:
        (settings["folder"] / old).unlink(missing_ok=True)
    await announce_users()  # everyone's page shows the new picture
    return {"ok": True, kind: picture_id}


async def remove_picture(request, kind):
    user_id, username, password_hash, email = logged_in_user(request)
    settings = PICTURE_KINDS[kind]
    old = db.execute(f"SELECT {settings['column']} FROM users WHERE id = ?", (user_id,)).fetchone()[0]
    with db:
        db.execute(f"UPDATE users SET {settings['column']} = NULL WHERE id = ?", (user_id,))
    if old:
        (settings["folder"] / old).unlink(missing_ok=True)
    await announce_users()
    return {"ok": True}


def serve_picture(request, kind, picture_id):
    """A profile picture or banner, for logged-in people only."""
    settings = PICTURE_KINDS[kind]
    row = db.execute(f"SELECT 1 FROM users WHERE {settings['column']} = ?", (picture_id,)).fetchone()
    if current_user(request) is None or row is None:
        raise HTTPException(404, "Not found.")
    # Our own table said this name exists, so it's safe to use as a file name. Its extension
    # (which we chose ourselves when saving) gives the type.
    extension = picture_id.rsplit(".", 1)[-1]
    content_type = {ext: type_ for type_, ext in PICTURE_EXTENSIONS.items()}[extension]
    return FileResponse(
        settings["folder"] / picture_id,
        media_type=content_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            # A picture's address never changes what's behind it (a new picture gets a new address),
            # so the browser may keep it for a year without asking again. "private": only in
            # the person's own browser, not in shared caches along the way.
            "Cache-Control": "private, max-age=31536000, immutable",
        },
    )


@router.post("/settings/avatar")
async def change_avatar(request: Request):
    return await set_picture(request, "avatar")


@router.delete("/settings/avatar")
async def remove_avatar(request: Request):
    return await remove_picture(request, "avatar")


@router.get("/avatars/{picture_id}")
async def get_avatar(request: Request, picture_id: str):
    return serve_picture(request, "avatar", picture_id)


@router.post("/settings/banner")
async def change_banner(request: Request):
    return await set_picture(request, "banner")


@router.delete("/settings/banner")
async def remove_banner(request: Request):
    return await remove_picture(request, "banner")


@router.get("/banners/{picture_id}")
async def get_banner(request: Request, picture_id: str):
    return serve_picture(request, "banner", picture_id)


class ProfileChange(BaseModel):
    status: str
    bio: str


@router.post("/settings/profile")
async def change_profile(data: ProfileChange, request: Request):
    """Status and bio. No password needed: nothing about the account's security depends on them."""
    user_id, username, password_hash, email = logged_in_user(request)
    status = data.status.strip()
    bio = data.bio.strip()
    if len(status) > MAX_STATUS_LENGTH:
        raise HTTPException(400, f"Your status can be at most {MAX_STATUS_LENGTH} characters.")
    if len(bio) > MAX_BIO_LENGTH:
        raise HTTPException(400, f"Your bio can be at most {MAX_BIO_LENGTH} characters.")
    with db:
        # `status or None`: an empty text is stored as NULL, meaning "none".
        db.execute("UPDATE users SET status = ?, bio = ? WHERE id = ?", (status or None, bio or None, user_id))
    await announce_users()
    return {"ok": True}


# ---------- Friends ----------


async def send_friends_update(*user_ids):
    """Friendships are personal, so they aren't sent to everyone: each of these people gets
    their own up-to-date list, in all their open tabs."""
    for user_id in user_ids:
        message = friends_message(user_id)
        for websocket, client in list(clients.items()):
            if client["user_id"] == user_id:
                await send(websocket, message)


class FriendAction(BaseModel):
    user_id: int  # the other person


def other_person(data, request):
    """(my id, their id) for a friend action, after checking it makes sense."""
    me = current_user(request)
    if me is None:
        raise HTTPException(401, "You're not logged in.")
    if data.user_id == me or username_of(data.user_id) is None:
        raise HTTPException(400, "That's not someone you can add.")
    return me, data.user_id


@router.post("/friends/request")
async def friend_request(data: FriendAction, request: Request):
    me, other = other_person(data, request)
    if has_blocked(me, other):
        raise HTTPException(400, "You've blocked them: unblock them first.")
    if has_blocked(other, me):  # (said plainly, without telling them they're blocked)
        raise HTTPException(400, "You can't send a friend request to this person.")
    row = friendship(me, other)
    user_a, user_b = pair(me, other)
    if row is None:
        with db:
            db.execute(
                "INSERT INTO friendships (user_a, user_b, requested_by) VALUES (?, ?, ?)", (user_a, user_b, me)
            )
        # Their phones too (the page notifies by itself: notifyFriendRequest). Tapping it opens the
        # Friends page ("friends" as the channel, like the page's own name for it).
        avatar = db.execute("SELECT avatar_id FROM users WHERE id = ?", (me,)).fetchone()[0]
        push_in_background([other], {
            "title": username_of(me), "body": "👋 sent you a friend request", "channel": "friends",
            "icon": f"/avatars/{avatar}" if avatar else "/icons/icon-192.png", "kind": "friend",
        })
    elif row[1] == 0 and row[0] == other:
        # They had already asked us: asking back counts as accepting.
        with db:
            db.execute("UPDATE friendships SET accepted = 1 WHERE user_a = ? AND user_b = ?", (user_a, user_b))
    # Otherwise we're already friends, or we already asked: nothing to change.
    await send_friends_update(me, other)
    return {"ok": True}


@router.post("/friends/accept")
async def friend_accept(data: FriendAction, request: Request):
    me, other = other_person(data, request)
    user_a, user_b = pair(me, other)
    with db:
        # Only a request *they* sent can be accepted by us.
        cursor = db.execute(
            "UPDATE friendships SET accepted = 1 WHERE user_a = ? AND user_b = ? AND requested_by = ? AND accepted = 0",
            (user_a, user_b, other),
        )
    if cursor.rowcount != 1:
        raise HTTPException(400, "There's no friend request from them.")
    clear_on_phones(me, "friends")
    await send_friends_update(me, other)
    return {"ok": True}


@router.post("/friends/remove")
async def friend_remove(data: FriendAction, request: Request):
    """Decline a request, cancel your own, or end a friendship: all three remove the row.
    The DM's messages stay in the database, hidden; becoming friends again brings them back."""
    me, other = other_person(data, request)
    if is_bot(me) or is_bot(other):  # (the page shows no Remove for bots; this is for anyone who asks by hand)
        raise HTTPException(400, "Bots stay everyone's friend.")
    with db:
        db.execute("DELETE FROM friendships WHERE user_a = ? AND user_b = ?", pair(me, other))
    clear_on_phones(me, "friends")  # (a declined request; harmless for the other two)
    await send_friends_update(me, other)
    return {"ok": True}


# ---------- Blocking ----------
#
# Blocking someone ends the friendship (and any request), so DMs, group invites and DM calls stop:
# all of those need friends. They can't send a new request; they never count as mentioning us
# (save_mentions: no notifications, counts or pushes) and their calls don't ring us; their messages in
# chats we share are hidden on our page, and left out of our searches. They aren't told. Admins
# can't be blocked (the chat's rule), nor bots (they're everyone's friend, at every start).


def blocks_message(user_id):
    """The people someone blocked, for their own pages: {"type": "blocks", "blocked": [7, 12]}."""
    rows = db.execute("SELECT blocked_id FROM blocks WHERE blocker_id = ? ORDER BY created_at", (user_id,))
    return {"type": "blocks", "blocked": [blocked for (blocked,) in rows]}


@router.post("/friends/block")
async def block(data: FriendAction, request: Request):
    me, other = other_person(data, request)
    if is_admin(other):
        raise HTTPException(400, "Admins can't be blocked.")
    if is_bot(other):
        raise HTTPException(400, "Bots can't be blocked. To quiet one, mute its channel (🔔).")
    with db:
        db.execute("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)", (me, other))
        db.execute("DELETE FROM friendships WHERE user_a = ? AND user_b = ?", pair(me, other))
    await send_friends_update(me, other)  # (they see the friendship gone, as if it had been removed)
    await send_to_user(me, blocks_message(me))
    return {"ok": True}


@router.post("/friends/unblock")
async def unblock(data: FriendAction, request: Request):
    """Unblocking doesn't make them a friend again: that takes a new request."""
    me, other = other_person(data, request)
    with db:
        db.execute("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?", (me, other))
    await send_to_user(me, blocks_message(me))
    return {"ok": True}
