"""Admin tools: bans and the owner's admins, the bug reports inbox, and everyone's invites."""

import asyncio

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from chatapp.config import INVITE_DAYS, LANDING_HOST, REQUIRE_INVITE, SECURE_COOKIES
from chatapp.db import BANNED_NOW, db, iso_time
from chatapp.sessions import logged_in_admin, logged_in_user
from chatapp.users import is_owner
from chatapp.connections import clients, disconnect_user
from chatapp.presence import announce_users
from chatapp.voice import remove_from_voice
from chatapp.channels import announce_roles
from chatapp.accounts import (
    INVITE_COOKIE, allow_landing_page, has_people, invite_code, open_invite, record_failure, send_email,
    too_many_failures
)

router = APIRouter()


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


@router.post("/admin/ban")
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


@router.post("/admin/unban")
async def unban(data: UserChoice, request: Request):
    logged_in_admin(request)
    with db:
        db.execute(
            "UPDATE users SET banned_at = NULL, banned_until = NULL, banned_by = NULL, ban_reason = NULL WHERE id = ?",
            (data.user_id,),
        )
    await announce_users()  # back in the lists (they log in again by themselves)
    return ban_list()


@router.get("/admin/bans")
async def bans(request: Request):
    logged_in_admin(request)
    return ban_list()


class AdminChange(BaseModel):
    user_id: int
    admin: bool


@router.post("/admin/admins")
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


@router.get("/invite/{code}")
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


@router.get("/invite-info")
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


# ---------- Feedback: bug reports and ideas (Settings → Feedback) ----------

FEEDBACK_KINDS = {"bug": "Bug report", "idea": "Idea"}
MAX_FEEDBACK_LENGTH = 4000


class Feedback(BaseModel):
    kind: str
    text: str
    app: bool = False  # sent from the Windows app (whose window says it's Edge, so we're told)
    phone: bool = False  # sent from the phone app (mobile/, which says it's "okhttp")


@router.post("/feedback")
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


@router.get("/feedback")
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


@router.post("/feedback/{feedback_id}/done")
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
