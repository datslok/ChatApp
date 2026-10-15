"""Makes the landing page's screenshot (static/landing/screenshot.png) on a throwaway chat: never the
real one, never dev.db. Run it again when the chat's look changes:

    python tools/make_screenshot.py            (with the chatapp environment's Python, like start.ps1)

1. Starts a server of its own (port 8009) with an empty database and upload folder in a temporary
   folder, which is deleted at the end.
2. Makes a few accounts (alex, the first, is the admin) with colourful pictures (animal emoji drawn by
   Pillow), Chattus with his cat (tools/make_bot.py), friends, roles, a custom emoji and a Games heading.
3. Connects them all over the WebSocket, like pages: statuses, what they're playing or listening to,
   two in the Lounge; then a conversation in #general that shows what's special: maths (LaTeX), a code
   block, a reply, reactions (a custom emoji too), a mention, a spoiler, Chattus with his BOT tag and a
   poll; and someone typing.
4. While they're all still connected, photographs alex's page with Edge without a window ("headless"),
   steered through its DevTools protocol (the same as its F12 tools use): alex's login cookie, a
   1440x800 window at twice the pixels (sharp on high-resolution screens), then the picture.
"""
import asyncio
import base64
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from io import BytesIO
from pathlib import Path

import websockets
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PORT = 8009
SERVER = f"http://localhost:{PORT}"
DEBUG_PORT = 9333  # Edge's DevTools
OUT = ROOT / "static" / "landing" / "screenshot.png"
EDGE = next(path for path in [
    Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft/Edge/Application/msedge.exe",
    Path(os.environ.get("ProgramFiles", "")) / "Microsoft/Edge/Application/msedge.exe",
] if path.exists())

# name: (picture: emoji and background colour, presence, activity, the status line they wrote)
PEOPLE = {
    "alex": ("🦊", (88, 101, 242), "online", None, "making ChatApp 🛠️"),
    "mira": ("🐼", (235, 69, 158), "online", {"kind": "listening", "name": "Midnight City", "details": "M83"}, "drawing 🎨"),
    "jonas": ("🐸", (35, 165, 90), "online", {"kind": "playing", "name": "Minecraft"}, ""),
    "sam": ("🐙", (240, 178, 50), "idle", None, "clack clack ⌨️"),
    "kari": ("🦉", (0, 134, 215), "dnd", {"kind": "playing", "name": "Hollow Knight"}, "do not disturb, boss fight"),
}
PASSWORD = "screenshot-only-1"


