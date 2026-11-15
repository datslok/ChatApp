"""Files: uploads and serving them, thumbnails, profile-picture processing, re-packing videos and removing
metadata from pictures and videos."""

import asyncio
import os
import secrets
import shutil
import subprocess
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, ImageSequence

from chatapp.config import (
    IMAGE_TYPES, MAX_CROP_SIDE, MAX_FILENAME_LENGTH, MAX_GIF_FRAMES, MAX_GIF_SIZE, MAX_UPLOAD_SIZE,
    PICTURE_EXTENSIONS, PICTURE_KINDS, SHOWN_TYPES, UPLOAD_DIR, VIDEO_TYPES
)
from chatapp.db import db
from chatapp.sessions import current_user
from chatapp.access import can_join
from chatapp.pages import SEASONAL_DIR, SEASONS

router = APIRouter()


# ---------- Videos ----------

def is_video(path, content_type):
    """Does this file really start like a video of that type? Every file format begins with its own
    few bytes, its "magic number": an MP4 has "ftyp" at byte 4, a WebM starts with 1A 45 DF A3.
    So a file can't become a "video" just by being called one."""
    with open(path, "rb") as file:
        start = file.read(12)
    if content_type == "video/mp4":
        return start[4:8] == b"ftyp"
    if content_type == "video/webm":
        return start[:4] == b"\x1a\x45\xdf\xa3"
    return False


def mark_old_videos():
    """Videos sent before the page could play them were stored as plain downloads. At every start:
    those with a video's name whose first bytes say so too become videos. (Only looks at .mp4 and
    .webm downloads, so after the first time there's next to nothing to check.)"""
    rows = db.execute(
        "SELECT id, filename FROM attachments WHERE content_type = 'application/octet-stream'"
        " AND (LOWER(filename) LIKE '%.mp4' OR LOWER(filename) LIKE '%.webm')"
    ).fetchall()
    for file_id, filename in rows:
        content_type = "video/webm" if filename.lower().endswith(".webm") else "video/mp4"
        path = UPLOAD_DIR / file_id
        if path.exists() and is_video(path, content_type):
            with db:
                db.execute("UPDATE attachments SET content_type = ? WHERE id = ?", (content_type, file_id))


mark_old_videos()


# ---------- Re-packing videos ----------
#
# A video file is a container (MP4, WebM) holding the picture and sound, plus an index: how long it is
# and where each moment is in the file. Some programs (screen recorders, browsers' own recordings, video
# downloaders) write "fragmented" files: many small pieces, with the header saying the length is 0 and
# the real index at the very end. Browsers cope; Android's player (the phone app's) can't tell how long
# such a video is or skip in it. So every uploaded video is re-packed once by ffmpeg: the same picture
# and sound, copied as they are ("-c copy", nothing re-encoded: a second or two, no quality lost), into
# an ordinary file with the length and index at the start ("+faststart", which also lets a video begin
# playing before it's all downloaded). If ffmpeg isn't installed, or fails on a file, the original stays.

