# Pixel-art icon set for OBS overlays.
#
# Replaces emoji used as decoration in aquilo-gg/overlays/ with custom
# 16×16 transparent-background PNG sprites. Same in-house pixel-art bar
# as the Clash / Boltbound / Character systems.
#
# Output: aquilo-gg/sprites/ui/icons/<name>.png  (16×16 transparent)
#
# Naming follows the concept, NOT the original emoji. e.g. flame.png,
# trophy.png, crown.png.
#
# Regenerate from scratch:
#   pwsh -ExecutionPolicy Bypass -File tools/build-ui-icons.ps1
#
# Idempotent — overwrites cleanly.

[CmdletBinding()]
param(
  [string]$OutRoot = ''
)
$ErrorActionPreference = 'Stop'
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $OutRoot) { $OutRoot = Join-Path (Split-Path -Parent $ScriptDir) 'aquilo-gg/sprites' }
. (Join-Path $ScriptDir 'lib-pixel.ps1')

$iconDir = Join-Path $OutRoot 'ui/icons'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

$W = 16; $H = 16

# Color ramps — kept tight, 16×16 doesn't have room for 5-tone gradients.
function Ramp { param([string]$d, [string]$b, [string]$h)
  return @{ deep = (Color-FromHex $d); base = (Color-FromHex $b); high = (Color-FromHex $h) }
}
$YELLOW   = Ramp '#3a2200' '#e0a418' '#fff088'
$ORANGE   = Ramp '#3a0a00' '#e04420' '#ffb060'
$RED      = Ramp '#3a0408' '#c83838' '#ffa0a0'
$BLUE     = Ramp '#0a1838' '#3878d8' '#a0d0f8'
$GREEN    = Ramp '#0a3818' '#388848' '#a0e8a0'
$PURPLE   = Ramp '#10084a' '#6840d8' '#c8a0ff'
$GOLD     = Ramp '#3a2400' '#d09818' '#fff0a8'
$GREY     = Ramp '#181818' '#686868' '#d8d8d8'
$WHITE    = Ramp '#404040' '#c0c0c0' '#ffffff'
$PINK     = Ramp '#380020' '#c060a8' '#ff90e0'
$CYAN     = Ramp '#0a2034' '#3878a8' '#a0e8f0'

function New-Icon { New-CanvasFx $W $H }
function Save-Icon { param($bmp, [string]$name)
  Save-CanvasFx $bmp (Join-Path $iconDir ("{0}.png" -f $name))
}

# ── bolt (lightning bolt — Bolts brand) ──────────────────────────────
function Draw-Bolt {
  $b = New-Icon
  $r = $YELLOW
  # Diagonal zigzag bolt
  $path = @(@(9,1), @(7,3), @(8,5), @(6,6), @(5,8), @(7,8), @(5,10), @(6,12), @(4,14), @(8,9), @(6,9), @(10,4))
  # Outline (deep)
  foreach ($p in $path) { Set-Pixel $b ($p[0] - 1) $p[1] $r.deep; Set-Pixel $b $p[0] ($p[1] + 1) $r.deep }
  # Fill (base)
  Fill-Box $b 8 1 2 1 $r.base
  Fill-Box $b 7 2 2 1 $r.base
  Fill-Box $b 6 3 3 1 $r.base
  Fill-Box $b 5 4 4 1 $r.base
  Fill-Box $b 4 5 5 1 $r.base
  Fill-Box $b 5 6 3 1 $r.base
  Fill-Box $b 6 7 2 1 $r.base
  Fill-Box $b 4 8 4 1 $r.base
  Fill-Box $b 3 9 4 1 $r.base
  Fill-Box $b 3 10 3 1 $r.base
  Fill-Box $b 2 11 3 1 $r.base
  Fill-Box $b 2 12 2 1 $r.base
  Fill-Box $b 1 13 2 1 $r.base
  # Highlights
  Set-Pixel $b 8 1 $r.high
  Set-Pixel $b 7 2 $r.high
  Set-Pixel $b 6 3 $r.high
  Set-Pixel $b 5 4 $r.high
  Set-Pixel $b 4 5 $r.high
  Save-Icon $b 'bolt'
}

# ── flame (streak / fire) ────────────────────────────────────────────
function Draw-Flame {
  $b = New-Icon
  # Two-tone flame: orange body, yellow core
  for ($i = 0; $i -lt 12; $i++) {
    $y = 14 - $i
    $w = if ($i -lt 6) { [Math]::Max(1, [int]([Math]::Round(($i + 1) * 1.0))) }
         else { [Math]::Max(1, [int]([Math]::Round((11 - $i) * 1.4))) }
    $x0 = 8 - [int]($w / 2)
    Fill-Box $b $x0 $y $w 1 $ORANGE.base
    # Outline edges
    Set-Pixel $b $x0 $y $ORANGE.deep
    Set-Pixel $b ($x0 + $w - 1) $y $ORANGE.deep
  }
  # Inner core (yellow)
  for ($i = 2; $i -lt 9; $i++) {
    $y = 14 - $i
    $w = if ($i -lt 5) { 1 } elseif ($i -lt 7) { 2 } else { 1 }
    $x0 = 8 - [int]($w / 2)
    Fill-Box $b $x0 $y $w 1 $YELLOW.base
  }
  # Tip highlight
  Set-Pixel $b 8 3 $YELLOW.high
  Set-Pixel $b 8 4 $YELLOW.high
  Save-Icon $b 'flame'
}

