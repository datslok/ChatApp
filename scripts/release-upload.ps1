# From the development PC, after building a new desktop app release (CLAUDE.md, "Releasing a new
# version of the desktop app"): copies it into the server PC's releases\ folder, where the apps
# look for updates.
#
#   .\scripts\release-upload.ps1
#
# It copies what releases\latest.json points to (the installer and its .sig), then latest.json
# itself, last: so an app that checks in the meantime never sees a version whose installer isn't
# there yet. Uses SSH's file copy (scp), set up once with scripts\server-connect.ps1.
#
# Then it restarts the chat (with scripts\deploy.ps1, so newly pushed code goes along): every open
# app reconnects, looks for an update and installs it (someone in a call: once they leave it).

$ServerFolder = "C:/ChatApp"  # where the code is on the server PC (scp prefers / in paths)

Set-Location (Split-Path $PSScriptRoot)  # the project folder: one up from scripts\

$latest = Get-Content releases\latest.json -Raw | ConvertFrom-Json
$installer = Split-Path $latest.platforms."windows-x86_64".url -Leaf  # "ChatApp_0.1.8_x64-setup.exe"
foreach ($file in "releases\$installer", "releases\$installer.sig") {
    if (-not (Test-Path $file)) { Write-Host "Missing: $file (did the build and copy steps finish?)"; exit 1 }
}

Write-Host "Version $($latest.version): copying $installer and its .sig..."
scp "releases\$installer" "releases\$installer.sig" "chatserver:$ServerFolder/releases/"
if ($LASTEXITCODE -ne 0) { Write-Host "Copying failed (see above)."; exit 1 }

Write-Host "Copying latest.json..."
scp releases\latest.json "chatserver:$ServerFolder/releases/"
if ($LASTEXITCODE -ne 0) { Write-Host "Copying latest.json failed (see above)."; exit 1 }

Write-Host "Restarting the chat, so the open apps reconnect and update..."
& .\scripts\deploy.ps1
if ($LASTEXITCODE -ne 0) { Write-Host "The restart failed (see above): the apps update at their next start or reconnect."; exit 1 }

Write-Host "Done: the open apps install version $($latest.version) now (or after their call), the others when they start." -ForegroundColor Green
