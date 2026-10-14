# From the development PC: copies a video for the seasonal easter egg (server.py, "Seasons") into the
# server PC's seasonal\ folder, named after its season:
#
#   .\scripts\seasonal-upload.ps1 "external\SpOwOky OwOky Pumpkin Song.mp4" halloween
#
# The season's name is one from SEASONS in server.py (the file becomes halloween.mp4 there). Only .mp4
# videos. No restart is needed: pages see the season the next time they connect. The videos aren't in
# git (seasonal\ is git-ignored), so this is how they get there; the server's nightly backup keeps them.
# Uses SSH's file copy (scp), set up once with scripts\server-connect.ps1.

param(
    [Parameter(Mandatory)][string]$File,    # the video, on this PC
    [Parameter(Mandatory)][string]$Season   # its season's name in SEASONS, like halloween
)

$ServerFolder = "C:/ChatApp"  # where the code is on the server PC (scp prefers / in paths)

if (-not (Test-Path $File)) { Write-Host "There's no file $File."; exit 1 }
if ([IO.Path]::GetExtension($File) -ne ".mp4") { Write-Host "Only .mp4 videos (the server sends them as video/mp4)."; exit 1 }
if ($Season -notmatch '^[a-z]+$') { Write-Host "A season's name is lowercase letters only, like halloween."; exit 1 }

Write-Host "Copying $File to the server as seasonal/$Season.mp4..."
ssh chatserver "New-Item -ItemType Directory -Force $ServerFolder/seasonal | Out-Null"
scp $File "chatserver:$ServerFolder/seasonal/$Season.mp4"
if ($LASTEXITCODE -ne 0) { Write-Host "Copying failed (see above)."; exit 1 }
Write-Host "Done: pages show the easter egg during $Season from their next connect." -ForegroundColor Green