def request(path, body=None, cookie=None, content_type="application/json", method=None):
    """A request to the throwaway server: (answer, its session cookie if it set one)."""
    data = json.dumps(body).encode() if content_type == "application/json" and body is not None else body
    headers = {"Content-Type": content_type} if data is not None else {}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(SERVER + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as response:
        set_cookie = response.headers.get("Set-Cookie")
        text = response.read().decode() or "null"
        return json.loads(text), set_cookie.split(";")[0] if set_cookie else None


def avatar(emoji, colour):
    """A 256x256 PNG: the emoji (Windows' colour emoji font) on a plain colour."""
    picture = Image.new("RGB", (256, 256), colour)
    font = ImageFont.truetype(r"C:\Windows\Fonts\seguiemj.ttf", 150)
    ImageDraw.Draw(picture).text((128, 140), emoji, font=font, embedded_color=True, anchor="mm")
    data = BytesIO()  # (a file in memory)
    picture.save(data, "PNG")
    return data.getvalue()


async def main(work):
    db_file = work / "shot.db"
    env = {**os.environ, "DATABASE_FILE": str(db_file), "UPLOAD_DIR": str(work / "uploads"),
           "REQUIRE_INVITE": "0", "PUBLIC_URL": SERVER, "SMTP_HOST": "", "VAPID_PUBLIC_KEY": "",
           "VAPID_PRIVATE_KEY": "", "FIREBASE_KEY_FILE": str(work / "none.json"), "LIVEKIT_URL": "",
           "GIPHY_API_KEY": "", "LANDING_HOST": ""}
    server = subprocess.Popen([sys.executable, "-m", "uvicorn", "server:app", "--port", str(PORT)],
                              cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    edge = None
    try:
        for _ in range(60):  # until it answers
            try:
                urllib.request.urlopen(SERVER + "/login")
                break
            except OSError:
                time.sleep(0.5)

        def database():
            return sqlite3.connect(db_file)

        # Accounts: registered, then marked as having verified their email (no mail goes out here).
        cookies, ids = {}, {}
        for name in PEOPLE:
            request("/register", {"username": name, "password": PASSWORD, "email": f"{name}@example.com"})
            with database() as db:
                db.execute("UPDATE users SET email_verified = 1 WHERE username = ?", (name,))
                ids[name] = db.execute("SELECT id FROM users WHERE username = ?", (name,)).fetchone()[0]
            cookies[name] = request("/login", {"username": name, "password": PASSWORD})[1]
            emoji, colour = PEOPLE[name][:2]
            request("/settings/avatar", avatar(emoji, colour), cookies[name], "image/png")
            request("/settings/profile", {"status": PEOPLE[name][4], "bio": ""}, cookies[name])

        # Chattus, the bot, with his own picture and a password in a file of the throwaway folder.
        subprocess.run([sys.executable, "tools/make_bot.py", "--db", str(db_file), "--uploads", str(work / "uploads"),
                        "--env", str(work / "bot.env")], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        bot_password = (work / "bot.env").read_text().split("CHATTUS_PASSWORD=")[1].split()[0]
        cookies["Chattus"] = request("/login", {"username": "Chattus", "password": bot_password})[1]
        with database() as db:
            ids["Chattus"] = db.execute("SELECT id FROM users WHERE username = 'Chattus'").fetchone()[0]

        # Everyone friends with alex (and Chattus with everyone), so the DM list and calls have people.
        for name in [*PEOPLE, "Chattus"]:
            if name != "alex":
                request("/friends/request", {"user_id": ids[name]}, cookies["alex"])
                request("/friends/accept", {"user_id": ids["alex"]}, cookies[name])
        for name in ["mira", "jonas", "sam", "kari"]:
            request("/friends/request", {"user_id": ids["Chattus"]}, cookies[name])
            request("/friends/accept", {"user_id": ids[name]}, cookies["Chattus"])

        # Roles with colours (coloured names and member list sections), a channel under a heading, and
        # a custom emoji (the cat).
        for role, colour, members in [("Mods", "#e67e22", ["alex"]), ("Artists", "#eb459e", ["mira", "kari"])]:
            request("/roles", {"name": role, "colour": colour}, cookies["alex"])
            with database() as db:
                role_id = db.execute("SELECT id FROM roles WHERE name = ?", (role,)).fetchone()[0]
            for member in members:
                request(f"/roles/{role_id}/members", {"user_id": ids[member], "member": True}, cookies["alex"])
        request("/channels", {"name": "Games", "heading": True}, cookies["alex"])
        request("/channels", {"name": "minecraft"}, cookies["alex"])
        cat = (ROOT / "icon" / "chattuschattus_square.png").read_bytes()
        request("/custom-emoji?name=chattus", cat, cookies["mira"], "image/png")
        with database() as db:
            cat_emoji = db.execute("SELECT id FROM custom_emoji WHERE name = 'chattus'").fetchone()[0]

        # Everyone connects, like their pages: status, activity, voice. Each in #general.
        sockets = {}
        for name in [*PEOPLE, "Chattus"]:
            ws = await websockets.connect(f"ws://localhost:{PORT}/ws", additional_headers={"Cookie": cookies[name]},
                                          max_size=None)
            sockets[name] = ws
            await ws.send(json.dumps({"type": "join", "channel": "general"}))
            if name in PEOPLE:
                presence, activity = PEOPLE[name][2:4]
                await ws.send(json.dumps({"type": "presence", "presence": presence}))
                if activity:
                    await ws.send(json.dumps({"type": "activity", "activity": activity}))
        for name in ["jonas", "sam"]:
            await sockets[name].send(json.dumps({"type": "voice", "room": "lounge", "muted": name == "sam"}))

        # Their incoming messages are read in the background (a socket that's never read fills up).
        sent = asyncio.Queue()

        async def read(name, ws):
            async for raw in ws:
                data = json.loads(raw)
                if data.get("type") == "message" and name == "alex":
                    await sent.put(data["id"])

        readers = [asyncio.create_task(read(name, ws)) for name, ws in sockets.items()]

        async def say(name, text, reply_to=None, channel=None):
            """name writes text (in #general, or another chat); returns the message's id."""
            if channel:
                await sockets[name].send(json.dumps({"type": "join", "channel": channel}))
                await asyncio.sleep(0.3)
            await sockets[name].send(json.dumps({"type": "message", "text": text, "reply_to": reply_to}))
            if channel:
                await asyncio.sleep(0.3)
                await sockets[name].send(json.dumps({"type": "join", "channel": "general"}))
                await asyncio.sleep(0.3)
                return None
            return await asyncio.wait_for(sent.get(), 5)

        async def react(name, message_id, emoji):
            await sockets[name].send(json.dumps({"type": "react", "message_id": message_id, "emoji": emoji}))
            await asyncio.sleep(0.05)

        # The conversation.
        q = await say("mira", "ok quick maths question for the physics nerds: why is $e^{i\\pi} + 1 = 0$ so famous?")
        a = await say("jonas", "because it ties together $e$, $i$, $\\pi$, 1 and 0 in one line ✨\n"
                               "$$e^{ix} = \\cos x + i \\sin x$$", reply_to=q)
        for name, emoji in [("mira", "🤯"), ("sam", "🤯"), ("kari", f"custom:{cat_emoji}"), ("alex", "🔥")]:
            await react(name, a, emoji)
        await say("sam", "the maths actually renders in here?? ||ok that's sick||")
        code = await say("alex", "it's KaTeX, same as @jonas used. code blocks too:\n"
                                 "```python\nprint(\"hello from #general\")\n```")
        await react("sam", code, "👀")
        await say("mira", "@Chattus what should we play tonight? :chattus:")
        poll = await say("Chattus", "📊 **Game night: what do we play?** (react to vote, nyan ^-^)\n"
                                    "1️⃣ Minecraft\n2️⃣ Among Us\n3️⃣ Jackbox")
        for name, emoji in [("Chattus", "1️⃣"), ("Chattus", "2️⃣"), ("Chattus", "3️⃣"), ("jonas", "1️⃣"),
                            ("mira", "1️⃣"), ("sam", "3️⃣"), ("kari", "1️⃣")]:
            await react(name, poll, emoji)
        # Something unread for alex: a DM from kari, and #memes.
        await say("kari", "are you joining later? 🦉", channel=f"dm:{min(ids['alex'], ids['kari'])}:{max(ids['alex'], ids['kari'])}")
        await say("sam", "new meme just dropped", channel="memes")

        # Edge, without a window, steered over its DevTools WebSocket.
        profile = work / "edge"
        edge = subprocess.Popen([str(EDGE), "--headless=new", "--disable-gpu", "--hide-scrollbars",
                                 f"--remote-debugging-port={DEBUG_PORT}", f"--user-data-dir={profile}", "about:blank"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json"))
                page = next(target for target in targets if target["type"] == "page")
                break
            except (OSError, StopIteration):
                time.sleep(0.5)
        async with websockets.connect(page["webSocketDebuggerUrl"], max_size=None) as devtools:
            counter = 0

            async def command(method, **params):
                nonlocal counter
                counter += 1
                await devtools.send(json.dumps({"id": counter, "method": method, "params": params}))
                while True:
                    answer = json.loads(await devtools.recv())
                    if answer.get("id") == counter:
                        return answer.get("result", {})

            name, value = cookies["alex"].split("=", 1)
            await command("Network.enable")
            await command("Network.setCookie", name=name, value=value, domain="localhost", path="/")
            await command("Emulation.setDeviceMetricsOverride", width=1440, height=800, deviceScaleFactor=2, mobile=False)
            # As a returning visitor: the "Windows app" banner closed, What's new seen (both kept in the
            # page's localStorage, which belongs to the address: so first a page there, then the chat).
            await command("Page.navigate", url=f"{SERVER}/login")
            await asyncio.sleep(1)
            await command("Runtime.evaluate", expression="localStorage.setItem('appBanner', 'off');"
                                                         "localStorage.setItem('changelogSeenCount', '9999')")
            await command("Page.navigate", url=f"{SERVER}/?channel=general")
            # The page loads, connects, draws the maths; mira types meanwhile (the line at the bottom).
            for _ in range(8):
                await sockets["mira"].send(json.dumps({"type": "typing"}))
                await asyncio.sleep(1)
            shot = await command("Page.captureScreenshot", format="png")
        OUT.write_bytes(base64.b64decode(shot["data"]))
        print(f"Wrote {OUT} ({Image.open(OUT).size[0]}x{Image.open(OUT).size[1]})")
        for task in readers:
            task.cancel()
        for ws in sockets.values():
            await ws.close()
    finally:
        if edge:
            edge.terminate()
        server.terminate()
        server.wait()


work = Path(tempfile.mkdtemp(prefix="chatapp-screenshot-"))
try:
    asyncio.run(main(work))
finally:
    time.sleep(1)  # (Edge lets go of its profile folder)
    shutil.rmtree(work, ignore_errors=True)
