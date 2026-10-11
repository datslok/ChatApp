# Unpacks chatapp-data.zip (made by scripts\server\export.ps1 on the old PC) into this folder: chat.db,
# uploads/, releases/ and .env, in the project folder. Run it on the new PC, before scripts\server\install.ps1:
#
#   .\scripts\server\import.ps1                       (chatapp-data.zip in the project folder)
#   .\scripts\server\import.ps1 D:\chatapp-data.zip   (somewhere else, like a USB stick)
#
# It refuses to overwrite an existing chat.db (that could be a live chat's messages), unless you
# add -Force.

param(
    [string]$Zip = (Join-Path (Split-Path (Split-Path $PSScriptRoot)) "chatapp-data.zip"),
    [switch]$Force
)

$root = Split-Path (Split-Path $PSScriptRoot)  # the project folder: two up from scripts\server\
Set-Location $root

if (-not (Test-Path $Zip)) {
    Write-Host "Can't find $Zip. Make it with .\scripts\server\export.ps1 on the old PC first."
    exit 1
}
if ((Test-Path chat.db) -and -not $Force) {
    Write-Host "There's already a chat.db here. To replace it with the one in the zip, run:"
    Write-Host "  .\scripts\server\import.ps1 $Zip -Force"
    exit 1
}

Write-Host "Unpacking $Zip..."
Expand-Archive -Path $Zip -DestinationPath $root -Force
foreach ($item in "chat.db", "uploads", "releases", ".env") {
    $found = if (Test-Path $item) { "ok" } else { "MISSING" }
    Write-Host "  $item : $found"
}
Write-Host ""
Write-Host "Done. Delete the zip (and the copy on the USB stick): it holds your secrets."
Write-Host "Next: .\scripts\server\install.ps1 (as administrator), if you haven't yet."
