# Progression badges — HD pixel-art generator.
#
# PROGRESSION-SYSTEM-DESIGN.md §7 — 64×64 PNG per badge, written to
# aquilo-gg/sprites/progression/badges/<id>.png. Mirrors the v2 Clash
# generator structure: shared material ramps from lib-pixel.ps1,
# rarity-coloured ring + brand-accent glyph in the centre, hand-tuned
# shape per badge kind.
#
# The catalogue is the JS-side source of truth; this script parses
# tools/badge-manifest.json (regenerated from
# discord-bot/progression/badges-catalog.js) and renders one PNG per
# entry. To regenerate the manifest, the workflow is:
#   1. Edit discord-bot/progression/badges-catalog.js
#   2. Run tools/dump-badge-manifest.mjs (committed alongside this file)
#   3. Run this generator.

[CmdletBinding()]
param(
  [string]$OutRoot = '',
  [string[]]$Only = @()
)
$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $OutRoot) {
  $OutRoot = Join-Path (Split-Path -Parent $scriptDir) 'aquilo-gg/sprites'
}
. (Join-Path $scriptDir 'lib-pixel.ps1')

$badgeDir = Join-Path (Join-Path $OutRoot 'progression') 'badges'
New-Item -ItemType Directory -Force -Path $badgeDir | Out-Null

$BADGE_W = 64
$BADGE_H = 64
$CX = 32
$CY = 32

# Accent palette — drives the centre glyph colour. Mirrors the brand
# palette defined in lib-pixel.ps1.
function Accent-Ramp { param([string]$accent)
  switch ($accent) {
    'gold'     { return $MAT_GOLD }
    'violet'   { return @{ deep=(Color-FromHex '#1a0c40'); shadow=(Color-FromHex '#3a1f7a'); base=$BRAND.Violet; high=$BRAND.VioletHi; top=(Color-FromHex '#d0c0ff'); } }
    'crimson'  { return @{ deep=(Color-FromHex '#3a0a08'); shadow=(Color-FromHex '#7a1818'); base=(Color-FromHex '#c83c30'); high=(Color-FromHex '#f86a58'); top=(Color-FromHex '#ffaabc'); } }
    'teal'     { return @{ deep=(Color-FromHex '#0a3a30'); shadow=(Color-FromHex '#1a6a58'); base=$BRAND.Teal; high=(Color-FromHex '#a8f0e0'); top=(Color-FromHex '#e0fff8'); } }
    'emerald'  { return @{ deep=(Color-FromHex '#0a3a18'); shadow=(Color-FromHex '#206a30'); base=$BRAND.Green; high=(Color-FromHex '#a8f0bc'); top=(Color-FromHex '#e0ffe8'); } }
    'sapphire' { return @{ deep=(Color-FromHex '#0a1a4a'); shadow=(Color-FromHex '#1a3a7a'); base=(Color-FromHex '#2e5ebc'); high=(Color-FromHex '#5a8af0'); top=(Color-FromHex '#a4c0ff'); } }
    'silver'   { return $MAT_SILVER }
    'iron'     { return $MAT_IRON }
    'bronze'   { return $MAT_BRONZE }
    default    { return $MAT_GOLD }
  }
}

# Rarity → ring colour. Drives the outer halo + frame.
function Rarity-Ring { param([string]$rarity)
  switch ($rarity) {
    'common'    { return (Color-FromHex '#7a818c') }
    'rare'      { return (Color-FromHex '#5a8af0') }
    'epic'      { return (Color-FromHex '#a878f0') }
    'legendary' { return (Color-FromHex '#f0c050') }
    default     { return (Color-FromHex '#7a818c') }
  }
}

# ── Glyph painters ─────────────────────────────────────────────────
# Each draws inside a centred ~36×36 area (the badge frame leaves
# ~12 px of border for the ring + accent halo).

