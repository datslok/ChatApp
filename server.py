import asyncio
import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import re
import secrets
import shutil
import smtplib
import socket
import sqlite3
import ssl
import subprocess
import time
import urllib.request
import warnings
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr
from html.parser import HTMLParser
from io import BytesIO
from pathlib import Path
from urllib.parse import quote, urlencode, urljoin, urlsplit

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageSequence
from pydantic import BaseModel
from pywebpush import WebPushException, webpush
from starlette.exceptions import HTTPException as StarletteHTTPException

# docs_url etc. = None: turn off FastAPI's automatic API explorer pages (/docs, /redoc),
# handy in development but nothing the public internet needs to see.
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(StarletteHTTPException)
async def errors_are_never_cached(request, error):
    """Every error answer (404 not found, 403, ...) gets "Cache-Control: no-store": never keep it.
    Otherwise Cloudflare may keep a 404 for hours (it adds its own 4 hours to answers that don't
    say), and browsers with it: a file that was briefly missing during an update would stay
    "missing" long after. FastAPI builds the answer as usual; we only add the header.
    (Starlette's HTTPException: the one behind FastAPI's own, which also covers unknown addresses.)"""
    response = await http_exception_handler(request, error)
    response.headers["Cache-Control"] = "no-store"
    return response

# Settings from the environment. serve.ps1 loads them from the .env file (which is never committed).
# New accounts need an invite link from someone in the chat ("Invites"). Only "0" turns that off (dev.env:
# development has no strangers), so a server whose .env forgot it stays closed.
REQUIRE_INVITE = os.environ.get("REQUIRE_INVITE", "1") != "0"
SECURE_COOKIES = os.environ.get("SECURE_COOKIES") == "1"  # 1 = cookies only ever sent over HTTPS
# Where messages and files are kept. Development (start.ps1, via dev.env) uses its own,
# so test messages never end up in the real chat.
DATABASE_FILE = os.environ.get("DATABASE_FILE", "chat.db")
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "uploads"))
RELEASES_DIR = Path("releases")  # the desktop app's installers and latest.json (see /releases/)
# The site's own address, for links in emails. Never taken from the request: a request can
# claim any host name, which would let someone make us email links to *their* site.
PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://localhost:8000").rstrip("/")
# The main domain (like "example.com"), if it should show the landing page (static/landing/): what
# ChatApp is, with buttons to the chat. Empty = no landing page there (it's always at /welcome).
LANDING_HOST = os.environ.get("LANDING_HOST", "").lower()
# The mail server that sends our emails (password reset links). Empty = print emails here instead.
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
# Who emails come from. By default noreply@ the site's own domain (from PUBLIC_URL).
MAIL_FROM = os.environ.get("MAIL_FROM", f"ChatApp <noreply@{urlsplit(PUBLIC_URL).hostname}>")
# The LiveKit server that carries voice (voice.ps1), and the key and secret it shares with us:
# we sign the tickets ("tokens") that let people into a voice room, and LiveKit checks them.
LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "")
# Push notifications (the phone app): our key pair, made once by tools/make_vapid_keys.py. The push
# services only deliver pushes signed with the private key. Without them: no push notifications.
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
# Push notifications for the native phone app go through Firebase Cloud Messaging: the Firebase
# project's service account key (a JSON file from Firebase's console, never committed) lets us
# send them. Without it: no pushes to the app (the web's still work).
FIREBASE_KEY_FILE = Path(os.environ.get("FIREBASE_KEY_FILE", "firebase-key.json"))
print(f"Using database {DATABASE_FILE} and upload folder {UPLOAD_DIR}/")
if not REQUIRE_INVITE:
    print("WARNING: REQUIRE_INVITE=0, so anyone who can reach this server can create an account.")
if not SMTP_HOST:
    print("No SMTP_HOST set: emails will be printed here instead of sent.")

MAX_CHANNEL_NAME = 30  # characters, for channels and headings (Settings → Channels)
MAX_CHANNELS = 50      # channels and headings together

# Every emoji allowed as a reaction, from static/emoji.json (made from Unicode's official list by
# tools/make_emoji_json.py). The page's emoji picker uses the same file, so they always agree.
# Without a list, someone with their own script could "react" with any text at all.
with open("static/emoji.json", encoding="utf-8") as emoji_file:
    ALLOWED_EMOJI = {emoji for group in json.load(emoji_file)["groups"] for emoji, name in group["emoji"]}
MAX_TEXT_LENGTH = 2000
HISTORY_LIMIT = 50  # how many messages a channel opens with, and how many more each scroll up loads

USERNAME_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,32}")  # 1-32 letters, digits, _ or -
RESERVED_NAMES = {"everyone", "here"}  # would be confused with @everyone
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 200
SESSION_COOKIE = "session"
SESSION_DAYS = 30        # how long a login lasts before the page asks for the password again
MAX_FAILURES = 5          # wrong passwords (or invite codes) allowed...
FAILURE_WINDOW = 15 * 60  # ...within this many seconds, before we refuse to check more
# Good enough to catch typos: something@something.something, no spaces.
EMAIL_PATTERN = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
MAX_EMAIL_LENGTH = 254
RESET_MINUTES = 60  # how long a password reset link works
VERIFY_HOURS = 24   # how long an email verification link works
INVITE_DAYS = 7     # how long an invite link works (once)
MAX_OPEN_INVITES = 10  # unused invite links per person

UPLOAD_DIR.mkdir(exist_ok=True)  # create the folder if it isn't there yet
MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50 MB, in bytes
MAX_FILENAME_LENGTH = 200
# Only these are shown in the page. They're pure pictures and can't contain scripts.
# Everything else (including SVG, which can) is only ever offered as a download.
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
# Videos are played in the page too: the two formats every browser plays. Like pictures they can't run
# scripts, and we only believe the type if the file's first bytes say so too (is_video).
VIDEO_TYPES = {"video/mp4", "video/webm"}
SHOWN_TYPES = IMAGE_TYPES | VIDEO_TYPES  # served "inline" (shown), not as a download


def is_video(path, content_type):
    """Does this file really start like a video of that type? Every file format begins with its own
    few bytes, its "magic number": an MP4 has "ftyp" at byte 4, a WebM starts with 1A 45 DF A3.
    So a file can't become a "video" just by being called one."""
    with open(path, "rb") as file:
        start = file.read(12)
    if content_type == "video/mp4":
        return start[4:8] == b"ftyp"
    if content_type == "video/webm":
        return start[:4] == b"\x1a\x45\xdf\xa3"
    return False

# Profiles. The page crops and shrinks pictures before uploading (a profile picture to 256x256,
# a banner to 960x320: a few KB each), so these limits are only for anyone uploading around the page.
# For each kind: which column of the users table holds it, which folder its files go in, how big it may be.
# `animated_size`: animated GIFs are cropped and shrunk here on the server instead (see
# make_animated_webp), to this size. Banners are a bit smaller when animated, because all
# frames are held in memory while they're processed.
PICTURE_KINDS = {
    "avatar": {
        "column": "avatar_id", "folder": UPLOAD_DIR / "avatars",
        "max_size": 1024 * 1024, "animated_size": (256, 256),      # 1 MB
    },
    "banner": {
        "column": "banner_id", "folder": UPLOAD_DIR / "banners",
        "max_size": 2 * 1024 * 1024, "animated_size": (600, 200),  # 2 MB
    },
    # Custom emoji aren't a column of users (they have their own table), but are received the same way.
    "emoji": {
        "column": None, "folder": UPLOAD_DIR / "emoji",
        "max_size": 512 * 1024, "animated_size": (128, 128),       # 512 KB
    },
}
MAX_CUSTOM_EMOJI = 12  # per person
EMOJI_NAME_PATTERN = re.compile(r"[A-Za-z0-9_]{2,32}")
for kind in PICTURE_KINDS.values():
    kind["folder"].mkdir(exist_ok=True)
PICTURE_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}

# Animated GIFs arrive uncropped (the browser can't crop an animation), so they may be bigger.
# Images from users are a classic way to attack servers, so Pillow gets limits: file size,
# number of frames, and pixels per frame (a tiny file can claim to be 50,000 x 50,000 pixels:
# a "decompression bomb" that would fill the memory).
MAX_GIF_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_GIF_FRAMES = 200
Image.MAX_IMAGE_PIXELS = 25_000_000  # e.g. 5000 x 5000
# Above that limit Pillow only *warns* (it refuses at twice the limit). Turn the warning into an error.
warnings.simplefilter("error", Image.DecompressionBombWarning)
MAX_STATUS_LENGTH = 60
MAX_BIO_LENGTH = 300

hasher = PasswordHasher()

# Every open connection (one per browser tab) and what we know about it: the channel it's looking
# at, and the voice room it says it's in (and whether it's muted or deafened there).
# {websocket: {"user_id": 3, "channel": "memes", "voice": "lounge", "muted": False, "deafened": False}}
clients = {}


# ---------- Database ----------
#
# People are identified everywhere by their user id (users.id), never by their username.
# The username is stored in exactly one place, the users table, and looked up when it's shown.
# That way a username can change without touching anything else.

