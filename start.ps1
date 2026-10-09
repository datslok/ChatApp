# Starts the chat server for development. Run setup.ps1 once first.
# (The real site, chat.datslok.no, is started with serve.ps1 instead.)
#
# Run it from this folder with:   .\start.ps1
# Then open http://localhost:8001. Stop the server with Ctrl+C.

conda activate chatapp

# --reload restarts the server automatically whenever you save a .py file.
# --port 8001: NOT 8000, because the Cloudflare Tunnel sends the public site to port 8000.
#   This way the internet can never reach the development server (which has no invite code).
uvicorn server:app --reload --port 8001
