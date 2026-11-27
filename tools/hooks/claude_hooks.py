"""Checks Claude Code runs around Claude's own tool calls, so the rules a script can check are checked.

Registered in .claude/settings.json; what each does and why: docs/notes/claude-code.md; tested by
tools/hooks/test_claude_hooks.py. Only the standard library, so any Python runs it.
Usage: python -I tools/hooks/claude_hooks.py <check>, with the hook event as JSON on stdin.
Exit code 2 blocks the call (or, after it, shows the reason) to Claude; asking the user or reminding Claude is JSON
on stdout.
"""

import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Which files are code and which notes file covers each: one home, the docs check.
sys.path.insert(0, str(REPO_ROOT / "tools"))
import docs_check  # noqa: E402

# The most paths or facts a reminder names, so a big change stays readable.
MOST_NAMED = 20

# ---------- Reading a command line ----------

# A heredoc's body (the text a script feeds a program), from its << line to its closing word.
HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n.*?\n\1\s*(\n|$)", re.DOTALL)
# Quoted text: a message, a string or a quoted path (PowerShell's @'...'@ is quoted text too).
QUOTED = re.compile(r"\"[^\"]*\"|'[^']*'")
# Where one command ends and the next starts.
COMMAND_BREAK = re.compile(r"&&|\|\||[;|\n]")
# Words before a command's program: PowerShell's call operator and bash's VAR=value.
BEFORE_PROGRAM = re.compile(r"^(&|\w+=\S*)$")
# git options that take the next word as their value.
GIT_OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree"}


# One program a command line runs. words: its words with quoted text emptied, so a quoted message says nothing about
# what runs; text: its original text, quotes included.
@dataclass
class Command:
    program: str
    words: list
    text: str


def commands_run(command_line):
    """The programs a command line runs, heredoc bodies left out. Quoted text is masked while splitting, so a ; inside
    a commit message doesn't start a command."""
    quoted = []

    def mask(match):
        quoted.append(match.group(0))
        return f"\x00{len(quoted) - 1}\x00"

    def unmask(text):
        return re.sub(r"\x00(\d+)\x00", lambda match: quoted[int(match.group(1))], text)

    masked_line = QUOTED.sub(mask, HEREDOC.sub("\n", command_line))
    commands = []
    for part in COMMAND_BREAK.split(masked_line):
        masked_words = part.split()
        while masked_words and BEFORE_PROGRAM.match(masked_words[0]):
            masked_words.pop(0)
        if not masked_words:
            continue
        words = [re.sub(r"\x00\d+\x00", '""', word) for word in masked_words]
        commands.append(Command(program=program_name(unmask(masked_words[0])), words=words, text=unmask(part).strip()))
    return commands


def program_name(word):
    """A program's bare name, lower case: "C:\\x\\Git.EXE" becomes git."""
    name = word.strip("\"'").replace("\\", "/").rsplit("/", 1)[-1].lower()
    return name[:-4] if name.endswith(".exe") else name


def git_subcommands(command_line):
    """(subcommand, its words) for each git command a line runs."""
    found = []
    for command in commands_run(command_line):
        if command.program != "git":
            continue
        words = command.words[1:]
        while words and words[0].startswith("-"):
            words = words[2:] if words[0] in GIT_OPTIONS_WITH_VALUE else words[1:]
        if words:
            found.append((words[0], words[1:]))
    return found


# ---------- Commands that break a rule ----------

# The user is the only author of every commit (their global CLAUDE.md).
AI_ATTRIBUTION = re.compile(r"Co-Authored-By:[^\n]*(Claude|Anthropic)|Generated with \[?Claude|noreply@anthropic\.com",
                            re.IGNORECASE)

# Files that must never be committed: secrets, keys, this PC's own notes.
SECRET_NAMES = {".env", "dev-secrets.env", "dev-chattus.env", "firebase-key.json", "google-services.json",
                "CLAUDE.local.md", "settings.local.json"}
SECRET_SUFFIXES = (".jks", ".keystore", ".p12", ".pem", ".key")

# Each check below looks at the programs a line runs (commands_run), never at quoted text: a commit message that
# mentions pkill or keytool runs neither.

# Stopping a program by its name stops the user's copies too (drive-desktop skill): only by process id.
STOPPERS = {"stop-process", "spps", "kill"}
PROCESS_LISTERS = {"get-process", "gps", "ps"}

