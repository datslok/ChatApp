import json
import sqlite3

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

app = FastAPI()

MAX_NAME_LENGTH = 32
MAX_TEXT_LENGTH = 2000
HISTORY_LIMIT = 50  # how many old messages a new connection gets

# Every browser tab that is currently connected.
connections = set()

# Open the database file (SQLite creates it if it doesn't exist) and make sure the table is there.
db = sqlite3.connect("chat.db")
db.execute("""
    CREATE TABLE IF NOT EXISTS messages (
        id      INTEGER PRIMARY KEY,
        name    TEXT NOT NULL,
        text    TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
""")


def save_message(message):
    # "with db" commits the change when the block ends (or undoes it if something fails).
    # The ? placeholders keep user text as data, so it can never be run as SQL.
    with db:
        db.execute(
            "INSERT INTO messages (name, text) VALUES (?, ?)",
            (message["name"], message["text"]),
        )


def recent_messages():
    """The newest messages, oldest first, in the same shape as live messages."""
    rows = db.execute(
        "SELECT name, text FROM messages ORDER BY id DESC LIMIT ?",
        (HISTORY_LIMIT,),
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


@app.websocket("/ws")
async def chat(websocket: WebSocket):
    await websocket.accept()
    # Fetch the history and join the broadcast list right after each other (no await in
    # between), so no message can slip through the gap.
    history = recent_messages()
    connections.add(websocket)
    try:
        # Send the history to this connection only.
        for message in history:
            await websocket.send_json(message)

        while True:
            raw = await websocket.receive_text()
            message = clean_message(raw)
            if message is None:
                continue  # ignore invalid messages
            save_message(message)
            # Send it to everyone, including whoever sent it.
            # list() makes a copy, in case someone joins or leaves while we're sending.
            for connection in list(connections):
                await connection.send_json(message)
    except WebSocketDisconnect:
        pass
    finally:
        connections.discard(websocket)
