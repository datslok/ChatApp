"""Make the desktop app's installer pictures, and the cat in its update window, from the app icon.

    python tools/make_installer_images.py

- desktop/src-tauri/installer/header.bmp (150x57 at 100% scaling): top right of the installer's pages
- desktop/src-tauri/installer/sidebar.bmp (164x314 at 100%): left side of its first and last page
- desktop/ui/cat.png: the cat in the update window (ui/update.html)

NSIS (the installer) only takes BMP pictures without transparency, so the round icon is put on
a solid background first.

The pictures are made SCALE times bigger than NSIS's standard sizes: on screens with Windows
scaling (125%, 150%, ...) the installer's window grows, and shrinking a big picture to fit stays
sharp, while enlarging a small one blurs it. installer/hooks.nsh makes NSIS keep their shape.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICON = Image.open(ROOT / "icon" / "fin2_round.png").convert("RGBA")
INSTALLER = ROOT / "desktop" / "src-tauri" / "installer"
FONT = "C:/Windows/Fonts/segoeuib.ttf"  # Segoe UI Bold, Windows' own font
SCALE = 2

DARK = (49, 51, 56)        # the chat's background, #313338
LIGHT = (219, 222, 225)    # the chat's text, #dbdee1


def cat(size):
    """The round icon, scaled down to size x size pixels."""
    return ICON.resize((size, size), Image.LANCZOS)


def header():
    # The installer's header is white, with the page's title on the left: the cat goes on the right.
    width, height = 150 * SCALE, 57 * SCALE
    image = Image.new("RGB", (width, height), "white")
    small = cat(45 * SCALE)
    image.paste(small, (width - 51 * SCALE, 6 * SCALE), small)  # the third argument: use its transparency
    image.save(INSTALLER / "header.bmp")


def sidebar():
    # Dark like the chat, with the cat and the name in the middle.
    width, height = 164 * SCALE, 314 * SCALE
    image = Image.new("RGB", (width, height), DARK)
    big = cat(120 * SCALE)
    image.paste(big, ((width - 120 * SCALE) // 2, 80 * SCALE), big)
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(FONT, 22 * SCALE)
    draw.text((width // 2, 225 * SCALE), "ChatApp", fill=LIGHT, font=font, anchor="mm")
    image.save(INSTALLER / "sidebar.bmp")


INSTALLER.mkdir(exist_ok=True)
header()
sidebar()
cat(176).save(ROOT / "desktop" / "ui" / "cat.png")  # shown at 88px: twice that for sharp high-DPI screens
print("Made header.bmp, sidebar.bmp and cat.png")