function Glyph-Star { param($bmp, $r)
  # 5-point star at the centre
  $points = @()
  for ($i = 0; $i -lt 10; $i++) {
    $rad = if (($i % 2) -eq 0) { 14.0 } else { 6.0 }
    $ang = -1.570796 + ($i * 0.628318)   # start at top, 36° step
    $px = [int]([Math]::Round($CX + [Math]::Cos($ang) * $rad))
    $py = [int]([Math]::Round($CY + [Math]::Sin($ang) * $rad))
    $points += ,@($px, $py)
  }
  # Fill (scanline-ish): draw lines from centre to each point and
  # fan-fill between adjacent points
  for ($i = 0; $i -lt 10; $i++) {
    $a = $points[$i]
    $b = $points[($i + 1) % 10]
    for ($t = 0; $t -le 14; $t++) {
      $u = $t / 14.0
      $x = [int]([Math]::Round($CX + ($a[0] - $CX) * $u))
      $y = [int]([Math]::Round($CY + ($a[1] - $CY) * $u))
      Set-Pixel $bmp $x $y $r.base
      $x2 = [int]([Math]::Round($CX + ($b[0] - $CX) * $u))
      $y2 = [int]([Math]::Round($CY + ($b[1] - $CY) * $u))
      Set-Pixel $bmp $x2 $y2 $r.base
      Line-Pixel $bmp $x $y $x2 $y2 $r.base
    }
  }
  # Outline + highlight
  for ($i = 0; $i -lt 10; $i++) {
    $a = $points[$i]
    $b = $points[($i + 1) % 10]
    Line-Pixel $bmp $a[0] $a[1] $b[0] $b[1] $r.deep
  }
  # Specular highlight on upper-left
  Set-Pixel $bmp ($CX - 2) ($CY - 6) $r.top
  Set-Pixel $bmp ($CX - 1) ($CY - 7) $r.top
}

function Glyph-Shield { param($bmp, $r)
  # Heater shield silhouette
  for ($y = 12; $y -le 50; $y++) {
    $taper = if ($y -lt 28) { 16 } else { [int](16 - ($y - 28) * 0.9) }
    if ($taper -lt 1) { $taper = 1 }
    for ($dx = -$taper; $dx -le $taper; $dx++) {
      Set-Pixel $bmp ($CX + $dx) $y $r.base
    }
    Set-Pixel $bmp ($CX - $taper) $y $r.deep
    Set-Pixel $bmp ($CX + $taper) $y $r.shadow
  }
  for ($x = -16; $x -le 16; $x++) { Set-Pixel $bmp ($CX + $x) 12 $r.high }
  Set-Pixel $bmp $CX 14 $r.top
  # Centre rivet
  Draw-Rivet $bmp $CX 28 $r
}

function Glyph-Flame { param($bmp, $r)
  $hot = @{
    deep=(Color-FromHex '#3a0a08'); shadow=(Color-FromHex '#7a1818'); base=$r.base; high=$r.high; top=(Color-FromHex '#fff8c0');
  }
  Shade-Oval $bmp $CX ($CY + 6) 12 14 $hot
  Shade-Disc $bmp $CX ($CY - 4) 7 (@{
    deep=$hot.shadow; shadow=$hot.base; base=$hot.high; high=$hot.top; top=$hot.top;
  })
  Set-Pixel $bmp $CX ($CY - 12) $hot.top
}

function Glyph-Medal { param($bmp, $r)
  # Ribbon
  for ($y = 8; $y -le 22; $y++) {
    $w = if ($y -lt 16) { 10 } else { 6 }
    Fill-Box $bmp ($CX - $w) $y ($w * 2) 1 $r.shadow
  }
  # Disc
  Shade-Disc $bmp $CX ($CY + 6) 13 $r -RimLight
  # Inner star
  for ($i = -3; $i -le 3; $i++) { Set-Pixel $bmp $CX ($CY + 6 + $i) $r.high }
  for ($i = -3; $i -le 3; $i++) { Set-Pixel $bmp ($CX + $i) ($CY + 6) $r.high }
  Set-Pixel $bmp $CX ($CY + 6) $r.top
}

