# From the development PC: how much space the chat takes up on the server PC (database, uploads,
# releases, logs, backups, free disk space). Only reads, never changes anything.
#
#   .\scripts\usage.ps1
#
# It runs scripts\server\usage.ps1 on the server over SSH (set up once with scripts\server-connect.ps1).

$ServerFolder = "C:\ChatApp"  # where the code is on the server PC (README, step 2)

ssh chatserver "cd $ServerFolder; .\scripts\server\usage.ps1"
exit $LASTEXITCODE
