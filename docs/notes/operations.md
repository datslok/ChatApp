# Running and operating the server

The scripts for running the chat in development and for real, setting up and moving the server PC,
backups, deploying from the development PC, and the `.env` files. The step-by-step manual for all of this is
in README.md.

## The roadmap

`ROADMAP.md` holds the milestones, ticked off as they're done.

## Running it

| Script | What it does |
|--------|--------------|
| `setup.ps1` | Creates the `chatapp` conda environment and installs `requirements.txt`. |
| `start.ps1` | Activates the environment and starts the server with auto-reload (development). |
| `serve.ps1` | Runs the real site for chat.datslok.no: no reload, localhost only, settings from `.env`. |
| `voice.ps1` | Runs LiveKit, for voice (see [voice.md](voice.md)). |

`serve.ps1` uses `.venv` if there is one (the server PC), else the conda environment. `-LogFile` (used by the
scheduled tasks) writes everything to a log instead of the window; `voice.ps1` has the same option.

## Setting up and moving the server

The README covers this in "Host your own" and "Moving to another PC".

| Script | Where | What it does |
|--------|-------|--------------|
| `scripts\server\export.ps1` | old PC | Makes `chatapp-data.zip` with chat.db, uploads/, releases/ and .env. |
| `scripts\server\import.ps1` | new PC | Brings that data in on the new PC. |
| `scripts\server\install.ps1` | new PC, as admin | Sets everything up (below). |
| `scripts\server\update.ps1` | server | git pull, packages, restart the chat; `-Voice` also restarts LiveKit. |
| `tools/copy_db.py` | anywhere | Makes a safe copy of a live database (SQLite's backup function). |

`scripts\server\install.ps1` installs and sets up:

- Python + `.venv`;
- LiveKit;
- the cloudflared service;
- the firewall;
- power settings;
- the scheduled tasks "ChatApp" and "ChatApp voice", at boot and every 5 minutes if not running;
- Task Scheduler's history (turned on);
- logs in `logs\`.

## Backups

On the server PC, `scripts/server/backup.ps1` runs as the scheduled task "ChatApp backup" at 04:00 (set up by
install.ps1 step 8). It puts into `E:\ChatApp-backups`, on the server PC's second disk:

- a dated `chat.db` + `.env` (the last 30 days);
- all of `uploads/` and `releases/` (robocopy, nothing deleted).

Its log is `logs/backup.log`.

On the development PC, `scripts/backup-fetch.ps1` (task "ChatApp backup fetch", 05:00, set up with `-Install`)
copies the newest one to `~\ChatApp-backups` over SSH.

Restoring is described in the README, "Backups".

## From the development PC

First run `scripts\server-connect.ps1` once: it makes an SSH key and adds the name `chatserver` to
`~/.ssh/config`. Then:

| Script | What it does |
|--------|--------------|
| `scripts\deploy.ps1` | Pushes if needed and runs `scripts\server\update.ps1` on the server over SSH. |
| `scripts\release-upload.ps1` | Copies a new desktop app release into the server's `releases\` and runs deploy.ps1. |
| `scripts\set-server-secret.ps1 NAME` | Changes one existing value in the server's .env. |
| `scripts\usage.ps1` | Shows the space used on the server. Only reads. |

### release-upload.ps1

After copying the release, it deletes the older installers there and locally (only the one latest.json names
stays), and then runs deploy.ps1: the restart makes open apps reconnect and update. See
[desktop-app.md](desktop-app.md).

### set-server-secret.ps1

- It asks for the value with Read-Host -AsSecureString.
- The value goes in through ssh's stdin, never a command line; the server part runs as -EncodedCommand.
- It drops Windows PowerShell's piped BOM.
- Then it restarts "ChatApp" and "ChatApp bot".

**The user runs it, so keys never pass through me** (Claude).

### usage.ps1

It runs `scripts\server\usage.ps1`, which shows the database, uploads by kind, releases, logs, leftover
.db/.zip files, backups and free disk.

### SSH

The server PC's SSH server (step 7 of scripts\server\install.ps1) only accepts the home network.

## The .env files

- `.env.example` is the template for `.env` (SECURE_COOKIES, the keys). `.env` itself is never committed.
- The git-ignored development files have templates too:
  - `dev-secrets.env.example` (GIPHY_API_KEY for start.ps1);
  - `dev-chattus.env.example` (chattus.ps1 -Dev; see [chattus.md](chattus.md)).
- `dev.env` has no secrets, so it's committed as it is (see [server.md](server.md#devenv)).
