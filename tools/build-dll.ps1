# Loadout — build the DLL.
# Usage:  .\tools\build-dll.ps1
# Output: src\Loadout.Core\bin\Release\net48\Loadout.dll
[CmdletBinding()]
param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$proj = Join-Path $repoRoot "src\Loadout.Core\Loadout.Core.csproj"

if (-not (Test-Path $proj)) {
    throw "Project not found: $proj"
}

Write-Host "Building Loadout.Core ($Configuration)..." -ForegroundColor Cyan
& dotnet build $proj -c $Configuration --nologo
if ($LASTEXITCODE -ne 0) { throw "Build failed (exit $LASTEXITCODE)" }

$out = Join-Path $repoRoot "src\Loadout.Core\bin\$Configuration\net48\Loadout.dll"
if (-not (Test-Path $out)) { throw "Expected output not found: $out" }

$size = (Get-Item $out).Length
Write-Host "OK: $out ($([math]::Round($size/1KB,1)) KB)" -ForegroundColor Green