# The real phone app (not the dev one, no.datslok.chat.dev) is never cleared, stopped or removed (drive-phone skill).
REAL_APP_TOUCHED = re.compile(r"\b(pm\s+clear|uninstall|force-stop)\s+(--user\s+\d+\s+|-k\s+)?no\.datslok\.chat(?![\w.])")
# Starting the app on the phone begins a test round, which needs the user's yes (drive-phone skill).
APP_STARTED = re.compile(r"\bam\s+start\b|\bmonkey\b")

# Packages in the phone app only with `npx expo install` (.claude/rules/phone-app.md): npm picks versions that don't
# match Expo SDK 57.
PACKAGE_MANAGERS = {"npm", "yarn", "pnpm"}
INSTALLS = {"install", "i", "add"}


def is_secret(path):
    name = path.replace("\\", "/").rsplit("/", 1)[-1]
    return name in SECRET_NAMES or name.endswith(SECRET_SUFFIXES)


def attribution_problem(command_line):
    if not any(name == "commit" for name, _ in git_subcommands(command_line)):
        return None
    texts = [command_line]
    for command in commands_run(command_line):
        for flag, value in zip(command.text.split(), command.text.split()[1:]):
            if flag in ("-F", "--file"):
                try:
                    texts.append(Path(value.strip("\"'")).read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    pass
    if any(AI_ATTRIBUTION.search(text) for text in texts):
        return "No AI attribution in commits: the user is the only author (their global CLAUDE.md)."
    return None


def secret_problem(command_line, staged):
    """A secret staged for a commit, or forced past .gitignore with git add -f."""
    subcommands = git_subcommands(command_line)
    for name, words in subcommands:
        if name == "add" and ("-f" in words or "--force" in words):
            forced = [word for word in words if not word.startswith("-") and is_secret(word)]
            if forced:
                return f"{forced[0]} is a secret or this PC's own file: never committed (CLAUDE.md)."
    if any(name == "commit" for name, _ in subcommands):
        secrets = [path for path in staged if is_secret(path)]
        if secrets:
            return f"{', '.join(secrets)} would be committed: secrets and CLAUDE.local.md never are (git restore " \
                   f"--staged it)."
    return None


def npm_problem(command_line, cwd):
    in_mobile = "mobile" in Path(cwd or "").parts or re.search(r"\bmobile\b", command_line) is not None
    for command in commands_run(command_line):
        if command.program in PACKAGE_MANAGERS and len(command.words) > 2 and command.words[1] in INSTALLS:
            packages = [word for word in command.words[2:] if not word.startswith("-")]
            if packages and in_mobile:
                return (f"Packages in the phone app only with `npx expo install {' '.join(packages)}`: it picks the "
                        f"versions Expo SDK 57 expects (.claude/rules/phone-app.md).")
    return None


def kills_by_name(commands):
    """Whether a line stops programs by name: Stop-Process -Name, taskkill /IM, pkill, killall, or Get-Process <name>
    piped straight into Stop-Process (through Where-Object, by path or command line, is fine)."""
    for command, after in zip(commands, commands[1:] + [None]):
        flags = {word.lower() for word in command.words[1:]}
        if command.program in STOPPERS and flags & {"-name", "-processname"}:
            return True
        if (command.program == "taskkill" and "/im" in flags) or command.program in ("pkill", "killall"):
            return True
        named = [word for word in command.words[1:] if not word.startswith("-")]
        by_name = (named and "-id" not in flags) or "-name" in flags
        if command.program in PROCESS_LISTERS and by_name and after is not None and after.program in STOPPERS:
            return True
    return False


def touches_real_app(commands):
    return any(command.program == "adb" and REAL_APP_TOUCHED.search(command.text) for command in commands)


def starts_phone_app(command_line):
    return any(command.program == "adb" and APP_STARTED.search(command.text) for command in commands_run(command_line))


def makes_new_key(commands):
    for command in commands:
        words = [word.lower() for word in command.words]
        if command.program == "keytool" and any(word.startswith("-genkey") for word in words):
            return True
        if "signer" in words and "generate" in words and (command.program == "tauri" or "tauri" in words):
            return True
    return False


def skips_git_hooks(command_line):
    """--no-verify (or commit's -n) skips the personal check: only when the user asks."""
    return any("--no-verify" in words or (name == "commit" and "-n" in words)
               for name, words in git_subcommands(command_line) if name in ("commit", "push", "merge"))


def command_problem(command_line, cwd, staged):
    """Why a command line must not run, or None. staged: a function, so git runs only when needed."""
    commands = commands_run(command_line)
    checks = [
        lambda: attribution_problem(command_line),
        lambda: "Git's hooks (the personal check) aren't skipped unless the user asks."
                if skips_git_hooks(command_line) else None,
        lambda: secret_problem(command_line, staged()),
        lambda: npm_problem(command_line, cwd),
        lambda: "Stop only the processes you started, by id: the user may have the same program open "
                "(drive-desktop skill)." if kills_by_name(commands) else None,
        lambda: "That's the user's real ChatApp: tests use no.datslok.chat.dev (drive-phone skill)."
                if touches_real_app(commands) else None,
        lambda: "Never make a new signing key: installed apps would refuse every update signed with it "
                "(CLAUDE.local.md says where the keys are)." if makes_new_key(commands) else None,
    ]
    for check in checks:
        problem = check()
        if problem is not None:
            return problem
    return None


# ---------- Edits that break a rule ----------

# User text never goes in with innerHTML (CLAUDE.md, .claude/rules/web-page.md); icons.js puts our own fixed SVG
# shapes in that way.
HTML_FROM_TEXT = re.compile(r"\.(innerHTML|outerHTML)\s*\+?=(?!=)(?!\s*(\"\"|''|``)\s*;)|\binsertAdjacentHTML\s*\(|"
                            r"\bdocument\.write(ln)?\s*\(")
INNER_HTML_ALLOWED = {"static/js/icons.js"}

# The tests are black-box only (.claude/rules/server.md).
TEST_IMPORTS_SERVER = re.compile(r"^\s*(from|import)\s+(server|chatapp)\b", re.MULTILINE)

# Nothing of the app over the lock screen but the incoming-call screen (.claude/rules/phone-app.md). The push
# module's manifest declares that screen, Notifications.kt's full-screen intent opens it, PushModule.kt asks for
# the permission it needs.
LOCK_SCREEN_FLAGS = re.compile(r"showWhenLocked|turnScreenOn|FLAG_SHOW_WHEN_LOCKED|FLAG_TURN_SCREEN_ON|"
                               r"FLAG_DISMISS_KEYGUARD|FullScreenIntent|FULL_SCREEN_INTENT", re.IGNORECASE)
PUSH_MODULE = "mobile/modules/push/android/src/main/"
LOCK_SCREEN_ALLOWED = {PUSH_MODULE + "AndroidManifest.xml", PUSH_MODULE + "java/no/datslok/push/IncomingCallActivity.kt",
                       PUSH_MODULE + "java/no/datslok/push/Notifications.kt",
                       PUSH_MODULE + "java/no/datslok/push/PushModule.kt"}


def repo_path(file_path):
    """A file's path from the repo's root with / separators, or None when it's outside the repo."""
    try:
        return Path(file_path).resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except (ValueError, OSError):
        return None


def edit_problem(path, text):
    """Why this text must not be written to this file (a path from the repo's root), or None."""
    if path is None:
        return None
    if path.startswith("mobile/android/"):
        return "mobile/android/ is made by prebuild: change app.json or mobile/plugins instead (phone-app rule)."
    if is_secret(path):
        return f"{path} holds a secret or a key: the user sets those themselves (CLAUDE.md)."
    if (path.startswith("static/") and path.endswith((".js", ".html")) and path not in INNER_HTML_ALLOWED
            and not path.startswith(docs_check.NOT_OURS) and HTML_FROM_TEXT.search(text)):
        return ("No innerHTML, outerHTML, insertAdjacentHTML or document.write: build elements and set textContent, "
                "so nobody's text can become HTML (web-page rule).")
    if re.match(r"^tests/.+\.py$", path) and TEST_IMPORTS_SERVER.search(text):
        return "The tests are black-box: talk to the test server over HTTP and WebSockets, never import it (server rule)."
    if path.startswith("mobile/") and path not in LOCK_SCREEN_ALLOWED and LOCK_SCREEN_FLAGS.search(text):
        return ("Nothing of the app over the lock screen: only IncomingCallActivity may be (phone-app rule). Ask the "
                "user before adding anything else that shows while locked.")
    return None


# ---------- Line endings ----------

def ending_flips(eol_listing):
    """The files whose line endings changed from what git has, from `git ls-files --eol` lines:
    (path, git's style, the working file's style). A mixed file counts too, unless git's copy was already mixed."""
    flips = []
    for line in eol_listing.splitlines():
        info, _, path = line.partition("\t")
        fields = info.split()
        if len(fields) < 2 or not path:
            continue
        index, work = fields[0].removeprefix("i/"), fields[1].removeprefix("w/")
        if index in ("lf", "crlf") and work in ("lf", "crlf", "mixed") and work != index:
            flips.append((path, index, work))
    return flips


# A shell command's own changes are from its last two minutes (commands that change files don't run longer).
RECENT_SECONDS = 120


def recently_changed(path):
    file = REPO_ROOT / path
    return file.is_file() and time.time() - file.stat().st_mtime < RECENT_SECONDS


def restore_endings(path, style):
    """Write the file back with git's line endings (lf or crlf), its text unchanged."""
    file = REPO_ROOT / path
    data = file.read_bytes().replace(b"\r\n", b"\n")
    file.write_bytes(data.replace(b"\n", b"\r\n") if style == "crlf" else data)


# ---------- Before a commit: reminders ----------

# A doc's facts a script can see: backticked names, links, and numbers that say something (a decimal, two digits or
# more, or a unit).
BACKTICKED = re.compile(r"`([^`\n]+)`")
LINK = re.compile(r"\]\(([^)\s]+)\)|https?://[^\s)>\]]+")
NUMBER = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s?(%|[kKMG]?B\b|ms\b|min\b|s\b|Hz\b|px\b|fps\b|dB\b)?")

# Code friends could notice: the page, the phone app, the Windows app, the server.
USER_FACING = ("static/", "mobile/", "desktop/", "chatapp/", "server.py", "chattus.py")
SERVER_CODE = ("server.py", "chatapp/", "chattus.py")
DESKTOP_APP_CODE = "desktop/src-tauri/"
MANUAL_STEPS = ("scripts/", "serve.ps1", "start.ps1", "voice.ps1", "setup.ps1", "test.ps1", "chattus.ps1", "llama.ps1")


def doc_facts(text):
    facts = {}
    for match in BACKTICKED.finditer(text):
        facts.setdefault("`" + match.group(1) + "`", None)
    for match in LINK.finditer(text):
        facts.setdefault(match.group(1) or match.group(0).rstrip(".,;:"), None)
    for match in NUMBER.finditer(BACKTICKED.sub(" ", text)):
        number, unit = match.group(1), match.group(2) or ""
        if unit or "." in number or len(number) >= 2:
            facts.setdefault(number + (" " + unit if unit else ""), None)
    return list(facts)


def vanished_facts(old_docs, new_docs):
    """(path, fact) for each fact a changed doc had at HEAD that no doc has now."""
    kept = set()
    for text in new_docs.values():
        kept.update(doc_facts(text))
    return [(path, fact) for path, text in old_docs.items() for fact in doc_facts(text) if fact not in kept]


def named(items):
    more = f" (and {len(items) - MOST_NAMED} more)" if len(items) > MOST_NAMED else ""
    return ", ".join(items[:MOST_NAMED]) + more


def commit_reminders(changed, covering, old_docs, new_docs, tests_ran_after):
    """The reminders for a commit of these paths, as sentences."""
    reminders = []
    vanished = vanished_facts(old_docs, new_docs)
    if vanished:
        reminders.append(f"Gone from every doc since HEAD: {named([f'{path}: {fact}' for path, fact in vanished])}. "
                         f"Compact, never lose meaning: put back or move what still holds, and tell the user what "
                         f"was dropped and why.")
    stale = {}
    for path in changed:
        if docs_check.is_code(path):
            doc = docs_check.describing_doc(path, covering)
            if doc not in changed:
                stale.setdefault(doc, []).append(path)
    for doc, paths in stale.items():
        whose = f"{doc} didn't" if doc else "no docs/notes file's Covers: line claims them"
        reminders.append(f"{named(paths)} changed; {whose}: if what it does changed, rewrite its section.")
    code = [path for path in changed if docs_check.is_code(path)]
    if any(path.startswith(USER_FACING) for path in code) and "static/changelog.json" not in changed:
        reminders.append("No What's new line: if friends would notice this, add one (whats-new rule); plain fixes "
                         "and discreet admin features get none.")
    if any(path.startswith(MANUAL_STEPS) for path in code) and not any(p.startswith("docs/guides/") for p in changed):
        reminders.append("A script changed but no guide did: its guide and docs/guides/scripts.md describe it.")
    if any(path.startswith(SERVER_CODE) for path in code) and not tests_ran_after:
        reminders.append("Server code changed since the tests last ran: run test.ps1 first.")
    if any(path.startswith(DESKTOP_APP_CODE) and docs_check.is_code(path) for path in changed):
        reminders.append("The Windows app's code changed: release it as part of this (go-live skill).")
    return reminders


# ---------- git ----------

def git(*arguments):
    result = subprocess.run(["git", "-C", str(REPO_ROOT), *arguments], capture_output=True, encoding="utf-8",
                            errors="replace")
    return result.stdout.strip() if result.returncode == 0 else ""


def changed_paths():
    """Paths changed since HEAD, staged or not, and new files: `git add -A && git commit` stages in the same line."""
    tracked = git("diff", "HEAD", "--name-only").splitlines()
    untracked = git("ls-files", "--others", "--exclude-standard").splitlines()
    return [line for line in tracked + untracked if line]


def staged_paths():
    return [line for line in git("diff", "--cached", "--name-only").splitlines() if line]


def docs_now():
    docs = {}
    for path in git("ls-files", "--cached", "--others", "--exclude-standard", "*.md").splitlines():
        try:
            docs[path] = (REPO_ROOT / path).read_text(encoding="utf-8", errors="replace")
        except OSError:
            pass
    return docs


def docs_at_head():
    docs = {}
    for path in git("diff", "HEAD", "--name-only", "--", "*.md").splitlines():
        text = git("show", f"HEAD:{path}")
        if text:
            docs[path] = text
    return docs


def tests_ran_after(paths):
    """Whether pytest's cache was written after the newest of these files changed."""
    cache = REPO_ROOT / ".pytest_cache"
    stamps = [file.stat().st_mtime for file in cache.rglob("*") if file.is_file()] if cache.exists() else []
    changed = [(REPO_ROOT / path).stat().st_mtime for path in paths if (REPO_ROOT / path).is_file()]
    return bool(stamps) and (not changed or max(stamps) >= max(changed))


# ---------- Answering Claude Code ----------

def block(reason):
    print(reason, file=sys.stderr)
    sys.exit(2)


def ask(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask",
                                             "permissionDecisionReason": reason}}))


