"""Make the phone apps' icons from the app icon: the PWA's (the chat installed from the website, see
static/manifest.json) and the native app's (mobile/).

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

The native app (mobile/assets/, named in mobile/app.json):
- android-icon-foreground.png (1024x1024): Android's "adaptive icon" is layers that Android cuts into
  the phone's own shape. This is the top layer: Niamh's line drawing (icon/chattuschattus.png) on
  transparency, inside the "safe zone" (a circle 66 of the icon's 108 units across in its middle), which
  every shape keeps; app.json's backgroundColor (the same blue) is the layer under it.
- android-icon-monochrome.png: the same drawing as a plain shape, for themed icons (Android 13+ colours
  it to match the wallpaper itself; only where it isn't transparent counts).
- icon.png: the icon as it is, for everything else that asks for one.
- The notifications' small icon (the cat as a white shape, a little thicker): in the push and
  call-service modules' res/drawable-*dpi, see the end of this file.

Run it again after changing the icon.
"""
from pathlib import Path
from PIL import Image, ImageFilter

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

# The native app's.
DRAWING = Image.open(ROOT / "icon" / "chattuschattus.png").convert("RGBA")
APP = ROOT / "mobile" / "assets"


def hull(points):
    """The convex hull of these (x, y) points: the corners of the smallest convex polygon around them
    (Andrew's monotone chain). Only those can be the farthest from any middle."""
    points = sorted(set(points))

    def turn(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for point in points:
        while len(lower) >= 2 and turn(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    for point in reversed(points):
        while len(upper) >= 2 and turn(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    return lower[:-1] + upper[:-1]


def enclosing_circle(corners):
    """The smallest circle around these points, as (centre x, centre y, radius): start in the middle of
    their bounding box and keep stepping towards the farthest point, in smaller and smaller steps."""
    x = (min(p[0] for p in corners) + max(p[0] for p in corners)) / 2
    y = (min(p[1] for p in corners) + max(p[1] for p in corners)) / 2
    step = 0.5
    for _ in range(2000):
        far = max(corners, key=lambda p: (p[0] - x) ** 2 + (p[1] - y) ** 2)
        x += (far[0] - x) * step * 0.01
        y += (far[1] - y) * step * 0.01
        step *= 0.997
    radius = max(((p[0] - x) ** 2 + (p[1] - y) ** 2) ** 0.5 for p in corners)
    return x, y, radius


def in_safe_zone(picture, size=1024, share=66 / 108):
    """The picture's drawn part on a size x size transparent square, as big as fits the safe zone (a
    circle share x size across in the middle, which every shape keeps): the smallest circle around the
    drawing is put on that circle, so the drawing is centred by it and touches it (an ear's tip, a
    whisker)."""
    alpha = picture.getchannel("A")
    drawn = [(x, y) for y in range(0, picture.height, 2) for x in range(0, picture.width, 2)
             if alpha.getpixel((x, y)) > 32]  # (every 2nd pixel is plenty)
    centre_x, centre_y, radius = enclosing_circle(hull(drawn))
    scale = (size * share / 2) / radius
    small = picture.resize((round(picture.width * scale), round(picture.height * scale)), Image.LANCZOS)
    square = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # Where the drawing's circle centre lands in the middle of the square.
    square.alpha_composite(small, (round(size / 2 - centre_x * scale), round(size / 2 - centre_y * scale)))
    return square


foreground = in_safe_zone(DRAWING)
foreground.save(APP / "android-icon-foreground.png")
# Monochrome: white wherever the drawing is (Android only uses the shape).
monochrome = Image.new("RGBA", foreground.size, (255, 255, 255, 0))
monochrome.putalpha(foreground.getchannel("A"))
monochrome.save(APP / "android-icon-monochrome.png")
ICON.save(APP / "icon.png")
print(f"Made the app's icons in {APP} (app.json's adaptiveIcon backgroundColor: #{BLUE[0]:02x}{BLUE[1]:02x}{BLUE[2]:02x})")

# The notifications' small icon: the cat in the status bar, in a notification's header, and as the badge
# on a sender's picture. Android draws it in one colour (only where it isn't transparent counts), so
# it's the drawing as a white shape, its lines a little thicker (the drawing's are finer than the 2 dp of
# Android's own icons, and looked faint next to them). The drawing filling Android's icon area as far as
# it goes (22 dp of the 24: a 1 dp margin) and centred in it, in each density's size; Android picks the
# one for the phone's screen. Two copies, as each module draws its own: mobile/modules/push's (messages,
# friend requests, a ringing call) and call-service's (the ongoing call).
WORK_WIDTH = 1000  # the drawing is thickened at this width, so the thickening is the same share of it
THICKER = 19       # px at WORK_WIDTH, each way about 1% of the drawing's width (an odd number: MaxFilter's rule)
DENSITIES = {"mdpi": 24, "hdpi": 36, "xhdpi": 48, "xxhdpi": 72, "xxxhdpi": 96}
NOTIFICATION_ICONS = [
    ROOT / "mobile" / "modules" / "push" / "android" / "src" / "main" / "res" / "drawable-{}" / "push_cat_icon.png",
    ROOT / "mobile" / "modules" / "call-service" / "android" / "src" / "main" / "res" / "drawable-{}" / "call_notification_icon.png",
]

# The drawing has faint specks around it, nearly transparent (invisible, but thickening would grow them
# and they'd count as drawn, putting the cat off centre): cleared first, as in_safe_zone ignores them too.
shape = DRAWING.getchannel("A").point(lambda alpha: alpha if alpha > 32 else 0)
shape = shape.crop(shape.getbbox())  # only the drawn part: its box is what gets centred
shape = shape.resize((WORK_WIDTH, round(shape.height * WORK_WIDTH / shape.width)), Image.LANCZOS)
pad = THICKER  # room for the lines to grow into at the edges
padded = Image.new("L", (shape.width + 2 * pad, shape.height + 2 * pad), 0)
padded.paste(shape, (pad, pad))
shape = padded.filter(ImageFilter.MaxFilter(THICKER))  # every pixel takes the strongest around it: lines grow
shape = shape.crop(shape.getbbox())

for density, size in DENSITIES.items():
    room = size * 22 / 24  # the live area
    scale = room / max(shape.width, shape.height)  # as big as fits, the longer side touching the margin
    small = shape.resize((max(1, round(shape.width * scale)), max(1, round(shape.height * scale))), Image.LANCZOS)
    icon = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    white = Image.new("RGBA", small.size, (255, 255, 255, 255))
    white.putalpha(small)
    icon.alpha_composite(white, ((size - small.width) // 2, (size - small.height) // 2))
    for pattern in NOTIFICATION_ICONS:
        path = Path(str(pattern).format(density))
        path.parent.mkdir(exist_ok=True)
        icon.save(path)
print("Made the notification icons (push_cat_icon.png, call_notification_icon.png) in the modules' res/drawable-*dpi")
