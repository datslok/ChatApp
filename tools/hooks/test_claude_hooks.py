"""Tests for claude_hooks.py: each check fed made-up commands and edits, and the script run end to end as Claude
Code runs it (the check's name as its argument, the event as JSON on stdin).

Run: python -I tools/hooks/test_claude_hooks.py (test.ps1 runs it). Only the standard library."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import claude_hooks as hooks  # noqa: E402

SCRIPT = Path(hooks.__file__)


def run(check, event):
    """The script as Claude Code runs it: (exit code, stdout, stderr)."""
    result = subprocess.run([sys.executable, "-I", str(SCRIPT), check], input=json.dumps(event).encode(),
                            capture_output=True)
    return result.returncode, result.stdout.decode(), result.stderr.decode()


def problem(command_line, cwd="", staged=()):
    return hooks.command_problem(command_line, cwd, lambda: list(staged))


class ReadingCommands(unittest.TestCase):
    def test_programs_and_quoted_text(self):
        commands = hooks.commands_run('git commit -m "fix; pkill stays text" && & "C:\\Git\\bin\\Git.EXE" push')
        self.assertEqual([command.program for command in commands], ["git", "git"])

    def test_heredoc_bodies_run_nothing(self):
        self.assertEqual([c.program for c in hooks.commands_run("python - <<'EOF'\npkill x\nEOF\n")], ["python"])

    def test_git_subcommands_skip_options(self):
        self.assertEqual(hooks.git_subcommands("git -C /x commit -q -m hi")[0][0], "commit")


class Commands(unittest.TestCase):
    def test_ai_attribution_is_blocked(self):
        address = "noreply" + "@" + "anthropic.com"  # built from pieces, so the personal check passes this file
        self.assertIsNotNone(problem(f'git commit -m "Fix\n\nCo-Authored-By: Claude <{address}>"'))
        self.assertIsNotNone(problem('git commit -m "x\n\nGenerated with [Claude Code](https://claude.com)"'))
        self.assertIsNone(problem('git commit -m "Hooks: block AI attribution lines in commits"'))
        self.assertIsNone(problem('echo "Co-Authored-By: Claude"'))  # not a commit

    def test_attribution_in_a_message_file(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as file:
            file.write("Fix\n\nCo-Authored-By: Claude")
        self.assertIsNotNone(problem(f'git commit -F "{file.name}"'))
        Path(file.name).unlink()

    def test_skipping_git_hooks(self):
        self.assertIsNotNone(problem("git commit --no-verify -m x"))
        self.assertIsNotNone(problem("git commit -n -m x"))
        self.assertIsNone(problem("git log -n 3"))

    def test_secrets_never_committed(self):
        self.assertIsNotNone(problem("git commit -m x", staged=["server.py", ".env"]))
        self.assertIsNotNone(problem("git commit -m x", staged=["CLAUDE.local.md"]))
        self.assertIsNotNone(problem("git add -f dev-secrets.env"))
        self.assertIsNotNone(problem("git commit -m x", staged=["keys/android-release.jks"]))
        self.assertIsNone(problem("git commit -m x", staged=[".env.example", "dev.env", "server.py"]))

    def test_npm_install_in_the_phone_app(self):
        self.assertIsNotNone(problem("npm install expo-camera", cwd="E:\\Code\\ChatApp\\mobile"))
        self.assertIsNotNone(problem("cd mobile; npm i react-native-svg"))
        self.assertIsNone(problem("npx expo install expo-camera", cwd="E:\\Code\\ChatApp\\mobile"))
        self.assertIsNone(problem("npm ci", cwd="E:\\Code\\ChatApp\\mobile"))
        self.assertIsNone(problem("npm install @tauri-apps/cli", cwd="E:\\Code\\ChatApp\\desktop"))

    def test_stopping_programs_by_name(self):
        for line in ["Stop-Process -Name notepad", "taskkill /IM msedge.exe /F", "pkill python",
                     "Get-Process notepad | Stop-Process", "Get-Process -Name msedge | Stop-Process -Force"]:
            self.assertIsNotNone(problem(line), line)
        for line in ["Stop-Process -Id 4242", "Get-Process -Id 4242 | Stop-Process",
                     "Get-Process msedge | Where-Object { $_.Path -like '*scratch*' } | Stop-Process",
                     'git commit -m "drive-desktop: never pkill or taskkill /IM"']:
            self.assertIsNone(problem(line), line)

    def test_the_real_phone_app(self):
        self.assertIsNotNone(problem("adb shell pm clear no.datslok.chat"))
        self.assertIsNotNone(problem('adb shell "am force-stop no.datslok.chat"'))
        self.assertIsNotNone(problem("adb uninstall no.datslok.chat"))
        self.assertIsNone(problem("adb shell pm clear no.datslok.chat.dev"))
        self.assertIsNone(problem("adb shell am force-stop no.datslok.chat.dev"))

    def test_starting_the_app_asks(self):
        self.assertTrue(hooks.starts_phone_app("adb shell am start -n no.datslok.chat.dev/.MainActivity"))
        self.assertTrue(hooks.starts_phone_app('adb shell "monkey -p no.datslok.chat.dev 1"'))
        self.assertFalse(hooks.starts_phone_app("adb shell screencap -p /sdcard/x.png"))
        self.assertFalse(hooks.starts_phone_app('git commit -m "drive-phone: ask before adb am start"'))

    def test_new_signing_keys(self):
        self.assertIsNotNone(problem("keytool -genkeypair -keystore x.jks"))
        self.assertIsNotNone(problem("npx tauri signer generate -w key"))
        self.assertIsNone(problem("keytool -list -keystore x.jks"))
        self.assertIsNone(problem("npx tauri signer sign file"))


class Edits(unittest.TestCase):
    def test_generated_android_folder(self):
        self.assertIsNotNone(hooks.edit_problem("mobile/android/app/build.gradle", "x"))

    def test_secret_files(self):
        self.assertIsNotNone(hooks.edit_problem(".env", "KEY=x"))
        self.assertIsNone(hooks.edit_problem(".env.example", "KEY="))

    def test_inner_html(self):
        page = "static/js/messages.js"
        self.assertIsNotNone(hooks.edit_problem(page, "box.innerHTML = text;"))
        self.assertIsNotNone(hooks.edit_problem(page, "box.innerHTML += `<b>${name}</b>`;"))
        self.assertIsNotNone(hooks.edit_problem(page, 'box.insertAdjacentHTML("beforeend", text);'))
        self.assertIsNone(hooks.edit_problem(page, 'box.innerHTML = "";'))  # emptying it
        self.assertIsNone(hooks.edit_problem(page, "// never innerHTML: text goes in as text nodes"))
        self.assertIsNone(hooks.edit_problem(page, "if (box.innerHTML === old) {"))
        self.assertIsNone(hooks.edit_problem("static/js/icons.js", "svg.innerHTML = ICON_SHAPES[name];"))
        self.assertIsNone(hooks.edit_problem("static/katex-0.18.9/katex.js", "x.innerHTML = y;"))

    def test_black_box_tests(self):
        self.assertIsNotNone(hooks.edit_problem("tests/test_x.py", "from chatapp.db import db\n"))
        self.assertIsNotNone(hooks.edit_problem("tests/test_x.py", "import server\n"))
        self.assertIsNone(hooks.edit_problem("tests/test_x.py", "from conftest import Client\n"))
        self.assertIsNone(hooks.edit_problem("tools/x.py", "from chatapp.db import db\n"))

    def test_lock_screen(self):
        self.assertIsNotNone(hooks.edit_problem("mobile/plugins/main.js", 'android:showWhenLocked="true"'))
        self.assertIsNotNone(hooks.edit_problem("mobile/src/CallBanner.js", "setShowWhenLocked(true)"))
        call_screen = hooks.PUSH_MODULE + "java/no/datslok/push/IncomingCallActivity.kt"
        self.assertIsNone(hooks.edit_problem(call_screen, "setShowWhenLocked(true)"))

    def test_outside_the_repo(self):
        self.assertIsNone(hooks.edit_problem(None, "box.innerHTML = text;"))


class LineEndings(unittest.TestCase):
    def test_flips(self):
        listing = ("i/crlf  w/lf    attr/                 \tCLAUDE.md\n"
                   "i/lf    w/lf    attr/                 \tserver.py\n"
                   "i/lf    w/mixed attr/                 \tsettings.js\n"
                   "i/mixed w/mixed attr/                 \told.js\n"
                   "i/-text w/-text attr/-text            \tx.bat\n")
        self.assertEqual(hooks.ending_flips(listing), [("CLAUDE.md", "crlf", "lf"), ("settings.js", "lf", "mixed")])


class Reminders(unittest.TestCase):
    COVERING = {"chatapp/voice.py": "docs/notes/voice.md", "static/": "docs/notes/web-page.md",
                "scripts/": "docs/notes/operations.md"}

    def reminders(self, changed, old_docs=None, new_docs=None, tests_ran=True):
        return " ".join(hooks.commit_reminders(changed, self.COVERING, old_docs or {}, new_docs or {}, tests_ran))

    def test_stale_notes(self):
        self.assertIn("docs/notes/voice.md didn't", self.reminders(["chatapp/voice.py"]))
        self.assertNotIn("voice.md didn't", self.reminders(["chatapp/voice.py", "docs/notes/voice.md"]))
        self.assertIn("no docs/notes file", self.reminders(["chatapp/new.py"]))

    def test_whats_new(self):
        self.assertIn("What's new", self.reminders(["static/js/rooms.js"]))
        self.assertNotIn("What's new", self.reminders(["static/js/rooms.js", "static/changelog.json"]))
        self.assertNotIn("What's new", self.reminders(["tools/docs_check.py"]))

    def test_scripts_and_guides(self):
        self.assertIn("no guide did", self.reminders(["scripts/deploy.ps1"]))
        self.assertNotIn("no guide did", self.reminders(["scripts/deploy.ps1", "docs/guides/running.md"]))

    def test_tests_before_a_server_commit(self):
        self.assertIn("run test.ps1", self.reminders(["chatapp/voice.py"], tests_ran=False))
        self.assertNotIn("run test.ps1", self.reminders(["chatapp/voice.py"], tests_ran=True))

    def test_desktop_release(self):
        self.assertIn("release it", self.reminders(["desktop/src-tauri/src/main.rs"]))

    def test_vanished_facts(self):
        old = {"docs/notes/voice.md": "Rings for `RING_SECONDS` (30 s)."}
        self.assertIn("`RING_SECONDS`", self.reminders([], old, {"docs/notes/voice.md": "Rings (30 s)."}))
        moved = {"docs/notes/voice.md": "Rings.", "docs/notes/push.md": "`RING_SECONDS` (30 s)"}
        self.assertNotIn("Gone from", self.reminders([], old, moved))


class EndToEnd(unittest.TestCase):
    def test_a_blocked_command(self):
        code, _, stderr = run("commands", {"tool_input": {"command": "taskkill /IM notepad.exe"}, "cwd": "."})
        self.assertEqual(code, 2)
        self.assertIn("by id", stderr)

    def test_a_question(self):
        code, stdout, _ = run("commands", {"tool_input": {"command": "adb shell am start -n no.datslok.chat.dev/.X"}})
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout)["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_a_harmless_command(self):
        self.assertEqual(run("commands", {"tool_input": {"command": "git status"}}), (0, "", ""))

    def test_a_blocked_edit(self):
        path = str(hooks.REPO_ROOT / "static" / "js" / "messages.js")
        code, _, stderr = run("edits", {"tool_input": {"file_path": path, "new_string": "a.innerHTML = b;"}})
        self.assertEqual(code, 2)
        self.assertIn("textContent", stderr)

    def test_a_byte_order_mark(self):
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), "commands"],
                                input=b"\xef\xbb\xbf" + json.dumps({"tool_input": {"command": "ls"}}).encode(),
                                capture_output=True)
        self.assertEqual(result.returncode, 0)

    def test_stop_once_only(self):
        self.assertEqual(run("push", {"stop_hook_active": True})[0], 0)


if __name__ == "__main__":
    unittest.main()
