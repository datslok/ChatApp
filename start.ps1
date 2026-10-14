# Starts the chat server for development. Run setup.ps1 once first.
# (The real site is started with serve.ps1 instead.)
#
# Run it from this folder with:   .\start.ps1
# Then open http://localhost:8001. Stop the server with Ctrl+C.

conda activate chatapp

# Development keys that mustn't be committed (like GIPHY_API_KEY for GIF search) live in
# dev-secrets.env, which git ignores. If it's there, each NAME=value line becomes an environment
# variable for the server, alongside dev.env's settings below.
if (Test-Path dev-secrets.env) {
    foreach ($line in Get-Content dev-secrets.env) {
        if ($line -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim(), 'Process')
        }
    }
}

# --reload restarts the server automatically whenever you save a .py file.
# --port 8001: NOT 8000, because the Cloudflare Tunnel sends the public site to port 8000.
#   This way the internet can never reach the development server (which has no invite code).
# --env-file dev.env: use dev.db and dev-uploads/, so tests stay out of the real chat.
uvicorn server:app --reload --port 8001 --env-file dev.env
