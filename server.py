import asyncio
import hashlib
import json
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import time
import warnings
from email.message import EmailMessage
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from PIL import Image, ImageSequence
from pydantic import BaseModel

# docs_url etc. = None: turn off FastAPI's automatic API explorer pages (/docs, /redoc),
# handy in development but nothing the public internet needs to see.
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

# Settings from the environment. serve.ps1 loads them from the .env file (which is never committed).
INVITE_CODE = os.environ.get("INVITE_CODE", "")  # needed to create an account; empty = anyone can
SECURE_COOKIES = os.environ.get("SECURE_COOKIES") == "1"  # 1 = cookies only ever sent over HTTPS
# Where messages and files are kept. Development (start.ps1, via dev.env) uses its own,
# so test messages never end up in the real chat.
DATABASE_FILE = os.environ.get("DATABASE_FILE", "chat.db")
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "uploads"))
RELEASES_DIR = Path("releases")  # the desktop app's installers and latest.json (see /releases/)
# The site's own address, for links in emails. Never taken from the request: a request can
# claim any host name, which would let someone make us email links to *their* site.
PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://localhost:8000").rstrip("/")
# The mail server that sends our emails (password reset links). Empty = print emails here instead.
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
MAIL_FROM = os.environ.get("MAIL_FROM", "ChatApp <noreply@datslok.no>")
print(f"Using database {DATABASE_FILE} and upload folder {UPLOAD_DIR}/")
if not INVITE_CODE:
    print("WARNING: no INVITE_CODE set, so anyone who can reach this server can create an account.")
if not SMTP_HOST:
    print("No SMTP_HOST set: emails will be printed here instead of sent.")

CHANNELS = ["general", "memes"]  # add a name here to make a new channel

# Every emoji allowed as a reaction, from static/emoji.json (made from Unicode's official list by
# tools/make_emoji_json.py). The page's emoji picker uses the same file, so they always agree.
# Without a list, someone with their own script could "react" with any text at all.
with open("static/emoji.json", encoding="utf-8") as emoji_file:
    ALLOWED_EMOJI = {emoji for group in json.load(emoji_file)["groups"] for emoji, name in group["emoji"]}
MAX_TEXT_LENGTH = 2000
HISTORY_LIMIT = 50  # how many old messages a new connection gets

USERNAME_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,32}")  # 1-32 letters, digits, _ or -
RESERVED_NAMES = {"everyone", "here"}  # would be confused with @everyone
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 200
SESSION_COOKIE = "session"
SESSION_DAYS = 30
MAX_FAILURES = 5          # wrong passwords (or invite codes) allowed...
FAILURE_WINDOW = 15 * 60  # ...within this many seconds, before we refuse to check more
# Good enough to catch typos: something@something.something, no spaces.
EMAIL_PATTERN = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
MAX_EMAIL_LENGTH = 254
RESET_MINUTES = 60  # how long a password reset link works

UPLOAD_DIR.mkdir(exist_ok=True)  # create the folder if it isn't there yet
MAX_UPLOAD_SIZE = 10 * 1024 * 1024  # 10 MB, in bytes
MAX_FILENAME_LENGTH = 200
# Only these are shown in the page. They're pure pictures and can't contain scripts.
# Everything else (including SVG, which can) is only ever offered as a download.
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}

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

# Every open connection (one per browser tab) and what we know about it:
# {websocket: {"user_id": 3, "channel": "memes"}}
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
        is_admin      INTEGER NOT NULL DEFAULT 0  -- 1 = may edit and delete anyone's messages (tools/make_admin.py)
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
        edited_at     TEXT                              -- when it was last edited; NULL = never
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

if "is_admin" not in table_columns("users"):
    # From before admins existed: nobody is one, until tools/make_admin.py says so.
    with db:
        db.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")


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


def save_message(channel, user_id, text, file, reply_to):
    """Save a message. Returns its id and time, so the live message matches the history exactly."""
    # "with db" commits the change when the block ends (or undoes it if something fails).
    # The ? placeholders keep user text as data, so it can never be run as SQL.
    with db:
        cursor = db.execute(
            "INSERT INTO messages (channel, user_id, text, attachment_id, reply_to) VALUES (?, ?, ?, ?, ?)",
            (channel, user_id, text, file["id"] if file else None, reply_to),
        )
    message_id = cursor.lastrowid  # the id SQLite gave it
    sent_at = db.execute("SELECT sent_at FROM messages WHERE id = ?", (message_id,)).fetchone()[0]
    return message_id, iso_time(sent_at)


def file_info(attachment_id, filename, size, content_type):
    """What the page needs to know about an attachment."""
    return {"id": attachment_id, "filename": filename, "size": size, "image": content_type in IMAGE_TYPES}


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