# ── trophy ───────────────────────────────────────────────────────────
function Draw-Trophy {
  $b = New-Icon
  $g = $GOLD
  # Cup body (rounded top)
  Fill-Box $b 4 3 8 1 $g.deep
  Fill-Box $b 3 4 10 5 $g.base
  Fill-Box $b 4 9 8 1 $g.base
  Fill-Box $b 5 10 6 1 $g.deep
  # Cup highlights
  for ($y = 4; $y -lt 9; $y++) { Set-Pixel $b 3 $y $g.deep }
  for ($y = 4; $y -lt 9; $y++) { Set-Pixel $b 12 $y $g.deep }
  Set-Pixel $b 4 4 $g.high
  Set-Pixel $b 5 4 $g.high
  Set-Pixel $b 4 5 $g.high
  # Handles
  Set-Pixel $b 2 5 $g.deep; Set-Pixel $b 2 6 $g.deep; Set-Pixel $b 2 7 $g.deep
  Set-Pixel $b 13 5 $g.deep; Set-Pixel $b 13 6 $g.deep; Set-Pixel $b 13 7 $g.deep
  # Stem + base
  Fill-Box $b 7 11 2 2 $g.deep
  Fill-Box $b 5 13 6 2 $g.base
  Set-Pixel $b 5 13 $g.deep; Set-Pixel $b 10 13 $g.deep
  Save-Icon $b 'trophy'
}

# ── gift (gift box) ──────────────────────────────────────────────────
function Draw-Gift {
  $b = New-Icon
  # Box body (red) with gold ribbon
  Fill-Box $b 2 7 12 7 $RED.base
  Set-Pixel $b 2 7 $RED.deep; Set-Pixel $b 13 7 $RED.deep
  Set-Pixel $b 2 13 $RED.deep; Set-Pixel $b 13 13 $RED.deep
  # Ribbon vertical
  Fill-Box $b 7 7 2 7 $GOLD.base
  # Ribbon horizontal
  Fill-Box $b 2 9 12 2 $GOLD.base
  Set-Pixel $b 7 9 $GOLD.high; Set-Pixel $b 8 9 $GOLD.high
  # Lid
  Fill-Box $b 1 5 14 2 $RED.deep
  # Bow on top
  Set-Pixel $b 6 3 $GOLD.base
  Set-Pixel $b 7 3 $GOLD.base; Set-Pixel $b 8 3 $GOLD.base
  Set-Pixel $b 9 3 $GOLD.base
  Set-Pixel $b 6 4 $GOLD.high
  Set-Pixel $b 9 4 $GOLD.high
  Set-Pixel $b 7 4 $GOLD.deep
  Set-Pixel $b 8 4 $GOLD.deep
  Save-Icon $b 'gift'
}

# ── crown ────────────────────────────────────────────────────────────
function Draw-Crown {
  $b = New-Icon
  $g = $GOLD
  # Three peaks
  Set-Pixel $b 3 4 $g.base; Set-Pixel $b 3 5 $g.base
  Set-Pixel $b 8 3 $g.high; Set-Pixel $b 8 4 $g.base; Set-Pixel $b 8 5 $g.base
  Set-Pixel $b 13 4 $g.base; Set-Pixel $b 13 5 $g.base
  Set-Pixel $b 2 5 $g.deep
  Set-Pixel $b 7 4 $g.deep; Set-Pixel $b 9 4 $g.deep
  Set-Pixel $b 14 5 $g.deep
  # Band
  Fill-Box $b 2 6 13 4 $g.base
  Set-Pixel $b 2 6 $g.deep; Set-Pixel $b 14 6 $g.deep
  Set-Pixel $b 2 9 $g.deep; Set-Pixel $b 14 9 $g.deep
  # Jewels
  Set-Pixel $b 5 7 $RED.base
  Set-Pixel $b 8 7 $BLUE.base
  Set-Pixel $b 11 7 $GREEN.base
  Set-Pixel $b 5 8 $RED.high
  Set-Pixel $b 8 8 $BLUE.high
  Set-Pixel $b 11 8 $GREEN.high
  # Highlight strip
  for ($x = 3; $x -lt 14; $x++) { Set-Pixel $b $x 6 $g.high }
  Save-Icon $b 'crown'
}

