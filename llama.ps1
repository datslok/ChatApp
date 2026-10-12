# Starts llama-server: a language model on the graphics card, for the chat's AI bot (Chattus).
#
#   .\llama.ps1     only reachable from this PC, at http://127.0.0.1:8080, with LLAMA_API_KEY from .env
#
# Stop it with Ctrl+C. llama-server and the model are downloaded into llama/ by
# scripts\server\install.ps1 -AI (see README, "Optional: an AI bot"), not committed.
#
# On the server PC, a scheduled task starts it at boot (see scripts\server\install.ps1), with
# -LogFile logs\ai.log: then there's no window, and everything it prints goes to that file.

param([string]$LogFile)

# Work from the folder this script is in, wherever it was started from.
Set-Location $PSScriptRoot

# The model and its picture reader (mmproj), as install.ps1 names them.
$model = "llama\models\qwen3.5-9b-Q4_K_M.gguf"
$mmproj = "llama\models\qwen3.5-9b-mmproj-F16.gguf"

# Read LLAMA_API_KEY from .env (lines like NAME=value).
$settings = @{}
if (Test-Path .env) {
    foreach ($line in Get-Content .env) {
        if ($line -match '^\s*([A-Z_]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2].Trim() }
    }
}
if (-not $settings["LLAMA_API_KEY"]) {
    Write-Host "No API key set. Put LLAMA_API_KEY in .env (see .env.example)."
    exit 1
}
# llama-server reads its key from this environment variable. Like LiveKit's in voice.ps1, it only
# exists for this window and what it starts, so the key isn't visible in the list of running programs.
$env:LLAMA_API_KEY = $settings["LLAMA_API_KEY"]

$arguments = @(
    "-m", $model, "--mmproj", $mmproj,
    "-ngl", "99",                 # every layer of the model on the graphics card (the CPU stays free for calls)
    "-c", "8192",                 # context: how many tokens it reads at once (conversation + answer); fits in 8 GB
    "-np", "1",                   # one answer at a time: the others wait (more would split the memory)
    "--threads", "4",             # at most 4 of the CPU's threads, so LiveKit and the chat always have room
    "--reasoning", "off",         # no "thinking" before answering: chat answers come quicker
    "--host", "127.0.0.1", "--port", "8080"  # only programs on this PC can reach it
)

if (-not $LogFile) {
    .\llama\llama-server.exe @arguments
    exit $LASTEXITCODE
}

# With a log file: keep the previous run's log, then run with everything going into the file.
New-Item -ItemType Directory (Split-Path $LogFile) -Force | Out-Null
if (Test-Path $LogFile) { Move-Item $LogFile ($LogFile -replace '\.log$', '.previous.log') -Force }
$process = Start-Process .\llama\llama-server.exe -ArgumentList $arguments -NoNewWindow -Wait -PassThru `
    -RedirectStandardError $LogFile -RedirectStandardOutput ($LogFile -replace '\.log$', '.out.log')
exit $process.ExitCode  # not 0 = it crashed: the scheduled task then starts it again