def remind(text):
    print(json.dumps({"systemMessage": text,
                      "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": text}}))


# ---------- The checks ----------

def check_commands(event):
    """PreToolUse, Bash and PowerShell: blocks what breaks a rule, asks before a phone test round, reminds before a
    commit."""
    tool_input = event.get("tool_input", {})
    command_line = tool_input.get("command", "")
    problem = command_problem(command_line, event.get("cwd", ""), staged_paths)
    if problem is not None:
        block(problem)
    if starts_phone_app(command_line):
        ask("This starts the app on the phone: has the user said they're ready, on the home screen with the app "
            "closed, for this round? (drive-phone skill)")
        return
    if any(name == "commit" for name, _ in git_subcommands(command_line)):
        changed = changed_paths()
        server = [path for path in changed if path.startswith(SERVER_CODE)]
        reminders = commit_reminders(changed, docs_check.covering_docs(REPO_ROOT), docs_at_head(), docs_now(),
                                     tests_ran_after(server))
        if reminders:
            remind("Before this commit: " + " ".join(reminders))


def check_edits(event):
    """PreToolUse, Edit and Write: the text an edit would put in a file."""
    tool_input = event.get("tool_input", {})
    text = tool_input.get("new_string") or tool_input.get("content") or ""
    problem = edit_problem(repo_path(tool_input.get("file_path", "")), text)
    if problem is not None:
        block(problem)