# ── shield ───────────────────────────────────────────────────────────
function Draw-Shield {
  $b = New-Icon
  # Outline
  Fill-Box $b 3 2 10 1 $BLUE.deep
  for ($y = 3; $y -lt 10; $y++) { Set-Pixel $b 2 $y $BLUE.deep; Set-Pixel $b 13 $y $BLUE.deep }
  # Body
  Fill-Box $b 3 3 10 7 $BLUE.base
  # Pointed bottom
  Fill-Box $b 4 10 8 1 $BLUE.deep
  Fill-Box $b 5 11 6 1 $BLUE.base
  Fill-Box $b 6 12 4 1 $BLUE.base
  Fill-Box $b 7 13 2 1 $BLUE.deep
  Set-Pixel $b 5 11 $BLUE.deep; Set-Pixel $b 10 11 $BLUE.deep
  Set-Pixel $b 6 12 $BLUE.deep; Set-Pixel $b 9 12 $BLUE.deep
  # Cross emblem
  Fill-Box $b 7 4 2 5 $GOLD.base
  Fill-Box $b 5 5 6 2 $GOLD.base
  Set-Pixel $b 7 4 $GOLD.high; Set-Pixel $b 7 5 $GOLD.high
  # Highlight
  for ($y = 3; $y -lt 9; $y++) { Set-Pixel $b 3 $y $BLUE.high }
  Save-Icon $b 'shield'
}

# ── gem ──────────────────────────────────────────────────────────────
function Draw-Gem {
  $b = New-Icon
  $g = $PINK
  # Diamond shape
  for ($i = 0; $i -lt 6; $i++) {
    $w = ($i + 1) * 2
    $x0 = 8 - $i - 1
    Fill-Box $b $x0 ($i + 2) $w 1 $g.base
    Set-Pixel $b $x0 ($i + 2) $g.deep
    Set-Pixel $b ($x0 + $w - 1) ($i + 2) $g.deep
  }
  # Lower triangle
  for ($i = 0; $i -lt 5; $i++) {
    $w = (5 - $i) * 2
    $x0 = 8 - (5 - $i)
    Fill-Box $b $x0 (8 + $i) $w 1 $g.base
    Set-Pixel $b $x0 (8 + $i) $g.deep
    Set-Pixel $b ($x0 + $w - 1) (8 + $i) $g.deep
  }
  # Facet highlight
  for ($i = 0; $i -lt 5; $i++) {
    Set-Pixel $b (4 + $i) (3 + $i) $g.high
  }
  Save-Icon $b 'gem'
}

# ── sword ────────────────────────────────────────────────────────────
function Draw-Sword {
  $b = New-Icon
  # Blade (vertical, diagonal-ish)
  for ($i = 0; $i -lt 9; $i++) {
    Set-Pixel $b (3 + $i) (10 - $i) $GREY.base
    Set-Pixel $b (4 + $i) (10 - $i) $GREY.high
    Set-Pixel $b (3 + $i) (11 - $i) $GREY.deep
  }
  # Crossguard
  Set-Pixel $b 11 2 $GOLD.base; Set-Pixel $b 12 2 $GOLD.base
  Set-Pixel $b 10 3 $GOLD.base; Set-Pixel $b 11 3 $GOLD.deep
  Set-Pixel $b 9 4 $GOLD.base; Set-Pixel $b 10 4 $GOLD.deep
  # Hilt
  Set-Pixel $b 12 1 $RED.base
  Set-Pixel $b 13 0 $RED.deep
  # Grip
  Fill-Box $b 11 4 2 3 $RED.base
  Set-Pixel $b 11 4 $RED.deep
  # Pommel
  Set-Pixel $b 13 1 $GOLD.high
  Save-Icon $b 'sword'
}

# ── castle (clash town) ──────────────────────────────────────────────
function Draw-Castle {
  $b = New-Icon
  $g = $GREY
  # Battlements top
  Fill-Box $b 2 5 2 2 $g.base
  Fill-Box $b 5 5 2 2 $g.base
  Fill-Box $b 9 5 2 2 $g.base
  Fill-Box $b 12 5 2 2 $g.base
  # Wall body
  Fill-Box $b 2 7 12 6 $g.base
  Set-Pixel $b 2 7 $g.high
  # Outline
  for ($y = 5; $y -lt 13; $y++) { Set-Pixel $b 2 $y $g.deep; Set-Pixel $b 13 $y $g.deep }
  Fill-Box $b 2 13 12 1 $g.deep
  # Door
  Fill-Box $b 7 9 3 4 $YELLOW.deep
  Set-Pixel $b 7 9 (Color-FromHex '#000000')
  Set-Pixel $b 8 9 (Color-FromHex '#000000')
  Set-Pixel $b 9 9 (Color-FromHex '#000000')
  # Windows
  Fill-Box $b 4 8 1 2 $YELLOW.base
  Fill-Box $b 11 8 1 2 $YELLOW.base
  # Flag
  Set-Pixel $b 8 1 $RED.base
  Set-Pixel $b 9 1 $RED.base; Set-Pixel $b 10 1 $RED.base
  Set-Pixel $b 8 2 $RED.deep; Set-Pixel $b 9 2 $RED.deep
  Fill-Box $b 8 3 1 3 $GREY.deep
  Save-Icon $b 'castle'
}

