"""Who is logged in: session cookies to user ids, and the checks routes start with
(logged_in_user, logged_in_admin) that answer 401/403 for everyone else."""

from fastapi import HTTPException

from chatapp.config import SESSION_COOKIE, SESSION_DAYS
from chatapp.db import BANNED_NOW, db


def is_admin(user_id):
    """Checked fresh from the database every time, so tools/make_admin.py works straight away."""
    row = db.execute("SELECT is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
    return bool(row and row[0])


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


def logged_in_user(request):
    """(id, username, password_hash, email) of whoever is logged in, or a 401 error."""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    return db.execute(
        "SELECT id, username, password_hash, email FROM users WHERE id = ?", (user_id,)
    ).fetchone()


def logged_in_admin(request):
    """The logged-in admin's id, or an error. The page only shows the inbox to admins, but anyone
    can send a request by hand, so this check on the server is what actually keeps it private."""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    if not is_admin(user_id):
        raise HTTPException(403, "Only admins can do that.")
    return user_id
