"""Make static/js/icon-shapes.js: the line icons the chat's buttons use (instead of emoji), from Lucide
(lucide.dev, ISC licence), one fixed version from npm's lucide-static package.

    python tools/make_icons.py

It downloads that version's package from npm, checks it against npm's own hash (so it's exactly
what Lucide published), and copies only the icons listed in ICONS below. To use another icon: find
its name on lucide.dev, add it to ICONS, run this again, and use it with data-icon="name" in
index.html or makeIcon("name") in the scripts (static/js/icons.js, which draws them).
"""
import base64
import hashlib
import io
import json
import re
import tarfile
import urllib.request
from pathlib import Path

VERSION = "1.48.0"

# Every icon the page uses, by Lucide's name.
ICONS = [
    "arrow-down", "arrow-up", "ban", "bell", "bell-off", "bug", "chevron-down", "file", "gamepad-2",
    "headphone-off", "headphones", "image", "lightbulb", "log-out", "maximize", "megaphone", "menu",
    "mic", "mic-off", "minimize", "monitor", "monitor-up", "music", "paperclip", "pencil", "phone",
    "phone-off", "pin", "reply", "search", "settings", "trash-2", "users", "video", "x",
    "volume-2",
]

# npm's description of that version, with the package's address and its hash ("integrity").
info = json.load(urllib.request.urlopen(f"https://registry.npmjs.org/lucide-static/{VERSION}"))
package = urllib.request.urlopen(info["dist"]["tarball"]).read()
algorithm, expected = info["dist"]["integrity"].split("-", 1)  # "sha512-<base64>"
actual = base64.b64encode(hashlib.new(algorithm, package).digest()).decode()
if actual != expected:
    raise SystemExit("The download doesn't match npm's hash: stopped.")

# The package is a .tgz (a compressed folder): read the files we need straight out of it.
with tarfile.open(fileobj=io.BytesIO(package)) as archive:
    def read(name):
        return archive.extractfile(f"package/{name}").read().decode("utf-8")

    licence = read("LICENSE").strip()
    shapes = {}
    for name in ICONS:
        svg = read(f"icons/{name}.svg")
        # Only the shapes inside <svg ...>...</svg>: icons.js makes the <svg> itself.
        inner = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)
        shapes[name] = " ".join(line.strip() for line in inner.strip().splitlines())

lines = [
    "// The line icons on the chat's buttons: Lucide's (lucide.dev), version " + VERSION + ", copied from npm's",
    "// lucide-static by tools/make_icons.py (don't edit by hand: add a name there and run it again).",
    "//",
    "// Lucide's licence:",
    *("// " + line if line else "//" for line in licence.splitlines()),
    "",
    "const ICON_SHAPES = {",
    *(f"  {json.dumps(name)}: {json.dumps(shape)}," for name, shape in shapes.items()),
    "};",
    "",
]
output = Path(__file__).parent.parent / "static" / "js" / "icon-shapes.js"
output.write_text("\n".join(lines), encoding="utf-8", newline="\n")
print(f"Wrote {len(shapes)} icons to {output}")
