# From the development PC: change one value in the server's .env (a new API key, a new password), then
# restart the chat and the bot there so they read it.
#
#   .\scripts\set-server-secret.ps1 ANTHROPIC_API_KEY
#
# It asks for the new value without showing it (paste it and press Enter), and sends it to the server
# over SSH's input, never on a command line: command lines can be seen by other programs on the server
# and end up in logs, SSH's input is encrypted on its way and seen by nothing else. The value is never
# printed, here or there. Only a name that's already in .env can be changed (a typo would otherwise add
# a line nobody reads). LiveKit's keys also need LiveKit restarted afterwards: .\scripts\deploy.ps1 -Voice.
#
# The server's backup saves the new .env the next night (scripts\server\backup.ps1).

param([Parameter(Mandatory = $true)][string]$Name)

$ServerFolder = "C:\ChatApp"  # where the code is on the server PC, as in deploy.ps1

# Capital letters, digits and _ only, like every name in .env: so it's safe to put in the command below.
#     (Not repeated back: if a key was pasted here by mistake, it mustn't end up on the screen.)
if ($Name -cnotmatch '^[A-Z][A-Z0-9_]*$') {
    if ($Name.Length -gt 30 -or $Name -match '^sk-') {
        Write-Host "That looks like the value itself, not its name. Give the name after the script; it asks for the value afterwards:"
    } else {
        Write-Host "That isn't a name from .env (capital letters, digits and _ only). Like this:"
    }
    Write-Host "  .\scripts\set-server-secret.ps1 ANTHROPIC_API_KEY"
    exit 1
}

# -AsSecureString: what's typed or pasted isn't shown. Turned back into ordinary text only to send it.
$secure = Read-Host "New value for $Name (it won't show; paste it and press Enter)" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)  # wipe that copy from memory
}
$value = $value.Trim()  # (a copied key often brings a space or line break along)
if (-not $value) {
    Write-Host "Nothing entered, so nothing changed."
    exit 1
}

# What runs on the server, in its PowerShell: read the value from the input, swap the line "NAME=..."
# in .env for "NAME=<value>" (everything else stays as it was, line endings too), then restart the
# chat and the bot like scripts\server\update.ps1 does. It answers with one line saying how it went.
$remote = @'
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # (no "Preparing modules for first use" in the answer)
$name = "__NAME__"
$root = "__FOLDER__"
# Windows PowerShell puts an invisible marker (a UTF-8 "BOM", U+FEFF) before text it pipes into a
# program: read the input as UTF-8 and drop it, or it would end up in front of the value.
[Console]::InputEncoding = New-Object Text.UTF8Encoding $false
$value = [Console]::In.ReadLine()
if ($value) { $value = $value.TrimStart([char]0xFEFF).Trim() }
if (-not $value) { "NOVALUE"; exit 2 }
$path = Join-Path $root ".env"
$text = [IO.File]::ReadAllText($path)
$newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
$lines = $text -split "`r?`n"
$found = 0
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].StartsWith("$name=")) { $lines[$i] = "$name=$value"; $found++ }
}
if ($found -ne 1) { "NOTFOUND $found $($value.Length)"; exit 3 }
# Written next to it first, then moved over it: a .env is never left half-written.
$utf8 = New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllText("$path.new", ($lines -join $newline), $utf8)
Move-Item "$path.new" $path -Force
function Restart-ChatTask($taskName, $commandPart) {
    if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) { return }
    Stop-ScheduledTask -TaskName $taskName
    Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
        Where-Object { $_.CommandLine -like "*$commandPart*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $taskName
}
Restart-ChatTask "ChatApp" "uvicorn server:app --host 127.0.0.1 --port 8000"
Restart-ChatTask "ChatApp bot" "chattus.py"
Start-Sleep -Seconds 8
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | ForEach-Object { $_.CommandLine })
$chat = [bool]($running -like "*uvicorn server:app*")
$bot = [bool]($running -like "*chattus.py*")
"CHANGED chat=$chat bot=$bot"
'@
$remote = $remote.Replace("__NAME__", $Name).Replace("__FOLDER__", $ServerFolder)
# -EncodedCommand: the script as base64 (of UTF-16, as PowerShell wants it), so no quote or $ in it can
# be misread by the shells on the way.
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remote))

Write-Host "Changing $Name on the server and restarting the chat and the bot..."
$OutputEncoding = New-Object Text.UTF8Encoding $false  # (what goes into ssh's input)
$answer = $value | ssh chatserver "powershell -NoProfile -NonInteractive -EncodedCommand $encoded"
$value = $null
$answer = ($answer | Select-Object -Last 1)

if ($answer -like "CHANGED*") {
    Write-Host "$Name is changed in the server's .env." -ForegroundColor Green
    if ($answer -like "*chat=True*") { Write-Host "The chat is running." } else { Write-Host "The chat isn't running yet: check with .\scripts\deploy.ps1 or on the server." -ForegroundColor Yellow }
    if ($answer -like "*bot=True*") { Write-Host "The bot is running: send Chattus a message to try it." } else { Write-Host "The bot isn't running (or isn't set up there): look at logs\bot.log on the server." -ForegroundColor Yellow }
} elseif ($answer -like "NOTFOUND 0*") {
    Write-Host "$Name isn't in the server's .env (check the spelling). Nothing changed." -ForegroundColor Yellow
    exit 1
} elseif ($answer -like "NOTFOUND*") {
    Write-Host "$Name is in the server's .env more than once: fix that by hand first. Nothing changed." -ForegroundColor Yellow
    exit 1
} else {
    Write-Host "Something went wrong on the server (see above). If it says nothing, .env is unchanged." -ForegroundColor Red
    exit 1
}