def find_ffmpeg():
    """ffmpeg's path, or None. On our PATH, or else on the PATH as Windows has it now: a program keeps
    the PATH it started with, so a server (or scheduled task) started before ffmpeg was installed
    wouldn't see it. Windows keeps the current one in the registry, for all users and for this one
    (install.ps1's Update-Path reads the same two)."""
    found = shutil.which("ffmpeg")
    if found or os.name != "nt":
        return found
    import winreg  # (Windows only)
    folders = []
    for root, key in ((winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
                      (winreg.HKEY_CURRENT_USER, "Environment")):
        try:
            with winreg.OpenKey(root, key) as opened:
                folders.append(winreg.QueryValueEx(opened, "Path")[0])
        except OSError:
            pass
    return shutil.which("ffmpeg", path=os.path.expandvars(";".join(folders)))


FFMPEG = find_ffmpeg()
if FFMPEG is None:
    print("ffmpeg isn't installed: uploaded videos are kept as they are (see README, \"Videos\").", flush=True)


def repack_video(path, content_type):
    """Re-pack the video at `path` in place (see above). True if it was replaced. Slow-ish (it runs a
    program), so it's called in a background thread."""
    if FFMPEG is None:
        return False
    container = "mp4" if content_type == "video/mp4" else "webm"
    temporary = path.with_name(path.name + ".repack")
    # -map_metadata -1: none of the file's notes are copied (where and when it was filmed, the phone; see
    # "Removing metadata"). Which way up it is isn't one of them (it's "side data"), so that stays.
    command = [FFMPEG, "-v", "error", "-y", "-i", str(path), "-map", "0:v", "-map", "0:a?", "-c", "copy",
               "-map_metadata", "-1"]
    if container == "mp4":
        command += ["-movflags", "+faststart"]
    command += ["-f", container, str(temporary)]
    try:
        # A list, never one string through a shell: the path can't be read as a command. 60 s at most.
        result = subprocess.run(command, capture_output=True, timeout=60)
        if result.returncode == 0 and temporary.stat().st_size > 0 and is_video(temporary, content_type):
            os.replace(temporary, path)  # swaps the file in one go: nobody ever gets half of one
            return True
        print(f"Couldn't re-pack {path.name}: {result.stderr.decode(errors='replace')[-300:]}", flush=True)
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"Couldn't re-pack {path.name}: {error}", flush=True)
    temporary.unlink(missing_ok=True)
    return False


# Has a video any sound? Browsers can't tell before it plays, so the server asks once and the page's
# player greys its volume out for a silent one (static/js/video-player.js). ffprobe, which comes with
# ffmpeg (in the same folder), only reads a file and describes what's in it: here, its audio streams.
FFPROBE = None
if FFMPEG is not None:
    beside = Path(FFMPEG).with_name("ffprobe" + Path(FFMPEG).suffix)  # (".exe" on Windows)
    FFPROBE = str(beside) if beside.is_file() else shutil.which("ffprobe")


