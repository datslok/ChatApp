# Starts the chat server. Run setup.ps1 once first.
#
# Run it from this folder with:   .\start.ps1
# Stop the server with Ctrl+C.

conda activate chatapp

# --reload restarts the server automatically whenever you save a .py file.
uvicorn server:app --reload
