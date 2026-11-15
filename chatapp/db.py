"""The database: one SQLite connection (`db`) for the whole server, every table, and the migrations that
bring an older chat.db up to date. All of it runs once, when the server starts (at import)."""

import sqlite3

from chatapp.config import DATABASE_FILE, UPLOAD_DIR


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
        reply_to      INTEGER REFERENCES messages(id),  -- the message this one replies to; NULL = none
        edited_at     TEXT,                             -- when it was last edited; NULL = never
        kind          TEXT,                             -- NULL = a normal message, "call" = a call note, "pin" = a pin note
        pinned_at     TEXT,                             -- when it was pinned; NULL = not pinned
        pinned_by     INTEGER REFERENCES users(id),     -- who pinned it
        sent_from     TEXT                              -- the device (see device_of); NULL = unknown
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
        created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        message_id   INTEGER REFERENCES messages(id),  -- the message it's in; NULL until it's sent
        position     INTEGER NOT NULL DEFAULT 0        -- its place among that message's files (0 = first)
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
# highest in the list colours their name and places them in the member list (see channels.py, "Roles").
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
# Blocked people: one row per person someone blocked (see people.py, "Blocking").
db.execute("""
    CREATE TABLE IF NOT EXISTS blocks (
        blocker_id INTEGER NOT NULL REFERENCES users(id),  -- who blocked
        blocked_id INTEGER NOT NULL REFERENCES users(id),  -- whom
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (blocker_id, blocked_id)
    )
""")
# Muted chats: one row per person per chat they muted (the 🔔 at the top of a chat; see messages.py, "Muting").
db.execute("""
    CREATE TABLE IF NOT EXISTS chat_mutes (
        user_id INTEGER NOT NULL REFERENCES users(id),
        channel TEXT NOT NULL,  -- a channel's key, a DM ("dm:3:7") or a group ("g:...")
        PRIMARY KEY (user_id, channel)
    )
""")
# Pinned DMs and groups: one row per person per chat they pinned to the top of their list (see
# messages.py, "Recent and pinned DMs").
db.execute("""
    CREATE TABLE IF NOT EXISTS pinned_chats (
        user_id INTEGER NOT NULL REFERENCES users(id),
        channel TEXT NOT NULL,  -- a DM ("dm:3:7") or a group ("g:...")
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
if "name" in table_columns("messages") and "attachment_id" not in table_columns("messages"):
    # From before uploads existed (and user ids: migrate_names_to_ids below copies this column, and
    # "Several files per message" further down then moves it into the attachments table).
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

if "sent_from" not in table_columns("messages"):
    # From before devices were remembered: we don't know where older messages were sent from (NULL).
    with db:
        db.execute("ALTER TABLE messages ADD COLUMN sent_from TEXT")

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
    # The owner (see admin.py, "Bans and admins"): the first account, which made the server. On a server from
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

if "idle_minutes" not in table_columns("users"):
    # Away from the PC (see presence.py, "Statuses"): after how many minutes without the keyboard or mouse the
    # Windows app counts as left alone. Everyone starts with 10.
    with db:
        db.execute("ALTER TABLE users ADD COLUMN idle_minutes INTEGER NOT NULL DEFAULT 10")

# Private channels and limited roles (see channels.py, "Who sees which channel").
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


# The attachments table's later columns (see "Re-packing videos" and "Removing metadata" in files).
if "repacked" not in table_columns("attachments"):
    # 1 once a video has been through repack_video (whether or not it needed it), so each is done once.
    with db:
        db.execute("ALTER TABLE attachments ADD COLUMN repacked INTEGER NOT NULL DEFAULT 0")
if "cleaned" not in table_columns("attachments"):
    # 1 once a picture's or video's metadata has been removed (or tried: see files.py, "Removing metadata"). Files
    # from before are 0, cleaned once by clean_old_uploads.
    with db:
        db.execute("ALTER TABLE attachments ADD COLUMN cleaned INTEGER NOT NULL DEFAULT 0")
if "audio" not in table_columns("attachments"):
    # A video's sound (has_audio): 1 has some, 0 is silent, NULL not known (yet: repack_old_videos asks).
    with db:
        db.execute("ALTER TABLE attachments ADD COLUMN audio INTEGER")

# Several files per message: from before, when a message had at most one file, in messages.attachment_id.
# That's a "one-to-many" relationship now, so the reference is turned around: each file says which
# message it's in (attachments.message_id) and where in its list (position). Done in one transaction:
# add the columns, copy every message's file across, drop the old column. (After every other change to
# these tables above: migrate_names_to_ids rebuilds both and would drop the new columns again.)
if "message_id" not in table_columns("attachments") or "attachment_id" in table_columns("messages"):
    with db:
        db.execute("BEGIN")
        if "message_id" not in table_columns("attachments"):
            db.execute("ALTER TABLE attachments ADD COLUMN message_id INTEGER REFERENCES messages(id)")
            db.execute("ALTER TABLE attachments ADD COLUMN position INTEGER NOT NULL DEFAULT 0")
        if "attachment_id" in table_columns("messages"):
            # UPDATE ... FROM: like a JOIN, each file gets the id of the message that named it.
            db.execute("UPDATE attachments SET message_id = messages.id FROM messages"
                       " WHERE messages.attachment_id = attachments.id")
            db.execute("ALTER TABLE messages DROP COLUMN attachment_id")
# An index: a sorted lookup SQLite keeps next to the table, so "the files of message 42" doesn't read them all.
db.execute("CREATE INDEX IF NOT EXISTS attachments_message ON attachments (message_id, position)")


def iso_time(sqlite_time):
    """SQLite stores times as "2026-10-10 14:03:12" (in UTC, but without saying so). Browsers would
    read that as *local* time. "2026-10-10T14:03:12Z" is the standard (ISO 8601) way to write it:
    the Z means UTC, and every browser understands it."""
    return sqlite_time.replace(" ", "T") + "Z"
