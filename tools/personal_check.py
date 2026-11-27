"""Keeps personal details out of commits, since the repo is public (docs/notes/claude-code.md, "The personal check").

Run by git's hooks in tools/githooks/, once `git config core.hooksPath tools/githooks` is set:
    python -I tools/personal_check.py staged           every line the commit adds
    python -I tools/personal_check.py message <file>   the commit message
Prints each personal detail found and exits 1 if there are any. Only the standard library.
"""

import re
import subprocess
import sys
from pathlib import Path

# One's own list, outside the repo so it's never published: a word or phrase per line (one's username, email
# address, the router's and server's local addresses, friends' real names), ignoring case; # starts a comment.
PRIVATE_LIST = Path.home() / ".chatapp-private.txt"

# A home folder that names someone: C:\Users\<name> or with forward slashes (any case), /home/<name>. Placeholders
# (C:\Users\you) and variables (%USERPROFILE%, $HOME, ~) name no one, so they pass.
HOME_FOLDER = re.compile(r"\b[a-z]:[\\/]+users[\\/]+([a-z0-9_.-]+)|(?<![\w.])/home/([a-z0-9_][\w.-]*)", re.IGNORECASE)
PLACEHOLDER_USERS = {"you", "yourname", "username", "user", "name", "public", "default", "example"}

# An email address: <user>@<domain> with a dot in the domain.
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")

# Addresses that are no one's: GitHub's noreply addresses (what commits use), the placeholder domains (RFC 2606, and
# their subdomains like chat.example.com), and git@ in a remote's address. A file name like icon@2x.png isn't one.
NOREPLY_DOMAIN = "users.noreply.github.com"
PLACEHOLDER_DOMAINS = ("example.com", "example.org", "example.net")
REMOTE_USER = "git"
FILE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "js", "css", "json"}

# Others' code, vendored unmodified: its licences carry their authors' published notices, emails included, which
# must ship with it. Only the private list's words are looked for there.
VENDORED = ("external/", "static/katex-", "static/jitsi-rnnoise-", "static/workadventure-ns-", "static/livekit-client-",
            "mobile/modules/call-service/android/src/main/cpp/rnnoise-")


def is_someones_email(address):
    user, domain = address.lower().split("@", 1)
    if domain.rsplit(".", 1)[-1] in FILE_EXTENSIONS:
        return False
    placeholder = any(domain == d or domain.endswith("." + d) for d in PLACEHOLDER_DOMAINS)
    return not (domain.endswith(NOREPLY_DOMAIN) or placeholder or user == REMOTE_USER)


def personal_details(text, private, vendored=False):
    """The personal details in a line: home folders, email addresses, and the private list's words.
    vendored: others' code, checked for the private list only."""
    found = []
    if not vendored:
        for match in HOME_FOLDER.finditer(text):
            if (match.group(1) or match.group(2)).lower() not in PLACEHOLDER_USERS:
                found.append(match.group(0))
        found += [match.group(0) for match in EMAIL.finditer(text) if is_someones_email(match.group(0))]
    lowered = text.lower()
    found += [word for word in private if word in lowered]
    return found


def private_patterns(file):
    """The private list's words, lowercase; none when the file doesn't exist (someone else's clone has no list)."""
    if not file.is_file():
        return []
    words = [line.strip().lower() for line in file.read_text(encoding="utf-8").split("\n")]
    return [word for word in words if word and not word.startswith("#")]


def added_lines(diff):
    """Each line a diff adds: (its file, its line number in the new file, its text)."""
    path = None
    number = 0
    in_header = False
    for line in diff.split("\n"):
        if line.startswith("diff --git "):
            in_header = True
        elif in_header and line.startswith("+++ "):
            path = line[len("+++ b/"):] if line.startswith("+++ b/") else None
        elif line.startswith("@@"):
            in_header = False
            number = int(re.match(r"@@ -\S+ \+(\d+)", line).group(1))
        elif in_header or path is None:
            continue
        elif line.startswith("+"):
            yield path, number, line[1:]
            number += 1
        elif line.startswith(" "):
            number += 1


def problem(where, detail):
    return f"personal: {where}: `{detail}`: personal details stay out of the repo, since it's public"


def diff_problems(diff, private):
    return [problem(f"{path}:{number}", detail) for path, number, text in added_lines(diff)
            for detail in personal_details(text, private, path.startswith(VENDORED))]


def message_problems(message, private):
    """Lines starting with # are git's notes in the message editor, never committed."""
    return [problem(f"commit message:{number}", detail)
            for number, text in enumerate(message.split("\n"), start=1) if not text.startswith("#")
            for detail in personal_details(text, private)]


def staged_diff():
    result = subprocess.run(["git", "-c", "core.quotepath=off", "diff", "--cached", "-U0", "--no-color",
                             "--no-ext-diff"], capture_output=True, encoding="utf-8", errors="replace", check=True)
    return result.stdout


def main(arguments, private_file):
    private = private_patterns(private_file)
    if arguments == ["staged"]:
        problems = diff_problems(staged_diff(), private)
    elif len(arguments) == 2 and arguments[0] == "message":
        problems = message_problems(Path(arguments[1]).read_text(encoding="utf-8", errors="replace"), private)
    else:
        print("usage: personal_check.py staged | message <file>")
        return 2
    for line in problems:
        print(line)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], PRIVATE_LIST))
