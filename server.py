import asyncio
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.exception_handlers import http_exception_handler
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.websockets import WebSocketDisconnected

import chatapp.pages
import chatapp.files
import chatapp.web
import chatapp.presence
import chatapp.push
import chatapp.emoji
import chatapp.people
import chatapp.groups
import chatapp.voice
import chatapp.channels
import chatapp.accounts
import chatapp.admin
from chatapp.config import (
    ALLOWED_EMOJI, HISTORY_LIMIT, IMAGE_TYPES, MAX_BIO_LENGTH, MAX_CHANNEL_NAME, MAX_CUSTOM_EMOJI,
    MAX_EMOJI_NAME, MAX_GIF_SIZE, MAX_STATUS_LENGTH, MAX_TEXT_LENGTH, MAX_UPLOAD_SIZE, SESSION_COOKIE,
    VAPID_PUBLIC_KEY
)
from chatapp.db import db, iso_time
from chatapp.sessions import is_admin, user_id_from_token
from chatapp.users import friends_message, is_bot, username_of
from chatapp.access import can_join, can_mute, is_dm_or_group
from chatapp.connections import (
    NONCE_MEMORY, clients, device_of, message_nonce, recent_nonces, send, send_to_channel, send_to_user
)
from chatapp.pages import FreshStaticFiles, LastingStaticFiles, PAGE_VERSION, current_season
from chatapp.files import (
    MAX_FILES_PER_MESSAGE, THUMB_SIZES, claim_attachments, delete_upload, start_repacking
)
from chatapp.web import PREVIEW_DIR, delete_preview, start_preview
from chatapp.presence import (
    IDLE_MINUTES_CHOICES, PRESENCES, announce_presences, clean_activity, idle_minutes_of, phones_away,
    presence_of, start_watching_presences, users_for, users_message
)
from chatapp.push import clear_on_phones, firebase_account, push_message
from chatapp.messages import (
    CHAT_INFO_TABS, MAX_PINS, announce_new_message, chat_activity_message, chat_info, check_reply,
    clean_text, expand_mentions, live_reply_preview, mark_read, messages_around, mutes_message,
    newer_messages, parse_json, pinned_chats_message, pinned_messages, reactions_for, recent_messages,
    save_mentions, save_message, search_messages, unread_channels, unread_mentions, with_files
)
from chatapp.emoji import custom_emoji_exists, custom_emoji_message, expand_custom_emoji
from chatapp.people import blocks_message
from chatapp.groups import MAX_GROUP_SIZE, groups_message
from chatapp.voice import (
    VOICE_ROOMS, announce_dm_call, announce_voice_members, answer_call, call_message, calls, check_call,
    dm_call_message, end_call, is_call_member, is_private_room, may_join_voice, start_call,
    voice_members_message
)
from chatapp.channels import MAX_ROLE_NAME, channels_message, roles_message
from chatapp.accounts import appearance_of
from chatapp.admin import MAX_BAN_REASON, MAX_FEEDBACK_LENGTH


# docs_url etc. = None: turn off FastAPI's automatic API explorer pages (/docs, /redoc),
# handy in development but nothing the public internet needs to see.
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(StarletteHTTPException)
async def errors_are_never_cached(request, error):
    """Every error answer (404 not found, 403, ...) gets "Cache-Control: no-store": never keep it.
    Otherwise Cloudflare may keep a 404 for hours (it adds its own 4 hours to answers that don't
    say), and browsers with it: a file that was briefly missing during an update would stay
    "missing" long after. FastAPI builds the answer as usual; we only add the header.
    (Starlette's HTTPException: the one behind FastAPI's own, which also covers unknown addresses.)"""
    response = await http_exception_handler(request, error)
    response.headers["Cache-Control"] = "no-store"
    return response


# Each topic's routes (chatapp/*.py: each makes an APIRouter, a bundle of routes, that's added here).
app.include_router(chatapp.pages.router)
app.include_router(chatapp.files.router)
app.include_router(chatapp.web.router)
app.include_router(chatapp.presence.router)
app.include_router(chatapp.push.router)
app.include_router(chatapp.emoji.router)
app.include_router(chatapp.people.router)
app.include_router(chatapp.groups.router)
app.include_router(chatapp.voice.router)
app.include_router(chatapp.channels.router)
app.include_router(chatapp.accounts.router)
app.include_router(chatapp.admin.router)

