# Runs the test suite (tests/) against a server of its own: a temporary database and uploads
# folder, on port 8011, so it never touches chat.db or dev.db and can run beside start.ps1.
#
#   .\test.ps1                      everything, then the docs check and the tools' own tests
#   .\test.ps1 tests\test_people.py one file
#   .\test.ps1 -k block             only tests with "block" in their name
#
# Anything after the script's name goes to pytest as it is (pytest --help lists the options).
# Run setup.ps1 once first: it installs pytest (requirements-dev.txt).

conda activate chatapp
python -m pytest @args
$failed = $LASTEXITCODE -ne 0

# A whole run also checks the docs (tools/docs_check.py) and tests Claude Code's hooks and the personal
# check (docs/notes/claude-code.md). They need only Python's standard library.
if ($args.Count -eq 0) {
    foreach ($check in "tools/docs_check.py", "tools/hooks/test_claude_hooks.py", "tools/test_personal_check.py") {
        python -I $check
        if ($LASTEXITCODE -ne 0) { $failed = $true }
    }
}
if ($failed) { exit 1 } else { exit 0 }