def recent_messages(channel):
    """The channel's newest messages, oldest first, in the same shape as live messages."""
    # LEFT JOINs: each message, plus its sender's *current* username, plus its attachment
    # (NULLs where there's none). COALESCE(a, b) means "a, or b if a is NULL": for messages from
    # before accounts existed, there's no user, so we show the name that was typed back then.
    #
    # For replies, the messages table is joined with *itself*: "original" is a second copy of it
    # (an alias), holding the message being replied to, and "original_sender" its sender.
    rows = db.execute(
        """
        SELECT messages.id, messages.sent_at, messages.edited_at, messages.reply_to,
               messages.user_id, COALESCE(users.username, messages.legacy_name), messages.text,
               attachments.id, attachments.filename, attachments.size, attachments.content_type,
               original.id, original.user_id, COALESCE(original_sender.username, original.legacy_name),
               original.text, original.attachment_id
        FROM messages
        LEFT JOIN users ON users.id = messages.user_id
        LEFT JOIN attachments ON attachments.id = messages.attachment_id
        LEFT JOIN messages AS original ON original.id = messages.reply_to
        LEFT JOIN users AS original_sender ON original_sender.id = original.user_id
        WHERE messages.channel = ?
        ORDER BY messages.id DESC LIMIT ?
        """,
        (channel, HISTORY_LIMIT),
    ).fetchall()
    rows.reverse()  # we fetched newest-first; chat reads oldest-first
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
            "reply": reply_preview(*original) or ({"id": reply_to, "deleted": True} if reply_to else None),
            "reactions": reactions[message_id],
        }
        for (message_id, sent_at, edited_at, reply_to, user_id, name, text,
             file_id, filename, size, content_type, *original) in rows
    ]


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


def user_id_from_token(token):
    """The id of the user a session token belongs to, or None if it's missing, unknown or expired."""
    if not token:
        return None
    row = db.execute(
        "SELECT user_id FROM sessions WHERE token = ? AND created_at > datetime('now', ?)",
        (token, f"-{SESSION_DAYS} days"),
    ).fetchone()
    return row[0] if row else None


def current_user(request):
    """The logged-in user's id for an HTTP request, or None."""
    return user_id_from_token(request.cookies.get(SESSION_COOKIE))


@app.post("/register")
async def register(credentials: Credentials, request: Request, response: Response):
    if INVITE_CODE:
        # Limit guesses per visitor (IP address), so the code can't be found by trying them all.
        key = "invite:" + client_ip(request)
        if too_many_failures(key):
            raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")
        # compare_digest takes the same time however much of the guess is right,
        # so the response time gives no hints about the real code.
        if not secrets.compare_digest(credentials.invite.strip().encode(), INVITE_CODE.encode()):
            record_failure(key)
            raise HTTPException(403, "Wrong invite code.")

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
        with db:
            cursor = db.execute(
                "INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)",
                (username, password_hash, email),
            )
    except sqlite3.IntegrityError as error:  # a UNIQUE rule was broken: username or email
        if "email" in str(error):
            raise HTTPException(400, "That email is already used by another account.")
        raise HTTPException(400, "That username is taken.")

    start_session(response, cursor.lastrowid)  # lastrowid: the id SQLite gave the new user
    await send_to_everyone(users_message())  # so the new person shows up in everyone's DM list
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
    start_session(response, user_id)
    return {"ok": True}


