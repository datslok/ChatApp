# Sets up this PC as the chat's server (see README, "Host your own"):
#
#   1. Python, and a virtual environment (.venv) with the packages from requirements.txt
#   2. LiveKit (voice), downloaded into livekit/ and checked against its published checksums
#   3. The Cloudflare Tunnel (cloudflared), as a Windows service, with your tunnel's token
#   4. Windows Firewall rules for LiveKit's audio ports
#   5. Power settings: never sleep on the charger, and closing the lid does nothing
#   6. Two scheduled tasks, "ChatApp" and "ChatApp voice": start serve.ps1 and voice.ps1 at boot
#      (even before anyone logs in), hidden, logging to logs\, and restarting them if they crash
#      or aren't running (checked every 5 minutes); and Task Scheduler's history switched on
#   7. Windows' SSH server, so the development PC can update this one (scripts\deploy.ps1)
#   8. A nightly backup ("ChatApp backup", 04:00) onto a second disk, with scripts\server\backup.ps1
#   9. Only with -AI: llama.cpp and a language model for the AI bot (needs an NVIDIA graphics card
#      with 8 GB), a key for it in .env, and a scheduled task "ChatApp AI" that runs llama.ps1
#
# Run it in PowerShell *as administrator* (right-click PowerShell, "Run as administrator"),
# from the project folder:   .\scripts\server\install.ps1      (or .\scripts\server\install.ps1 -AI)
#
# Safe to run again: every step checks what's already done. Run scripts\server\import.ps1 first if you're
# moving an existing chat here, so the servers start with its data.

param([switch]$AI)

$ErrorActionPreference = "Stop"  # stop at the first error, instead of carrying on half set up
$ProgressPreference = "SilentlyContinue"  # no progress bars: in Windows PowerShell they make downloads very slow
$root = Split-Path (Split-Path $PSScriptRoot)  # the project folder: two up from scripts\server\
Set-Location $root

$LiveKitVersion = "1.13.9"  # the same version as the development PC (see CLAUDE.md)
$LlamaVersion = "b11563"     # llama.cpp's build (github.com/ggml-org/llama.cpp/releases), for -AI
$ModelRepo = "unsloth/Qwen3.5-9B-GGUF"  # the model, from Hugging Face, for -AI

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
    Write-Host "your tunnel -> Add a connector (or Configure). The install command there ends with a long"
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
# Asked right here in the terminal (not in a separate window), so it also works over SSH from the
# development PC. -AsSecureString: shown as dots, and kept encrypted in memory.
# Who we are, asked from Windows itself: "LAPTOP-NAME\axel". (Not $env:USERDOMAIN: over SSH that
# says "WORKGROUP", and "WORKGROUP\axel" is no account Windows knows.)
$userName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$password = Read-Host "Your Windows password for $userName" -AsSecureString
$credential = New-Object System.Management.Automation.PSCredential($userName, $password)

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
# (ExecutionTimeLimit 0: run forever. Restart: if it crashes, try again every minute. Batteries:
#  keep running when the charger is unplugged, which is what the battery is for.)

