"""Deletes old phone app updates, so releases/ doesn't grow by ~6 MB with every app-update.ps1.

    python tools/prune_app_updates.py releases            (scripts/app-update.ps1 runs it here and on the server)
    python tools/prune_app_updates.py releases --keep 5

In each releases/app-updates/<version>/ it keeps the newest KEEP manifests (their names are their times,
so they sort by age) and deletes the older ones. Then it deletes every file in releases/app-assets/ that
no remaining manifest names: files are named by their content, so updates share the ones that didn't
change, and a file is only deleted once nothing uses it. Phones only ever ask for the newest update of
their version, so the older ones were never needed again (the few kept are a margin for a phone that's
downloading one just as a newer one comes out).
"""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description="Delete old phone app updates and the files only they used.")
parser.add_argument("releases", type=Path, help="the releases folder")
parser.add_argument("--keep", type=int, default=3, help="updates to keep per app version (default 3)")
args = parser.parse_args()
if args.keep < 1:
    parser.error("--keep must be at least 1")

updates = args.releases / "app-updates"
assets = args.releases / "app-assets"
if not updates.is_dir():
    print("No phone app updates here: nothing to do.")
    raise SystemExit

removed_updates = 0
used = set()  # the files the kept manifests name
for version in sorted(path for path in updates.iterdir() if path.is_dir()):
    manifests = sorted(version.glob("*.json"))  # oldest first
    old, kept = manifests[:-args.keep], manifests[-args.keep:]
    for manifest in old:
        manifest.unlink()
        removed_updates += 1
    for manifest in kept:
        data = json.loads(manifest.read_text())
        used.add(data["launchAsset"]["file"])
        used.update(asset["file"] for asset in data["assets"])

removed_files, freed = 0, 0
if assets.is_dir():
    for file in assets.iterdir():
        if file.is_file() and file.name not in used:
            freed += file.stat().st_size
            file.unlink()
            removed_files += 1

print(f"Removed {removed_updates} old update(s) and {removed_files} file(s) nothing uses any more "
      f"({freed / 1024 / 1024:.1f} MB).")
