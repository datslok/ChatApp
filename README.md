# ChatApp

A small Discord-style chat app for me and my friends, built as a learning project.

Backend in Python ([FastAPI](https://fastapi.tiangolo.com/) with WebSockets), frontend in plain
HTML, CSS and JavaScript.

> **Status:** just getting started. Nothing runs yet.

## Running it locally

You need [Anaconda](https://www.anaconda.com/) (or Miniconda). In PowerShell:

```powershell
.\setup.ps1                   # first time: creates the "chatapp" environment and installs packages
conda activate chatapp
uvicorn server:app --reload
```

Then open http://localhost:8000 in two browser tabs and chat between them.

## Roadmap

- [ ] One chat room
- [ ] Message history (SQLite)
- [ ] Channels
- [ ] Accounts and login
- [ ] Online list and "is typing…"
- [ ] Image and file uploads
- [ ] Hosting so friends can connect
- [ ] Voice channels