# The chat page's styles and scripts (static/index.html loads them). Only these two folders:
# the rest of static/ is served by its own routes, some of them only when logged in.
app.mount("/static/css", FreshStaticFiles(directory="static/css"), name="css")
app.mount("/static/js", FreshStaticFiles(directory="static/js"), name="js")
app.mount("/landing", FreshStaticFiles(directory="static/landing"), name="landing")  # its pictures
app.mount("/icons", FreshStaticFiles(directory="static/icons"), name="icons")  # the phone app's (manifest.json)
app.mount("/static/seasonal", FreshStaticFiles(directory="static/seasonal"), name="seasonal")  # the seasons' pictures (the Santa hat)
# KaTeX, which draws the $maths$ in messages (messages.js), one fixed version from npm (see CLAUDE.md).
app.mount("/katex-0.18.9", LastingStaticFiles(directory="static/katex-0.18.9"), name="katex")
# Country flags for Windows, whose emoji font has none (chat.css's @font-face; see CLAUDE.md).
app.mount("/flags-0.1.10", LastingStaticFiles(directory="static/flags-0.1.10"), name="flags")
# Noise suppression "Extra strong" (voice.js): DeepFilterNet 3 from npm's @workadventure/noise-suppression
# 0.2.0 (see docs/notes/voice.md). 23 MB (~12 MB as Cloudflare compresses the wasm), fetched only by pages that choose it.
app.mount("/workadventure-ns-0.2.0", LastingStaticFiles(directory="static/workadventure-ns-0.2.0"), name="deepfilternet")


# The limits the pages need to know (to grey out a button or say "too big" before trying), sent
# in "welcome" so this file is the only place they're written. The server still checks each one
# itself: a page's copy is only for being friendly.
LIMITS = {
    "custom_emoji": MAX_CUSTOM_EMOJI,
    "emoji_name": MAX_EMOJI_NAME,
    "upload_size": MAX_UPLOAD_SIZE,
    "files_per_message": MAX_FILES_PER_MESSAGE,  # (also how many files the tray holds)
    "gif_size": MAX_GIF_SIZE,  # profile pictures, banners and emoji (they come whole)
    "image_types": sorted(IMAGE_TYPES),  # (a set isn't JSON)
    "thumb_sizes": THUMB_SIZES,  # the ?size= a picture can be asked for (see files.py, "Thumbnails")
    "group_size": MAX_GROUP_SIZE,
    "channel_name": MAX_CHANNEL_NAME,  # also group names
    "role_name": MAX_ROLE_NAME,
    "status": MAX_STATUS_LENGTH,
    "bio": MAX_BIO_LENGTH,
    "ban_reason": MAX_BAN_REASON,
    "feedback": MAX_FEEDBACK_LENGTH,
    "idle_minutes": IDLE_MINUTES_CHOICES,  # Settings → Notifications' choices (see presence.py, "Away from the PC")
}


