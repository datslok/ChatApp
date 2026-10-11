# Unpacks chatapp-data.zip (made by server-export.ps1 on the old PC) into this folder: chat.db,
# uploads/, releases/ and .env. Run it on the new PC, before server-install.ps1:
#
#   .\server-import.ps1                       (chatapp-data.zip next to this script)
#   .\server-import.ps1 D:\chatapp-data.zip   (somewhere else, like a USB stick)
#
# It refuses to overwrite an existing chat.db (that could be a live chat's messages), unless you
# add -Force.

param(
    [string]$Zip = (Join-Path $PSScriptRoot "chatapp-data.zip"),
    [switch]$Force
)

Set-Location $PSScriptRoot

if (-not (Test-Path $Zip)) {
    Write-Host "Can't find $Zip. Make it with .\server-export.ps1 on the old PC first."
    exit 1
}
if ((Test-Path chat.db) -and -not $Force) {
    Write-Host "There's already a chat.db here. To replace it with the one in the zip, run:"
    Write-Host "  .\server-import.ps1 $Zip -Force"
    exit 1
}

Write-Host "Unpacking $Zip..."
Expand-Archive -Path $Zip -DestinationPath $PSScriptRoot -Force
foreach ($item in "chat.db", "uploads", "releases", ".env") {
    $found = if (Test-Path $item) { "ok" } else { "MISSING" }
    Write-Host "  $item : $found"
}
Write-Host ""
Write-Host "Done. Delete the zip (and the copy on the USB stick): it holds your secrets."
Write-Host "Next: .\server-install.ps1 (as administrator), if you haven't yet."