def has_audio(path):
    """True if the video at `path` has a sound track, False if not, None if we can't tell (no ffprobe,
    or it couldn't read the file). Runs a program, so it's called in a background thread."""
    if FFPROBE is None:
        return None
    # -select_streams a: only the audio streams; -show_entries stream=index: one line (its number) for
    # each; csv=p=0: just that number. No line at all: no sound.
    command = [FFPROBE, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)]
    try:
        result = subprocess.run(command, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() != b""


def mp4_is_fragmented(path):
    """Does this MP4 need re-packing: is it in pieces ("moof" boxes), or is its index after the picture
    and sound ("moov" after "mdat")? An MP4 is a row of boxes, each starting with its size (4 bytes) and
    its kind (4 letters); this reads only those headers, skipping over each box."""
    seen = []
    with open(path, "rb") as file:
        while len(seen) < 1000:
            header = file.read(8)
            if len(header) < 8:
                break
            size, kind = int.from_bytes(header[:4], "big"), header[4:8]
            seen.append(kind)
            if size == 1:  # a big box: its real size follows, in 8 bytes
                size = int.from_bytes(file.read(8), "big") - 8
            elif size == 0:  # "until the end of the file"
                break
            file.seek(size - 8, os.SEEK_CUR)
    if b"moof" in seen:
        return True
    return b"mdat" in seen and b"moov" in seen and seen.index(b"mdat") < seen.index(b"moov")


# ---------- Removing metadata ----------
#
# Besides its pixels, a photo carries notes the camera wrote: where it was taken (GPS), when, the phone,
# sometimes the owner's name. Anyone who downloads it gets them, so they're removed from every picture and
# video sent in the chat. Each format keeps its notes in its own way:
#   JPEG: a row of "segments", each a marker (FF and a byte) and a 2-byte length. The notes are APP1
#         (EXIF and XMP), APP13 (IPTC) and COM (comments); iPhones add more pictures after the photo (MPO).
#   PNG:  a row of "chunks" (length, 4-letter kind, data, checksum); the text ones and eXIf hold notes.
#   WebP: a row of RIFF chunks; EXIF and "XMP " are the notes, announced by two flags in the VP8X chunk.
# The files are cut, not saved again: everything but the notes is copied byte for byte, so a JPEG loses
# no quality (saving it again would compress it again). Two notes stay, since without them the picture
# would look wrong: which way up it is (EXIF orientation, put back as a tiny EXIF of its own) and its
# colours' meaning (the ICC profile). Videos: ffmpeg's -map_metadata -1 in repack_video. GIFs (cameras
# don't make them) and other files (the sender's own documents) are left as they are.

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_NOTES = {b"tEXt", b"zTXt", b"iTXt", b"eXIf", b"tIME"}


def jpeg_without_metadata(data, orientation):
    """The JPEG `data` without its notes (above), with only `orientation` (2-8) as EXIF if given. None if
    it isn't laid out as expected (then the file is left alone)."""
    if data[:2] != b"\xff\xd8":
        return None
    out = bytearray(b"\xff\xd8")
    exif_written = orientation is None
    i = 2
    while True:
        if i >= len(data) or data[i] != 0xFF:
            return None
        while i < len(data) and data[i] == 0xFF:  # (a marker may have extra FF bytes before it)
            i += 1
        if i >= len(data) or data[i] == 0x00:
            return None
        marker = data[i]
        i += 1
        if marker == 0xD9:  # the end of the picture: anything after it (an iPhone's extra pictures) goes
            out += b"\xff\xd9"
            return bytes(out)
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:  # markers without a length
            out += bytes((0xFF, marker))
            continue
        length = int.from_bytes(data[i:i + 2], "big")  # (counts its own 2 bytes)
        if length < 2 or i + length > len(data):
            return None
        content = data[i + 2:i + length]
        segment = bytes((0xFF, marker)) + data[i:i + length]
        i += length
        if 0xE0 <= marker <= 0xEF:  # APP0-APP15: what programs add. Only three are needed:
            keep = (marker == 0xE0 and content.startswith(b"JFIF\x00")          # the basic header
                    or marker == 0xE2 and content.startswith(b"ICC_PROFILE\x00")  # the colour profile
                    or marker == 0xEE and content.startswith(b"Adobe"))          # how CMYK colours are stored
        else:
            keep = marker != 0xFE  # COM: a comment. Everything else is the picture itself.
        if not keep:
            continue
        if not exif_written and marker != 0xE0:  # the orientation goes right after JFIF (if any)
            exif = Image.Exif()
            exif[0x0112] = orientation
            payload = exif.tobytes()  # b"Exif\0\0" and the rest
            out += b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload
            exif_written = True
        out += segment
        if marker == 0xDA:  # start of scan: the compressed picture follows, up to the next real marker
            start = i
            while True:
                i = data.find(b"\xff", i)
                if i < 0 or i + 1 >= len(data):
                    return None
                after = data[i + 1]
                if after == 0x00 or 0xD0 <= after <= 0xD7:  # FF 00 is a plain FF byte; D0-D7 restarts
                    i += 2
                    continue
                break
            out += data[start:i]


def png_without_metadata(data):
    """The PNG `data` without its note chunks (PNG_NOTES), up to IEND. None if it isn't laid out as expected."""
    if data[:8] != PNG_SIGNATURE:
        return None
    out = bytearray(data[:8])
    i = 8
    while i + 12 <= len(data):
        length = int.from_bytes(data[i:i + 4], "big")
        kind = data[i + 4:i + 8]
        end = i + 12 + length  # length, kind, data, checksum
        if end > len(data):
            return None
        if kind not in PNG_NOTES:
            out += data[i:end]
        i = end
        if kind == b"IEND":
            return bytes(out)
    return None


def webp_without_metadata(data):
    """The WebP `data` without its EXIF and XMP chunks. None if it isn't laid out as expected."""
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    end = min(len(data), 8 + int.from_bytes(data[4:8], "little"))  # RIFF's size counts from byte 8
    out = bytearray()
    i = 12
    while i + 8 <= end:
        kind = data[i:i + 4]
        size = int.from_bytes(data[i + 4:i + 8], "little")
        if i + 8 + size > end:
            return None
        chunk_end = min(end, i + 8 + size + (size & 1))  # chunks are padded to an even length
        chunk = bytearray(data[i:chunk_end])
        if kind == b"VP8X":  # the header of an extended WebP: its flags say which chunks there are
            chunk[8] &= ~(0x08 | 0x04) & 0xFF  # no EXIF (0x08) or XMP (0x04) any more
        if kind not in (b"EXIF", b"XMP "):
            out += chunk
        i = chunk_end
    return b"RIFF" + (len(out) + 4).to_bytes(4, "little") + b"WEBP" + bytes(out)


def remove_metadata(path):
    """Remove the notes from the picture at `path` in place (see above). The format comes from the file's
    first bytes, not its name. True if the file changed. Reads it whole: run it in a thread."""
    try:
        data = path.read_bytes()
        with Image.open(BytesIO(data)) as picture:
            size = picture.size
            orientation = picture.getexif().get(0x0112)
        if data[:3] == b"\xff\xd8\xff":
            cleaned = jpeg_without_metadata(data, orientation if orientation in range(2, 9) else None)
        elif data[:8] == PNG_SIGNATURE:
            cleaned = png_without_metadata(data)
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            cleaned = webp_without_metadata(data)
        else:
            return False  # a GIF
        if cleaned is None:
            print(f"Couldn't remove the metadata from {path.name}: not laid out as expected.", flush=True)
            return False
        if cleaned == data:
            return False
        with Image.open(BytesIO(cleaned)) as check:  # still the same picture? (all of it decoded)
            check.load()
            if check.size != size:
                print(f"Couldn't remove the metadata from {path.name}: the result didn't match.", flush=True)
                return False
        temporary = path.with_name(path.name + ".clean")
        temporary.write_bytes(cleaned)
        os.replace(temporary, path)  # swapped in one go, like repack_video
        return True
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        print(f"Couldn't remove the metadata from {path.name}: {error}", flush=True)
        return False


async def clean_old_uploads():
    """Pictures and videos sent before metadata was removed: cleaned once, in the background (from
    repack_old_videos). A video goes through repack_video again, now without its notes; without ffmpeg,
    videos wait for a later start."""
    rows = db.execute(
        "SELECT id, content_type FROM attachments WHERE cleaned = 0"
        f" AND content_type IN ({', '.join('?' * len(SHOWN_TYPES))})", tuple(SHOWN_TYPES)
    ).fetchall()
    for file_id, content_type in rows:
        path = UPLOAD_DIR / file_id
        if content_type in VIDEO_TYPES:
            if FFMPEG is None:
                continue
            changed = path.exists() and await asyncio.to_thread(repack_video, path, content_type)
        else:
            changed = path.exists() and await asyncio.to_thread(remove_metadata, path)
        with db:
            if changed:
                db.execute("UPDATE attachments SET size = ? WHERE id = ?", (path.stat().st_size, file_id))
            db.execute("UPDATE attachments SET cleaned = 1, repacked = repacked OR ? WHERE id = ?",
                       (int(content_type in VIDEO_TYPES), file_id))


async def repack_old_videos():
    """Videos uploaded before re-packing existed, and the seasonal videos (seasonal/, see "Seasons"):
    re-packed once, in the background, started by the first connection (like watch_presences).
    The database is only touched here, in the server's own thread; ffmpeg runs in another.
    First, old files' metadata (clean_old_uploads)."""
    await clean_old_uploads()
    if FFMPEG is None:
        return
    rows = db.execute(
        "SELECT id, content_type FROM attachments WHERE content_type IN ('video/mp4', 'video/webm') AND repacked = 0"
    ).fetchall()
    for file_id, content_type in rows:
        path = UPLOAD_DIR / file_id
        if path.exists() and await asyncio.to_thread(repack_video, path, content_type):
            with db:
                db.execute("UPDATE attachments SET size = ? WHERE id = ?", (path.stat().st_size, file_id))
        with db:
            db.execute("UPDATE attachments SET repacked = 1 WHERE id = ?", (file_id,))
    # And videos whose sound we don't know yet (from before has_audio; or ffprobe failed: tried again).
    rows = db.execute(
        "SELECT id FROM attachments WHERE content_type IN ('video/mp4', 'video/webm') AND audio IS NULL"
    ).fetchall()
    for (file_id,) in rows:
        path = UPLOAD_DIR / file_id
        audio = await asyncio.to_thread(has_audio, path) if path.exists() else None
        if audio is not None:
            with db:
                db.execute("UPDATE attachments SET audio = ? WHERE id = ?", (int(audio), file_id))
    for season in SEASONS:
        path = SEASONAL_DIR / season["video"]
        if path.is_file() and await asyncio.to_thread(mp4_is_fragmented, path):
            if await asyncio.to_thread(repack_video, path, "video/mp4"):
                print(f"Re-packed seasonal/{season['video']}.", flush=True)

repacker = None  # the task above, started by the first connection (it needs the running loop)


def start_repacking():
    """Start repack_old_videos once: called by every new connection, only the first one starts it."""
    global repacker  # (this function gives the name a new value, so it must say it means the global one)
    if repacker is None:
        repacker = asyncio.create_task(repack_old_videos())


def file_info(attachment_id, filename, size, content_type, audio=None):
    """What the page needs to know about an attachment. A video also says whether it has sound
    (attachments.audio; not known counts as yes, so the volume is never greyed out by mistake)."""
    info = {"id": attachment_id, "filename": filename, "size": size,
            "image": content_type in IMAGE_TYPES, "video": content_type in VIDEO_TYPES}
    if info["video"]:
        info["audio"] = audio != 0
    return info


def files_note(files):
    """A message's files in words, for notifications of a message without text."""
    if not files:
        return ""
    if len(files) == 1:
        return "📷 A picture" if files[0]["image"] else "📎 " + files[0]["filename"]
    if all(file["image"] for file in files):
        return f"📷 {len(files)} pictures"
    return f"📎 {len(files)} files"


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


@router.post("/upload")
async def upload(request: Request, filename: str):
    """Receive one file. The body is the raw file; its name comes in the URL: /upload?filename=cat.png"""
    user_id = current_user(request)
    if user_id is None:
        raise HTTPException(401, "You're not logged in.")

    filename = filename.strip()[:MAX_FILENAME_LENGTH] or "file"
    # The browser says what type the file is. We only believe it for our safe picture and video types
    # (a video also has to start like one, checked below); anything else is stored as a generic
    # download type.
    content_type = request.headers.get("content-type", "")
    if content_type not in SHOWN_TYPES:
        content_type = "application/octet-stream"

    # On disk the file gets a random name, never the one the user gave
    # (a name like "../../server.py" could otherwise overwrite our own files).
    file_id = secrets.token_urlsafe(16)
    size = await receive_file(request, UPLOAD_DIR / file_id, MAX_UPLOAD_SIZE)
    if content_type in VIDEO_TYPES and not is_video(UPLOAD_DIR / file_id, content_type):
        content_type = "application/octet-stream"
    # A picture: its metadata (where and when it was taken...) removed before anyone can download it
    # (see "Removing metadata"; a video's goes in repack_video below).
    if content_type in IMAGE_TYPES and await asyncio.to_thread(remove_metadata, UPLOAD_DIR / file_id):
        size = (UPLOAD_DIR / file_id).stat().st_size
    # A video: re-packed before anyone sees it, so every player knows its length (see "Re-packing
    # videos"). In a background thread: the chat keeps running meanwhile.
    repacked = content_type in VIDEO_TYPES and FFMPEG is not None
    if repacked and await asyncio.to_thread(repack_video, UPLOAD_DIR / file_id, content_type):
        size = (UPLOAD_DIR / file_id).stat().st_size
    # And whether it has sound (see has_audio; None: not known, asked again at the next start).
    audio = await asyncio.to_thread(has_audio, UPLOAD_DIR / file_id) if content_type in VIDEO_TYPES else None

    with db:
        db.execute(
            "INSERT INTO attachments (id, filename, content_type, size, uploader_id, repacked, audio, cleaned)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (file_id, filename, content_type, size, user_id, int(repacked), None if audio is None else int(audio),
             int(content_type in IMAGE_TYPES or repacked)),
        )
    return {"id": file_id}


