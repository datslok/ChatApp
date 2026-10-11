# Starts the LiveKit server, which carries the voice in Lounge and in DM calls.
#
#   .\voice.ps1         for the real site: settings from livekit.yaml, the keys from .env
#   .\voice.ps1 -Dev    for development: only reachable from this PC, with LiveKit's test keys
#
# Stop it with Ctrl+C. livekit-server.exe is downloaded into livekit/ (see CLAUDE.md), not committed.
#
# On the server PC, a scheduled task starts it at boot (see scripts\server\install.ps1), with
# -LogFile logs\voice.log: then there's no window, and everything it prints goes to that file.

param([switch]$Dev, [string]$LogFile)

# Work from the folder this script is in, wherever it was started from.
Set-Location $PSScriptRoot

if ($Dev) {
    # --dev: the key "devkey" with the secret "secret", and only programs on this PC can connect.
    .\livekit\livekit-server.exe --dev
    exit
}

# Read LIVEKIT_API_KEY and LIVEKIT_API_SECRET from .env (lines like NAME=value).
$settings = @{}
if (Test-Path .env) {
    foreach ($line in Get-Content .env) {
        if ($line -match '^\s*([A-Z_]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2].Trim() }
    }
}
$key = $settings["LIVEKIT_API_KEY"]
$secret = $settings["LIVEKIT_API_SECRET"]
if (-not $key -or -not $secret) {
    Write-Host "No LiveKit keys set. Put LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env (see .env.example)."
    exit 1
}

# LiveKit reads its keys from this environment variable, as "key: secret". It only exists for this
# window and the programs it starts, so the secret is never written to a file other than .env.
$env:LIVEKIT_KEYS = "${key}: ${secret}"

if (-not $LogFile) {
    .\livekit\livekit-server.exe --config livekit.yaml
    exit $LASTEXITCODE
}

# With a log file: keep the previous run's log, then run with everything going into the file.
# (LiveKit gets LIVEKIT_KEYS too: a program started from here inherits our environment variables.)
New-Item -ItemType Directory (Split-Path $LogFile) -Force | Out-Null
if (Test-Path $LogFile) { Move-Item $LogFile ($LogFile -replace '\.log$', '.previous.log') -Force }
$process = Start-Process .\livekit\livekit-server.exe -ArgumentList "--config livekit.yaml" -NoNewWindow -Wait -PassThru `
    -RedirectStandardError $LogFile -RedirectStandardOutput ($LogFile -replace '\.log$', '.out.log')
exit $process.ExitCode  # not 0 = it crashed: the scheduled task then starts it again
