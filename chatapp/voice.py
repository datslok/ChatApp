"""Voice: LiveKit tokens for the Lounge and calls, who's in voice, and ringing in DMs and groups."""

import asyncio
import hashlib
import hmac
import json
import time
import urllib.request

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from chatapp.config import LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL
from chatapp.db import db
from chatapp.sessions import logged_in_user
from chatapp.users import blockers_of, is_bot, username_of
from chatapp.access import (
    dm_people, group_members, group_title, is_dm_member, is_group_member, may_use_lounge
)
from chatapp.connections import clients, send, send_to_channel, send_to_user
from chatapp.push import base64url, has_push_on, is_here, push_in_background, stop_ringing_phones
from chatapp.messages import announce_new_message, save_message, with_files

router = APIRouter()


# ---------- Voice ----------

VOICE_ROOMS = ["lounge"]  # voice channels anyone logged in can join (DM calls use the DM's name)
VOICE_TOKEN_LIFETIME = 10 * 60  # seconds: only needed to get in; LiveKit renews it after that


def make_jwt(payload):
    """A JSON Web Token: header.payload.signature, each part base64url. The signature is an HMAC
    (a fingerprint that needs the secret to make) of the first two parts, so anyone can read the
    token, but nobody without LIVEKIT_API_SECRET can change it or make a new one."""
    header = {"alg": "HS256", "typ": "JWT"}  # HS256: HMAC with SHA-256
    signed_part = base64url(json.dumps(header).encode()) + "." + base64url(json.dumps(payload).encode())
    signature = hmac.new(LIVEKIT_API_SECRET.encode(), signed_part.encode(), hashlib.sha256).digest()
    return signed_part + "." + base64url(signature)


def make_voice_token(user_id, name, room):
    """A ticket into one LiveKit room for one person, valid for VOICE_TOKEN_LIFETIME seconds."""
    now = int(time.time())
    return make_jwt({
        "iss": LIVEKIT_API_KEY,  # issued by: tells LiveKit which secret to check the signature with
        "sub": str(user_id),     # who it's for: their "identity" in the room
        "name": name,            # the name the others see
        "nbf": now,              # not valid before
        "exp": now + VOICE_TOKEN_LIFETIME,
        # What they may do there (LiveKit calls it "video", but it covers audio too): join this
        # room, send their own audio and hear the others.
        "video": {"room": room, "roomJoin": True, "canPublish": True, "canSubscribe": True},
    })


def members_in(room):
    """Who's in a voice room (in the order their tabs connected), and whether they're muted or
    deafened (hear nobody): [{"id": 3, "muted": False, "deafened": False}, ...]. Someone in it from
    two tabs is listed once (muted or deafened only if they are in all of them)."""
    members = {}  # user id -> their entry (a dict keeps the order things were added: who came first)
    for client in clients.values():
        if client["voice"] == room:
            member = members.setdefault(client["user_id"], {"id": client["user_id"], "muted": True, "deafened": True})
            member["muted"] = member["muted"] and client["muted"]
            member["deafened"] = member["deafened"] and client["deafened"]
    return list(members.values())


def voice_members_message(user_id):
    """Who's in each voice channel: {"type": "voice_members", "rooms": {"lounge": [...members_in]}}.
    Nothing for someone limited (see channels.py, "Channels"), who has no Lounge."""
    rooms = {room: members_in(room) for room in VOICE_ROOMS} if may_use_lounge(user_id) else {}
    return {"type": "voice_members", "rooms": rooms}


async def announce_voice_members():
    for websocket, client in list(clients.items()):
        await send(websocket, voice_members_message(client["user_id"]))


