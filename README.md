# ChatApp

A small Discord-style chat app for me and my friends, built as a learning project.

Backend in Python ([FastAPI](https://fastapi.tiangolo.com/) with WebSockets), frontend in plain
HTML, CSS and JavaScript.

Features so far: channels, direct messages, accounts, online list, "is typing…", unread dots, and
image/file uploads (with drag-and-drop and pasting).

## Running it locally

You need [Anaconda](https://www.anaconda.com/) (or Miniconda). In PowerShell:

```powershell
.\setup.ps1                   # first time: creates the "chatapp" environment and installs packages
.\start.ps1                   # starts the server for development (Ctrl+C to stop)
```

Then open http://localhost:8001 in two browser tabs and chat between them.

## Running it for real

Copy `.env.example` to `.env` and set your own `INVITE_CODE` (people need it to create an account),
then run `.\serve.ps1`. It only listens on the local machine, so put something like a Cloudflare
Tunnel in front of it to reach it from the internet over HTTPS.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for what's planned and what's done.
