# Updates the server PC to the newest code on GitHub, and restarts the chat:
#
#   .\scripts\server\update.ps1          the chat (calls in Lounge and DMs carry on: voice isn't touched)
#   .\scripts\server\update.ps1 -Voice   the chat and LiveKit (everyone in a call is dropped for a moment)
#   .\scripts\server\update.ps1 -AI      the chat and llama-server (after changes to llama.ps1)
#
# Run it in PowerShell as administrator (stopping and starting the tasks needs it), in the project folder.

param([switch]$Voice, [switch]$AI)

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
if ($AI) {
    Restart-ChatTask "ChatApp AI" "llama-server.exe" "--port 8080"
}

# Is the chat back? It is once something listens on port 8000 again (uvicorn only starts listening
# when its startup is complete). Ask Windows once a second, for up to 30 seconds. (Fetching a page
# with Invoke-WebRequest instead isn't reliable when this runs over SSH from deploy.ps1.)
$running = $false
for ($second = 0; $second -lt 30 -and -not $running; $second++) {
    Start-Sleep -Seconds 1
    $running = [bool](Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue)
}
if ($running) {
    Write-Host "The chat is running." -ForegroundColor Green
} else {
    Write-Host "The chat isn't running after 30 seconds: look in logs\chat.log." -ForegroundColor Yellow
}
