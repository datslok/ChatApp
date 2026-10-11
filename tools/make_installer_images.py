"""Make the desktop app's installer pictures, and the cat in its update window, from the app icon.

    python tools/make_installer_images.py

- desktop/src-tauri/installer/header.bmp (150x57): top right of the installer's pages
- desktop/src-tauri/installer/sidebar.bmp (164x314): left side of its first and last page
- desktop/ui/cat.png: the cat in the update window (ui/update.html)

NSIS (the installer) only takes BMP pictures without transparency, so the round icon is put on
a solid background first.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICON = Image.open(ROOT / "icon" / "fin2_round.png").convert("RGBA")
INSTALLER = ROOT / "desktop" / "src-tauri" / "installer"
FONT = "C:/Windows/Fonts/segoeuib.ttf"  # Segoe UI Bold, Windows' own font

DARK = (49, 51, 56)        # the chat's background, #313338
LIGHT = (219, 222, 225)    # the chat's text, #dbdee1


def cat(size):
    """The round icon, scaled down to size x size pixels."""
    return ICON.resize((size, size), Image.LANCZOS)


def header():
    # The installer's header is white, with the page's title on the left: the cat goes on the right.
    image = Image.new("RGB", (150, 57), "white")
    small = cat(45)
    image.paste(small, (150 - 45 - 6, 6), small)  # the third argument: use its transparency
    image.save(INSTALLER / "header.bmp")


def sidebar():
    # Dark like the chat, with the cat and the name in the middle.
    image = Image.new("RGB", (164, 314), DARK)
    big = cat(120)
    image.paste(big, ((164 - 120) // 2, 80), big)
    draw = ImageDraw.Draw(image)
    draw.text((164 // 2, 225), "ChatApp", fill=LIGHT, font=ImageFont.truetype(FONT, 22), anchor="mm")
    image.save(INSTALLER / "sidebar.bmp")


INSTALLER.mkdir(exist_ok=True)
header()
sidebar()
cat(176).save(ROOT / "desktop" / "ui" / "cat.png")  # shown at 88px: twice that for sharp high-DPI screens
print("Made header.bmp, sidebar.bmp and cat.png")
