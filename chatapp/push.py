"""Push notifications: Web Push for the PWA and Firebase Cloud Messaging for the Android app."""

import asyncio
import base64
import json
import re
import time
import urllib.request
from email.utils import parseaddr
from urllib.parse import urlencode, urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from pywebpush import WebPushException, webpush

from chatapp.config import FIREBASE_KEY_FILE, MAIL_FROM, VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY
from chatapp.db import db
from chatapp.sessions import logged_in_user
from chatapp.access import channel_name, group_title
from chatapp.users import is_bot
from chatapp.connections import background_tasks, clients, device_of
from chatapp.files import files_note
from chatapp.presence import presence_of

router = APIRouter()


# ---------- Push notifications (the phone app) ----------
#
# A device that turns them on (Settings → Notifications) gives us a "subscription": an address at
# its push service (the endpoint) and two keys to encrypt pushes for it. We keep one row per device.
#
# In 2b we'll send requests to those endpoints, so only the real push services are accepted:
# otherwise anyone could make our server visit any address, even inside our own network ("SSRF").

PUSH_SERVICE_HOSTS = (
    "fcm.googleapis.com",          # Chrome, Edge and other Chromium browsers on Android and PCs
    ".push.apple.com",             # Safari (iPhones, Macs)
    ".push.services.mozilla.com",  # Firefox
    ".notify.windows.com",         # Edge on Windows
)


def is_push_service(endpoint):
    """True for an https address at one of the push services above (".x" means x and anything under it)."""
    parts = urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    known = False
    for name in PUSH_SERVICE_HOSTS:
        if host == name or (name.startswith(".") and host.endswith(name)):
            known = True
    return parts.scheme == "https" and known and len(endpoint) <= 1000


class PushSubscription(BaseModel):
    endpoint: str
    p256dh: str = ""  # (not needed to unsubscribe)
    auth: str = ""


@router.post("/push/subscribe")
async def push_subscribe(data: PushSubscription, request: Request):
    user_id, username, password_hash, email = logged_in_user(request)
    if not VAPID_PUBLIC_KEY:
        raise HTTPException(400, "Push notifications aren't set up on this server.")
    if not is_push_service(data.endpoint):
        raise HTTPException(400, "That isn't a push service we know.")
    if not (0 < len(data.p256dh) <= 200 and 0 < len(data.auth) <= 100):
        raise HTTPException(400, "Those keys don't look right.")
    with db:
        # "OR REPLACE": the same device again (or someone else logged in on it): this row replaces it.
        db.execute(
            "INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)",
            (data.endpoint, user_id, data.p256dh, data.auth),
        )
    return {"ok": True}


@router.post("/push/unsubscribe")
async def push_unsubscribe(data: PushSubscription, request: Request):
    user_id, username, password_hash, email = logged_in_user(request)
    with db:
        db.execute("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", (data.endpoint, user_id))
    return {"ok": True}


class PushMute(BaseModel):
    endpoint: str
    until: float | None = None  # a Unix time in seconds; None = not muted (far future = until turned back on)


@router.post("/push/mute")
async def push_mute(data: PushMute, request: Request):
    """"Mute notifications" in Settings, for this device's pushes (the page keeps its own copy)."""
    user_id, username, password_hash, email = logged_in_user(request)
    with db:
        db.execute(
            "UPDATE push_subscriptions SET muted_until = ? WHERE endpoint = ? AND user_id = ?",
            (data.until, data.endpoint, user_id),
        )
    return {"ok": True}


# ----- The native phone app: Firebase Cloud Messaging (FCM) -----
#
# The app has no service worker. Instead it registers with Firebase on the phone and gets a "token":
# that phone's address at FCM, which it gives us (/push/fcm) at every connect. We keep it in
# push_subscriptions like a browser's subscription, as "fcm:<token>", so muting, unsubscribing and
# send_push's rules (not while looking, not on Do Not Disturb) work the same for both.
#
# Sending is one HTTPS request to Google per push. It must carry an access token that proves we're
# this Firebase project. We get one (good for an hour) by signing a small JWT with the service
# account's private key and trading it in at Google. Unlike make_jwt's HMAC (one shared secret), this
# is RS256: an RSA signature, which Google checks with the public half of the key it keeps.