def check_line_endings(event):
    """PostToolUse, Edit, Write, Bash and PowerShell: a file whose line endings flipped gets git's back."""
    file_path = event.get("tool_input", {}).get("file_path")
    if file_path:
        paths = [repo_path(file_path)]
    else:  # a shell command: only what it just changed, never the user's own edits from before
        paths = [path for path in git("diff", "--name-only").splitlines() if recently_changed(path)]
    paths = [path for path in paths if path]
    if not paths:
        return
    flips = ending_flips(git("ls-files", "--eol", "--", *paths))
    for path, style, _ in flips:
        restore_endings(path, style)
    if flips:
        block("Line endings put back as git has them (CLAUDE.local.md, \"Line endings\"): "
              + "; ".join(f"{path} was {work}, is {style} again" for path, style, work in flips)
              + ". Prefer the Edit tool, or Python with newline=\"\".")


def check_push(event):
    """Stop: commits not pushed yet keep the turn going (CLAUDE.md: always push after committing). Once only: when
    pushing fails (offline), Claude says so instead of looping."""
    if event.get("stop_hook_active"):
        return
    ahead = git("rev-list", "--count", "@{u}..HEAD")
    if ahead.isdigit() and int(ahead) > 0:
        block(f"{ahead} commit(s) not pushed: git push (CLAUDE.md, always push after committing). If pushing "
              f"fails, tell the user.")


CHECKS = {"commands": check_commands, "edits": check_edits, "line-endings": check_line_endings, "push": check_push}


def read_event(stream):
    """The hook event Claude Code writes on stdin. utf-8-sig: a PowerShell pipe puts a byte-order mark first."""
    return json.loads(stream.read().decode("utf-8-sig") or "{}")


if __name__ == "__main__":
    CHECKS[sys.argv[1]](read_event(sys.stdin.buffer))
