# Sets up this PC as the chat's server (see README, "Running the server on its own PC"):
#
#   1. Python, and a virtual environment (.venv) with the packages from requirements.txt
#   2. LiveKit (voice), downloaded into livekit/ and checked against its published checksums
#   3. The Cloudflare Tunnel (cloudflared), as a Windows service, with your tunnel's token
#   4. Windows Firewall rules for LiveKit's audio ports
#   5. Power settings: never sleep on the charger, and closing the lid does nothing
#   6. Two scheduled tasks, "ChatApp" and "ChatApp voice": start serve.ps1 and voice.ps1 at boot
#      (even before anyone logs in), hidden, logging to logs\, and restarting them if they crash
#   7. Windows' SSH server, so the development PC can update this one (deploy.ps1)
#
# Run it in PowerShell *as administrator* (right-click PowerShell, "Run as administrator"),
# from this folder:   .\server-install.ps1
#
# Safe to run again: every step checks what's already done. Run server-import.ps1 first if you're
# moving an existing chat here, so the servers start with its data.

$ErrorActionPreference = "Stop"  # stop at the first error, instead of carrying on half set up
$ProgressPreference = "SilentlyContinue"  # no progress bars: in Windows PowerShell they make downloads very slow
Set-Location $PSScriptRoot
$root = $PSScriptRoot

$LiveKitVersion = "1.13.9"  # the same version as the development PC (see CLAUDE.md)

function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }

# winget installs programs and adds them to PATH, but only new windows see the new PATH. Read it
# again from Windows' settings, so this window finds them too.
function Update-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
}

# --- Administrator? (firewall rules, the service and the tasks need it)
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Please run this in PowerShell as administrator (right-click PowerShell, Run as administrator)."
    exit 1
}

# --- winget (Windows' own installer for programs): on every up-to-date Windows 10 and 11
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "winget is missing. Install 'App Installer' from the Microsoft Store (or update Windows), then run this again."
    exit 1
}

# --- 1. Python and the virtual environment
Step "1. Python"
# "py" is the Python launcher that comes with Python from python.org. (Plain "python" can be
# Windows' stand-in that only opens the Microsoft Store, so we don't trust that.)
Update-Path
if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Python 3.13 (for all users)..."
    winget install --exact --id Python.Python.3.13 --scope machine --silent --accept-package-agreements --accept-source-agreements
    Update-Path
}
if (-not (Test-Path .venv\Scripts\python.exe)) {
    Write-Host "Making the virtual environment (.venv)..."
    # A venv: this project's own copy of Python's package folder, so its packages are kept apart.
    py -3.13 -m venv .venv
}
Write-Host "Installing the packages from requirements.txt..."
.venv\Scripts\python.exe -m pip install --upgrade pip --quiet
.venv\Scripts\python.exe -m pip install -r requirements.txt --quiet
if ($LASTEXITCODE -ne 0) { throw "Installing the packages failed." }
Write-Host "Python is ready."

# --- 2. LiveKit
Step "2. LiveKit $LiveKitVersion"
$livekitExe = Join-Path $root "livekit\livekit-server.exe"
$installed = if (Test-Path $livekitExe) { (& $livekitExe --version) -join " " } else { "" }
if ($installed -match [regex]::Escape($LiveKitVersion)) {
    Write-Host "Already there: $installed"
} else {
    $base = "https://github.com/livekit/livekit/releases/download/v$LiveKitVersion"
    $zipName = "livekit_${LiveKitVersion}_windows_amd64.zip"
    $download = Join-Path $env:TEMP $zipName
    Write-Host "Downloading $zipName..."
    Invoke-WebRequest "$base/$zipName" -OutFile $download -UseBasicParsing
    # The checksum: a fingerprint of the file. If ours matches LiveKit's, it's exactly their file.
    $checksumFile = Join-Path $env:TEMP "livekit-checksums.txt"
    Invoke-WebRequest "$base/checksums.txt" -OutFile $checksumFile -UseBasicParsing
    $checksums = Get-Content $checksumFile -Raw  # (read from a file: GitHub sends it as a download, not as text)
    Remove-Item $checksumFile
    $expected = ($checksums -split "`n" | Where-Object { $_ -match [regex]::Escape($zipName) }) -split "\s+" | Select-Object -First 1
    $actual = (Get-FileHash $download -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) { throw "The download's checksum doesn't match LiveKit's. Not installing it." }
    New-Item -ItemType Directory livekit -Force | Out-Null
    Expand-Archive $download -DestinationPath livekit -Force
    Remove-Item $download
    Write-Host "Installed: $((& $livekitExe --version) -join ' ')"
}

# --- 3. The Cloudflare Tunnel
Step "3. Cloudflare Tunnel"
Update-Path
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "Installing cloudflared..."
    winget install --exact --id Cloudflare.cloudflared --silent --accept-package-agreements --accept-source-agreements
    Update-Path
}
if (Get-Service Cloudflared -ErrorAction SilentlyContinue) {
    Write-Host "The tunnel service is already installed."
} else {
    Write-Host "The tunnel needs its token. In Cloudflare's Zero Trust dashboard: Networks -> Tunnels ->"
    Write-Host "chatapp -> Add a connector (or Configure). The install command there ends with a long"
    Write-Host "token starting with eyJ. Copy just that token."
    $token = Read-Host "Paste the token (or press Enter to skip this for now)"
    if ($token) {
        cloudflared service install $token.Trim()
        Write-Host "The tunnel service is installed and running."
    } else {
        Write-Host "Skipped. Run this script again when you have the token."
    }
}