# ── coin (Bolts amount) ──────────────────────────────────────────────
function Draw-Coin {
  $b = New-Icon
  $g = $GOLD
  # Round disc with edge highlights
  Shade-Disc $b 8 8 6 @{ deep=$g.deep; shadow=$g.deep; base=$g.base; high=$g.high; top=$g.high }
  # Inner border ring
  Set-Pixel $b 5 5 $g.deep
  Set-Pixel $b 11 5 $g.deep
  Set-Pixel $b 5 11 $g.deep
  Set-Pixel $b 11 11 $g.deep
  # B mark for Bolts
  Fill-Box $b 7 6 1 5 $g.deep
  Fill-Box $b 8 6 2 1 $g.deep
  Fill-Box $b 8 8 2 1 $g.deep
  Fill-Box $b 8 10 2 1 $g.deep
  Set-Pixel $b 10 7 $g.deep
  Set-Pixel $b 10 9 $g.deep
  Save-Icon $b 'coin'
}

# ── wave (hand wave — welcome) ───────────────────────────────────────
function Draw-Wave {
  $b = New-Icon
  $skin = Ramp '#7a4830' '#e8c098' '#ffeed0'
  # Palm
  Shade-Disc $b 8 9 4 @{ deep=$skin.deep; shadow=$skin.deep; base=$skin.base; high=$skin.high; top=$skin.high }
  # Fingers (4)
  for ($f = 0; $f -lt 4; $f++) {
    $x = 5 + $f * 2
    Fill-Box $b $x 3 1 5 $skin.base
    Set-Pixel $b $x 3 $skin.high
  }
  # Thumb
  Fill-Box $b 11 6 2 3 $skin.base
  # Motion lines (right side)
  Set-Pixel $b 13 3 $YELLOW.base
  Set-Pixel $b 14 4 $YELLOW.base
  Set-Pixel $b 13 5 $YELLOW.base
  Save-Icon $b 'wave'
}

# ── sparkle (return / refresh) ───────────────────────────────────────
function Draw-Sparkle {
  $b = New-Icon
  # 4-pointed star x 2 (large + small)
  $c = $YELLOW
  # Large
  Set-Pixel $b 8 4 $c.high
  Set-Pixel $b 8 5 $c.base
  Set-Pixel $b 8 6 $c.base
  Set-Pixel $b 8 7 $c.high
  Set-Pixel $b 8 8 $c.base
  Set-Pixel $b 8 9 $c.base
  Set-Pixel $b 8 10 $c.high
  Set-Pixel $b 4 7 $c.high
  Set-Pixel $b 5 7 $c.base
  Set-Pixel $b 6 7 $c.base
  Set-Pixel $b 7 7 $c.high
  Set-Pixel $b 9 7 $c.high
  Set-Pixel $b 10 7 $c.base
  Set-Pixel $b 11 7 $c.base
  Set-Pixel $b 12 7 $c.high
  # Small sparkle top-left
  Set-Pixel $b 2 2 $c.high
  Set-Pixel $b 2 3 $c.base
  Set-Pixel $b 2 4 $c.high
  Set-Pixel $b 1 3 $c.high
  Set-Pixel $b 3 3 $c.high
  # Small sparkle bottom-right
  Set-Pixel $b 13 12 $c.high
  Set-Pixel $b 13 13 $c.base
  Set-Pixel $b 13 14 $c.high
  Set-Pixel $b 12 13 $c.high
  Set-Pixel $b 14 13 $c.high
  Save-Icon $b 'sparkle'
}

# ── bomb (raid sacked / explosion) ───────────────────────────────────
function Draw-Bomb {
  $b = New-Icon
  # Burst star — 6-point
  $c = $ORANGE
  for ($i = 0; $i -lt 8; $i++) {
    $ang = $i * ([Math]::PI / 4)
    $x = [int]([Math]::Round(8 + [Math]::Cos($ang) * 6))
    $y = [int]([Math]::Round(8 + [Math]::Sin($ang) * 6))
    Set-Pixel $b $x $y $c.deep
    $xN = [int]([Math]::Round(8 + [Math]::Cos($ang) * 4))
    $yN = [int]([Math]::Round(8 + [Math]::Sin($ang) * 4))
    Line-Pixel $b 8 8 $xN $yN $c.base
  }
  # Core
  Shade-Disc $b 8 8 3 @{ deep=$RED.deep; shadow=$RED.base; base=$RED.base; high=$YELLOW.high; top=$YELLOW.high }
  Set-Pixel $b 8 8 $YELLOW.high
  Save-Icon $b 'bomb'
}

# ── star (generic accent) ────────────────────────────────────────────
function Draw-Star {
  $b = New-Icon
  $c = $YELLOW
  # 5-point star
  for ($i = 0; $i -lt 5; $i++) {
    $ang = -[Math]::PI / 2 + $i * (2 * [Math]::PI / 5)
    $x = [int]([Math]::Round(8 + [Math]::Cos($ang) * 6))
    $y = [int]([Math]::Round(8 + [Math]::Sin($ang) * 6))
    $angN = -[Math]::PI / 2 + (($i + 2) % 5) * (2 * [Math]::PI / 5)
    $xN = [int]([Math]::Round(8 + [Math]::Cos($angN) * 6))
    $yN = [int]([Math]::Round(8 + [Math]::Sin($angN) * 6))
    Line-Pixel $b $x $y $xN $yN $c.base
  }
  # Inner fill (rough)
  Fill-Box $b 6 7 5 3 $c.base
  Set-Pixel $b 7 6 $c.base; Set-Pixel $b 8 6 $c.base; Set-Pixel $b 9 6 $c.base
  Set-Pixel $b 8 8 $c.high
  Save-Icon $b 'star'
}

