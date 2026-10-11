# Packs everything the real chat needs that isn't in git into chatapp-data.zip, for moving the
# server to another PC (see README, "Running the server on its own PC"):
#
#   chat.db     the messages and accounts (a safe copy, even while the server runs)
#   uploads/    pictures and files
#   releases/   the desktop app's installers and latest.json
#   .env        the settings and secrets (invite code, mail password, LiveKit keys)
#
# Run it on the PC the chat runs on now:   .\scripts\server\export.ps1
# Then copy chatapp-data.zip to the new PC (a USB stick, say) and run .\scripts\server\import.ps1 there.
# The zip holds your secrets and everyone's messages: delete it from the stick afterwards.

$root = Split-Path (Split-Path $PSScriptRoot)  # the project folder: two up from scripts\server\
Set-Location $root
$zip = Join-Path $root "chatapp-data.zip"

# The Python to use: the server's .venv if there is one, otherwise the "chatapp" conda environment.
if (Test-Path .venv\Scripts\python.exe) {
    $python = ".venv\Scripts\python.exe"
    $pythonArgs = @()
} else {
    $python = "conda"
    $pythonArgs = @("run", "-n", "chatapp", "python")
}

# Gather everything in a temporary folder first, then zip that folder.
$temp = Join-Path $env:TEMP ("chatapp-export-" + [guid]::NewGuid())
New-Item -ItemType Directory $temp | Out-Null
try {
    Write-Host "Copying chat.db (safely, with SQLite's backup)..."
    & $python @pythonArgs tools\copy_db.py chat.db (Join-Path $temp "chat.db")  # (@ spreads the list into arguments)
    if ($LASTEXITCODE -ne 0) { throw "Copying chat.db failed." }

    foreach ($item in "uploads", "releases", ".env") {
        if (Test-Path $item) {
            Write-Host "Copying $item..."
            Copy-Item $item -Destination $temp -Recurse
        } else {
            Write-Host "(No $item here, skipping it.)"
        }
    }

    Write-Host "Zipping..."
    # "$temp\*": the things inside the folder, so the zip has chat.db etc. at its top, not a folder.
    Compress-Archive -Path "$temp\*" -DestinationPath $zip -Force
    $size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
    Write-Host ""
    Write-Host "Done: $zip ($size MB)."
    Write-Host "Copy it into the project folder on the new PC (C:\ChatApp) and run .\scripts\server\import.ps1 there."
} finally {
    Remove-Item $temp -Recurse -Force  # the temporary copy, whatever happened
}
