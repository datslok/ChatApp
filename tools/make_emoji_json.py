"""Turn Unicode's official emoji list into static/emoji.json, used by the emoji picker (to show them)
and by the server (to check that a reaction is a real emoji).

Download the list first, then run this with its path:
    curl.exe -L -o emoji-test.txt https://unicode.org/Public/emoji/latest/emoji-test.txt
    python tools/make_emoji_json.py emoji-test.txt

Lines in the file look like:
    # group: Smileys & Emotion
    1F600      ; fully-qualified     # 😀 E1.0 grinning face
"""
import json
import sys
from pathlib import Path

SKIN_TONES = {"1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"}  # 🏻🏼🏽🏾🏿: left out, to keep the list manageable
SKIP_GROUPS = {"Component"}  # skin tones and hair styles on their own, not emoji to pick

groups = []
# Which Unicode emoji version each emoji came in: {"17.0": ["🫫", ...], ...}. The phone app hides the
# ones newer than its Android can draw (the web page tests drawing instead, on a canvas). Kept apart
# from "groups", whose entries stay [emoji, name] pairs (server.py and chattus.py read them as pairs).
versions = {}
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    if line.startswith("# group: "):
        groups.append({"name": line.removeprefix("# group: "), "emoji": []})
        continue
    if line.startswith("#") or ";" not in line:
        continue

    code_points, rest = line.split(";", 1)
    status, description = rest.split("#", 1)
    # Only the "fully-qualified" form: e.g. the emoji heart ❤️ (2764 FE0F), not the old text heart ❤ (2764).
    if status.strip() != "fully-qualified":
        continue
    if SKIN_TONES & set(code_points.split()):  # & between two sets: what they have in common
        continue

    # description is like " 😀 E1.0 grinning face": the emoji, its Unicode version, then its name.
    emoji, version, name = description.strip().split(" ", 2)
    if groups[-1]["name"] in SKIP_GROUPS:
        continue
    groups[-1]["emoji"].append([emoji, name])
    versions.setdefault(version.removeprefix("E"), []).append(emoji)  # "E17.0" -> "17.0"

groups = [group for group in groups if group["name"] not in SKIP_GROUPS]
output = Path(__file__).parent.parent / "static" / "emoji.json"
# ensure_ascii=False writes the emoji themselves (smaller and readable), not 😀 codes.
output.write_text(json.dumps({"groups": groups, "versions": versions}, ensure_ascii=False, separators=(",", ":")),
                  encoding="utf-8")

total = sum(len(group["emoji"]) for group in groups)
print(f"Wrote {output}: {total} emoji in {len(groups)} groups.")
for group in groups:
    print(f"  {group['name']}: {len(group['emoji'])}")
