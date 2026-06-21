# Loadout - resilient local dev install.
#
# Builds the DLL and copies it to your Streamer.bot data folder. Three
# write modes, tried in order:
#
#   1. Direct overwrite of Loadout.dll       (works only when SB is closed)
#   2. Atomic rename (Move) which sometimes succeeds while the file is
#      loaded into another process - retried as a second attempt.
#   3. Stage as Loadout.dll.new + drop a flag. SB's boot action swaps
#      .new -> .dll on next launch via 00-boot.cs's stage-then-swap path.
#
# Exits 0 unless every path fails. Prints which mode landed so you know
# whether a restart is needed.
#
# Usage:  .\tools\install-dev.ps1
#         .\tools\install-dev.ps1 -SbPath "$env:USERPROFILE\Desktop\Streamerbot"
#         .\tools\install-dev.ps1 -SkipBuild       # use already-built DLL
[CmdletBinding()]
param(
    [string]$SbPath = (Join-Path $env:USERPROFILE "Desktop\Streamerbot"),
    [string]$Configuration = "Release",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $SbPath)) {
    throw "Streamer.bot folder not found: $SbPath. Pass -SbPath <path> if it is elsewhere."
}

# 1. Build
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot "build-dll.ps1") -Configuration $Configuration
}
$srcDir = Join-Path $repoRoot "src\Loadout.Core\bin\$Configuration\net48"
$dllSrc = Join-Path $srcDir 'Loadout.dll'
if (-not (Test-Path $dllSrc)) {
    throw "Built DLL not found at $dllSrc - did the build succeed?"
}

# 2. Resolve destination
$dataDir = Join-Path $SbPath "data\Loadout"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# 3. Install with locked-file fallback
$dstDll = Join-Path $dataDir 'Loadout.dll'
$dstNew = Join-Path $dataDir 'Loadout.dll.new'
$installedAs = $null

function Try-CopyDirect {
    param([string]$src, [string]$dst)
    try {
        Copy-Item $src $dst -Force -ErrorAction Stop
        return $true
    } catch [System.IO.IOException] {
        return $false
    } catch {
        Write-Host ("  ! Unexpected error during direct copy: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
        return $false
    }
}

function Try-AtomicReplace {
    param([string]$src, [string]$dst)
    try {
        $tmp = $dst + ".swap"
        Copy-Item $src $tmp -Force
        [System.IO.File]::Move($tmp, $dst)
        return $true
    } catch {
        try { if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue } } catch {}
        return $false
    }
}

if (Try-CopyDirect -src $dllSrc -dst $dstDll) {
    $installedAs = 'direct'
} elseif (Try-AtomicReplace -src $dllSrc -dst $dstDll) {
    $installedAs = 'atomic-replace'
} else {
    Copy-Item $dllSrc $dstNew -Force
    $installedAs = 'staged'
}

# 4. Sidecars (Newtonsoft.Json + icon)
$njSrc = Join-Path $srcDir 'Newtonsoft.Json.dll'
$njDst = Join-Path $dataDir 'Newtonsoft.Json.dll'
if (Test-Path $njSrc) {
    if (-not (Try-CopyDirect -src $njSrc -dst $njDst)) {
        Copy-Item $njSrc ($njDst + '.new') -Force
    }
}
$icoSrc = Join-Path $repoRoot 'assets\Loadout.ico'
if (Test-Path $icoSrc) {
    try { Copy-Item $icoSrc (Join-Path $dataDir 'Loadout.ico') -Force } catch {}
}

# 5. Report
$v = [System.Reflection.AssemblyName]::GetAssemblyName($dllSrc).Version
$verStr = '{0}.{1}.{2}' -f $v.Major, $v.Minor, $v.Build

Write-Host ""
switch ($installedAs) {
    'direct' {
        Write-Host ("Loadout.dll v{0} installed live (SB was closed)." -f $verStr) -ForegroundColor Green
        Write-Host "Start Streamer.bot to load the new build." -ForegroundColor Gray
    }
    'atomic-replace' {
        Write-Host ("Loadout.dll v{0} swapped in place via atomic rename." -f $verStr) -ForegroundColor Green
        Write-Host "Restart Streamer.bot to load the new build (the loaded copy is still the old one)." -ForegroundColor Gray
    }
    'staged' {
        Write-Host ("Loadout.dll v{0} staged as Loadout.dll.new (SB had it locked)." -f $verStr) -ForegroundColor Yellow
        Write-Host "Restart Streamer.bot - the boot action swaps .new -> .dll on startup." -ForegroundColor Gray
    }
}
Write-Host ("Path: {0}" -f $dataDir) -ForegroundColor Gray
