"""The open WebSocket connections (`clients`) and sending to them: one connection, one person's pages,
a channel's viewers or everyone. Every WebSocket message the server sends goes through `send`."""

import asyncio


# Every open connection (one per browser tab) and what we know about it: the channel it's looking
# at, and the voice room it says it's in (and whether it's muted or deafened there).
# {websocket: {"user_id": 3, "channel": "memes", "voice": "lounge", "muted": False, "deafened": False}}
clients = {}

# Messages' tags ("nonce"), for the phone app's outbox: it sends a message again when it isn't sure the
# first try arrived (a bad connection), and a tag seen before means "already saved": we only confirm it
# again. {(user_id, nonce): (message_id, channel, when)}, forgotten after NONCE_MEMORY seconds. (Memory
# only: a resend just after a restart could be saved twice, which is rare enough.)
recent_nonces = {}
NONCE_MEMORY = 10 * 60


def message_nonce(data):
    """A message's tag from the app: a short string, or None."""
    nonce = data.get("nonce")
    return nonce if isinstance(nonce, str) and 0 < len(nonce) <= 64 else None


# Which device a message was sent from ("sent_from"): saved with it, and given to bots only, so Chattus can
# explain the way to a setting for the device someone asks on. People's pages never get it: a phone dot while
# you're online is one thing, "from the phone at 03:12" kept on every message is more than anyone asked to share.
def device_of(client):
    """What a connection is, from what its page says in "looking": "android app", "windows app",
    "phone browser" or "web browser"."""
    if client["android"]:
        return "android app"
    if client["app"]:
        return "windows app"
    return "phone browser" if client["mobile"] else "web browser"


def without_devices(data):
    """A WebSocket message without any message's "sent_from": on a message itself, or on each one in
    a list of them ("history", "older" and "pins" have "messages", search "results", chat info "items")."""
    def strip(message):
        return {key: value for key, value in message.items() if key != "sent_from"}

    if "sent_from" in data:
        data = strip(data)
    for key in ("messages", "results", "items"):
        if isinstance(data.get(key), list):
            data = {**data, key: [strip(item) if isinstance(item, dict) else item for item in data[key]]}
    return data


# Stuck connections: a connection whose other end stopped reading (a phone that lost its signal, with
# nobody hearing of it yet) fills up its outgoing buffer, and then sending to it waits until there's room,
# which may be minutes. Everyone is sent to one after another, so that wait held up whoever was sending:
# a new connection got stuck in its first "users" and never answered the phone app's ping, which then
# reconnected, and got stuck again (a reconnecting loop, for up to a minute). So a send that can't go out
# within SEND_TIMEOUT gives up on the connection: it's marked "stuck", skipped from then on, and its chat()
# is stopped, which cleans up after it like any closed connection (its phone simply connects again).
# (5 s: a working connection drains far faster, and it's below the phone app's 6 s wait for an answer.)
SEND_TIMEOUT = 5


async def send(websocket, data):
    """Send to one connection, ignoring errors: if that tab just closed, its own
    chat() call notices and cleans up, so a failure here must not crash the sender.
    Every WebSocket message goes through here, so this is where messages' devices are taken out for
    everyone but bots (see device_of)."""
    client = clients.get(websocket)
    if client is not None and client["stuck"]:
        return  # given up on (see "Stuck connections")
    if client is None or not client["bot"]:
        data = without_devices(data)
    try:
        await asyncio.wait_for(websocket.send_json(data), SEND_TIMEOUT)
    except TimeoutError:
        if client is not None:
            client["stuck"] = True
            client["task"].cancel()  # its chat() ends (see the end of chat())
    except Exception:
        pass


async def disconnect_user(user_id):
    """Close every open chat tab of one user, with our "not logged in" code (the page then
    goes to the login page). Used after a password reset."""
    for websocket, client in list(clients.items()):
        if client["user_id"] == user_id:
            try:
                await websocket.close(code=4001)
            except Exception:
                pass


async def send_to_everyone(data):
    # list() makes a copy, in case someone joins or leaves while we're sending.
    for websocket in list(clients):
        await send(websocket, data)


async def send_to_user(user_id, data):
    """Send to every open tab of one person (the desktop app and their phone, say)."""
    for websocket, client in list(clients.items()):
        if client["user_id"] == user_id:
            await send(websocket, data)


async def send_to_channel(channel, data, except_user_id=None):
    """Send to everyone viewing a channel, optionally leaving out one user (all their tabs)."""
    for websocket, client in list(clients.items()):
        if client["channel"] == channel and client["user_id"] != except_user_id:
            await send(websocket, data)


# Work started in the background (link previews, push notifications): asyncio only keeps a weak reference
# to a task, so one nobody holds could be cleaned away half-way. Each removes itself when it's done.
background_tasks = set()
