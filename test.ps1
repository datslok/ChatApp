# Runs the test suite (tests/) against a server of its own: a temporary database and uploads
# folder, on port 8011, so it never touches chat.db or dev.db and can run beside start.ps1.
#
#   .\test.ps1                      everything
#   .\test.ps1 tests\test_people.py one file
#   .\test.ps1 -k block             only tests with "block" in their name
#
# Anything after the script's name goes to pytest as it is (pytest --help lists the options).
# Run setup.ps1 once first: it installs pytest (requirements-dev.txt).

conda activate chatapp
python -m pytest @args
exit $LASTEXITCODE
