import json
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel

# docs_url etc. = None: turn off FastAPI's automatic API explorer pages (/docs, /redoc),
# handy in development but nothing the public internet needs to see.
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

# Settings from the environment. serve.ps1 loads them from the .env file (which is never committed).
INVITE_CODE = os.environ.get("INVITE_CODE", "")  # needed to create an account; empty = anyone can
SECURE_COOKIES = os.environ.get("SECURE_COOKIES") == "1"  # 1 = cookies only ever sent over HTTPS
if not INVITE_CODE:
    print("WARNING: no INVITE_CODE set, so anyone who can reach this server can create an account.")

CHANNELS = ["general", "memes"]  # add a name here to make a new channel
MAX_TEXT_LENGTH = 2000
HISTORY_LIMIT = 50  # how many old messages a new connection gets

USERNAME_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,32}")  # 1-32 letters, digits, _ or -
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 200
SESSION_COOKIE = "session"
SESSION_DAYS = 30
MAX_FAILURES = 5          # wrong passwords (or invite codes) allowed...
FAILURE_WINDOW = 15 * 60  # ...within this many seconds, before we refuse to check more

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)  # create the folder if it isn't there yet
MAX_UPLOAD_SIZE = 10 * 1024 * 1024  # 10 MB, in bytes
MAX_FILENAME_LENGTH = 200
# Only these are shown in the page. They're pure pictures and can't contain scripts.
# Everything else (including SVG, which can) is only ever offered as a download.
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}

hasher = PasswordHasher()

# Every open connection (one per browser tab) and what we know about it:
# {websocket: {"username": "axel", "channel": "memes"}}
clients = {}

# Open the database file (SQLite creates it if it doesn't exist) and make sure the tables are there.
db = sqlite3.connect("chat.db")
db.execute("""
    CREATE TABLE IF NOT EXISTS messages (
        id            INTEGER PRIMARY KEY,
        channel       TEXT NOT NULL DEFAULT 'general',
        name          TEXT NOT NULL,
        text          TEXT NOT NULL,
        sent_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        attachment_id TEXT REFERENCES attachments(id)
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS attachments (
        id           TEXT PRIMARY KEY,
        filename     TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size         INTEGER NOT NULL,
        uploader     TEXT NOT NULL,
        channel      TEXT,  -- NULL until the file is sent in a message
        created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
""")

db.execute("""
    CREATE TABLE IF NOT EXISTS last_read (
        username   TEXT NOT NULL,
        channel    TEXT NOT NULL,
        message_id INTEGER NOT NULL,  -- the newest message this user has seen in this channel
        PRIMARY KEY (username, channel)  -- one row per person per channel
    )
""")

# Migrations: add columns that older databases don't have yet.
columns = [row[1] for row in db.execute("PRAGMA table_info(messages)")]
if "channel" not in columns:
    # From before channels existed: the DEFAULT puts all the old messages in #general.
    with db:
        db.execute("ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'general'")
if "attachment_id" not in columns:
    # From before uploads existed: old messages simply have no attachment (NULL).
    with db:
        db.execute("ALTER TABLE messages ADD COLUMN attachment_id TEXT REFERENCES attachments(id)")


# ---------- Messages ----------

def save_message(channel, message):
    # "with db" commits the change when the block ends (or undoes it if something fails).
    # The ? placeholders keep user text as data, so it can never be run as SQL.
    attachment_id = message["file"]["id"] if message["file"] else None
    with db:
        db.execute(
            "INSERT INTO messages (channel, name, text, attachment_id) VALUES (?, ?, ?, ?)",
            (channel, message["name"], message["text"], attachment_id),
        )


def file_info(attachment_id, filename, size, content_type):
    """What the page needs to know about an attachment."""
    return {"id": attachment_id, "filename": filename, "size": size, "image": content_type in IMAGE_TYPES}


