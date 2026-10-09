# Runs the chat for real, for chat.datslok.no (the Cloudflare Tunnel connects to it).
# For development, use start.ps1 instead.
#
# Run it from this folder with:   .\serve.ps1
# Stop it with Ctrl+C.

# Work from the folder this script is in, wherever it was started from.
Set-Location $PSScriptRoot

# Refuse to start without a real invite code, so the site is never accidentally open to everyone.
$hasInvite = (Test-Path .env) -and (Select-String -Path .env -Pattern '^INVITE_CODE=.+' -Quiet) -and
             -not (Select-String -Path .env -Pattern '^INVITE_CODE=change-me' -Quiet)
if (-not $hasInvite) {
    Write-Host "No invite code set. Copy .env.example to .env and choose an INVITE_CODE."
    exit 1
}

conda activate chatapp

# --host 127.0.0.1: only programs on this PC (like the tunnel) can connect, not other devices.
# --env-file .env:  load INVITE_CODE and SECURE_COOKIES from the .env file.
# No --reload: that's only for development.
uvicorn server:app --host 127.0.0.1 --port 8000 --env-file .env
