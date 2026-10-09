import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

app = FastAPI()

MAX_NAME_LENGTH = 32
MAX_TEXT_LENGTH = 2000

# Every browser tab that is currently connected.
connections = set()


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
    connections.add(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            message = clean_message(raw)
            if message is None:
                continue  # ignore invalid messages
            # Send it to everyone, including whoever sent it.
            # list() makes a copy, in case someone joins or leaves while we're sending.
            for connection in list(connections):
                await connection.send_json(message)
    except WebSocketDisconnect:
        pass
    finally:
        connections.discard(websocket)
