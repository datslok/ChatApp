import asyncio
import hashlib
import hmac
import json
import secrets
import smtplib
import sqlite3
import ssl
import time
import urllib.request
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.websockets import WebSocketDisconnected

import chatapp.pages
import chatapp.files
import chatapp.web
import chatapp.presence
import chatapp.push
import chatapp.emoji
from chatapp.config import (
    ALLOWED_EMOJI, EMAIL_PATTERN, FAILURE_WINDOW, HEX_COLOUR, HISTORY_LIMIT, IMAGE_TYPES, INVITE_DAYS,
    LANDING_HOST, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, MAIL_FROM, MAX_BIO_LENGTH, MAX_CHANNELS,
    MAX_CHANNEL_NAME, MAX_CUSTOM_EMOJI, MAX_EMAIL_LENGTH, MAX_EMOJI_NAME, MAX_FAILURES, MAX_GIF_SIZE,
    MAX_OPEN_INVITES, MAX_PASSWORD_LENGTH, MAX_STATUS_LENGTH, MAX_TEXT_LENGTH, MAX_UPLOAD_SIZE,
    MIN_PASSWORD_LENGTH, PICTURE_EXTENSIONS, PICTURE_KINDS, PUBLIC_URL, REQUIRE_INVITE, RESERVED_NAMES,
    RESET_MINUTES, SECURE_COOKIES, SESSION_COOKIE, SESSION_DAYS, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT,
    SMTP_USER, USERNAME_PATTERN, VAPID_PUBLIC_KEY, VERIFY_HOURS
)
from chatapp.db import BANNED_NOW, db, iso_time
from chatapp.sessions import (
    current_user, is_admin, logged_in_admin, logged_in_user, session_user, unverified_user,
    user_id_from_token
)
from chatapp.users import (
    are_friends, befriend_bots, blockers_of, friends_message, friendship, has_blocked, is_bot, is_owner,
    pair, username_of
)
from chatapp.access import (
    can_join, can_mute, channel_list, dm_people, group_members, group_people, group_title, is_channel,
    is_dm_member, is_dm_or_group, is_group_member, may_see_channel, may_use_lounge
)
from chatapp.connections import (
    NONCE_MEMORY, clients, device_of, disconnect_user, message_nonce, recent_nonces, send, send_to_channel,
    send_to_everyone, send_to_user
)
from chatapp.pages import FreshStaticFiles, LastingStaticFiles, PAGE_VERSION, current_season
from chatapp.files import (
    MAX_FILES_PER_MESSAGE, THUMB_SIZES, claim_attachments, delete_upload, receive_picture, start_repacking
)
from chatapp.web import PREVIEW_DIR, delete_preview, start_preview
from chatapp.presence import (
    IDLE_MINUTES_CHOICES, PRESENCES, announce_presences, announce_users, clean_activity, idle_minutes_of,
    phones_away, presence_of, start_watching_presences, users_for, users_message
)
from chatapp.push import base64url, clear_on_phones, firebase_account, push_in_background, push_message
from chatapp.messages import (
    CHAT_INFO_TABS, MAX_PINS, announce_new_message, chat_activity_message, chat_info, check_reply,
    clean_text, delete_messages_in, expand_mentions, live_reply_preview, mark_read, messages_around,
    mutes_message, newer_messages, parse_json, pinned_chats_message, pinned_messages, reactions_for,
    recent_messages, save_mentions, save_message, search_messages, unread_channels, unread_mentions,
    with_files
)
from chatapp.emoji import custom_emoji_exists, custom_emoji_message, expand_custom_emoji


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


# Each topic's routes (chatapp/*.py: each makes an APIRouter, a bundle of routes, that's added here).
app.include_router(chatapp.pages.router)
app.include_router(chatapp.files.router)
app.include_router(chatapp.web.router)
app.include_router(chatapp.presence.router)
app.include_router(chatapp.push.router)
app.include_router(chatapp.emoji.router)

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


hasher = PasswordHasher()


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


# ---------- Profiles ----------