# (A function, because step 9 makes one more the same way.)
function Register-ChatTask($task) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\$($task.Script)`" -LogFile `"$root\$($task.Log)`""
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $root
    $atBoot = New-ScheduledTaskTrigger -AtStartup
    $atBoot.Delay = "PT30S"  # 30 seconds after boot: the network is up by then (LiveKit looks up our IP)
    # A safety net: also every 5 minutes, from now on. While it's running that does nothing (a task
    # ignores a new start while one is running: "MultipleInstances IgnoreNew", the default), but if
    # it isn't, it starts. Windows once skipped voice's boot start after an update, for no reason it
    # wrote down; with this, the worst is 5 minutes without it. (Stopping one on purpose: it comes back.)
    $every5Minutes = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $task.Name -Action $action -Trigger $atBoot, $every5Minutes -Settings $settings `
        -User $credential.UserName -Password $credential.GetNetworkCredential().Password -RunLevel Limited -Force -ErrorAction Stop | Out-Null
    Write-Host "  Task '$($task.Name)': runs $($task.Script) at boot (and starts it again if it isn't running), log in $($task.Log)"
}
Register-ChatTask @{ Name = "ChatApp"; Script = "serve.ps1"; Log = "logs\chat.log" }
Register-ChatTask @{ Name = "ChatApp voice"; Script = "voice.ps1"; Log = "logs\voice.log" }
# Task Scheduler's history (off by default): what it started, when, and why something didn't run.
# Read it in Task Scheduler (taskschd.msc), a task's History tab.
wevtutil set-log Microsoft-Windows-TaskScheduler/Operational /enabled:true
Write-Host "  Task Scheduler's history is on."

# --- 7. SSH
Step "7. SSH server (so the development PC can update this one)"
# Windows' own SSH server ("OpenSSH"): it only needs switching on. The development PC then runs
# commands here with scripts\deploy.ps1 and copies desktop app releases with scripts\release-upload.ps1.
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
Write-Host "SSH is on. On the development PC, run:  .\scripts\server-connect.ps1 $address $env:USERNAME"

# --- 8. The nightly backup
Step "8. Nightly backup (onto a second disk)"
$drive = (Read-Host "The backup disk's drive letter (Enter for E)").Trim().TrimEnd(":", "\")
if (-not $drive) { $drive = "E" }
if (-not (Test-Path "${drive}:\")) {
    Write-Host "There's no drive ${drive}: here. Skipped: run this script again with the right letter." -ForegroundColor Yellow
} else {
    $backups = "${drive}:\ChatApp-backups"
    New-Item -ItemType Directory $backups -Force | Out-Null
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\scripts\server\backup.ps1`" -Destination `"$backups`""
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -Daily -At "04:00"
    # StartWhenAvailable: if the PC was off at 04:00, back up as soon as it's on again.
    $backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
    Register-ScheduledTask -TaskName "ChatApp backup" -Action $action -Trigger $trigger -Settings $backupSettings `
        -User $credential.UserName -Password $credential.GetNetworkCredential().Password -RunLevel Limited -Force -ErrorAction Stop | Out-Null
    Write-Host "  Task 'ChatApp backup': every night at 04:00 into $backups (log in logs\backup.log)"
    if (Test-Path chat.db) {
        Start-ScheduledTask -TaskName "ChatApp backup"  # the first backup, now
        Write-Host "  The first backup is running now."
    }
}