@app.post("/logout")
async def logout(request: Request, response: Response):
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
async def reset(data: ResetRequest):
    """Set a new password using the token from an emailed link."""
    check_password_length(data.password)
    row = db.execute(
        """
        SELECT password_resets.user_id, users.username
        FROM password_resets JOIN users ON users.id = password_resets.user_id
        WHERE password_resets.token_hash = ? AND password_resets.created_at > datetime('now', ?)
        """,
        (hash_token(data.token), f"-{RESET_MINUTES} minutes"),
    ).fetchone()
    if row is None:
        raise HTTPException(400, "This reset link is invalid or has expired. Ask for a new one.")
    user_id, username = row

    with db:
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hasher.hash(data.password), user_id))
        db.execute("DELETE FROM password_resets WHERE user_id = ?", (user_id,))  # every link, used up
        db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))  # log out everywhere
    failures.pop("login:" + username.lower(), None)  # a fresh start for logging in
    await disconnect_user(user_id)  # close their open chat tabs too
    return {"ok": True}


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
    avatar, banner, status, bio = db.execute(
        "SELECT avatar_id, banner_id, status, bio FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    return {"username": username, "email": email, "avatar": avatar, "banner": banner, "status": status, "bio": bio}


class EmailChange(BaseModel):
    email: str
    password: str


@app.post("/settings/email")
async def change_email(data: EmailChange, request: Request):
    user_id, username, password_hash, old_email = logged_in_user(request)
    # Needs the password: otherwise someone at your unlocked laptop could set their own
    # email and then "reset" your password to take over the account.
    check_current_password(username, password_hash, data.password)
    email = clean_email(data.email)
    if email is None:
        raise HTTPException(400, "That doesn't look like an email address.")
    try:
        with db:
            db.execute("UPDATE users SET email = ? WHERE id = ?", (email, user_id))
    except sqlite3.IntegrityError:
        raise HTTPException(400, "That email is already used by another account.")
    return {"ok": True, "email": email}


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
    await send_to_everyone(users_message())
    await send_to_everyone({"type": "renamed", "id": user_id, "username": new_username})
    return {"ok": True, "username": new_username}


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


@app.post("/settings/password")
async def change_password(data: PasswordChange, request: Request):
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
    # The browser says what type the file is. We only believe it for our safe image types;
    # anything else is stored as a generic download type.
    content_type = request.headers.get("content-type", "")
    if content_type not in IMAGE_TYPES:
        content_type = "application/octet-stream"

    # On disk the file gets a random name, never the one the user gave
    # (a name like "../../server.py" could otherwise overwrite our own files).
    file_id = secrets.token_urlsafe(16)
    size = await receive_file(request, UPLOAD_DIR / file_id, MAX_UPLOAD_SIZE)

    with db:
        db.execute(
            "INSERT INTO attachments (id, filename, content_type, size, uploader_id) VALUES (?, ?, ?, ?, ?)",
            (file_id, filename, content_type, size, user_id),
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
        # Images are shown in the page; everything else is downloaded, never opened on our site.
        content_disposition_type="inline" if content_type in IMAGE_TYPES else "attachment",
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
    await send_to_everyone(users_message())  # everyone's page shows the new picture
    return {"ok": True, kind: picture_id}


async def remove_picture(request, kind):
    user_id, username, password_hash, email = logged_in_user(request)
    settings = PICTURE_KINDS[kind]
    old = db.execute(f"SELECT {settings['column']} FROM users WHERE id = ?", (user_id,)).fetchone()[0]
    with db:
        db.execute(f"UPDATE users SET {settings['column']} = NULL WHERE id = ?", (user_id,))
    if old:
        (settings["folder"] / old).unlink(missing_ok=True)
    await send_to_everyone(users_message())
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
    await send_to_everyone(users_message())
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
    see the channel, and never the sender themselves. @everyone = everyone who can see it."""
    if everyone:
        mentioned = {user_id for (user_id,) in db.execute("SELECT id FROM users")}
    if channel.startswith("dm:"):
        # In a DM, every message counts as mentioning the other person (like Discord): it gets a
        # red number and a notification. "dm:3:7" -> both ids; the sender is left out below.
        mentioned = set(mentioned) | {int(part) for part in channel.split(":")[1:]}
    people = [user_id for user_id in mentioned if user_id != sender_id and can_join(channel, user_id)]
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
    row = friendship(me, other)
    user_a, user_b = pair(me, other)
    if row is None:
        with db:
            db.execute(
                "INSERT INTO friendships (user_a, user_b, requested_by) VALUES (?, ?, ?)", (user_a, user_b, me)
            )
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
    with db:
        db.execute("DELETE FROM friendships WHERE user_a = ? AND user_b = ?", pair(me, other))
    await send_friends_update(me, other)
    return {"ok": True}


# ---------- Pages ----------

@app.get("/")
async def index(request: Request):
    if current_user(request) is None:
        return RedirectResponse("/login")  # not logged in: send them to the login page
    return FileResponse("static/index.html")


@app.get("/login")
async def login_page():
    return FileResponse("static/login.html")


@app.get("/reset")
async def reset_page():
    # One page for both steps: "send me a link" (no token) and "choose a new password" (?token=...).
    return FileResponse("static/reset.html")


@app.get("/emoji.json")
async def emoji_list():
    # All emoji for the picker. They never change while the server runs, so browsers may keep it for a day.
    return FileResponse("static/emoji.json", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/download")
async def download_page():
    # "Get the Windows app" (app.datslok.no redirects here). No login needed.
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


@app.get("/releases/{name}")
async def release_file(name: str):
    # The desktop app's updates: latest.json (which version is newest) and the installers.
    # No login needed: the app checks for updates before anyone has logged in.
    # Only plain file names straight inside releases/ ("..\chat.db" and the like don't match).
    if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]*", name) or not (RELEASES_DIR / name).is_file():
        raise HTTPException(404)
    # latest.json changes with every release, so it must never come from a cache.
    return FileResponse(RELEASES_DIR / name, headers={"Cache-Control": "no-cache"})


@app.get("/channels")
async def channels():
    return CHANNELS


# ---------- Chat ----------

def online_user_ids():
    """The ids of everyone with at least one open tab. A set, so two tabs count once."""
    return {client["user_id"] for client in clients.values()}


def users_message():
    """Every account with its profile, each marked online or not:
    [{"id": 3, "name": "axel", "online": True, "avatar": "Xk9...webp", "status": "...", "bio": "..."}, ...]"""
    online = online_user_ids()
    rows = db.execute(
        "SELECT id, username, avatar_id, banner_id, status, bio, is_admin FROM users ORDER BY username COLLATE NOCASE"
    ).fetchall()
    return {
        "type": "users",
        "users": [
            {
                "id": user_id, "name": name, "online": user_id in online,
                "avatar": avatar, "banner": banner, "status": status, "bio": bio, "admin": bool(admin),
            }
            for user_id, name, avatar, banner, status, bio, admin in rows
        ],
    }


def can_join(channel, user_id):
    """May this user join this channel? Normal channels: anyone logged in.
    DMs ("dm:3:7", the two user ids, smallest first): only the two people in it, and only
    while they're friends."""
    if channel in CHANNELS:
        return True
    if not isinstance(channel, str) or not channel.startswith("dm:"):
        return False

    parts = channel.split(":")[1:]  # "dm:3:7" -> ["3", "7"]
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        return False
    first, second = int(parts[0]), int(parts[1])
    if channel != f"dm:{first}:{second}" or first >= second:
        return False  # not the exact shape the page builds (smallest first, no leading zeros)
    if user_id not in (first, second):
        return False  # someone else's DM: never
    other = second if user_id == first else first
    return are_friends(user_id, other)  # (a friendship also means the other person exists)


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
    was_online = user_id in online_user_ids()  # already open in another tab?
    clients[websocket] = {"user_id": user_id, "channel": None}  # no channel until they "join"
    try:
        # Tell the page who it is (the id is for building DM names).
        await send(websocket, {
            "type": "welcome", "id": user_id, "username": username_of(user_id),
            "max_text_length": MAX_TEXT_LENGTH,  # so the page's text box uses the same limit
        })
        await send(websocket, friends_message(user_id))
        await send(websocket, custom_emoji_message())
        await send(websocket, {
            "type": "unread", "channels": unread_channels(user_id), "mentions": unread_mentions(user_id),
        })
        if was_online:
            await send(websocket, users_message())  # just this tab
        else:
            await send_to_everyone(users_message())  # they came online

        while True:
            data = parse_json(await websocket.receive_text())
            if data is None:
                continue  # ignore invalid messages
            kind = data.get("type")
            channel = clients[websocket]["channel"]

            if kind == "join":
                new_channel = data.get("channel")
                if not can_join(new_channel, user_id):
                    continue
                # Switch channel and fetch its history with no await in between,
                # so no message can slip through the gap.
                clients[websocket]["channel"] = new_channel
                history = recent_messages(new_channel)
                mark_read(user_id, new_channel)  # opening a channel means you've seen it
                await send(websocket, {"type": "history", "channel": new_channel, "messages": history})

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
                }
                await send_to_channel(channel, message)  # everyone in the channel, including us
                await announce_new_message(channel, mentioned_people, message)  # read/unread, mentions, notifications

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
                    "SELECT channel, user_id, attachment_id FROM messages WHERE id = ?", (message_id,)
                ).fetchone()
                if row is None:
                    continue
                message_channel, author_id, attachment_id = row
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
                        db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
                        if attachment_id:
                            db.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))
                    if file:  # the file on disk, only once the database change has been saved
                        (UPLOAD_DIR / attachment_id).unlink(missing_ok=True)
                    # (Replies to it keep their reply_to; their quote now says "deleted".)
                    await send_to_channel(message_channel, {
                        "type": "deleted", "channel": message_channel, "message_id": message_id,
                    })

            elif kind == "typing" and channel is not None:
                # Tell the others in this channel; you don't need to see yourself typing.
                await send_to_channel(
                    channel, {"type": "typing", "channel": channel, "name": username_of(user_id)},
                    except_user_id=user_id,
                )
    except WebSocketDisconnect:
        pass
    finally:
        del clients[websocket]
        if user_id not in online_user_ids():  # that was their last tab: they went offline
            await send_to_everyone(users_message())