def recent_messages(channel):
    """The channel's newest messages, oldest first, in the same shape as live messages."""
    # LEFT JOIN: every message, plus its attachment's details if it has one (NULLs if not).
    rows = db.execute(
        """
        SELECT messages.name, messages.text,
               attachments.id, attachments.filename, attachments.size, attachments.content_type
        FROM messages LEFT JOIN attachments ON attachments.id = messages.attachment_id
        WHERE messages.channel = ?
        ORDER BY messages.id DESC LIMIT ?
        """,
        (channel, HISTORY_LIMIT),
    ).fetchall()
    rows.reverse()  # we fetched newest-first; chat reads oldest-first
    return [
        {
            "name": name,
            "text": text,
            "file": file_info(file_id, filename, size, content_type) if file_id else None,
        }
        for name, text, file_id, filename, size, content_type in rows
    ]


def parse_json(raw):
    """Turn raw text from a client into a dict, or None if it isn't a JSON object.

    Never trust what clients send: anyone can connect to /ws with their own script.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return data


def clean_text(data):
    """Get the message text out of a client's "message" (maybe empty), or None if it's invalid.

    The sender's name is NOT taken from here; it comes from their login session.
    """
    text = data.get("text")
    if not isinstance(text, str):
        return None
    text = text.strip()
    if len(text) > MAX_TEXT_LENGTH:
        return None
    return text


# ---------- Accounts and sessions ----------

class Credentials(BaseModel):
    """What the login page sends: FastAPI checks the JSON has these fields, as strings."""
    username: str
    password: str
    invite: str = ""  # only used when creating an account


# Recent failed attempts, to stop password (and invite code) guessing:
# {"login:axel": [time, time, ...], "invite:203.0.113.5": [...]}. Kept in memory only.
failures = {}


def too_many_failures(key):
    """Has this key failed MAX_FAILURES times within the last FAILURE_WINDOW seconds?"""
    now = time.monotonic()  # a clock in seconds that only ever goes forward
    recent = [t for t in failures.get(key, []) if now - t < FAILURE_WINDOW]  # forget old ones
    if recent:
        failures[key] = recent
    else:
        failures.pop(key, None)  # nothing recent: remove the key, so the dict doesn't keep growing
    return len(recent) >= MAX_FAILURES


def record_failure(key):
    failures.setdefault(key, []).append(time.monotonic())


def client_ip(request):
    """The visitor's IP address. Behind the Cloudflare Tunnel every request comes from
    cloudflared on this PC, so Cloudflare puts the real address in a header for us.
    (We only trust that header because the server only listens on this PC; see serve.ps1.)"""
    return request.headers.get("cf-connecting-ip") or request.client.host


def start_session(response, user_id):
    """Log a user in: store a new random token, and give it to their browser as a cookie."""
    token = secrets.token_urlsafe(32)  # 32 random bytes: impossible to guess
    with db:
        db.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 24 * 60 * 60,  # in seconds
        httponly=True,   # JavaScript can't read it, so a script can't steal it
        samesite="lax",  # other websites can't make the browser send it to us
        secure=SECURE_COOKIES,  # on the real site: only ever sent over HTTPS
    )


def user_from_token(token):
    """The username a session token belongs to, or None if it's missing, unknown or expired."""
    if not token:
        return None
    row = db.execute(
        """
        SELECT users.username
        FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token = ? AND sessions.created_at > datetime('now', ?)
        """,
        (token, f"-{SESSION_DAYS} days"),
    ).fetchone()
    return row[0] if row else None