MAX_FILES_PER_MESSAGE = 10  # like Discord


class NotAllowed(Exception):
    """Raised inside a `with db:` block to undo everything it did so far."""


def claim_attachments(file_ids, user_id, channel):
    """Tie uploaded files to the channel they're being sent in. Only the uploader can do that, and
    only once. All of them or none: returns their infos for the message, in order, or None if any
    isn't allowed (or the list is wrong: not a list of 1 to MAX_FILES_PER_MESSAGE different ids)."""
    if (not isinstance(file_ids, list) or not 1 <= len(file_ids) <= MAX_FILES_PER_MESSAGE
            or not all(isinstance(file_id, str) for file_id in file_ids) or len(set(file_ids)) != len(file_ids)):
        return None
    try:
        with db:  # one transaction: an exception inside undoes the files claimed before it
            for file_id in file_ids:
                cursor = db.execute(
                    "UPDATE attachments SET channel = ? WHERE id = ? AND uploader_id = ? AND channel IS NULL",
                    (channel, file_id, user_id),
                )
                if cursor.rowcount != 1:  # rowcount: how many rows the UPDATE changed
                    raise NotAllowed
    except NotAllowed:
        return None
    files = []
    for file_id in file_ids:
        filename, size, content_type, audio = db.execute(
            "SELECT filename, size, content_type, audio FROM attachments WHERE id = ?", (file_id,)
        ).fetchone()
        files.append(file_info(file_id, filename, size, content_type, audio))
    return files


