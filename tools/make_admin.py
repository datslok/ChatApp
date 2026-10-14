"""Make someone an admin (or take it away), by changing the database directly.

Admins can edit and delete anyone's messages and custom emoji, manage channels and roles, and ban
people. The owner (the first account) can also do this in the chat: Settings → Admin → Admins. This
script is for everything else: an admin on a server without an owner, or fixing things by hand.
The server checks is_admin on every action, so no restart is needed.

Run it from the project folder:
    python tools/make_admin.py alex                    # make alex an admin (in the real chat.db)
    python tools/make_admin.py alex --remove           # take it away again
    python tools/make_admin.py alex --db dev.db        # in the development database
    python tools/make_admin.py --list                  # who's an admin?
"""
import argparse
import sqlite3
import sys

# argparse reads the command-line options and makes --help for free.
parser = argparse.ArgumentParser(description="Make someone an admin, or take it away.")
parser.add_argument("username", nargs="?", help="whose admin status to change")
parser.add_argument("--remove", action="store_true", help="take admin away instead of giving it")
parser.add_argument("--db", default="chat.db", help="which database (default: chat.db, the real chat)")
parser.add_argument("--list", action="store_true", help="show who's an admin")
args = parser.parse_args()

db = sqlite3.connect(args.db)

if args.list or not args.username:
    admins = [name + (" (owner)" if owner else "") for name, owner in
              db.execute("SELECT username, is_owner FROM users WHERE is_admin = 1 ORDER BY username")]
    print(f"Admins in {args.db}: {', '.join(admins) if admins else '(none)'}")
    sys.exit()

with db:
    # COLLATE NOCASE on the column: "Alex" finds "alex".
    cursor = db.execute("UPDATE users SET is_admin = ? WHERE username = ?", (0 if args.remove else 1, args.username))
if cursor.rowcount == 0:
    print(f"There's no user called {args.username!r} in {args.db}.")
    sys.exit(1)
print(f"{args.username} is {'no longer' if args.remove else 'now'} an admin (in {args.db}).")
