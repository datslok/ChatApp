"""Tests for personal_check.py. Every sample address and home folder is built from pieces at run time, so this file
holds none and passes its own check. Run: python -I tools/test_personal_check.py (test.ps1 runs it)."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import personal_check as check  # noqa: E402

AT = "@"
SOMEONE = "kari.nordmann" + AT + "gmail" + ".com"
HOME = "C:" + "\\Users\\" + "kari"


def details(text, private=(), vendored=False):
    return check.personal_details(text, list(private), vendored)


class Details(unittest.TestCase):
    def test_home_folders(self):
        self.assertEqual(details(f"copy it to {HOME}\\bin"), [HOME])
        self.assertTrue(details("C:/" + "users/kari/x"))
        self.assertTrue(details("/" + "home/kari/x"))
        self.assertEqual(details("C:/" + "Users/you/.chatapp-keys"), [])  # a placeholder
        self.assertEqual(details("%USERPROFILE%\\x and $HOME/x and ~/.tauri"), [])

    def test_emails(self):
        self.assertEqual(details(f"mail {SOMEONE}"), [SOMEONE])
        for address in ["owner" + AT + "example.com", "noreply" + AT + "chat.example.com",
                        "123+kari" + AT + "users.noreply.github.com", "git" + AT + "github.com",
                        "icons/128x128" + AT + "2x.png"]:
            self.assertEqual(details(address), [], address)

    def test_the_private_list(self):
        self.assertEqual(details("the router is at 192.168.77.1", ["192.168.77.1"]), ["192.168.77.1"])
        self.assertEqual(details("Hi KARI", ["kari"]), ["kari"])

    def test_vendored_code_keeps_its_notices(self):
        self.assertEqual(details(f"Jean <{SOMEONE}>", vendored=True), [])
        self.assertEqual(details("kari", ["kari"], vendored=True), ["kari"])

    def test_reading_the_private_list(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "list.txt"
            file.write_text("# a comment\nKari\n\n  192.168.77.1  \n", encoding="utf-8")
            self.assertEqual(check.private_patterns(file), ["kari", "192.168.77.1"])
            self.assertEqual(check.private_patterns(Path(folder) / "missing.txt"), [])


class Diffs(unittest.TestCase):
    def test_only_added_lines_with_their_numbers(self):
        diff = ("diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -3,0 +4,2 @@\n"
                f"+fine\n+mail {SOMEONE}\n@@ -9 +11 @@\n-{SOMEONE}\n+gone\n")
        problems = check.diff_problems(diff, [])
        self.assertEqual(len(problems), 1)
        self.assertIn("x.md:5", problems[0])

    def test_vendored_paths(self):
        diff = ("diff --git a/external/a b/external/a\n--- /dev/null\n+++ b/external/a\n@@ -0,0 +1 @@\n"
                f"+{SOMEONE}\n")
        self.assertEqual(check.diff_problems(diff, []), [])

    def test_commit_messages_skip_gits_notes(self):
        self.assertEqual(check.message_problems(f"Fix\n# {SOMEONE}\n", []), [])
        self.assertEqual(len(check.message_problems(f"Fix for {SOMEONE}\n", [])), 1)


class TheHooks(unittest.TestCase):
    """Both git hooks in a repo of their own, as git runs them."""

    def git(self, folder, *arguments):
        return subprocess.run(["git", "-C", folder, *arguments], capture_output=True, text=True)

    def test_a_commit_is_refused_and_a_clean_one_passes(self):
        hooks = Path(check.__file__).resolve().parent / "githooks"
        tools = Path(check.__file__).resolve().parent
        with tempfile.TemporaryDirectory() as folder:
            self.git(folder, "init", "-q")
            self.git(folder, "config", "user.name", "Test")
            self.git(folder, "config", "user.email", "test" + AT + "example.com")
            self.git(folder, "config", "core.hooksPath", hooks.as_posix())
            (Path(folder) / "tools").mkdir()
            (Path(folder) / "tools" / "personal_check.py").write_text(
                (tools / "personal_check.py").read_text(encoding="utf-8"), encoding="utf-8")
            (Path(folder) / "notes.md").write_text(f"ask {SOMEONE}\n", encoding="utf-8")
            self.git(folder, "add", "-A")
            refused = self.git(folder, "commit", "-q", "-m", "notes")
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("personal:", refused.stdout + refused.stderr)
            (Path(folder) / "notes.md").write_text("ask the owner\n", encoding="utf-8")
            self.git(folder, "add", "-A")
            self.assertEqual(self.git(folder, "commit", "-q", "-m", "notes").returncode, 0)
            message = self.git(folder, "commit", "-q", "--allow-empty", "-m", f"from {HOME}")
            self.assertNotEqual(message.returncode, 0)


if __name__ == "__main__":
    unittest.main()
