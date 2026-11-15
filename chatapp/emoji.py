"""Custom emoji: uploading, renaming and deleting them, and serving their pictures."""

import re
import sqlite3

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from chatapp.config import EMOJI_NAME_PATTERN, MAX_CUSTOM_EMOJI, PICTURE_EXTENSIONS, PICTURE_KINDS
from chatapp.db import db
from chatapp.sessions import current_user, is_admin, logged_in_user
from chatapp.connections import send_to_channel, send_to_everyone
from chatapp.files import receive_picture
from chatapp.messages import reactions_for

router = APIRouter()


# ---------- Custom emoji ----------

def custom_emoji_message():
    """Every custom emoji: {"type": "custom_emoji", "emoji": [{"id", "name", "file", "owner_id"}, ...]}."""
    rows = db.execute("SELECT id, name, file, owner_id FROM custom_emoji ORDER BY name COLLATE NOCASE")
    return {
        "type": "custom_emoji",
        "emoji": [{"id": emoji_id, "name": name, "file": file, "owner_id": owner_id} for emoji_id, name, file, owner_id in rows],
    }


CUSTOM_EMOJI_CODE = re.compile(r":([A-Za-z0-9_]{2,32}):")  # :pog: in a message's text


def expand_custom_emoji(text):
    """Turn every :name: of an existing custom emoji into a token with its id, like <:17>.
    Messages store the id, not the name, so a deleted (or one day renamed) emoji can never turn
    into a different one that later gets the same name. Anything else (":)", ":nope:") stays text."""
    ids = {name.lower(): emoji_id for emoji_id, name in db.execute("SELECT id, name FROM custom_emoji")}

    def replace(match):  # called for each :name: found; returns what to put in its place
        emoji_id = ids.get(match[1].lower())
        return f"<:{emoji_id}>" if emoji_id else match[0]

    return CUSTOM_EMOJI_CODE.sub(replace, text)


def custom_emoji_exists(reaction):
    """Is this a reference to a custom emoji that exists, like "custom:17"?"""
    match = re.fullmatch(r"custom:(\d{1,10})", reaction)
    if match is None:
        return False
    return db.execute("SELECT 1 FROM custom_emoji WHERE id = ?", (int(match[1]),)).fetchone() is not None


@router.post("/custom-emoji")
async def add_custom_emoji(request: Request, name: str):
    """Add a custom emoji: the picture is the body (like a profile picture), the name is in the address."""
    user_id, username, password_hash, email = logged_in_user(request)
    name = name.strip()
    if not EMOJI_NAME_PATTERN.fullmatch(name):
        raise HTTPException(400, "Emoji names are 2–32 letters, digits or _.")
    count = db.execute("SELECT COUNT(*) FROM custom_emoji WHERE owner_id = ?", (user_id,)).fetchone()[0]
    if count >= MAX_CUSTOM_EMOJI:
        raise HTTPException(400, f"You have {MAX_CUSTOM_EMOJI} emoji. Delete one to add another.")
    if db.execute("SELECT 1 FROM custom_emoji WHERE name = ?", (name,)).fetchone():
        raise HTTPException(400, f"There's already an emoji called :{name}:.")  # (checked again below)

    file = await receive_picture(request, "emoji")
    try:
        with db:
            db.execute("INSERT INTO custom_emoji (name, file, owner_id) VALUES (?, ?, ?)", (name, file, user_id))
    except sqlite3.IntegrityError:
        # Someone took the name while our picture was uploading: the UNIQUE rule caught it.
        (PICTURE_KINDS["emoji"]["folder"] / file).unlink(missing_ok=True)
        raise HTTPException(400, f"There's already an emoji called :{name}:.")
    await send_to_everyone(custom_emoji_message())  # it appears in everyone's picker
    return {"ok": True}


@router.delete("/custom-emoji/{emoji_id}")
async def delete_custom_emoji(request: Request, emoji_id: int):
    """Delete one of your own custom emoji (admins: anyone's), and the reactions that used it."""
    user_id, username, password_hash, email = logged_in_user(request)
    row = db.execute("SELECT file, owner_id FROM custom_emoji WHERE id = ?", (emoji_id,)).fetchone()
    if row is None or (row[1] != user_id and not is_admin(user_id)):
        raise HTTPException(404, "That's not one of your emoji.")
    reaction = f"custom:{emoji_id}"
    # Which messages had it as a reaction, so their chips can be updated afterwards.
    affected = db.execute(
        "SELECT DISTINCT reactions.message_id, messages.channel FROM reactions "
        "JOIN messages ON messages.id = reactions.message_id WHERE reactions.emoji = ?",
        (reaction,),
    ).fetchall()
    with db:
        db.execute("DELETE FROM reactions WHERE emoji = ?", (reaction,))
        db.execute("DELETE FROM custom_emoji WHERE id = ?", (emoji_id,))
    (PICTURE_KINDS["emoji"]["folder"] / row[0]).unlink(missing_ok=True)

    await send_to_everyone(custom_emoji_message())
    for message_id, channel in affected:
        await send_to_channel(channel, {
            "type": "reactions", "channel": channel, "message_id": message_id,
            "reactions": reactions_for([message_id])[message_id],
        })
    return {"ok": True}


@router.post("/custom-emoji/{emoji_id}/picture")
async def replace_custom_emoji(request: Request, emoji_id: int):
    """A new picture for one of your own custom emoji (admins: anyone's). It keeps its id and name,
    so every message and reaction that uses it shows the new picture."""
    user_id, username, password_hash, email = logged_in_user(request)
    row = db.execute("SELECT owner_id FROM custom_emoji WHERE id = ?", (emoji_id,)).fetchone()
    if row is None or (row[0] != user_id and not is_admin(user_id)):
        raise HTTPException(404, "That's not one of your emoji.")

    folder = PICTURE_KINDS["emoji"]["folder"]
    file = await receive_picture(request, "emoji")
    # Look the old file up only now: someone might have replaced it while ours was uploading.
    old = db.execute("SELECT file FROM custom_emoji WHERE id = ?", (emoji_id,)).fetchone()
    if old is None:  # deleted while ours was uploading
        (folder / file).unlink(missing_ok=True)
        raise HTTPException(404, "That emoji was deleted.")
    with db:
        db.execute("UPDATE custom_emoji SET file = ? WHERE id = ?", (file, emoji_id))
    (folder / old[0]).unlink(missing_ok=True)
    await send_to_everyone(custom_emoji_message())  # everyone's pictures switch to the new file
    return {"ok": True}


@router.get("/custom-emoji/files/{file}")
async def get_custom_emoji(request: Request, file: str):
    """A custom emoji's picture, for logged-in people only."""
    row = db.execute("SELECT 1 FROM custom_emoji WHERE file = ?", (file,)).fetchone()
    if current_user(request) is None or row is None:
        raise HTTPException(404, "Not found.")
    extension = file.rsplit(".", 1)[-1]  # our own table said this name exists, so it's safe to use
    content_type = {ext: type_ for type_, ext in PICTURE_EXTENSIONS.items()}[extension]
    return FileResponse(
        PICTURE_KINDS["emoji"]["folder"] / file,
        media_type=content_type,
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable"},
    )
