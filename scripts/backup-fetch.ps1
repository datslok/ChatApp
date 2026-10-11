# On the development PC: fetches the server PC's newest backup, so there's also a copy outside
# that PC (its own backup is on its second disk; see scripts\server\backup.ps1).
#
#   .\scripts\backup-fetch.ps1            fetch now
#   .\scripts\backup-fetch.ps1 -Install   once: a scheduled task that fetches every day at 05:00,
#                                         or as soon as this PC is on, if it was off then
#
# Into ~\ChatApp-backups (your user folder): the newest dated folder (chat.db and .env), and the
# upload and release files this PC doesn't have yet. The last 30 dated folders are kept.
# Uses SSH (set up once with scripts\server-connect.ps1). Each run is logged in ~\ChatApp-backups\fetch.log.

param(
    [switch]$Install,
    [string]$Destination = (Join-Path $HOME "ChatApp-backups"),
    [int]$KeepDays = 30
)

$ServerBackups = "E:\ChatApp-backups"  # where the server PC keeps them (its second disk)

if ($Install) {
    # Runs as you, only while you're logged in (it needs your SSH key), so no password is needed.
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -Daily -At "05:00"  # an hour after the server's backup
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName "ChatApp backup fetch" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "Task 'ChatApp backup fetch': every day at 05:00 (or when this PC is on again). Backups go to $Destination."
    exit
}

New-Item -ItemType Directory $Destination -Force | Out-Null
Start-Transcript -Path (Join-Path $Destination "fetch.log") -Append | Out-Null

# Run a PowerShell script on the server, sent encoded so no quotes get lost on the way. Returns its
# output lines (without PowerShell's progress noise).
function Invoke-OnServer($script) {
    $script = "`$ProgressPreference = 'SilentlyContinue'`n" + $script
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    ssh -o BatchMode=yes chatserver "powershell -NoProfile -EncodedCommand $encoded" |
        Where-Object { $_ -and $_ -notmatch '^#< CLIXML|^<Objs ' }
    if ($LASTEXITCODE -ne 0) { throw "Couldn't reach the server (ssh chatserver)." }
}

# scp wants / in Windows paths: E:\ChatApp-backups\x -> chatserver:E:/ChatApp-backups/x
function ServerPath($relative) { "chatserver:" + (Join-Path $ServerBackups $relative).Replace("\", "/") }

try {
    # 1. The newest dated folder, unless we have it already.
    $newest = Invoke-OnServer "(Get-ChildItem '$ServerBackups' -Directory | Where-Object Name -match '^\d{4}-\d{2}-\d{2}$' | Sort-Object Name | Select-Object -Last 1).Name"
    if (-not $newest) { throw "The server has no backups yet." }
    if (Test-Path (Join-Path $Destination "$newest\chat.db")) {
        Write-Output "Already have $newest."
    } else {
        Write-Output "Fetching $newest..."
        scp -r -q (ServerPath $newest) $Destination
        if ($LASTEXITCODE -ne 0) { throw "Fetching $newest failed." }
    }

    # 2. Upload and release files we don't have yet (they never change once there, so new ones are enough).
    $files = Invoke-OnServer "Set-Location '$ServerBackups'; Get-ChildItem uploads, releases -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { Resolve-Path -Relative `$_.FullName }"
    $new = 0
    foreach ($file in $files) {
        $relative = $file.TrimStart(".", "\")  # ".\uploads\abc.png" -> "uploads\abc.png"
        $local = Join-Path $Destination $relative
        if (Test-Path $local) { continue }
        New-Item -ItemType Directory (Split-Path $local) -Force | Out-Null
        scp -q (ServerPath $relative) $local
        if ($LASTEXITCODE -ne 0) { throw "Fetching $relative failed." }
        $new++
    }
    Write-Output "$new new upload/release file(s) fetched."

    # 3. Dated folders older than $KeepDays days: delete them here too.
    $oldest = (Get-Date).Date.AddDays(-$KeepDays)
    Get-ChildItem $Destination -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' } |
        Where-Object { [datetime]::ParseExact($_.Name, "yyyy-MM-dd", $null) -lt $oldest } |
        ForEach-Object { Write-Output "Deleting the old backup $($_.Name)"; Remove-Item $_.FullName -Recurse -Force }
    Write-Output "Done: $Destination"
} catch {
    Write-Output "FETCH FAILED: $_"
    exit 1
} finally {
    Stop-Transcript | Out-Null
}