# Profile pictures and banners work the same way; `kind` ("avatar" or "banner") picks the
# column, folder and size limit from PICTURE_KINDS. The column names in the SQL below come from
# that table of ours, never from a request, so putting them into the SQL text is safe.


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
    # The checked values, back as a plain dict, on top of what was saved: settings saved before the text
    # size and scale went per device have those too, and they stay for pages and phone apps from before,
    # which would otherwise reset them to the defaults (new ones ignore them, appearance.js).
    appearance = {**(appearance_of(user_id) or {}), **data.model_dump()}
    with db:
        db.execute("UPDATE users SET appearance = ? WHERE id = ?", (json.dumps(appearance), user_id))
    # Every open page of theirs (this one too, which already shows it): the app, their phone.
    await send_to_user(user_id, {"type": "appearance", "appearance": appearance})
    return {"ok": True}


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


# ---------- Friends ----------


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
    clear_on_phones(me, "friends")
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
    clear_on_phones(me, "friends")  # (a declined request; harmless for the other two)
    await send_friends_update(me, other)
    return {"ok": True}


# ---------- Blocking ----------
#
# Blocking someone ends the friendship (and any request), so DMs, group invites and DM calls stop:
# all of those need friends. They can't send a new request; they never count as mentioning us
# (save_mentions: no notifications, counts or pushes) and their calls don't ring us; their messages in
# chats we share are hidden on our page, and left out of our searches. They aren't told. Admins
# can't be blocked (the chat's rule), nor bots (they're everyone's friend, at every start).


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
        db.execute("DELETE FROM pinned_chats WHERE user_id = ? AND channel = ?", (user_id, key))
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


# ---------- Voice ----------

VOICE_ROOMS = ["lounge"]  # voice channels anyone logged in can join (DM calls use the DM's name)
VOICE_TOKEN_LIFETIME = 10 * 60  # seconds: only needed to get in; LiveKit renews it after that


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
    message_id, sent_at = save_message(channel, call["caller"], text, [], None, kind="call")
    message = with_files({
        "type": "message", "channel": channel, "id": message_id, "sent_at": sent_at,
        "user_id": call["caller"], "name": username_of(call["caller"]), "text": text,
        "reply": None, "reactions": [], "edited_at": None, "kind": "call", "pinned": False,
    }, [])
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