function Glyph-Crown { param($bmp, $r)
  # Base band
  Fill-Box $bmp 12 36 40 8 $r.base
  Fill-Box $bmp 12 36 40 1 $r.high
  Fill-Box $bmp 12 43 40 1 $r.shadow
  # Three spikes — avoid foreach-iterator/$CX name collision by using
  # an explicit list + indexed access (PowerShell is case-insensitive
  # so $cx and $CX would be the same variable).
  $spikeXs = @(($CX - 14), $CX, ($CX + 14))
  for ($s = 0; $s -lt $spikeXs.Count; $s++) {
    $spikeX = [int]$spikeXs[$s]
    for ($i = 0; $i -le 12; $i++) {
      $w = 5 - [int]($i * 0.4)
      if ($w -lt 1) { $w = 1 }
      Fill-Box $bmp ($spikeX - [int]($w / 2)) (35 - $i) $w 1 $r.base
    }
    Set-Pixel $bmp $spikeX 22 $r.top
  }
  # Gems
  Set-Pixel $bmp ($CX - 14) 28 (Color-FromHex '#c83c30')
  Set-Pixel $bmp $CX 28 (Color-FromHex '#5a8af0')
  Set-Pixel $bmp ($CX + 14) 28 (Color-FromHex '#5fc4a8')
}

function Glyph-Paw { param($bmp, $r)
  Shade-Oval $bmp $CX ($CY + 8) 12 8 $r
  # 4 toes
  foreach ($p in @(@(-10, -2), @(-4, -8), @(4, -8), @(10, -2))) {
    Shade-Disc $bmp ($CX + $p[0]) ($CY + $p[1]) 4 $r
  }
}

function Glyph-Cards { param($bmp, $r)
  # Two cards fanned
  for ($y = 12; $y -le 48; $y++) {
    Fill-Box $bmp ($CX - 14) $y 10 1 $r.shadow
    Set-Pixel $bmp ($CX - 14) $y $r.deep
    Set-Pixel $bmp ($CX - 5) $y $r.high
  }
  for ($y = 14; $y -le 50; $y++) {
    Fill-Box $bmp ($CX) $y 10 1 $r.base
    Set-Pixel $bmp $CX $y $r.shadow
    Set-Pixel $bmp ($CX + 9) $y $r.deep
  }
  # Card pip
  Set-Pixel $bmp ($CX - 9) 30 $r.top
  Set-Pixel $bmp ($CX + 4) 32 $r.top
}

function Glyph-Sword { param($bmp, $r)
  Draw-Blade $bmp $CX 10 42 6 $r -Fuller
  Fill-Box $bmp ($CX - 6) 42 13 2 $r.base
  Draw-Grip $bmp $CX 44 54 2 $MAT_LEATHER
  Shade-Disc $bmp $CX 55 3 $MAT_GOLD
}

function Glyph-Castle { param($bmp, $r)
  # Three-tower silhouette
  Fill-Box $bmp 14 24 36 24 $r.base
  Fill-Box $bmp 14 24 36 1 $r.high
  Fill-Box $bmp 14 47 36 1 $r.deep
  Fill-Box $bmp 14 24 1 24 $r.high
  Fill-Box $bmp 49 24 1 24 $r.shadow
  $towerXs = @(14, ($CX - 4), 42)
  for ($t = 0; $t -lt $towerXs.Count; $t++) {
    $tx = [int]$towerXs[$t]
    Fill-Box $bmp $tx 16 8 12 $r.base
    Fill-Box $bmp $tx 16 8 1 $r.high
    # Crenel
    Set-Pixel $bmp $tx 14 $r.base
    Set-Pixel $bmp ($tx + 1) 14 $r.base
    Set-Pixel $bmp ($tx + 4) 14 $r.base
    Set-Pixel $bmp ($tx + 5) 14 $r.base
  }
  # Door
  Fill-Box $bmp ($CX - 3) 38 6 10 (Color-FromHex '#3a2515')
  Set-Pixel $bmp $CX 41 (Color-FromHex '#f0c850')
}