# ---------- Thumbnails ----------

# A picture in the chat is shown much smaller than it is: a phone photo is 4000 px wide, its tile in the
# Media tab 100. Sending the original makes the browser download megabytes and decode every pixel
# (~48 MB of memory for a 12-megapixel photo) for each tile, which is what made long lists lag. So the
# pages ask for /uploads/<id>?size=400: a copy whose longest side is at most that, made once with Pillow
# and kept in uploads/thumbs/. Only the viewer (a picture opened) loads the original.
# Only these sizes, so nobody can fill the disk by asking for every number from 1 to 10,000.
THUMB_SIZES = (200, 400, 800, 1200)  # (1200: a single picture on a very sharp screen)
THUMB_DIR = UPLOAD_DIR / "thumbs"
THUMB_DIR.mkdir(exist_ok=True)
# An animation keeps every frame in memory while it's shrunk: one with more pixels than this in all
# (frames x width x height of the copy) is sent as it is instead.
MAX_THUMB_ANIMATION_PIXELS = 40_000_000
thumbnail_lock = asyncio.Lock()  # one at a time: a Media tab asks for 50 at once


def thumbnail_path(file_id, size):
    return THUMB_DIR / f"{file_id}-{size}.webp"


def delete_upload(file_id):
    """Delete an attachment's file and every thumbnail made of it."""
    (UPLOAD_DIR / file_id).unlink(missing_ok=True)
    for size in THUMB_SIZES:
        thumbnail_path(file_id, size).unlink(missing_ok=True)


