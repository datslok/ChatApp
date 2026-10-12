"""Make the AI bot's account, Chattus (or give it a new password), by changing the database directly.

Like make_admin.py: only someone with access to this PC can run it. The account gets a long random
password, which is written into an env file for chattus.py (CHATTUS_PASSWORD), and the app icon as
its profile picture. It has no email (nobody needs to reset its password: run this again instead).
It's marked as a bot (users.is_bot), which lets a mention invite it into a DM between two people.

Run it from the project folder:
    python tools/make_bot.py                       # the real chat: chat.db, uploads/, .env
    python tools/make_bot.py --db dev.db --uploads dev-uploads --env dev-chattus.env   # development

Running it again gives the account a new password (and the picture again, if it has none).
"""
import argparse
import re
import secrets
import sqlite3
from pathlib import Path

from argon2 import PasswordHasher  # the same password hashing as server.py
from PIL import Image

parser = argparse.ArgumentParser(description="Make the AI bot's account, or give it a new password.")
parser.add_argument("--name", default="Chattus", help="the bot's username (default: Chattus)")
parser.add_argument("--db", default="chat.db", help="which database (default: chat.db, the real chat)")
parser.add_argument("--uploads", default="uploads", help="the uploads folder (default: uploads, the real chat's)")
parser.add_argument("--env", default=".env", help="the file to write CHATTUS_PASSWORD into (default: .env)")
parser.add_argument("--picture", default="icon/chattuschattus_square.png", help="the profile picture")
args = parser.parse_args()
if not Path(args.picture).exists():  # checked first, so a wrong path changes nothing
    raise SystemExit(f"There's no picture {args.picture} (run this from the project folder).")

db = sqlite3.connect(args.db)
# users.is_bot marks the account as the bot (a mention can invite it into a DM). The server adds the
# column when it starts; add it here too, in case this runs before the server got the new code.
if "is_bot" not in [column[1] for column in db.execute("PRAGMA table_info(users)")]:
    with db:
        db.execute("ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0")
password = secrets.token_urlsafe(32)  # nobody types it: only chattus.py uses it
password_hash = PasswordHasher().hash(password)

row = db.execute("SELECT id, avatar_id FROM users WHERE username = ?", (args.name,)).fetchone()
with db:
    if row is None:
        cursor = db.execute("INSERT INTO users (username, password_hash, is_bot) VALUES (?, ?, 1)", (args.name, password_hash))
        user_id, avatar_id = cursor.lastrowid, None
        print(f"Made the account {args.name} (id {user_id}) in {args.db}.")
    else:
        user_id, avatar_id = row
        db.execute("UPDATE users SET password_hash = ?, is_bot = 1 WHERE id = ?", (password_hash, user_id))
        db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))  # logins with the old password end
        print(f"{args.name} (id {user_id}) in {args.db} has a new password.")

# The profile picture: shrunk to 256 x 256 and saved as WebP, the way the page saves people's own
# (under a random name in uploads/avatars, which the server serves to logged-in people).
if avatar_id is None:
    folder = Path(args.uploads) / "avatars"
    folder.mkdir(parents=True, exist_ok=True)
    avatar_id = secrets.token_urlsafe(16) + ".webp"
    with Image.open(args.picture) as picture:
        picture.convert("RGBA").resize((256, 256), Image.Resampling.LANCZOS).save(folder / avatar_id, quality=90)
    with db:
        db.execute("UPDATE users SET avatar_id = ? WHERE id = ?", (avatar_id, user_id))
    print(f"Its profile picture is {args.picture}.")

# Write the password into the env file: replace the old line, or add one at the end.
env = Path(args.env)
text = env.read_text(encoding="utf-8") if env.exists() else ""
line = f"CHATTUS_PASSWORD={password}"
if re.search(r"(?m)^CHATTUS_PASSWORD=.*$", text):
    text = re.sub(r"(?m)^CHATTUS_PASSWORD=.*$", line, text)
else:
    text = text.rstrip("\n") + ("\n\n" if text else "") + f"# The AI bot's password (tools/make_bot.py).\n{line}\n"
env.write_text(text, encoding="utf-8")
print(f"Its password is in {args.env} (CHATTUS_PASSWORD). Restart chattus.py if it's running.")
