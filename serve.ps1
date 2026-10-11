# Runs the chat for real, for chat.datslok.no (the Cloudflare Tunnel connects to it).
# For development, use start.ps1 instead.
#
# Run it from this folder with:   .\serve.ps1
# Stop it with Ctrl+C.
#
# On the server PC, a scheduled task starts it at boot (see server-install.ps1), with
# -LogFile logs\chat.log: then there's no window, and everything it prints goes to that file.

param([string]$LogFile)

# Work from the folder this script is in, wherever it was started from.
Set-Location $PSScriptRoot

# Refuse to start without a real invite code, so the site is never accidentally open to everyone.
$hasInvite = (Test-Path .env) -and (Select-String -Path .env -Pattern '^INVITE_CODE=.+' -Quiet) -and
             -not (Select-String -Path .env -Pattern '^INVITE_CODE=change-me' -Quiet)
if (-not $hasInvite) {
    Write-Host "No invite code set. Copy .env.example to .env and choose an INVITE_CODE."
    exit 1
}

# The Python to use: the server PC's .venv (server-install.ps1 makes it), or else the "chatapp"
# conda environment (this development PC).
if (Test-Path .venv\Scripts\python.exe) {
    $python = (Resolve-Path .venv\Scripts\python.exe).Path
} else {
    conda activate chatapp
    $python = "python"
}

# --host 127.0.0.1: only programs on this PC (like the tunnel) can connect, not other devices.
# --env-file .env:  load INVITE_CODE and SECURE_COOKIES from the .env file.
# No --reload: that's only for development.
$arguments = "-m uvicorn server:app --host 127.0.0.1 --port 8000 --env-file .env"

if (-not $LogFile) {
    & $python $arguments.Split(" ")
    exit $LASTEXITCODE
}

# With a log file: keep the previous run's log, then run with everything going into the file.
# (uvicorn writes its log lines to "standard error", our prints go to "standard output".)
New-Item -ItemType Directory (Split-Path $LogFile) -Force | Out-Null
if (Test-Path $LogFile) { Move-Item $LogFile ($LogFile -replace '\.log$', '.previous.log') -Force }
$process = Start-Process $python -ArgumentList $arguments -NoNewWindow -Wait -PassThru `
    -RedirectStandardError $LogFile -RedirectStandardOutput ($LogFile -replace '\.log$', '.out.log')
exit $process.ExitCode  # not 0 = it crashed: the scheduled task then starts it again
