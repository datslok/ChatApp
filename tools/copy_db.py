"""Make a safe copy of a SQLite database, even while the server is using it.

    python tools/copy_db.py chat.db backups/chat-copy.db

Copying the file itself while the server writes to it can give a broken copy (half of one write,
half of the next). SQLite's own backup function copies it page by page and makes sure the copy is
one consistent moment of the database.
"""
import sqlite3
import sys

source_file, target_file = sys.argv[1], sys.argv[2]
source = sqlite3.connect(source_file)
target = sqlite3.connect(target_file)
with target:
    source.backup(target)
target.close()
source.close()
print(f"Copied {source_file} to {target_file}")
