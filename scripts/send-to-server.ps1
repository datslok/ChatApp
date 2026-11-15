# Sends files into a folder on the server PC. Not run by itself: the release scripts load it
# (". .\scripts\send-to-server.ps1") and call Send-ToServer for their big files: app-release.ps1 (the APK),
# release-upload.ps1 (the desktop installer) and app-update.ps1 (the phone app's bundle).
#
# At home: SSH's file copy (scp), over the home network.
#
# -ViaGitHub, from outside the home network: scp then goes through the Cloudflare tunnel (README, "Reaching
# the server from outside your home network"), which crawls for big files (~70 KB/s) and can break off.
# Instead the files go into a temporary release of the project's GitHub repository (the gh command, logged
# in), and the server downloads them from there itself, which is fast. Each file's SHA-256 is worked out
# here first; the server downloads into a .tmp name, checks every one, and only then puts them in place, so
# a broken or changed file never takes the real one's place. The GitHub release is deleted at the end,
# also when something failed. (The repository is public: for that minute anyone could download the files,
# but they're what /download hands out anyway, built from the public code.)

function Send-ToServer {
    param(
        [Parameter(Mandatory)] [string[]] $Files,   # paths on this PC
        [Parameter(Mandatory)] [string] $Folder,    # on the server, like "C:/ChatApp/releases"
        [switch] $ViaGitHub
    )
    # (Out-Host: what the programs print goes to the screen. Without it, it would become part of what this
    # function returns, and the caller's "did it work?" would get a list of lines instead of $true.)
    if (-not $ViaGitHub) {
        scp $Files "chatserver:$Folder/" | Out-Host
        return $LASTEXITCODE -eq 0
    }

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Write-Host "-ViaGitHub needs GitHub's gh command (winget install GitHub.cli, then gh auth login)."; return $false }
    $repo = gh repo view --json nameWithOwner --jq .nameWithOwner  # "you/ChatApp", from this folder's git remote
    if ($LASTEXITCODE -ne 0) { Write-Host "gh can't see the repository (gh auth login?)."; return $false }
    $tag = "upload-" + (Get-Date -Format "yyyyMMdd-HHmmss")

    # What the server must download and what each file must be: one line of PowerShell per file.
    $list = foreach ($file in $Files) {
        $name = Split-Path $file -Leaf
        $hash = (Get-FileHash $file -Algorithm SHA256).Hash
        "@{ name = '$name'; hash = '$hash'; url = 'https://github.com/$repo/releases/download/$tag/$name' }"
    }

    Write-Host "Uploading $($Files.Count) file(s) to a temporary GitHub release ($tag)..."
    gh release create $tag $Files --repo $repo --prerelease --title "Temporary upload (deleted shortly)" --notes "On its way to the server; deleted in a minute." | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Uploading to GitHub failed (see above)."
        gh release delete $tag --repo $repo --yes --cleanup-tag 2>$null | Out-Host  # (in case it got half made)
        return $false
    }
    try {
        # The server's part. Sent as -EncodedCommand (base64), like set-server-secret.ps1: no quote or $
        # in it can be mangled on the way through ssh.
        # (No progress reports: without a terminal, PowerShell sends them back as a block of XML.)
        $remote = @"
`$ProgressPreference = 'SilentlyContinue'
`$files =@($($list -join ', '))
Set-Location '$Folder'
foreach (`$file in `$files) {
    curl.exe -sSfL --retry 3 -o "`$(`$file.name).tmp" `$file.url
    `$ok = `$LASTEXITCODE -eq 0 -and (Get-FileHash "`$(`$file.name).tmp" -Algorithm SHA256).Hash -eq `$file.hash
    if (-not `$ok) {
        "Downloading or checking `$(`$file.name) failed: nothing was changed."
        foreach (`$f in `$files) { Remove-Item "`$(`$f.name).tmp" -ErrorAction SilentlyContinue }
        exit 1
    }
}
foreach (`$file in `$files) { Move-Item "`$(`$file.name).tmp" `$file.name -Force }
"The server downloaded and checked `$(`$files.Count) file(s)."
"@
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remote))
        ssh chatserver "powershell -NoProfile -NonInteractive -EncodedCommand $encoded" | Out-Host
        return $LASTEXITCODE -eq 0
    } finally {
        gh release delete $tag --repo $repo --yes --cleanup-tag | Out-Host
        if ($LASTEXITCODE -ne 0) { Write-Host "Couldn't delete the GitHub release ${tag}: delete it by hand (gh release delete $tag --cleanup-tag)." }
    }
}
