"""Read the bug reports and ideas people sent from Settings → Bugs & ideas, and tick them off.

Every report is also emailed to the admins when it's sent; this is the list of all of them.

Run it from the project folder:
    python tools/feedback.py                   # the ones not done yet (in the real chat.db)
    python tools/feedback.py --all             # every one, done ones too
    python tools/feedback.py --done 12         # mark #12 as done (--undo 12 to take it back)
    python tools/feedback.py --db dev.db       # in the development database
"""
import argparse
import sqlite3
import sys

parser = argparse.ArgumentParser(description="List bug reports and ideas, or mark them done.")
parser.add_argument("--all", action="store_true", help="also show the ones marked done")
parser.add_argument("--done", type=int, metavar="ID", help="mark this one as done")
parser.add_argument("--undo", type=int, metavar="ID", help="mark this one as not done again")
parser.add_argument("--db", default="chat.db", help="which database (default: chat.db, the real chat)")
args = parser.parse_args()

db = sqlite3.connect(args.db)

if args.done is not None or args.undo is not None:
    feedback_id = args.done if args.done is not None else args.undo
    with db:
        cursor = db.execute("UPDATE feedback SET done = ? WHERE id = ?", (1 if args.done is not None else 0, feedback_id))
    if cursor.rowcount == 0:
        print(f"There's no feedback #{feedback_id} in {args.db}.")
        sys.exit(1)
    print(f"#{feedback_id} is {'done' if args.done is not None else 'not done'}.")
    sys.exit()

rows = db.execute(
    f"""
    SELECT feedback.id, feedback.kind, feedback.text, feedback.created_at, feedback.done, users.username
    FROM feedback JOIN users ON users.id = feedback.user_id
    {"" if args.all else "WHERE feedback.done = 0"}
    ORDER BY feedback.id
    """
).fetchall()
if not rows:
    print("Nothing here." if args.all else "Nothing left to do. (--all shows the done ones too.)")
for feedback_id, kind, text, created_at, done, username in rows:
    label = "Bug" if kind == "bug" else "Idea"
    print(f"#{feedback_id}  {label} from {username}, {created_at} (UTC){'  [done]' if done else ''}")
    for line in text.splitlines():
        print("    " + line)
    print()
