"""Fetching from the internet: link preview cards (with the SSRF guards) and GIFs from GIPHY."""

import asyncio
import http.client
import ipaddress
import json
import os
import re
import secrets
import socket
import ssl
import time
from html.parser import HTMLParser
from io import BytesIO
from urllib.parse import urlencode, urljoin, urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel

from chatapp.config import MAX_FILENAME_LENGTH, PUBLIC_URL, UPLOAD_DIR
from chatapp.db import db
from chatapp.sessions import current_user
from chatapp.access import can_join
from chatapp.connections import background_tasks, send_to_channel

router = APIRouter()


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


def message_links(text):
    """Every web address in a message, in order and without repeats, as the page shows them
    (static/js/messages.js). Not ones inside `code` or a code block: those are shown as typed, not as links."""
    text = re.sub(r"```[\s\S]*?```|`[^`\n]*`", " ", text)
    links = []
    for match in re.finditer(r"https?://[^\s<]+", text):
        url = match.group()
        # Punctuation at the end belongs to the sentence ("see https://x.com."); a ")" stays if the
        # address has a "(" of its own (like the page's trimUrl).
        while url and (url[-1] in ".,!?:;'\"*~|" or (url[-1] == ")" and url.count(")") > url.count("("))):
            url = url[:-1]
        if url and url not in links:
            links.append(url)
    return links


def first_link(text):
    """The first web address in a message (the one that gets a preview card), or None."""
    links = message_links(text)
    return links[0] if links else None


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


@router.get("/previews/{name}")
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
MAX_GIPHY_FILE = 5 * 1024 * 1024    # the file we save (a few hundred KB as WebP, usually)
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
        if is_giphy_url(image.get("webp")) and int(image.get("webp_size") or 0) <= MAX_GIPHY_FILE:
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


@router.get("/gifs/search")
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


@router.post("/gifs/send")
async def save_gif(choice: GifChoice, request: Request):
    """Download a GIF from GIPHY and save it as an upload of ours. Answers {"id": ...} like /upload,
    and the page then sends it like any file (claim_attachments ties it to the chat)."""
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
    result = await asyncio.to_thread(fetch_url, address, MAX_GIPHY_FILE, "image/webp,image/*")
    if result is None or len(result[2]) > MAX_GIPHY_FILE:
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
