# On the server PC: how much space the chat takes up. Only reads, never changes anything.
#
#   .\scripts\server\usage.ps1
#
# From the development PC, .\scripts\usage.ps1 runs this over SSH.

param([string]$Backups = "E:\ChatApp-backups")  # where scripts\server\backup.ps1 puts its copies

Set-Location (Split-Path (Split-Path $PSScriptRoot))  # the project folder: two up from scripts\server\

# The files in a folder (and its subfolders), or a list of files: their total size and how many.
function Measure-Files($files) {
    $files = @($files | Where-Object { $_ })  # @(): always a list, even for one or no file
    $sum = ($files | Measure-Object -Property Length -Sum).Sum
    [pscustomobject]@{ Bytes = [double]$sum; Count = $files.Count }
}

function Measure-Folder($path, [switch]$TopOnly) {
    if (-not (Test-Path $path)) { return Measure-Files @() }
    Measure-Files (Get-ChildItem $path -File -Recurse:(-not $TopOnly) -Force)
}

# Bytes as something readable: 512 B, 3.4 MB, 1.2 GB.
function Format-Size([double]$bytes) {
    if ($bytes -ge 1GB) { return "{0:N1} GB" -f ($bytes / 1GB) }
    if ($bytes -ge 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
    if ($bytes -ge 1KB) { return "{0:N0} KB" -f ($bytes / 1KB) }
    return "{0:N0} B" -f $bytes
}

# One line: a name, its size, and (if asked) how many files.
function Write-Row($name, $measured, [switch]$Files) {
    $line = "  {0,-26}{1,10}" -f $name, (Format-Size $measured.Bytes)
    if ($Files) { $line += "   {0,6:N0} files" -f $measured.Count }
    Write-Output $line
}

# The database: chat.db plus SQLite's -wal and -shm files next to it (changes waiting to be folded in).
$database = Measure-Files (Get-ChildItem "chat.db", "chat.db-wal", "chat.db-shm" -ErrorAction SilentlyContinue)
# Uploads: files sent in messages are right in uploads\, pictures in their own subfolders.
$messageFiles = Measure-Folder "uploads" -TopOnly
$avatars = Measure-Folder "uploads\avatars"
$banners = Measure-Folder "uploads\banners"
$emoji = Measure-Folder "uploads\emoji"
$previews = Measure-Folder "uploads\previews"
$uploads = Measure-Folder "uploads"
$releases = Measure-Folder "releases"
$logs = Measure-Folder "logs"
# Copies left lying around (an old export zip, a copy made before a fix): other .db and .zip files here.
$leftoverFiles = Get-ChildItem *.db, *.zip -File | Where-Object { $_.Name -notin "chat.db", "dev.db" }
$leftovers = Measure-Files $leftoverFiles

Write-Output "ChatApp on the server ($((Get-Location).Path))"
Write-Row "Database (chat.db)" $database
Write-Row "Uploads" $uploads -Files
Write-Row "  files in messages" $messageFiles -Files
Write-Row "  profile pictures" $avatars -Files
Write-Row "  banners" $banners -Files
Write-Row "  custom emoji" $emoji -Files
Write-Row "  link preview pictures" $previews -Files
Write-Row "Desktop app releases" $releases -Files
Write-Row "Logs" $logs
if ($leftovers.Count -gt 0) {
    Write-Row "Leftovers ($(($leftoverFiles.Name) -join ', '))" $leftovers
}
Write-Output "  $('-' * 36)"
$total = [pscustomobject]@{ Bytes = $database.Bytes + $uploads.Bytes + $releases.Bytes + $logs.Bytes + $leftovers.Bytes }
Write-Row "Total" $total
Write-Output ""

if (Test-Path $Backups) {
    Write-Output ("Backups ($Backups)   " + (Format-Size (Measure-Folder $Backups).Bytes))
}

# Free space on each disk (Used and Free are in bytes).
$disks = foreach ($drive in Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null }) {
    $size = $drive.Used + $drive.Free
    if ($size -gt 0) { "$($drive.Name): $(Format-Size $drive.Free) free of $(Format-Size $size)" }
}
Write-Output ("Disks   " + ($disks -join "    "))