@app.post("/register")
async def register(credentials: Credentials, request: Request, response: Response):
    if INVITE_CODE:
        # Limit guesses per visitor (IP address), so the code can't be found by trying them all.
        key = "invite:" + client_ip(request)
        if too_many_failures(key):
            raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")
        # compare_digest takes the same time however much of the guess is right,
        # so the response time gives no hints about the real code.
        if not secrets.compare_digest(credentials.invite.strip().encode(), INVITE_CODE.encode()):
            record_failure(key)
            raise HTTPException(403, "Wrong invite code.")

    username = credentials.username.strip()
    password = credentials.password
    if not USERNAME_PATTERN.fullmatch(username):
        raise HTTPException(400, "Usernames are 1–32 letters, digits, _ or -.")
    if not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH:
        raise HTTPException(400, f"Passwords need at least {MIN_PASSWORD_LENGTH} characters.")

    password_hash = hasher.hash(password)  # salted and hashed; the password itself is never stored
    try:
        with db:
            cursor = db.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username, password_hash),
            )
    except sqlite3.IntegrityError:  # the UNIQUE rule on username was broken
        raise HTTPException(400, "That username is taken.")

    start_session(response, cursor.lastrowid)  # lastrowid: the id SQLite gave the new user
    await send_to_everyone(users_message())  # so the new person shows up in everyone's DM list
    return {"ok": True}


@app.post("/login")
async def login(credentials: Credentials, response: Response):
    # Same message whether the username or the password is wrong,
    # so nobody can use this to find out which usernames exist.
    wrong = HTTPException(401, "Wrong username or password.")

    # Limit guesses per username. Checked before the password, so while it's locked
    # even the right password is refused; otherwise guessing could just carry on.
    key = "login:" + credentials.username.strip().lower()
    if too_many_failures(key):
        raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")

    row = db.execute(
        "SELECT id, password_hash FROM users WHERE username = ?",
        (credentials.username.strip(),),
    ).fetchone()
    if row is None:
        record_failure(key)
        raise wrong
    user_id, password_hash = row

    try:
        hasher.verify(password_hash, credentials.password)
    except VerifyMismatchError:
        record_failure(key)
        raise wrong

    failures.pop(key, None)  # logged in: start counting from zero again
    start_session(response, user_id)
    return {"ok": True}