firebase_account = json.loads(FIREBASE_KEY_FILE.read_text()) if FIREBASE_KEY_FILE.exists() else None
firebase_access = {"token": None, "expires": 0}  # the current access token, and when it runs out
FCM_TOKEN = re.compile(r"[\w:-]{20,4096}")  # what a token looks like (letters, digits, _ : -)
FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"  # all we ask permission for: sending


def firebase_access_token():
    """An access token for FCM: the one we have, or a new one if it runs out within a minute."""
    if time.time() < firebase_access["expires"] - 60:
        return firebase_access["token"]
    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    claims = {
        "iss": firebase_account["client_email"],  # who's asking: the service account
        "scope": FCM_SCOPE,
        "aud": firebase_account["token_uri"],      # for Google's token address only
        "iat": now,
        "exp": now + 3600,
    }
    signed_part = base64url(json.dumps(header).encode()) + "." + base64url(json.dumps(claims).encode())
    key = serialization.load_pem_private_key(firebase_account["private_key"].encode(), password=None)
    signature = key.sign(signed_part.encode(), padding.PKCS1v15(), hashes.SHA256())
    form = urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",  # "here's a signed JWT, give me a token"
        "assertion": signed_part + "." + base64url(signature),
    }).encode()
    with urllib.request.urlopen(firebase_account["token_uri"], data=form, timeout=10) as response:
        answer = json.load(response)
    firebase_access.update(token=answer["access_token"], expires=time.time() + answer["expires_in"])
    return answer["access_token"]


class FcmTokenGone(Exception):
    """FCM says this token isn't anyone's any more (the app was uninstalled, or got a new token)."""


def send_fcm(token, payload, ttl):
    """One push to one phone. Run it in a thread: it waits for Google's answer. A "data message": the
    app's own code (mobile/modules/push) makes the notification from it, so every value is text."""
    message = {
        "token": token,
        "data": {key: str(value) for key, value in payload.items() if value is not None},
        # HIGH: deliver at once, even to a sleeping phone (Google allows it for pushes that show a
        # notification). "read" shows nothing (it takes one away), so it's NORMAL: Google may hold it
        # until the phone wakes, which is soon enough. ttl: how long FCM keeps trying a phone that's off.
        "android": {"priority": "NORMAL" if payload.get("kind") == "read" else "HIGH", "ttl": f"{ttl}s"},
    }
    request = urllib.request.Request(
        f"https://fcm.googleapis.com/v1/projects/{firebase_account['project_id']}/messages:send",
        data=json.dumps({"message": message}).encode(),
        headers={"Authorization": "Bearer " + firebase_access_token(), "Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(request, timeout=10).close()
    except urllib.error.HTTPError as error:
        if error.code == 404:  # "UNREGISTERED"
            raise FcmTokenGone() from error
        raise Exception(f"{error.code} {error.read()[:300]!r}") from error


class PhonePush(BaseModel):
    token: str


@router.post("/push/fcm")
async def push_fcm(data: PhonePush, request: Request):
    """The phone app's FCM token: pushes go to this phone from now on (until /push/unsubscribe)."""
    user_id, username, password_hash, email = logged_in_user(request)
    if firebase_account is None:
        raise HTTPException(400, "Push notifications for the app aren't set up on this server.")
    if not FCM_TOKEN.fullmatch(data.token):
        raise HTTPException(400, "That doesn't look like a token.")
    with db:
        # Sent at every connect, so an existing row stays as it is (its mute too), unless someone else
        # logged in on that phone: then it's theirs, unmuted.
        db.execute(
            "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, '', '')"
            " ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id,"
            " muted_until = CASE WHEN user_id = excluded.user_id THEN muted_until END",
            ("fcm:" + data.token, user_id),
        )
    return {"ok": True}


# Sending. A push service only passes a push on: pywebpush encrypts it for that one browser (with
# the subscription's keys) and signs it with our private key. "sub" says who we are, for the push
# service to contact if our pushes cause trouble: an email address, from MAIL_FROM.
PUSH_CLAIMS_SUBJECT = "mailto:" + parseaddr(MAIL_FROM)[1]
PUSH_TEXT_LENGTH = 200  # the start of a message is enough (and a push may be at most about 4 KB)


def readable_text(text):
    """A message's text as it was typed: <@2> back to @kari, <@everyone> to @everyone, <:17> to :pog:."""
    names = dict(db.execute("SELECT id, username FROM users"))
    emoji = dict(db.execute("SELECT id, name FROM custom_emoji"))
    text = text.replace("<@everyone>", "@everyone")
    text = re.sub(r"<@(\d+)>", lambda match: "@" + names.get(int(match[1]), "someone"), text)
    return re.sub(r"<:(\d+)>", lambda match: ":" + emoji.get(int(match[1]), "emoji") + ":", text)


def is_here(client):
    """Whether this connection is where its person is right now: looking at the chat, or the Windows
    app with someone at the PC (an idle PC counts for nothing). Calls ring only here when there is
    such a place (voice.py, ring), and pushes stay away meanwhile (why_no_push)."""
    return not client["pc_idle"] and (client["looking"] or client["app"])


def has_push_on(user_id):
    """Whether any of this person's devices has push on and isn't muted (a push could reach them)."""
    return db.execute(
        "SELECT 1 FROM push_subscriptions WHERE user_id = ? AND (muted_until IS NULL OR muted_until < ?)",
        (user_id, time.time()),
    ).fetchone() is not None


def why_no_push(user_id):
    """Why this person gets no push right now, in words for the log, or None: they get one.
    - Looking at the chat on any device (each page says so: "looking"): they see it there.
    - The Windows app open (focused or not) and someone at the PC lately: it notifies by itself, so
      their phones stay quiet meanwhile. (The page says it's the app in its "looking" messages, and
      when nobody has been at the PC for a while: see presence.py, "Away from the PC".)
    - Do Not Disturb."""
    for client in clients.values():
        if client["user_id"] != user_id or not is_here(client):
            continue
        if client["looking"]:
            return f"looking at the chat in the {device_of(client)}"
        return "the Windows app is open and the PC in use"
    if presence_of(user_id) == "dnd":
        return "Do Not Disturb"
    return None


# The log (since 2026-11-26): a push that should notify (a message, a friend request, a call) writes one
# line per person, sent or not and why, so "I got no notification" can be looked up in chat.out.log instead of
# guessed at. Ids and names only, never the message.
LOGGED_KINDS = ("message", "friend", "call")


def log_push(user_id, payload, outcome):
    name = (db.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone() or ["?"])[0]
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} push {payload.get('kind')} in {payload.get('channel')}"
          f" for {name} ({user_id}): {outcome}", flush=True)