function Glyph-Orb { param($bmp, $r)
  Shade-Disc $bmp $CX $CY 14 $r -RimLight
  # Highlight reflection
  Set-Pixel $bmp ($CX - 3) ($CY - 7) $r.top
  Set-Pixel $bmp ($CX - 4) ($CY - 6) $r.top
  Set-Pixel $bmp ($CX - 2) ($CY - 6) $r.high
}

function Glyph-Fang { param($bmp, $r)
  # Two curving fangs
  for ($y = 14; $y -le 46; $y++) {
    $w = 5 - [int](($y - 14) / 12)
    if ($w -lt 1) { $w = 1 }
    Fill-Box $bmp ($CX - 12) $y $w 1 $r.base
    Fill-Box $bmp ($CX + 12 - $w + 1) $y $w 1 $r.base
  }
  # Curl tips
  Set-Pixel $bmp ($CX - 10) 46 $r.deep
  Set-Pixel $bmp ($CX + 10) 46 $r.deep
}

function Glyph-Wing { param($bmp, $r)
  # Single feathered wing fanning right
  for ($i = 0; $i -le 14; $i++) {
    $len = 22 - $i
    if ($len -lt 4) { $len = 4 }
    for ($j = 0; $j -lt $len; $j++) {
      Set-Pixel $bmp ($CX - 10 + $j) (16 + $i) $r.base
    }
    Set-Pixel $bmp ($CX - 10) (16 + $i) $r.deep
    Set-Pixel $bmp ($CX - 10 + $len - 1) (16 + $i) $r.high
  }
}

function Glyph-Trophy { param($bmp, $r)
  # Cup body
  Fill-Box $bmp ($CX - 10) 16 20 18 $r.base
  Fill-Box $bmp ($CX - 10) 16 20 1 $r.high
  for ($y = 16; $y -le 33; $y++) {
    Set-Pixel $bmp ($CX - 10) $y $r.high
    Set-Pixel $bmp ($CX + 9) $y $r.shadow
  }
  # Tapered stem + base
  Fill-Box $bmp ($CX - 3) 34 6 8 $r.base
  Fill-Box $bmp ($CX - 8) 42 16 4 $r.base
  Fill-Box $bmp ($CX - 8) 45 16 1 $r.deep
  # Handles
  for ($i = 0; $i -le 8; $i++) {
    Set-Pixel $bmp ($CX - 14) (20 + $i) $r.base
    Set-Pixel $bmp ($CX + 13) (20 + $i) $r.base
  }
  Set-Pixel $bmp ($CX - 14) 20 $r.high
  Set-Pixel $bmp ($CX + 13) 20 $r.shadow
}

function Glyph-Lightning { param($bmp, $r)
  # Bold zigzag bolt
  $pts = @(
    @(36, 12),@(36, 13),@(35, 14),@(34, 15),@(33, 16),@(32, 17),
    @(31, 18),@(30, 19),@(29, 20),@(28, 21),@(27, 22),@(26, 23),
    @(25, 24),@(24, 25),@(23, 26),@(22, 27),@(21, 28),@(20, 29),
    @(19, 30),@(18, 31),@(17, 32),@(20, 32),@(23, 32),@(26, 32),
    @(29, 32),@(32, 32),@(30, 33),@(28, 34),@(26, 35),@(24, 36),
    @(22, 37),@(20, 38),@(18, 39),@(16, 40),@(14, 41),@(12, 42),
    @(10, 43),@(8, 44),@(6, 45),@(4, 46)
  )
  foreach ($p in $pts) {
    Set-Pixel $bmp $p[0] $p[1] $r.base
    Set-Pixel $bmp ($p[0] + 1) $p[1] $r.high
    Set-Pixel $bmp $p[0] ($p[1] + 1) $r.shadow
  }
}

