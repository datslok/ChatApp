"""Turns an `npx expo export` of the phone app into a JavaScript update for server.py's /app-update
(expo-updates' protocol: docs.expo.dev/technical-specs/expo-updates-1). scripts\\app-update.ps1 runs it:

    python tools/make_app_update.py EXPORT_FOLDER RUNTIME_VERSION [RELEASES_FOLDER]

EXPORT_FOLDER is what `npx expo export --platform android --output-dir EXPORT_FOLDER` made: the bundle
(the app's JavaScript, as Hermes bytecode), its pictures and sounds, and metadata.json listing them.
It writes, in RELEASES_FOLDER (releases/ by default):

    app-assets/<md5>.<ext>                        each file, named by its content (never changes)
    app-updates/<runtime version>/<time>.json     the manifest: which files, with their fingerprints

The manifest's "file" fields become full addresses when server.py hands it out.
"""
import base64
import hashlib
import json
import shutil
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

export = Path(sys.argv[1])
runtime = sys.argv[2]
releases = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(__file__).resolve().parent.parent / "releases"
metadata_bytes = (export / "metadata.json").read_bytes()
android = json.loads(metadata_bytes)["fileMetadata"]["android"]
assets_folder = releases / "app-assets"
assets_folder.mkdir(parents=True, exist_ok=True)


def asset(path, ext, launch=False):
    """One file of the update: copied into app-assets/, described for the manifest. key: the MD5 the
    bundle knows it by (also how Expo names it); hash: its SHA-256, which the app checks after
    downloading, in base64url without the = padding."""
    data = (export / path).read_bytes()
    md5 = hashlib.md5(data).hexdigest()
    sha256 = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
    file = f"{md5}.{ext}"
    if not (assets_folder / file).exists():
        shutil.copyfile(export / path, assets_folder / file)
    described = {"hash": sha256, "key": md5, "file": file}
    if launch:  # the bundle: always JavaScript to the app (it's Hermes bytecode, which it runs as such)
        described["contentType"] = "application/javascript"
    else:
        described["contentType"] = {
            "png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
            "wav": "audio/wav", "mp3": "audio/mpeg", "ttf": "font/ttf", "otf": "font/otf", "json": "application/json",
        }.get(ext, "application/octet-stream")
        described["fileExtension"] = "." + ext
    return described


now = datetime.now(timezone.utc)
manifest = {
    # The same metadata.json always gives the same id (Expo's example server does it this way): a UUID
    # made from its SHA-256.
    "id": str(uuid.UUID(hashlib.sha256(metadata_bytes).hexdigest()[:32])),
    "createdAt": now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z",
    "runtimeVersion": runtime,
    "launchAsset": asset(android["bundle"], "hbc", launch=True),
    "assets": [asset(item["path"], item["ext"]) for item in android["assets"]],
    "metadata": {},
    "extra": {},
}
folder = releases / "app-updates" / runtime
folder.mkdir(parents=True, exist_ok=True)
name = now.strftime("%Y%m%d-%H%M%S") + ".json"
(folder / name).write_text(json.dumps(manifest, indent=2))
print(f"Update {manifest['id']} for version {runtime}: {folder / name} ({len(manifest['assets'])} assets)")
