"""Settings from the environment (serve.ps1 and start.ps1 load them from .env / dev.env) and the limits
and constants several parts of the server share. Topic-only constants live with their topic."""

import json
import os
import re
import warnings
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image


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
# 95 MB, in bytes. Uploads are one request each, and Cloudflare refuses requests over 100 MB on its
# Free plan before they reach us, so more than this needs uploads split into pieces.
MAX_UPLOAD_SIZE = 95 * 1024 * 1024
MAX_FILENAME_LENGTH = 200
# Only these are shown in the page. They're pure pictures and can't contain scripts.
# Everything else (including SVG, which can) is only ever offered as a download.
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
# Videos are played in the page too: the two formats every browser plays. Like pictures they can't run
# scripts, and we only believe the type if the file's first bytes say so too (is_video).
VIDEO_TYPES = {"video/mp4", "video/webm"}
SHOWN_TYPES = IMAGE_TYPES | VIDEO_TYPES  # served "inline" (shown), not as a download


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
MAX_CUSTOM_EMOJI = 24  # per person
MAX_EMOJI_NAME = 32
EMOJI_NAME_PATTERN = re.compile(rf"[A-Za-z0-9_]{{2,{MAX_EMOJI_NAME}}}")  # ({{ }}: a real { } in an f-string)
for kind in PICTURE_KINDS.values():
    kind["folder"].mkdir(exist_ok=True)
PICTURE_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}

# Animated GIFs arrive uncropped (the browser can't crop an animation), so they may be bigger.
# Images from users are a classic way to attack servers, so Pillow gets limits: file size,
# number of frames, and pixels per frame (a tiny file can claim to be 50,000 x 50,000 pixels:
# a "decompression bomb" that would fill the memory).
MAX_GIF_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_GIF_FRAMES = 200
MAX_CROP_SIDE = 4096  # the crop rectangle's longest allowed side (see check_crop_box)
Image.MAX_IMAGE_PIXELS = 25_000_000  # e.g. 5000 x 5000
# Above that limit Pillow only *warns* (it refuses at twice the limit). Turn the warning into an error.
warnings.simplefilter("error", Image.DecompressionBombWarning)
MAX_STATUS_LENGTH = 60
MAX_BIO_LENGTH = 300