@app.post("/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        # Delete it on the server too, so the token stops working even if someone copied it.
        with db:
            db.execute("DELETE FROM sessions WHERE token = ?", (token,))
    response.delete_cookie(SESSION_COOKIE, httponly=True, samesite="lax", secure=SECURE_COOKIES)
    return {"ok": True}


# ---------- Uploads ----------

def current_user(request):
    """The logged-in username for an HTTP request, or None."""
    return user_from_token(request.cookies.get(SESSION_COOKIE))


@app.post("/upload")
async def upload(request: Request, filename: str):
    """Receive one file. The body is the raw file; its name comes in the URL: /upload?filename=cat.png"""
    username = current_user(request)
    if username is None:
        raise HTTPException(401, "You're not logged in.")

    filename = filename.strip()[:MAX_FILENAME_LENGTH] or "file"
    # The browser says what type the file is. We only believe it for our safe image types;
    # anything else is stored as a generic download type.
    content_type = request.headers.get("content-type", "")
    if content_type not in IMAGE_TYPES:
        content_type = "application/octet-stream"

    # On disk the file gets a random name, never the one the user gave
    # (a name like "../../server.py" could otherwise overwrite our own files).
    file_id = secrets.token_urlsafe(16)
    path = UPLOAD_DIR / file_id

    # Read the body piece by piece as it arrives, so we can stop as soon as it's too big.
    size = 0
    try:
        with open(path, "wb") as out:  # "wb": write, in binary mode (bytes, not text)
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD_SIZE:
                    raise HTTPException(413, "Files can be at most 10 MB.")
                out.write(chunk)
        if size == 0:
            raise HTTPException(400, "That file is empty.")
    except BaseException:
        # Whatever went wrong (too big, empty, the upload was cancelled...), don't keep half a file.
        path.unlink(missing_ok=True)
        raise

    with db:
        db.execute(
            "INSERT INTO attachments (id, filename, content_type, size, uploader) VALUES (?, ?, ?, ?, ?)",
            (file_id, filename, content_type, size, username),
        )
    return {"id": file_id}


def claim_attachment(file_id, username, channel):
    """Tie an uploaded file to the channel it's being sent in. Only the uploader can do that,
    and only once. Returns the file's info for the message, or None if not allowed."""
    if not isinstance(file_id, str):
        return None
    with db:
        cursor = db.execute(
            "UPDATE attachments SET channel = ? WHERE id = ? AND uploader = ? AND channel IS NULL",
            (channel, file_id, username),
        )
    if cursor.rowcount != 1:  # rowcount: how many rows the UPDATE changed
        return None
    filename, size, content_type = db.execute(
        "SELECT filename, size, content_type FROM attachments WHERE id = ?", (file_id,)
    ).fetchone()
    return file_info(file_id, filename, size, content_type)


@app.get("/uploads/{file_id}")
async def get_upload(request: Request, file_id: str):
    """Send a file, but only to people who may see the message it's in."""
    username = current_user(request)
    row = db.execute(
        "SELECT filename, content_type, uploader, channel FROM attachments WHERE id = ?", (file_id,)
    ).fetchone()
    # "Not found" for everything that isn't allowed, so nobody learns which files exist.
    not_found = HTTPException(404, "Not found.")
    if username is None or row is None:
        raise not_found
    filename, content_type, uploader, channel = row
    if channel is None:
        allowed = uploader == username  # not sent yet: only the uploader
    else:
        allowed = can_join(channel, username)  # sent: whoever can see that channel or DM
    if not allowed:
        raise not_found

    return FileResponse(
        UPLOAD_DIR / file_id,  # safe: file_id was found in our own table above
        media_type=content_type,
        filename=filename,
        # Images are shown in the page; everything else is downloaded, never opened on our site.
        content_disposition_type="inline" if content_type in IMAGE_TYPES else "attachment",
        # Tell the browser to trust our type and never guess (so a fake "image" can't act as a page).
        headers={"X-Content-Type-Options": "nosniff"},
    )


# ---------- Pages ----------

@app.get("/")
async def index(request: Request):
    if user_from_token(request.cookies.get(SESSION_COOKIE)) is None:
        return RedirectResponse("/login")  # not logged in: send them to the login page
    return FileResponse("static/index.html")


@app.get("/login")
async def login_page():
    return FileResponse("static/login.html")


@app.get("/channels")
async def channels():
    return CHANNELS


# ---------- Chat ----------

def online_users():
    """Everyone with at least one open tab, sorted by name. A set first, so two tabs count once."""
    return sorted({client["username"] for client in clients.values()}, key=str.lower)


def users_message():
    """Every account, each marked online or not: [{"name": "axel", "online": True}, ...]"""
    online = set(online_users())
    rows = db.execute("SELECT username FROM users ORDER BY username COLLATE NOCASE").fetchall()
    return {"type": "users", "users": [{"name": name, "online": name in online} for (name,) in rows]}


def user_exists(username):
    row = db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
    return row is not None


def can_join(channel, username):
    """May this user join this channel? Normal channels: anyone logged in.
    DMs ("dm:axel:kari", lowercase and sorted): only the two people in it."""
    if channel in CHANNELS:
        return True
    if not isinstance(channel, str) or not channel.startswith("dm:"):
        return False

    names = channel.split(":")[1:]  # "dm:axel:kari" -> ["axel", "kari"]
    if len(names) != 2 or channel != channel.lower() or names != sorted(names) or names[0] == names[1]:
        return False  # not the exact shape the page builds
    me = username.lower()
    if me not in names:
        return False  # someone else's DM: never
    other = names[1] if names[0] == me else names[0]
    return user_exists(other)


# ---------- Unread ----------

def mark_read(username, channel):
    """Remember that this user has now seen everything in this channel."""
    newest = db.execute("SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel = ?", (channel,)).fetchone()[0]
    # An "upsert": insert a new row, or if this user already has one for this channel,
    # update it instead. "excluded" means the values we just tried to insert.
    with db:
        db.execute(
            """
            INSERT INTO last_read (username, channel, message_id) VALUES (?, ?, ?)
            ON CONFLICT (username, channel) DO UPDATE SET message_id = excluded.message_id
            """,
            (username, channel, newest),
        )


def unread_channels(username):
    """Every channel and DM this user can see that has messages newer than the last one they saw."""
    # GROUP BY: one row per channel, with the newest message id in it.
    newest = dict(db.execute("SELECT channel, MAX(id) FROM messages GROUP BY channel"))
    seen = dict(db.execute("SELECT channel, message_id FROM last_read WHERE username = ?", (username,)))
    return [
        channel
        for channel, newest_id in newest.items()
        if newest_id > seen.get(channel, 0) and can_join(channel, username)
    ]


async def announce_new_message(channel):
    """After a new message: it counts as read for whoever is looking at the channel, and
    everyone else who can see the channel gets an "unread" for it."""
    viewers = {client["username"] for client in clients.values() if client["channel"] == channel}
    for username in viewers:
        mark_read(username, channel)
    for websocket, client in list(clients.items()):
        if client["username"] not in viewers and can_join(channel, client["username"]):
            await send(websocket, {"type": "unread", "channels": [channel]})


async def send(websocket, data):
    """Send to one connection, ignoring errors: if that tab just closed, its own
    chat() call notices and cleans up, so a failure here must not crash the sender."""
    try:
        await websocket.send_json(data)
    except Exception:
        pass


async def send_to_everyone(data):
    # list() makes a copy, in case someone joins or leaves while we're sending.
    for websocket in list(clients):
        await send(websocket, data)


async def send_to_channel(channel, data, except_user=None):
    """Send to everyone viewing a channel, optionally leaving out one user (all their tabs)."""
    for websocket, client in list(clients.items()):
        if client["channel"] == channel and client["username"] != except_user:
            await send(websocket, data)


@app.websocket("/ws")
async def chat(websocket: WebSocket):
    # The browser sends the session cookie along when it opens the WebSocket.
    username = user_from_token(websocket.cookies.get(SESSION_COOKIE))
    if username is None:
        # Not logged in. Accept first and then close with our own code (4000-4999 are free
        # for apps): if we refused outright, the page couldn't see why, and would keep retrying.
        await websocket.accept()
        await websocket.close(code=4001)
        return

    await websocket.accept()
    was_online = username in online_users()  # already open in another tab?
    clients[websocket] = {"username": username, "channel": None}  # no channel until they "join"
    try:
        await send(websocket, {"type": "welcome", "username": username})  # tell the page who it is
        await send(websocket, {"type": "unread", "channels": unread_channels(username)})
        if was_online:
            await send(websocket, users_message())  # just this tab
        else:
            await send_to_everyone(users_message())  # they came online

        while True:
            data = parse_json(await websocket.receive_text())
            if data is None:
                continue  # ignore invalid messages
            kind = data.get("type")
            channel = clients[websocket]["channel"]

            if kind == "join":
                new_channel = data.get("channel")
                if not can_join(new_channel, username):
                    continue
                # Switch channel and fetch its history with no await in between,
                # so no message can slip through the gap.
                clients[websocket]["channel"] = new_channel
                history = recent_messages(new_channel)
                mark_read(username, new_channel)  # opening a channel means you've seen it
                await send(websocket, {"type": "history", "channel": new_channel, "messages": history})

            elif kind == "message" and channel is not None:
                text = clean_text(data)
                if text is None:
                    continue
                file = None
                if data.get("file") is not None:
                    file = claim_attachment(data.get("file"), username, channel)
                    if file is None:
                        continue  # not their file, already sent, or doesn't exist
                if not text and file is None:
                    continue  # nothing to send
                # The name comes from the login, never from the client.
                message = {"type": "message", "channel": channel, "name": username, "text": text, "file": file}
                save_message(channel, message)
                await send_to_channel(channel, message)  # everyone in the channel, including us
                await announce_new_message(channel)  # mark it read or unread for everyone else

            elif kind == "typing" and channel is not None:
                # Tell the others in this channel; you don't need to see yourself typing.
                await send_to_channel(
                    channel, {"type": "typing", "channel": channel, "name": username}, except_user=username
                )
    except WebSocketDisconnect:
        pass
    finally:
        del clients[websocket]
        if username not in online_users():  # that was their last tab: they went offline
            await send_to_everyone(users_message())
