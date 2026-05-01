# Loadout - local dev install.
# Builds the DLL and copies it to your Streamer.bot data folder so you can
# iterate without going through a GitHub release. Reflection-based loading
# means you do NOT need to add the DLL to any action's References tab.
#
# Usage:  .\tools\install-dev.ps1
#         .\tools\install-dev.ps1 -SbPath "$env:USERPROFILE\Desktop\Streamerbot"
[CmdletBinding()]
param(
    [string]$SbPath = (Join-Path $env:USERPROFILE "Desktop\Streamerbot"),
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $SbPath)) {
    throw "Streamer.bot folder not found: $SbPath. Pass -SbPath <path> if it is elsewhere."
}

& (Join-Path $PSScriptRoot "build-dll.ps1") -Configuration $Configuration
$dll = Join-Path $repoRoot "src\Loadout.Core\bin\$Configuration\net48\Loadout.dll"

$dataDir = Join-Path $SbPath "data\Loadout"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Copy-Item $dll (Join-Path $dataDir "Loadout.dll") -Force

# Newtonsoft.Json sits next to the DLL so Assembly.LoadFrom can resolve the dep.
$nj = Join-Path $repoRoot "src\Loadout.Core\bin\$Configuration\net48\Newtonsoft.Json.dll"
if (Test-Path $nj) {
    Copy-Item $nj (Join-Path $dataDir "Newtonsoft.Json.dll") -Force
    Write-Host "  + Newtonsoft.Json.dll" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Installed to $dataDir" -ForegroundColor Green
Write-Host "Next:"
Write-Host "  1. Open Streamer.bot."
Write-Host "  2. Click Import top-right and paste the contents of:"
Write-Host "     $repoRoot\streamerbot\loadout-import.sb.txt"
Write-Host "  3. Right-click 'Loadout: Boot' and Run Now (or restart SB)."
Write-Host ""
Write-Host "No References-tab edits required - the actions load the DLL via reflection."
