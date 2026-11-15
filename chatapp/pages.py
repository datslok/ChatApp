"""The pages themselves: the chat page, login and the other HTML pages, the static files, the landing
page, the seasonal easter egg's videos, downloads and the phone app's updates."""

import hashlib
import json
import re
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from chatapp.config import LANDING_HOST, PUBLIC_URL, RELEASES_DIR
from chatapp.sessions import current_user, unverified_user

router = APIRouter()


# ---------- Pages ----------

@router.get("/")
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


@router.get("/welcome")
async def welcome():
    # The landing page on any address: for trying it out, and for linking to.
    return landing_page()


@router.get("/login")
async def login_page(request: Request):
    if current_user(request) is not None:
        return RedirectResponse("/")  # already logged in: straight to the chat
    if unverified_user(request) is not None:
        return RedirectResponse("/verify-email")  # (logged in, waiting for the email's link)
    return FileResponse("static/login.html")


@router.get("/reset")
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


@router.get("/seasonal/{name}")
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


@router.get("/favicon.ico")
async def favicon():
    # The icon in the browser tab. Browsers ask for /favicon.ico by themselves, on every page.
    # (A copy of the desktop app's desktop/src-tauri/icons/icon.ico.)
    return FileResponse("static/favicon.ico", headers={"Cache-Control": "public, max-age=86400"})


# The phone app: the chat installed as a PWA. The manifest gives its name, icons and look
# (static/icons/ from tools/make_pwa_icons.py); the service worker has to be at the top level,
# /sw.js, to look after every page of the site. No login needed: nothing private in them.
@router.get("/manifest.json")
async def manifest():
    return FileResponse("static/manifest.json", media_type="application/manifest+json",
                        headers={"Cache-Control": "no-cache"})


@router.get("/sw.js")
async def service_worker():
    return FileResponse("static/sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


def page_version():
    """A fingerprint of the chat page's files: a hash (SHA-256) of all of them together. Change
    one letter in any of them and it comes out completely different. Each page gets it in its
    "welcome"; after a deploy that changed the page, the pages that reconnect see a new one and
    reload themselves (core.js, reloadIfOutdated). Changes to this file alone don't count."""
    files = [Path("static/index.html"), Path("static/voice-gate.js"), Path("static/voice-denoiser.js"), Path("static/app-audio.js"),
             Path("static/changelog.json"),
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


@router.get("/emoji.json")
async def emoji_list():
    # All emoji for the picker. They never change while the server runs, so browsers may keep it for a day.
    return FileResponse("static/emoji.json", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/changelog.json")
async def changelog():
    # Settings -> What's new. "no-cache" (check first), so a new entry shows up straight after a deploy.
    return FileResponse("static/changelog.json", headers={"Cache-Control": "no-cache"})


# LiveKit's browser library (voice), one fixed version from npm (see CLAUDE.md). A new version gets
# a new file name, so this address never changes its contents and browsers may keep it for a week.
LIVEKIT_CLIENT_FILE = "livekit-client-2.22.3.umd.js"


@router.get("/voice-gate.js")
async def voice_gate():
    # The noise gate for voice, which the page loads into the browser's audio engine (an AudioWorklet).
    # "no-cache" (check first), like the page's other files: without a Cache-Control, browsers guess
    # how long to keep it, and an app kept an old gate for days after it changed (2026-10-14).
    return FileResponse("static/voice-gate.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@router.get("/app-audio.js")
async def app_audio():
    # The shared program's sound in the Windows app (video.js): another AudioWorklet, like the gate.
    return FileResponse("static/app-audio.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@router.get("/voice-denoiser.js")
async def voice_denoiser():
    # Noise suppression "On" (voice.js): our AudioWorklet around RNNoise, with its cap. Always checked
    # for changes, like the gate.
    return FileResponse("static/voice-denoiser.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@router.get("/jitsi-rnnoise-0.2.1/rnnoise-sync.js")
async def rnnoise():
    # RNNoise 0.2, the AI noise filter voice-denoiser.js imports: compiled to WebAssembly, inside this
    # script as text, from npm's @jitsi/rnnoise-wasm 0.2.1 (see CLAUDE.md). The version is in the
    # address, so browsers may keep it for a week (it's ~1.9 MB).
    return FileResponse("static/jitsi-rnnoise-0.2.1/rnnoise-sync.js", media_type="text/javascript",
                        headers={"Cache-Control": "public, max-age=604800"})


@router.get("/" + LIVEKIT_CLIENT_FILE)
async def livekit_client():
    return FileResponse("static/" + LIVEKIT_CLIENT_FILE, media_type="text/javascript",
                        headers={"Cache-Control": "public, max-age=604800"})


@router.get("/download")
async def download_page():
    # "Get the Windows app". No login needed.
    return FileResponse("static/download.html")


@router.get("/download/windows")
async def download_windows():
    # A link that never changes: sends the browser on to the newest installer, the one latest.json names.
    try:
        latest = json.loads((RELEASES_DIR / "latest.json").read_text())
        url = latest["platforms"]["windows-x86_64"]["url"]
    except (OSError, ValueError, KeyError):  # no latest.json yet, or not the shape we expect
        raise HTTPException(404, "No Windows version has been released yet.")
    return RedirectResponse(url, status_code=302)


@router.get("/download/android")
async def download_android():
    # The same for the phone app: the newest APK, the one android.json names (scripts\app-release.ps1).
    try:
        latest = json.loads((RELEASES_DIR / "android.json").read_text())
        apk = latest["apk"]
    except (OSError, ValueError, KeyError):
        raise HTTPException(404, "No Android version has been released yet.")
    return RedirectResponse(f"/releases/{quote(apk)}", status_code=302)


@router.get("/.well-known/assetlinks.json")
async def asset_links():
    # Android App Links: the phone app claims the chat's links (https://chat.example.com/?channel=..),
    # so they open in the app instead of the browser. Android only lets an app do that if the website
    # agrees, by naming the app here: its package and the fingerprint of the key that signs it. Android
    # fetches this once, when the app is installed. Both come from android.json (scripts\app-release.ps1),
    # so every server names its own build of the app.
    try:
        latest = json.loads((RELEASES_DIR / "android.json").read_text())
        package, fingerprint = latest["package"], latest["fingerprint"]
    except (OSError, ValueError, KeyError):
        raise HTTPException(404, "No Android app has been released here.")
    return [{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {"namespace": "android_app", "package_name": package, "sha256_cert_fingerprints": [fingerprint]},
    }]


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


@router.get("/app-update")
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


@router.get("/app-update/assets/{name}")
async def app_update_asset(name: str):
    # Named by their content, so a file here never changes: phones may keep it for good.
    if not APP_ASSET.fullmatch(name) or not (APP_ASSETS_DIR / name).is_file():
        raise HTTPException(404, "Not found.")
    return FileResponse(APP_ASSETS_DIR / name, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/releases/{name}")
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