async def send_push(user_ids, payload, ttl=24 * 60 * 60, urgency="normal", always=False):
    """Push this to every device of these people that turned push on and isn't muted, unless they
    shouldn't get one now (why_no_push: looking at the chat somewhere, the Windows app in use, Do Not
    Disturb). ttl: how many seconds the push service keeps trying a phone that's off or offline. Run it
    as a background task: each push service takes a moment to answer, and the chat mustn't wait for that.
    always: to all of them, whatever they're doing, and only to the phone app: for taking a ringing
    call off their phones (a browser's notification can't be taken back by a push)."""
    logged = not always and payload.get("kind") in LOGGED_KINDS
    if not always:
        wanted = []
        for user_id in user_ids:
            reason = why_no_push(user_id)
            if reason is None:
                wanted.append(user_id)
            elif logged and not is_bot(user_id):
                log_push(user_id, payload, "not sent, " + reason)
        user_ids = wanted
    if not user_ids:
        return
    marks = ",".join("?" * len(user_ids))  # "?,?,?": one placeholder per person
    rows = db.execute(
        f"SELECT endpoint, p256dh, auth, user_id FROM push_subscriptions WHERE user_id IN ({marks})"
        + ("" if always else " AND (muted_until IS NULL OR muted_until < ?)"),
        (*user_ids,) if always else (*user_ids, time.time()),
    ).fetchall()
    if logged:
        for user_id in set(user_ids) - {row[3] for row in rows}:
            if not is_bot(user_id):
                log_push(user_id, payload, "not sent, no device with push on (or all muted)")
    data = json.dumps(payload)
    for endpoint, p256dh, auth, user_id in rows:
        if endpoint.startswith("fcm:"):  # the phone app
            if firebase_account is None:
                continue
            try:
                await asyncio.to_thread(send_fcm, endpoint.removeprefix("fcm:"), payload, ttl)
                if logged:
                    log_push(user_id, payload, "sent to the phone app")
                if payload.get("kind") in ("message", "friend"):
                    on_phones.add((user_id, payload["channel"]))
                elif payload.get("kind") == "call":
                    rang_phones.add((user_id, payload["channel"]))
            except FcmTokenGone:
                with db:
                    db.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
                if logged:
                    log_push(user_id, payload, "not sent, the phone app's token is gone (uninstalled?), forgotten")
            except Exception as error:
                if logged:
                    log_push(user_id, payload, f"to the phone app FAILED: {error}")
                else:
                    print(f"A push to the phone app failed: {error}", flush=True)
            continue
        if always or not VAPID_PRIVATE_KEY:
            continue
        try:
            # In a thread: webpush waits for the push service's answer, which would stop the whole
            # server (everyone's chat) in the meantime if it ran here.
            await asyncio.to_thread(
                webpush,
                subscription_info={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
                data=data,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": PUSH_CLAIMS_SUBJECT},
                ttl=ttl,
                headers={"Urgency": urgency},  # "high": deliver at once, even to a sleeping phone
                timeout=10,
            )
            if logged:
                log_push(user_id, payload, f"sent to a browser ({urlsplit(endpoint).hostname})")
        except WebPushException as error:
            status = error.response.status_code if error.response is not None else None
            if status in (404, 410):  # "this subscription doesn't exist (any more)": uninstalled, say
                with db:
                    db.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
            else:
                print(f"A push to {urlsplit(endpoint).hostname} failed: {error}", flush=True)
        except Exception as error:  # (no connection, a timeout, ...): try again with the next message
            print(f"A push to {urlsplit(endpoint).hostname} failed: {error}", flush=True)


def push_in_background(user_ids, payload, **options):
    """Start send_push without waiting for it (kept in background_tasks, or asyncio may drop it)."""
    task = asyncio.create_task(send_push(user_ids, payload, **options))
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)


