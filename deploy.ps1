# From the development PC: put the newest code on the server PC and restart the chat there.
#
#   .\deploy.ps1          the chat (calls in Lounge and DMs carry on)
#   .\deploy.ps1 -Voice   the chat and LiveKit (after changes to voice.ps1 or livekit.yaml)
#
# It runs server-update.ps1 on the server over SSH (set up once with server-connect.ps1), which
# fetches the code from GitHub. So only what's committed *and pushed* gets there: this checks that.

param([switch]$Voice)

$ServerFolder = "C:\ChatApp"  # where the code is on the server PC (README, step 2)

Set-Location $PSScriptRoot

# Uncommitted changes don't go anywhere: say so, so it's not a surprise.
$uncommitted = git status --porcelain
if ($uncommitted) {
    Write-Host "Not committed (these stay here, they won't be on the server):" -ForegroundColor Yellow
    $uncommitted | ForEach-Object { Write-Host "  $_" }
}

# Commits that aren't on GitHub yet: push them first, or the server would fetch the old code.
git fetch --quiet
$notPushed = git rev-list --count "@{u}..HEAD"
if ([int]$notPushed -gt 0) {
    Write-Host "Pushing $notPushed commit(s) to GitHub first..."
    git push
    if ($LASTEXITCODE -ne 0) { Write-Host "Pushing failed (see above), so not deploying."; exit 1 }
}

$command = "cd $ServerFolder; .\server-update.ps1" + $(if ($Voice) { " -Voice" } else { "" })
Write-Host "On the server: $command"
ssh chatserver $command
exit $LASTEXITCODE
