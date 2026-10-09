# Our Chat: a small Discord-style app

A chat app for me, my girlfriend and our friends (about 5–20 people). It's a **fun learning project**:
the point is for me to understand how it works, not just to have it done.

## How to work with me

- **Teach, don't just build.** Work in small steps. Before writing code, briefly explain the concept
  (WebSockets, databases, auth, …). After writing it, explain what each part does and why.
- **Leave parts for me to write.** For each milestone, suggest one or two small pieces I can implement
  myself, and review my code when I do.
- **Keep it simple.** Prefer the standard library and a few well-known packages over frameworks and
  abstractions. Readable code beats clever code. Don't add features I didn't ask for.
- **Explain any new dependency** before adding it: what it does and why it's needed.
- I know Python. I'm learning JavaScript/HTML/CSS along the way, so explain frontend code in more detail.
- **Security basics still matter**, since friends will use this for real: never insert user text with
  `innerHTML`, hash passwords with a proper library, never commit secrets.

## Stack

| Part      | Choice                                      |
|-----------|---------------------------------------------|
| Backend   | Python, FastAPI, WebSockets                 |
| Frontend  | Plain HTML/CSS/JavaScript (no framework yet) |
| Database  | SQLite (once we need persistence)           |
| Voice     | WebRTC via LiveKit (later)                  |

## Layout

- `server.py`: FastAPI app. Serves the page and the `/ws` WebSocket endpoint that broadcasts messages.
- `static/index.html`: the whole frontend (markup, styles and script in one file for now).
- `setup.ps1`: creates the `chatapp` conda environment and installs `requirements.txt`.

## Running it

Python comes from Anaconda; conda is already hooked into PowerShell. First time (or after changing
`requirements.txt`):

```powershell
.\setup.ps1
```

Every other time:

```powershell
conda activate chatapp
uvicorn server:app --reload
```

Then open http://localhost:8000 in two browser tabs and chat between them.

## Roadmap

1. [ ] One chat room: WebSocket broadcast to everyone connected
2. [ ] Save messages in SQLite and load history when someone joins
3. [ ] Channels (#general, #memes, …) and a sidebar to switch between them
4. [ ] Accounts and login (hashed passwords, sessions)
5. [ ] Online list and "is typing…" indicator
6. [ ] Image and file uploads
7. [ ] Host it so friends can connect (VPS, or a Cloudflare Tunnel/Tailscale)
8. [ ] Voice channels with WebRTC/LiveKit
9. [ ] Nice-to-haves: reactions, replies, mentions, notifications, desktop app via Tauri

Tick milestones off here as they're finished.