function Draw-Glyph { param($bmp, [string]$shape, $r)
  switch ($shape) {
    'star'      { Glyph-Star      $bmp $r }
    'shield'    { Glyph-Shield    $bmp $r }
    'flame'     { Glyph-Flame     $bmp $r }
    'medal'     { Glyph-Medal     $bmp $r }
    'crown'     { Glyph-Crown     $bmp $r }
    'paw'       { Glyph-Paw       $bmp $r }
    'cards'     { Glyph-Cards     $bmp $r }
    'sword'     { Glyph-Sword     $bmp $r }
    'castle'    { Glyph-Castle    $bmp $r }
    'orb'       { Glyph-Orb       $bmp $r }
    'fang'      { Glyph-Fang      $bmp $r }
    'wing'      { Glyph-Wing      $bmp $r }
    'trophy'    { Glyph-Trophy    $bmp $r }
    'lightning' { Glyph-Lightning $bmp $r }
    default     { Glyph-Star      $bmp $r }
  }
}

function Draw-Badge {
  param($bmp, [string]$badgeId, [string]$shape, [string]$accent, [string]$rarity)
  Rng-Init "badge-$badgeId"
  # Frame disc — dark base
  Shade-Disc $bmp $CX $CY 30 (@{
    deep=(Color-FromHex '#040510');
    shadow=(Color-FromHex '#0a0c18');
    base=(Color-FromHex '#1a1f2c');
    high=(Color-FromHex '#2a3148');
    top=(Color-FromHex '#3c4366');
  }) -RimLight
  # Rarity ring
  $ringCol = Rarity-Ring $rarity
  for ($a = 0; $a -lt 360; $a += 2) {
    $rad = $a * 3.14159 / 180.0
    $rx = [int]([Math]::Round($CX + [Math]::Cos($rad) * 28))
    $ry = [int]([Math]::Round($CY + [Math]::Sin($rad) * 28))
    Set-Pixel $bmp $rx $ry $ringCol
    $rx2 = [int]([Math]::Round($CX + [Math]::Cos($rad) * 27))
    $ry2 = [int]([Math]::Round($CY + [Math]::Sin($rad) * 27))
    Set-Pixel $bmp $rx2 $ry2 (Mix-Color $ringCol (Color-FromHex '#000000') 0.4)
  }
  # Glyph
  $accentRamp = Accent-Ramp $accent
  Draw-Glyph $bmp $shape $accentRamp
  # Legendary halo
  if ($rarity -eq 'legendary') { Add-GlowHalo $bmp $ringCol 2 130 }
  elseif ($rarity -eq 'epic') { Add-GlowHalo $bmp $ringCol 2 80 }
}

# ── Manifest loader ───────────────────────────────────────────────
# Reads tools/badge-manifest.json (regenerated from badges-catalog.js)
# so the generator stays in sync with the JS catalogue without
# duplicating the data.

$manifestPath = Join-Path $scriptDir 'badge-manifest.json'
if (-not (Test-Path $manifestPath)) {
  throw "Missing $manifestPath. Run tools/dump-badge-manifest.mjs first."
}
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

Write-Host '── progression badges (64×64) ──' -ForegroundColor Cyan
$count = 0
foreach ($entry in $manifest) {
  if ($Only -and $Only.Count -gt 0 -and -not ($Only -contains $entry.id)) { continue }
  $bmp = New-CanvasFx $BADGE_W $BADGE_H
  Draw-Badge $bmp $entry.id $entry.shape $entry.accent $entry.rarity
  Save-CanvasFx $bmp (Join-Path $badgeDir ("{0}.png" -f $entry.id))
  $count++
  Write-Host ("  {0,-22} {1,-9} {2}" -f $entry.id, $entry.rarity, $entry.shape) -ForegroundColor DarkGray
}
Write-Host ("  badges: {0}" -f $count) -ForegroundColor Green
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "Output: $badgeDir"