def make_thumbnail(source, destination, size):
    """Save a WebP copy of the picture `source`, at most `size` pixels on its longest side; animations
    stay animated. Returns False (and saves nothing) when the original is small enough already or
    can't be shrunk (then it's sent as it is). Blocking: run it in a thread."""
    try:
        with Image.open(source, formats=["PNG", "JPEG", "GIF", "WEBP"]) as picture:
            if max(picture.size) <= size:
                return False
            # iPhones (and some other cameras) save a photo as an MPO: a JPEG with more pictures after it,
            # such as the HDR "gain map", a small dark one. Pillow counts those as frames, but they're no
            # animation: only the first is the photo (as two frames, the copy flashed photo/black).
            frame_count = 1 if picture.format == "MPO" else getattr(picture, "n_frames", 1)
            if frame_count > 1:
                width, height = picture.size
                scale = size / max(width, height)
                if frame_count * width * height * scale * scale > MAX_THUMB_ANIMATION_PIXELS:
                    return False
                frames, durations = [], []
                for frame in ImageSequence.Iterator(picture):
                    duration = frame.info.get("duration", 100)
                    durations.append(duration if duration >= 20 else 100)  # as in make_animated_webp
                    copy = frame.convert("RGBA")
                    copy.thumbnail((size, size), Image.Resampling.LANCZOS)  # shrinks, keeping its shape
                    frames.append(copy)
                part = destination.with_suffix(".part")
                frames[0].save(part, format="WEBP", save_all=True, append_images=frames[1:],
                               duration=durations, loop=0, quality=80)
            else:
                # A JPEG can be decoded at 1/2, 1/4 or 1/8 of its size straight away ("draft"), which
                # is much faster than decoding all of it and shrinking afterwards.
                picture.draft("RGB", (size, size))
                # Phone cameras save photos sideways with a note saying "turn me"; browsers follow it,
                # but WebP copies don't carry the note, so turn the picture itself.
                still = ImageOps.exif_transpose(picture)
                still = still.convert("RGBA" if still.mode in ("RGBA", "LA", "P", "PA") else "RGB")
                still.thumbnail((size, size), Image.Resampling.LANCZOS)
                part = destination.with_suffix(".part")
                still.save(part, format="WEBP", quality=80)
        # Saved under another name first and renamed when complete, so half a file is never sent.
        os.replace(part, destination)
        return True
    except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        return False


