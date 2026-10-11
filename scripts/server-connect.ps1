# Run once on the development PC, after scripts\server\install.ps1 has run on the server PC. Afterwards
# "ssh chatserver" logs in there without a password, which scripts\deploy.ps1 and scripts\release-upload.ps1 use.
#
#   .\scripts\server-connect.ps1 192.168.10.123 axel     (the server PC's address and your username there;
#                                                  scripts\server\install.ps1 prints both at its step 7)
#
# What it does:
#   1. Makes a key pair on this PC, if there isn't one: a private key that never leaves this PC
#      (~\.ssh\id_ed25519), and a public key (id_ed25519.pub) to give to the server.
#   2. Puts the public key on the server. It asks for your password there this one time.
#   3. Adds "chatserver" to this PC's SSH settings (~\.ssh\config), as a short name for it.
#   4. Checks that logging in with the key works.

param(
    [Parameter(Mandatory = $true)][string]$Address,
    [Parameter(Mandatory = $true)][string]$User
)

$sshFolder = Join-Path $HOME ".ssh"
$key = Join-Path $sshFolder "id_ed25519"
New-Item -ItemType Directory $sshFolder -Force | Out-Null

# --- 1. The key pair
if (Test-Path $key) {
    Write-Host "Using your existing key: $key"
} else {
    Write-Host "Making a key pair..."
    # -N: no passphrase (the key file is the only secret, and it stays on this PC). Windows PowerShell
    # and PowerShell 7 pass an empty argument differently, hence the two versions.
    if ($PSVersionTable.PSVersion.Major -ge 7) { ssh-keygen -t ed25519 -f $key -q -N "" }
    else { ssh-keygen -t ed25519 -f $key -q -N '""' }
    if ($LASTEXITCODE -ne 0) { Write-Host "Making the key failed."; exit 1 }
}
$publicKey = (Get-Content "$key.pub" -Raw).Trim()

# --- 2. The public key onto the server
# On Windows, an administrator's keys go in C:\ProgramData\ssh\administrators_authorized_keys
# (not in their own .ssh folder), and SSH ignores that file unless only Administrators and SYSTEM
# may change it. Other accounts: ~\.ssh\authorized_keys. This runs there, in PowerShell.
$remoteScript = @"
`$key = '$publicKey'
`$isAdmin = (whoami /groups) -match 'S-1-5-32-544'
if (`$isAdmin) { `$file = 'C:\ProgramData\ssh\administrators_authorized_keys' }
else { New-Item -ItemType Directory "`$HOME\.ssh" -Force | Out-Null; `$file = "`$HOME\.ssh\authorized_keys" }
if (-not ((Test-Path `$file) -and (Select-String -Path `$file -SimpleMatch `$key -Quiet))) {
    Add-Content -Path `$file -Value `$key -Encoding ascii
}
if (`$isAdmin) { icacls `$file /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null }
'The key is installed on the server.'
"@
# Sent as -EncodedCommand (the script in base64), so no quotes or line breaks get mangled on the way.
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteScript))
Write-Host "Putting the key on $Address. Type your password for '$User' there (this one time):"
# accept-new: trust the server's own key the first time (on our home network), and check it after.
ssh -o StrictHostKeyChecking=accept-new "$User@$Address" "powershell -NoProfile -EncodedCommand $encoded"
if ($LASTEXITCODE -ne 0) { Write-Host "That didn't work (see above)."; exit 1 }

# --- 3. "chatserver" in ~\.ssh\config
$config = Join-Path $sshFolder "config"
$entry = @"
Host chatserver
    HostName $Address
    User $User
    IdentityFile ~/.ssh/id_ed25519
"@
$text = if (Test-Path $config) { Get-Content $config -Raw } else { "" }
# Replace an older "Host chatserver" block (from running this before), keep everything else.
$text = [regex]::Replace($text, "(?m)^Host chatserver\r?\n(?:[ \t]+.*\r?\n?)*", "")
$text = $text.TrimEnd() + "`n`n" + $entry + "`n"
# Without the invisible "BOM" mark at the start, which Windows' SSH doesn't understand.
[IO.File]::WriteAllText($config, $text.TrimStart(), (New-Object Text.UTF8Encoding $false))

# --- 4. Check
$answer = ssh -o BatchMode=yes chatserver "Write-Output ok"  # BatchMode: fail instead of asking a password
if ($answer -eq "ok") {
    Write-Host "Done: 'ssh chatserver' works without a password. Try .\scripts\deploy.ps1" -ForegroundColor Green
} else {
    Write-Host "Logging in with the key didn't work yet. Run this again, or check the server's step 7." -ForegroundColor Yellow
}
