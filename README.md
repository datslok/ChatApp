# ChatApp

A small Discord-style chat app for me and my friends, built as a learning project.

Backend in Python ([FastAPI](https://fastapi.tiangolo.com/) with WebSockets), frontend in plain
HTML, CSS and JavaScript.

> **Status:** just getting started. Nothing runs yet.

## Running it locally

You need [Anaconda](https://www.anaconda.com/) (or Miniconda). In PowerShell:

```powershell
.\setup.ps1                   # first time: creates the "chatapp" environment and installs packages
.\start.ps1                   # starts the server (Ctrl+C to stop)
```

Then open http://localhost:8000 in two browser tabs and chat between them.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for what's planned and what's done.