# The limits the pages need to know (to grey out a button or say "too big" before trying), sent
# in "welcome" so this file is the only place they're written. The server still checks each one
# itself: a page's copy is only for being friendly.
LIMITS = {
    "custom_emoji": MAX_CUSTOM_EMOJI,
    "emoji_name": MAX_EMOJI_NAME,
    "upload_size": MAX_UPLOAD_SIZE,
    "files_per_message": MAX_FILES_PER_MESSAGE,  # (also how many files the tray holds)
    "gif_size": MAX_GIF_SIZE,  # profile pictures, banners and emoji (they come whole)
    "image_types": sorted(IMAGE_TYPES),  # (a set isn't JSON)
    "thumb_sizes": THUMB_SIZES,  # the ?size= a picture can be asked for (see "Thumbnails")
    "group_size": MAX_GROUP_SIZE,
    "channel_name": MAX_CHANNEL_NAME,  # also group names
    "role_name": MAX_ROLE_NAME,
    "status": MAX_STATUS_LENGTH,
    "bio": MAX_BIO_LENGTH,
    "ban_reason": MAX_BAN_REASON,
    "feedback": MAX_FEEDBACK_LENGTH,
    "idle_minutes": IDLE_MINUTES_CHOICES,  # Settings → Notifications' choices (see "Away from the PC")
}


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
    # The first connection since the server started starts watching for idle, and re-packs older videos
    # once (see "Re-packing videos"); later ones find them running.
    start_watching_presences()
    start_repacking()
    # No channel until they "join", no voice room until they say they joined one.
    clients[websocket] = {"user_id": user_id, "channel": None, "voice": None, "muted": False, "deafened": False,
                          "looking": False,  # looking at it right now (the page says, see "looking")
                          "away_since": time.time(),  # since when it isn't (None while it is): for "idle"
                          "app": False,      # the Windows app (the page says so in "looking" too)
                          "pc_idle": False,  # nobody at that PC for a while ("looking" too; "Away from the PC")
                          "mobile": False,   # a phone (in "looking" too): see on_phone_only
                          "android": False,  # the Android app, not a phone's browser ("looking" too): device_of
                          "bot": is_bot(user_id),  # a bot gets each message's device (see send)
                          "activity": None,  # what they're doing, if this page says (see "activity")
                          "stuck": False,    # not reading what we send: given up on (see "Stuck connections")
                          "task": asyncio.current_task()}  # this chat() call, for stopping it then
    try:
        # Tell the page who it is (the id is for building DM names).
        await send(websocket, {
            "type": "welcome", "id": user_id, "username": username_of(user_id),
            "max_text_length": MAX_TEXT_LENGTH,  # so the page's text box uses the same limit
            "limits": LIMITS,  # the other limits the pages need (see LIMITS)
            "page_version": PAGE_VERSION,  # a different one than it was loaded with: it reloads
            "appearance": appearance_of(user_id),  # Settings → Appearance (None: the defaults)
            "presence": presence_of(user_id),  # the status they chose (the others may see another: users)
            "idle_minutes": idle_minutes_of(user_id),  # away from the PC after (see "Away from the PC")
            "vapid_public_key": VAPID_PUBLIC_KEY or None,  # for subscribing to push (None: not set up)
            "phone_push": firebase_account is not None,  # can the phone app get pushes (FCM)?
            "season": current_season(),  # the seasonal easter egg ("Seasons"; None: none now)
        })
        await send(websocket, channels_message(user_id))  # (they may have changed while away)
        await send(websocket, friends_message(user_id))
        await send(websocket, groups_message(user_id))
        await send(websocket, mutes_message(user_id))
        await send(websocket, pinned_chats_message(user_id))  # (see "Recent and pinned DMs")
        await send(websocket, chat_activity_message(user_id))
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

            if kind == "ping":
                # {"type": "ping"}: the app checking the connection still works (a bad network can kill
                # it without either end hearing). The answer proves it does.
                await send(websocket, {"type": "pong"})

            elif kind == "join":
                new_channel = data.get("channel")
                if new_channel is None:
                    # Looking at no channel (the Friends page): new messages anywhere count as unread.
                    clients[websocket]["channel"] = None
                    if clients[websocket]["looking"]:
                        clear_on_phones(user_id, "friends")  # (the friend requests are on that page)
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
                # Seen, if the page is in sight (a page in the background also rejoins after a dropped
                # connection: then it's when they look at it, "looking" below).
                if clients[websocket]["looking"]:
                    clear_on_phones(user_id, new_channel)
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

            elif kind in ("around", "newer") and channel is not None:
                # {"type": "around", "id": 1234}: jumping to message 1234, far up: the messages around it
                # (messages_around). {"type": "newer", "after": 1234}: scrolling down from there, the next
                # batch. Checked like "older".
                number = data.get("id" if kind == "around" else "after")
                if not isinstance(number, int) or isinstance(number, bool) or not 0 < number < 2**63:
                    continue
                if not can_join(channel, user_id):
                    continue
                if kind == "around":
                    stretch, more, newer = messages_around(channel, number)
                    await send(websocket, {"type": "around", "channel": channel, "id": number,
                                           "messages": stretch, "more": more, "newer": newer})
                else:
                    batch = newer_messages(channel, number)
                    await send(websocket, {"type": "newer", "channel": channel, "messages": batch,
                                           "newer": len(batch) == HISTORY_LIMIT})

            elif kind == "message" and (channel is not None or data.get("channel") is not None):
                # The chat we're in, or the one the message names (the app's outbox sends a message again
                # after a reconnect, from whatever chat is open by then). Checked again, not just when
                # joining: a DM stops being allowed the moment the friendship ends, even if this tab is still showing it.
                if data.get("channel") is not None:
                    channel = data.get("channel")
                # A tag (the app's outbox): seen before means it's saved already, so only confirm it again.
                nonce = message_nonce(data)
                now = time.time()
                for key in [key for key, (_, _, when) in recent_nonces.items() if now - when > NONCE_MEMORY]:
                    del recent_nonces[key]
                if nonce is not None and (user_id, nonce) in recent_nonces:
                    message_id, sent_channel, _ = recent_nonces[(user_id, nonce)]
                    await send(websocket, {"type": "sent", "nonce": nonce, "id": message_id, "channel": sent_channel})
                    continue
                text = clean_text(data) if can_join(channel, user_id) else None
                # The files: "files", a list of upload ids; or "file", one (from before several per message).
                # (An empty list is no files: the phone app sends "files": [] with every text message.)
                file_ids = data.get("files") if data.get("file") is None else [data.get("file")]
                files = []
                if text is not None and file_ids not in (None, []):
                    files = claim_attachments(file_ids, user_id, channel)  # (None: not theirs, already sent, gone)
                if text is None or files is None or (not text and not files):
                    # Refused (or nothing to send): an outbox's message shows as not sent straight away.
                    if nonce is not None:
                        await send(websocket, {"type": "not_sent", "nonce": nonce})
                    continue
                text = expand_custom_emoji(text)  # :pog: -> <:17>
                text, mentioned, everyone = expand_mentions(text)  # @kari -> <@2>
                reply_to = check_reply(data.get("reply_to"), channel)
                sent_from = device_of(clients[websocket])
                message_id, sent_at = save_message(channel, user_id, text, files, reply_to, sent_from=sent_from)
                mentioned_people = save_mentions(message_id, channel, user_id, mentioned, everyone)
                # The name comes from the login (looked up now, so it's always the current one),
                # never from the client.
                message = with_files({
                    "type": "message", "channel": channel, "id": message_id, "sent_at": sent_at,
                    "user_id": user_id, "name": username_of(user_id), "text": text,
                    "reply": live_reply_preview(reply_to),
                    "reactions": [],  # a brand new message has none yet
                    "edited_at": None,
                    "kind": None,
                    "pinned": False,
                    "preview": None,  # a link's preview comes a moment later, as its own "preview"
                    "nonce": nonce,  # the app's tag (or None): its faded copy in the outbox goes as this comes
                    "sent_from": sent_from,  # (bots only, see send)
                }, files)
                await send_to_channel(channel, message)  # everyone in the channel, including us
                if nonce is not None:
                    # Saved: tell the page that sent it (even if it's in another chat by now), with its tag.
                    recent_nonces[(user_id, nonce)] = (message_id, channel, now)
                    await send(websocket, {"type": "sent", "nonce": nonce, "id": message_id, "channel": channel})
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
                row = db.execute("SELECT channel, user_id, kind FROM messages WHERE id = ?", (message_id,)).fetchone()
                if row is None:
                    continue
                message_channel, author_id, message_kind = row
                file_ids = [file_id for (file_id,) in db.execute(
                    "SELECT id FROM attachments WHERE message_id = ?", (message_id,))]
                if kind == "edit" and message_kind is not None:
                    continue  # call notes are written by the server, not edited
                if not can_join(message_channel, user_id):
                    continue  # a message we can't even see
                if author_id != user_id and not is_admin(user_id):
                    continue  # only your own messages, unless you're an admin

                if kind == "edit":
                    text = clean_text(data)
                    if text is None or (not text and not file_ids):
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
                    with db:
                        db.execute("DELETE FROM reactions WHERE message_id = ?", (message_id,))
                        db.execute("DELETE FROM mentions WHERE message_id = ?", (message_id,))
                        preview_image = delete_preview(message_id)
                        db.execute("DELETE FROM attachments WHERE message_id = ?", (message_id,))
                        db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
                    for file_id in file_ids:  # the files on disk, only once the database change has been saved
                        delete_upload(file_id)
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
                    note_id, sent_at = save_message(message_channel, user_id, "📌 pinned a message.", [], message_id, kind="pin")
                    await send_to_channel(message_channel, with_files({
                        "type": "message", "channel": message_channel, "id": note_id, "sent_at": sent_at,
                        "user_id": user_id, "name": username_of(user_id), "text": "📌 pinned a message.",
                        "reply": live_reply_preview(message_id), "reactions": [],
                        "edited_at": None, "kind": "pin", "pinned": False, "preview": None,
                    }, []))
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

            elif kind == "chat_info" and channel is not None:
                # {"type": "chat_info", "tab": "media" | "files" | "links", "before": a message id or null}:
                # the chat info panel of the DM or group we're in ("Chat info" above). The answer
                # repeats tab and before, so the page knows which question it answers.
                tab = data.get("tab")
                before = data.get("before")
                if not isinstance(before, int) or isinstance(before, bool):  # (True is an int in Python)
                    before = None
                if tab in CHAT_INFO_TABS and is_dm_or_group(channel) and can_join(channel, user_id):
                    await send(websocket, {"type": "chat_info", "channel": channel, "tab": tab, "before": before,
                                           **chat_info(channel, tab, before)})

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
                looking_changed = looking != clients[websocket]["looking"]
                if looking_changed:
                    clients[websocket]["away_since"] = None if looking else time.time()
                clients[websocket]["looking"] = looking
                clients[websocket]["app"] = data.get("app") is True  # (then no pushes at all: has_app_open)
                clients[websocket]["android"] = data.get("android") is True
                # "idle": the Windows app's keyboard and mouse unused for the person's minutes (only the app can tell)
                pc_idle = data.get("idle") is True and clients[websocket]["app"]
                idle_changed = pc_idle != clients[websocket]["pc_idle"]
                clients[websocket]["pc_idle"] = pc_idle
                mobile = data.get("mobile") is True
                phone_changed = mobile != clients[websocket]["mobile"]
                clients[websocket]["mobile"] = mobile
                # A phone back after its connection closed while locked: this connection takes over. Still
                # away (Android woke it in the background)? Then away since it was locked, not since now.
                left_at = phones_away.pop(user_id, None) if mobile else None
                if left_at is not None and not looking:
                    clients[websocket]["away_since"] = min(left_at, clients[websocket]["away_since"] or left_at)
                if looking_changed or phone_changed or idle_changed:
                    await announce_presences()  # back from idle, a phone locked (idle), now known to be a phone
                if looking and not pc_idle:  # back at the page: the chat on it has been seen (or the People page)
                    clear_on_phones(user_id, clients[websocket]["channel"] or "friends")

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

            elif kind == "pin_chat":
                # {"type": "pin_chat", "channel": "dm:3:7", "pinned": true}: pin a DM or group to the top of
                # our list (or unpin it). All our pages hear the new list.
                chat = data.get("channel")
                if not is_dm_or_group(chat):
                    continue
                if data.get("pinned") is True:
                    if not can_join(chat, user_id):
                        continue  # not a chat of theirs
                    with db:
                        db.execute("INSERT OR IGNORE INTO pinned_chats (user_id, channel) VALUES (?, ?)", (user_id, chat))
                else:
                    with db:
                        db.execute("DELETE FROM pinned_chats WHERE user_id = ? AND channel = ?", (user_id, chat))
                await send_to_user(user_id, pinned_chats_message(user_id))

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
    except (WebSocketDisconnect, WebSocketDisconnected):
        pass  # closed (WebSocketDisconnected: a send to it had already failed, so starlette knew first)
    except asyncio.CancelledError:
        if not clients[websocket]["stuck"]:
            raise  # (the server is shutting down)
        # send() gave up on it (see "Stuck connections"): it ends here, cleaned up below.
    finally:
        voice_room = clients[websocket]["voice"]
        gone = clients.pop(websocket)
        # A phone's connection closing while it was locked or left (Android cuts it): still idle for a
        # while, from when it was locked (see "Statuses"). Not when it closed with the app on screen (logging
        # out, a dropped network in use: back in a moment, or really gone).
        if gone["mobile"] and gone["away_since"] is not None:
            phones_away[user_id] = max(gone["away_since"], phones_away.get(user_id, 0))
        await announce_presences()  # their last tab: they went offline (or another tab of theirs decides now)
        if voice_room in VOICE_ROOMS:  # closed the tab while in voice: they're out
            await announce_voice_members()
        if is_private_room(voice_room):  # ...or out of a DM's or group's call
            await announce_dm_call(voice_room)
        if voice_room in calls:
            await check_call(voice_room)