# ── heart (love / streak) ────────────────────────────────────────────
function Draw-Heart {
  $b = New-Icon
  $c = $PINK
  # Two lobes
  Shade-Disc $b 6 6 3 @{ deep=$c.deep; shadow=$c.deep; base=$c.base; high=$c.high; top=$c.high }
  Shade-Disc $b 10 6 3 @{ deep=$c.deep; shadow=$c.deep; base=$c.base; high=$c.high; top=$c.high }
  # V bottom
  for ($i = 0; $i -lt 6; $i++) {
    $w = 11 - $i * 2
    if ($w -lt 1) { break }
    $x0 = 8 - [int]($w / 2)
    Fill-Box $b $x0 (7 + $i) $w 1 $c.base
    Set-Pixel $b $x0 (7 + $i) $c.deep
    Set-Pixel $b ($x0 + $w - 1) (7 + $i) $c.deep
  }
  # Highlight
  Set-Pixel $b 5 5 $c.high
  Set-Pixel $b 9 5 $c.high
  Save-Icon $b 'heart'
}

# ── checkmark (check-in confirmation) ────────────────────────────────
function Draw-Check {
  $b = New-Icon
  $c = $GREEN
  # Tick shape
  Set-Pixel $b 3 8 $c.deep; Set-Pixel $b 3 9 $c.deep
  Set-Pixel $b 4 9 $c.base; Set-Pixel $b 4 10 $c.base
  Set-Pixel $b 5 10 $c.base; Set-Pixel $b 5 11 $c.base
  Set-Pixel $b 6 11 $c.base; Set-Pixel $b 6 12 $c.deep
  Set-Pixel $b 7 10 $c.base
  Set-Pixel $b 8 9 $c.base
  Set-Pixel $b 9 8 $c.base
  Set-Pixel $b 10 7 $c.base
  Set-Pixel $b 11 6 $c.base
  Set-Pixel $b 12 5 $c.base
  Set-Pixel $b 13 4 $c.deep
  # Highlight
  Set-Pixel $b 7 11 $c.high
  Set-Pixel $b 8 10 $c.high
  Set-Pixel $b 9 9 $c.high
  Set-Pixel $b 10 8 $c.high
  Set-Pixel $b 11 7 $c.high
  Save-Icon $b 'check'
}

# ── camera (clip) ────────────────────────────────────────────────────
function Draw-Camera {
  $b = New-Icon
  # Camera body
  Fill-Box $b 2 6 12 7 $GREY.base
  Set-Pixel $b 2 6 $GREY.deep; Set-Pixel $b 13 6 $GREY.deep
  Set-Pixel $b 2 12 $GREY.deep; Set-Pixel $b 13 12 $GREY.deep
  # Lens
  Shade-Disc $b 8 9 3 @{ deep=$GREY.deep; shadow=$GREY.deep; base=$GREY.base; high=$WHITE.high; top=$WHITE.high }
  Set-Pixel $b 8 9 $WHITE.high
  # Top bump
  Fill-Box $b 6 4 4 2 $GREY.base
  Set-Pixel $b 6 4 $GREY.deep; Set-Pixel $b 9 4 $GREY.deep
  # Record dot
  Set-Pixel $b 12 7 $RED.high
  Save-Icon $b 'camera'
}

# ── swirl (voltaic / sparkle vortex) ─────────────────────────────────
function Draw-Swirl {
  $b = New-Icon
  $c = $PURPLE
  # Two-arm spiral
  for ($i = 0; $i -lt 16; $i++) {
    $ang = $i * 0.6
    $r = 0.5 + $i * 0.4
    $x = [int]([Math]::Round(8 + [Math]::Cos($ang) * $r))
    $y = [int]([Math]::Round(8 + [Math]::Sin($ang) * $r))
    Set-Pixel $b $x $y $c.base
  }
  for ($i = 0; $i -lt 16; $i++) {
    $ang = ($i * 0.6) + [Math]::PI
    $r = 0.5 + $i * 0.4
    $x = [int]([Math]::Round(8 + [Math]::Cos($ang) * $r))
    $y = [int]([Math]::Round(8 + [Math]::Sin($ang) * $r))
    Set-Pixel $b $x $y $c.high
  }
  Set-Pixel $b 8 8 $c.high
  Save-Icon $b 'swirl'
}

