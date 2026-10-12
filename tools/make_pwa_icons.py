"""Make the phone app's icons (the chat installed as a PWA, see static/manifest.json) from the app icon.

    python tools/make_pwa_icons.py

- static/icons/icon-192.png and icon-512.png: the icon as it is (a blue rounded square, with
  transparent corners), in the two sizes Android asks for
- static/icons/icon-maskable-512.png: for Android's own icon shapes (a circle, a rounded square,
  ...). Android cuts those out of the middle of the picture, keeping at least the middle 80%
  (the "safe zone"). So: the whole square filled with the icon's blue, and the icon a little
  smaller in the middle (70%: its whiskers reach almost to its edges), so the cuts only ever
  take blue, never the cat.
- static/icons/apple-touch-icon.png (180x180): the iPhone's home screen icon. iPhones round the
  corners themselves and show transparency as black, so it's filled with the blue too.

Run it again after changing the icon.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICON = Image.open(ROOT / "icon" / "chattuschattus_square.png").convert("RGBA")  # the app icon in use
OUT = ROOT / "static" / "icons"
BLUE = ICON.getpixel((ICON.width // 2, 40))  # the square's blue, read from near its top edge


def on_blue(size, icon_share):
    """A size x size square of the blue, with the icon in the middle at icon_share of its width."""
    picture = Image.new("RGBA", (size, size), BLUE)
    # The icon's transparent corners filled with the blue first: shrunk as they are, the edge
    # pixels would mix with "transparent black" and leave a faint outline of the rounded square.
    filled = Image.new("RGBA", ICON.size, BLUE)
    filled.alpha_composite(ICON)
    inner = round(size * icon_share)
    small = filled.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    picture.alpha_composite(small, (offset, offset))  # (pastes it, keeping its transparency)
    return picture


OUT.mkdir(exist_ok=True)
for size in (192, 512):
    ICON.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png")
on_blue(512, 0.7).save(OUT / "icon-maskable-512.png")
on_blue(180, 0.9).convert("RGB").save(OUT / "apple-touch-icon.png")
print(f"Made the icons in {OUT}")
