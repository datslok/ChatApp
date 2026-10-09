import json
import sqlite3

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

app = FastAPI()

CHANNELS = ["general", "memes"]  # add a name here to make a new channel
MAX_NAME_LENGTH = 32
MAX_TEXT_LENGTH = 2000
HISTORY_LIMIT = 50  # how many old messages a new connection gets

# The browser tabs currently connected to each channel: {"general": {ws1, ws2}, "memes": {...}}
connections = {channel: set() for channel in CHANNELS}

# Open the database file (SQLite creates it if it doesn't exist) and make sure the table is there.
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

# Migration: databases made before channels existed have no "channel" column yet.
# Add it, and the DEFAULT puts all the old messages in #general.
columns = [row[1] for row in db.execute("PRAGMA table_info(messages)")]
if "channel" not in columns:
    with db:
        db.execute("ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'general'")


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


def clean_message(raw):
    """Turn raw text from a client into a {"name", "text"} dict, or None if it's invalid.

    Never trust what clients send: anyone can connect to /ws with their own script.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None

    name = data.get("name")
    text = data.get("text")
    if not isinstance(name, str) or not isinstance(text, str):
        return None

    name = name.strip()
    text = text.strip()
    if not name or not text:
        return None
    if len(name) > MAX_NAME_LENGTH or len(text) > MAX_TEXT_LENGTH:
        return None

    # A fresh dict with only the fields we expect, so any extras a client sends are dropped.
    return {"name": name, "text": text}


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.get("/channels")
async def channels():
    return CHANNELS


@app.websocket("/ws/{channel}")
async def chat(websocket: WebSocket, channel: str):
    if channel not in CHANNELS:
        await websocket.close()  # refuse connections to channels that don't exist
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
            message = clean_message(raw)
            if message is None:
                continue  # ignore invalid messages
            save_message(channel, message)
            # Send it to everyone in this channel, including whoever sent it.
            # list() makes a copy, in case someone joins or leaves while we're sending.
            for connection in list(connections[channel]):
                await connection.send_json(message)
    except WebSocketDisconnect:
        pass
    finally:
        connections[channel].discard(websocket)
