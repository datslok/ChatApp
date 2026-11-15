"""Accounts: registering, logging in and out, invites, email verification, password resets and the
account settings (username, email, password, appearance)."""

import hashlib
import json
import secrets
import smtplib
import sqlite3
import ssl
import time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel

from chatapp.config import (
    EMAIL_PATTERN, FAILURE_WINDOW, HEX_COLOUR, INVITE_DAYS, LANDING_HOST, MAIL_FROM, MAX_EMAIL_LENGTH,
    MAX_FAILURES, MAX_OPEN_INVITES, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, PUBLIC_URL, REQUIRE_INVITE,
    RESERVED_NAMES, RESET_MINUTES, SECURE_COOKIES, SESSION_COOKIE, SESSION_DAYS, SMTP_HOST, SMTP_PASSWORD,
    SMTP_PORT, SMTP_USER, USERNAME_PATTERN, VERIFY_HOURS
)
from chatapp.db import BANNED_NOW, db, iso_time
from chatapp.sessions import current_user, logged_in_admin, logged_in_user, session_user, unverified_user
from chatapp.users import befriend_bots
from chatapp.connections import disconnect_user, send_to_everyone, send_to_user
from chatapp.presence import announce_users

router = APIRouter()


# ---------- Accounts and sessions ----------

# Hashes passwords with argon2 (the argon2-cffi package): slow on purpose, so guessing is slow too.
hasher = PasswordHasher()


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


@router.post("/register")
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


@router.post("/login")
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


@router.get("/whoami")
async def whoami(request: Request, response: Response):
    """For the landing page: who's logged in in this browser, if anyone. Only the name and picture."""
    allow_landing_page(request, response)
    response.headers["Cache-Control"] = "no-store"  # different for everyone: never keep a copy
    user_id = current_user(request)
    if user_id is None:
        return {"username": None}
    username, avatar = db.execute("SELECT username, avatar_id FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"username": username, "avatar": f"{PUBLIC_URL}/avatars/{avatar}" if avatar else None}


@router.post("/logout")
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


@router.post("/forgot")
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


@router.post("/reset")
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


@router.get("/verify")
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


@router.get("/verify-email")
async def verify_page():
    return FileResponse("static/verify.html", headers={"Cache-Control": "no-cache"})


@router.get("/verify/status")
async def verify_status(request: Request):
    """For the verify page: who's logged in in this browser, and whether their email is verified."""
    row = session_user(request.cookies.get(SESSION_COOKIE))
    if row is None:
        return {"logged_in": False}
    username, email, pending = db.execute(
        "SELECT username, email, pending_email FROM users WHERE id = ?", (row[0],)
    ).fetchone()
    return {"logged_in": True, "verified": row[1] == 1, "username": username, "email": email, "pending_email": pending}


@router.post("/verify/resend")
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


@router.post("/verify/change")
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


@router.get("/invites")
async def list_invites(request: Request):
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")
    return {"invites": my_invites(user_id), "days": INVITE_DAYS}


@router.post("/invites")
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


@router.post("/invites/{code}/cancel")
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


@router.get("/admin/invites")
async def admin_invites(request: Request):
    logged_in_admin(request)  # (admins only: the server's check is what counts, not the hidden tab)
    return all_invites()


@router.post("/admin/invites/{code}/cancel")
async def admin_cancel_invite(code: str, request: Request):
    """Cancel anyone's unused link (a link posted somewhere it shouldn't be, say)."""
    logged_in_admin(request)
    with db:
        db.execute("DELETE FROM invites WHERE code = ? AND used_by IS NULL", (code,))
    return all_invites()


INVITE_COOKIE = "invite"


def invite_code(given, request):
    """The invite to use: one in the address or the form (old-style links), else the one the browser
    has kept since its invite link was opened (the "invite" cookie, see open_invite_link)."""
    return given.strip() or request.cookies.get(INVITE_COOKIE, "")


# ---------- Settings (logged in) ----------


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


@router.get("/me")
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


@router.post("/settings/email")
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


@router.post("/settings/email/cancel")
async def cancel_email_change(request: Request):
    """Settings: forget the new address that was waiting for its link."""
    user_id = logged_in_user(request)[0]
    cancel_pending_email(user_id)
    return {"ok": True}


class UsernameChange(BaseModel):
    username: str
    password: str


@router.post("/settings/username")
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


@router.post("/settings/password")
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


# ---------- Appearance (Settings → Appearance): theme, colours and font ----------
#
# Kept with the account, so it's the same on every device. (The text size and the Windows app's scale
# are each device's own, kept by the pages themselves: the user's wish.) The page (static/js/appearance.js)
# puts these values into its CSS, so only names from these lists and real colours get in: without
# that check, anyone could put any text into their own page's styles with a hand-made request.

APPEARANCE_THEMES = {"dark", "darker", "light", "blue", "purple", "green", "pink", "lightpink"}
APPEARANCE_FONTS = {"system", "calibri", "georgia", "consolas", "comic"}
# The colours with a picker: names of the CSS variables in chat.css (without the "--").
APPEARANCE_COLOURS = {"bg-main", "bg-panel", "text", "text-muted", "accent", "link"}


class Appearance(BaseModel):
    theme: str = "dark"
    colours: dict[str, str] = {}  # only the ones picked by hand: {"accent": "#e91e63"}
    font: str = "system"
    # (Older pages also send font_size and scale: pydantic ignores fields that aren't here.)


def appearance_of(user_id):
    """Someone's saved appearance as a dict, or None if they never changed it."""
    saved = db.execute("SELECT appearance FROM users WHERE id = ?", (user_id,)).fetchone()[0]
    return json.loads(saved) if saved else None


@router.post("/settings/appearance")
async def change_appearance(data: Appearance, request: Request):
    user_id, username, password_hash, email = logged_in_user(request)
    if data.theme not in APPEARANCE_THEMES:
        raise HTTPException(400, "Unknown theme.")
    if data.font not in APPEARANCE_FONTS:
        raise HTTPException(400, "Unknown font.")
    for name, colour in data.colours.items():
        if name not in APPEARANCE_COLOURS or not HEX_COLOUR.fullmatch(colour):
            raise HTTPException(400, "Unknown colour.")
    # The checked values, back as a plain dict, on top of what was saved: settings saved before the text
    # size and scale went per device have those too, and they stay for pages and phone apps from before,
    # which would otherwise reset them to the defaults (new ones ignore them, appearance.js).
    appearance = {**(appearance_of(user_id) or {}), **data.model_dump()}
    with db:
        db.execute("UPDATE users SET appearance = ? WHERE id = ?", (json.dumps(appearance), user_id))
    # Every open page of theirs (this one too, which already shows it): the app, their phone.
    await send_to_user(user_id, {"type": "appearance", "appearance": appearance})
    return {"ok": True}