@app.websocket("/ws")
async def chat(websocket: WebSocket):
    # The browser sends the session cookie along when it opens the WebSocket.
    user_id = user_id_from_token(websocket.cookies.get(SESSION_COOKIE))
    if user_id is None:
        # Not logged in. Accept first and then close with our own code (4000-4999 are free
        # for apps): if we refused outright, the page couldn't see why, and would keep retrying.
        await websocket.accept()
        await websocket.close(code=4001)
        return

    await websocket.accept()
    # The first connection since the server started starts watching for idle, and re-packs older videos
    # once (see files.py, "Re-packing videos"); later ones find them running.
    start_watching_presences()
    start_repacking()
    # No channel until they "join", no voice room until they say they joined one.
    clients[websocket] = {"user_id": user_id, "channel": None, "voice": None, "muted": False, "deafened": False,
                          "looking": False,  # looking at it right now (the page says, see "looking")
                          "away_since": time.time(),  # since when it isn't (None while it is): for "idle"
                          "app": False,      # the Windows app (the page says so in "looking" too)
                          "pc_idle": False,  # nobody at that PC for a while ("looking" too; presence.py, "Away from the PC")
                          "mobile": False,   # a phone (in "looking" too): see on_phone_only
                          "android": False,  # the Android app, not a phone's browser ("looking" too): device_of
                          "bot": is_bot(user_id),  # a bot gets each message's device (see send)
                          "activity": None,  # what they're doing, if this page says (see "activity")
                          "stuck": False,    # not reading what we send: given up on (see connections.py, "Stuck connections")
                          "task": asyncio.current_task()}  # this chat() call, for stopping it then
    try:
        # Tell the page who it is (the id is for building DM names).
        await send(websocket, {
            "type": "welcome", "id": user_id, "username": username_of(user_id),
            "max_text_length": MAX_TEXT_LENGTH,  # so the page's text box uses the same limit
            "limits": LIMITS,  # the other limits the pages need (see LIMITS)
            "page_version": PAGE_VERSION,  # a different one than it was loaded with: it reloads
            "appearance": appearance_of(user_id),  # Settings → Appearance (None: the defaults)
            "presence": presence_of(user_id),  # the status they chose (the others may see another: users)
            "idle_minutes": idle_minutes_of(user_id),  # away from the PC after (see presence.py, "Away from the PC")
            "vapid_public_key": VAPID_PUBLIC_KEY or None,  # for subscribing to push (None: not set up)
            "phone_push": firebase_account is not None,  # can the phone app get pushes (FCM)?
            "season": current_season(),  # the seasonal easter egg (pages.py, "Seasons"; None: none now)
        })
        await send(websocket, channels_message(user_id))  # (they may have changed while away)
        await send(websocket, friends_message(user_id))
        await send(websocket, groups_message(user_id))
        await send(websocket, mutes_message(user_id))
        await send(websocket, pinned_chats_message(user_id))  # (see messages.py, "Recent and pinned DMs")
        await send(websocket, chat_activity_message(user_id))
        await send(websocket, blocks_message(user_id))
        await send(websocket, roles_message(user_id))  # (before "users", whose roles refer to these)
        await send(websocket, custom_emoji_message())
        await send(websocket, {
            "type": "unread", "channels": unread_channels(user_id), "mentions": unread_mentions(user_id),
        })
        await send(websocket, users_for(user_id, users_message()))  # this tab
        await announce_presences()  # and everyone, if this changed what they see (they came online)
        await send(websocket, voice_members_message(user_id))  # who's in the voice channels right now
        # Their DM and group calls that someone is in right now (so the banner can offer "Join call").
        private_rooms = {c["voice"] for c in clients.values() if is_private_room(c["voice"])}
        for room in private_rooms:
            if is_call_member(room, user_id):
                await send(websocket, dm_call_message(room))
        for channel, call in list(calls.items()):  # opened while someone is calling them: ring here too
            if user_id in call["ringing"]:
                await send(websocket, call_message(channel))

        while True:
            data = parse_json(await websocket.receive_text())
            if data is None:
                continue  # ignore invalid messages
            kind = data.get("type")
            channel = clients[websocket]["channel"]

            if kind == "ping":
                # {"type": "ping"}: the app checking the connection still works (a bad network can kill
                # it without either end hearing). The answer proves it does.
                await send(websocket, {"type": "pong"})

            elif kind == "join":
                new_channel = data.get("channel")
                if new_channel is None:
                    # Looking at no channel (the Friends page): new messages anywhere count as unread.
                    clients[websocket]["channel"] = None
                    if clients[websocket]["looking"]:
                        clear_on_phones(user_id, "friends")  # (the friend requests are on that page)
                    continue
                if not can_join(new_channel, user_id):
                    continue
                # Switch channel and fetch its history with no await in between,
                # so no message can slip through the gap.
                clients[websocket]["channel"] = new_channel
                history = recent_messages(new_channel)
                # Where they stopped reading (read before mark_read moves it): the page draws a
                # "New messages" divider above the first message after it. None: never opened.
                seen = db.execute(
                    "SELECT message_id FROM last_read WHERE user_id = ? AND channel = ?", (user_id, new_channel)
                ).fetchone()
                mark_read(user_id, new_channel)  # opening a channel means you've seen it
                # Seen, if the page is in sight (a page in the background also rejoins after a dropped
                # connection: then it's when they look at it, "looking" below).
                if clients[websocket]["looking"]:
                    clear_on_phones(user_id, new_channel)
                # "more": a full batch, so there may be older messages to load by scrolling up.
                more = len(history) == HISTORY_LIMIT
                await send(websocket, {
                    "type": "history", "channel": new_channel, "messages": history, "more": more,
                    "last_read": seen[0] if seen else None,
                })

            elif kind == "older" and channel is not None:
                # {"type": "older", "before": 1234}: scrolled to the top, so send the messages just
                # before message 1234 in the channel we're in. Checked like everything else: a whole
                # number (True counts as an int in Python, so rule that out) that SQLite can hold,
                # and a channel we may still read (a DM stops being allowed when the friendship ends).
                before = data.get("before")
                if not isinstance(before, int) or isinstance(before, bool) or not 0 < before < 2**63:
                    continue
                if not can_join(channel, user_id):
                    continue
                older = recent_messages(channel, before)
                more = len(older) == HISTORY_LIMIT
                await send(websocket, {"type": "older", "channel": channel, "messages": older, "more": more})

            elif kind in ("around", "newer") and channel is not None:
                # {"type": "around", "id": 1234}: jumping to message 1234, far up: the messages around it
                # (messages_around). {"type": "newer", "after": 1234}: scrolling down from there, the next
                # batch. Checked like "older".
                number = data.get("id" if kind == "around" else "after")
                if not isinstance(number, int) or isinstance(number, bool) or not 0 < number < 2**63:
                    continue
                if not can_join(channel, user_id):
                    continue
                if kind == "around":
                    stretch, more, newer = messages_around(channel, number)
                    await send(websocket, {"type": "around", "channel": channel, "id": number,
                                           "messages": stretch, "more": more, "newer": newer})
                else:
                    batch = newer_messages(channel, number)
                    await send(websocket, {"type": "newer", "channel": channel, "messages": batch,
                                           "newer": len(batch) == HISTORY_LIMIT})

            elif kind == "message" and (channel is not None or data.get("channel") is not None):
                # The chat we're in, or the one the message names (the app's outbox sends a message again
                # after a reconnect, from whatever chat is open by then). Checked again, not just when
                # joining: a DM stops being allowed the moment the friendship ends, even if this tab is still showing it.
                if data.get("channel") is not None:
                    channel = data.get("channel")
                # A tag (the app's outbox): seen before means it's saved already, so only confirm it again.
                nonce = message_nonce(data)
                now = time.time()
                for key in [key for key, (_, _, when) in recent_nonces.items() if now - when > NONCE_MEMORY]:
                    del recent_nonces[key]
                if nonce is not None and (user_id, nonce) in recent_nonces:
                    message_id, sent_channel, _ = recent_nonces[(user_id, nonce)]
                    await send(websocket, {"type": "sent", "nonce": nonce, "id": message_id, "channel": sent_channel})
                    continue
                text = clean_text(data) if can_join(channel, user_id) else None
                # The files: "files", a list of upload ids; or "file", one (from before several per message).
                # (An empty list is no files: the phone app sends "files": [] with every text message.)
                file_ids = data.get("files") if data.get("file") is None else [data.get("file")]
                files = []
                if text is not None and file_ids not in (None, []):
                    files = claim_attachments(file_ids, user_id, channel)  # (None: not theirs, already sent, gone)
                if text is None or files is None or (not text and not files):
                    # Refused (or nothing to send): an outbox's message shows as not sent straight away.
                    if nonce is not None:
                        await send(websocket, {"type": "not_sent", "nonce": nonce})
                    continue
                text = expand_custom_emoji(text)  # :pog: -> <:17>
                text, mentioned, everyone = expand_mentions(text)  # @kari -> <@2>
                reply_to = check_reply(data.get("reply_to"), channel)
                sent_from = device_of(clients[websocket])
                message_id, sent_at = save_message(channel, user_id, text, files, reply_to, sent_from=sent_from)
                mentioned_people = save_mentions(message_id, channel, user_id, mentioned, everyone)
                # The name comes from the login (looked up now, so it's always the current one),
                # never from the client.
                message = with_files({
                    "type": "message", "channel": channel, "id": message_id, "sent_at": sent_at,
                    "user_id": user_id, "name": username_of(user_id), "text": text,
                    "reply": live_reply_preview(reply_to),
                    "reactions": [],  # a brand new message has none yet
                    "edited_at": None,
                    "kind": None,
                    "pinned": False,
                    "preview": None,  # a link's preview comes a moment later, as its own "preview"
                    "nonce": nonce,  # the app's tag (or None): its faded copy in the outbox goes as this comes
                    "sent_from": sent_from,  # (bots only, see send)
                }, files)
                await send_to_channel(channel, message)  # everyone in the channel, including us
                if nonce is not None:
                    # Saved: tell the page that sent it (even if it's in another chat by now), with its tag.
                    recent_nonces[(user_id, nonce)] = (message_id, channel, now)
                    await send(websocket, {"type": "sent", "nonce": nonce, "id": message_id, "channel": channel})
                await announce_new_message(channel, mentioned_people, message)  # read/unread, mentions, notifications
                push_message(mentioned_people, message)  # their phones, if they're not looking at the chat
                start_preview(message_id, channel, user_id, text)  # in the background, if it has a link

            elif kind == "react":
                # {"type": "react", "message_id": 57, "emoji": "👍"}: add our reaction, or remove it
                # if it's already there (a toggle).
                message_id = data.get("message_id")
                emoji = data.get("emoji")
                if not isinstance(message_id, int) or isinstance(message_id, bool):
                    continue
                # A Unicode emoji from the list, or a custom one ("custom:17") that exists.
                if not isinstance(emoji, str) or not (emoji in ALLOWED_EMOJI or custom_emoji_exists(emoji)):
                    continue
                row = db.execute("SELECT channel FROM messages WHERE id = ?", (message_id,)).fetchone()
                if row is None or not can_join(row[0], user_id):
                    continue  # no such message, or one we're not allowed to see (someone else's DM)
                message_channel = row[0]
                with db:
                    cursor = db.execute(
                        "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
                        (message_id, user_id, emoji),
                    )
                    if cursor.rowcount == 0:  # nothing was deleted, so it wasn't there yet: add it
                        db.execute(
                            "INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)",
                            (message_id, user_id, emoji),
                        )
                # Everyone looking at that channel gets the message's new reactions.
                await send_to_channel(message_channel, {
                    "type": "reactions", "channel": message_channel, "message_id": message_id,
                    "reactions": reactions_for([message_id])[message_id],
                })

            elif kind in ("edit", "delete"):
                # {"type": "edit", "message_id": 57, "text": "..."} or {"type": "delete", "message_id": 57}
                message_id = data.get("message_id")
                if not isinstance(message_id, int) or isinstance(message_id, bool):
                    continue
                row = db.execute("SELECT channel, user_id, kind FROM messages WHERE id = ?", (message_id,)).fetchone()
                if row is None:
                    continue
                message_channel, author_id, message_kind = row
                file_ids = [file_id for (file_id,) in db.execute(
                    "SELECT id FROM attachments WHERE message_id = ?", (message_id,))]
                if kind == "edit" and message_kind is not None:
                    continue  # call notes are written by the server, not edited
                if not can_join(message_channel, user_id):
                    continue  # a message we can't even see
                if author_id != user_id and not is_admin(user_id):
                    continue  # only your own messages, unless you're an admin

                if kind == "edit":
                    text = clean_text(data)
                    if text is None or (not text and not file_ids):
                        continue  # too long, or empty without a file to keep the message
                    text = expand_custom_emoji(text)  # :pog: -> <:17>, as for new messages
                    text, mentioned, everyone = expand_mentions(text)
                    with db:
                        db.execute(
                            "UPDATE messages SET text = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?",
                            (text, message_id),
                        )
                    # The mentions follow the new text (an edit doesn't send new unread counts, like Discord).
                    save_mentions(message_id, message_channel, author_id, mentioned, everyone)
                    edited_at = db.execute("SELECT edited_at FROM messages WHERE id = ?", (message_id,)).fetchone()[0]
                    await send_to_channel(message_channel, {
                        "type": "edited", "channel": message_channel, "message_id": message_id,
                        "text": text, "edited_at": iso_time(edited_at),
                    })
                else:
                    # Delete the message with everything that belongs to it, in one transaction.
                    with db:
                        db.execute("DELETE FROM reactions WHERE message_id = ?", (message_id,))
                        db.execute("DELETE FROM mentions WHERE message_id = ?", (message_id,))
                        preview_image = delete_preview(message_id)
                        db.execute("DELETE FROM attachments WHERE message_id = ?", (message_id,))
                        db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
                    for file_id in file_ids:  # the files on disk, only once the database change has been saved
                        delete_upload(file_id)
                    if preview_image:
                        (PREVIEW_DIR / preview_image).unlink(missing_ok=True)
                    # (Replies to it keep their reply_to; their quote now says "deleted".)
                    await send_to_channel(message_channel, {
                        "type": "deleted", "channel": message_channel, "message_id": message_id,
                    })

            elif kind == "pin":
                # {"type": "pin", "message_id": 57, "pinned": true}: pin a message, or unpin it (false).
                # Anyone who can see it may (a chat of friends), but not the server's own notes.
                message_id = data.get("message_id")
                if not isinstance(message_id, int) or isinstance(message_id, bool):
                    continue
                row = db.execute("SELECT channel, kind, pinned_at FROM messages WHERE id = ?", (message_id,)).fetchone()
                if row is None or not can_join(row[0], user_id) or row[1] is not None:
                    continue
                message_channel, _, pinned_at = row
                pin = data.get("pinned") is True
                if pin == (pinned_at is not None):
                    continue  # it already is (pinned twice at once from two tabs, say)
                if pin:
                    count = db.execute("SELECT COUNT(*) FROM messages WHERE channel = ? AND pinned_at IS NOT NULL",
                                       (message_channel,)).fetchone()[0]
                    if count >= MAX_PINS:
                        await send(websocket, {"type": "pins_full", "channel": message_channel, "max": MAX_PINS})
                        continue
                with db:
                    db.execute(
                        "UPDATE messages SET pinned_at = CASE WHEN ? THEN CURRENT_TIMESTAMP END, pinned_by = ? WHERE id = ?",
                        (pin, user_id if pin else None, message_id),
                    )
                await send_to_channel(message_channel, {
                    "type": "pinned", "channel": message_channel, "message_id": message_id, "pinned": pin,
                })
                if pin:
                    # A note in the chat, quoting the message, so everyone notices (like Discord). Saved and
                    # sent like any message, so it gets unread dots; like a call note, it can't be edited.
                    note_id, sent_at = save_message(message_channel, user_id, "📌 pinned a message.", [], message_id, kind="pin")
                    await send_to_channel(message_channel, with_files({
                        "type": "message", "channel": message_channel, "id": note_id, "sent_at": sent_at,
                        "user_id": user_id, "name": username_of(user_id), "text": "📌 pinned a message.",
                        "reply": live_reply_preview(message_id), "reactions": [],
                        "edited_at": None, "kind": "pin", "pinned": False, "preview": None,
                    }, []))
                    await announce_new_message(message_channel)

            elif kind == "search":
                # {"type": "search", "query": "pizza", "channel": "general" (or null: everywhere),
                # "from": 3 (or null: anyone), "ask": 7}. "ask" comes back, so the page can ignore the
                # answer to an older search (typing fast sends several).
                query = data.get("query") if isinstance(data.get("query"), str) else ""
                chat = data.get("channel") if isinstance(data.get("channel"), str) else None
                author = data.get("from")
                if not isinstance(author, int) or isinstance(author, bool):
                    author = None
                ask = data.get("ask") if isinstance(data.get("ask"), int) else None
                await send(websocket, {"type": "search_results", "ask": ask,
                                       "results": search_messages(user_id, query[:200], chat, author)})

            elif kind == "pins" and channel is not None:
                # {"type": "pins"}: the pinned messages of the channel we're in (the 📌 list).
                if can_join(channel, user_id):
                    await send(websocket, {"type": "pins", "channel": channel, "messages": pinned_messages(channel)})

            elif kind == "chat_info" and channel is not None:
                # {"type": "chat_info", "tab": "media" | "files" | "links", "before": a message id or null}:
                # the chat info panel of the DM or group we're in (messages.py, "Chat info"). The answer
                # repeats tab and before, so the page knows which question it answers.
                tab = data.get("tab")
                before = data.get("before")
                if not isinstance(before, int) or isinstance(before, bool):  # (True is an int in Python)
                    before = None
                if tab in CHAT_INFO_TABS and is_dm_or_group(channel) and can_join(channel, user_id):
                    await send(websocket, {"type": "chat_info", "channel": channel, "tab": tab, "before": before,
                                           **chat_info(channel, tab, before)})

            elif kind == "typing" and channel is not None:
                # Tell the others in this channel; you don't need to see yourself typing.
                await send_to_channel(
                    channel, {"type": "typing", "channel": channel, "name": username_of(user_id)},
                    except_user_id=user_id,
                )

            elif kind == "voice":
                # The page joined a voice room ({"room": "lounge"}), left it ({"room": null}), or
                # muted, unmuted or deafened ({"muted": true, "deafened": false}). Only for showing
                # who's in voice: getting into the audio itself still needs a ticket from /voice-token.
                room = data.get("room")
                if room is not None and not may_join_voice(room, user_id):
                    continue  # not a room they may be in
                old_room = clients[websocket]["voice"]
                clients[websocket]["voice"] = room
                clients[websocket]["muted"] = data.get("muted") is True
                clients[websocket]["deafened"] = data.get("deafened") is True
                # Everyone sees who's in the voice channels; DM and group calls stay private.
                if old_room in VOICE_ROOMS or room in VOICE_ROOMS:
                    await announce_voice_members()
                for changed in {old_room, room}:
                    if is_private_room(changed):
                        await announce_dm_call(changed)  # its people see who's in their call
                    if changed in calls:  # a call may have been called off, or ended
                        await check_call(changed)

            elif kind == "looking":
                # {"type": "looking", "looking": true}: the page is in sight and has the focus (or
                # not any more). Nobody gets a push while they're looking at the chat somewhere.
                looking = data.get("looking") is True
                looking_changed = looking != clients[websocket]["looking"]
                if looking_changed:
                    clients[websocket]["away_since"] = None if looking else time.time()
                clients[websocket]["looking"] = looking
                clients[websocket]["app"] = data.get("app") is True  # (then no pushes at all: has_app_open)
                clients[websocket]["android"] = data.get("android") is True
                # "idle": the Windows app's keyboard and mouse unused for the person's minutes (only the app can tell)
                pc_idle = data.get("idle") is True and clients[websocket]["app"]
                idle_changed = pc_idle != clients[websocket]["pc_idle"]
                clients[websocket]["pc_idle"] = pc_idle
                mobile = data.get("mobile") is True
                phone_changed = mobile != clients[websocket]["mobile"]
                clients[websocket]["mobile"] = mobile
                # A phone back after its connection closed while locked: this connection takes over. Still
                # away (Android woke it in the background)? Then away since it was locked, not since now.
                left_at = phones_away.pop(user_id, None) if mobile else None
                if left_at is not None and not looking:
                    clients[websocket]["away_since"] = min(left_at, clients[websocket]["away_since"] or left_at)
                if looking_changed or phone_changed or idle_changed:
                    await announce_presences()  # back from idle, a phone locked (idle), now known to be a phone
                if looking and not pc_idle:  # back at the page: the chat on it has been seen (or the People page)
                    clear_on_phones(user_id, clients[websocket]["channel"] or "friends")

            elif kind == "activity":
                # {"type": "activity", "activity": {"kind": "playing", "name": "Hollow Knight"} or null}:
                # what the Windows app sees them doing. "since" is when this one started: kept while
                # the same thing goes on, so their profile can say "for 23 min".
                activity = clean_activity(data.get("activity"))
                old = clients[websocket]["activity"]
                old_without_since = {key: value for key, value in old.items() if key != "since"} if old else None
                if activity != old_without_since:
                    if activity is not None:
                        activity["since"] = int(time.time())
                    clients[websocket]["activity"] = activity
                    await announce_presences()

            elif kind == "mute":
                # {"type": "mute", "channel": "memes", "muted": true}: mute a chat for ourselves (or unmute).
                # All our pages hear the new list.
                chat = data.get("channel")
                if not isinstance(chat, str):
                    continue
                if data.get("muted") is True:
                    if not can_mute(chat, user_id):
                        continue  # not a chat of theirs, or a DM with an admin
                    with db:
                        db.execute("INSERT OR IGNORE INTO chat_mutes (user_id, channel) VALUES (?, ?)", (user_id, chat))
                else:
                    with db:
                        db.execute("DELETE FROM chat_mutes WHERE user_id = ? AND channel = ?", (user_id, chat))
                await send_to_user(user_id, mutes_message(user_id))

            elif kind == "pin_chat":
                # {"type": "pin_chat", "channel": "dm:3:7", "pinned": true}: pin a DM or group to the top of
                # our list (or unpin it). All our pages hear the new list.
                chat = data.get("channel")
                if not is_dm_or_group(chat):
                    continue
                if data.get("pinned") is True:
                    if not can_join(chat, user_id):
                        continue  # not a chat of theirs
                    with db:
                        db.execute("INSERT OR IGNORE INTO pinned_chats (user_id, channel) VALUES (?, ?)", (user_id, chat))
                else:
                    with db:
                        db.execute("DELETE FROM pinned_chats WHERE user_id = ? AND channel = ?", (user_id, chat))
                await send_to_user(user_id, pinned_chats_message(user_id))

            elif kind == "presence":
                # {"type": "presence", "presence": "dnd"}: the status they choose. All their pages hear it,
                # and everyone sees the new one.
                presence = data.get("presence")
                if presence not in PRESENCES:
                    continue
                with db:
                    db.execute("UPDATE users SET presence = ? WHERE id = ?", (presence, user_id))
                await send_to_user(user_id, {"type": "my_presence", "presence": presence})
                await announce_presences()

            elif kind == "call":
                await start_call(data.get("channel"), user_id)

            elif kind == "call_answer":
                await answer_call(data.get("channel"), user_id, data.get("accept") is True)

            elif kind == "call_cancel":
                # The caller hung up before an answer (also when their page never got into the room).
                call = calls.get(data.get("channel"))
                if call is not None and call["caller"] == user_id and call["started"] is None:
                    await end_call(data.get("channel"), "cancelled")
    except (WebSocketDisconnect, WebSocketDisconnected):
        pass  # closed (WebSocketDisconnected: a send to it had already failed, so starlette knew first)
    except asyncio.CancelledError:
        if not clients[websocket]["stuck"]:
            raise  # (the server is shutting down)
        # send() gave up on it (see connections.py, "Stuck connections"): it ends here, cleaned up below.
    finally:
        voice_room = clients[websocket]["voice"]
        gone = clients.pop(websocket)
        # A phone's connection closing while it was locked or left (Android cuts it): still idle for a
        # while, from when it was locked (see presence.py, "Statuses"). Not when it closed with the app on screen (logging
        # out, a dropped network in use: back in a moment, or really gone).
        if gone["mobile"] and gone["away_since"] is not None:
            phones_away[user_id] = max(gone["away_since"], phones_away.get(user_id, 0))
        await announce_presences()  # their last tab: they went offline (or another tab of theirs decides now)
        if voice_room in VOICE_ROOMS:  # closed the tab while in voice: they're out
            await announce_voice_members()
        if is_private_room(voice_room):  # ...or out of a DM's or group's call
            await announce_dm_call(voice_room)
        if voice_room in calls:
            await check_call(voice_room)