def remove_flashing_thumbnails():
    """Before 2026-11-15, an iPhone photo's thumbnails were made as two-frame animations (see MPO in
    make_thumbnail). A JPEG never animates, so an animated copy of one is such a mistake: delete it, and
    the next look makes it again. Once only (afterwards a marker file is in uploads/thumbs/)."""
    marker = THUMB_DIR / "mpo-fixed"
    if marker.exists():
        return
    rows = db.execute("SELECT id FROM attachments WHERE content_type = 'image/jpeg'").fetchall()
    for (file_id,) in rows:
        for size in THUMB_SIZES:
            thumbnail = thumbnail_path(file_id, size)
            if not thumbnail.exists():
                continue
            try:
                with Image.open(thumbnail) as copy:
                    animated = getattr(copy, "n_frames", 1) > 1
            except OSError:
                animated = True  # can't be read either: make it again
            if animated:
                thumbnail.unlink(missing_ok=True)
    marker.touch()


remove_flashing_thumbnails()


@router.get("/uploads/{file_id}")
async def get_upload(request: Request, file_id: str, size: int | None = None):
    """Send a file, but only to people who may see the message it's in. With ?size= (one of
    THUMB_SIZES), a picture comes as a smaller copy (see "Thumbnails")."""
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

    if size is not None and content_type in IMAGE_TYPES:
        if size not in THUMB_SIZES:
            raise HTTPException(400, f"The sizes are {', '.join(map(str, THUMB_SIZES))}.")
        thumbnail = thumbnail_path(file_id, size)
        if not thumbnail.exists():
            async with thumbnail_lock:
                # Another request may have made it while this one waited for the lock.
                if not thumbnail.exists():
                    await asyncio.to_thread(make_thumbnail, UPLOAD_DIR / file_id, thumbnail, size)
        if thumbnail.exists():  # (else the original is small already, or couldn't be shrunk: sent below)
            return FileResponse(thumbnail, media_type="image/webp", content_disposition_type="inline",
                                filename=Path(filename).stem + ".webp",  # "Save image as" offers photo.webp
                                headers={"X-Content-Type-Options": "nosniff"})

    return FileResponse(
        UPLOAD_DIR / file_id,  # safe: file_id was found in our own table above
        media_type=content_type,
        filename=filename,
        # Pictures and videos are shown in the page; everything else is downloaded, never opened on our
        # site. (A video player asks for a piece at a time, "bytes=1000000-": FileResponse answers
        # those "range requests" by itself, so skipping ahead works.)
        content_disposition_type="inline" if content_type in SHOWN_TYPES else "attachment",
        # Tell the browser to trust our type and never guess (so a fake "image" can't act as a page).
        headers={"X-Content-Type-Options": "nosniff"},
    )


