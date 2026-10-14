# The nightly backup on the server PC (the scheduled task "ChatApp backup", 04:00; see
# install.ps1, step 8), onto a second disk:
#
#   <Destination>\2026-10-11\chat.db   a safe copy of the database, one folder per day (the last 30 kept)
#   <Destination>\2026-10-11\.env      the settings and secrets, with it
#   <Destination>\uploads\             every uploaded file: only new ones are copied, nothing is
#   <Destination>\releases\            ever deleted here (so a file deleted by mistake survives)
#   <Destination>\seasonal\            (the seasonal easter egg's videos, the same way)
#
# By hand:   .\scripts\server\backup.ps1 -Destination E:\ChatApp-backups
# Every run is written to logs\backup.log. The development PC fetches copies with
# scripts\backup-fetch.ps1, so there's also one outside this PC.

param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [int]$KeepDays = 30
)

$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $PSScriptRoot)  # the project folder: two up from scripts\server\
Set-Location $root
New-Item -ItemType Directory logs -Force | Out-Null
Start-Transcript -Path (Join-Path $root "logs\backup.log") -Append | Out-Null  # everything below goes into the log too

try {
    $today = Get-Date -Format "yyyy-MM-dd"
    $folder = Join-Path $Destination $today
    New-Item -ItemType Directory $folder -Force | Out-Null

    # 1. The database: SQLite's own backup function, safe while the chat is running.
    $python = if (Test-Path .venv\Scripts\python.exe) { ".venv\Scripts\python.exe" } else { "python" }
    & $python tools\copy_db.py chat.db (Join-Path $folder "chat.db") | Write-Output
    if ($LASTEXITCODE -ne 0) { throw "Copying chat.db failed." }
    Copy-Item .env $folder -Force

    # 2. Uploads, releases and the seasonal videos: robocopy (Windows' own copy tool) copies only new
    #    and changed files. /E: with subfolders. No /PURGE: files deleted here stay in the backup.
    #    The rest: less output.
    foreach ($item in "uploads", "releases", "seasonal") {
        if (-not (Test-Path $item)) { continue }
        robocopy $item (Join-Path $Destination $item) /E /R:2 /W:5 /NP /NFL /NDL /NJH /NJS | Out-Null
        # robocopy's exit codes: 0-7 mean success (what was copied), 8 and up mean errors.
        if ($LASTEXITCODE -ge 8) { throw "Copying $item failed (robocopy exit code $LASTEXITCODE)." }
    }

    # 3. Database copies older than $KeepDays days: delete them (only the dated folders).
    $oldest = (Get-Date).Date.AddDays(-$KeepDays)
    Get-ChildItem $Destination -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' } |
        Where-Object { [datetime]::ParseExact($_.Name, "yyyy-MM-dd", $null) -lt $oldest } |
        ForEach-Object { Write-Output "Deleting the old backup $($_.Name)"; Remove-Item $_.FullName -Recurse -Force }

    $size = [math]::Round((Get-Item (Join-Path $folder "chat.db")).Length / 1MB, 1)
    $kept = @(Get-ChildItem $Destination -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' }).Count
    Write-Output "Backup done: $folder (chat.db $size MB; $kept daily copies kept)."
} catch {
    Write-Output "BACKUP FAILED: $_"
    exit 1
} finally {
    Stop-Transcript | Out-Null
}