# --- 4. Firewall
Step "4. Firewall rules for LiveKit"
# Only for livekit-server.exe in this folder, and only its two audio ports.
foreach ($rule in @(@{ Name = "LiveKit voice (UDP 7882)"; Protocol = "UDP"; Port = 7882 },
                    @{ Name = "LiveKit voice (TCP 7881)"; Protocol = "TCP"; Port = 7881 })) {
    Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow -Protocol $rule.Protocol `
        -LocalPort $rule.Port -Program $livekitExe -Profile Any | Out-Null
    Write-Host "  $($rule.Name): allowed"
}

# --- 5. Power
Step "5. Power settings (on the charger)"
powercfg /change standby-timeout-ac 0     # never sleep
powercfg /change hibernate-timeout-ac 0   # never hibernate
# Closing the lid: do nothing (0), on the charger. (SUB_BUTTONS / LIDACTION are powercfg's names.)
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
Write-Host "On the charger it now never sleeps, and closing the lid does nothing."

# --- 6. The scheduled tasks
Step "6. Starting the chat and voice with Windows"
New-Item -ItemType Directory logs -Force | Out-Null
Write-Host "The tasks run as your account, also when nobody is logged in, so Windows needs your"
Write-Host "password once. (With a Microsoft account: its password, not the PIN.)"
$credential = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message "Your Windows password, for the ChatApp tasks"

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
# (ExecutionTimeLimit 0: run forever. Restart: if it crashes, try again every minute. Batteries:
#  keep running when the charger is unplugged, which is what the battery is for.)

foreach ($task in @(@{ Name = "ChatApp"; Script = "serve.ps1"; Log = "logs\chat.log" },
                    @{ Name = "ChatApp voice"; Script = "voice.ps1"; Log = "logs\voice.log" })) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\$($task.Script)`" -LogFile `"$root\$($task.Log)`""
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = "PT30S"  # 30 seconds after boot: the network is up by then (LiveKit looks up our IP)
    Register-ScheduledTask -TaskName $task.Name -Action $action -Trigger $trigger -Settings $settings `
        -User $credential.UserName -Password $credential.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
    Write-Host "  Task '$($task.Name)': runs $($task.Script) at boot, log in $($task.Log)"
}

# --- 7. SSH
Step "7. SSH server (so the development PC can update this one)"
# Windows' own SSH server ("OpenSSH"): it only needs switching on. The development PC then runs
# commands here with deploy.ps1 and copies desktop app releases with release-upload.ps1.
$sshServer = Get-WindowsCapability -Online -Name "OpenSSH.Server*" | Select-Object -First 1
if ($sshServer.State -ne "Installed") {
    Write-Host "Switching on Windows' SSH server (this can take a minute)..."
    Add-WindowsCapability -Online -Name $sshServer.Name | Out-Null
}
Set-Service sshd -StartupType Automatic  # start with Windows
Start-Service sshd
# The shell you get over SSH: PowerShell, instead of the old cmd.
New-Item -Path "HKLM:\SOFTWARE\OpenSSH" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -PropertyType String -Force `
    -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" | Out-Null
# The firewall: SSH (port 22) only from this home network. (The router doesn't forward port 22,
# so the internet can't reach it anyway.)
if (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -RemoteAddress LocalSubnet
} else {
    New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" -Direction Inbound `
        -Protocol TCP -LocalPort 22 -Action Allow -RemoteAddress LocalSubnet | Out-Null
}
$address = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -like "192.168.*" -or $_.IPAddress -like "10.*" } | Select-Object -First 1).IPAddress
Write-Host "SSH is on. On the development PC, run:  .\server-connect.ps1 $address $env:USERNAME"

# --- Start them now (if there's something to start)
Step "Starting"
if (Test-Path .env) {
    Start-ScheduledTask -TaskName "ChatApp"
    Start-ScheduledTask -TaskName "ChatApp voice"
    Start-Sleep -Seconds 8
    foreach ($check in @(@{ Name = "Chat"; Url = "http://localhost:8000/login" }, @{ Name = "Voice"; Url = "http://localhost:7880" })) {
        try {
            Invoke-WebRequest $check.Url -UseBasicParsing -TimeoutSec 5 | Out-Null
            Write-Host "  $($check.Name): running" -ForegroundColor Green
        } catch {
            Write-Host "  $($check.Name): not answering yet. Give it a minute, or look in logs\." -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "No .env here yet: run .\server-import.ps1 (moving a chat) or copy .env.example to .env"
    Write-Host "and fill it in (a new chat). Then: Start-ScheduledTask ChatApp; Start-ScheduledTask 'ChatApp voice'"
}

Write-Host ""
Write-Host "Done. Still to do by hand (see the README): the router's port forwarding to this PC, and" -ForegroundColor Cyan
Write-Host "removing cloudflared from the old PC." -ForegroundColor Cyan