# ── train (hype train) ───────────────────────────────────────────────
function Draw-Train {
  $b = New-Icon
  # Engine body
  Fill-Box $b 2 7 8 5 $RED.base
  Set-Pixel $b 2 7 $RED.deep; Set-Pixel $b 9 7 $RED.deep
  Set-Pixel $b 2 11 $RED.deep; Set-Pixel $b 9 11 $RED.deep
  # Boiler front
  Shade-Disc $b 11 9 2 @{ deep=$GREY.deep; shadow=$GREY.deep; base=$GREY.base; high=$WHITE.high; top=$WHITE.high }
  # Wheels
  Set-Pixel $b 3 12 $GREY.deep; Set-Pixel $b 4 12 $GREY.deep
  Set-Pixel $b 6 12 $GREY.deep; Set-Pixel $b 7 12 $GREY.deep
  Set-Pixel $b 11 12 $GREY.deep
  # Smoke stack
  Fill-Box $b 5 4 2 4 $GREY.base
  # Smoke puffs
  Set-Pixel $b 4 3 $WHITE.high
  Set-Pixel $b 6 2 $WHITE.high
  Set-Pixel $b 7 3 $WHITE.high
  # Light highlight
  Set-Pixel $b 3 8 $RED.high
  Save-Icon $b 'train'
}

# ── chat (message) ───────────────────────────────────────────────────
function Draw-Chat {
  $b = New-Icon
  # Speech bubble
  Fill-Box $b 2 4 12 7 $WHITE.base
  Set-Pixel $b 2 4 $WHITE.deep; Set-Pixel $b 13 4 $WHITE.deep
  Set-Pixel $b 2 10 $WHITE.deep; Set-Pixel $b 13 10 $WHITE.deep
  for ($y = 5; $y -lt 10; $y++) { Set-Pixel $b 2 $y $WHITE.deep; Set-Pixel $b 13 $y $WHITE.deep }
  for ($x = 3; $x -lt 13; $x++) { Set-Pixel $b $x 4 $WHITE.deep; Set-Pixel $b $x 10 $WHITE.deep }
  # Tail
  Set-Pixel $b 4 11 $WHITE.base; Set-Pixel $b 5 11 $WHITE.base
  Set-Pixel $b 4 11 $WHITE.deep; Set-Pixel $b 5 11 $WHITE.deep
  Set-Pixel $b 4 12 $WHITE.deep
  # Dots
  Set-Pixel $b 5 7 $GREY.deep
  Set-Pixel $b 7 7 $GREY.deep
  Set-Pixel $b 9 7 $GREY.deep
  Save-Icon $b 'chat'
}

# ── target (raid result) ─────────────────────────────────────────────
function Draw-Target {
  $b = New-Icon
  # Concentric rings
  Shade-Disc $b 8 8 6 @{ deep=$RED.deep; shadow=$RED.deep; base=$RED.base; high=$WHITE.high; top=$WHITE.high }
  Shade-Disc $b 8 8 4 @{ deep=$WHITE.deep; shadow=$WHITE.base; base=$WHITE.base; high=$RED.high; top=$RED.high }
  Shade-Disc $b 8 8 2 @{ deep=$RED.deep; shadow=$RED.deep; base=$RED.base; high=$RED.high; top=$RED.high }
  Set-Pixel $b 8 8 $YELLOW.high
  Save-Icon $b 'target'
}

# ── music (now-playing) ──────────────────────────────────────────────
function Draw-Music {
  $b = New-Icon
  # Eighth note
  Fill-Box $b 4 11 3 3 $PURPLE.base
  Set-Pixel $b 4 11 $PURPLE.deep; Set-Pixel $b 6 11 $PURPLE.deep
  Set-Pixel $b 4 13 $PURPLE.deep; Set-Pixel $b 6 13 $PURPLE.deep
  # Stem
  Fill-Box $b 7 4 1 8 $PURPLE.base
  # Flag
  Fill-Box $b 8 4 4 1 $PURPLE.base
  Fill-Box $b 11 5 1 3 $PURPLE.base
  Set-Pixel $b 8 5 $PURPLE.base
  Save-Icon $b 'music'
}

# ── construction (build) ─────────────────────────────────────────────
function Draw-Construction {
  $b = New-Icon
  # Crane base
  Fill-Box $b 3 12 4 2 $GREY.deep
  # Vertical mast
  Fill-Box $b 4 4 2 8 $YELLOW.base
  Set-Pixel $b 4 4 $YELLOW.deep; Set-Pixel $b 5 4 $YELLOW.deep
  # Horizontal jib
  Fill-Box $b 5 4 8 1 $YELLOW.base
  Set-Pixel $b 12 4 $YELLOW.deep
  # Hook line
  Fill-Box $b 11 5 1 4 $GREY.deep
  # Hook
  Set-Pixel $b 11 9 $GREY.base
  Set-Pixel $b 12 9 $GREY.base
  Save-Icon $b 'construction'
}

