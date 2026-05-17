# Loadout - cut a release.
#
# Usage:
#   .\tools\release.ps1 -Version 0.2.0
#   .\tools\release.ps1 -Version 0.2.0 -PushTag        # also git push the tag
#
# What it does:
#   1. Validates the version string (semver-ish)
#   2. Updates Version / AssemblyVersion / FileVersion in the csproj
#   3. Updates the Version constant in 00-boot.cs (so the bootstrap downloads the matching DLL)
#   4. Builds Loadout.dll in Release config
#   5. Regenerates loadout-import.sb.txt with the new version
#   6. Updates the [Unreleased] heading in CHANGELOG.md to dated [vX.Y.Z] and re-adds an empty Unreleased
#   7. Stages a release zip at dist/Loadout-vX.Y.Z.zip with everything a user needs
#   8. Commits the version bumps and creates a git tag vX.Y.Z (signed if your git is configured for it)
#   9. Optionally pushes the tag with -PushTag
#
# After this script runs successfully, the GitHub Actions release.yml workflow takes over: it
# re-builds in CI, packages, and creates a draft GitHub Release with assets attached. You flip
# that draft to Published when you're ready, and post-release-notes.yml posts to Discord.
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$')]
    [string]$Version,

    [switch]$PushTag,
    [switch]$SkipCommit,
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$tag = "v$Version"
$baseVersion = ($Version -split '-')[0]   # strip any -beta.1 suffix for assembly attrs
$assemblyVersion = "$baseVersion.0"

Write-Host ("=" * 60) -ForegroundColor Cyan
Write-Host "Loadout release: $tag" -ForegroundColor Cyan
Write-Host ("=" * 60) -ForegroundColor Cyan

# ── 1. Update csproj ───────────────────────────────────────────────────────
$csprojPath = "src/Loadout.Core/Loadout.Core.csproj"
$csproj = Get-Content $csprojPath -Raw -Encoding utf8
$csproj = [regex]::Replace($csproj, '<Version>[^<]+</Version>',         "<Version>$Version</Version>")
$csproj = [regex]::Replace($csproj, '<AssemblyVersion>[^<]+</AssemblyVersion>', "<AssemblyVersion>$assemblyVersion</AssemblyVersion>")
$csproj = [regex]::Replace($csproj, '<FileVersion>[^<]+</FileVersion>', "<FileVersion>$assemblyVersion</FileVersion>")
Set-Content -Path $csprojPath -Value $csproj -NoNewline -Encoding utf8
Write-Host "  ✓ Updated csproj"

