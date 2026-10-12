# Runs Chattus, the chat's AI bot (chattus.py). Needs the chat and llama-server (llama.ps1) running.
#
#   .\chattus.ps1         the real chat (port 8000), with CHATTUS_PASSWORD and LLAMA_API_KEY from .env
#   .\chattus.ps1 -Dev    the development chat (start.ps1, port 8001), with dev-chattus.env; the model
#                         comes from the server through an SSH tunnel (README, "Optional: an AI bot")
#
# Stop it with Ctrl+C.
#
# On the server PC, a scheduled task starts it at boot (see scripts\server\install.ps1), with
# -LogFile logs\bot.log: then there's no window, and everything it prints goes to that file.

param([switch]$Dev, [string]$LogFile)

# Work from the folder this script is in, wherever it was started from.
Set-Location $PSScriptRoot

# The Python to use: the server PC's .venv (scripts\server\install.ps1 makes it), or else the "chatapp"
# conda environment (this development PC).
if (Test-Path .venv\Scripts\python.exe) {
    $python = (Resolve-Path .venv\Scripts\python.exe).Path
} else {
    conda activate chatapp
    $python = "python"
}

# -u: print straight away (not in chunks), so the log is always up to date.
$arguments = if ($Dev) { "-u chattus.py --chat http://127.0.0.1:8001 --env dev-chattus.env" } else { "-u chattus.py" }

if (-not $LogFile) {
    & $python $arguments.Split(" ")
    exit $LASTEXITCODE
}

# With a log file: keep the previous run's log, then run with everything going into the file.
# (What the bot says goes to "standard output"; Python's own errors to "standard error".)
New-Item -ItemType Directory (Split-Path $LogFile) -Force | Out-Null
if (Test-Path $LogFile) { Move-Item $LogFile ($LogFile -replace '\.log$', '.previous.log') -Force }
$process = Start-Process $python -ArgumentList $arguments -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $LogFile -RedirectStandardError ($LogFile -replace '\.log$', '.errors.log')
exit $process.ExitCode  # not 0 = it crashed: the scheduled task then starts it again