# ── skull (defeat / sacked) ──────────────────────────────────────────
function Draw-Skull {
  $b = New-Icon
  # Cranium
  Shade-Disc $b 8 6 4 @{ deep=$WHITE.deep; shadow=$WHITE.deep; base=$WHITE.base; high=$WHITE.high; top=$WHITE.high }
  # Eye sockets
  Set-Pixel $b 6 6 (Color-FromHex '#000000'); Set-Pixel $b 6 7 (Color-FromHex '#000000')
  Set-Pixel $b 9 6 (Color-FromHex '#000000'); Set-Pixel $b 9 7 (Color-FromHex '#000000')
  # Nose
  Set-Pixel $b 8 9 $WHITE.deep
  # Jaw
  Fill-Box $b 5 10 7 3 $WHITE.base
  Set-Pixel $b 5 10 $WHITE.deep; Set-Pixel $b 11 10 $WHITE.deep
  Set-Pixel $b 5 12 $WHITE.deep; Set-Pixel $b 11 12 $WHITE.deep
  # Teeth
  Set-Pixel $b 6 11 $WHITE.deep; Set-Pixel $b 7 11 $WHITE.deep; Set-Pixel $b 8 11 $WHITE.deep
  Set-Pixel $b 9 11 $WHITE.deep; Set-Pixel $b 10 11 $WHITE.deep
  Save-Icon $b 'skull'
}

# ── id-card (profile) ────────────────────────────────────────────────
function Draw-Id {
  $b = New-Icon
  # Card frame
  Fill-Box $b 2 3 12 10 $BLUE.base
  Set-Pixel $b 2 3 $BLUE.deep; Set-Pixel $b 13 3 $BLUE.deep
  Set-Pixel $b 2 12 $BLUE.deep; Set-Pixel $b 13 12 $BLUE.deep
  # Photo area
  Fill-Box $b 3 4 4 5 $GREY.base
  Set-Pixel $b 5 6 $YELLOW.high
  # Lines (text)
  Fill-Box $b 8 5 5 1 $WHITE.base
  Fill-Box $b 8 7 5 1 $WHITE.base
  Fill-Box $b 8 9 5 1 $WHITE.base
  Save-Icon $b 'id'
}

# ── droplet (rain) ───────────────────────────────────────────────────
function Draw-Droplet {
  $b = New-Icon
  # Teardrop
  Set-Pixel $b 8 3 $BLUE.high
  Fill-Box $b 7 4 2 1 $BLUE.base
  Fill-Box $b 6 5 4 1 $BLUE.base
  Fill-Box $b 6 6 4 1 $BLUE.base
  Fill-Box $b 5 7 6 1 $BLUE.base
  Fill-Box $b 5 8 6 1 $BLUE.base
  Fill-Box $b 5 9 6 1 $BLUE.base
  Fill-Box $b 6 10 4 1 $BLUE.base
  Fill-Box $b 6 11 4 1 $BLUE.base
  Fill-Box $b 7 12 2 1 $BLUE.deep
  # Edges
  Set-Pixel $b 5 7 $BLUE.deep; Set-Pixel $b 10 7 $BLUE.deep
  Set-Pixel $b 5 10 $BLUE.deep; Set-Pixel $b 10 10 $BLUE.deep
  # Highlight
  Set-Pixel $b 7 6 $BLUE.high
  Set-Pixel $b 6 8 $BLUE.high
  Save-Icon $b 'droplet'
}

# ── plus (info) ──────────────────────────────────────────────────────
function Draw-Plus {
  $b = New-Icon
  Fill-Box $b 6 2 4 12 $GREEN.base
  Fill-Box $b 2 6 12 4 $GREEN.base
  # Outline
  for ($y = 2; $y -lt 14; $y++) { Set-Pixel $b 5 $y $GREEN.deep; Set-Pixel $b 10 $y $GREEN.deep }
  for ($x = 2; $x -lt 14; $x++) { Set-Pixel $b $x 5 $GREEN.deep; Set-Pixel $b $x 10 $GREEN.deep }
  # Highlight
  Set-Pixel $b 6 2 $GREEN.high
  Save-Icon $b 'plus'
}

# ── alert (warning / lose) ───────────────────────────────────────────
function Draw-Alert {
  $b = New-Icon
  # Triangle
  for ($i = 0; $i -lt 11; $i++) {
    $w = $i + 1
    $x0 = 8 - [int]($w / 2)
    Fill-Box $b $x0 (3 + $i) $w 1 $RED.base
    Set-Pixel $b $x0 (3 + $i) $RED.deep
    Set-Pixel $b ($x0 + $w - 1) (3 + $i) $RED.deep
  }
  # Exclamation
  Fill-Box $b 7 5 2 5 $YELLOW.high
  Fill-Box $b 7 11 2 1 $YELLOW.high
  Save-Icon $b 'alert'
}