# A phone's notification stays until it's tapped or swiped, or the chat is opened in the app; and the
# number on the app's icon is the sum of the notifications showing. So when a chat is seen anywhere else
# (the PC, the web page), its phones get a "read" push that takes the notification away. on_phones:
# (user id, chat key) for every chat a phone was notified about since, so only those get one. In memory
# only: after a restart, notifications from before it go the old way.
on_phones = set()


def clear_on_phones(user_id, channel):
    """This person has seen this chat (or the People page, "friends"): its notification leaves their phones."""
    if (user_id, channel) in on_phones:
        on_phones.discard((user_id, channel))
        push_in_background([user_id], {"kind": "read", "channel": channel}, always=True)


# The same for ringing calls: rang_phones holds (user id, call's chat key) for every call a phone was
# actually rung for. Only those phones get a "call_end" when the ringing stops. A HIGH push that shows
# nothing (taking away a call the phone never got, when the Windows app rang instead) is what Google
# counts against an app: enough of them and Android may hold its pushes, calls too, until it's opened.
rang_phones = set()


def stop_ringing_phones(people, channel, ttl):
    """Take this call off the phones of these people that it rang on."""
    rang = [person for person in people if (person, channel) in rang_phones]
    rang_phones.difference_update((person, channel) for person in rang)
    if rang:
        push_in_background(rang, {"kind": "call_end", "channel": channel}, ttl=ttl, always=True)


def push_message(people, message):
    """A new message for these people (a DM to them, or mentioning them): "axel in #general"."""
    channel = message["channel"]
    if channel.startswith("dm:"):
        chat = None  # (a DM is the person)
    elif channel.startswith("g:"):
        chat = group_title(channel)
    else:
        chat = "#" + channel_name(channel)
    title = message["name"] if chat is None else f'{message["name"]} in {chat}'
    body = readable_text(message["text"])
    if len(body) > PUSH_TEXT_LENGTH:
        body = body[:PUSH_TEXT_LENGTH] + "…"
    if not body:
        body = files_note(message["files"])
    avatar = db.execute("SELECT avatar_id FROM users WHERE id = ?", (message["user_id"],)).fetchone()[0]
    push_in_background(people, {
        "title": title, "body": body, "channel": channel, "message_id": message["id"],
        "icon": f"/avatars/{avatar}" if avatar else "/icons/icon-192.png",
        # For the phone app, which stacks a chat's messages in one notification ("kari: hi"):
        # who wrote it, and the chat's name (none for a DM: that's the person).
        "kind": "message", "sender": message["name"], "sender_id": message["user_id"],
        "chat": chat,
    })


def base64url(data):
    """Bytes as base64url text: letters, digits, - and _ (safe in a URL), without the = padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()
