"""Small facts about people that every part asks: is this a bot, what's their name, are two people
friends, who blocked whom. Also makes everyone a bot's friend and puts bots in every group, at every start."""

from chatapp.db import db


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


def username_of(user_id):
    row = db.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
    return row[0] if row else None


def is_owner(user_id):
    row = db.execute("SELECT is_owner FROM users WHERE id = ?", (user_id,)).fetchone()
    return bool(row and row[0])


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


def has_blocked(blocker, blocked):
    return db.execute("SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?", (blocker, blocked)).fetchone() is not None


def blockers_of(user_id):
    """Everyone who blocked this person (they don't hear from them)."""
    return {blocker for (blocker,) in db.execute("SELECT blocker_id FROM blocks WHERE blocked_id = ?", (user_id,))}
