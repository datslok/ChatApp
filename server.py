from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

app = FastAPI()

# Every browser tab that is currently connected.
connections = set()


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.websocket("/ws")
async def chat(websocket: WebSocket):
    await websocket.accept()
    connections.add(websocket)
    try:
        while True:
            message = await websocket.receive_text()
            # Send it to everyone, including whoever sent it.
            # list() makes a copy, in case someone joins or leaves while we're sending.
            for connection in list(connections):
                await connection.send_text(message)
    except WebSocketDisconnect:
        pass
    finally:
        connections.discard(websocket)
