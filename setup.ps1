# Sets up the "chatapp" conda environment and installs the packages from requirements.txt.
# Safe to run again: it skips creating the environment if it already exists.
#
# Run it from this folder with:   .\setup.ps1

$envName = "chatapp"

# 1. Create the environment, unless it's already there.
#    "conda env list" prints one line per environment; we search it for our name.
$exists = conda env list | Select-String -Pattern "^$envName\s"
if ($exists) {
    Write-Host "Environment '$envName' already exists, skipping creation."
} else {
    Write-Host "Creating environment '$envName'..."
    conda create -n $envName python=3.13 -y
    # $LASTEXITCODE holds the exit code of the last program we ran (0 means success).
    if ($LASTEXITCODE -ne 0) { Write-Host "Creating the environment failed."; exit 1 }
}

# 2. Switch into the environment, so "pip" below installs into it and not into base.
conda activate $envName

# 3. Install (or update) the packages listed in requirements.txt (and requirements-dev.txt).
Write-Host "Installing packages..."
pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { Write-Host "Installing packages failed."; exit 1 }
# And what working on the code needs (pytest, for test.ps1).
pip install -r requirements-dev.txt
if ($LASTEXITCODE -ne 0) { Write-Host "Installing packages failed."; exit 1 }

Write-Host ""
Write-Host "Done! The '$envName' environment is active in this terminal."
Write-Host "Start the server with:  uvicorn server:app --reload"