# ---------- Pictures for profiles and custom emoji ----------
#
# The page crops and shrinks them first; an animated GIF is cropped here instead (see make_animated_webp).

def crop_box_from(request):
    """The rectangle chosen in the editor, from the address (?left=..&top=..&width=..&height=..),
    as four whole numbers. None if they're not there."""
    try:
        box = [int(request.query_params[name]) for name in ("left", "top", "width", "height")]
    except (KeyError, ValueError):
        return None
    return box


def check_crop_box(box, picture_size):
    """Raise ValueError unless the rectangle `box` (left, top, width, height) is a sane size and
    overlaps the picture. It may go past the picture's edges: the editor lets the whole picture fit
    inside the frame, and the empty part of the frame becomes see-through."""
    left, top, width, height = box
    picture_width, picture_height = picture_size
    if not (1 <= width <= MAX_CROP_SIDE and 1 <= height <= MAX_CROP_SIDE):
        raise ValueError("That crop doesn't fit the picture.")
    if left >= picture_width or top >= picture_height or left + width <= 0 or top + height <= 0:
        raise ValueError("That crop doesn't fit the picture.")


def make_padded_webp(source, destination, box):
    """A still picture from the phone app, already cut and shrunk, but smaller than the frame on
    one side (Android's image tools can't add empty space): put it into a see-through `box`
    (crop() past the edges pads) and save it as WebP."""
    with Image.open(source) as picture:
        check_crop_box(box, picture.size)
        left, top, width, height = box
        padded = picture.convert("RGBA").crop((left, top, left + width, top + height))
    padded.save(destination, format="WEBP", quality=85)


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
        check_crop_box(box, gif.size)

        frames, durations = [], []
        for frame in ImageSequence.Iterator(gif):  # every frame, one after the other
            # How long this frame shows, in milliseconds. Browsers treat tiny values as 100.
            duration = frame.info.get("duration", 100)
            durations.append(duration if duration >= 20 else 100)
            # RGBA: full colour plus transparency, whatever the GIF's own colour format was. Where the
            # rectangle goes past the picture's edges, crop() fills in see-through pixels.
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
    elif box is not None:
        # A still picture that needs see-through space around it (the phone app's editor).
        picture_id = secrets.token_urlsafe(16) + ".webp"
        upload = settings["folder"] / (picture_id + ".upload")
        await receive_file(request, upload, settings["max_size"])
        try:
            await asyncio.to_thread(make_padded_webp, upload, settings["folder"] / picture_id, box)
        except ValueError as error:
            raise HTTPException(400, str(error))
        except Exception:
            (settings["folder"] / picture_id).unlink(missing_ok=True)
            raise HTTPException(400, "Couldn't read that picture.")
        finally:
            upload.unlink(missing_ok=True)
    else:
        picture_id = secrets.token_urlsafe(16) + "." + PICTURE_EXTENSIONS[content_type]
        await receive_file(request, settings["folder"] / picture_id, settings["max_size"])
    return picture_id
