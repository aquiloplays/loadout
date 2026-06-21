# Build aquilo-crowdplay-companion.exe via PyInstaller.
#
# Mirrors the Loadout/companion-streamkey build (PyInstaller --onefile +
# --runtime-tmpdir=. so the bundle extracts next to the exe instead of
# %TEMP%, sidestepping the AV/CFA filter driver that bit us in 2026-06).
#
# Usage:  pwsh -File build.ps1
# Output: dist/aquilo-crowdplay-companion.exe

# Don't stop on stderr from native commands - PyInstaller writes its info log
# to stderr by default and we don't want PowerShell aborting the build over
# that. We still check $LASTEXITCODE after the PyInstaller call.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

Write-Host "[build] python -m pip install -r requirements.txt + pyinstaller"
python -m pip install --upgrade --quiet pip
python -m pip install --quiet -r requirements.txt
python -m pip install --quiet pyinstaller

# PRE-BUILD SMOKE TEST: construct every Qt widget offscreen so PySide6
# enum / import / attribute regressions surface BEFORE PyInstaller packs.
# Without this gate a broken widget ships and the user sees a popup on
# first launch (the NoEditTriggers bug 2026-06-09).
Write-Host "[build] pre-build smoke test (Qt widget construction)"
python tests\smoke_test.py
if ($LASTEXITCODE -ne 0) {
    Write-Host "[build] smoke test failed - fix the regression above before shipping." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "[build] cleaning prior dist/build artifacts"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue dist, build, "aquilo-crowdplay-companion.spec"

# --runtime-tmpdir=.  : extract bundled assets beside the exe (NOT %TEMP%).
# --windowed          : no console window on launch.
# --name              : final binary name.
# --noconfirm         : overwrite without prompts.
# Resolve the local aquilo-crowdplay source so we can bundle it into the exe.
$enginePath = Resolve-Path -ErrorAction SilentlyContinue (Join-Path $here "..\..\..\aquilo-crowdplay")
if (-not $enginePath) {
    $enginePath = Resolve-Path -ErrorAction SilentlyContinue (Join-Path $here "..\..\aquilo-crowdplay")
}
if (-not $enginePath) {
    Write-Host "[build] WARN: aquilo-crowdplay folder not found; the exe will not bundle the engine source." -ForegroundColor Yellow
    $addData = @()
} else {
    Write-Host "[build] bundling engine source from $enginePath"
    # PyInstaller --add-data format on Windows uses ; as separator.
    # We exclude node_modules / .git / .wrangler by relying on the build to
    # have those untouched (the bundled source loses them on disk anyway).
    $addData = @("--add-data", "$enginePath;aquilo-crowdplay")
}

# Use the generated icon for the .exe so the taskbar pin shows the right glyph.
$icoPath = Join-Path $here "companion_crowdplay\assets\logo.ico"
$iconArgs = if (Test-Path $icoPath) { @("--icon", $icoPath) } else { @() }

python -m PyInstaller `
  --noconfirm `
  --windowed `
  --onefile `
  --runtime-tmpdir=. `
  --name aquilo-crowdplay-companion `
  --collect-submodules PySide6 `
  @iconArgs `
  @addData `
  --add-data "companion_crowdplay/assets;companion_crowdplay/assets" `
  companion_crowdplay/__main__.py

if ($LASTEXITCODE -ne 0) {
  Write-Host "[build] PyInstaller exited $LASTEXITCODE" -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "[build] done."
Get-ChildItem dist | Format-Table Name, Length, LastWriteTime