def remove_from_voice(room, user_id):
    """Throw someone out of a LiveKit room. Closing their chat connection makes their page leave by
    itself, but a page that doesn't play along could stay connected to LiveKit (tickets are only
    checked when joining). LiveKit's own API can remove them: an HTTP request to its RoomService,
    with a short ticket of our own that says we may run that room ("roomAdmin"). Blocking: run it in
    a thread. LiveKit's address for the API is the same as for browsers, with http(s) for ws(s)."""
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        return
    base = LIVEKIT_URL.replace("wss://", "https://", 1).replace("ws://", "http://", 1).rstrip("/")
    now = int(time.time())
    token = make_jwt({"iss": LIVEKIT_API_KEY, "nbf": now, "exp": now + 60, "video": {"room": room, "roomAdmin": True}})
    request = urllib.request.Request(
        base + "/twirp/livekit.RoomService/RemoveParticipant",
        data=json.dumps({"room": room, "identity": str(user_id)}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
    )
    try:
        urllib.request.urlopen(request, timeout=5).close()
    except Exception as error:  # (not in the room any more, for one: LiveKit answers "not found")
        print(f"Couldn't remove user {user_id} from voice room {room}: {error}", flush=True)


def may_join_voice(room, user_id):
    """The Lounge: anyone not limited. A DM's or group's call: only its people (see is_call_member)."""
    if room in VOICE_ROOMS:
        return may_use_lounge(user_id)
    return is_call_member(room, user_id)


# ---------- Calls in DMs and group DMs ----------
#
# A call is a LiveKit room named after the DM or group ("dm:3:7", "g:5f3a9b21"). Our server only
# does the ringing, over the chat's WebSocket:
#   caller's page:     {"type": "call", "channel": "dm:3:7"}                 (and joins the room)
#   the others' tabs:  {"type": "call", "channel": ..., "from": 3, "name": "axel"}  (they ring)
#   one who answers:   {"type": "call_answer", "channel": ..., "accept": true}      (and joins)
#   their tabs (and the caller's, the first time): {"type": "call_answered", "channel": ...}  (the
#                      ringing, or the caller's "Calling…", stops)
#   everyone:          {"type": "call_ended", "channel": ..., "reason": "no_answer"}
# In a DM, declining ends the call. In a group, it only stops your own ringing: the others ring
# until they answer or 30 seconds pass, and the call goes on as long as anyone is in it.
# When it's over, a call note goes into the chat: "📞 Call · 12 min", or "📞 Missed call".

RING_SECONDS = 30

# The calls ringing or going on, by DM or group:
# {"dm:3:7": {"caller": 3, "ringing": {7} (those still being rung), "started": None until someone
#             answered (then the time), "caller_joined": True once the caller's page is in the room,
#             "ring": the 30 s timer}}
calls = {}


def is_private_room(room):
    """A DM's or group's call (not Lounge)?"""
    return isinstance(room, str) and (room.startswith("dm:") or room.startswith("g:"))


def is_call_member(room, user_id):
    """May this person be in this DM's or group's call? The two friends of a DM, or a group's members.
    Never a bot: not one invited to read a DM, nor one added to a group."""
    return is_dm_member(room, user_id) or (is_group_member(room, user_id) and not is_bot(user_id))


def call_people(channel):
    """Everyone a DM's or group's call belongs to: who hears about it."""
    people = dm_people(channel)
    return list(people) if people else group_members(channel)


def dm_call_message(channel):
    """Who's in a DM's or group's call right now, for the call banner and "Join call":
    {"type": "dm_call", "channel": "dm:3:7", "members": [{"id": 7, "muted": false, "deafened": false}]}."""
    return {"type": "dm_call", "channel": channel, "members": members_in(channel)}


async def announce_dm_call(channel):
    """Tell the people of this DM or group (and nobody else) who's in its call."""
    message = dm_call_message(channel)
    for person in call_people(channel):
        await send_to_user(person, message)


def voice_user_ids(room):
    """Everyone whose page says it's in this voice room."""
    return {client["user_id"] for client in clients.values() if client["voice"] == room}


def call_message(channel):
    call = calls[channel]
    return {"type": "call", "channel": channel, "from": call["caller"], "name": username_of(call["caller"])}


async def ring(person, channel):
    """Ring a call where this person is, not on every device they have open:
    - somewhere they are (is_here: looking at the chat, or the Windows app in use): only there (their
      phones get no push then either);
    - nowhere: every page but an idle PC's Windows app (they're away from it, and the push rings their
      phone); a background browser tab still rings, since we can't tell whether they're at that PC;
    - an idle PC is all there is, and no device has push on: there after all, so it reaches someone.
    A device where they turn up while it still rings starts ringing then (server.py, "looking")."""
    theirs = [(websocket, client) for websocket, client in list(clients.items()) if client["user_id"] == person]
    here = [websocket for websocket, client in theirs if is_here(client)]
    if not here:
        here = [websocket for websocket, client in theirs if not client["pc_idle"]]
    if not here and not has_push_on(person):
        here = [websocket for websocket, client in theirs]
    for websocket in here:
        await send(websocket, call_message(channel))


async def start_call(channel, caller):
    if not is_call_member(channel, caller):
        return  # only in your own DMs with friends, and your groups
    call = calls.get(channel)
    if call is not None:
        if caller in call["ringing"]:
            await answer_call(channel, caller, True)  # it rang for them while they called: that's an answer
        return  # already ringing or going on: the page just joins the room
    # Ring everyone else who could join (in a group: not its bots).
    others = {person for person in call_people(channel) if person != caller and is_call_member(channel, person)}
    others -= blockers_of(caller)  # (in a group: who blocked the caller isn't rung)
    calls[channel] = {
        "caller": caller, "ringing": others, "started": None, "caller_joined": False,
        # A background task that ends the call if nobody answers in time. (asyncio runs it while
        # we wait for other things, like the next WebSocket message.)
        "ring": asyncio.create_task(ring_timeout(channel)),
    }
    for person in others:
        await ring(person, channel)  # where they are (not an idle PC while their phone rings)
    # ...and their phones: "high" urgency (wake it now), and gone after the 30 s it rings.
    if channel.startswith("dm:"):
        title, body = username_of(caller), "📞 Calling you"
    else:
        title, body = group_title(channel), f"📞 {username_of(caller)} is calling"
    avatar = db.execute("SELECT avatar_id FROM users WHERE id = ?", (caller,)).fetchone()[0]
    push_in_background(list(others), {
        "title": title, "body": body, "channel": channel, "call": True, "icon": "/icons/icon-192.png",
        # For the phone app's incoming call (its picture is the caller's):
        "kind": "call", "sender": username_of(caller), "sender_id": caller,
        "avatar": f"/avatars/{avatar}" if avatar else None,
    }, ttl=RING_SECONDS, urgency="high")


def stop_ringing(people, channel):
    """Take a ringing call off these people's phones: answered on another device, declined, or over.
    (Their pages stop by themselves, from "call_answered" or "call_ended". Only phones it rang on get
    told: see push.py, rang_phones.)"""
    stop_ringing_phones(people, channel, RING_SECONDS)


async def ring_timeout(channel):
    await asyncio.sleep(RING_SECONDS)
    call = calls.get(channel)
    if call is None:
        return
    if call["started"] is None:
        await end_call(channel, "no_answer")
        return
    # A group call that's going on: those who never answered stop ringing (they can still join).
    stop_ringing(call["ringing"], channel)
    for person in list(call["ringing"]):
        call["ringing"].discard(person)
        await send_to_user(person, {"type": "call_answered", "channel": channel})


async def answer_call(channel, user_id, accept):
    call = calls.get(channel)
    if call is None or user_id not in call["ringing"]:
        return  # not ringing, or not for them
    if not accept and channel.startswith("dm:"):
        await end_call(channel, "declined")  # in a DM, a no ends it
        return
    call["ringing"].discard(user_id)
    await send_to_user(user_id, {"type": "call_answered", "channel": channel})  # all their tabs stop ringing
    stop_ringing([user_id], channel)  # ...and their phones
    if not accept:
        if not call["ringing"] and call["started"] is None:
            await end_call(channel, "declined")  # everyone in the group said no
        return
    if call["started"] is None:  # the first to answer: the call has started
        call["started"] = time.time()
        await send_to_user(call["caller"], {"type": "call_answered", "channel": channel})
    if not call["ringing"]:
        call["ring"].cancel()  # nobody left to ring


async def end_call(channel, reason):
    """reason: "no_answer", "declined", "cancelled" (hung up before an answer) or "ended"."""
    call = calls.pop(channel, None)
    if call is None:
        return
    if call["ring"] is not asyncio.current_task():  # (cancelling ourselves would stop us right here)
        call["ring"].cancel()
    stop_ringing(call["ringing"], channel)  # (those still ringing: their phones too)
    for person in call_people(channel):
        await send_to_user(person, {"type": "call_ended", "channel": channel, "reason": reason})

    if call["started"] is None:
        text = "📞 Declined call" if reason == "declined" else "📞 Missed call"
    else:
        minutes = round((time.time() - call["started"]) / 60)
        text = f"📞 Call · {minutes} min" if minutes >= 1 else "📞 Call · under a minute"
    # The note comes from the caller, and is saved and sent like any message (so it gets unread
    # dots and stays in the history).
    message_id, sent_at = save_message(channel, call["caller"], text, [], None, kind="call")
    message = with_files({
        "type": "message", "channel": channel, "id": message_id, "sent_at": sent_at,
        "user_id": call["caller"], "name": username_of(call["caller"]), "text": text,
        "reply": None, "reactions": [], "edited_at": None, "kind": "call", "pinned": False,
    }, [])
    await send_to_channel(channel, message)
    await announce_new_message(channel)


async def check_call(channel):
    """After someone's voice room changed: has this DM's or group's call been called off, or ended?"""
    call = calls.get(channel)
    if call is None:
        return
    in_room = voice_user_ids(channel)
    if call["started"] is None:  # still ringing
        if call["caller"] in in_room:
            call["caller_joined"] = True
        elif call["caller_joined"]:
            await end_call(channel, "cancelled")  # the caller hung up (or closed the tab)
    elif not in_room:
        await end_call(channel, "ended")  # the last one left


class CallChannel(BaseModel):
    channel: str


@router.post("/calls/decline")
async def decline_call(data: CallChannel, request: Request):
    """Decline on a ringing call's notification in the phone app, which may not even be running (so
    there's no WebSocket to say it with): the same as {"type": "call_answer", "accept": false}."""
    user_id, username, password_hash, email = logged_in_user(request)
    await answer_call(data.channel, user_id, False)
    return {"ok": True}


@router.get("/voice-token")
async def voice_token(room: str, request: Request):
    """Where the LiveKit server is, and a ticket into this voice room. The page asks for this when
    you join voice, and gives both to LiveKit."""
    user_id, username, password_hash, email = logged_in_user(request)
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise HTTPException(503, "Voice isn't set up on this server.")
    if not may_join_voice(room, user_id):
        raise HTTPException(403, "You can't join that voice room.")
    return {"url": LIVEKIT_URL, "token": make_voice_token(user_id, username, room)}