db = sqlite3.connect(DATABASE_FILE)
db.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        email         TEXT,  -- stored in lowercase; NULL for accounts made before emails existed
        avatar_id     TEXT,  -- profile picture's file name in uploads/avatars, like "Xk9...a.webp"; NULL = none
        banner_id     TEXT,  -- profile banner's file name in uploads/banners; NULL = none
        status        TEXT,  -- a short line like "playing Minecraft"; NULL = none
        bio           TEXT,  -- a few lines about yourself; NULL = none
        is_admin      INTEGER NOT NULL DEFAULT 0, -- 1 = may edit and delete anyone's messages (tools/make_admin.py)
        appearance    TEXT,  -- Settings → Appearance as JSON, like {"theme": "light", ...}; NULL = the defaults
        presence      TEXT NOT NULL DEFAULT 'online'  -- the status they chose: online, idle, dnd or invisible
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS messages (
        id            INTEGER PRIMARY KEY,
        channel       TEXT NOT NULL DEFAULT 'general',  -- "general", or "dm:3:7" for a DM
        user_id       INTEGER REFERENCES users(id),     -- who sent it
        legacy_name   TEXT,  -- only for messages from before accounts existed (no user_id)
        text          TEXT NOT NULL,
        sent_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        attachment_id TEXT REFERENCES attachments(id),
        reply_to      INTEGER REFERENCES messages(id),  -- the message this one replies to; NULL = none
        edited_at     TEXT,                             -- when it was last edited; NULL = never
        kind          TEXT,                             -- NULL = a normal message, "call" = a call note, "pin" = a pin note
        pinned_at     TEXT,                             -- when it was pinned; NULL = not pinned
        pinned_by     INTEGER REFERENCES users(id)      -- who pinned it
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS attachments (
        id           TEXT PRIMARY KEY,
        filename     TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size         INTEGER NOT NULL,
        uploader_id  INTEGER REFERENCES users(id),
        channel      TEXT,  -- NULL until the file is sent in a message
        created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS last_read (
        user_id    INTEGER NOT NULL REFERENCES users(id),
        channel    TEXT NOT NULL,
        message_id INTEGER NOT NULL,  -- the newest message this user has seen in this channel
        PRIMARY KEY (user_id, channel)  -- one row per person per channel
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS reactions (
        message_id INTEGER NOT NULL REFERENCES messages(id),
        user_id    INTEGER NOT NULL REFERENCES users(id),
        emoji      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        -- All three together: each person can use each emoji once per message
        -- (but several different emoji).
        PRIMARY KEY (message_id, user_id, emoji)
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS mentions (
        message_id INTEGER NOT NULL REFERENCES messages(id),
        user_id    INTEGER NOT NULL REFERENCES users(id),  -- someone mentioned (by name, or by @everyone)
        PRIMARY KEY (message_id, user_id)
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS custom_emoji (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- one :pog: for everyone, whatever the case
        file       TEXT NOT NULL,                        -- its file name in uploads/emoji
        owner_id   INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY,  -- a hash of the token in the emailed link, never the token itself
        user_id    INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS email_verifications (
        token_hash TEXT PRIMARY KEY,  -- a hash of the token in the emailed link, like password_resets
        user_id    INTEGER NOT NULL REFERENCES users(id),
        email      TEXT NOT NULL,     -- the address it was sent to: the link verifies that one only
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS invites (
        code       TEXT PRIMARY KEY,  -- the random part of the link: /invite/<code>
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- it works for INVITE_DAYS after this
        used_by    INTEGER REFERENCES users(id),  -- who made an account with it; NULL = not used yet
        used_at    TEXT
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS feedback (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id),  -- who sent it
        kind       TEXT NOT NULL,                          -- "bug" or "idea"
        text       TEXT NOT NULL,
        user_agent TEXT,  -- which browser (or the app) it was sent from, handy for bugs
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        done       INTEGER NOT NULL DEFAULT 0  -- 1 = dealt with (tools/feedback.py --done)
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint    TEXT PRIMARY KEY,  -- the push service's address for one browser on one device
        user_id     INTEGER NOT NULL REFERENCES users(id),
        p256dh      TEXT NOT NULL,     -- that browser's public key: each push is encrypted for it
        auth        TEXT NOT NULL,     -- a secret shared with that browser, also for the encryption
        muted_until REAL,              -- "Mute notifications" on that device, as a Unix time; NULL = not muted
        created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS link_previews (
        message_id  INTEGER PRIMARY KEY REFERENCES messages(id),  -- one preview per message at most
        url         TEXT NOT NULL,  -- the link it's for (after redirects)
        site        TEXT,           -- "YouTube", or the address's host name
        title       TEXT,
        description TEXT,
        image       TEXT            -- its picture's file name in uploads/previews; NULL = none
    )
""")
# The sidebar's channels and headings (Settings → Channels, for admins). Messages point to a
# channel by its key, which never changes, so renaming one only changes its name.
db.execute("""
    CREATE TABLE IF NOT EXISTS channels (
        key      TEXT PRIMARY KEY,           -- what messages.channel holds: "general", or "c:5f3a9b21"
        name     TEXT NOT NULL,              -- what people see after the #
        position INTEGER NOT NULL,           -- the order in the sidebar, from the top
        heading  INTEGER NOT NULL DEFAULT 0  -- 1 = a heading over the channels below it ("h:..."), not a channel
    )
""")
# Group DMs: private chats for 3 to 10 people. Their messages are saved under the group's key
# ("g:5f3a9b21"), the way a DM's are under "dm:3:7".
db.execute("""
    CREATE TABLE IF NOT EXISTS group_dms (
        key        TEXT PRIMARY KEY,  -- "g:" and 8 random hex digits
        name       TEXT,              -- NULL = called after its members ("kari, ola")
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS group_members (
        group_key TEXT NOT NULL REFERENCES group_dms(key),
        user_id   INTEGER NOT NULL REFERENCES users(id),
        PRIMARY KEY (group_key, user_id)  -- each person once per group
    )
""")
# Roles (Settings → Roles, for admins): a name and a colour; people can have several, and the one
# highest in the list colours their name and places them in the member list (see "Roles").
db.execute("""
    CREATE TABLE IF NOT EXISTS roles (
        id       INTEGER PRIMARY KEY,
        name     TEXT NOT NULL,
        colour   TEXT NOT NULL,     -- "#3ba55c"
        position INTEGER NOT NULL   -- the order in the list, from the top (the top one wins)
    )
""")
db.execute("""
    CREATE TABLE IF NOT EXISTS user_roles (
        user_id INTEGER NOT NULL REFERENCES users(id),
        role_id INTEGER NOT NULL REFERENCES roles(id),
        PRIMARY KEY (user_id, role_id)  -- each role once per person
    )
""")
# Blocked people: one row per person someone blocked (see "Blocking").
db.execute("""
    CREATE TABLE IF NOT EXISTS blocks (
        blocker_id INTEGER NOT NULL REFERENCES users(id),  -- who blocked
        blocked_id INTEGER NOT NULL REFERENCES users(id),  -- whom
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (blocker_id, blocked_id)
    )
""")
# Muted chats: one row per person per chat they muted (the 🔔 at the top of a chat; see "Muting").
db.execute("""
    CREATE TABLE IF NOT EXISTS chat_mutes (
        user_id INTEGER NOT NULL REFERENCES users(id),
        channel TEXT NOT NULL,  -- a channel's key, a DM ("dm:3:7") or a group ("g:...")
        PRIMARY KEY (user_id, channel)
    )
""")
if db.execute("SELECT COUNT(*) FROM channels").fetchone()[0] == 0:
    # The first start with this table (or a brand new database): the channels that used to be
    # written in the code. Their keys are their old names, so every message stays where it was.
    with db:
        db.executemany(
            "INSERT INTO channels (key, name, position) VALUES (?, ?, ?)",
            [("general", "general", 0), ("memes", "memes", 1), ("chattus", "chattus", 2)],
        )


def create_friendships_table():
    """Friendships and friend requests: one row per pair of people. user_a is always the smaller
    id (like in DM names "dm:3:7"), so each pair can only have one row, whoever asked first."""
    db.execute("""
        CREATE TABLE friendships (
            user_a       INTEGER NOT NULL REFERENCES users(id),
            user_b       INTEGER NOT NULL REFERENCES users(id),
            requested_by INTEGER NOT NULL REFERENCES users(id),  -- who sent the request
            accepted     INTEGER NOT NULL DEFAULT 0,             -- 0 = request pending, 1 = friends
            created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_a, user_b),
            CHECK (user_a < user_b)  -- the database itself refuses a row in the wrong order
        )
    """)


def table_exists(table):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone() is not None


def table_columns(table):
    return [row[1] for row in db.execute(f"PRAGMA table_info({table})")]


# Migrations: bring databases made by older versions of this code up to date.
# Each one checks the table's current shape, so it only ever runs once.

if "channel" not in table_columns("messages"):
    # From before channels existed: the DEFAULT puts all the old messages in #general.
    with db:
        db.execute("ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'general'")
if "attachment_id" not in table_columns("messages"):
    # From before uploads existed: old messages simply have no attachment (NULL).
    with db:
        db.execute("ALTER TABLE messages ADD COLUMN attachment_id TEXT REFERENCES attachments(id)")
if "email" not in table_columns("users"):
    # From before emails existed: old accounts have none (NULL) until they add one in Settings.
    with db:
        db.execute("ALTER TABLE users ADD COLUMN email TEXT")
for column in ("avatar_id", "banner_id", "status", "bio"):
    if column not in table_columns("users"):
        # From before profiles existed: everyone starts with no picture, banner, status or bio (NULL).
        with db:
            db.execute(f"ALTER TABLE users ADD COLUMN {column} TEXT")
# A unique index: a lookup table SQLite keeps next to the users table (fast "who has this email?"),
# which also refuses a second account with the same email. Several NULLs are allowed.
db.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email)")


def migrate_names_to_ids():
    """From before user ids were used: messages, attachments and unread state referred to people
    by username, and DMs were called "dm:axel:kari". Rebuild those tables to use user ids, and
    rename DMs to "dm:3:7".

    SQLite can't change a column or a primary key in place, so each table is rebuilt: create the
    new version, copy the rows across (turning names into ids), drop the old one, rename the new one.
    All of it happens in one transaction: if anything fails, nothing changes at all."""
    with db:
        # Python's sqlite3 only starts a transaction by itself before INSERT/UPDATE/DELETE,
        # not before CREATE/DROP, so we start one ourselves to cover everything.
        db.execute("BEGIN")

        if "name" in table_columns("messages"):
            db.execute("""
                CREATE TABLE messages_new (
                    id            INTEGER PRIMARY KEY,
                    channel       TEXT NOT NULL DEFAULT 'general',
                    user_id       INTEGER REFERENCES users(id),
                    legacy_name   TEXT,
                    text          TEXT NOT NULL,
                    sent_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    attachment_id TEXT REFERENCES attachments(id)
                )
            """)
            # LEFT JOIN: every message, plus the account with that name if there is one.
            # No account (the "type your name" days)? Then keep the typed name as legacy_name.
            db.execute("""
                INSERT INTO messages_new (id, channel, user_id, legacy_name, text, sent_at, attachment_id)
                SELECT messages.id, messages.channel, users.id,
                       CASE WHEN users.id IS NULL THEN messages.name END,
                       messages.text, messages.sent_at, messages.attachment_id
                FROM messages LEFT JOIN users ON users.username = messages.name COLLATE NOCASE
            """)
            db.execute("DROP TABLE messages")
            db.execute("ALTER TABLE messages_new RENAME TO messages")

        if "uploader" in table_columns("attachments"):
            db.execute("""
                CREATE TABLE attachments_new (
                    id           TEXT PRIMARY KEY,
                    filename     TEXT NOT NULL,
                    content_type TEXT NOT NULL,
                    size         INTEGER NOT NULL,
                    uploader_id  INTEGER REFERENCES users(id),
                    channel      TEXT,
                    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """)
            db.execute("""
                INSERT INTO attachments_new (id, filename, content_type, size, uploader_id, channel, created_at)
                SELECT attachments.id, attachments.filename, attachments.content_type, attachments.size,
                       users.id, attachments.channel, attachments.created_at
                FROM attachments LEFT JOIN users ON users.username = attachments.uploader COLLATE NOCASE
            """)
            db.execute("DROP TABLE attachments")
            db.execute("ALTER TABLE attachments_new RENAME TO attachments")

        if "username" in table_columns("last_read"):
            db.execute("""
                CREATE TABLE last_read_new (
                    user_id    INTEGER NOT NULL REFERENCES users(id),
                    channel    TEXT NOT NULL,
                    message_id INTEGER NOT NULL,
                    PRIMARY KEY (user_id, channel)
                )
            """)
            # A plain JOIN here: unread state for a name with no account is simply dropped.
            db.execute("""
                INSERT OR IGNORE INTO last_read_new (user_id, channel, message_id)
                SELECT users.id, last_read.channel, last_read.message_id
                FROM last_read JOIN users ON users.username = last_read.username COLLATE NOCASE
            """)
            db.execute("DROP TABLE last_read")
            db.execute("ALTER TABLE last_read_new RENAME TO last_read")

        # Rename DMs from "dm:axel:kari" to "dm:3:7" everywhere a channel name is stored.
        ids = {name.lower(): user_id for user_id, name in db.execute("SELECT id, username FROM users")}
        old_dms = set()
        for table in ("messages", "attachments", "last_read"):
            old_dms |= {channel for (channel,) in db.execute(f"SELECT DISTINCT channel FROM {table} WHERE channel LIKE 'dm:%'")}
        for old in old_dms:
            names = old.split(":")[1:]
            if len(names) != 2 or not all(name in ids for name in names):
                continue  # already new style ("dm:3:7"), or someone without an account
            first, second = sorted(ids[name] for name in names)
            new = f"dm:{first}:{second}"
            for table in ("messages", "attachments", "last_read"):
                db.execute(f"UPDATE {table} SET channel = ? WHERE channel = ?", (new, old))


if (
    "name" in table_columns("messages")
    or "uploader" in table_columns("attachments")
    or "username" in table_columns("last_read")
):
    print("Updating the database to use user ids...")
    migrate_names_to_ids()


if not table_exists("friendships"):
    # From before friends existed: DMs are now only allowed between friends, and nobody is
    # friends yet, so the old DMs are deleted (messages, their files, unread state).
    # This runs once: the next time, the friendships table exists.
    dm_files = [
        attachment_id
        for (attachment_id,) in db.execute("SELECT id FROM attachments WHERE channel LIKE 'dm:%'")
    ]
    with db:
        db.execute("BEGIN")
        db.execute("DELETE FROM messages WHERE channel LIKE 'dm:%'")
        db.execute("DELETE FROM attachments WHERE channel LIKE 'dm:%'")
        db.execute("DELETE FROM last_read WHERE channel LIKE 'dm:%'")
        create_friendships_table()
    for attachment_id in dm_files:  # only after the database change has been saved
        (UPLOAD_DIR / attachment_id).unlink(missing_ok=True)
    print(f"Friends added: old DMs removed ({len(dm_files)} files).")

if "reply_to" not in table_columns("messages"):
    # From before replies existed: no old message is a reply (NULL). This one comes last,
    # after the table rebuild above, which would otherwise drop the new column again.
    with db:
        db.execute("ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES messages(id)")

if "edited_at" not in table_columns("messages"):
    # From before editing existed: no message has been edited (NULL).
    with db:
        db.execute("ALTER TABLE messages ADD COLUMN edited_at TEXT")

if "kind" not in table_columns("messages"):
    # From before call notes existed: every message is a normal one (NULL).
    with db:
        db.execute("ALTER TABLE messages ADD COLUMN kind TEXT")

if "presence" not in table_columns("users"):
    # From before statuses existed: everyone is Online (the status they'd have chosen anyway).
    with db:
        db.execute("ALTER TABLE users ADD COLUMN presence TEXT NOT NULL DEFAULT 'online'")

if "pinned_at" not in table_columns("messages"):
    # From before pinned messages existed: nothing is pinned (NULL).
    with db:
        db.execute("ALTER TABLE messages ADD COLUMN pinned_at TEXT")  # when it was pinned; NULL = not pinned
        db.execute("ALTER TABLE messages ADD COLUMN pinned_by INTEGER REFERENCES users(id)")  # who pinned it

# Search: a full-text index of every message's text (SQLite's FTS5), like the index at the back of a
# book: for each word, which messages have it, so finding one is a lookup instead of reading every
# message. "content='messages'": the index doesn't keep its own copy of the text, it points to the
# messages table (its id). unicode61 with remove_diacritics: whole words, any case, and "pa" finds
# "på". The first start fills it from every message there is ('rebuild').
if not table_exists("messages_fts"):
    with db:
        db.execute("""
            CREATE VIRTUAL TABLE messages_fts USING fts5(
                text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
            )
        """)
        db.execute("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')")
# ...and kept up to date by the database itself: triggers are bits of SQL that SQLite runs after
# every insert, edit or delete on messages, whichever code did it. ('delete' is how FTS5 is told
# that a text is gone: it needs the old text to find its words.)
with db:
    db.execute("""
        CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
        END
    """)
    db.execute("""
        CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END
    """)
    db.execute("""
        CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF text ON messages BEGIN
            INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
            INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
        END
    """)

if "is_admin" not in table_columns("users"):
    # From before admins existed: nobody is one, until tools/make_admin.py says so.
    with db:
        db.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")

if "appearance" not in table_columns("users"):
    # From before themes existed: everyone keeps the defaults (NULL) until they pick something.
    with db:
        db.execute("ALTER TABLE users ADD COLUMN appearance TEXT")

if "is_bot" not in table_columns("users"):
    # From before the AI bot: nobody is one, until tools/make_bot.py makes its account.
    with db:
        db.execute("ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0")

if "email_verified" not in table_columns("users"):
    # From before email verification: every existing account counts as verified (DEFAULT 1), and so
    # do bots (tools/make_bot.py: they have no email). Only /register makes an account with 0.
    # pending_email: a new address from Settings, waiting for its link to be clicked (NULL = none).
    with db:
        db.execute("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1")
        db.execute("ALTER TABLE users ADD COLUMN pending_email TEXT")

if "is_owner" not in table_columns("users"):
    # The owner (see "Bans and admins"): the first account, which made the server. On a server from
    # before owners existed, that's the oldest admin who isn't a bot.
    with db:
        db.execute("ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0")
        db.execute("UPDATE users SET is_owner = 1 WHERE id = (SELECT MIN(id) FROM users WHERE is_admin = 1 AND is_bot = 0)")

if "banned_at" not in table_columns("users"):
    # Bans: when, until when (NULL = for good), by whom and why. banned_at NULL = not banned.
    with db:
        db.execute("ALTER TABLE users ADD COLUMN banned_at TEXT")
        db.execute("ALTER TABLE users ADD COLUMN banned_until TEXT")
        db.execute("ALTER TABLE users ADD COLUMN banned_by INTEGER REFERENCES users(id)")
        db.execute("ALTER TABLE users ADD COLUMN ban_reason TEXT")

# Private channels and limited roles (see "Who sees which channel").
if "private" not in table_columns("channels"):
    # From before private channels: every channel is open to everyone (0).
    with db:
        db.execute("ALTER TABLE channels ADD COLUMN private INTEGER NOT NULL DEFAULT 0")
if "limited" not in table_columns("roles"):
    # From before limited roles: no role limits anyone (0).
    with db:
        db.execute("ALTER TABLE roles ADD COLUMN limited INTEGER NOT NULL DEFAULT 0")
if "hidden" not in table_columns("roles"):
    # From before hidden roles: every role shows (0).
    with db:
        db.execute("ALTER TABLE roles ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0")
# Which roles see a private channel: one row per channel per role. (An open channel has none.)
db.execute("""
    CREATE TABLE IF NOT EXISTS channel_roles (
        channel TEXT NOT NULL REFERENCES channels(key),
        role_id INTEGER NOT NULL REFERENCES roles(id),
        PRIMARY KEY (channel, role_id)
    )
""")

# "Banned right now", as SQL about a row of users: banned, and either for good or not over yet.
# (Times in SQLite's own form, "2026-10-21 14:30:00" in UTC, so they compare as text.)
BANNED_NOW = "(users.banned_at IS NOT NULL AND (users.banned_until IS NULL OR users.banned_until > datetime('now')))"


def is_bot(user_id):
    """Is this the AI bot's account (tools/make_bot.py)? Bots may be invited into DMs (see can_join)."""
    row = db.execute("SELECT is_bot FROM users WHERE id = ?", (user_id,)).fetchone()
    return row is not None and row[0] == 1


def befriend_bots():
    """Everyone is friends with every bot (so anyone can DM Chattus without a request): adds the
    missing friendships as accepted, and turns open requests with a bot into friendships. At every
    start (for everyone so far, and a bot made by tools/make_bot.py since) and for each new account."""
    with db:
        # Every pair of a person and a bot, smallest id first (the table's rule), unless the pair
        # already has a row: "INSERT OR IGNORE" skips those (PRIMARY KEY (user_a, user_b)).
        db.execute("""
            INSERT OR IGNORE INTO friendships (user_a, user_b, requested_by, accepted)
            SELECT MIN(person.id, bot.id), MAX(person.id, bot.id), bot.id, 1
            FROM users AS person, users AS bot
            WHERE bot.is_bot = 1 AND person.id != bot.id
        """)
        db.execute("""
            UPDATE friendships SET accepted = 1
            WHERE accepted = 0 AND (user_a IN (SELECT id FROM users WHERE is_bot = 1)
                                    OR user_b IN (SELECT id FROM users WHERE is_bot = 1))
        """)


befriend_bots()


def add_bots_to_groups():
    """Every bot is in every group DM (Chattus answers @mentions there). New groups get them when
    they're made (create_group); this adds them to the groups made before, and a bot made since.
    INSERT OR IGNORE: skip the rows that are already there (the table's PRIMARY KEY)."""
    with db:
        db.execute(
            "INSERT OR IGNORE INTO group_members (group_key, user_id)"
            " SELECT group_dms.key, users.id FROM group_dms, users WHERE users.is_bot = 1"
        )


add_bots_to_groups()


def mark_old_videos():
    """Videos sent before the page could play them were stored as plain downloads. At every start:
    those with a video's name whose first bytes say so too become videos. (Only looks at .mp4 and
    .webm downloads, so after the first time there's next to nothing to check.)"""
    rows = db.execute(
        "SELECT id, filename FROM attachments WHERE content_type = 'application/octet-stream'"
        " AND (LOWER(filename) LIKE '%.mp4' OR LOWER(filename) LIKE '%.webm')"
    ).fetchall()
    for file_id, filename in rows:
        content_type = "video/webm" if filename.lower().endswith(".webm") else "video/mp4"
        path = UPLOAD_DIR / file_id
        if path.exists() and is_video(path, content_type):
            with db:
                db.execute("UPDATE attachments SET content_type = ? WHERE id = ?", (content_type, file_id))


mark_old_videos()


# ---------- Re-packing videos ----------
#
# A video file is a container (MP4, WebM) holding the picture and sound, plus an index: how long it is
# and where each moment is in the file. Some programs (screen recorders, browsers' own recordings, video
# downloaders) write "fragmented" files: many small pieces, with the header saying the length is 0 and
# the real index at the very end. Browsers cope; Android's player (the phone app's) can't tell how long
# such a video is or skip in it. So every uploaded video is re-packed once by ffmpeg: the same picture
# and sound, copied as they are ("-c copy", nothing re-encoded: a second or two, no quality lost), into
# an ordinary file with the length and index at the start ("+faststart", which also lets a video begin
# playing before it's all downloaded). If ffmpeg isn't installed, or fails on a file, the original stays.

def find_ffmpeg():
    """ffmpeg's path, or None. On our PATH, or else on the PATH as Windows has it now: a program keeps
    the PATH it started with, so a server (or scheduled task) started before ffmpeg was installed
    wouldn't see it. Windows keeps the current one in the registry, for all users and for this one
    (install.ps1's Update-Path reads the same two)."""
    found = shutil.which("ffmpeg")
    if found or os.name != "nt":
        return found
    import winreg  # (Windows only)
    folders = []
    for root, key in ((winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
                      (winreg.HKEY_CURRENT_USER, "Environment")):
        try:
            with winreg.OpenKey(root, key) as opened:
                folders.append(winreg.QueryValueEx(opened, "Path")[0])
        except OSError:
            pass
    return shutil.which("ffmpeg", path=os.path.expandvars(";".join(folders)))


FFMPEG = find_ffmpeg()
if FFMPEG is None:
    print("ffmpeg isn't installed: uploaded videos are kept as they are (see README, \"Videos\").", flush=True)


def repack_video(path, content_type):
    """Re-pack the video at `path` in place (see above). True if it was replaced. Slow-ish (it runs a
    program), so it's called in a background thread."""
    if FFMPEG is None:
        return False
    container = "mp4" if content_type == "video/mp4" else "webm"
    temporary = path.with_name(path.name + ".repack")
    command = [FFMPEG, "-v", "error", "-y", "-i", str(path), "-map", "0:v", "-map", "0:a?", "-c", "copy"]
    if container == "mp4":
        command += ["-movflags", "+faststart"]
    command += ["-f", container, str(temporary)]
    try:
        # A list, never one string through a shell: the path can't be read as a command. 60 s at most.
        result = subprocess.run(command, capture_output=True, timeout=60)
        if result.returncode == 0 and temporary.stat().st_size > 0 and is_video(temporary, content_type):
            os.replace(temporary, path)  # swaps the file in one go: nobody ever gets half of one
            return True
        print(f"Couldn't re-pack {path.name}: {result.stderr.decode(errors='replace')[-300:]}", flush=True)
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"Couldn't re-pack {path.name}: {error}", flush=True)
    temporary.unlink(missing_ok=True)
    return False


def mp4_is_fragmented(path):
    """Does this MP4 need re-packing: is it in pieces ("moof" boxes), or is its index after the picture
    and sound ("moov" after "mdat")? An MP4 is a row of boxes, each starting with its size (4 bytes) and
    its kind (4 letters); this reads only those headers, skipping over each box."""
    seen = []
    with open(path, "rb") as file:
        while len(seen) < 1000:
            header = file.read(8)
            if len(header) < 8:
                break
            size, kind = int.from_bytes(header[:4], "big"), header[4:8]
            seen.append(kind)
            if size == 1:  # a big box: its real size follows, in 8 bytes
                size = int.from_bytes(file.read(8), "big") - 8
            elif size == 0:  # "until the end of the file"
                break
            file.seek(size - 8, os.SEEK_CUR)
    if b"moof" in seen:
        return True
    return b"mdat" in seen and b"moov" in seen and seen.index(b"mdat") < seen.index(b"moov")


if "repacked" not in table_columns("attachments"):
    # 1 once a video has been through repack_video (whether or not it needed it), so each is done once.
    with db:
        db.execute("ALTER TABLE attachments ADD COLUMN repacked INTEGER NOT NULL DEFAULT 0")


async def repack_old_videos():
    """Videos uploaded before re-packing existed, and the seasonal videos (seasonal/, see "Seasons"):
    re-packed once, in the background, started by the first connection (like watch_presences).
    The database is only touched here, in the server's own thread; ffmpeg runs in another."""
    if FFMPEG is None:
        return
    rows = db.execute(
        "SELECT id, content_type FROM attachments WHERE content_type IN ('video/mp4', 'video/webm') AND repacked = 0"
    ).fetchall()
    for file_id, content_type in rows:
        path = UPLOAD_DIR / file_id
        if path.exists() and await asyncio.to_thread(repack_video, path, content_type):
            with db:
                db.execute("UPDATE attachments SET size = ? WHERE id = ?", (path.stat().st_size, file_id))
        with db:
            db.execute("UPDATE attachments SET repacked = 1 WHERE id = ?", (file_id,))
    for season in SEASONS:
        path = SEASONAL_DIR / season["video"]
        if path.is_file() and await asyncio.to_thread(mp4_is_fragmented, path):
            if await asyncio.to_thread(repack_video, path, "video/mp4"):
                print(f"Re-packed seasonal/{season['video']}.", flush=True)

repacker = None  # the task above, started by the first connection (it needs the running loop)


def is_admin(user_id):
    """Checked fresh from the database every time, so tools/make_admin.py works straight away."""
    row = db.execute("SELECT is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
    return bool(row and row[0])


def username_of(user_id):
    row = db.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
    return row[0] if row else None


# ---------- Messages ----------

def iso_time(sqlite_time):
    """SQLite stores times as "2026-10-10 14:03:12" (in UTC, but without saying so). Browsers would
    read that as *local* time. "2026-10-10T14:03:12Z" is the standard (ISO 8601) way to write it:
    the Z means UTC, and every browser understands it."""
    return sqlite_time.replace(" ", "T") + "Z"


def save_message(channel, user_id, text, file, reply_to, kind=None):
    """Save a message (kind: None for a normal one, "call" for a call note). Returns its id and
    time, so the live message matches the history exactly."""
    # "with db" commits the change when the block ends (or undoes it if something fails).
    # The ? placeholders keep user text as data, so it can never be run as SQL.
    with db:
        cursor = db.execute(
            "INSERT INTO messages (channel, user_id, text, attachment_id, reply_to, kind) VALUES (?, ?, ?, ?, ?, ?)",
            (channel, user_id, text, file["id"] if file else None, reply_to, kind),
        )
    message_id = cursor.lastrowid  # the id SQLite gave it
    sent_at = db.execute("SELECT sent_at FROM messages WHERE id = ?", (message_id,)).fetchone()[0]
    return message_id, iso_time(sent_at)


def file_info(attachment_id, filename, size, content_type):
    """What the page needs to know about an attachment."""
    return {"id": attachment_id, "filename": filename, "size": size,
            "image": content_type in IMAGE_TYPES, "video": content_type in VIDEO_TYPES}


REPLY_PREVIEW_LENGTH = 100


def reply_preview(original_id, user_id, name, text, attachment_id):
    """The small quote shown above a reply: who wrote the original, and the start of it."""
    if original_id is None:
        return None  # not a reply (or the original no longer exists)
    return {
        "id": original_id,
        "user_id": user_id,
        "name": name,
        # Cut to length, then drop a custom emoji token that got cut in half at the end ("<:1").
        "text": re.sub(r"<:\d*$", "", text[:REPLY_PREVIEW_LENGTH]),
        "file": attachment_id is not None,  # the page shows "Attachment" if there's no text
    }


def check_reply(reply_to, channel):
    """The id of the message being replied to, if it's valid: a number, of a message that exists
    *in this same channel*. (Otherwise anyone could quote a DM they can't see, just by guessing
    its id.) None if it isn't valid; the message is then sent as a normal one."""
    # bool is a kind of int in Python (True == 1), so it has to be ruled out separately.
    if not isinstance(reply_to, int) or isinstance(reply_to, bool):
        return None
    row = db.execute("SELECT id FROM messages WHERE id = ? AND channel = ?", (reply_to, channel)).fetchone()
    return row[0] if row else None


def live_reply_preview(original_id):
    """The quote for a reply that's being sent right now (the history gets it from its JOIN instead)."""
    if original_id is None:
        return None
    row = db.execute(
        """
        SELECT messages.id, messages.user_id, COALESCE(users.username, messages.legacy_name),
               messages.text, messages.attachment_id
        FROM messages LEFT JOIN users ON users.id = messages.user_id
        WHERE messages.id = ?
        """,
        (original_id,),
    ).fetchone()
    return reply_preview(*row) if row else None  # *row: the row's five values as five arguments


def reactions_for(message_ids):
    """The reactions on several messages: {message_id: [{"emoji": "👍", "user_ids": [1, 2]}, ...]}.
    One query for all of them, not one per message: running a query for each of 50 messages
    is so common (and slow) that it has a name, the "N+1 problem"."""
    result = {message_id: [] for message_id in message_ids}
    if not message_ids:
        return result
    placeholders = ",".join("?" * len(message_ids))  # "?,?,?" : one ? per id
    rows = db.execute(
        f"SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN ({placeholders}) "
        "ORDER BY created_at, rowid",  # oldest first, so the first emoji used comes first
        list(message_ids),
    )
    by_message = {}  # {message_id: {emoji: [user ids]}}; dicts keep the order things were added in
    for message_id, emoji, user_id in rows:
        by_message.setdefault(message_id, {}).setdefault(emoji, []).append(user_id)
    for message_id, emojis in by_message.items():
        result[message_id] = [{"emoji": emoji, "user_ids": user_ids} for emoji, user_ids in emojis.items()]
    return result


# Everything the page needs about messages, for the history and for the pinned list (each adds its
# own WHERE and ORDER BY). LEFT JOINs: each message, plus its sender's *current* username, plus its
# attachment (NULLs where there's none). COALESCE(a, b) means "a, or b if a is NULL": for messages
# from before accounts existed, there's no user, so we show the name that was typed back then.
#
# For replies, the messages table is joined with *itself*: "original" is a second copy of it
# (an alias), holding the message being replied to, and "original_sender" its sender.
# And its link preview, if it got one (link_previews).
MESSAGES_QUERY = """
    SELECT messages.id, messages.sent_at, messages.edited_at, messages.reply_to, messages.kind,
           messages.pinned_at, messages.user_id, COALESCE(users.username, messages.legacy_name), messages.text,
           attachments.id, attachments.filename, attachments.size, attachments.content_type,
           link_previews.url, link_previews.site, link_previews.title, link_previews.description,
           link_previews.image,
           original.id, original.user_id, COALESCE(original_sender.username, original.legacy_name),
           original.text, original.attachment_id
    FROM messages
    LEFT JOIN users ON users.id = messages.user_id
    LEFT JOIN attachments ON attachments.id = messages.attachment_id
    LEFT JOIN messages AS original ON original.id = messages.reply_to
    LEFT JOIN users AS original_sender ON original_sender.id = original.user_id
    LEFT JOIN link_previews ON link_previews.message_id = messages.id
"""


def message_dicts(rows):
    """Rows from MESSAGES_QUERY in the same shape as live messages."""
    reactions = reactions_for([row[0] for row in rows])  # all the reactions, in one query
    return [
        {
            "id": message_id,
            "sent_at": iso_time(sent_at),
            "edited_at": iso_time(edited_at) if edited_at else None,
            "user_id": user_id,  # None for messages from before accounts existed
            "name": name,
            "text": text,
            "file": file_info(file_id, filename, size, content_type) if file_id else None,
            # A reply whose original has been deleted: reply_to is still set, but the JOIN found nothing.
            "reply": reply_preview(*rest[5:]) or ({"id": reply_to, "deleted": True} if reply_to else None),
            "reactions": reactions[message_id],
            "kind": kind,  # None, "call" for a call note, "pin" for a pin note
            "pinned": pinned_at is not None,
            "preview": preview_info(*rest[:5]) if rest[0] else None,  # rest: the preview, then the original
        }
        for (message_id, sent_at, edited_at, reply_to, kind, pinned_at, user_id, name, text,
             file_id, filename, size, content_type, *rest) in rows
    ]


def recent_messages(channel, before=None):
    """The channel's newest messages, oldest first, in the same shape as live messages.
    With `before` (a message id): the newest ones *older* than that message instead, for
    scrolling up. Ids only ever grow, so "older" simply means "a smaller id"."""
    rows = db.execute(
        MESSAGES_QUERY + " WHERE messages.channel = ? AND messages.id < ? ORDER BY messages.id DESC LIMIT ?",
        # No `before`: SQLite's biggest whole number, so the condition lets every message through.
        (channel, before if before is not None else 2**63 - 1, HISTORY_LIMIT),
    ).fetchall()
    rows.reverse()  # we fetched newest-first; chat reads oldest-first
    return message_dicts(rows)


MAX_PINS = 100  # pinned messages per channel, DM or group (Discord allows 50)


def pinned_messages(channel):
    """A channel's pinned messages, the most recently pinned first."""
    rows = db.execute(
        MESSAGES_QUERY + " WHERE messages.channel = ? AND messages.pinned_at IS NOT NULL"
        " ORDER BY messages.pinned_at DESC, messages.id DESC",
        (channel,),
    ).fetchall()
    return message_dicts(rows)


MAX_SEARCH_RESULTS = 50
MAX_SEARCH_WORDS = 10


def visible_chats(user_id):
    """Every chat this person may read (see can_join): the channels, their DMs with friends, their groups."""
    chats = [item["key"] for item in channel_list(user_id) if not item["heading"]]
    chats += [f"dm:{min(user_id, friend)}:{max(user_id, friend)}" for friend in friends_message(user_id)["friends"]]
    chats += [key for (key,) in db.execute("SELECT group_key FROM group_members WHERE user_id = ?", (user_id,))]
    return chats


def search_messages(user_id, text, chat=None, author=None):
    """The newest messages (at most MAX_SEARCH_RESULTS) this person can see with every word of `text`,
    each also as the start of a longer word ("hunt" finds "hunter2"); in one chat or in all of them,
    from anyone or from one person. Like the history, plus each message's "channel". Text or author
    may be left out, not both."""
    words = re.findall(r"\w+", text)[:MAX_SEARCH_WORDS]  # letters and digits only: no FTS5 syntax gets in
    chats = visible_chats(user_id)  # never anything else: someone else's DM stays out of reach
    if chat is not None:
        chats = [chat] if chat in chats else []
    if not chats or (not words and author is None):
        return []
    conditions = [f"messages.channel IN ({','.join('?' * len(chats))})", "messages.kind IS NULL",  # (no notes)
                  # nor anything from someone we blocked (the page hides those too). "IS NULL OR": in SQL,
                  # NULL NOT IN (...) isn't true, so messages from before accounts existed would vanish.
                  "(messages.user_id IS NULL OR messages.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?))"]
    params = [*chats, user_id]
    if words:
        # '"pizza"* "fred"*': every word must be there ("..." keeps it a plain word, * = or longer).
        conditions.append("messages.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)")
        params.append(" ".join(f'"{word}"*' for word in words))
    if author is not None:
        conditions.append("messages.user_id = ?")
        params.append(author)
    rows = db.execute(
        MESSAGES_QUERY + " WHERE " + " AND ".join(conditions) + " ORDER BY messages.id DESC LIMIT ?",
        (*params, MAX_SEARCH_RESULTS),
    ).fetchall()
    found = message_dicts(rows)
    if found:
        # Which chat each one is in (the page shows it, and Jump goes there).
        ids = [message["id"] for message in found]
        chat_of = dict(db.execute(f"SELECT id, channel FROM messages WHERE id IN ({','.join('?' * len(ids))})", ids))
        for message in found:
            message["channel"] = chat_of[message["id"]]
    return found


def parse_json(raw):
    """Turn raw text from a client into a dict, or None if it isn't a JSON object.

    Never trust what clients send: anyone can connect to /ws with their own script.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return data


def clean_text(data):
    """Get the message text out of a client's "message" (maybe empty), or None if it's invalid.

    The sender is NOT taken from here; it comes from their login session.
    """
    text = data.get("text")
    if not isinstance(text, str):
        return None
    text = text.strip()
    if len(text) > MAX_TEXT_LENGTH:
        return None
    return text


# ---------- Accounts and sessions ----------

class Credentials(BaseModel):
    """What the login page sends: FastAPI checks the JSON has these fields, as strings."""
    username: str
    password: str
    email: str = ""   # only used when creating an account
    invite: str = ""  # only used when creating an account


def clean_email(raw):
    """A tidied-up email address (trimmed, lowercase), or None if it doesn't look like one."""
    email = raw.strip().lower()
    if len(email) > MAX_EMAIL_LENGTH or not EMAIL_PATTERN.fullmatch(email):
        return None
    return email


def check_password_length(password):
    if not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH:
        raise HTTPException(400, f"Passwords need at least {MIN_PASSWORD_LENGTH} characters.")


# Recent failed attempts, to stop password (and invite code) guessing:
# {"login:axel": [time, time, ...], "invite:203.0.113.5": [...]}. Kept in memory only.
failures = {}


def too_many_failures(key):
    """Has this key failed MAX_FAILURES times within the last FAILURE_WINDOW seconds?"""
    now = time.monotonic()  # a clock in seconds that only ever goes forward
    recent = [t for t in failures.get(key, []) if now - t < FAILURE_WINDOW]  # forget old ones
    if recent:
        failures[key] = recent
    else:
        failures.pop(key, None)  # nothing recent: remove the key, so the dict doesn't keep growing
    return len(recent) >= MAX_FAILURES


def record_failure(key):
    failures.setdefault(key, []).append(time.monotonic())


def client_ip(request):
    """The visitor's IP address. Behind the Cloudflare Tunnel every request comes from
    cloudflared on this PC, so Cloudflare puts the real address in a header for us.
    (We only trust that header because the server only listens on this PC; see serve.ps1.)"""
    return request.headers.get("cf-connecting-ip") or request.client.host


def start_session(response, user_id):
    """Log a user in: store a new random token, and give it to their browser as a cookie."""
    token = secrets.token_urlsafe(32)  # 32 random bytes: impossible to guess
    with db:
        db.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 24 * 60 * 60,  # in seconds
        httponly=True,   # JavaScript can't read it, so a script can't steal it
        samesite="lax",  # other websites can't make the browser send it to us
        secure=SECURE_COOKIES,  # on the real site: only ever sent over HTTPS
    )


def session_user(token):
    """(user id, email verified?) for a session token, or None if it's missing, unknown or expired."""
    if not token:
        return None
    # (A banned account is "logged out" too: see "Bans and admins".)
    return db.execute(
        f"""
        SELECT users.id, users.email_verified FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token = ? AND sessions.created_at > datetime('now', ?) AND NOT {BANNED_NOW}
        """,
        (token, f"-{SESSION_DAYS} days"),
    ).fetchone()


def user_id_from_token(token):
    """The id of the user a session token belongs to, or None if it's missing, unknown or expired,
    or the account's email isn't verified yet: until then, the account can only use the
    verification page ("Email verification"), so everything else treats it as logged out."""
    row = session_user(token)
    return row[0] if row and row[1] == 1 else None


def current_user(request):
    """The logged-in (and verified) user's id for an HTTP request, or None."""
    return user_id_from_token(request.cookies.get(SESSION_COOKIE))


def unverified_user(request):
    """The id of a logged-in account still waiting for its email to be verified, or None."""
    row = session_user(request.cookies.get(SESSION_COOKIE))
    return row[0] if row and row[1] == 0 else None


@app.post("/register")
async def register(credentials: Credentials, request: Request, response: Response, background_tasks: BackgroundTasks):
    # An invite link is needed (see "Invites"), except with REQUIRE_INVITE=0 or for the very first
    # account on a new server, when there's nobody yet to make one.
    code = invite_code(credentials.invite, request)
    needs_invite = REQUIRE_INVITE and has_people()
    if needs_invite:
        # Limit wrong tries per visitor (IP address). The codes are far too long to guess anyway.
        key = "invite:" + client_ip(request)
        if too_many_failures(key):
            raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")
        if not code:
            raise HTTPException(403, "You need an invite link from someone in the chat to make an account.")
        if open_invite(code) is None:
            record_failure(key)
            raise HTTPException(403, INVITE_GONE)

    username = credentials.username.strip()
    password = credentials.password
    if not USERNAME_PATTERN.fullmatch(username):
        raise HTTPException(400, "Usernames are 1–32 letters, digits, _ or -.")
    if username.lower() in RESERVED_NAMES:
        raise HTTPException(400, "That name is reserved.")
    check_password_length(password)
    email = clean_email(credentials.email)
    if email is None:
        raise HTTPException(400, "Please enter a valid email address (it's used to reset your password).")

    password_hash = hasher.hash(password)  # salted and hashed; the password itself is never stored
    try:
        # One transaction: the account and using up the invite happen together, or neither does
        # (an error inside "with db" undoes everything in it). So two people can't both use one
        # link at the same moment: the second one's UPDATE finds it used and changes no row.
        with db:
            # The first person on a new server (bots don't count) becomes its admin and owner. Decided
            # inside the INSERT itself, so two people signing up at the same moment can't both be first.
            first = "NOT EXISTS (SELECT 1 FROM users WHERE is_bot = 0)"
            cursor = db.execute(
                "INSERT INTO users (username, password_hash, email, email_verified, is_admin, is_owner)"
                f" VALUES (?, ?, ?, 0, {first}, {first})",
                (username, password_hash, email),
            )
            user_id = cursor.lastrowid  # the id SQLite gave the new user
            if needs_invite:
                used = db.execute(
                    "UPDATE invites SET used_by = ?, used_at = CURRENT_TIMESTAMP"
                    " WHERE code = ? AND used_by IS NULL AND created_at > datetime('now', ?)",
                    (user_id, code, f"-{INVITE_DAYS} days"),
                )
                if used.rowcount != 1:
                    raise HTTPException(403, INVITE_GONE)
    except sqlite3.IntegrityError as error:  # a UNIQUE rule was broken: username or email
        if "email" in str(error):
            raise HTTPException(400, "That email is already used by another account.")
        raise HTTPException(400, "That username is taken.")

    # Logged in, but only to the "check your inbox" page until the link in this email is clicked.
    start_session(response, user_id)
    response.delete_cookie(INVITE_COOKIE, httponly=True, samesite="lax", secure=SECURE_COOKIES)  # used up
    send_verification(background_tasks, user_id, username, email)
    return {"ok": True}


@app.post("/login")
async def login(credentials: Credentials, response: Response):
    # Same message whether the username or the password is wrong,
    # so nobody can use this to find out which usernames exist.
    wrong = HTTPException(401, "Wrong username or password.")

    # Limit guesses per username. Checked before the password, so while it's locked
    # even the right password is refused; otherwise guessing could just carry on.
    key = "login:" + credentials.username.strip().lower()
    if too_many_failures(key):
        raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")

    row = db.execute(
        "SELECT id, password_hash FROM users WHERE username = ?",
        (credentials.username.strip(),),
    ).fetchone()
    if row is None:
        record_failure(key)
        raise wrong
    user_id, password_hash = row

    try:
        hasher.verify(password_hash, credentials.password)
    except VerifyMismatchError:
        record_failure(key)
        raise wrong

    failures.pop(key, None)  # logged in: start counting from zero again
    banned = ban_message(user_id)
    if banned:
        raise HTTPException(403, banned)
    start_session(response, user_id)
    return {"ok": True}


def allow_landing_page(request, response):
    """Let the landing page (on LANDING_HOST, a different address than the chat) read this answer.
    Browsers only let a page read answers from its own address, unless the server says otherwise
    ("CORS"): we say so for exactly that one address, never for anyone. The login cookie still
    reaches us because the two addresses are the same *site* (example.com and chat.example.com),
    which SameSite=Lax allows."""
    origin = request.headers.get("origin")
    if LANDING_HOST and origin == f"https://{LANDING_HOST}":
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"  # with the cookie
    response.headers["Vary"] = "Origin"  # the answer depends on who asks: caches mustn't mix them up


@app.get("/whoami")
async def whoami(request: Request, response: Response):
    """For the landing page: who's logged in in this browser, if anyone. Only the name and picture."""
    allow_landing_page(request, response)
    response.headers["Cache-Control"] = "no-store"  # different for everyone: never keep a copy
    user_id = current_user(request)
    if user_id is None:
        return {"username": None}
    username, avatar = db.execute("SELECT username, avatar_id FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"username": username, "avatar": f"{PUBLIC_URL}/avatars/{avatar}" if avatar else None}


@app.post("/logout")
async def logout(request: Request, response: Response):
    allow_landing_page(request, response)  # (the landing page's "Log out" too)
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        # Delete it on the server too, so the token stops working even if someone copied it.
        with db:
            db.execute("DELETE FROM sessions WHERE token = ?", (token,))
    response.delete_cookie(SESSION_COOKIE, httponly=True, samesite="lax", secure=SECURE_COOKIES)
    return {"ok": True}


# ---------- Email and password resets ----------

def send_email(to, subject, body):
    """Send a plain-text email. This is slow (it talks to a mail server over the internet),
    so it's only ever run in the background, after the response has gone out."""
    if not SMTP_HOST:
        # Development: no mail server, so just show the email in the server window.
        print(f"\n----- EMAIL (not sent: no SMTP_HOST) -----\nTo: {to}\nSubject: {subject}\n\n{body}\n", flush=True)
        return

    message = EmailMessage()
    message["From"] = MAIL_FROM
    message["To"] = to
    message["Subject"] = subject
    # Every normal email has a date and a unique id; spam filters distrust emails without them.
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid(domain=parseaddr(MAIL_FROM)[1].rpartition("@")[2])  # the sender's domain
    message.set_content(body)
    try:
        # SMTP: the protocol mail servers use. starttls() switches the connection to encrypted
        # before we log in, so the password and the email never travel in plain text.
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as smtp:
            smtp.starttls(context=ssl.create_default_context())
            smtp.login(SMTP_USER, SMTP_PASSWORD)
            smtp.send_message(message)
    except Exception as error:
        print(f"Couldn't send email to {to}: {error}", flush=True)


def send_security_notice(background_tasks, email, username, subject, what, if_not_you):
    """Tell someone about a change to their account, in case it wasn't them.
    `what` says what happened; `if_not_you` what to do then. Sent in the background (see send_email)."""
    if not email:
        return  # (an account without an email: nobody to tell)
    when = time.strftime("%d %B %Y, %H:%M")  # e.g. "11 October 2026, 14:30" (the server's clock)
    body = (
        f"Hi {username},\n\n"
        f"{what} ({when}).\n\n"
        "If that was you, all is well and you don't need to do anything.\n\n"
        f"If it wasn't you, someone else has been in your account. {if_not_you}\n"
    )
    background_tasks.add_task(send_email, email, subject, body)


def hash_token(token):
    """Reset tokens are stored hashed: if the database leaked, the hashes couldn't be used as links.
    A fast hash (SHA-256) is fine here, unlike for passwords: the token is long and random,
    so there's nothing to guess."""
    return hashlib.sha256(token.encode()).hexdigest()


class ForgotRequest(BaseModel):
    email: str


@app.post("/forgot")
async def forgot(data: ForgotRequest, request: Request, background_tasks: BackgroundTasks):
    """Email a reset link. The answer is always the same, whether or not the email belongs to
    an account, so nobody can use this to find out whose email is registered."""
    email = clean_email(data.email)
    if email is None:
        raise HTTPException(400, "That doesn't look like an email address.")

    # At most a few requests per visitor and per email address, so nobody can flood an inbox.
    # (Every request counts here, not just failed ones.)
    ip_key = "forgot-ip:" + client_ip(request)
    email_key = "forgot-email:" + email
    if too_many_failures(ip_key) or too_many_failures(email_key):
        raise HTTPException(429, "Too many requests. Try again in 15 minutes.")
    record_failure(ip_key)
    record_failure(email_key)

    row = db.execute("SELECT id, username FROM users WHERE email = ?", (email,)).fetchone()
    if row is not None:
        user_id, username = row
        token = secrets.token_urlsafe(32)
        with db:
            db.execute(
                "INSERT INTO password_resets (token_hash, user_id) VALUES (?, ?)", (hash_token(token), user_id)
            )
        link = f"{PUBLIC_URL}/reset?token={token}"
        body = (
            f"Hi {username},\n\n"
            "Someone (hopefully you) asked to reset your password for ChatApp.\n"
            f"Open this link to choose a new one. It works once, for the next {RESET_MINUTES} minutes:\n\n"
            f"{link}\n\n"
            "If you didn't ask for this, just ignore this email. Your password stays the same.\n"
        )
        # Sent after we've answered: if we waited for it, a real address would answer slower
        # than a made-up one, and the timing would give away which emails exist.
        background_tasks.add_task(send_email, email, "Reset your password for ChatApp", body)

    return {"ok": True}


class ResetRequest(BaseModel):
    token: str
    password: str


@app.post("/reset")
async def reset(data: ResetRequest, background_tasks: BackgroundTasks):
    """Set a new password using the token from an emailed link."""
    check_password_length(data.password)
    row = db.execute(
        """
        SELECT password_resets.user_id, users.username, users.email
        FROM password_resets JOIN users ON users.id = password_resets.user_id
        WHERE password_resets.token_hash = ? AND password_resets.created_at > datetime('now', ?)
        """,
        (hash_token(data.token), f"-{RESET_MINUTES} minutes"),
    ).fetchone()
    if row is None:
        raise HTTPException(400, "This reset link is invalid or has expired. Ask for a new one.")
    user_id, username, email = row

    with db:
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hasher.hash(data.password), user_id))
        db.execute("DELETE FROM password_resets WHERE user_id = ?", (user_id,))  # every link, used up
        db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))  # log out everywhere
    failures.pop("login:" + username.lower(), None)  # a fresh start for logging in
    await disconnect_user(user_id)  # close their open chat tabs too
    send_password_notice(background_tasks, email, username)
    return {"ok": True}


# ---------- Email verification ----------
#
# A new account gets an email with a link, and until it's clicked the account can only use the
# "check your inbox" page (static/verify.html, at /verify-email): user_id_from_token treats it as
# logged out everywhere else, and it isn't in anyone's lists yet. A new address from Settings
# waits in pending_email the same way, while the old one stays in use (a typo can't lock anyone
# out of password resets). Like reset links, only a hash of each link's token is stored.

def send_verification(background_tasks, user_id, username, email):
    """Email a link that verifies `email` for this account (in the background, see send_email).
    Each one counts towards verification_limited."""
    token = secrets.token_urlsafe(32)
    with db:
        db.execute(
            "INSERT INTO email_verifications (token_hash, user_id, email) VALUES (?, ?, ?)",
            (hash_token(token), user_id, email),
        )
    record_failure(f"verify:{user_id}")
    link = f"{PUBLIC_URL}/verify?token={token}"
    body = (
        f"Hi {username},\n\n"
        "Open this link to confirm that this is your email address for ChatApp.\n"
        f"It works for the next {VERIFY_HOURS} hours:\n\n"
        f"{link}\n\n"
        "If you didn't make a ChatApp account or change your email there, just ignore this email.\n"
    )
    background_tasks.add_task(send_email, email, "Confirm your email for ChatApp", body)


def verification_limited(user_id):
    """Has this account had MAX_FAILURES (5) verification emails in the last 15 minutes? Then no
    more for now, so "Send again" can't be used to flood someone's inbox through our mail service."""
    return too_many_failures(f"verify:{user_id}")


TOO_MANY_EMAILS = "We've sent a few already. Check your spam folder, or try again in 15 minutes."


@app.get("/verify")
async def verify(token: str, background_tasks: BackgroundTasks):
    """The link in the email. It verifies the address it was sent to: a new account's own, or a new
    one from Settings (then that becomes the account's email). Then on to the page, which says how
    it went (?result=...)."""
    row = db.execute(
        """
        SELECT email_verifications.user_id, email_verifications.email,
               users.username, users.email, users.email_verified, users.pending_email
        FROM email_verifications JOIN users ON users.id = email_verifications.user_id
        WHERE email_verifications.token_hash = ? AND email_verifications.created_at > datetime('now', ?)
        """,
        (hash_token(token), f"-{VERIFY_HOURS} hours"),
    ).fetchone()
    if row is None:
        return RedirectResponse("/verify-email?result=expired")
    user_id, address, username, email, verified, pending = row

    if not verified and address == email:
        # A new account: in. It joins everyone's lists, and the bots become its friends.
        with db:
            db.execute("UPDATE users SET email_verified = 1 WHERE id = ?", (user_id,))
            db.execute("DELETE FROM email_verifications WHERE user_id = ?", (user_id,))
        befriend_bots()
        await announce_users()
        return RedirectResponse("/verify-email?result=verified")

    if verified and address == pending:
        # A new address from Settings. (Someone else may have taken it in the meantime: UNIQUE.)
        try:
            with db:
                db.execute("UPDATE users SET email = ?, pending_email = NULL WHERE id = ?", (address, user_id))
                db.execute("DELETE FROM email_verifications WHERE user_id = ?", (user_id,))
        except sqlite3.IntegrityError:
            return RedirectResponse("/verify-email?result=taken")
        # To the *old* address: if someone else did this, the new one is theirs, and reset links
        # go there now. So the real owner needs the admin, who can put their email back.
        send_security_notice(
            background_tasks, email, username,
            "Your ChatApp email address was changed",
            f"The email address for your ChatApp account was just changed to {address}",
            "Password reset links now go to that new address, so tell the admin right away:"
            " they can put your own email back.",
        )
        return RedirectResponse("/verify-email?result=changed")

    # A link for an address the account no longer uses (changed again since).
    return RedirectResponse("/verify-email?result=expired")


@app.get("/verify-email")
async def verify_page():
    return FileResponse("static/verify.html", headers={"Cache-Control": "no-cache"})


@app.get("/verify/status")
async def verify_status(request: Request):
    """For the verify page: who's logged in in this browser, and whether their email is verified."""
    row = session_user(request.cookies.get(SESSION_COOKIE))
    if row is None:
        return {"logged_in": False}
    username, email, pending = db.execute(
        "SELECT username, email, pending_email FROM users WHERE id = ?", (row[0],)
    ).fetchone()
    return {"logged_in": True, "verified": row[1] == 1, "username": username, "email": email, "pending_email": pending}


@app.post("/verify/resend")
async def resend_verification(request: Request, background_tasks: BackgroundTasks):
    """"Send again": a new link, to a new account's address or to the one waiting in Settings."""
    row = session_user(request.cookies.get(SESSION_COOKIE))
    if row is None:
        raise HTTPException(401, "You're not logged in.")
    user_id, verified = row
    username, email, pending = db.execute(
        "SELECT username, email, pending_email FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    address = pending if verified else email
    if not address:
        raise HTTPException(400, "Your email is already verified.")
    if verification_limited(user_id):
        raise HTTPException(429, TOO_MANY_EMAILS)
    send_verification(background_tasks, user_id, username, address)
    return {"ok": True, "email": address}


class NewEmail(BaseModel):
    email: str


@app.post("/verify/change")
async def change_unverified_email(data: NewEmail, request: Request, background_tasks: BackgroundTasks):
    """"Wrong address?" on the verify page: a new account fixes its email, and gets a new link."""
    user_id = unverified_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in, or your email is already verified.")
    email = clean_email(data.email)
    if email is None:
        raise HTTPException(400, "That doesn't look like an email address.")
    if verification_limited(user_id):
        raise HTTPException(429, TOO_MANY_EMAILS)
    try:
        with db:
            db.execute("UPDATE users SET email = ? WHERE id = ?", (email, user_id))
            db.execute("DELETE FROM email_verifications WHERE user_id = ?", (user_id,))  # old links stop working
    except sqlite3.IntegrityError:
        raise HTTPException(400, "That email is already used by another account.")
    username = db.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()[0]
    send_verification(background_tasks, user_id, username, email)
    return {"ok": True, "email": email}


# ---------- Invites ----------
#
# A new account needs an invite link from someone in the chat: /invite/<code>, which opens the
# create-account page with the code filled in. Each link works once, for INVITE_DAYS; anyone can
# have MAX_OPEN_INVITES unused ones (the People page: Invite someone). A used one stays in the
# table, so who invited whom is remembered (invites.created_by and used_by).

INVITE_GONE = ("This invite link doesn't work any more: it has been used, or it's more than "
               f"{INVITE_DAYS} days old. Ask for a new one.")


def has_people():
    """Does anyone have an account yet (bots don't count)? The very first account needs no invite."""
    return db.execute("SELECT 1 FROM users WHERE is_bot = 0 LIMIT 1").fetchone() is not None


def open_invite(code):
    """(code, the inviter's name) for an invite that can still be used, or None."""
    if not code:
        return None
    return db.execute(
        """
        SELECT invites.code, users.username FROM invites JOIN users ON users.id = invites.created_by
        WHERE invites.code = ? AND invites.used_by IS NULL AND invites.created_at > datetime('now', ?)
        """,
        (code, f"-{INVITE_DAYS} days"),
    ).fetchone()


def my_invites(user_id):
    """This person's unused invite links that still work, newest first."""
    rows = db.execute(
        """
        SELECT code, datetime(created_at, ?) FROM invites
        WHERE created_by = ? AND used_by IS NULL AND created_at > datetime('now', ?)
        ORDER BY created_at DESC, rowid DESC
        """,
        (f"+{INVITE_DAYS} days", user_id, f"-{INVITE_DAYS} days"),
    ).fetchall()
    return [{"code": code, "link": f"{PUBLIC_URL}/invite/{code}", "expires": iso_time(expires)} for code, expires in rows]


@app.get("/invites")
async def list_invites(request: Request):
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    return {"invites": my_invites(user_id), "days": INVITE_DAYS}


@app.post("/invites")
async def create_invite(request: Request):
    """A new link. Answers with all of this person's open ones (the new one first)."""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    if len(my_invites(user_id)) >= MAX_OPEN_INVITES:
        raise HTTPException(400, f"You have {MAX_OPEN_INVITES} unused links already: cancel one first.")
    code = secrets.token_urlsafe(12)  # 12 random bytes as 16 characters: impossible to guess
    with db:
        db.execute("INSERT INTO invites (code, created_by) VALUES (?, ?)", (code, user_id))
    return {"invites": my_invites(user_id), "days": INVITE_DAYS}


@app.post("/invites/{code}/cancel")
async def cancel_invite(code: str, request: Request):
    """Cancel one of our own unused links (someone else's, or a used one, is left alone)."""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    with db:
        db.execute("DELETE FROM invites WHERE code = ? AND created_by = ? AND used_by IS NULL", (code, user_id))
    return {"invites": my_invites(user_id), "days": INVITE_DAYS}


def all_invites():
    """For Settings → Admin → Invites: everyone's links that still work (with who made them), and
    who joined with whose link (newest first). Expired unused links are left out."""
    open_links = db.execute(
        """
        SELECT invites.code, users.username, datetime(invites.created_at, ?) FROM invites
        JOIN users ON users.id = invites.created_by
        WHERE invites.used_by IS NULL AND invites.created_at > datetime('now', ?)
        ORDER BY invites.created_at DESC, invites.rowid DESC
        """,
        (f"+{INVITE_DAYS} days", f"-{INVITE_DAYS} days"),
    ).fetchall()
    # LEFT JOIN: the person who joined (or who invited them) may have had their account deleted
    # since; the row still shows, with a name of None.
    joined = db.execute(
        """
        SELECT invites.used_by, joiner.username, inviter.username, invites.used_at FROM invites
        LEFT JOIN users AS joiner ON joiner.id = invites.used_by
        LEFT JOIN users AS inviter ON inviter.id = invites.created_by
        WHERE invites.used_by IS NOT NULL
        ORDER BY invites.used_at DESC
        """
    ).fetchall()
    return {
        "open": [
            {"code": code, "link": f"{PUBLIC_URL}/invite/{code}", "by": by, "expires": iso_time(expires)}
            for code, by, expires in open_links
        ],
        "joined": [
            {"user_id": user_id, "name": name, "invited_by": inviter, "joined": iso_time(when)}
            for user_id, name, inviter, when in joined
        ],
        "days": INVITE_DAYS,
    }


@app.get("/admin/invites")
async def admin_invites(request: Request):
    logged_in_admin(request)  # (admins only: the server's check is what counts, not the hidden tab)
    return all_invites()


@app.post("/admin/invites/{code}/cancel")
async def admin_cancel_invite(code: str, request: Request):
    """Cancel anyone's unused link (a link posted somewhere it shouldn't be, say)."""
    logged_in_admin(request)
    with db:
        db.execute("DELETE FROM invites WHERE code = ? AND used_by IS NULL", (code,))
    return all_invites()


# ---------- Bans and admins ----------
#
# The owner is the first account (is_owner): they can ban anyone but themselves, and make people
# admins or take it away (Settings → Admin → Admins). Other admins can ban everyone but admins, the
# owner and bots. A ban lasts a day, a week, a month or for good (banned_until NULL); it ends by
# itself, because every check compares banned_until with the time now (BANNED_NOW). While banned,
# session_user treats them as logged out, /login says why, and they're in nobody's lists. Their
# messages stay. Unbanning (or the end of the ban) changes nothing else: they just log in again.

BAN_DAYS = (1, 7, 30)  # the lengths on offer; None = for good
MAX_BAN_REASON = 200


def is_owner(user_id):
    row = db.execute("SELECT is_owner FROM users WHERE id = ?", (user_id,)).fetchone()
    return bool(row and row[0])


def ban_message(user_id):
    """What /login says to a banned account ("This account is banned until 21 October 2026. Reason:
    spam"), or None if it isn't banned now."""
    row = db.execute(f"SELECT banned_until, ban_reason FROM users WHERE id = ? AND {BANNED_NOW}", (user_id,)).fetchone()
    if row is None:
        return None
    until, reason = row
    if until is None:
        text = "This account is banned."
    else:
        day = time.strftime("%d %B %Y", time.strptime(until, "%Y-%m-%d %H:%M:%S")).lstrip("0")  # "21 October 2026"
        text = f"This account is banned until {day}."
    return text + (f" Reason: {reason}" if reason else "")


def ban_refusal(admin_id, target_id):
    """Why this admin may not ban that account, or None if they may."""
    row = db.execute("SELECT is_admin, is_owner, is_bot FROM users WHERE id = ?", (target_id,)).fetchone()
    if row is None:
        return "There's no such account."
    admin, owner, bot = row
    if target_id == admin_id:
        return "You can't ban yourself."
    if bot:
        return "Bots can't be banned."
    if owner:
        return "The owner can't be banned."
    if admin and not is_owner(admin_id):
        return "Only the owner can ban an admin."
    return None


def remove_from_voice(room, user_id):
    """Throw someone out of a LiveKit room. Closing their chat connection makes their page leave by
    itself, but a page that doesn't play along could stay connected to LiveKit (tickets are only
    checked when joining). LiveKit's own API can remove them: an HTTP request to its RoomService,
    with a short ticket of our own that says we may run that room ("roomAdmin"). Blocking: run it in
    a thread. LiveKit's address for the API is the same as for browsers, with http(s) for ws(s)."""
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        return
    base = LIVEKIT_URL.replace("wss://", "https://", 1).replace("ws://", "http://", 1).rstrip("/")
    now = int(time.time())
    token = make_jwt({"iss": LIVEKIT_API_KEY, "nbf": now, "exp": now + 60, "video": {"room": room, "roomAdmin": True}})
    request = urllib.request.Request(
        base + "/twirp/livekit.RoomService/RemoveParticipant",
        data=json.dumps({"room": room, "identity": str(user_id)}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
    )
    try:
        urllib.request.urlopen(request, timeout=5).close()
    except Exception as error:  # (not in the room any more, for one: LiveKit answers "not found")
        print(f"Couldn't remove user {user_id} from voice room {room}: {error}", flush=True)


def ban_list():
    """Everyone banned right now, the newest ban first, for Settings → Admin → Bans. Times as ISO."""
    rows = db.execute(
        f"""
        SELECT users.id, users.username, admin.username, users.banned_at, users.banned_until, users.ban_reason
        FROM users LEFT JOIN users AS admin ON admin.id = users.banned_by
        WHERE {BANNED_NOW} ORDER BY users.banned_at DESC
        """
    ).fetchall()
    return {
        "bans": [
            {
                "user_id": user_id, "name": name, "by": by, "at": iso_time(at),
                "until": iso_time(until) if until else None, "reason": reason,
            }
            for user_id, name, by, at, until, reason in rows
        ],
    }


class BanRequest(BaseModel):
    user_id: int
    days: int | None = None  # 1, 7 or 30; None = for good
    reason: str = ""


@app.post("/admin/ban")
async def ban(data: BanRequest, request: Request):
    admin_id = logged_in_admin(request)
    refusal = ban_refusal(admin_id, data.user_id)
    if refusal:
        raise HTTPException(403, refusal)
    if data.days is not None and data.days not in BAN_DAYS:
        raise HTTPException(400, "A ban lasts 1, 7 or 30 days, or for good.")
    reason = " ".join(data.reason.split())[:MAX_BAN_REASON] or None
    with db:
        db.execute(
            """
            UPDATE users SET banned_at = CURRENT_TIMESTAMP, banned_by = ?, ban_reason = ?, is_admin = 0,
                banned_until = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END
            WHERE id = ?
            """,
            (admin_id, reason, data.days, f"+{data.days} days", data.user_id),
        )
        # (is_admin = 0: an admin the owner bans isn't one any more when the ban ends.)
        db.execute("DELETE FROM sessions WHERE user_id = ?", (data.user_id,))  # logged out everywhere
        db.execute("DELETE FROM invites WHERE created_by = ? AND used_by IS NULL", (data.user_id,))
    # Out of any call (see remove_from_voice), then every open page closed: it goes to the login page.
    rooms = {client["voice"] for client in clients.values() if client["user_id"] == data.user_id and client["voice"]}
    for room in rooms:
        await asyncio.to_thread(remove_from_voice, room, data.user_id)
    await disconnect_user(data.user_id)
    await announce_users()  # out of everyone's lists
    return ban_list()


class UserChoice(BaseModel):
    user_id: int


@app.post("/admin/unban")
async def unban(data: UserChoice, request: Request):
    logged_in_admin(request)
    with db:
        db.execute(
            "UPDATE users SET banned_at = NULL, banned_until = NULL, banned_by = NULL, ban_reason = NULL WHERE id = ?",
            (data.user_id,),
        )
    await announce_users()  # back in the lists (they log in again by themselves)
    return ban_list()


@app.get("/admin/bans")
async def bans(request: Request):
    logged_in_admin(request)
    return ban_list()


class AdminChange(BaseModel):
    user_id: int
    admin: bool


@app.post("/admin/admins")
async def set_admin(data: AdminChange, request: Request):
    """The owner makes someone an admin, or takes it away (Settings → Admin → Admins)."""
    owner_id = logged_in_admin(request)
    if not is_owner(owner_id):
        raise HTTPException(403, "Only the owner can make or remove admins.")
    row = db.execute(f"SELECT is_bot, {BANNED_NOW} FROM users WHERE id = ?", (data.user_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "There's no such account.")
    if data.user_id == owner_id:
        raise HTTPException(400, "The owner is always an admin.")
    if row[0]:
        raise HTTPException(400, "Bots can't be admins.")
    if row[1] and data.admin:
        raise HTTPException(400, "Unban them first.")
    with db:
        db.execute("UPDATE users SET is_admin = ? WHERE id = ?", (int(data.admin), data.user_id))
    # Every page knows who's an admin (badges, menus, Settings); admins also see hidden roles and every channel.
    await announce_roles()
    return {"ok": True}


INVITE_COOKIE = "invite"


def invite_code(given, request):
    """The invite to use: one in the address or the form (old-style links), else the one the browser
    has kept since its invite link was opened (the "invite" cookie, see open_invite_link)."""
    return given.strip() or request.cookies.get(INVITE_COOKIE, "")


@app.get("/invite/{code}")
async def open_invite_link(code: str):
    """The link itself: the browser keeps the code as a cookie, and goes on to the landing page, so
    people can read what the chat is before making an account; its "Create your account" button and
    the login page find the invite again through the cookie. Opening the link doesn't use it up."""
    response = RedirectResponse(f"https://{LANDING_HOST}/" if LANDING_HOST else "/welcome")
    response.set_cookie(
        INVITE_COOKIE,
        code[:100],  # (a real code is far shorter; the server checks it when it's used anyway)
        max_age=INVITE_DAYS * 24 * 60 * 60,  # as long as an invite works at most
        httponly=True,   # only the server reads it: pages ask /invite-info
        samesite="lax",  # sent from the landing page (the same site), not from other websites
        secure=SECURE_COOKIES,
    )
    return response


@app.get("/invite-info")
async def invite_info(request: Request, response: Response, code: str = ""):
    """For the login and landing pages: is an invite needed, and does this browser's (or the given)
    invite work, and whose is it?"""
    allow_landing_page(request, response)
    response.headers["Cache-Control"] = "no-store"  # different for everyone: never keep a copy
    code = invite_code(code, request)
    invite = open_invite(code)
    return {
        "required": REQUIRE_INVITE and has_people(),
        "given": bool(code),  # (one that doesn't work any more says so, instead of "you need one")
        "valid": invite is not None,
        "inviter": invite[1] if invite else None,
    }


# ---------- Settings (logged in) ----------

def logged_in_user(request):
    """(id, username, password_hash, email) of whoever is logged in, or a 401 error."""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    return db.execute(
        "SELECT id, username, password_hash, email FROM users WHERE id = ?", (user_id,)
    ).fetchone()


def check_current_password(username, password_hash, password):
    """For changes that need your password. Wrong guesses count towards the login limit."""
    key = "login:" + username.lower()
    if too_many_failures(key):
        raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")
    try:
        hasher.verify(password_hash, password)
    except VerifyMismatchError:
        record_failure(key)
        raise HTTPException(403, "Wrong password.")


@app.get("/me")
async def me(request: Request):
    user_id, username, password_hash, email = logged_in_user(request)
    avatar, banner, status, bio, pending = db.execute(
        "SELECT avatar_id, banner_id, status, bio, pending_email FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    return {
        "username": username, "email": email, "pending_email": pending,  # (a new address waiting for its link)
        "avatar": avatar, "banner": banner, "status": status, "bio": bio,
    }


class EmailChange(BaseModel):
    email: str
    password: str


@app.post("/settings/email")
async def change_email(data: EmailChange, request: Request, background_tasks: BackgroundTasks):
    user_id, username, password_hash, old_email = logged_in_user(request)
    # Needs the password: otherwise someone at your unlocked laptop could set their own
    # email and then "reset" your password to take over the account.
    check_current_password(username, password_hash, data.password)
    email = clean_email(data.email)
    if email is None:
        raise HTTPException(400, "That doesn't look like an email address.")
    if email == old_email:  # (back to the one we have: nothing waits any more)
        cancel_pending_email(user_id)
        return {"ok": True, "email": old_email, "pending": None}
    if db.execute("SELECT 1 FROM users WHERE email = ? AND id != ?", (email, user_id)).fetchone():
        raise HTTPException(400, "That email is already used by another account.")
    if verification_limited(user_id):
        raise HTTPException(429, TOO_MANY_EMAILS)
    # The new address waits until its link is clicked (see "Email verification", /verify), which
    # also tells the old address. Until then the old one stays in use.
    with db:
        db.execute("UPDATE users SET pending_email = ? WHERE id = ?", (email, user_id))
        db.execute("DELETE FROM email_verifications WHERE user_id = ?", (user_id,))  # older links stop working
    send_verification(background_tasks, user_id, username, email)
    return {"ok": True, "email": old_email, "pending": email}


def cancel_pending_email(user_id):
    with db:
        db.execute("UPDATE users SET pending_email = NULL WHERE id = ?", (user_id,))
        db.execute("DELETE FROM email_verifications WHERE user_id = ?", (user_id,))


@app.post("/settings/email/cancel")
async def cancel_email_change(request: Request):
    """Settings: forget the new address that was waiting for its link."""
    user_id = logged_in_user(request)[0]
    cancel_pending_email(user_id)
    return {"ok": True}


class UsernameChange(BaseModel):
    username: str
    password: str


@app.post("/settings/username")
async def change_username(data: UsernameChange, request: Request):
    user_id, username, password_hash, email = logged_in_user(request)
    check_current_password(username, password_hash, data.password)
    new_username = data.username.strip()
    if not USERNAME_PATTERN.fullmatch(new_username):
        raise HTTPException(400, "Usernames are 1–32 letters, digits, _ or -.")
    if new_username.lower() in RESERVED_NAMES:
        raise HTTPException(400, "That name is reserved.")
    try:
        # Everything else refers to people by id, so this one row is all that changes.
        # (Changing only the case of your own name, axel -> Axel, is fine: the UNIQUE rule
        # only compares against *other* rows.)
        with db:
            db.execute("UPDATE users SET username = ? WHERE id = ?", (new_username, user_id))
    except sqlite3.IntegrityError:
        raise HTTPException(400, "That username is taken.")

    # Tell every open page: the DM list and online list get the new name, and pages reload
    # the messages they're showing, so the new name appears on old messages too.
    await announce_users()
    await send_to_everyone({"type": "renamed", "id": user_id, "username": new_username})
    return {"ok": True, "username": new_username}


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


def send_password_notice(background_tasks, email, username):
    """After a password change (in Settings, or with a reset link)."""
    send_security_notice(
        background_tasks, email, username,
        "Your ChatApp password was changed",
        "The password for your ChatApp account was just changed",
        f"Choose a new password right away at {PUBLIC_URL}/reset (the link is sent to this email address),"
        " and let the admin know.",
    )


@app.post("/settings/password")
async def change_password(data: PasswordChange, request: Request, background_tasks: BackgroundTasks):
    user_id, username, password_hash, email = logged_in_user(request)
    check_current_password(username, password_hash, data.current_password)
    check_password_length(data.new_password)
    with db:
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hasher.hash(data.new_password), user_id))
        # Log out every *other* session (other devices), but keep this one.
        db.execute(
            "DELETE FROM sessions WHERE user_id = ? AND token != ?",
            (user_id, request.cookies.get(SESSION_COOKIE)),
        )
    send_password_notice(background_tasks, email, username)
    return {"ok": True}


# ---------- Uploads ----------

async def receive_file(request, path, max_size):
    """Save the request's body (a raw file) to `path`, reading it piece by piece as it arrives,
    so we can stop as soon as it's too big. Returns the size in bytes."""
    size = 0
    try:
        with open(path, "wb") as out:  # "wb": write, in binary mode (bytes, not text)
            async for chunk in request.stream():
                size += len(chunk)
                if size > max_size:
                    raise HTTPException(413, f"Files can be at most {max_size // (1024 * 1024)} MB.")
                out.write(chunk)
        if size == 0:
            raise HTTPException(400, "That file is empty.")
    except BaseException:
        # Whatever went wrong (too big, empty, the upload was cancelled...), don't keep half a file.
        path.unlink(missing_ok=True)
        raise
    return size


@app.post("/upload")
async def upload(request: Request, filename: str):
    """Receive one file. The body is the raw file; its name comes in the URL: /upload?filename=cat.png"""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")

    filename = filename.strip()[:MAX_FILENAME_LENGTH] or "file"
    # The browser says what type the file is. We only believe it for our safe picture and video types
    # (a video also has to start like one, checked below); anything else is stored as a generic
    # download type.
    content_type = request.headers.get("content-type", "")
    if content_type not in SHOWN_TYPES:
        content_type = "application/octet-stream"

    # On disk the file gets a random name, never the one the user gave
    # (a name like "../../server.py" could otherwise overwrite our own files).
    file_id = secrets.token_urlsafe(16)
    size = await receive_file(request, UPLOAD_DIR / file_id, MAX_UPLOAD_SIZE)
    if content_type in VIDEO_TYPES and not is_video(UPLOAD_DIR / file_id, content_type):
        content_type = "application/octet-stream"
    # A video: re-packed before anyone sees it, so every player knows its length (see "Re-packing
    # videos"). In a background thread: the chat keeps running meanwhile.
    repacked = content_type in VIDEO_TYPES and FFMPEG is not None
    if repacked and await asyncio.to_thread(repack_video, UPLOAD_DIR / file_id, content_type):
        size = (UPLOAD_DIR / file_id).stat().st_size

    with db:
        db.execute(
            "INSERT INTO attachments (id, filename, content_type, size, uploader_id, repacked) VALUES (?, ?, ?, ?, ?, ?)",
            (file_id, filename, content_type, size, user_id, int(repacked)),
        )
    return {"id": file_id}


def claim_attachment(file_id, user_id, channel):
    """Tie an uploaded file to the channel it's being sent in. Only the uploader can do that,
    and only once. Returns the file's info for the message, or None if not allowed."""
    if not isinstance(file_id, str):
        return None
    with db:
        cursor = db.execute(
            "UPDATE attachments SET channel = ? WHERE id = ? AND uploader_id = ? AND channel IS NULL",
            (channel, file_id, user_id),
        )
    if cursor.rowcount != 1:  # rowcount: how many rows the UPDATE changed
        return None
    filename, size, content_type = db.execute(
        "SELECT filename, size, content_type FROM attachments WHERE id = ?", (file_id,)
    ).fetchone()
    return file_info(file_id, filename, size, content_type)


@app.get("/uploads/{file_id}")
async def get_upload(request: Request, file_id: str):
    """Send a file, but only to people who may see the message it's in."""
    user_id = current_user(request)
    row = db.execute(
        "SELECT filename, content_type, uploader_id, channel FROM attachments WHERE id = ?", (file_id,)
    ).fetchone()
    # "Not found" for everything that isn't allowed, so nobody learns which files exist.
    not_found = HTTPException(404, "Not found.")
    if user_id is None or row is None:
        raise not_found
    filename, content_type, uploader_id, channel = row
    if channel is None:
        allowed = uploader_id == user_id  # not sent yet: only the uploader
    else:
        allowed = can_join(channel, user_id)  # sent: whoever can see that channel or DM
    if not allowed:
        raise not_found

    return FileResponse(
        UPLOAD_DIR / file_id,  # safe: file_id was found in our own table above
        media_type=content_type,
        filename=filename,
        # Pictures and videos are shown in the page; everything else is downloaded, never opened on our
        # site. (A video player asks for a piece at a time, "bytes=1000000-": FileResponse answers
        # those "range requests" by itself, so skipping ahead works.)
        content_disposition_type="inline" if content_type in SHOWN_TYPES else "attachment",
        # Tell the browser to trust our type and never guess (so a fake "image" can't act as a page).
        headers={"X-Content-Type-Options": "nosniff"},
    )


# ---------- Profiles ----------

# Profile pictures and banners work the same way; `kind` ("avatar" or "banner") picks the
# column, folder and size limit from PICTURE_KINDS. The column names in the SQL below come from
# that table of ours, never from a request, so putting them into the SQL text is safe.

def crop_box_from(request):
    """The rectangle chosen in the editor, from the address (?left=..&top=..&width=..&height=..),
    as four whole numbers. None if they're not there."""
    try:
        box = [int(request.query_params[name]) for name in ("left", "top", "width", "height")]
    except (KeyError, ValueError):
        return None
    return box


def make_animated_webp(source, destination, box, size):
    """Crop an animated GIF to `box` (left, top, width, height) and shrink it to `size`,
    frame by frame, and save it as an animated WebP (usually several times smaller than GIF).
    Slow-ish, so it's run in a background thread. Raises ValueError if the GIF isn't acceptable."""
    left, top, width, height = box
    with Image.open(source) as gif:
        if gif.format != "GIF":
            raise ValueError("That isn't a GIF.")
        if getattr(gif, "n_frames", 1) > MAX_GIF_FRAMES:
            raise ValueError(f"GIFs can have at most {MAX_GIF_FRAMES} frames.")
        if left < 0 or top < 0 or width < 1 or height < 1 or left + width > gif.width or top + height > gif.height:
            raise ValueError("That crop doesn't fit the picture.")

        frames, durations = [], []
        for frame in ImageSequence.Iterator(gif):  # every frame, one after the other
            # How long this frame shows, in milliseconds. Browsers treat tiny values as 100.
            duration = frame.info.get("duration", 100)
            durations.append(duration if duration >= 20 else 100)
            # RGBA: full colour plus transparency, whatever the GIF's own colour format was.
            cropped = frame.convert("RGBA").crop((left, top, left + width, top + height))
            frames.append(cropped.resize(size, Image.Resampling.LANCZOS))  # LANCZOS: a sharp, smooth way to shrink

    frames[0].save(
        destination, format="WEBP", save_all=True, append_images=frames[1:],
        duration=durations, loop=0, quality=80,  # loop=0: repeat forever
    )


async def receive_picture(request, kind):
    """Receive a picture of this kind (the raw image is the body) and save it in its folder under
    a new random name, which is returned. The page has already cropped and shrunk it, except for
    animated GIFs: those come whole, with the chosen crop in the address."""
    settings = PICTURE_KINDS[kind]
    content_type = request.headers.get("content-type", "")
    if content_type not in PICTURE_EXTENSIONS:
        raise HTTPException(400, "Pictures must be PNG, JPEG, GIF or WebP.")

    # A new random name every time: browsers keep (cache) pictures they've seen, so if the new
    # picture had the old address, people would keep seeing the old one.
    box = crop_box_from(request)
    if content_type == "image/gif" and box is not None:
        # An animated GIF: save the upload under a temporary name, then crop and shrink every
        # frame into an animated WebP. In a background thread, so the chat keeps running meanwhile.
        picture_id = secrets.token_urlsafe(16) + ".webp"
        upload = settings["folder"] / (picture_id + ".upload")
        await receive_file(request, upload, MAX_GIF_SIZE)
        try:
            await asyncio.to_thread(
                make_animated_webp, upload, settings["folder"] / picture_id, box, settings["animated_size"]
            )
        except ValueError as error:
            raise HTTPException(400, str(error))
        except Exception:  # Pillow couldn't read it at all (broken file, too many pixels, ...)
            (settings["folder"] / picture_id).unlink(missing_ok=True)
            raise HTTPException(400, "Couldn't read that GIF.")
        finally:
            upload.unlink(missing_ok=True)  # the original isn't kept
    else:
        picture_id = secrets.token_urlsafe(16) + "." + PICTURE_EXTENSIONS[content_type]
        await receive_file(request, settings["folder"] / picture_id, settings["max_size"])
    return picture_id


async def set_picture(request, kind):
    """A new profile picture or banner."""
    user_id, username, password_hash, email = logged_in_user(request)
    settings = PICTURE_KINDS[kind]
    picture_id = await receive_picture(request, kind)

    old = db.execute(f"SELECT {settings['column']} FROM users WHERE id = ?", (user_id,)).fetchone()[0]
    with db:
        db.execute(f"UPDATE users SET {settings['column']} = ? WHERE id = ?", (picture_id, user_id))
    if old:
        (settings["folder"] / old).unlink(missing_ok=True)
    await announce_users()  # everyone's page shows the new picture
    return {"ok": True, kind: picture_id}


async def remove_picture(request, kind):
    user_id, username, password_hash, email = logged_in_user(request)
    settings = PICTURE_KINDS[kind]
    old = db.execute(f"SELECT {settings['column']} FROM users WHERE id = ?", (user_id,)).fetchone()[0]
    with db:
        db.execute(f"UPDATE users SET {settings['column']} = NULL WHERE id = ?", (user_id,))
    if old:
        (settings["folder"] / old).unlink(missing_ok=True)
    await announce_users()
    return {"ok": True}


def serve_picture(request, kind, picture_id):
    """A profile picture or banner, for logged-in people only."""
    settings = PICTURE_KINDS[kind]
    row = db.execute(f"SELECT 1 FROM users WHERE {settings['column']} = ?", (picture_id,)).fetchone()
    if current_user(request) is None or row is None:
        raise HTTPException(404, "Not found.")
    # Our own table said this name exists, so it's safe to use as a file name. Its extension
    # (which we chose ourselves when saving) gives the type.
    extension = picture_id.rsplit(".", 1)[-1]
    content_type = {ext: type_ for type_, ext in PICTURE_EXTENSIONS.items()}[extension]
    return FileResponse(
        settings["folder"] / picture_id,
        media_type=content_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            # A picture's address never changes what's behind it (a new picture gets a new address),
            # so the browser may keep it for a year without asking again. "private": only in
            # the person's own browser, not in shared caches along the way.
            "Cache-Control": "private, max-age=31536000, immutable",
        },
    )


@app.post("/settings/avatar")
async def change_avatar(request: Request):
    return await set_picture(request, "avatar")


@app.delete("/settings/avatar")
async def remove_avatar(request: Request):
    return await remove_picture(request, "avatar")


@app.get("/avatars/{picture_id}")
async def get_avatar(request: Request, picture_id: str):
    return serve_picture(request, "avatar", picture_id)


@app.post("/settings/banner")
async def change_banner(request: Request):
    return await set_picture(request, "banner")


@app.delete("/settings/banner")
async def remove_banner(request: Request):
    return await remove_picture(request, "banner")


@app.get("/banners/{picture_id}")
async def get_banner(request: Request, picture_id: str):
    return serve_picture(request, "banner", picture_id)


class ProfileChange(BaseModel):
    status: str
    bio: str


@app.post("/settings/profile")
async def change_profile(data: ProfileChange, request: Request):
    """Status and bio. No password needed: nothing about the account's security depends on them."""
    user_id, username, password_hash, email = logged_in_user(request)
    status = data.status.strip()
    bio = data.bio.strip()
    if len(status) > MAX_STATUS_LENGTH:
        raise HTTPException(400, f"Your status can be at most {MAX_STATUS_LENGTH} characters.")
    if len(bio) > MAX_BIO_LENGTH:
        raise HTTPException(400, f"Your bio can be at most {MAX_BIO_LENGTH} characters.")
    with db:
        # `status or None`: an empty text is stored as NULL, meaning "none".
        db.execute("UPDATE users SET status = ?, bio = ? WHERE id = ?", (status or None, bio or None, user_id))
    await announce_users()
    return {"ok": True}


# ---------- Appearance (Settings → Appearance): theme, colours, font, text size and scale ----------
#
# Kept with the account, so it's the same on every device. The page (static/js/appearance.js)
# puts these values into its CSS, so only names from these lists and real colours get in: without
# that check, anyone could put any text into their own page's styles with a hand-made request.

APPEARANCE_THEMES = {"dark", "darker", "light", "blue", "purple", "green", "pink", "lightpink"}
APPEARANCE_FONTS = {"system", "calibri", "georgia", "consolas", "comic"}
# The colours with a picker: names of the CSS variables in chat.css (without the "--").
APPEARANCE_COLOURS = {"bg-main", "bg-panel", "text", "text-muted", "accent", "link"}
HEX_COLOUR = re.compile(r"#[0-9a-fA-F]{6}")  # "#" and six hex digits, like "#5865f2"


class Appearance(BaseModel):
    theme: str = "dark"
    colours: dict[str, str] = {}  # only the ones picked by hand: {"accent": "#e91e63"}
    font: str = "system"
    font_size: int = 16  # pixels: everything written in rem in chat.css follows it
    scale: int = 100  # percent: the desktop app zooms the whole page (main.rs, set_zoom)


def appearance_of(user_id):
    """Someone's saved appearance as a dict, or None if they never changed it."""
    saved = db.execute("SELECT appearance FROM users WHERE id = ?", (user_id,)).fetchone()[0]
    return json.loads(saved) if saved else None


@app.post("/settings/appearance")
async def change_appearance(data: Appearance, request: Request):
    user_id, username, password_hash, email = logged_in_user(request)
    if data.theme not in APPEARANCE_THEMES:
        raise HTTPException(400, "Unknown theme.")
    if data.font not in APPEARANCE_FONTS:
        raise HTTPException(400, "Unknown font.")
    for name, colour in data.colours.items():
        if name not in APPEARANCE_COLOURS or not HEX_COLOUR.fullmatch(colour):
            raise HTTPException(400, "Unknown colour.")
    if not 12 <= data.font_size <= 20:
        raise HTTPException(400, "The text size must be between 12 and 20.")
    if not 80 <= data.scale <= 150:
        raise HTTPException(400, "The scale must be between 80 and 150.")
    appearance = data.model_dump()  # the checked values, back as a plain dict
    with db:
        db.execute("UPDATE users SET appearance = ? WHERE id = ?", (json.dumps(appearance), user_id))
    # Every open page of theirs (this one too, which already shows it): the app, their phone.
    await send_to_user(user_id, {"type": "appearance", "appearance": appearance})
    return {"ok": True}


# ---------- Push notifications (the phone app) ----------
#
# A device that turns them on (Settings → Notifications) gives us a "subscription": an address at
# its push service (the endpoint) and two keys to encrypt pushes for it. We keep one row per device.
#
# In 2b we'll send requests to those endpoints, so only the real push services are accepted:
# otherwise anyone could make our server visit any address, even inside our own network ("SSRF").

PUSH_SERVICE_HOSTS = (
    "fcm.googleapis.com",          # Chrome, Edge and other Chromium browsers on Android and PCs
    ".push.apple.com",             # Safari (iPhones, Macs)
    ".push.services.mozilla.com",  # Firefox
    ".notify.windows.com",         # Edge on Windows
)


def is_push_service(endpoint):
    """True for an https address at one of the push services above (".x" means x and anything under it)."""
    parts = urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    known = False
    for name in PUSH_SERVICE_HOSTS:
        if host == name or (name.startswith(".") and host.endswith(name)):
            known = True
    return parts.scheme == "https" and known and len(endpoint) <= 1000


class PushSubscription(BaseModel):
    endpoint: str
    p256dh: str = ""  # (not needed to unsubscribe)
    auth: str = ""


@app.post("/push/subscribe")
async def push_subscribe(data: PushSubscription, request: Request):
    user_id, username, password_hash, email = logged_in_user(request)
    if not VAPID_PUBLIC_KEY:
        raise HTTPException(400, "Push notifications aren't set up on this server.")
    if not is_push_service(data.endpoint):
        raise HTTPException(400, "That isn't a push service we know.")
    if not (0 < len(data.p256dh) <= 200 and 0 < len(data.auth) <= 100):
        raise HTTPException(400, "Those keys don't look right.")
    with db:
        # "OR REPLACE": the same device again (or someone else logged in on it): this row replaces it.
        db.execute(
            "INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)",
            (data.endpoint, user_id, data.p256dh, data.auth),
        )
    return {"ok": True}


@app.post("/push/unsubscribe")
async def push_unsubscribe(data: PushSubscription, request: Request):
    user_id, username, password_hash, email = logged_in_user(request)
    with db:
        db.execute("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", (data.endpoint, user_id))
    return {"ok": True}


class PushMute(BaseModel):
    endpoint: str
    until: float | None = None  # a Unix time in seconds; None = not muted (far future = until turned back on)


@app.post("/push/mute")
async def push_mute(data: PushMute, request: Request):
    """"Mute notifications" in Settings, for this device's pushes (the page keeps its own copy)."""
    user_id, username, password_hash, email = logged_in_user(request)
    with db:
        db.execute(
            "UPDATE push_subscriptions SET muted_until = ? WHERE endpoint = ? AND user_id = ?",
            (data.until, data.endpoint, user_id),
        )
    return {"ok": True}


# ----- The native phone app: Firebase Cloud Messaging (FCM) -----
#
# The app has no service worker. Instead it registers with Firebase on the phone and gets a "token":
# that phone's address at FCM, which it gives us (/push/fcm) at every connect. We keep it in
# push_subscriptions like a browser's subscription, as "fcm:<token>", so muting, unsubscribing and
# send_push's rules (not while looking, not on Do Not Disturb) work the same for both.
#
# Sending is one HTTPS request to Google per push. It must carry an access token that proves we're
# this Firebase project. We get one (good for an hour) by signing a small JWT with the service
# account's private key and trading it in at Google. Unlike make_jwt's HMAC (one shared secret), this
# is RS256: an RSA signature, which Google checks with the public half of the key it keeps.

firebase_account = json.loads(FIREBASE_KEY_FILE.read_text()) if FIREBASE_KEY_FILE.exists() else None
firebase_access = {"token": None, "expires": 0}  # the current access token, and when it runs out
FCM_TOKEN = re.compile(r"[\w:-]{20,4096}")  # what a token looks like (letters, digits, _ : -)
FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"  # all we ask permission for: sending


def firebase_access_token():
    """An access token for FCM: the one we have, or a new one if it runs out within a minute."""
    if time.time() < firebase_access["expires"] - 60:
        return firebase_access["token"]
    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    claims = {
        "iss": firebase_account["client_email"],  # who's asking: the service account
        "scope": FCM_SCOPE,
        "aud": firebase_account["token_uri"],      # for Google's token address only
        "iat": now,
        "exp": now + 3600,
    }
    signed_part = base64url(json.dumps(header).encode()) + "." + base64url(json.dumps(claims).encode())
    key = serialization.load_pem_private_key(firebase_account["private_key"].encode(), password=None)
    signature = key.sign(signed_part.encode(), padding.PKCS1v15(), hashes.SHA256())
    form = urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",  # "here's a signed JWT, give me a token"
        "assertion": signed_part + "." + base64url(signature),
    }).encode()
    with urllib.request.urlopen(firebase_account["token_uri"], data=form, timeout=10) as response:
        answer = json.load(response)
    firebase_access.update(token=answer["access_token"], expires=time.time() + answer["expires_in"])
    return answer["access_token"]


class FcmTokenGone(Exception):
    """FCM says this token isn't anyone's any more (the app was uninstalled, or got a new token)."""


def send_fcm(token, payload, ttl):
    """One push to one phone. Run it in a thread: it waits for Google's answer. A "data message": the
    app's own code (mobile/modules/push) makes the notification from it, so every value is text."""
    message = {
        "token": token,
        "data": {key: str(value) for key, value in payload.items() if value is not None},
        # HIGH: deliver at once, even to a sleeping phone (Google allows it for pushes that show a
        # notification, which ours do). ttl: how long FCM keeps trying a phone that's off.
        "android": {"priority": "HIGH", "ttl": f"{ttl}s"},
    }
    request = urllib.request.Request(
        f"https://fcm.googleapis.com/v1/projects/{firebase_account['project_id']}/messages:send",
        data=json.dumps({"message": message}).encode(),
        headers={"Authorization": "Bearer " + firebase_access_token(), "Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(request, timeout=10).close()
    except urllib.error.HTTPError as error:
        if error.code == 404:  # "UNREGISTERED"
            raise FcmTokenGone() from error
        raise Exception(f"{error.code} {error.read()[:300]!r}") from error


class PhonePush(BaseModel):
    token: str


@app.post("/push/fcm")
async def push_fcm(data: PhonePush, request: Request):
    """The phone app's FCM token: pushes go to this phone from now on (until /push/unsubscribe)."""
    user_id, username, password_hash, email = logged_in_user(request)
    if firebase_account is None:
        raise HTTPException(400, "Push notifications for the app aren't set up on this server.")
    if not FCM_TOKEN.fullmatch(data.token):
        raise HTTPException(400, "That doesn't look like a token.")
    with db:
        # Sent at every connect, so an existing row stays as it is (its mute too), unless someone else
        # logged in on that phone: then it's theirs, unmuted.
        db.execute(
            "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, '', '')"
            " ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id,"
            " muted_until = CASE WHEN user_id = excluded.user_id THEN muted_until END",
            ("fcm:" + data.token, user_id),
        )
    return {"ok": True}


# Sending. A push service only passes a push on: pywebpush encrypts it for that one browser (with
# the subscription's keys) and signs it with our private key. "sub" says who we are, for the push
# service to contact if our pushes cause trouble: an email address, from MAIL_FROM.
PUSH_CLAIMS_SUBJECT = "mailto:" + parseaddr(MAIL_FROM)[1]
PUSH_TEXT_LENGTH = 200  # the start of a message is enough (and a push may be at most about 4 KB)


def readable_text(text):
    """A message's text as it was typed: <@2> back to @kari, <@everyone> to @everyone, <:17> to :pog:."""
    names = dict(db.execute("SELECT id, username FROM users"))
    emoji = dict(db.execute("SELECT id, name FROM custom_emoji"))
    text = text.replace("<@everyone>", "@everyone")
    text = re.sub(r"<@(\d+)>", lambda match: "@" + names.get(int(match[1]), "someone"), text)
    return re.sub(r"<:(\d+)>", lambda match: ":" + emoji.get(int(match[1]), "emoji") + ":", text)


def is_looking(user_id):
    """Is this person looking at the chat right now, on any device? (Each page says so: "looking".)"""
    return any(client["user_id"] == user_id and client["looking"] for client in clients.values())


def has_app_open(user_id):
    """Has this person got the Windows app open (focused or not)? It notifies by itself, so their
    phones stay quiet meanwhile. (The page says it's the app in its "looking" messages.)"""
    return any(client["user_id"] == user_id and client["app"] for client in clients.values())


async def send_push(user_ids, payload, ttl=24 * 60 * 60, urgency="normal", always=False):
    """Push this to every device of these people that turned push on and isn't muted, unless they're
    looking at the chat somewhere right now or have the Windows app open (then they get it there), or
    chose Do Not Disturb. ttl: how many seconds the push service keeps trying a phone that's off or
    offline. Run it as a background task: each push service takes a moment to answer, and the chat
    mustn't wait for that.
    always: to all of them, whatever they're doing, and only to the phone app: for taking a ringing
    call off their phones (a browser's notification can't be taken back by a push)."""
    if not always:
        user_ids = [user_id for user_id in user_ids
                    if not is_looking(user_id) and not has_app_open(user_id) and presence_of(user_id) != "dnd"]
    if not user_ids:
        return
    marks = ",".join("?" * len(user_ids))  # "?,?,?": one placeholder per person
    rows = db.execute(
        f"SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN ({marks})"
        + ("" if always else " AND (muted_until IS NULL OR muted_until < ?)"),
        (*user_ids,) if always else (*user_ids, time.time()),
    ).fetchall()
    data = json.dumps(payload)
    for endpoint, p256dh, auth in rows:
        if endpoint.startswith("fcm:"):  # the phone app
            if firebase_account is None:
                continue
            try:
                await asyncio.to_thread(send_fcm, endpoint.removeprefix("fcm:"), payload, ttl)
            except FcmTokenGone:
                with db:
                    db.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
            except Exception as error:
                print(f"A push to the phone app failed: {error}")
            continue
        if always or not VAPID_PRIVATE_KEY:
            continue
        try:
            # In a thread: webpush waits for the push service's answer, which would stop the whole
            # server (everyone's chat) in the meantime if it ran here.
            await asyncio.to_thread(
                webpush,
                subscription_info={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
                data=data,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": PUSH_CLAIMS_SUBJECT},
                ttl=ttl,
                headers={"Urgency": urgency},  # "high": deliver at once, even to a sleeping phone
                timeout=10,
            )
        except WebPushException as error:
            status = error.response.status_code if error.response is not None else None
            if status in (404, 410):  # "this subscription doesn't exist (any more)": uninstalled, say
                with db:
                    db.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
            else:
                print(f"A push to {urlsplit(endpoint).hostname} failed: {error}")
        except Exception as error:  # (no connection, a timeout, ...): try again with the next message
            print(f"A push to {urlsplit(endpoint).hostname} failed: {error}")


def push_in_background(user_ids, payload, **options):
    """Start send_push without waiting for it (kept in background_tasks, or asyncio may drop it)."""
    task = asyncio.create_task(send_push(user_ids, payload, **options))
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)


def push_message(people, message):
    """A new message for these people (a DM to them, or mentioning them): "axel in #general"."""
    channel = message["channel"]
    if channel.startswith("dm:"):
        chat = None  # (a DM is the person)
    elif channel.startswith("g:"):
        chat = group_title(channel)
    else:
        chat = "#" + channel_name(channel)
    title = message["name"] if chat is None else f'{message["name"]} in {chat}'
    body = readable_text(message["text"])
    if len(body) > PUSH_TEXT_LENGTH:
        body = body[:PUSH_TEXT_LENGTH] + "…"
    if not body and message["file"]:
        body = "📷 A picture" if message["file"]["image"] else "📎 " + message["file"]["filename"]
    avatar = db.execute("SELECT avatar_id FROM users WHERE id = ?", (message["user_id"],)).fetchone()[0]
    push_in_background(people, {
        "title": title, "body": body, "channel": channel, "message_id": message["id"],
        "icon": f"/avatars/{avatar}" if avatar else "/icons/icon-192.png",
        # For the phone app, which stacks a chat's messages in one notification ("kari: hi"):
        # who wrote it, and the chat's name (none for a DM: that's the person).
        "kind": "message", "sender": message["name"], "sender_id": message["user_id"],
        "chat": chat,
    })


# ---------- Feedback: bug reports and ideas (Settings → Feedback) ----------

FEEDBACK_KINDS = {"bug": "Bug report", "idea": "Idea"}
MAX_FEEDBACK_LENGTH = 4000


class Feedback(BaseModel):
    kind: str
    text: str
    app: bool = False  # sent from the Windows app (whose window says it's Edge, so we're told)
    phone: bool = False  # sent from the phone app (mobile/, which says it's "okhttp")


@app.post("/feedback")
async def send_feedback(data: Feedback, request: Request, background_tasks: BackgroundTasks):
    """Save a bug report or idea, and email it to every admin (tools/make_admin.py) with an email.
    Saved first, so nothing is lost if the email can't be sent; tools/feedback.py lists them."""
    user_id, username, password_hash, email = logged_in_user(request)
    if data.kind not in FEEDBACK_KINDS:
        raise HTTPException(400, "Choose bug or idea.")
    text = data.text.strip()
    if not text:
        raise HTTPException(400, "Write something first.")
    if len(text) > MAX_FEEDBACK_LENGTH:
        raise HTTPException(400, f"That's a bit long: at most {MAX_FEEDBACK_LENGTH} characters.")
    # A few per person at a time, so a stuck button (or a prank) can't fill the admins' inboxes.
    # Every report counts here, like with /forgot.
    key = f"feedback:{user_id}"
    if too_many_failures(key):
        raise HTTPException(429, "That's a lot of feedback! Try again in 15 minutes.")
    record_failure(key)

    # The browser says what it is in every request (the User-Agent header): which browser, which
    # version, which system. The app's window (WebView2) says it's Edge, and the phone app's requests
    # say "okhttp" (Android's web library), so the apps tell us.
    marker = "ChatApp Windows app | " if data.app else "ChatApp Android app | " if data.phone else ""
    user_agent = marker + request.headers.get("user-agent", "")[:300]
    with db:
        cursor = db.execute(
            "INSERT INTO feedback (user_id, kind, text, user_agent) VALUES (?, ?, ?, ?)",
            (user_id, data.kind, text, user_agent),
        )
    feedback_id = cursor.lastrowid

    admin_emails = [e for (e,) in db.execute("SELECT email FROM users WHERE is_admin = 1 AND email IS NOT NULL")]
    # The subject shows the start of the text. An email header must be one line, so newlines go.
    preview = " ".join(text.split())[:60]
    subject = f"{FEEDBACK_KINDS[data.kind]} from {username}: {preview}"
    body = (
        f"{FEEDBACK_KINDS[data.kind]} #{feedback_id} from {username}:\n\n"
        f"{text}\n\n"
        f"Sent from: {user_agent or 'unknown'}\n"
        "(All of them: python tools/feedback.py on the server PC.)\n"
    )
    for admin_email in admin_emails:
        background_tasks.add_task(send_email, admin_email, subject, body)
    if not admin_emails:
        print(f"Feedback #{feedback_id} saved, but no admin has an email to send it to.", flush=True)
    return {"ok": True}


def logged_in_admin(request):
    """The logged-in admin's id, or an error. The page only shows the inbox to admins, but anyone
    can send a request by hand, so this check on the server is what actually keeps it private."""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    if not is_admin(user_id):
        raise HTTPException(403, "Only admins can do that.")
    return user_id


@app.get("/feedback")
async def list_feedback(request: Request):
    """Every report, newest first, for the inbox in Settings (admins only)."""
    logged_in_admin(request)
    rows = db.execute(
        "SELECT id, user_id, kind, text, user_agent, created_at, done FROM feedback ORDER BY id DESC"
    ).fetchall()
    return [
        {
            "id": feedback_id, "user_id": user_id, "kind": kind, "text": text,
            "user_agent": user_agent, "created_at": iso_time(created_at), "done": bool(done),
        }
        for feedback_id, user_id, kind, text, user_agent, created_at, done in rows
    ]


class FeedbackDone(BaseModel):
    done: bool


@app.post("/feedback/{feedback_id}/done")
async def mark_feedback_done(feedback_id: int, data: FeedbackDone, request: Request):
    """Tick a report off (done: true), or open it again (done: false). Admins only.
    {feedback_id} in the path: FastAPI takes the 12 out of /feedback/12/done (and refuses
    anything that isn't a number, because of the `int`)."""
    logged_in_admin(request)
    with db:
        cursor = db.execute("UPDATE feedback SET done = ? WHERE id = ?", (int(data.done), feedback_id))
    if cursor.rowcount == 0:
        raise HTTPException(404, "There's no such report.")
    return {"ok": True}


# ---------- Custom emoji ----------

def custom_emoji_message():
    """Every custom emoji: {"type": "custom_emoji", "emoji": [{"id", "name", "file", "owner_id"}, ...]}."""
    rows = db.execute("SELECT id, name, file, owner_id FROM custom_emoji ORDER BY name COLLATE NOCASE")
    return {
        "type": "custom_emoji",
        "emoji": [{"id": emoji_id, "name": name, "file": file, "owner_id": owner_id} for emoji_id, name, file, owner_id in rows],
    }


CUSTOM_EMOJI_CODE = re.compile(r":([A-Za-z0-9_]{2,32}):")  # :pog: in a message's text


def expand_custom_emoji(text):
    """Turn every :name: of an existing custom emoji into a token with its id, like <:17>.
    Messages store the id, not the name, so a deleted (or one day renamed) emoji can never turn
    into a different one that later gets the same name. Anything else (":)", ":nope:") stays text."""
    ids = {name.lower(): emoji_id for emoji_id, name in db.execute("SELECT id, name FROM custom_emoji")}

    def replace(match):  # called for each :name: found; returns what to put in its place
        emoji_id = ids.get(match[1].lower())
        return f"<:{emoji_id}>" if emoji_id else match[0]

    return CUSTOM_EMOJI_CODE.sub(replace, text)


# "@kari" in a message: an @ at the start or after a space ((?<!\S) = "not right after a non-space"),
# so email addresses like me@gmail.com stay text. Then a username's characters.
MENTION_CODE = re.compile(r"(?<!\S)@([A-Za-z0-9_-]{1,32})")


def expand_mentions(text):
    """Turn "@kari" into <@2> (her user id) and "@everyone" into <@everyone>, like custom emoji:
    by id, so a renamed person's old mentions show their new name. Returns the new text,
    the ids mentioned by name, and whether @everyone was used."""
    ids = {name.lower(): user_id for user_id, name in db.execute("SELECT id, username FROM users")}
    mentioned = set()
    everyone = False

    def replace(match):
        nonlocal everyone  # (lets this inner function change `everyone` from the outer one)
        name = match[1].lower()
        if name == "everyone":
            everyone = True
            return "<@everyone>"
        if name in ids:
            mentioned.add(ids[name])
            return f"<@{ids[name]}>"
        return match[0]  # not a user: stays text

    return MENTION_CODE.sub(replace, text), mentioned, everyone


def save_mentions(message_id, channel, sender_id, mentioned, everyone):
    """Remember who a message mentions (replacing what was there, for edits). Only people who can
    see the channel, and never the sender themselves. @everyone = everyone who can see it.
    A bot named in a DM counts too: its mention is what invites it in (see bot_invited)."""
    invited = {user_id for user_id in mentioned if channel.startswith("dm:") and is_bot(user_id)}  # (by name: not @everyone)
    named = set(mentioned)  # the people named in it (@kari), before @everyone and DMs add the rest
    if everyone:
        mentioned = {user_id for (user_id,) in db.execute("SELECT id FROM users")}
    if channel.startswith("dm:"):
        # In a DM, every message counts as mentioning the other person (like Discord): it gets a
        # red number and a notification. "dm:3:7" -> both ids; the sender is left out below.
        mentioned = set(mentioned) | {int(part) for part in channel.split(":")[1:]}
    elif channel.startswith("g:"):
        # A group DM: the same, for every member but a bot (Chattus only wants his @mentions there).
        mentioned = set(mentioned) | {member for member in group_members(channel) if not is_bot(member)}
    people = [user_id for user_id in mentioned
              if user_id != sender_id and (can_join(channel, user_id) or user_id in invited)]
    # Who muted this chat only hears about it when named in it, or when an admin wrote it (admins
    # can't be muted). Leaving them out here means no red count, notification or push for them.
    if not is_admin(sender_id):
        muted = {user_id for (user_id,) in db.execute("SELECT user_id FROM chat_mutes WHERE channel = ?", (channel,))}
        people = [user_id for user_id in people if user_id not in muted or user_id in named]
    blockers = blockers_of(sender_id)  # who blocked the sender never hears from them
    people = [user_id for user_id in people if user_id not in blockers]
    with db:
        db.execute("DELETE FROM mentions WHERE message_id = ?", (message_id,))
        db.executemany(  # executemany: the same INSERT once for each item in the list
            "INSERT INTO mentions (message_id, user_id) VALUES (?, ?)", [(message_id, user_id) for user_id in people]
        )
    return people


def unread_mentions(user_id, channel=None):
    """How many unread messages mention this user, per channel: {"memes": 2, ...}.
    Unread = newer than the last message they've seen there (last_read), like the unread dots."""
    rows = db.execute(
        """
        SELECT messages.channel, COUNT(*)
        FROM mentions
        JOIN messages ON messages.id = mentions.message_id
        LEFT JOIN last_read ON last_read.user_id = mentions.user_id AND last_read.channel = messages.channel
        WHERE mentions.user_id = ? AND messages.id > COALESCE(last_read.message_id, 0)
        GROUP BY messages.channel
        """,
        (user_id,),
    )
    counts = {name: count for name, count in rows if can_join(name, user_id)}
    return counts if channel is None else {channel: counts.get(channel, 0)}


def custom_emoji_exists(reaction):
    """Is this a reference to a custom emoji that exists, like "custom:17"?"""
    match = re.fullmatch(r"custom:(\d{1,10})", reaction)
    if match is None:
        return False
    return db.execute("SELECT 1 FROM custom_emoji WHERE id = ?", (int(match[1]),)).fetchone() is not None


@app.post("/custom-emoji")
async def add_custom_emoji(request: Request, name: str):
    """Add a custom emoji: the picture is the body (like a profile picture), the name is in the address."""
    user_id, username, password_hash, email = logged_in_user(request)
    name = name.strip()
    if not EMOJI_NAME_PATTERN.fullmatch(name):
        raise HTTPException(400, "Emoji names are 2–32 letters, digits or _.")
    count = db.execute("SELECT COUNT(*) FROM custom_emoji WHERE owner_id = ?", (user_id,)).fetchone()[0]
    if count >= MAX_CUSTOM_EMOJI:
        raise HTTPException(400, f"You have {MAX_CUSTOM_EMOJI} emoji. Delete one to add another.")
    if db.execute("SELECT 1 FROM custom_emoji WHERE name = ?", (name,)).fetchone():
        raise HTTPException(400, f"There's already an emoji called :{name}:.")  # (checked again below)

    file = await receive_picture(request, "emoji")
    try:
        with db:
            db.execute("INSERT INTO custom_emoji (name, file, owner_id) VALUES (?, ?, ?)", (name, file, user_id))
    except sqlite3.IntegrityError:
        # Someone took the name while our picture was uploading: the UNIQUE rule caught it.
        (PICTURE_KINDS["emoji"]["folder"] / file).unlink(missing_ok=True)
        raise HTTPException(400, f"There's already an emoji called :{name}:.")
    await send_to_everyone(custom_emoji_message())  # it appears in everyone's picker
    return {"ok": True}


@app.delete("/custom-emoji/{emoji_id}")
async def delete_custom_emoji(request: Request, emoji_id: int):
    """Delete one of your own custom emoji (admins: anyone's), and the reactions that used it."""
    user_id, username, password_hash, email = logged_in_user(request)
    row = db.execute("SELECT file, owner_id FROM custom_emoji WHERE id = ?", (emoji_id,)).fetchone()
    if row is None or (row[1] != user_id and not is_admin(user_id)):
        raise HTTPException(404, "That's not one of your emoji.")
    reaction = f"custom:{emoji_id}"
    # Which messages had it as a reaction, so their chips can be updated afterwards.
    affected = db.execute(
        "SELECT DISTINCT reactions.message_id, messages.channel FROM reactions "
        "JOIN messages ON messages.id = reactions.message_id WHERE reactions.emoji = ?",
        (reaction,),
    ).fetchall()
    with db:
        db.execute("DELETE FROM reactions WHERE emoji = ?", (reaction,))
        db.execute("DELETE FROM custom_emoji WHERE id = ?", (emoji_id,))
    (PICTURE_KINDS["emoji"]["folder"] / row[0]).unlink(missing_ok=True)

    await send_to_everyone(custom_emoji_message())
    for message_id, channel in affected:
        await send_to_channel(channel, {
            "type": "reactions", "channel": channel, "message_id": message_id,
            "reactions": reactions_for([message_id])[message_id],
        })
    return {"ok": True}


@app.post("/custom-emoji/{emoji_id}/picture")
async def replace_custom_emoji(request: Request, emoji_id: int):
    """A new picture for one of your own custom emoji (admins: anyone's). It keeps its id and name,
    so every message and reaction that uses it shows the new picture."""
    user_id, username, password_hash, email = logged_in_user(request)
    row = db.execute("SELECT owner_id FROM custom_emoji WHERE id = ?", (emoji_id,)).fetchone()
    if row is None or (row[0] != user_id and not is_admin(user_id)):
        raise HTTPException(404, "That's not one of your emoji.")

    folder = PICTURE_KINDS["emoji"]["folder"]
    file = await receive_picture(request, "emoji")
    # Look the old file up only now: someone might have replaced it while ours was uploading.
    old = db.execute("SELECT file FROM custom_emoji WHERE id = ?", (emoji_id,)).fetchone()
    if old is None:  # deleted while ours was uploading
        (folder / file).unlink(missing_ok=True)
        raise HTTPException(404, "That emoji was deleted.")
    with db:
        db.execute("UPDATE custom_emoji SET file = ? WHERE id = ?", (file, emoji_id))
    (folder / old[0]).unlink(missing_ok=True)
    await send_to_everyone(custom_emoji_message())  # everyone's pictures switch to the new file
    return {"ok": True}


@app.get("/custom-emoji/files/{file}")
async def get_custom_emoji(request: Request, file: str):
    """A custom emoji's picture, for logged-in people only."""
    row = db.execute("SELECT 1 FROM custom_emoji WHERE file = ?", (file,)).fetchone()
    if current_user(request) is None or row is None:
        raise HTTPException(404, "Not found.")
    extension = file.rsplit(".", 1)[-1]  # our own table said this name exists, so it's safe to use
    content_type = {ext: type_ for type_, ext in PICTURE_EXTENSIONS.items()}[extension]
    return FileResponse(
        PICTURE_KINDS["emoji"]["folder"] / file,
        media_type=content_type,
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable"},
    )


# ---------- Friends ----------

def pair(a, b):
    """Two user ids, smallest first: how a pair is stored in the friendships table."""
    return (a, b) if a < b else (b, a)


def friendship(a, b):
    """(requested_by, accepted) for two people, or None if there's nothing between them."""
    return db.execute(
        "SELECT requested_by, accepted FROM friendships WHERE user_a = ? AND user_b = ?", pair(a, b)
    ).fetchone()


def are_friends(a, b):
    row = friendship(a, b)
    return row is not None and row[1] == 1


def friends_message(user_id):
    """One person's own view: {"type": "friends", "friends": [...], "incoming": [...], "outgoing": [...]}."""
    friends, incoming, outgoing = [], [], []
    rows = db.execute(
        "SELECT user_a, user_b, requested_by, accepted FROM friendships WHERE user_a = ? OR user_b = ?",
        (user_id, user_id),
    )
    for user_a, user_b, requested_by, accepted in rows:
        other = user_b if user_a == user_id else user_a
        if accepted:
            friends.append(other)
        elif requested_by == user_id:
            outgoing.append(other)  # we asked them
        else:
            incoming.append(other)  # they asked us
    return {"type": "friends", "friends": friends, "incoming": incoming, "outgoing": outgoing}


async def send_friends_update(*user_ids):
    """Friendships are personal, so they aren't sent to everyone: each of these people gets
    their own up-to-date list, in all their open tabs."""
    for user_id in user_ids:
        message = friends_message(user_id)
        for websocket, client in list(clients.items()):
            if client["user_id"] == user_id:
                await send(websocket, message)


class FriendAction(BaseModel):
    user_id: int  # the other person


def other_person(data, request):
    """(my id, their id) for a friend action, after checking it makes sense."""
    me = current_user(request)
    if me is None:
        raise HTTPException(401, "You're not logged in.")
    if data.user_id == me or username_of(data.user_id) is None:
        raise HTTPException(400, "That's not someone you can add.")
    return me, data.user_id


@app.post("/friends/request")
async def friend_request(data: FriendAction, request: Request):
    me, other = other_person(data, request)
    if has_blocked(me, other):
        raise HTTPException(400, "You've blocked them: unblock them first.")
    if has_blocked(other, me):  # (said plainly, without telling them they're blocked)
        raise HTTPException(400, "You can't send a friend request to this person.")
    row = friendship(me, other)
    user_a, user_b = pair(me, other)
    if row is None:
        with db:
            db.execute(
                "INSERT INTO friendships (user_a, user_b, requested_by) VALUES (?, ?, ?)", (user_a, user_b, me)
            )
        # Their phones too (the page notifies by itself: notifyFriendRequest). Tapping it opens the
        # Friends page ("friends" as the channel, like the page's own name for it).
        avatar = db.execute("SELECT avatar_id FROM users WHERE id = ?", (me,)).fetchone()[0]
        push_in_background([other], {
            "title": username_of(me), "body": "👋 sent you a friend request", "channel": "friends",
            "icon": f"/avatars/{avatar}" if avatar else "/icons/icon-192.png", "kind": "friend",
        })
    elif row[1] == 0 and row[0] == other:
        # They had already asked us: asking back counts as accepting.
        with db:
            db.execute("UPDATE friendships SET accepted = 1 WHERE user_a = ? AND user_b = ?", (user_a, user_b))
    # Otherwise we're already friends, or we already asked: nothing to change.
    await send_friends_update(me, other)
    return {"ok": True}


@app.post("/friends/accept")
async def friend_accept(data: FriendAction, request: Request):
    me, other = other_person(data, request)
    user_a, user_b = pair(me, other)
    with db:
        # Only a request *they* sent can be accepted by us.
        cursor = db.execute(
            "UPDATE friendships SET accepted = 1 WHERE user_a = ? AND user_b = ? AND requested_by = ? AND accepted = 0",
            (user_a, user_b, other),
        )
    if cursor.rowcount != 1:
        raise HTTPException(400, "There's no friend request from them.")
    await send_friends_update(me, other)
    return {"ok": True}


@app.post("/friends/remove")
async def friend_remove(data: FriendAction, request: Request):
    """Decline a request, cancel your own, or end a friendship: all three remove the row.
    The DM's messages stay in the database, hidden; becoming friends again brings them back."""
    me, other = other_person(data, request)
    if is_bot(me) or is_bot(other):  # (the page shows no Remove for bots; this is for anyone who asks by hand)
        raise HTTPException(400, "Bots stay everyone's friend.")
    with db:
        db.execute("DELETE FROM friendships WHERE user_a = ? AND user_b = ?", pair(me, other))
    await send_friends_update(me, other)
    return {"ok": True}


# ---------- Blocking ----------
#
# Blocking someone ends the friendship (and any request), so DMs, group invites and DM calls stop:
# all of those need friends. They can't send a new request; they never count as mentioning us
# (save_mentions: no notifications, counts or pushes) and their calls don't ring us; their messages in
# chats we share are hidden on our page, and left out of our searches. They aren't told. Admins
# can't be blocked (the chat's rule), nor bots (they're everyone's friend, at every start).

def has_blocked(blocker, blocked):
    return db.execute("SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?", (blocker, blocked)).fetchone() is not None


def blockers_of(user_id):
    """Everyone who blocked this person (they don't hear from them)."""
    return {blocker for (blocker,) in db.execute("SELECT blocker_id FROM blocks WHERE blocked_id = ?", (user_id,))}


def blocks_message(user_id):
    """The people someone blocked, for their own pages: {"type": "blocks", "blocked": [7, 12]}."""
    rows = db.execute("SELECT blocked_id FROM blocks WHERE blocker_id = ? ORDER BY created_at", (user_id,))
    return {"type": "blocks", "blocked": [blocked for (blocked,) in rows]}


@app.post("/friends/block")
async def block(data: FriendAction, request: Request):
    me, other = other_person(data, request)
    if is_admin(other):
        raise HTTPException(400, "Admins can't be blocked.")
    if is_bot(other):
        raise HTTPException(400, "Bots can't be blocked. To quiet one, mute its channel (🔔).")
    with db:
        db.execute("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)", (me, other))
        db.execute("DELETE FROM friendships WHERE user_a = ? AND user_b = ?", pair(me, other))
    await send_friends_update(me, other)  # (they see the friendship gone, as if it had been removed)
    await send_to_user(me, blocks_message(me))
    return {"ok": True}


@app.post("/friends/unblock")
async def unblock(data: FriendAction, request: Request):
    """Unblocking doesn't make them a friend again: that takes a new request."""
    me, other = other_person(data, request)
    with db:
        db.execute("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?", (me, other))
    await send_to_user(me, blocks_message(me))
    return {"ok": True}


# ---------- Pages ----------

@app.get("/")
async def index(request: Request):
    # The main domain gets the landing page. The tunnel passes on the address the visitor asked
    # for in the Host header ("example.com", or "chat.example.com" for the chat).
    if LANDING_HOST and (request.headers.get("host") or "").split(":")[0].lower() == LANDING_HOST:
        return landing_page()
    if current_user(request) is None:
        if unverified_user(request) is not None:
            return RedirectResponse("/verify-email")  # logged in, but the email isn't verified yet
        return RedirectResponse("/login")  # not logged in: send them to the login page
    # no-cache: the browser asks each time whether it changed, so a reload after a new version
    # (see PAGE_VERSION) never gets an old copy.
    return FileResponse("static/index.html", headers={"Cache-Control": "no-cache"})


def landing_page():
    """The landing page, with {{CHAT}} in it replaced by the chat's address (PUBLIC_URL, from our own
    settings, never from the request), so its buttons lead to the right place on every copy."""
    html = Path("static/landing/index.html").read_text(encoding="utf-8").replace("{{CHAT}}", PUBLIC_URL)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


@app.get("/welcome")
async def welcome():
    # The landing page on any address: for trying it out, and for linking to.
    return landing_page()


@app.get("/login")
async def login_page(request: Request):
    if current_user(request) is not None:
        return RedirectResponse("/")  # already logged in: straight to the chat
    if unverified_user(request) is not None:
        return RedirectResponse("/verify-email")  # (logged in, waiting for the email's link)
    return FileResponse("static/login.html")


@app.get("/reset")
async def reset_page():
    # One page for both steps: "send me a link" (no token) and "choose a new password" (?token=...).
    return FileResponse("static/reset.html")


# ---------- Seasons ----------
#
# A seasonal easter egg: during a season (Halloween in October, ...) a small emoji sits on the corner
# of your own picture at the bottom left, and clicking it plays that season's video. The videos aren't
# in git (they're big, and may be someone else's work): they're in the git-ignored seasonal/ folder on
# the server, copied there with scripts/seasonal-upload.ps1. A season whose video isn't there doesn't
# show at all, so a copy of the chat without the videos has no easter egg.

SEASONAL_DIR = Path("seasonal")
SEASONS = [
    # Its name, the months it lasts (1-12), what sits on your picture (an emoji, or "image": a picture in
    # static/seasonal/, worn on top like a hat), and its video's file name in seasonal/.
    {"name": "halloween", "months": [10], "emoji": "🎃", "video": "halloween.mp4"},
    {"name": "christmas", "months": [12], "image": "/static/seasonal/santa-hat.svg", "video": "christmas.mp4"},
]


def current_season():
    """The season it is now (by the server's clock), if its video is here: {name, emoji or image,
    video}, sent to each page in "welcome". None: no season (or no video for it)."""
    month = time.localtime().tm_mon
    for season in SEASONS:
        if month in season["months"] and (SEASONAL_DIR / season["video"]).is_file():
            return {
                "name": season["name"], "emoji": season.get("emoji"), "image": season.get("image"),
                "video": "/seasonal/" + season["video"],
            }
    return None


@app.get("/seasonal/{name}")
async def seasonal_video(name: str, request: Request):
    """A season's video, for people logged in. Only the file names in SEASONS, so nothing else in
    the folder (or outside it: "../.env") can ever be asked for. FileResponse answers "Range"
    requests (a piece of the file), which is how a browser's video player skips ahead."""
    if current_user(request) is None or name not in {season["video"] for season in SEASONS}:
        raise HTTPException(404, "Not found.")
    path = SEASONAL_DIR / name
    if not path.is_file():
        raise HTTPException(404, "Not found.")
    return FileResponse(path, media_type="video/mp4", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/favicon.ico")
async def favicon():
    # The icon in the browser tab. Browsers ask for /favicon.ico by themselves, on every page.
    # (A copy of the desktop app's desktop/src-tauri/icons/icon.ico.)
    return FileResponse("static/favicon.ico", headers={"Cache-Control": "public, max-age=86400"})


# The phone app: the chat installed as a PWA. The manifest gives its name, icons and look
# (static/icons/ from tools/make_pwa_icons.py); the service worker has to be at the top level,
# /sw.js, to look after every page of the site. No login needed: nothing private in them.
@app.get("/manifest.json")
async def manifest():
    return FileResponse("static/manifest.json", media_type="application/manifest+json",
                        headers={"Cache-Control": "no-cache"})


@app.get("/sw.js")
async def service_worker():
    return FileResponse("static/sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


def page_version():
    """A fingerprint of the chat page's files: a hash (SHA-256) of all of them together. Change
    one letter in any of them and it comes out completely different. Each page gets it in its
    "welcome"; after a deploy that changed the page, the pages that reconnect see a new one and
    reload themselves (core.js, reloadIfOutdated). Changes to this file alone don't count."""
    files = [Path("static/index.html"), Path("static/voice-gate.js"), Path("static/changelog.json"),
             *Path("static/js").glob("*.js"), *Path("static/css").glob("*.css")]
    digest = hashlib.sha256()
    for path in sorted(files):  # always in the same order, or the same files would give another hash
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:16]  # the first 16 characters are plenty to tell versions apart


PAGE_VERSION = page_version()  # worked out once, when the server starts


class FreshStaticFiles(StaticFiles):
    """Serves a folder's files, telling browsers (and Cloudflare) to check for a newer version every
    time they use one ("no-cache" means "check first", not "don't store"). Unchanged files cost a
    tiny "304 Not Modified" answer, and after an update everyone gets the new version straight away."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


class LastingStaticFiles(StaticFiles):
    """For a library whose version is in its address: those files never change, so browsers may keep
    them for a week without asking."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "public, max-age=604800"
        return response


# The chat page's styles and scripts (static/index.html loads them). Only these two folders:
# the rest of static/ is served by its own routes, some of them only when logged in.
app.mount("/static/css", FreshStaticFiles(directory="static/css"), name="css")
app.mount("/static/js", FreshStaticFiles(directory="static/js"), name="js")
app.mount("/landing", FreshStaticFiles(directory="static/landing"), name="landing")  # its pictures
app.mount("/icons", FreshStaticFiles(directory="static/icons"), name="icons")  # the phone app's (manifest.json)
app.mount("/static/seasonal", FreshStaticFiles(directory="static/seasonal"), name="seasonal")  # the seasons' pictures (the Santa hat)
# KaTeX, which draws the $maths$ in messages (messages.js), one fixed version from npm (see CLAUDE.md).
app.mount("/katex-0.18.9", LastingStaticFiles(directory="static/katex-0.18.9"), name="katex")
# Country flags for Windows, whose emoji font has none (chat.css's @font-face; see CLAUDE.md).
app.mount("/flags-0.1.10", LastingStaticFiles(directory="static/flags-0.1.10"), name="flags")


@app.get("/emoji.json")
async def emoji_list():
    # All emoji for the picker. They never change while the server runs, so browsers may keep it for a day.
    return FileResponse("static/emoji.json", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/changelog.json")
async def changelog():
    # Settings -> What's new. "no-cache" (check first), so a new entry shows up straight after a deploy.
    return FileResponse("static/changelog.json", headers={"Cache-Control": "no-cache"})


# LiveKit's browser library (voice), one fixed version from npm (see CLAUDE.md). A new version gets
# a new file name, so this address never changes its contents and browsers may keep it for a week.
LIVEKIT_CLIENT_FILE = "livekit-client-2.22.3.umd.js"


@app.get("/voice-gate.js")
async def voice_gate():
    # The noise gate for voice, which the page loads into the browser's audio engine (an AudioWorklet).
    # "no-cache" (check first), like the page's other files: without a Cache-Control, browsers guess
    # how long to keep it, and an app kept an old gate for days after it changed (2026-10-14).
    return FileResponse("static/voice-gate.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/rnnoise-0.4.1/{name}")
async def rnnoise(name: str):
    # RNNoise, the AI noise filter for "Noise suppression: On" (voice.js): an AudioWorklet and the
    # compiled filter it runs (WebAssembly), from npm's @sapphi-red/web-noise-suppressor (see CLAUDE.md).
    # Only these two files; the version is in the address, so browsers may keep them for a week.
    media_types = {"rnnoise-worklet.js": "text/javascript", "rnnoise_simd.wasm": "application/wasm"}
    if name not in media_types:
        raise HTTPException(404)
    return FileResponse("static/rnnoise-0.4.1/" + name, media_type=media_types[name],
                        headers={"Cache-Control": "public, max-age=604800"})


@app.get("/" + LIVEKIT_CLIENT_FILE)
async def livekit_client():
    return FileResponse("static/" + LIVEKIT_CLIENT_FILE, media_type="text/javascript",
                        headers={"Cache-Control": "public, max-age=604800"})


@app.get("/download")
async def download_page():
    # "Get the Windows app". No login needed.
    return FileResponse("static/download.html")


@app.get("/download/windows")
async def download_windows():
    # A link that never changes: sends the browser on to the newest installer, the one latest.json names.
    try:
        latest = json.loads((RELEASES_DIR / "latest.json").read_text())
        url = latest["platforms"]["windows-x86_64"]["url"]
    except (OSError, ValueError, KeyError):  # no latest.json yet, or not the shape we expect
        raise HTTPException(404, "No Windows version has been released yet.")
    return RedirectResponse(url, status_code=302)


@app.get("/download/android")
async def download_android():
    # The same for the phone app: the newest APK, the one android.json names (scripts\app-release.ps1).
    try:
        latest = json.loads((RELEASES_DIR / "android.json").read_text())
        apk = latest["apk"]
    except (OSError, ValueError, KeyError):
        raise HTTPException(404, "No Android version has been released yet.")
    return RedirectResponse(f"/releases/{quote(apk)}", status_code=302)


# ---------- The phone app's JavaScript updates (expo-updates) ----------
#
# Most changes to the phone app are JavaScript only: those reach the phones without a new APK. At each
# start the app (expo-updates) asks GET /app-update "is there a newer bundle for my version?", saying
# its "runtime version" (the app's version, which goes up with every APK, so new JavaScript only goes
# to apps whose native code it was made for). scripts\app-update.ps1 puts each update here:
#   releases/app-updates/<runtime version>/<time>.json   the manifest (tools/make_app_update.py)
#   releases/app-assets/<md5>.<ext>                       the bundle and pictures it names, by content
# We answer with the newest manifest for that version, its files' addresses filled in, or 204 (no
# update). The app downloads it in the background and uses it from its next start. Expo's protocol:
# docs.expo.dev/technical-specs/expo-updates-1. No login: it asks before anyone has logged in.

APP_UPDATES_DIR = RELEASES_DIR / "app-updates"
APP_ASSETS_DIR = RELEASES_DIR / "app-assets"
RUNTIME_VERSION = re.compile(r"\d+(\.\d+){1,3}")  # "1.0.3"
APP_ASSET = re.compile(r"[0-9a-f]{32}(\.[a-z0-9]{1,10})?")  # an MD5 and an extension: "5e8f...a1.png"
EXPO_HEADERS = {"expo-protocol-version": "1", "expo-sfv-version": "0", "cache-control": "private, max-age=0"}


@app.get("/app-update")
async def app_update(request: Request):
    runtime = request.headers.get("expo-runtime-version", "")
    if request.headers.get("expo-platform") != "android" or not RUNTIME_VERSION.fullmatch(runtime):
        raise HTTPException(400, "Not an update request we know.")
    folder = APP_UPDATES_DIR / runtime
    manifests = sorted(folder.glob("*.json")) if folder.is_dir() else []  # (named by time: the last is the newest)
    if not manifests:
        return Response(status_code=204, headers=EXPO_HEADERS)
    manifest = json.loads(manifests[-1].read_text())
    for asset in [manifest["launchAsset"], *manifest["assets"]]:
        asset["url"] = f"{PUBLIC_URL}/app-update/assets/{asset.pop('file')}"
    return Response(json.dumps(manifest), media_type="application/expo+json", headers=EXPO_HEADERS)


@app.get("/app-update/assets/{name}")
async def app_update_asset(name: str):
    # Named by their content, so a file here never changes: phones may keep it for good.
    if not APP_ASSET.fullmatch(name) or not (APP_ASSETS_DIR / name).is_file():
        raise HTTPException(404, "Not found.")
    return FileResponse(APP_ASSETS_DIR / name, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/releases/{name}")
async def release_file(name: str):
    # The desktop app's updates: latest.json (which version is newest) and the installers.
    # No login needed: the app checks for updates before anyone has logged in.
    # Only plain file names straight inside releases/ ("..\chat.db" and the like don't match).
    if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]*", name) or not (RELEASES_DIR / name).is_file():
        raise HTTPException(404)
    # latest.json changes with every release, so it must never come from a cache. An APK (the phone
    # app) says what it is, so phones offer to install it (Python doesn't always know .apk).
    media_type = "application/vnd.android.package-archive" if name.endswith(".apk") else None
    return FileResponse(RELEASES_DIR / name, media_type=media_type, headers={"Cache-Control": "no-cache"})


# ---------- Channels ----------
#
# The sidebar is one list, top to bottom, of channels and headings: a heading groups the channels
# under it, until the next heading. Admins change it in Settings → Channels; every change goes
# out to every open page at once ({"type": "channels"}), which redraws its sidebar.
#
# Who sees which channel: a channel is open (everyone sees it) or private (only people with one of
# its roles, in channel_roles). A role can be "limited": whoever has one sees only the private
# channels their roles open, no open channel and no Lounge (for parents, say: their DMs and a
# family channel). The owner sees everything, and bots (Chattus) every channel too, though never
# limited; other admins see open channels, and a private one only with one of its roles (in Settings too: only those who see a private channel can rename or delete it).
# Each person's pages get only the channels they may see, and can_join checks the same rule, so a page
# asking for another channel by hand gets nothing.

def channel_list(user_id=None):
    """The sidebar, top to bottom, as this person may see it (None: all of it):
    [{"key": "general", "name": "general", "heading": False, "private": False, "roles": []}, ...]
    "roles" (admins only, as roles can be hidden): the role ids that see a private channel. "members" (private
    channels): the ids of everyone who sees it (the owner and its roles' people), for the member list. A heading
    with nothing visible under it goes too."""
    rows = db.execute("SELECT key, name, heading, private FROM channels ORDER BY position").fetchall()
    roles_of = {}
    for channel, role_id in db.execute("SELECT channel, role_id FROM channel_roles"):
        roles_of.setdefault(channel, []).append(role_id)
    everywhere = {person for (person,) in db.execute("SELECT id FROM users WHERE is_owner = 1 OR is_bot = 1")}  # (in every channel)
    holders = {}  # role id -> its people
    for holder, role_id in db.execute("SELECT user_id, role_id FROM user_roles"):
        holders.setdefault(role_id, set()).add(holder)
    items = []
    for key, name, heading, private in rows:
        item = {"key": key, "name": name, "heading": bool(heading), "private": bool(private), "roles": roles_of.get(key, [])}
        if private:
            item["members"] = sorted(everywhere.union(*(holders.get(r, set()) for r in item["roles"])))
        items.append(item)
    if user_id is None or is_owner(user_id) or is_bot(user_id):
        return items if user_id is None or is_admin(user_id) else [{k: v for k, v in item.items() if k != "roles"} for item in items]
    mine, limited = role_ids_of(user_id), is_limited(user_id)
    shown = []
    for item in items:
        if item["heading"]:
            # Kept for now; dropped below if no channel of its own made it.
            if shown and shown[-1]["heading"]:
                shown.pop()
            shown.append(item)
        elif sees_channel(item["private"], item["roles"], mine, limited):
            shown.append(item)
    if shown and shown[-1]["heading"]:
        shown.pop()
    if is_admin(user_id):
        return shown
    return [{k: v for k, v in item.items() if k != "roles"} for item in shown]  # (the role ids: admins only)


def role_ids_of(user_id):
    return {role_id for (role_id,) in db.execute("SELECT role_id FROM user_roles WHERE user_id = ?", (user_id,))}


def is_limited(user_id):
    """Does this person have a limited role (only their private channels, no Lounge)? Never admins or bots."""
    if is_admin(user_id) or is_bot(user_id):
        return False
    row = db.execute("SELECT 1 FROM user_roles JOIN roles ON roles.id = user_roles.role_id"
                     " WHERE user_roles.user_id = ? AND roles.limited = 1", (user_id,)).fetchone()
    return row is not None


def sees_channel(private, channel_roles, my_roles, limited):
    """The rule (not for the owner, who sees all): a private channel needs one of its roles; an open one
    is for everyone not limited (admins never are)."""
    if private:
        return any(role_id in my_roles for role_id in channel_roles)
    return not limited


def may_see_channel(key, user_id):
    """May this person see this channel (which exists; see is_channel)?"""
    if is_owner(user_id) or is_bot(user_id):
        return True
    private = db.execute("SELECT private FROM channels WHERE key = ?", (key,)).fetchone()[0]
    roles = [role_id for (role_id,) in db.execute("SELECT role_id FROM channel_roles WHERE channel = ?", (key,))]
    return sees_channel(bool(private), roles, role_ids_of(user_id), is_limited(user_id))


def may_use_lounge(user_id):
    return not is_limited(user_id)


def is_channel(key):
    """Is this a channel that exists? (Headings aren't: nobody can join one.)"""
    if not isinstance(key, str):
        return False  # (the page could send anything as a channel, a list say)
    return db.execute("SELECT 1 FROM channels WHERE key = ? AND heading = 0", (key,)).fetchone() is not None


def channel_name(key):
    """A channel's name, for notifications ("kari in #memes"). Its key if it's gone."""
    row = db.execute("SELECT name FROM channels WHERE key = ?", (key,)).fetchone()
    return row[0] if row else key


def channels_message(user_id):
    """{"type": "channels", "channels": [...], "lounge": True}: their sidebar, and whether it has the Lounge."""
    return {"type": "channels", "channels": channel_list(user_id), "lounge": may_use_lounge(user_id)}


async def announce_channels():
    """After any change to the channels, roles or who has which: each page gets its own list. A page
    in a channel it may no longer see stops getting its messages (and moves to the first channel when
    it hears), and someone who lost the Lounge is taken out of it."""
    lounge_changed = False
    for websocket, client in list(clients.items()):
        user_id = client["user_id"]
        if is_channel(client["channel"]) and not may_see_channel(client["channel"], user_id):
            client["channel"] = None
        if client["voice"] in VOICE_ROOMS and not may_use_lounge(user_id):
            client["voice"] = None
            lounge_changed = True
            asyncio.create_task(asyncio.to_thread(remove_from_voice, "lounge", user_id))
        await send(websocket, channels_message(user_id))
    if lounge_changed:
        await announce_voice_members()


def clean_channel_name(name):
    """A name as typed, tidied: spaces at the ends and line breaks gone, runs of spaces made one."""
    name = " ".join(name.split())
    if not name:
        raise HTTPException(400, "Give it a name.")
    if len(name) > MAX_CHANNEL_NAME:
        raise HTTPException(400, f"That's a bit long: at most {MAX_CHANNEL_NAME} characters.")
    return name


def managed_channel(admin_id, key):
    """Like existing_channel, for an admin changing it: one they can't see (private) is a 404 to them too."""
    if key not in [item["key"] for item in channel_list(admin_id)]:
        raise HTTPException(404, "That channel doesn't exist (any more).")
    return existing_channel(key)


def existing_channel(key):
    """(is it a heading?) for a channel or heading that exists, or a 404."""
    row = db.execute("SELECT heading FROM channels WHERE key = ?", (key,)).fetchone()
    if row is None:
        raise HTTPException(404, "That channel doesn't exist (any more).")
    return bool(row[0])


@app.get("/channels")
async def channels(request: Request):
    """The sidebar's channels, as this person may see them (for the page's first draw)."""
    user_id = logged_in_user(request)[0]
    return channel_list(user_id)


class NewChannel(BaseModel):
    name: str
    heading: bool = False  # True: a heading instead of a channel


@app.post("/channels")
async def create_channel(request: Request, data: NewChannel):
    """A new channel or heading, at the bottom of the list (admins only)."""
    logged_in_admin(request)
    name = clean_channel_name(data.name)
    if db.execute("SELECT COUNT(*) FROM channels").fetchone()[0] >= MAX_CHANNELS:
        raise HTTPException(400, f"That's the most there can be ({MAX_CHANNELS}).")
    # A key that's never been used: "c:" (or "h:" for a heading) and 8 random hex digits. Not the
    # name, which can change, and never clashing with "dm:3:7", "voice:..." or the page's "friends".
    key = ("h:" if data.heading else "c:") + secrets.token_hex(4)
    with db:
        db.execute(
            "INSERT INTO channels (key, name, position, heading) "
            "VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM channels), ?)",
            (key, name, int(data.heading)),
        )
    await announce_channels()
    return {"key": key}


class ChannelRename(BaseModel):
    name: str


@app.post("/channels/{key}/rename")
async def rename_channel(request: Request, key: str, data: ChannelRename):
    """A new name for a channel or heading (admins only). Its messages keep pointing to its key."""
    managed_channel(logged_in_admin(request), key)
    name = clean_channel_name(data.name)
    with db:
        db.execute("UPDATE channels SET name = ? WHERE key = ?", (name, key))
    await announce_channels()
    return {"ok": True}


class ChannelAccess(BaseModel):
    private: bool          # False: everyone (not limited) sees it
    roles: list[int] = []  # a private one: the roles that see it (none: only admins)


@app.post("/channels/{key}/access")
async def set_channel_access(request: Request, key: str, data: ChannelAccess):
    """Who can see a channel (admins only): everyone, or only some roles."""
    if managed_channel(logged_in_admin(request), key):
        raise HTTPException(400, "Headings can't be private, only channels.")
    existing = {role_id for (role_id,) in db.execute("SELECT id FROM roles")}
    roles = set(data.roles) if data.private else set()
    if not roles <= existing:  # (<= on sets: "is a subset of")
        raise HTTPException(409, "The roles changed meanwhile. Try again.")
    with db:
        db.execute("UPDATE channels SET private = ? WHERE key = ?", (int(data.private), key))
        db.execute("DELETE FROM channel_roles WHERE channel = ?", (key,))
        db.executemany("INSERT INTO channel_roles (channel, role_id) VALUES (?, ?)", [(key, role_id) for role_id in roles])
    await announce_channels()
    return {"ok": True}


class ChannelOrder(BaseModel):
    keys: list[str]  # every channel and heading, in their new order


@app.post("/channels/order")
async def reorder_channels(request: Request, data: ChannelOrder):
    """Put the channels and headings in a new order (admins only). The page sends the whole list,
    so it must have exactly the keys they see: no more, no fewer, none twice. (An admin who can't see a
    private channel moves only the others: theirs take the places those had, the private one keeps its own.)"""
    admin_id = logged_in_admin(request)
    seen = [item["key"] for item in channel_list(admin_id)]
    if sorted(data.keys) != sorted(seen):
        raise HTTPException(409, "The channels changed meanwhile. Try again.")
    everything = [key for (key,) in db.execute("SELECT key FROM channels ORDER BY position")]
    new_order = iter(data.keys)
    order = [next(new_order) if key in seen else key for key in everything]
    with db:
        # enumerate gives each key its place: (0, "general"), (1, "memes"), ...
        db.executemany("UPDATE channels SET position = ? WHERE key = ?",
                       [(position, key) for position, key in enumerate(order)])
    await announce_channels()
    return {"ok": True}


@app.post("/channels/{key}/delete")
async def delete_channel(request: Request, key: str):
    """Delete a heading, or a channel with every message in it (admins only). There's no undo,
    except a backup, so the page asks first."""
    if not managed_channel(logged_in_admin(request), key):
        if db.execute("SELECT COUNT(*) FROM channels WHERE heading = 0").fetchone()[0] <= 1:
            raise HTTPException(400, "That's the last channel: there must always be one.")
    with db:
        db.execute("DELETE FROM channels WHERE key = ?", (key,))
        db.execute("DELETE FROM channel_roles WHERE channel = ?", (key,))
    delete_messages_in(key)
    for client in clients.values():
        if client["channel"] == key:
            client["channel"] = None  # (their page moves to the first channel when it hears)
    await announce_channels()
    return {"ok": True}


def delete_messages_in(key):
    """Delete every message in a channel or group, with its reactions, mentions, previews and files,
    and everyone's read marker there. (For a deleted channel, and a group its last member left.)"""
    files = [file for (file,) in db.execute("SELECT id FROM attachments WHERE channel = ?", (key,))]
    previews = [image for (image,) in db.execute(
        "SELECT image FROM link_previews WHERE image IS NOT NULL"
        " AND message_id IN (SELECT id FROM messages WHERE channel = ?)", (key,))]
    # Everything that belongs to its messages, then the messages, in one transaction: all or nothing.
    with db:
        for table in ("reactions", "mentions", "link_previews"):
            db.execute(f"DELETE FROM {table} WHERE message_id IN (SELECT id FROM messages WHERE channel = ?)", (key,))
        db.execute("DELETE FROM messages WHERE channel = ?", (key,))
        db.execute("DELETE FROM attachments WHERE channel = ?", (key,))
        db.execute("DELETE FROM last_read WHERE channel = ?", (key,))
        db.execute("DELETE FROM chat_mutes WHERE channel = ?", (key,))
    # The files on disk, only once the database change has been saved (as for one message).
    for file in files:
        (UPLOAD_DIR / file).unlink(missing_ok=True)
    for image in previews:
        (PREVIEW_DIR / image).unlink(missing_ok=True)


# ---------- Roles ----------
#
# Admins make roles (a name and a colour) in Settings → Roles and give them to people. Someone's top
# role (the highest in the list) colours their name and gives them a section in the member list.
# Every change goes to every page: "roles" (the list) and "users" (who has which).

MAX_ROLES = 20
MAX_ROLE_NAME = 30


def roles_message(user_id):
    """{"type": "roles", "roles": [{"id": 1, "name": "Gamers", "colour": "#3ba55c", "limited": False, "hidden": False}, ...]},
    the top one first. "limited": its people only see the private channels their roles open (see "Channels").
    "hidden": only admins know it exists (no colour, member list section or profile tag): everyone else's
    pages never get it, nor see anyone have it (users_for)."""
    rows = db.execute("SELECT id, name, colour, limited, hidden FROM roles ORDER BY position").fetchall()
    admin = is_admin(user_id)
    return {"type": "roles", "roles": [
        {"id": role_id, "name": name, "colour": colour, "limited": bool(limited), "hidden": bool(hidden)}
        for role_id, name, colour, limited, hidden in rows if admin or not hidden
    ]}


def hidden_role_ids():
    return {role_id for (role_id,) in db.execute("SELECT id FROM roles WHERE hidden = 1")}


async def announce_roles():
    for websocket, client in list(clients.items()):
        await send(websocket, roles_message(client["user_id"]))
    await announce_users()
    await announce_channels()  # (who sees which channel can depend on the roles)


def clean_role(name, colour):
    """A role's name, tidied, and its colour, checked: or a 400."""
    name = " ".join(name.split())
    if not name:
        raise HTTPException(400, "Give it a name.")
    if len(name) > MAX_ROLE_NAME:
        raise HTTPException(400, f"That's a bit long: at most {MAX_ROLE_NAME} characters.")
    if not HEX_COLOUR.fullmatch(colour):
        raise HTTPException(400, "That's not a colour.")
    return name, colour.lower()


def existing_role(role_id):
    if db.execute("SELECT 1 FROM roles WHERE id = ?", (role_id,)).fetchone() is None:
        raise HTTPException(404, "That role doesn't exist (any more).")


class RoleData(BaseModel):
    name: str
    colour: str  # "#3ba55c"


@app.post("/roles")
async def create_role(request: Request, data: RoleData):
    """A new role, at the bottom of the list (admins only)."""
    logged_in_admin(request)
    name, colour = clean_role(data.name, data.colour)
    if db.execute("SELECT COUNT(*) FROM roles").fetchone()[0] >= MAX_ROLES:
        raise HTTPException(400, f"That's the most there can be ({MAX_ROLES}).")
    with db:
        db.execute("INSERT INTO roles (name, colour, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM roles))",
                   (name, colour))
    await announce_roles()
    return {"ok": True}


@app.post("/roles/{role_id}/edit")
async def edit_role(request: Request, role_id: int, data: RoleData):
    """A new name or colour for a role (admins only)."""
    logged_in_admin(request)
    existing_role(role_id)
    name, colour = clean_role(data.name, data.colour)
    with db:
        db.execute("UPDATE roles SET name = ?, colour = ? WHERE id = ?", (name, colour, role_id))
    await announce_roles()
    return {"ok": True}


class RoleOrder(BaseModel):
    ids: list[int]  # every role, in the new order


@app.post("/roles/order")
async def reorder_roles(request: Request, data: RoleOrder):
    """Put the roles in a new order (admins only): the whole list, like the channels."""
    logged_in_admin(request)
    existing = [role_id for (role_id,) in db.execute("SELECT id FROM roles")]
    if sorted(data.ids) != sorted(existing):
        raise HTTPException(409, "The roles changed meanwhile. Try again.")
    with db:
        db.executemany("UPDATE roles SET position = ? WHERE id = ?", [(position, role_id) for position, role_id in enumerate(data.ids)])
    await announce_roles()
    return {"ok": True}


@app.post("/roles/{role_id}/delete")
async def delete_role(request: Request, role_id: int):
    """Delete a role, and take it from everyone who had it (admins only)."""
    logged_in_admin(request)
    existing_role(role_id)
    with db:
        db.execute("DELETE FROM user_roles WHERE role_id = ?", (role_id,))
        # (A private channel that only this role saw stays private: then only the owner sees it.)
        db.execute("DELETE FROM channel_roles WHERE role_id = ?", (role_id,))
        db.execute("DELETE FROM roles WHERE id = ?", (role_id,))
    await announce_roles()
    return {"ok": True}


class RoleLimited(BaseModel):
    limited: bool


@app.post("/roles/{role_id}/limited")
async def set_role_limited(request: Request, role_id: int, data: RoleLimited):
    """Make a role limited (its people only see their private channels, no Lounge), or not (admins only)."""
    logged_in_admin(request)
    existing_role(role_id)
    with db:
        db.execute("UPDATE roles SET limited = ? WHERE id = ?", (int(data.limited), role_id))
    await announce_roles()
    return {"ok": True}


class RoleHidden(BaseModel):
    hidden: bool


@app.post("/roles/{role_id}/hidden")
async def set_role_hidden(request: Request, role_id: int, data: RoleHidden):
    """Hide a role from everyone but admins (no colour, section or tag; see roles_message), or show it (admins only)."""
    logged_in_admin(request)
    existing_role(role_id)
    with db:
        db.execute("UPDATE roles SET hidden = ? WHERE id = ?", (int(data.hidden), role_id))
    await announce_roles()
    return {"ok": True}


class RoleMember(BaseModel):
    user_id: int
    member: bool  # True: give them the role; False: take it away


@app.post("/roles/{role_id}/members")
async def set_role_member(request: Request, role_id: int, data: RoleMember):
    """Give someone a role, or take it from them (admins only)."""
    logged_in_admin(request)
    existing_role(role_id)
    if username_of(data.user_id) is None:
        raise HTTPException(404, "That person doesn't exist.")
    with db:
        if data.member:
            db.execute("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", (data.user_id, role_id))
        else:
            db.execute("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?", (data.user_id, role_id))
    await announce_users()
    await announce_channels()  # (their roles may open or close channels for them)
    return {"ok": True}


# ---------- Group DMs ----------
#
# Private chats for 3 to 10 people. Anyone can start one with their friends; any member can add
# more of their own friends and rename it; anyone can leave, and the last one out deletes it.
# The members don't have to be friends with each other (as in Discord). Calls: see "Calls in DMs
# and group DMs". Every bot is in every group too (add_bots_to_groups), answering @mentions, but
# bots don't count as people: not for the size, and the last *person* out deletes the group.
# Each member's pages get {"type": "groups"} with their groups at the start and after every change.

MAX_GROUP_SIZE = 10  # people in a group, its starter included (bots not counted)


def group_members(key):
    """A group's members' ids, bots included, in the order they joined."""
    rows = db.execute("SELECT user_id FROM group_members WHERE group_key = ? ORDER BY rowid", (key,))
    return [user_id for (user_id,) in rows]


def group_people(key):
    """A group's members without the bots."""
    return [user_id for user_id in group_members(key) if not is_bot(user_id)]


def is_group_member(key, user_id):
    if not isinstance(key, str) or not key.startswith("g:"):
        return False
    row = db.execute("SELECT 1 FROM group_members WHERE group_key = ? AND user_id = ?", (key, user_id)).fetchone()
    return row is not None


def group_title(key):
    """What a group is called in notifications: its name, or its people's names ("axel, kari, ola")."""
    row = db.execute("SELECT name FROM group_dms WHERE key = ?", (key,)).fetchone()
    if row and row[0]:
        return row[0]
    return ", ".join(username_of(user_id) for user_id in group_people(key))


def groups_message(user_id):
    """One person's groups, oldest first: {"type": "groups", "groups": [{"key", "name", "members"}, ...]}"""
    rows = db.execute(
        "SELECT key, name FROM group_dms JOIN group_members ON group_members.group_key = group_dms.key"
        " WHERE group_members.user_id = ? ORDER BY group_dms.created_at, group_dms.rowid",
        (user_id,),
    ).fetchall()
    return {"type": "groups", "groups": [
        {"key": key, "name": name, "members": group_members(key)} for key, name in rows
    ]}


async def announce_groups(user_ids):
    """Send these people their groups again (each their own list), after a change."""
    for user_id in set(user_ids):
        await send_to_user(user_id, groups_message(user_id))


def logged_in_member(request, key):
    """The logged-in user's id if they're in this group, or an error. A 404 also for groups that
    exist but aren't theirs: nobody can find out about other people's groups by trying keys."""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    if not is_group_member(key, user_id):
        raise HTTPException(404, "That group doesn't exist (any more).")
    return user_id


def new_group_members(user_id, wanted, already):
    """The people to add (sorted, without those already in it): each must be a friend of whoever adds
    them, and the group may not grow past MAX_GROUP_SIZE people. (Bots are in every group already.)"""
    new = sorted(set(wanted) - set(already))
    if any(other == user_id or not are_friends(user_id, other) or is_bot(other) for other in new):
        raise HTTPException(400, "You can only add your friends.")
    if len([member for member in already if not is_bot(member)]) + len(new) > MAX_GROUP_SIZE:
        raise HTTPException(400, f"A group has at most {MAX_GROUP_SIZE} people.")
    return new


def clean_group_name(name):
    """A group's name as typed, tidied like a channel's; empty means none (called after its members)."""
    name = " ".join(name.split())
    if len(name) > MAX_CHANNEL_NAME:
        raise HTTPException(400, f"That's a bit long: at most {MAX_CHANNEL_NAME} characters.")
    return name or None


class NewGroup(BaseModel):
    user_ids: list[int]  # the friends to start it with (not yourself)
    name: str = ""


@app.post("/groups")
async def create_group(request: Request, data: NewGroup):
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    others = new_group_members(user_id, data.user_ids, [user_id])
    if len(others) < 2:
        raise HTTPException(400, "Pick at least two friends (for one, send them a DM).")
    name = clean_group_name(data.name)
    key = "g:" + secrets.token_hex(4)  # random, like a new channel's key
    bots = [bot for (bot,) in db.execute("SELECT id FROM users WHERE is_bot = 1")]  # in every group
    with db:
        db.execute("INSERT INTO group_dms (key, name) VALUES (?, ?)", (key, name))
        db.executemany("INSERT INTO group_members (group_key, user_id) VALUES (?, ?)",
                       [(key, member) for member in [user_id, *others, *bots]])  # (*: the list's items, one by one)
    await announce_groups([user_id, *others, *bots])
    return {"key": key}


class GroupName(BaseModel):
    name: str  # "" = no name (called after its members)


@app.post("/groups/{key}/rename")
async def rename_group(request: Request, key: str, data: GroupName):
    logged_in_member(request, key)
    with db:
        db.execute("UPDATE group_dms SET name = ? WHERE key = ?", (clean_group_name(data.name), key))
    await announce_groups(group_members(key))
    return {"ok": True}


class GroupAdd(BaseModel):
    user_ids: list[int]


@app.post("/groups/{key}/add")
async def add_to_group(request: Request, key: str, data: GroupAdd):
    """Add some of your friends to a group you're in. They see its whole history, as in Discord."""
    user_id = logged_in_member(request, key)
    members = group_members(key)
    new = new_group_members(user_id, data.user_ids, members)
    if not new:
        raise HTTPException(400, "Pick someone to add.")
    with db:
        db.executemany("INSERT INTO group_members (group_key, user_id) VALUES (?, ?)", [(key, other) for other in new])
    await announce_groups(members + new)
    return {"ok": True}


@app.post("/groups/{key}/leave")
async def leave_group(request: Request, key: str):
    user_id = logged_in_member(request, key)
    with db:
        db.execute("DELETE FROM group_members WHERE group_key = ? AND user_id = ?", (key, user_id))
        db.execute("DELETE FROM last_read WHERE user_id = ? AND channel = ?", (user_id, key))
        db.execute("DELETE FROM chat_mutes WHERE user_id = ? AND channel = ?", (user_id, key))
    remaining = group_members(key)
    if not group_people(key):  # the last person out (only bots left): nobody will see it again, so it goes
        with db:
            db.execute("DELETE FROM group_members WHERE group_key = ?", (key,))
            db.execute("DELETE FROM group_dms WHERE key = ?", (key,))
        delete_messages_in(key)
    for client in clients.values():
        if client["user_id"] == user_id and client["channel"] == key:
            client["channel"] = None  # (their page moves to the first channel when it hears)
    await announce_groups([user_id, *remaining])
    return {"ok": True}


# ---------- Chat ----------

def online_user_ids():
    """The ids of everyone with at least one open tab. A set, so two tabs count once."""
    return {client["user_id"] for client in clients.values()}


# ---------- Statuses ----------
#
# Each person chooses Online, Idle, Do Not Disturb or Invisible (users.presence; the popup at the bottom
# left). What the others see: "offline" without an open tab, and when Invisible; "dnd" and "idle" as
# chosen; and Online turns "idle" by itself when none of their pages has been looked at for IDLE_AFTER
# (each page says when it's in sight: "looking"). Do Not Disturb also stops every notification.

PRESENCES = ["online", "idle", "dnd", "invisible"]
IDLE_AFTER = 10 * 60  # seconds without looking at the chat anywhere


def shown_presence(user_id, chosen, bot=False):
    """What the others see of this person: "online", "idle", "dnd" or "offline"."""
    tabs = [client for client in clients.values() if client["user_id"] == user_id]
    if not tabs or chosen == "invisible":
        return "offline"
    if chosen in ("idle", "dnd"):
        return chosen
    now = time.time()
    # Every page out of sight for a while (away_since: when it stopped being looked at). Not bots:
    # they never "look", and are always there.
    if not bot and all(client["away_since"] is not None and now - client["away_since"] >= IDLE_AFTER for client in tabs):
        return "idle"
    return "online"


def on_phone_only(user_id, presence):
    """Is this person only here on a phone (every open page of theirs says it's one)? Then the others
    see a little phone instead of their dot. Not when they show as offline (Invisible gives nothing away)."""
    tabs = [client for client in clients.values() if client["user_id"] == user_id]
    return presence != "offline" and bool(tabs) and all(client["mobile"] for client in tabs)


# What someone is doing (the Windows app sees it: desktop/src-tauri/src/activity.rs; the page sends it
# with {"type": "activity"}). Kept only in memory, with the connection that sent it: when that page
# closes, it's gone. Never shown while they show as offline (Invisible).
ACTIVITY_KINDS = ("playing", "listening", "using")


def clean_activity(value):
    """An activity from a page, checked: {"kind": "listening", "name": "Song", "details": "Artist"}
    ("details" only if there is one), or None for nothing (or anything odd)."""
    if not isinstance(value, dict) or value.get("kind") not in ACTIVITY_KINDS:
        return None
    name, details = value.get("name"), value.get("details")
    if not isinstance(name, str) or not name.strip():
        return None
    activity = {"kind": value["kind"], "name": name.strip()[:100]}
    if isinstance(details, str) and details.strip():
        activity["details"] = details.strip()[:100]
    return activity


def activity_of(user_id, presence):
    """What the others see this person doing (with "since", when it started), or None."""
    if presence == "offline":
        return None
    for client in clients.values():
        if client["user_id"] == user_id and client["activity"] is not None:
            return client["activity"]
    return None


def presence_of(user_id):
    """The status this person chose (for their own pages, and for notifications)."""
    row = db.execute("SELECT presence FROM users WHERE id = ?", (user_id,)).fetchone()
    return row[0] if row else "online"


def users_message():
    """Every account with its profile and what the others see of their status:
    [{"id": 3, "name": "axel", "presence": "idle", "online": True, "avatar": "Xk9...webp", "status": "...", ...}]
    ("status" is the line people write about themselves, "playing Minecraft"; "online" is "not offline".)"""
    rows = db.execute(
        "SELECT id, username, avatar_id, banner_id, status, bio, is_admin, is_bot, presence, is_owner FROM users"
        " WHERE email_verified = 1"  # (a new account joins the lists once its email is verified)
        f" AND NOT {BANNED_NOW}"     # (and a banned one leaves them)
        " ORDER BY username COLLATE NOCASE"
    ).fetchall()
    # Everyone's roles, in one query: the top one first (the list's order), so the page takes roles[0].
    roles_of = {}
    for user_id, role_id in db.execute(
        "SELECT user_roles.user_id, user_roles.role_id FROM user_roles"
        " JOIN roles ON roles.id = user_roles.role_id ORDER BY roles.position"
    ):
        roles_of.setdefault(user_id, []).append(role_id)
    # Who has a limited role (not admins): left out of open channels' member lists (see "Channels").
    limited = {user_id for (user_id,) in db.execute(
        "SELECT user_roles.user_id FROM user_roles JOIN roles ON roles.id = user_roles.role_id"
        " JOIN users ON users.id = user_roles.user_id WHERE roles.limited = 1 AND users.is_admin = 0 AND users.is_bot = 0"
    )}
    users = []
    for user_id, name, avatar, banner, status, bio, admin, bot, chosen, owner in rows:
        presence = shown_presence(user_id, chosen, bool(bot))
        users.append({
            "id": user_id, "name": name, "presence": presence, "online": presence != "offline",
            "mobile": on_phone_only(user_id, presence),  # only on a phone: a little phone for a dot
            "activity": activity_of(user_id, presence),  # playing, listening to, using (or None)
            "avatar": avatar, "banner": banner, "status": status, "bio": bio, "admin": bool(admin),
            "bot": bool(bot),  # the AI bot: the page offers it in DMs' @ suggestions too
            "owner": bool(owner),  # the server's owner (see "Bans and admins")
            "roles": roles_of.get(user_id, []),  # role ids, the top one first (see "roles"; hidden: users_for)
            "limited": user_id in limited,  # sees only their private channels (see "Channels")
        })
    return {"type": "users", "users": users}


def users_for(user_id, message):
    """The users message as this person may see it: hidden roles (see "Roles") left out, but for admins."""
    if is_admin(user_id):
        return message
    hidden = hidden_role_ids()
    if not hidden:
        return message
    return {**message, "users": [{**user, "roles": [r for r in user["roles"] if r not in hidden]} for user in message["users"]]}


async def announce_users(message=None):
    """Send every page the users list (each its own, see users_for)."""
    message = message or users_message()
    for websocket, client in list(clients.items()):
        await send(websocket, users_for(client["user_id"], message))


shown_presences = {}  # what everyone was last told: {user_id: ("idle", False, None), ...} (see announce_presences)


async def announce_presences():
    """Send everyone the users list again, if anyone's status (phone, activity) looks different from last time."""
    global shown_presences  # (this function gives the name a new dict, so it must say it means the global one)
    message = users_message()
    now = {user["id"]: (user["presence"], user["mobile"], user["activity"]) for user in message["users"]}
    if now != shown_presences:
        shown_presences = now
        await announce_users(message)


async def watch_presences():
    """Going idle isn't an event, it's time passing: so look every 30 seconds. Runs as long as the server."""
    while True:
        await asyncio.sleep(30)
        try:
            await announce_presences()
        except Exception as error:  # (one bad round must not stop it for good)
            print(f"Couldn't update statuses: {error!r}", flush=True)


presence_watcher = None  # the task above, started by the first connection (it needs the running loop)


# ---------- Muting ----------
#
# Anyone can mute a chat (channel, DM or group) for themselves: no unread dot (the page), and no
# notifications, red counts or pushes, except when they're named in a message, or an admin wrote it
# (save_mentions). Admins can't be muted: a DM with an admin can't be muted at all.

def mutes_message(user_id):
    """Someone's muted chats, for their pages: {"type": "mutes", "channels": ["memes", "dm:3:7"]}."""
    rows = db.execute("SELECT channel FROM chat_mutes WHERE user_id = ?", (user_id,))
    return {"type": "mutes", "channels": [channel for (channel,) in rows]}


def can_mute(channel, user_id):
    """May this person mute this chat? Any they can see, except a DM with an admin."""
    if not can_join(channel, user_id):
        return False
    people = dm_people(channel)
    return people is None or not any(is_admin(person) for person in people if person != user_id)


BOT_INVITE_TIME = "-1 hour"  # how long a mention lets a bot into a DM (SQLite's way of writing it)


def dm_people(channel):
    """The two user ids of a DM's name ("dm:3:7" -> (3, 7)), or None if it isn't exactly the
    shape the page builds (smallest first, no leading zeros)."""
    if not isinstance(channel, str) or not channel.startswith("dm:"):
        return None
    parts = channel.split(":")[1:]  # "dm:3:7" -> ["3", "7"]
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        return None
    first, second = int(parts[0]), int(parts[1])
    if channel != f"dm:{first}:{second}" or first >= second:
        return None
    return first, second


def is_dm_member(channel, user_id):
    """Is this one of the two people of this DM, and are they still friends? (Calls only ever
    use this: a bot invited to read a DM is never let into its calls.)"""
    people = dm_people(channel)
    if people is None or user_id not in people:
        return False
    other = people[1] if user_id == people[0] else people[0]
    return are_friends(user_id, other)  # (a friendship also means the other person exists)


def bot_invited(channel, user_id):
    """A bot may read and write in someone else's DM for an hour after one of them mentions it
    there (that's how you invite it). Only a bot (users.is_bot), and only while they're friends."""
    people = dm_people(channel)
    if people is None or not is_bot(user_id) or not are_friends(*people):
        return False
    row = db.execute(
        """
        SELECT 1 FROM mentions JOIN messages ON messages.id = mentions.message_id
        WHERE mentions.user_id = ? AND messages.channel = ? AND messages.sent_at > datetime('now', ?)
        LIMIT 1
        """,
        (user_id, channel, BOT_INVITE_TIME),
    ).fetchone()
    return row is not None


def can_join(channel, user_id):
    """May this user read and write in this channel? Normal channels: anyone logged in.
    DMs ("dm:3:7", the two user ids, smallest first): the two people in it, while they're
    friends; and the AI bot for an hour after one of them mentioned it there."""
    if is_channel(channel):
        return may_see_channel(channel, user_id)  # (a private channel: only its roles; see "Channels")
    if is_dm_member(channel, user_id) or is_group_member(channel, user_id):
        return True
    people = dm_people(channel)  # (a member who's no longer friends stays out, even a bot)
    return people is not None and user_id not in people and bot_invited(channel, user_id)


# ---------- Voice ----------

VOICE_ROOMS = ["lounge"]  # voice channels anyone logged in can join (DM calls use the DM's name)
VOICE_TOKEN_LIFETIME = 10 * 60  # seconds: only needed to get in; LiveKit renews it after that


def base64url(data):
    """Bytes as base64url text: letters, digits, - and _ (safe in a URL), without the = padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(payload):
    """A JSON Web Token: header.payload.signature, each part base64url. The signature is an HMAC
    (a fingerprint that needs the secret to make) of the first two parts, so anyone can read the
    token, but nobody without LIVEKIT_API_SECRET can change it or make a new one."""
    header = {"alg": "HS256", "typ": "JWT"}  # HS256: HMAC with SHA-256
    signed_part = base64url(json.dumps(header).encode()) + "." + base64url(json.dumps(payload).encode())
    signature = hmac.new(LIVEKIT_API_SECRET.encode(), signed_part.encode(), hashlib.sha256).digest()
    return signed_part + "." + base64url(signature)


def make_voice_token(user_id, name, room):
    """A ticket into one LiveKit room for one person, valid for VOICE_TOKEN_LIFETIME seconds."""
    now = int(time.time())
    return make_jwt({
        "iss": LIVEKIT_API_KEY,  # issued by: tells LiveKit which secret to check the signature with
        "sub": str(user_id),     # who it's for: their "identity" in the room
        "name": name,            # the name the others see
        "nbf": now,              # not valid before
        "exp": now + VOICE_TOKEN_LIFETIME,
        # What they may do there (LiveKit calls it "video", but it covers audio too): join this
        # room, send their own audio and hear the others.
        "video": {"room": room, "roomJoin": True, "canPublish": True, "canSubscribe": True},
    })


def members_in(room):
    """Who's in a voice room (in the order their tabs connected), and whether they're muted or
    deafened (hear nobody): [{"id": 3, "muted": False, "deafened": False}, ...]. Someone in it from
    two tabs is listed once (muted or deafened only if they are in all of them)."""
    members = {}  # user id -> their entry (a dict keeps the order things were added: who came first)
    for client in clients.values():
        if client["voice"] == room:
            member = members.setdefault(client["user_id"], {"id": client["user_id"], "muted": True, "deafened": True})
            member["muted"] = member["muted"] and client["muted"]
            member["deafened"] = member["deafened"] and client["deafened"]
    return list(members.values())


def voice_members_message(user_id):
    """Who's in each voice channel: {"type": "voice_members", "rooms": {"lounge": [...members_in]}}.
    Nothing for someone limited (see "Channels"), who has no Lounge."""
    rooms = {room: members_in(room) for room in VOICE_ROOMS} if may_use_lounge(user_id) else {}
    return {"type": "voice_members", "rooms": rooms}


async def announce_voice_members():
    for websocket, client in list(clients.items()):
        await send(websocket, voice_members_message(client["user_id"]))


def may_join_voice(room, user_id):
    """The Lounge: anyone not limited. A DM's or group's call: only its people (see is_call_member)."""
    if room in VOICE_ROOMS:
        return may_use_lounge(user_id)
    return is_call_member(room, user_id)


# ---------- Calls in DMs and group DMs ----------
#
# A call is a LiveKit room named after the DM or group ("dm:3:7", "g:5f3a9b21"). Our server only
# does the ringing, over the chat's WebSocket:
#   caller's page:     {"type": "call", "channel": "dm:3:7"}                 (and joins the room)
#   the others' tabs:  {"type": "call", "channel": ..., "from": 3, "name": "axel"}  (they ring)
#   one who answers:   {"type": "call_answer", "channel": ..., "accept": true}      (and joins)
#   their tabs (and the caller's, the first time): {"type": "call_answered", "channel": ...}  (the
#                      ringing, or the caller's "Calling…", stops)
#   everyone:          {"type": "call_ended", "channel": ..., "reason": "no_answer"}
# In a DM, declining ends the call. In a group, it only stops your own ringing: the others ring
# until they answer or 30 seconds pass, and the call goes on as long as anyone is in it.
# When it's over, a call note goes into the chat: "📞 Call · 12 min", or "📞 Missed call".

RING_SECONDS = 30

# The calls ringing or going on, by DM or group:
# {"dm:3:7": {"caller": 3, "ringing": {7} (those still being rung), "started": None until someone
#             answered (then the time), "caller_joined": True once the caller's page is in the room,
#             "ring": the 30 s timer}}
calls = {}


def is_private_room(room):
    """A DM's or group's call (not Lounge)?"""
    return isinstance(room, str) and (room.startswith("dm:") or room.startswith("g:"))


def is_call_member(room, user_id):
    """May this person be in this DM's or group's call? The two friends of a DM, or a group's members.
    Never a bot: not one invited to read a DM, nor one added to a group."""
    return is_dm_member(room, user_id) or (is_group_member(room, user_id) and not is_bot(user_id))


def call_people(channel):
    """Everyone a DM's or group's call belongs to: who hears about it."""
    people = dm_people(channel)
    return list(people) if people else group_members(channel)


def dm_call_message(channel):
    """Who's in a DM's or group's call right now, for the call banner and "Join call":
    {"type": "dm_call", "channel": "dm:3:7", "members": [{"id": 7, "muted": false, "deafened": false}]}."""
    return {"type": "dm_call", "channel": channel, "members": members_in(channel)}


async def announce_dm_call(channel):
    """Tell the people of this DM or group (and nobody else) who's in its call."""
    message = dm_call_message(channel)
    for person in call_people(channel):
        await send_to_user(person, message)


def voice_user_ids(room):
    """Everyone whose page says it's in this voice room."""
    return {client["user_id"] for client in clients.values() if client["voice"] == room}


def call_message(channel):
    call = calls[channel]
    return {"type": "call", "channel": channel, "from": call["caller"], "name": username_of(call["caller"])}


async def start_call(channel, caller):
    if not is_call_member(channel, caller):
        return  # only in your own DMs with friends, and your groups
    call = calls.get(channel)
    if call is not None:
        if caller in call["ringing"]:
            await answer_call(channel, caller, True)  # it rang for them while they called: that's an answer
        return  # already ringing or going on: the page just joins the room
    # Ring everyone else who could join (in a group: not its bots).
    others = {person for person in call_people(channel) if person != caller and is_call_member(channel, person)}
    others -= blockers_of(caller)  # (in a group: who blocked the caller isn't rung)
    calls[channel] = {
        "caller": caller, "ringing": others, "started": None, "caller_joined": False,
        # A background task that ends the call if nobody answers in time. (asyncio runs it while
        # we wait for other things, like the next WebSocket message.)
        "ring": asyncio.create_task(ring_timeout(channel)),
    }
    for person in others:
        await send_to_user(person, call_message(channel))  # every tab and device they have open rings
    # ...and their phones: "high" urgency (wake it now), and gone after the 30 s it rings.
    if channel.startswith("dm:"):
        title, body = username_of(caller), "📞 Calling you"
    else:
        title, body = group_title(channel), f"📞 {username_of(caller)} is calling"
    avatar = db.execute("SELECT avatar_id FROM users WHERE id = ?", (caller,)).fetchone()[0]
    push_in_background(list(others), {
        "title": title, "body": body, "channel": channel, "call": True, "icon": "/icons/icon-192.png",
        # For the phone app's incoming call (its picture is the caller's):
        "kind": "call", "sender": username_of(caller), "sender_id": caller,
        "avatar": f"/avatars/{avatar}" if avatar else None,
    }, ttl=RING_SECONDS, urgency="high")


def stop_ringing(people, channel):
    """Take a ringing call off these people's phones: answered on another device, declined, or over.
    (Their pages stop by themselves, from "call_answered" or "call_ended".)"""
    if people:
        push_in_background(list(people), {"kind": "call_end", "channel": channel}, ttl=RING_SECONDS, always=True)


async def ring_timeout(channel):
    await asyncio.sleep(RING_SECONDS)
    call = calls.get(channel)
    if call is None:
        return
    if call["started"] is None:
        await end_call(channel, "no_answer")
        return
    # A group call that's going on: those who never answered stop ringing (they can still join).
    stop_ringing(call["ringing"], channel)
    for person in list(call["ringing"]):
        call["ringing"].discard(person)
        await send_to_user(person, {"type": "call_answered", "channel": channel})


async def answer_call(channel, user_id, accept):
    call = calls.get(channel)
    if call is None or user_id not in call["ringing"]:
        return  # not ringing, or not for them
    if not accept and channel.startswith("dm:"):
        await end_call(channel, "declined")  # in a DM, a no ends it
        return
    call["ringing"].discard(user_id)
    await send_to_user(user_id, {"type": "call_answered", "channel": channel})  # all their tabs stop ringing
    stop_ringing([user_id], channel)  # ...and their phones
    if not accept:
        if not call["ringing"] and call["started"] is None:
            await end_call(channel, "declined")  # everyone in the group said no
        return
    if call["started"] is None:  # the first to answer: the call has started
        call["started"] = time.time()
        await send_to_user(call["caller"], {"type": "call_answered", "channel": channel})
    if not call["ringing"]:
        call["ring"].cancel()  # nobody left to ring


async def end_call(channel, reason):
    """reason: "no_answer", "declined", "cancelled" (hung up before an answer) or "ended"."""
    call = calls.pop(channel, None)
    if call is None:
        return
    if call["ring"] is not asyncio.current_task():  # (cancelling ourselves would stop us right here)
        call["ring"].cancel()
    stop_ringing(call["ringing"], channel)  # (those still ringing: their phones too)
    for person in call_people(channel):
        await send_to_user(person, {"type": "call_ended", "channel": channel, "reason": reason})

    if call["started"] is None:
        text = "📞 Declined call" if reason == "declined" else "📞 Missed call"
    else:
        minutes = round((time.time() - call["started"]) / 60)
        text = f"📞 Call · {minutes} min" if minutes >= 1 else "📞 Call · under a minute"
    # The note comes from the caller, and is saved and sent like any message (so it gets unread
    # dots and stays in the history).
    message_id, sent_at = save_message(channel, call["caller"], text, None, None, kind="call")
    message = {
        "type": "message", "channel": channel, "id": message_id, "sent_at": sent_at,
        "user_id": call["caller"], "name": username_of(call["caller"]), "text": text, "file": None,
        "reply": None, "reactions": [], "edited_at": None, "kind": "call", "pinned": False,
    }
    await send_to_channel(channel, message)
    await announce_new_message(channel)


async def check_call(channel):
    """After someone's voice room changed: has this DM's or group's call been called off, or ended?"""
    call = calls.get(channel)
    if call is None:
        return
    in_room = voice_user_ids(channel)
    if call["started"] is None:  # still ringing
        if call["caller"] in in_room:
            call["caller_joined"] = True
        elif call["caller_joined"]:
            await end_call(channel, "cancelled")  # the caller hung up (or closed the tab)
    elif not in_room:
        await end_call(channel, "ended")  # the last one left


class CallChannel(BaseModel):
    channel: str


@app.post("/calls/decline")
async def decline_call(data: CallChannel, request: Request):
    """Decline on a ringing call's notification in the phone app, which may not even be running (so
    there's no WebSocket to say it with): the same as {"type": "call_answer", "accept": false}."""
    user_id, username, password_hash, email = logged_in_user(request)
    await answer_call(data.channel, user_id, False)
    return {"ok": True}


@app.get("/voice-token")
async def voice_token(room: str, request: Request):
    """Where the LiveKit server is, and a ticket into this voice room. The page asks for this when
    you join voice, and gives both to LiveKit."""
    user_id, username, password_hash, email = logged_in_user(request)
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise HTTPException(503, "Voice isn't set up on this server.")
    if not may_join_voice(room, user_id):
        raise HTTPException(403, "You can't join that voice room.")
    return {"url": LIVEKIT_URL, "token": make_voice_token(user_id, username, room)}


# ---------- Link previews ----------
#
# For the first link in a new message, the server fetches the page, reads its Open Graph tags
# (<meta property="og:title" content="...">: what sites put there for exactly this), and saves a
# card: site, title, description and a shrunk copy of the picture. Friends' browsers only ever
# talk to us, never to the linked site.
#
# The danger is SSRF ("server-side request forgery"): this server sits inside the home network,
# so a link to http://192.168.1.1 (the router) or http://localhost:7880 (LiveKit) would make it
# visit those, and show what's there. So: only http/https on the normal ports, only addresses
# on the public internet (looked up by us, then connected to directly, so a host name can't
# answer "public" when we check and "192.168..." when we connect), redirects checked the same
# way, and limits on time and size everywhere.

PREVIEW_DIR = UPLOAD_DIR / "previews"
PREVIEW_DIR.mkdir(exist_ok=True)
PREVIEW_TIMEOUT = 5               # seconds for each network step (connecting, each read)
PREVIEW_TOTAL_TIMEOUT = 15        # seconds for the whole preview, picture included
MAX_PREVIEW_HTML = 1024 * 1024    # 1 MB: the tags are at the top, so more is never needed
MAX_PREVIEW_IMAGE = 5 * 1024 * 1024  # 5 MB
MAX_PREVIEW_REDIRECTS = 3
PREVIEW_IMAGE_SIZE = (480, 480)   # at most this big, keeping its shape
PREVIEW_LIMIT = 10                # previews per person...
PREVIEW_WINDOW = 60               # ...within this many seconds
PREVIEW_USER_AGENT = f"Mozilla/5.0 (compatible; ChatAppBot/1.0; +{PUBLIC_URL})"  # sites see who's asking
preview_times = {}                # user id -> times of their recent previews (for the limit)
background_tasks = set()          # running previews (asyncio only keeps a weak reference to tasks)


def first_link(text):
    """The first web address in a message, as the page shows it (static/js/messages.js), or None.
    Not one inside `code` or a code block: those are shown as typed, not as links."""
    text = re.sub(r"```[\s\S]*?```|`[^`\n]*`", " ", text)
    match = re.search(r"https?://[^\s<]+", text)
    if not match:
        return None
    url = match.group()
    # Punctuation at the end belongs to the sentence ("see https://x.com."); a ")" stays if the
    # address has a "(" of its own (like the page's trimUrl).
    while url and (url[-1] in ".,!?:;'\"*~|" or (url[-1] == ")" and url.count(")") > url.count("("))):
        url = url[:-1]
    return url


def public_address(host, port):
    """The IP address to connect to for `host`, or None if it isn't safely on the public internet.
    Every address the name has must be public: a name that also points inside is refused."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        return None
    addresses = [info[4][0] for info in infos]
    for address in addresses:
        ip = ipaddress.ip_address(address.split("%")[0])  # (an IPv6 "%" zone, as in fe80::1%3)
        # is_global: not private (192.168.x, 10.x), loopback (127.x), link-local, reserved, ...
        if not ip.is_global:
            return None
    return addresses[0] if addresses else None


def fetch_url(url, max_bytes, accept):
    """GET a web address safely (see above). Returns (final address, content type, body), or None.
    Blocking: run it in a thread (asyncio.to_thread), not in the server's event loop."""
    for _ in range(MAX_PREVIEW_REDIRECTS + 1):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return None
        default_port = 443 if parts.scheme == "https" else 80
        if (parts.port or default_port) != default_port:
            return None  # only the normal ports: nobody's admin page on :8080
        address = public_address(parts.hostname, default_port)
        if address is None:
            return None
        # Connect to the address we just checked, ourselves...
        sock = socket.create_connection((address, default_port), timeout=PREVIEW_TIMEOUT)
        try:
            if parts.scheme == "https":
                # ...with HTTPS checked against the host *name*, as a browser would.
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=parts.hostname)
            # (HTTPSConnection for https, so the Host header is "example.com", not "example.com:443".)
            kind = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
            connection = kind(parts.hostname, default_port, timeout=PREVIEW_TIMEOUT)
            connection.sock = sock  # http.client uses this one instead of connecting by itself
            path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
            connection.request("GET", path, headers={
                "User-Agent": PREVIEW_USER_AGENT, "Accept": accept, "Accept-Language": "en",
            })
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    return None
                url = urljoin(url, location)  # (it may be relative: "/new-page")
                continue  # the next round checks the new address like the first
            if response.status != 200:
                return None
            body = response.read(max_bytes + 1)
            content_type = (response.getheader("Content-Type") or "").lower()
            return url, content_type, body
        except (OSError, http.client.HTTPException, ValueError):
            return None  # (ssl and socket errors are OSErrors)
        finally:
            sock.close()
    return None  # too many redirects


class MetaReader(HTMLParser):
    """Collects a page's <meta> tags and its <title>. Python's HTMLParser calls handle_starttag
    for each opening tag, handle_data for the text between them; attribute values arrive with
    &amp; and the like already turned back into characters."""

    def __init__(self):
        super().__init__()
        self.meta = {}       # "og:title" -> "Cat plays piano" (the first one of each)
        self.title = ""
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta":
            key = (attrs.get("property") or attrs.get("name") or "").lower()
            if key and attrs.get("content") and key not in self.meta:
                self.meta[key] = attrs["content"]
        elif tag == "title":
            self.in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title += data


def clean(text, limit):
    """Squash whitespace and cut to `limit` characters (with "…"), or None if empty."""
    text = " ".join((text or "").split())
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text or None


def fetch_preview(url):
    """Everything for one preview (blocking): {url, site, title, description, image} or None."""
    page = fetch_url(url, MAX_PREVIEW_HTML, "text/html,application/xhtml+xml")
    if page is None:
        return None
    final_url, content_type, body = page
    if "html" not in content_type:
        return None  # a PDF, a picture, a download, ...
    # The page's own character set if it says so ("text/html; charset=iso-8859-1"), else UTF-8.
    charset = re.search(r"charset=([\w-]+)", content_type)
    try:
        html = body[:MAX_PREVIEW_HTML].decode(charset.group(1) if charset else "utf-8", errors="replace")
    except LookupError:
        html = body[:MAX_PREVIEW_HTML].decode("utf-8", errors="replace")  # an unknown charset name
    reader = MetaReader()
    try:
        reader.feed(html)
    except Exception:
        pass  # broken HTML: keep whatever was read before it
    meta = reader.meta

    title = clean(meta.get("og:title") or meta.get("twitter:title") or reader.title, 200)
    description = clean(meta.get("og:description") or meta.get("twitter:description")
                        or meta.get("description"), 300)
    site = clean(meta.get("og:site_name"), 100) or urlsplit(final_url).hostname
    image_url = meta.get("og:image:secure_url") or meta.get("og:image") or meta.get("twitter:image")
    image = save_preview_image(urljoin(final_url, image_url)) if image_url else None
    if not title and not image:
        return None  # nothing worth a card
    return {"url": final_url, "site": site, "title": title, "description": description, "image": image}


def save_preview_image(url):
    """Download a preview picture, shrink it and save it as WebP in uploads/previews.
    Returns the file name, or None. Pillow redraws it from scratch, so only the pixels survive
    (no tricks hidden in the file), and its pixel limit stops "decompression bombs"."""
    fetched = fetch_url(url, MAX_PREVIEW_IMAGE, "image/*")
    if fetched is None or len(fetched[2]) > MAX_PREVIEW_IMAGE:
        return None
    try:
        with Image.open(BytesIO(fetched[2]), formats=["PNG", "JPEG", "GIF", "WEBP"]) as picture:
            picture = picture.convert("RGBA" if picture.mode in ("RGBA", "LA", "P") else "RGB")
            picture.thumbnail(PREVIEW_IMAGE_SIZE)  # shrinks (never enlarges), keeping its shape
            name = secrets.token_urlsafe(16) + ".webp"
            picture.save(PREVIEW_DIR / name, "WEBP", quality=85)
            return name
    except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        return None


def preview_info(url, site, title, description, image):
    """A preview as the page gets it (live and in the history)."""
    return {
        "url": url, "site": site, "title": title, "description": description,
        "image": f"/previews/{image}" if image else None,
    }


def preview_allowed(user_id):
    """At most PREVIEW_LIMIT previews per person per PREVIEW_WINDOW seconds."""
    now = time.time()
    recent = [t for t in preview_times.get(user_id, []) if t > now - PREVIEW_WINDOW]
    if len(recent) >= PREVIEW_LIMIT:
        preview_times[user_id] = recent
        return False
    preview_times[user_id] = recent + [now]
    return True


async def make_preview(message_id, channel, url):
    """In the background, after the message went out: fetch, save, and tell the channel."""
    try:
        preview = await asyncio.wait_for(asyncio.to_thread(fetch_preview, url), PREVIEW_TOTAL_TIMEOUT)
    except Exception:
        return  # (timeouts too: then no preview)
    if preview is None:
        return
    # Deleted while we were fetching? Then forget it (and its picture).
    if db.execute("SELECT 1 FROM messages WHERE id = ?", (message_id,)).fetchone() is None:
        if preview["image"]:
            (PREVIEW_DIR / preview["image"]).unlink(missing_ok=True)
        return
    with db:
        db.execute(
            "INSERT OR IGNORE INTO link_previews (message_id, url, site, title, description, image)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (message_id, preview["url"], preview["site"], preview["title"], preview["description"], preview["image"]),
        )
    await send_to_channel(channel, {
        "type": "preview", "channel": channel, "message_id": message_id,
        "preview": preview_info(**preview),
    })


def start_preview(message_id, channel, user_id, text):
    """Start a preview for a new message's first link, if it has one (and the person isn't over the limit)."""
    url = first_link(text)
    if url is None or not preview_allowed(user_id):
        return
    task = asyncio.create_task(make_preview(message_id, channel, url))
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)  # forget it once it's finished


def delete_preview(message_id):
    """When a message is deleted: its preview row (inside the caller's transaction). Returns the
    picture's file name, for the caller to delete once the change is saved."""
    row = db.execute("SELECT image FROM link_previews WHERE message_id = ?", (message_id,)).fetchone()
    db.execute("DELETE FROM link_previews WHERE message_id = ?", (message_id,))
    return row[0] if row else None


@app.get("/previews/{name}")
async def get_preview_image(request: Request, name: str):
    """A preview's picture, for people who may see the message it belongs to."""
    user_id = current_user(request)
    row = db.execute(
        "SELECT messages.channel FROM link_previews JOIN messages ON messages.id = link_previews.message_id"
        " WHERE link_previews.image = ?",
        (name,),
    ).fetchone()
    if user_id is None or row is None or not can_join(row[0], user_id):
        raise HTTPException(404, "Not found.")
    return FileResponse(
        PREVIEW_DIR / name,  # safe: the name was found in our own table above
        media_type="image/webp",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable"},
    )


# ---------- GIFs ----------
#
# GIF search through GIPHY (developers.giphy.com). The page never talks to GIPHY's API: it asks
# us, and we ask GIPHY with our key (GIPHY_API_KEY in .env), so the key stays secret. The free key
# allows about 100 requests an hour for the whole site, so every answer is kept for an hour
# (gif_cache: the same search twice costs one request) and each person has a limit.
# Sending one: the server downloads it and saves it as an ordinary upload, so from then on it's a
# picture like any other (the viewer, replies, Chattus, backups), friends' browsers never contact
# GIPHY to see it, and it stays even if GIPHY removes it. Only from GIPHY's own addresses (no SSRF).

GIPHY_API_KEY = os.environ.get("GIPHY_API_KEY", "")
GIPHY_API = "https://api.giphy.com/v1/gifs"
GIF_RATING = "pg-13"          # GIPHY's age ratings: g, pg, pg-13, r
GIF_RESULTS = 30              # GIFs per search
GIF_CACHE_TIME = 60 * 60      # seconds an answer is kept
GIF_LIMIT = 20                # GIPHY requests per person (searches not in the cache, and sends)...
GIF_WINDOW = 60               # ...within this many seconds
MAX_GIPHY_ANSWER = 2 * 1024 * 1024  # bytes: 30 GIFs' details are well under 100 KB
MAX_GIF_SIZE = 5 * 1024 * 1024      # the file we save (a few hundred KB as WebP, usually)
MAX_GIF_QUERY = 50
gif_cache = {}   # search ("" = trending) -> (when, the GIFs as the page gets them)
gif_files = {}   # GIPHY id -> (address of the file to save, its title), from searches, for sending
gif_times = {}   # user id -> times of their recent GIPHY requests (for the limit)


def gif_allowed(user_id):
    """At most GIF_LIMIT GIPHY requests per person per GIF_WINDOW seconds (like preview_allowed)."""
    now = time.time()
    recent = [t for t in gif_times.get(user_id, []) if t > now - GIF_WINDOW]
    if len(recent) >= GIF_LIMIT:
        gif_times[user_id] = recent
        return False
    gif_times[user_id] = recent + [now]
    return True


def is_giphy_url(url):
    """An https address on GIPHY's own servers (media0.giphy.com, i.giphy.com, ...)."""
    parts = urlsplit(url or "")
    return parts.scheme == "https" and (parts.hostname or "").endswith(".giphy.com")


def gif_file(item):
    """Which of a GIF's versions to save: the full-size animated WebP if it isn't too big, else
    the 200-pixel-high one. (A WebP is several times smaller than the same .gif.) None: neither."""
    images = item.get("images", {})
    for version in ("original", "fixed_height"):
        image = images.get(version) or {}
        if is_giphy_url(image.get("webp")) and int(image.get("webp_size") or 0) <= MAX_GIF_SIZE:
            return image["webp"]
    return None


async def ask_giphy(path, **params):
    """GET one of GIPHY's API addresses, with our key. Returns its "data", or None if it failed."""
    query = urlencode({"api_key": GIPHY_API_KEY, **params})
    # fetch_url (Link previews) blocks while it waits, so it runs in a thread.
    result = await asyncio.to_thread(fetch_url, f"{GIPHY_API}/{path}?{query}", MAX_GIPHY_ANSWER, "application/json")
    if result is None or len(result[2]) > MAX_GIPHY_ANSWER:
        return None
    try:
        return json.loads(result[2])["data"]
    except (ValueError, KeyError, TypeError):
        return None


@app.get("/gifs/search")
async def search_gifs(request: Request, q: str = ""):
    """GIFs for the picker: /gifs/search?q=cats, or the trending ones without q. Each with its id
    and a small, low frame rate preview (fixed_width_downsampled, ~30 KB) for the grid."""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    if not GIPHY_API_KEY:
        raise HTTPException(503, "GIF search isn't set up on this server.")
    query = " ".join(q.lower().split())[:MAX_GIF_QUERY]  # "  Cats " and "cats" are the same search
    cached = gif_cache.get(query)
    if cached and time.time() - cached[0] < GIF_CACHE_TIME:
        return {"gifs": cached[1]}
    if not gif_allowed(user_id):
        raise HTTPException(429, "That's a lot of GIFs: try again in a minute.")

    # bundle=messaging_non_clips: only the versions a chat needs, so the answer is smaller.
    params = {"limit": GIF_RESULTS, "rating": GIF_RATING, "bundle": "messaging_non_clips"}
    items = await (ask_giphy("search", q=query, **params) if query else ask_giphy("trending", **params))
    if items is None:
        raise HTTPException(502, "GIF search isn't answering right now. Try again in a bit.")
    gifs = []
    for item in items:
        try:
            preview = item["images"].get("fixed_width_downsampled") or item["images"]["fixed_width"]
            file = gif_file(item)
            address = preview.get("webp") or preview["url"]
            if file is None or not is_giphy_url(address) or not isinstance(item["id"], str):
                continue
            title = clean(item.get("title"), 100) or "GIF"
            gifs.append({
                "id": item["id"], "title": title, "preview": address,
                "width": int(preview["width"]), "height": int(preview["height"]),
            })
            gif_files[item["id"]] = (file, title)
        except (KeyError, TypeError, ValueError, AttributeError):
            continue  # (a GIF with something missing: left out)

    # Forget answers older than an hour, and (rarely) the remembered files: a send of a GIF that
    # was forgotten asks GIPHY for it again.
    now = time.time()
    for old in [key for key, (when, _) in gif_cache.items() if now - when >= GIF_CACHE_TIME]:
        del gif_cache[old]
    if len(gif_files) > 5000:
        gif_files.clear()
    gif_cache[query] = (now, gifs)
    return {"gifs": gifs}


class GifChoice(BaseModel):
    id: str  # GIPHY's id for the GIF, like "tphCApwvdtC1VJabZ1"


@app.post("/gifs/send")
async def save_gif(choice: GifChoice, request: Request):
    """Download a GIF from GIPHY and save it as an upload of ours. Answers {"id": ...} like /upload,
    and the page then sends it like any file (claim_attachment ties it to the chat)."""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    if not GIPHY_API_KEY:
        raise HTTPException(503, "GIF search isn't set up on this server.")
    if not re.fullmatch(r"[A-Za-z0-9]{1,64}", choice.id):  # (it goes into GIPHY's address below)
        raise HTTPException(400, "That isn't a GIF.")
    if not gif_allowed(user_id):
        raise HTTPException(429, "That's a lot of GIFs: try again in a minute.")
    known = gif_files.get(choice.id)
    if known is None:  # (not from a search we remember: ask GIPHY about it)
        item = await ask_giphy(choice.id)
        file = isinstance(item, dict) and gif_file(item)
        if not file:
            raise HTTPException(404, "That GIF isn't there any more.")
        known = (file, clean(item.get("title"), 100) or "GIF")
    address, title = known

    couldnt = HTTPException(502, "Couldn't get that GIF. Try another one.")
    result = await asyncio.to_thread(fetch_url, address, MAX_GIF_SIZE, "image/webp,image/*")
    if result is None or len(result[2]) > MAX_GIF_SIZE:
        raise couldnt
    body = result[2]
    # Make sure it really is a picture (Pillow reads its header), and which kind.
    try:
        with Image.open(BytesIO(body)) as picture:
            kind = picture.format  # "WEBP", "GIF", ...
    except Exception:
        raise couldnt
    content_type = {"WEBP": "image/webp", "GIF": "image/gif"}.get(kind)
    if content_type is None:
        raise couldnt

    file_id = secrets.token_urlsafe(16)  # a random name on disk, like /upload
    (UPLOAD_DIR / file_id).write_bytes(body)
    filename = title[:MAX_FILENAME_LENGTH - 5] + (".webp" if content_type == "image/webp" else ".gif")
    with db:
        db.execute(
            "INSERT INTO attachments (id, filename, content_type, size, uploader_id) VALUES (?, ?, ?, ?, ?)",
            (file_id, filename, content_type, len(body), user_id),
        )
    return {"id": file_id}


# ---------- Unread ----------

def mark_read(user_id, channel):
    """Remember that this user has now seen everything in this channel."""
    newest = db.execute("SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel = ?", (channel,)).fetchone()[0]
    # An "upsert": insert a new row, or if this user already has one for this channel,
    # update it instead. "excluded" means the values we just tried to insert.
    with db:
        db.execute(
            """
            INSERT INTO last_read (user_id, channel, message_id) VALUES (?, ?, ?)
            ON CONFLICT (user_id, channel) DO UPDATE SET message_id = excluded.message_id
            """,
            (user_id, channel, newest),
        )


def unread_channels(user_id):
    """Every channel and DM this user can see that has messages newer than the last one they saw."""
    # GROUP BY: one row per channel, with the newest message id in it.
    newest = dict(db.execute("SELECT channel, MAX(id) FROM messages GROUP BY channel"))
    seen = dict(db.execute("SELECT channel, message_id FROM last_read WHERE user_id = ?", (user_id,)))
    return [
        channel
        for channel, newest_id in newest.items()
        if newest_id > seen.get(channel, 0) and can_join(channel, user_id)
    ]


async def announce_new_message(channel, mentioned=(), message=None):
    """After a new message: it counts as read for whoever is looking at the channel, and
    everyone else who can see the channel gets an "unread" for it. People it mentioned also
    get their new count of unread mentions there, and a short preview for a notification."""
    viewers = {client["user_id"] for client in clients.values() if client["channel"] == channel}
    for user_id in viewers:
        mark_read(user_id, channel)
    for websocket, client in list(clients.items()):
        if client["user_id"] not in viewers and can_join(channel, client["user_id"]):
            update = {"type": "unread", "channels": [channel]}
            if client["user_id"] in mentioned:
                update["mentions"] = unread_mentions(client["user_id"], channel)  # {"memes": 2}
                if message:
                    update["notify"] = {
                        "channel": channel,
                        "id": message["id"],  # so clicking the notification can jump to the message
                        "user_id": message["user_id"],
                        "name": message["name"],
                        # The start of the text (a token cut in half at the end dropped), or a file.
                        "text": re.sub(r"<(:\d*|@\w*)?$", "", message["text"][:100]) or ("📎 Attachment" if message["file"] else ""),
                    }
            await send(websocket, update)


async def send(websocket, data):
    """Send to one connection, ignoring errors: if that tab just closed, its own
    chat() call notices and cleans up, so a failure here must not crash the sender."""
    try:
        await websocket.send_json(data)
    except Exception:
        pass


async def disconnect_user(user_id):
    """Close every open chat tab of one user, with our "not logged in" code (the page then
    goes to the login page). Used after a password reset."""
    for websocket, client in list(clients.items()):
        if client["user_id"] == user_id:
            try:
                await websocket.close(code=4001)
            except Exception:
                pass


async def send_to_everyone(data):
    # list() makes a copy, in case someone joins or leaves while we're sending.
    for websocket in list(clients):
        await send(websocket, data)


async def send_to_user(user_id, data):
    """Send to every open tab of one person (the desktop app and their phone, say)."""
    for websocket, client in list(clients.items()):
        if client["user_id"] == user_id:
            await send(websocket, data)


async def send_to_channel(channel, data, except_user_id=None):
    """Send to everyone viewing a channel, optionally leaving out one user (all their tabs)."""
    for websocket, client in list(clients.items()):
        if client["channel"] == channel and client["user_id"] != except_user_id:
            await send(websocket, data)


@app.websocket("/ws")
async def chat(websocket: WebSocket):
    # The browser sends the session cookie along when it opens the WebSocket.
    user_id = user_id_from_token(websocket.cookies.get(SESSION_COOKIE))
    if user_id is None:
        # Not logged in. Accept first and then close with our own code (4000-4999 are free
        # for apps): if we refused outright, the page couldn't see why, and would keep retrying.
        await websocket.accept()
        await websocket.close(code=4001)
        return

    await websocket.accept()
    global presence_watcher
    if presence_watcher is None:  # the first connection since the server started: start watching for idle
        presence_watcher = asyncio.create_task(watch_presences())
    global repacker
    if repacker is None:  # and re-pack older videos once (see "Re-packing videos")
        repacker = asyncio.create_task(repack_old_videos())
    # No channel until they "join", no voice room until they say they joined one.
    clients[websocket] = {"user_id": user_id, "channel": None, "voice": None, "muted": False, "deafened": False,
                          "looking": False,  # looking at it right now (the page says, see "looking")
                          "away_since": time.time(),  # since when it isn't (None while it is): for "idle"
                          "app": False,      # the Windows app (the page says so in "looking" too)
                          "mobile": False,   # a phone (in "looking" too): see on_phone_only
                          "activity": None}  # what they're doing, if this page says (see "activity")
    try:
        # Tell the page who it is (the id is for building DM names).
        await send(websocket, {
            "type": "welcome", "id": user_id, "username": username_of(user_id),
            "max_text_length": MAX_TEXT_LENGTH,  # so the page's text box uses the same limit
            "page_version": PAGE_VERSION,  # a different one than it was loaded with: it reloads
            "appearance": appearance_of(user_id),  # Settings → Appearance (None: the defaults)
            "presence": presence_of(user_id),  # the status they chose (the others may see another: users)
            "vapid_public_key": VAPID_PUBLIC_KEY or None,  # for subscribing to push (None: not set up)
            "phone_push": firebase_account is not None,  # can the phone app get pushes (FCM)?
            "season": current_season(),  # the seasonal easter egg ("Seasons"; None: none now)
        })
        await send(websocket, channels_message(user_id))  # (they may have changed while away)
        await send(websocket, friends_message(user_id))
        await send(websocket, groups_message(user_id))
        await send(websocket, mutes_message(user_id))
        await send(websocket, blocks_message(user_id))
        await send(websocket, roles_message(user_id))  # (before "users", whose roles refer to these)
        await send(websocket, custom_emoji_message())
        await send(websocket, {
            "type": "unread", "channels": unread_channels(user_id), "mentions": unread_mentions(user_id),
        })
        await send(websocket, users_for(user_id, users_message()))  # this tab
        await announce_presences()  # and everyone, if this changed what they see (they came online)
        await send(websocket, voice_members_message(user_id))  # who's in the voice channels right now
        # Their DM and group calls that someone is in right now (so the banner can offer "Join call").
        private_rooms = {c["voice"] for c in clients.values() if is_private_room(c["voice"])}
        for room in private_rooms:
            if is_call_member(room, user_id):
                await send(websocket, dm_call_message(room))
        for channel, call in list(calls.items()):  # opened while someone is calling them: ring here too
            if user_id in call["ringing"]:
                await send(websocket, call_message(channel))

        while True:
            data = parse_json(await websocket.receive_text())
            if data is None:
                continue  # ignore invalid messages
            kind = data.get("type")
            channel = clients[websocket]["channel"]

            if kind == "join":
                new_channel = data.get("channel")
                if new_channel is None:
                    # Looking at no channel (the Friends page): new messages anywhere count as unread.
                    clients[websocket]["channel"] = None
                    continue
                if not can_join(new_channel, user_id):
                    continue
                # Switch channel and fetch its history with no await in between,
                # so no message can slip through the gap.
                clients[websocket]["channel"] = new_channel
                history = recent_messages(new_channel)
                # Where they stopped reading (read before mark_read moves it): the page draws a
                # "New messages" divider above the first message after it. None: never opened.
                seen = db.execute(
                    "SELECT message_id FROM last_read WHERE user_id = ? AND channel = ?", (user_id, new_channel)
                ).fetchone()
                mark_read(user_id, new_channel)  # opening a channel means you've seen it
                # "more": a full batch, so there may be older messages to load by scrolling up.
                more = len(history) == HISTORY_LIMIT
                await send(websocket, {
                    "type": "history", "channel": new_channel, "messages": history, "more": more,
                    "last_read": seen[0] if seen else None,
                })

            elif kind == "older" and channel is not None:
                # {"type": "older", "before": 1234}: scrolled to the top, so send the messages just
                # before message 1234 in the channel we're in. Checked like everything else: a whole
                # number (True counts as an int in Python, so rule that out) that SQLite can hold,
                # and a channel we may still read (a DM stops being allowed when the friendship ends).
                before = data.get("before")
                if not isinstance(before, int) or isinstance(before, bool) or not 0 < before < 2**63:
                    continue
                if not can_join(channel, user_id):
                    continue
                older = recent_messages(channel, before)
                more = len(older) == HISTORY_LIMIT
                await send(websocket, {"type": "older", "channel": channel, "messages": older, "more": more})

            elif kind == "message" and channel is not None:
                # Check again, not just when joining: a DM stops being allowed the moment
                # the friendship ends, even if this tab is still showing it.
                if not can_join(channel, user_id):
                    continue
                text = clean_text(data)
                if text is None:
                    continue
                file = None
                if data.get("file") is not None:
                    file = claim_attachment(data.get("file"), user_id, channel)
                    if file is None:
                        continue  # not their file, already sent, or doesn't exist
                if not text and file is None:
                    continue  # nothing to send
                text = expand_custom_emoji(text)  # :pog: -> <:17>
                text, mentioned, everyone = expand_mentions(text)  # @kari -> <@2>
                reply_to = check_reply(data.get("reply_to"), channel)
                message_id, sent_at = save_message(channel, user_id, text, file, reply_to)
                mentioned_people = save_mentions(message_id, channel, user_id, mentioned, everyone)
                # The name comes from the login (looked up now, so it's always the current one),
                # never from the client.
                message = {
                    "type": "message", "channel": channel, "id": message_id, "sent_at": sent_at,
                    "user_id": user_id, "name": username_of(user_id), "text": text, "file": file,
                    "reply": live_reply_preview(reply_to),
                    "reactions": [],  # a brand new message has none yet
                    "edited_at": None,
                    "kind": None,
                    "pinned": False,
                    "preview": None,  # a link's preview comes a moment later, as its own "preview"
                }
                await send_to_channel(channel, message)  # everyone in the channel, including us
                await announce_new_message(channel, mentioned_people, message)  # read/unread, mentions, notifications
                push_message(mentioned_people, message)  # their phones, if they're not looking at the chat
                start_preview(message_id, channel, user_id, text)  # in the background, if it has a link

            elif kind == "react":
                # {"type": "react", "message_id": 57, "emoji": "👍"}: add our reaction, or remove it
                # if it's already there (a toggle).
                message_id = data.get("message_id")
                emoji = data.get("emoji")
                if not isinstance(message_id, int) or isinstance(message_id, bool):
                    continue
                # A Unicode emoji from the list, or a custom one ("custom:17") that exists.
                if not isinstance(emoji, str) or not (emoji in ALLOWED_EMOJI or custom_emoji_exists(emoji)):
                    continue
                row = db.execute("SELECT channel FROM messages WHERE id = ?", (message_id,)).fetchone()
                if row is None or not can_join(row[0], user_id):
                    continue  # no such message, or one we're not allowed to see (someone else's DM)
                message_channel = row[0]
                with db:
                    cursor = db.execute(
                        "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
                        (message_id, user_id, emoji),
                    )
                    if cursor.rowcount == 0:  # nothing was deleted, so it wasn't there yet: add it
                        db.execute(
                            "INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)",
                            (message_id, user_id, emoji),
                        )
                # Everyone looking at that channel gets the message's new reactions.
                await send_to_channel(message_channel, {
                    "type": "reactions", "channel": message_channel, "message_id": message_id,
                    "reactions": reactions_for([message_id])[message_id],
                })

            elif kind in ("edit", "delete"):
                # {"type": "edit", "message_id": 57, "text": "..."} or {"type": "delete", "message_id": 57}
                message_id = data.get("message_id")
                if not isinstance(message_id, int) or isinstance(message_id, bool):
                    continue
                row = db.execute(
                    "SELECT channel, user_id, attachment_id, kind FROM messages WHERE id = ?", (message_id,)
                ).fetchone()
                if row is None:
                    continue
                message_channel, author_id, attachment_id, message_kind = row
                if kind == "edit" and message_kind is not None:
                    continue  # call notes are written by the server, not edited
                if not can_join(message_channel, user_id):
                    continue  # a message we can't even see
                if author_id != user_id and not is_admin(user_id):
                    continue  # only your own messages, unless you're an admin

                if kind == "edit":
                    text = clean_text(data)
                    if text is None or (not text and attachment_id is None):
                        continue  # too long, or empty without a file to keep the message
                    text = expand_custom_emoji(text)  # :pog: -> <:17>, as for new messages
                    text, mentioned, everyone = expand_mentions(text)
                    with db:
                        db.execute(
                            "UPDATE messages SET text = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?",
                            (text, message_id),
                        )
                    # The mentions follow the new text (an edit doesn't send new unread counts, like Discord).
                    save_mentions(message_id, message_channel, author_id, mentioned, everyone)
                    edited_at = db.execute("SELECT edited_at FROM messages WHERE id = ?", (message_id,)).fetchone()[0]
                    await send_to_channel(message_channel, {
                        "type": "edited", "channel": message_channel, "message_id": message_id,
                        "text": text, "edited_at": iso_time(edited_at),
                    })
                else:
                    # Delete the message with everything that belongs to it, in one transaction.
                    file = None
                    if attachment_id:
                        file = db.execute("SELECT id FROM attachments WHERE id = ?", (attachment_id,)).fetchone()
                    with db:
                        db.execute("DELETE FROM reactions WHERE message_id = ?", (message_id,))
                        db.execute("DELETE FROM mentions WHERE message_id = ?", (message_id,))
                        preview_image = delete_preview(message_id)
                        db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
                        if attachment_id:
                            db.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))
                    if file:  # the file on disk, only once the database change has been saved
                        (UPLOAD_DIR / attachment_id).unlink(missing_ok=True)
                    if preview_image:
                        (PREVIEW_DIR / preview_image).unlink(missing_ok=True)
                    # (Replies to it keep their reply_to; their quote now says "deleted".)
                    await send_to_channel(message_channel, {
                        "type": "deleted", "channel": message_channel, "message_id": message_id,
                    })

            elif kind == "pin":
                # {"type": "pin", "message_id": 57, "pinned": true}: pin a message, or unpin it (false).
                # Anyone who can see it may (a chat of friends), but not the server's own notes.
                message_id = data.get("message_id")
                if not isinstance(message_id, int) or isinstance(message_id, bool):
                    continue
                row = db.execute("SELECT channel, kind, pinned_at FROM messages WHERE id = ?", (message_id,)).fetchone()
                if row is None or not can_join(row[0], user_id) or row[1] is not None:
                    continue
                message_channel, _, pinned_at = row
                pin = data.get("pinned") is True
                if pin == (pinned_at is not None):
                    continue  # it already is (pinned twice at once from two tabs, say)
                if pin:
                    count = db.execute("SELECT COUNT(*) FROM messages WHERE channel = ? AND pinned_at IS NOT NULL",
                                       (message_channel,)).fetchone()[0]
                    if count >= MAX_PINS:
                        await send(websocket, {"type": "pins_full", "channel": message_channel, "max": MAX_PINS})
                        continue
                with db:
                    db.execute(
                        "UPDATE messages SET pinned_at = CASE WHEN ? THEN CURRENT_TIMESTAMP END, pinned_by = ? WHERE id = ?",
                        (pin, user_id if pin else None, message_id),
                    )
                await send_to_channel(message_channel, {
                    "type": "pinned", "channel": message_channel, "message_id": message_id, "pinned": pin,
                })
                if pin:
                    # A note in the chat, quoting the message, so everyone notices (like Discord). Saved and
                    # sent like any message, so it gets unread dots; like a call note, it can't be edited.
                    note_id, sent_at = save_message(message_channel, user_id, "📌 pinned a message.", None, message_id, kind="pin")
                    await send_to_channel(message_channel, {
                        "type": "message", "channel": message_channel, "id": note_id, "sent_at": sent_at,
                        "user_id": user_id, "name": username_of(user_id), "text": "📌 pinned a message.",
                        "file": None, "reply": live_reply_preview(message_id), "reactions": [],
                        "edited_at": None, "kind": "pin", "pinned": False, "preview": None,
                    })
                    await announce_new_message(message_channel)

            elif kind == "search":
                # {"type": "search", "query": "pizza", "channel": "general" (or null: everywhere),
                # "from": 3 (or null: anyone), "ask": 7}. "ask" comes back, so the page can ignore the
                # answer to an older search (typing fast sends several).
                query = data.get("query") if isinstance(data.get("query"), str) else ""
                chat = data.get("channel") if isinstance(data.get("channel"), str) else None
                author = data.get("from")
                if not isinstance(author, int) or isinstance(author, bool):
                    author = None
                ask = data.get("ask") if isinstance(data.get("ask"), int) else None
                await send(websocket, {"type": "search_results", "ask": ask,
                                       "results": search_messages(user_id, query[:200], chat, author)})

            elif kind == "pins" and channel is not None:
                # {"type": "pins"}: the pinned messages of the channel we're in (the 📌 list).
                if can_join(channel, user_id):
                    await send(websocket, {"type": "pins", "channel": channel, "messages": pinned_messages(channel)})

            elif kind == "typing" and channel is not None:
                # Tell the others in this channel; you don't need to see yourself typing.
                await send_to_channel(
                    channel, {"type": "typing", "channel": channel, "name": username_of(user_id)},
                    except_user_id=user_id,
                )

            elif kind == "voice":
                # The page joined a voice room ({"room": "lounge"}), left it ({"room": null}), or
                # muted, unmuted or deafened ({"muted": true, "deafened": false}). Only for showing
                # who's in voice: getting into the audio itself still needs a ticket from /voice-token.
                room = data.get("room")
                if room is not None and not may_join_voice(room, user_id):
                    continue  # not a room they may be in
                old_room = clients[websocket]["voice"]
                clients[websocket]["voice"] = room
                clients[websocket]["muted"] = data.get("muted") is True
                clients[websocket]["deafened"] = data.get("deafened") is True
                # Everyone sees who's in the voice channels; DM and group calls stay private.
                if old_room in VOICE_ROOMS or room in VOICE_ROOMS:
                    await announce_voice_members()
                for changed in {old_room, room}:
                    if is_private_room(changed):
                        await announce_dm_call(changed)  # its people see who's in their call
                    if changed in calls:  # a call may have been called off, or ended
                        await check_call(changed)

            elif kind == "looking":
                # {"type": "looking", "looking": true}: the page is in sight and has the focus (or
                # not any more). Nobody gets a push while they're looking at the chat somewhere.
                looking = data.get("looking") is True
                if looking != clients[websocket]["looking"]:
                    clients[websocket]["away_since"] = None if looking else time.time()
                clients[websocket]["looking"] = looking
                clients[websocket]["app"] = data.get("app") is True  # (then no pushes at all: has_app_open)
                mobile = data.get("mobile") is True
                phone_changed = mobile != clients[websocket]["mobile"]
                clients[websocket]["mobile"] = mobile
                if looking or phone_changed:
                    await announce_presences()  # back from idle, or now known to be a phone: at once

            elif kind == "activity":
                # {"type": "activity", "activity": {"kind": "playing", "name": "Hollow Knight"} or null}:
                # what the Windows app sees them doing. "since" is when this one started: kept while
                # the same thing goes on, so their profile can say "for 23 min".
                activity = clean_activity(data.get("activity"))
                old = clients[websocket]["activity"]
                old_without_since = {key: value for key, value in old.items() if key != "since"} if old else None
                if activity != old_without_since:
                    if activity is not None:
                        activity["since"] = int(time.time())
                    clients[websocket]["activity"] = activity
                    await announce_presences()

            elif kind == "mute":
                # {"type": "mute", "channel": "memes", "muted": true}: mute a chat for ourselves (or unmute).
                # All our pages hear the new list.
                chat = data.get("channel")
                if not isinstance(chat, str):
                    continue
                if data.get("muted") is True:
                    if not can_mute(chat, user_id):
                        continue  # not a chat of theirs, or a DM with an admin
                    with db:
                        db.execute("INSERT OR IGNORE INTO chat_mutes (user_id, channel) VALUES (?, ?)", (user_id, chat))
                else:
                    with db:
                        db.execute("DELETE FROM chat_mutes WHERE user_id = ? AND channel = ?", (user_id, chat))
                await send_to_user(user_id, mutes_message(user_id))

            elif kind == "presence":
                # {"type": "presence", "presence": "dnd"}: the status they choose. All their pages hear it,
                # and everyone sees the new one.
                presence = data.get("presence")
                if presence not in PRESENCES:
                    continue
                with db:
                    db.execute("UPDATE users SET presence = ? WHERE id = ?", (presence, user_id))
                await send_to_user(user_id, {"type": "my_presence", "presence": presence})
                await announce_presences()

            elif kind == "call":
                await start_call(data.get("channel"), user_id)

            elif kind == "call_answer":
                await answer_call(data.get("channel"), user_id, data.get("accept") is True)

            elif kind == "call_cancel":
                # The caller hung up before an answer (also when their page never got into the room).
                call = calls.get(data.get("channel"))
                if call is not None and call["caller"] == user_id and call["started"] is None:
                    await end_call(data.get("channel"), "cancelled")
    except WebSocketDisconnect:
        pass
    finally:
        voice_room = clients[websocket]["voice"]
        del clients[websocket]
        await announce_presences()  # their last tab: they went offline (or another tab of theirs decides now)
        if voice_room in VOICE_ROOMS:  # closed the tab while in voice: they're out
            await announce_voice_members()
        if is_private_room(voice_room):  # ...or out of a DM's or group's call
            await announce_dm_call(voice_room)
        if voice_room in calls:
            await check_call(voice_room)
