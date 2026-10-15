# From the development PC: sends the phone app's JavaScript to the phones, without a new APK. Most
# changes are only JavaScript (mobile\App.js, mobile\src\). At the end the chat restarts (deploy.ps1, like
# release-upload.ps1): every open app reconnects, finds the new bundle and switches to it as soon as
# nothing would be lost (mobile\src\liveUpdates.js); closed ones get it when they start. See README,
# "Releasing the phone app".
#
#   .\scripts\app-update.ps1
#
# New JavaScript only goes to phones whose native code it was made for: their APK's version (the
# "runtime version"). So if anything native changed since the last APK (mobile\modules\, mobile\plugins\,
# mobile\app.json, the packages), this stops: release an APK instead (scripts\app-release.ps1).
#
# 1. Exports the bundle (npx expo export), 2. turns it into an update (tools\make_app_update.py: the
# files in releases\app-assets\, a manifest in releases\app-updates\<version>\), 3. copies those to the
# server, the manifest last.

$ServerFolder = "C:/ChatApp"  # where the code is on the server PC (scp prefers / in paths)
$root = Split-Path $PSScriptRoot
Set-Location $root

if (-not (Test-Path releases\android.json)) { Write-Host "No APK released from this PC yet (releases\android.json): run scripts\app-release.ps1 first."; exit 1 }
$latest = Get-Content releases\android.json -Raw | ConvertFrom-Json
$version = (node -e "console.log(require('./mobile/app.json').expo.version)")
if ($version -ne $latest.version) { Write-Host "app.json says $version, the last APK is $($latest.version): run scripts\app-release.ps1."; exit 1 }

# What goes out should be what's in git (and nothing native may have changed since that APK).
if (git status --porcelain mobile) { Write-Host "mobile\ has uncommitted changes: commit them first."; exit 1 }
$native = git diff --name-only $latest.commit HEAD -- mobile/modules mobile/plugins mobile/app.json mobile/package.json mobile/package-lock.json
if ($native) {
    Write-Host "Native code changed since the APK of version $($latest.version):"
    $native | ForEach-Object { Write-Host "  $_" }
    Write-Host "Phones with that APK can't run this JavaScript: release an APK instead (scripts\app-release.ps1)."
    exit 1
}

# 1. Export: the bundle as release builds have it, with its pictures and sounds.
$export = Join-Path $env:TEMP ("chatapp-update-" + [guid]::NewGuid())
Push-Location mobile
npx expo export --platform android --output-dir $export
$exported = $LASTEXITCODE -eq 0
Pop-Location
if (-not $exported) { Write-Host "Exporting failed (see above)."; exit 1 }

# 2. The update. (Only Python's standard library: the chatapp conda environment's Python if conda is
# there, as in a PowerShell that start.ps1 works in, else whichever python there is.)
$global:LASTEXITCODE = 1
if (Get-Command conda -ErrorAction SilentlyContinue) {
    $output = conda run -n chatapp python tools\make_app_update.py $export $version releases
} else {
    $output = python tools\make_app_update.py $export $version releases
}
Remove-Item $export -Recurse -Force
if ($LASTEXITCODE -ne 0) { Write-Host "Making the update failed: $output"; exit 1 }
Write-Host $output
$manifest = Get-ChildItem "releases\app-updates\$version" -Filter *.json | Sort-Object Name | Select-Object -Last 1
if (-not $manifest) { Write-Host "No update was made (see above)."; exit 1 }
$files = (Get-Content $manifest.FullName -Raw | ConvertFrom-Json)
$names = @($files.launchAsset.file) + @($files.assets | ForEach-Object { $_.file })

# 3. Upload: its files first, the manifest last (a phone asking meanwhile never gets a missing file).
ssh chatserver "New-Item -ItemType Directory -Force $ServerFolder/releases/app-assets, $ServerFolder/releases/app-updates/$version | Out-Null"
scp ($names | ForEach-Object { "releases\app-assets\$_" }) "chatserver:$ServerFolder/releases/app-assets/"
if ($LASTEXITCODE -ne 0) { Write-Host "Copying the files failed (see above)."; exit 1 }
scp $manifest.FullName "chatserver:$ServerFolder/releases/app-updates/$version/"
if ($LASTEXITCODE -ne 0) { Write-Host "Copying the manifest failed (see above)."; exit 1 }

Write-Host "Restarting the chat, so the open apps reconnect and switch to it..."
& .\scripts\deploy.ps1
if ($LASTEXITCODE -ne 0) { Write-Host "The restart failed (see above): open apps switch when they reconnect or come back on screen."; exit 1 }
Write-Host "Done: open apps with version $version switch to it as soon as they safely can, the others when they start." -ForegroundColor Green
