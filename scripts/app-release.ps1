# From the development PC: releases a new version of the phone app (the APK), for when its native
# side changed: a new module or package with native code, a permission, the icon, app.json. (Only
# JavaScript changed? scripts\app-update.ps1 instead: no new APK needed.) See README, "Releasing the
# phone app".
#
#   .\scripts\app-release.ps1            build, then upload to the server
#   .\scripts\app-release.ps1 -NoUpload  only build (the APK lands in releases\)
#
# 1. Raises the version in mobile\app.json (1.0.3 -> 1.0.4, and versionCode, which Android compares),
#    and commits that.
# 2. Builds the release APK, signed with the release key (mobile\plugins\release-signing.js; the key and
#    its password are in your user folder, never in git), and checks who signed it.
# 3. Puts it in releases\ as ChatApp-android-<version>.apk, with releases\android.json naming it (and
#    the commit it was built from, so app-update.ps1 knows what native code the phones have).
# 4. Copies both to the server (the APK first, android.json last, like release-upload.ps1) and removes
#    older APKs there and here. Phones offer the update at their next start; /download/android gives it.

param([switch]$NoUpload)

$ServerFolder = "C:/ChatApp"  # where the code is on the server PC (scp prefers / in paths)
$root = Split-Path $PSScriptRoot
Set-Location $root

# Signed with the release key, or not at all: a debug-signed APK could never be updated.
$gradleProperties = Join-Path $HOME ".gradle\gradle.properties"
if (-not ((Test-Path $gradleProperties) -and (Select-String -Path $gradleProperties -Pattern "^CHATAPP_RELEASE_STORE_FILE=" -Quiet))) {
    Write-Host "No release key set up in $gradleProperties (README, 'Releasing the phone app')."; exit 1
}
# The version goes into a commit, along with what's built: everything in mobile\ must be committed first.
if (git status --porcelain mobile) { Write-Host "mobile\ has uncommitted changes: commit them first."; exit 1 }

# Android Studio's SDK and Java 17 (user variables, which a fresh PowerShell may not have yet).
$env:ANDROID_HOME = [Environment]::GetEnvironmentVariable("ANDROID_HOME", "User")
$env:JAVA_HOME = [Environment]::GetEnvironmentVariable("JAVA_HOME", "User")
$env:Path = "$env:ANDROID_HOME\platform-tools;$env:Path"

# 1. The new version: the last number up by one, and versionCode up by one.
$bump = @'
const fs = require("fs");
const config = JSON.parse(fs.readFileSync("mobile/app.json", "utf8"));
const parts = config.expo.version.split(".").map(Number);
parts[parts.length - 1] += 1;
config.expo.version = parts.join(".");
config.expo.android.versionCode = (config.expo.android.versionCode || 0) + 1;
fs.writeFileSync("mobile/app.json", JSON.stringify(config, null, 2) + "\n");
console.log(config.expo.version + " " + config.expo.android.versionCode);
'@
# (From a file: Windows PowerShell drops the double quotes from a script handed to node -e.)
$bumpFile = Join-Path $env:TEMP "chatapp-bump.js"
Set-Content $bumpFile $bump -Encoding ascii
$bumped = node $bumpFile
Remove-Item $bumpFile
if ($LASTEXITCODE -ne 0 -or -not $bumped) { Write-Host "Raising the version failed (see above)."; exit 1 }
$version, $versionCode = $bumped.Split(" ")
Write-Host "Version $version (versionCode $versionCode)" -ForegroundColor Cyan

# 2. Build. prebuild makes android\ from app.json again (the adb server would hold the folder: stopped first).
adb kill-server | Out-Null
Push-Location mobile
try {
    npx expo prebuild --clean --platform android
    if ($LASTEXITCODE -ne 0) { throw "prebuild failed." }
    Push-Location android
    try {
        # -x: without Android's code checks ("lint"), which a release build otherwise runs on every library
        # (their code, not ours), and which ran out of memory. Expo's own builds leave them out too.
        # reactNativeArchitectures: native code only for phones' processors (64- and 32-bit ARM), not the
        # PC emulators' x86 ones: 148 MB with all four.
        .\gradlew.bat app:assembleRelease -x lint -x test -x lintVitalAnalyzeRelease -x lintVitalReportRelease -x lintVitalRelease `
            "-PreactNativeArchitectures=armeabi-v7a,arm64-v8a"
        if ($LASTEXITCODE -ne 0) { throw "The build failed." }
    } finally { Pop-Location }
} catch {
    Pop-Location
    git checkout mobile/app.json  # (the version goes back: nothing was released)
    Write-Host $_; exit 1
}
Pop-Location
$built = "mobile\android\app\build\outputs\apk\release\app-release.apk"

# Who signed it: must be our key (CN=ChatApp), not Android's debug key.
$buildTools = Get-ChildItem "$env:ANDROID_HOME\build-tools" -Directory | Sort-Object Name | Select-Object -Last 1
$signer = & "$($buildTools.FullName)\apksigner.bat" verify --print-certs $built | Select-String "Signer #1 certificate DN"
if ($signer -notmatch "CN=ChatApp") { git checkout mobile/app.json; Write-Host "Not signed with the release key: $signer"; exit 1 }
Write-Host "Signed: $signer"

# 3. Commit the version, then releases\: the APK and android.json.
git add mobile/app.json
git commit -q -m "Phone app $version"
git push -q
$apk = "ChatApp-android-$version.apk"
New-Item -ItemType Directory releases -Force | Out-Null
Copy-Item $built "releases\$apk"
@{ version = $version; versionCode = [int]$versionCode; apk = $apk; commit = (git rev-parse HEAD) } |
    ConvertTo-Json | Set-Content releases\android.json -Encoding ascii
Get-ChildItem releases -File -Filter "ChatApp-android-*.apk" | Where-Object Name -ne $apk | Remove-Item
$size = [math]::Round((Get-Item "releases\$apk").Length / 1MB, 1)
Write-Host "Built releases\$apk ($size MB)."
if ($NoUpload) { exit 0 }

# 4. Upload: the APK first, android.json last (a phone that checks meanwhile never sees a missing APK).
scp "releases\$apk" "chatserver:$ServerFolder/releases/"
if ($LASTEXITCODE -ne 0) { Write-Host "Copying the APK failed (see above)."; exit 1 }
scp releases\android.json "chatserver:$ServerFolder/releases/"
if ($LASTEXITCODE -ne 0) { Write-Host "Copying android.json failed (see above)."; exit 1 }
ssh chatserver "Get-ChildItem $ServerFolder/releases -File -Filter 'ChatApp-android-*.apk' | Where-Object { `$_.Name -ne '$apk' } | Remove-Item -Verbose"
Write-Host "Done: phones offer version $version at their next start, and /download/android gives it." -ForegroundColor Green
