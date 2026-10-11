# Updates the server PC to the newest code on GitHub, and restarts the chat:
#
#   .\scripts\server\update.ps1          the chat (calls in Lounge and DMs carry on: voice isn't touched)
#   .\scripts\server\update.ps1 -Voice   the chat and LiveKit (everyone in a call is dropped for a moment)
#
# Run it in PowerShell as administrator (stopping and starting the tasks needs it), in the project folder.

param([switch]$Voice)

$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $PSScriptRoot)  # the project folder: two up from scripts\server\
Set-Location $root

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Please run this in PowerShell as administrator."
    exit 1
}

Write-Host "Getting the newest code..."
git pull
if ($LASTEXITCODE -ne 0) { throw "git pull failed (see above)." }

Write-Host "Installing any new packages..."
.venv\Scripts\python.exe -m pip install -r requirements.txt --quiet
if ($LASTEXITCODE -ne 0) { throw "Installing the packages failed." }

# Stop a task, and the program it started. Stopping the task ends its PowerShell, but the program
# PowerShell started (uvicorn, LiveKit) can keep running and keep the port busy, so end that too:
# only the one running from this folder, found by its command line.
function Restart-ChatTask($taskName, $processName, $commandPart) {
    Stop-ScheduledTask -TaskName $taskName
    Get-CimInstance Win32_Process -Filter "Name = '$processName'" |
        Where-Object { $_.CommandLine -like "*$commandPart*" -and ($_.ExecutablePath -like "$root*" -or $processName -eq "python.exe") } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $taskName
    Write-Host "Restarted '$taskName'."
}

Restart-ChatTask "ChatApp" "python.exe" "uvicorn server:app --host 127.0.0.1 --port 8000"
if ($Voice) {
    Restart-ChatTask "ChatApp voice" "livekit-server.exe" "--config livekit.yaml"
}

Start-Sleep -Seconds 5
try {
    Invoke-WebRequest http://localhost:8000/login -UseBasicParsing -TimeoutSec 5 | Out-Null
    Write-Host "The chat is running." -ForegroundColor Green
} catch {
    Write-Host "The chat isn't answering yet. Give it a minute, or look in logs\chat.log." -ForegroundColor Yellow
}