# ── dice (random) ────────────────────────────────────────────────────
function Draw-Dice {
  $b = New-Icon
  # Cube
  Fill-Box $b 3 3 10 10 $WHITE.base
  Set-Pixel $b 3 3 $WHITE.deep; Set-Pixel $b 12 3 $WHITE.deep
  Set-Pixel $b 3 12 $WHITE.deep; Set-Pixel $b 12 12 $WHITE.deep
  for ($x = 4; $x -lt 12; $x++) { Set-Pixel $b $x 3 $WHITE.deep; Set-Pixel $b $x 12 $WHITE.deep }
  for ($y = 4; $y -lt 12; $y++) { Set-Pixel $b 3 $y $WHITE.deep; Set-Pixel $b 12 $y $WHITE.deep }
  # Pips (5)
  Set-Pixel $b 5 5 (Color-FromHex '#000000'); Set-Pixel $b 6 5 (Color-FromHex '#000000')
  Set-Pixel $b 5 6 (Color-FromHex '#000000'); Set-Pixel $b 6 6 (Color-FromHex '#000000')
  Set-Pixel $b 9 5 (Color-FromHex '#000000'); Set-Pixel $b 10 5 (Color-FromHex '#000000')
  Set-Pixel $b 9 6 (Color-FromHex '#000000'); Set-Pixel $b 10 6 (Color-FromHex '#000000')
  Set-Pixel $b 7 8 (Color-FromHex '#000000'); Set-Pixel $b 8 8 (Color-FromHex '#000000')
  Set-Pixel $b 7 9 (Color-FromHex '#000000'); Set-Pixel $b 8 9 (Color-FromHex '#000000')
  Set-Pixel $b 5 10 (Color-FromHex '#000000'); Set-Pixel $b 6 10 (Color-FromHex '#000000')
  Set-Pixel $b 5 11 (Color-FromHex '#000000'); Set-Pixel $b 6 11 (Color-FromHex '#000000')
  Set-Pixel $b 9 10 (Color-FromHex '#000000'); Set-Pixel $b 10 10 (Color-FromHex '#000000')
  Set-Pixel $b 9 11 (Color-FromHex '#000000'); Set-Pixel $b 10 11 (Color-FromHex '#000000')
  Save-Icon $b 'dice'
}

# ── Main ────────────────────────────────────────────────────────────

# ── rock / paper / scissors (minigame RPS) ──────────────────────────
function Draw-Rock {
  $b = New-Icon
  $g = $GREY
  Shade-Disc $b 8 9 6 @{ deep=$g.deep; shadow=$g.deep; base=$g.base; high=$g.high; top=$g.high }
  # Cracks / texture
  Set-Pixel $b 5 7 $g.deep; Set-Pixel $b 6 8 $g.deep
  Set-Pixel $b 10 10 $g.deep; Set-Pixel $b 11 11 $g.deep
  Save-Icon $b 'rock'
}
function Draw-Paper {
  $b = New-Icon
  # Folded page
  Fill-Box $b 3 3 10 11 $WHITE.base
  for ($y = 3; $y -lt 14; $y++) { Set-Pixel $b 3 $y $WHITE.deep; Set-Pixel $b 12 $y $WHITE.deep }
  for ($x = 3; $x -lt 13; $x++) { Set-Pixel $b $x 3 $WHITE.deep; Set-Pixel $b $x 13 $WHITE.deep }
  # Lines (text)
  Fill-Box $b 5 6 7 1 $GREY.deep
  Fill-Box $b 5 9 7 1 $GREY.deep
  Fill-Box $b 5 12 4 1 $GREY.deep
  # Folded corner
  Set-Pixel $b 11 3 $GREY.deep
  Set-Pixel $b 12 4 $GREY.deep
  Save-Icon $b 'paper'
}
function Draw-Scissors {
  $b = New-Icon
  # X-cross blades
  $s = $GREY
  Line-Pixel $b 3 3 12 12 $s.base
  Line-Pixel $b 12 3 3 12 $s.base
  Line-Pixel $b 4 3 13 12 $s.high
  Line-Pixel $b 13 3 4 12 $s.high
  # Finger loops
  Shade-Disc $b 4 13 2 @{ deep=$BLUE.deep; shadow=$BLUE.deep; base=$BLUE.base; high=$BLUE.high; top=$BLUE.high }
  Shade-Disc $b 12 13 2 @{ deep=$RED.deep; shadow=$RED.deep; base=$RED.base; high=$RED.high; top=$RED.high }
  # Pivot pin
  Set-Pixel $b 7 7 $YELLOW.high
  Set-Pixel $b 8 8 $YELLOW.high
  Save-Icon $b 'scissors'
}

Draw-Rock
Draw-Paper
Draw-Scissors
Draw-Bolt
Draw-Flame
Draw-Trophy
Draw-Gift
Draw-Crown
Draw-Shield
Draw-Gem
Draw-Sword
Draw-Castle
Draw-Coin
Draw-Wave
Draw-Sparkle
Draw-Bomb
Draw-Star
Draw-Heart
Draw-Check
Draw-Camera
Draw-Swirl
Draw-Train
Draw-Chat
Draw-Target
Draw-Music
Draw-Construction
Draw-Skull
Draw-Id
Draw-Droplet
Draw-Plus
Draw-Alert
Draw-Dice

$count = (Get-ChildItem $iconDir -Filter *.png).Count
Write-Host ("UI icons generated: {0} at {1}" -f $count, $iconDir) -ForegroundColor Green
