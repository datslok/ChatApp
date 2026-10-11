# Starts the LiveKit server, which carries the voice in Lounge and in DM calls.
#
#   .\voice.ps1         for the real site: settings from livekit.yaml, the keys from .env
#   .\voice.ps1 -Dev    for development: only reachable from this PC, with LiveKit's test keys
#
# Stop it with Ctrl+C. livekit-server.exe is downloaded into livekit/ (see CLAUDE.md), not committed.

param([switch]$Dev)

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
.\livekit\livekit-server.exe --config livekit.yaml