# --- 9. The AI bot's language model (only with -AI)
if ($AI) {
    Step "9. AI: llama.cpp $LlamaVersion and the model"
    # A program that was started with "2>&1" in this script would count its messages as errors (and
    # stop the script), so cmd runs it and hands us the text.
    function Get-LlamaVersion { cmd /c "`"$root\llama\llama-server.exe`" --version 2>&1" }

    # The task's llama-server would keep its files locked: stop it first (when it's already set up).
    if (Get-ScheduledTask -TaskName "ChatApp AI" -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName "ChatApp AI"
        Get-Process llama-server -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -like "$root*" } | Stop-Process -Force
    }

    # llama.cpp: the program that runs the model (llama-server.exe), built for NVIDIA's CUDA 12.4,
    # which needs an NVIDIA driver from 2024 or newer. Plus NVIDIA's CUDA libraries in a second zip.
    $installed = if (Test-Path llama\llama-server.exe) { (Get-LlamaVersion) -join " " } else { "" }
    if ($installed -match "build $($LlamaVersion.TrimStart('b'))\b") {
        Write-Host "llama.cpp is already there: $installed"
    } else {
        # GitHub lists each file's checksum, so we can check the downloads like LiveKit's.
        $release = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$LlamaVersion"
        # An older version's files go first (the models stay), so none of them are left mixed in.
        if (Test-Path llama) { Get-ChildItem llama -Exclude models | Remove-Item -Recurse -Force }
        New-Item -ItemType Directory llama -Force | Out-Null
        foreach ($zipName in "llama-$LlamaVersion-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip") {
            $asset = $release.assets | Where-Object name -eq $zipName
            if (-not $asset) { throw "$zipName isn't in llama.cpp's release $LlamaVersion." }
            $download = Join-Path $env:TEMP $zipName
            Write-Host "Downloading $zipName ($([int]($asset.size / 1MB)) MB)..."
            Invoke-WebRequest $asset.browser_download_url -OutFile $download -UseBasicParsing
            $actual = (Get-FileHash $download -Algorithm SHA256).Hash.ToLower()
            if ("sha256:$actual" -ne $asset.digest) { throw "$zipName's checksum doesn't match GitHub's. Not installing it." }
            Expand-Archive $download -DestinationPath llama -Force
            Remove-Item $download
        }
        Write-Host "Installed: $((Get-LlamaVersion) -join ' ')"
    }

    # The model, Qwen 3.5 9B, shrunk to 4 bits per number (Q4_K_M, 5.4 GB), and its picture reader
    # (mmproj, 0.9 GB). Hugging Face lists each file's size and checksum; the names here are llama.ps1's.
    New-Item -ItemType Directory llama\models -Force | Out-Null
    $listing = Invoke-RestMethod "https://huggingface.co/api/models/$ModelRepo/tree/main"
    foreach ($file in @(@{ Remote = "Qwen3.5-9B-Q4_K_M.gguf"; Local = "qwen3.5-9b-Q4_K_M.gguf" },
                        @{ Remote = "mmproj-F16.gguf"; Local = "qwen3.5-9b-mmproj-F16.gguf" })) {
        $entry = $listing | Where-Object path -eq $file.Remote
        $path = Join-Path "llama\models" $file.Local
        # Same size: already downloaded (and checked then). Checking 5 GB again would take a while.
        if ((Test-Path $path) -and (Get-Item $path).Length -eq $entry.size) {
            Write-Host "$($file.Local) is already there."
            continue
        }
        Write-Host "Downloading $($file.Remote) ($([int]($entry.size / 1MB)) MB, this takes a while)..."
        # curl (part of Windows) shows its progress and is much faster than Invoke-WebRequest for big files.
        curl.exe -L --fail -o $path "https://huggingface.co/$ModelRepo/resolve/main/$($file.Remote)"
        if ($LASTEXITCODE -ne 0) { throw "Downloading $($file.Remote) failed." }
        $actual = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $entry.lfs.oid) {
            Remove-Item $path
            throw "$($file.Remote)'s checksum doesn't match Hugging Face's. Deleted it."
        }
        Write-Host "  checksum OK"
    }

    # The key the bot needs to use llama-server, made here so it never leaves this PC.
    if (-not (Test-Path .env)) {
        Write-Host "No .env here yet, so no LLAMA_API_KEY. Make .env, then run this again with -AI." -ForegroundColor Yellow
    } elseif (-not (Select-String -Path .env -Pattern '^\s*LLAMA_API_KEY=.+' -Quiet)) {
        $key = .venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"
        Add-Content .env "`n# The AI bot: the key for llama-server (llama.ps1), made by install.ps1 -AI.`nLLAMA_API_KEY=$key"
        Write-Host "Made LLAMA_API_KEY in .env."
    }

    Register-ChatTask @{ Name = "ChatApp AI"; Script = "llama.ps1"; Log = "logs\ai.log" }
    if (Test-Path .env) {
        Start-ScheduledTask -TaskName "ChatApp AI"
        # Loading the model onto the graphics card takes up to a minute. It's ready when port 8080 listens.
        Write-Host "  Loading the model..."
        $running = $false
        for ($second = 0; $second -lt 90 -and -not $running; $second++) {
            Start-Sleep -Seconds 1
            $running = [bool](Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue)
        }
        if ($running) { Write-Host "  AI: running" -ForegroundColor Green }
        else { Write-Host "  AI: not answering after 90 seconds: look in logs\ai.log." -ForegroundColor Yellow }
    }
}

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
    Write-Host "No .env here yet: run .\scripts\server\import.ps1 (moving a chat) or copy .env.example to .env"
    Write-Host "and fill it in (a new chat). Then: Start-ScheduledTask ChatApp; Start-ScheduledTask 'ChatApp voice'"
}

Write-Host ""
Write-Host "Done. Still to do by hand (README, Host your own): the router's port forwarding to this PC" -ForegroundColor Cyan
Write-Host "(step 5), and making yourself an admin (step 6). Moving from an old PC? Remove cloudflared there." -ForegroundColor Cyan
