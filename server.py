import json
import re
import secrets
import sqlite3

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel

app = FastAPI()

CHANNELS = ["general", "memes"]  # add a name here to make a new channel
MAX_TEXT_LENGTH = 2000
HISTORY_LIMIT = 50  # how many old messages a new connection gets

USERNAME_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,32}")  # 1-32 letters, digits, _ or -
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 200
SESSION_COOKIE = "session"
SESSION_DAYS = 30

hasher = PasswordHasher()

# The browser tabs currently connected to each channel: {"general": {ws1, ws2}, "memes": {...}}
connections = {channel: set() for channel in CHANNELS}

# Open the database file (SQLite creates it if it doesn't exist) and make sure the tables are there.
db = sqlite3.connect("chat.db")
db.execute("""
    CREATE TABLE IF NOT EXISTS messages (
        id      INTEGER PRIMARY KEY,
        channel TEXT NOT NULL DEFAULT 'general',
        name    TEXT NOT NULL,
        text    TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

# Migration: databases made before channels existed have no "channel" column yet.
# Add it, and the DEFAULT puts all the old messages in #general.
columns = [row[1] for row in db.execute("PRAGMA table_info(messages)")]
if "channel" not in columns:
    with db:
        db.execute("ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'general'")


# ---------- Messages ----------

def save_message(channel, message):
    # "with db" commits the change when the block ends (or undoes it if something fails).
    # The ? placeholders keep user text as data, so it can never be run as SQL.
    with db:
        db.execute(
            "INSERT INTO messages (channel, name, text) VALUES (?, ?, ?)",
            (channel, message["name"], message["text"]),
        )


def recent_messages(channel):
    """The channel's newest messages, oldest first, in the same shape as live messages."""
    rows = db.execute(
        "SELECT name, text FROM messages WHERE channel = ? ORDER BY id DESC LIMIT ?",
        (channel, HISTORY_LIMIT),
    ).fetchall()
    rows.reverse()  # we fetched newest-first; chat reads oldest-first
    return [{"name": name, "text": text} for name, text in rows]


def clean_text(raw):
    """Get the message text out of what a client sent, or None if it's invalid.

    Never trust what clients send: anyone can connect to /ws with their own script.
    The sender's name is NOT taken from here; it comes from their login session.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None

    text = data.get("text")
    if not isinstance(text, str):
        return None
    text = text.strip()
    if not text or len(text) > MAX_TEXT_LENGTH:
        return None
    return text


# ---------- Accounts and sessions ----------

class Credentials(BaseModel):
    """What the login page sends: FastAPI checks the JSON has these fields, as strings."""
    username: str
    password: str


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
async def register(credentials: Credentials, response: Response):
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
    return {"ok": True}


@app.post("/login")
async def login(credentials: Credentials, response: Response):
    # Same message whether the username or the password is wrong,
    # so nobody can use this to find out which usernames exist.
    wrong = HTTPException(401, "Wrong username or password.")

    row = db.execute(
        "SELECT id, password_hash FROM users WHERE username = ?",
        (credentials.username.strip(),),
    ).fetchone()
    if row is None:
        raise wrong
    user_id, password_hash = row

    try:
        hasher.verify(password_hash, credentials.password)
    except VerifyMismatchError:
        raise wrong

    start_session(response, user_id)
    return {"ok": True}


@app.post("/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        # Delete it on the server too, so the token stops working even if someone copied it.
        with db:
            db.execute("DELETE FROM sessions WHERE token = ?", (token,))
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


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

@app.websocket("/ws/{channel}")
async def chat(websocket: WebSocket, channel: str):
    # The browser sends the session cookie along when it opens the WebSocket.
    username = user_from_token(websocket.cookies.get(SESSION_COOKIE))
    if username is None or channel not in CHANNELS:
        await websocket.close()  # refuse: not logged in, or no such channel
        return

    await websocket.accept()
    # Fetch the history and join the broadcast list right after each other (no await in
    # between), so no message can slip through the gap.
    history = recent_messages(channel)
    connections[channel].add(websocket)
    try:
        # Send the history to this connection only.
        for message in history:
            await websocket.send_json(message)

        while True:
            raw = await websocket.receive_text()
            text = clean_text(raw)
            if text is None:
                continue  # ignore invalid messages
            message = {"name": username, "text": text}  # the name comes from the login, not the client
            save_message(channel, message)
            # Send it to everyone in this channel, including whoever sent it.
            # list() makes a copy, in case someone joins or leaves while we're sending.
            for connection in list(connections[channel]):
                await connection.send_json(message)
    except WebSocketDisconnect:
        pass
    finally:
        connections[channel].discard(websocket)