# ── 2. Update 00-boot.cs ───────────────────────────────────────────────────
$bootPath = "streamerbot/actions/00-boot.cs"
$boot = Get-Content $bootPath -Raw -Encoding utf8
$boot = [regex]::Replace($boot, 'private const string Version\s*=\s*"[^"]+";', "private const string Version = `"$Version`";")
Set-Content -Path $bootPath -Value $boot -NoNewline -Encoding utf8
Write-Host "  ✓ Updated 00-boot.cs"

# ── 3. CHANGELOG ───────────────────────────────────────────────────────────
$changelogPath = "CHANGELOG.md"
if (Test-Path $changelogPath) {
    $changelog = Get-Content $changelogPath -Raw -Encoding utf8
    $today = (Get-Date).ToString("yyyy-MM-dd")
    if ($changelog -match '## \[Unreleased\]') {
        $newHeading = "## [Unreleased]`n`n(Nothing queued.)`n`n---`n`n## [$Version] - $today"
        $changelog = [regex]::Replace($changelog, '## \[Unreleased\][^\#]*', $newHeading + "`n`n", 1)
        Set-Content -Path $changelogPath -Value $changelog -NoNewline -Encoding utf8
        Write-Host "  ✓ Promoted [Unreleased] → [$Version] in CHANGELOG"
    } else {
        Write-Host "  ! No [Unreleased] section in CHANGELOG — leaving alone" -ForegroundColor Yellow
    }
}

# ── 4. Build DLL ──────────────────────────────────────────────────────────
Write-Host "  → Building DLL ($Configuration)..."
& dotnet build $csprojPath -c $Configuration --nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed (exit $LASTEXITCODE)" }
$dllPath = "src/Loadout.Core/bin/$Configuration/net48/Loadout.dll"
if (-not (Test-Path $dllPath)) { throw "Expected DLL not found: $dllPath" }
$dllSize = [math]::Round((Get-Item $dllPath).Length / 1KB, 1)
Write-Host "  ✓ Loadout.dll built ($dllSize KB)"

# ── 5. Regenerate import bundle ───────────────────────────────────────────
& "$PSScriptRoot/build-sb-import.ps1" -Version $Version
if (-not (Test-Path "streamerbot/loadout-import.sb.txt")) { throw "Bundle generation failed" }
Write-Host "  ✓ Import bundle regenerated"

# ── 6. Stage release zip ──────────────────────────────────────────────────
$distDir = "dist"
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$stage = Join-Path $distDir "stage-$tag"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item $dllPath                                    $stage/
$nj = "src/Loadout.Core/bin/$Configuration/net48/Newtonsoft.Json.dll"
if (Test-Path $nj) { Copy-Item $nj $stage/ }
Copy-Item "streamerbot/loadout-import.sb.txt"         $stage/
Copy-Item "README.md"                                  $stage/
Copy-Item "INSTALL.md"                                 $stage/
Copy-Item "CHANGELOG.md"                               $stage/
Copy-Item "LICENSE"                                    $stage/

@"
Loadout $tag

QUICK INSTALL:
  1. Drop Loadout.dll into <Streamerbot>/data/Loadout/
  2. Open Streamer.bot, click Import (top-right), paste loadout-import.sb.txt
  3. Restart SB or right-click 'Loadout: Boot' and Run Now
  4. Onboarding wizard opens. Pick what you want enabled.

See INSTALL.md for the full walkthrough.
Issues: https://github.com/aquiloplays/loadout/issues
"@ | Out-File "$stage/QUICKSTART.txt" -Encoding utf8

$zipPath = Join-Path $distDir "Loadout-$tag.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$stage/*" -DestinationPath $zipPath
$zipSize = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "  ✓ Release zip: $zipPath ($zipSize KB)"

# ── 7. Git commit + tag ───────────────────────────────────────────────────
if ($SkipCommit) {
    Write-Host ""
    Write-Host "Skipped git commit + tag (-SkipCommit). Files updated; commit manually." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "Committing version bump + tagging..." -ForegroundColor Cyan

$status = git status --porcelain 2>$null
if (-not $status) {
    Write-Host "  ! No changes to commit (already on this version?)" -ForegroundColor Yellow
} else {
    git add $csprojPath $bootPath "streamerbot/loadout-import.sb.txt" "streamerbot/loadout-import.bundle.json" $changelogPath
    git commit -m "Release $tag"
    if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
    Write-Host "  ✓ Commit created"
}

# Tag
$existing = git tag --list $tag
if ($existing) {
    Write-Host "  ! Tag $tag already exists — leaving alone" -ForegroundColor Yellow
} else {
    git tag -a $tag -m "Loadout $tag"
    if ($LASTEXITCODE -ne 0) { throw "git tag failed" }
    Write-Host "  ✓ Tag $tag created"
}

if ($PushTag) {
    Write-Host "  → Pushing tag..."
    git push origin HEAD --follow-tags
    if ($LASTEXITCODE -ne 0) { throw "git push failed" }
    Write-Host "  ✓ Pushed. CI will build and create the draft release."
} else {
    Write-Host ""
    Write-Host "Tag created locally but not pushed." -ForegroundColor Yellow
    Write-Host "Push with:" -ForegroundColor Yellow
    Write-Host "    git push origin HEAD --follow-tags" -ForegroundColor White
    Write-Host "Or re-run this script with -PushTag." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Release $tag staged. Local zip: $zipPath" -ForegroundColor Green
