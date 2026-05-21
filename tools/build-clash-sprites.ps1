# Procedural pixel-art sprite generator for the Clash building +
# troop roster. Same in-house GDI+ pipeline pattern as the character/
# gear art on the character branch — kept self-contained here so the
# Clash work deploys independently.
#
# Per Clay (2026-05-20): every Clash building kind + every troop
# (personal + garrison) gets a custom pixel-art sprite; visual detail
# scales with building level / troop tier. No re-used textures. The
# current text-label badges (TH, WALL, CAN, etc.) in panel / web /
# OBS renderers get replaced with these sprite IDs.
#
# Output paths (committed to git):
#   aquilo-gg/sprites/clash/buildings/<kind>-L<level>.png
#   aquilo-gg/sprites/clash/troops/<troopId>.png
#
# Canvas:
#   buildings = 32x32 (footprint anchored to bottom-centre)
#   troops    = 24x24 (footprint anchored to bottom-centre)
#
# Regenerate from scratch:
#   pwsh -ExecutionPolicy Bypass -File tools/build-clash-sprites.ps1
#
# This script is self-contained; it does NOT import any helpers from
# tools/build-sprites.ps1 (which lives only on the character branch).
# When that branch merges, the two scripts coexist; we can refactor
# the shared helpers into a tools/lib-pixel.ps1 then.

[CmdletBinding()]
param(
  [string]$OutRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'aquilo-gg/sprites')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# ── Paths ──────────────────────────────────────────────────────────
$clashDir    = Join-Path $OutRoot 'clash'
$buildingDir = Join-Path $clashDir 'buildings'
$troopDir    = Join-Path $clashDir 'troops'
foreach ($d in @($clashDir, $buildingDir, $troopDir)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# ── Brand palette ──────────────────────────────────────────────────
# Same locked-in colours as the character system, so the two rosters
# read as a coherent universe.
$BRAND = @{
  Violet    = [System.Drawing.Color]::FromArgb(255, 0x7c, 0x5c, 0xff);
  VioletHi  = [System.Drawing.Color]::FromArgb(255, 0x9a, 0x82, 0xff);
  VioletDk  = [System.Drawing.Color]::FromArgb(255, 0x5a, 0x40, 0xb0);
  Green     = [System.Drawing.Color]::FromArgb(255, 0x5b, 0xff, 0x95);
  Teal      = [System.Drawing.Color]::FromArgb(255, 0x6e, 0xe0, 0xc0);
  Gold      = [System.Drawing.Color]::FromArgb(255, 0xf0, 0xb4, 0x29);
  GoldHi    = [System.Drawing.Color]::FromArgb(255, 0xff, 0xf0, 0xa0);
  Crimson   = [System.Drawing.Color]::FromArgb(255, 0xf8, 0x51, 0x49);
  Ink       = [System.Drawing.Color]::FromArgb(255, 0x0a, 0x0b, 0x12);
  InkSoft   = [System.Drawing.Color]::FromArgb(255, 0x1c, 0x20, 0x34);
  Steel     = [System.Drawing.Color]::FromArgb(255, 0x4a, 0x52, 0x68);
  SteelHi   = [System.Drawing.Color]::FromArgb(255, 0x7a, 0x85, 0xa3);
  SteelDk   = [System.Drawing.Color]::FromArgb(255, 0x2a, 0x30, 0x44);
  Stone     = [System.Drawing.Color]::FromArgb(255, 0x9b, 0xa3, 0xb5);
  StoneHi   = [System.Drawing.Color]::FromArgb(255, 0xc4, 0xca, 0xd6);
  StoneDk   = [System.Drawing.Color]::FromArgb(255, 0x6a, 0x70, 0x80);
  Wood      = [System.Drawing.Color]::FromArgb(255, 0x6b, 0x47, 0x2b);
  WoodHi    = [System.Drawing.Color]::FromArgb(255, 0xa6, 0x7a, 0x4f);
  WoodDk    = [System.Drawing.Color]::FromArgb(255, 0x3a, 0x26, 0x18);
  Leather   = [System.Drawing.Color]::FromArgb(255, 0x5a, 0x3a, 0x22);
  LeatherHi = [System.Drawing.Color]::FromArgb(255, 0x8c, 0x5d, 0x37);
  Cloth     = [System.Drawing.Color]::FromArgb(255, 0xb7, 0xbc, 0xc8);
  ClothDk   = [System.Drawing.Color]::FromArgb(255, 0x70, 0x76, 0x86);
  Skin      = [System.Drawing.Color]::FromArgb(255, 0xe7, 0xc2, 0x99);
  SkinDk    = [System.Drawing.Color]::FromArgb(255, 0xb6, 0x8b, 0x66);
}

function Color-FromHex {
  param([string]$h)
  $h = $h.TrimStart('#')
  $r = [Convert]::ToInt32($h.Substring(0,2), 16)
  $g = [Convert]::ToInt32($h.Substring(2,2), 16)
  $b = [Convert]::ToInt32($h.Substring(4,2), 16)
  return [System.Drawing.Color]::FromArgb(255, $r, $g, $b)
}

# ── Bitmap helpers (bounds-check via the bitmap's own dims so we can
#    use multiple canvas sizes in the same script) ──────────────────
function New-Canvas {
  param([int]$w, [int]$h)
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    }
  }
  return $bmp
}

function Save-Canvas {
  param($bmp, [string]$path)
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Set-Px {
  param($bmp, [int]$x, [int]$y, $color)
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $bmp.Width -or $y -ge $bmp.Height) { return }
  $bmp.SetPixel($x, $y, $color)
}

function Fill-Rect {
  param($bmp, [int]$x, [int]$y, [int]$w, [int]$h, $color)
  for ($yy = $y; $yy -lt ($y + $h); $yy++) {
    for ($xx = $x; $xx -lt ($x + $w); $xx++) {
      Set-Px $bmp $xx $yy $color
    }
  }
}

function Stroke-Rect {
  param($bmp, [int]$x, [int]$y, [int]$w, [int]$h, $stroke, $fill = $null)
  if ($fill) { Fill-Rect $bmp $x $y $w $h $fill }
  for ($i = 0; $i -lt $w; $i++) {
    Set-Px $bmp ($x + $i) $y $stroke
    Set-Px $bmp ($x + $i) ($y + $h - 1) $stroke
  }
  for ($i = 0; $i -lt $h; $i++) {
    Set-Px $bmp $x ($y + $i) $stroke
    Set-Px $bmp ($x + $w - 1) ($y + $i) $stroke
  }
}

function Draw-Line {
  param($bmp, [int]$x0, [int]$y0, [int]$x1, [int]$y1, $color)
  $dx = [Math]::Abs($x1 - $x0); $dy = [Math]::Abs($y1 - $y0)
  $sx = if ($x0 -lt $x1) { 1 } else { -1 }
  $sy = if ($y0 -lt $y1) { 1 } else { -1 }
  $err = $dx - $dy
  while ($true) {
    Set-Px $bmp $x0 $y0 $color
    if ($x0 -eq $x1 -and $y0 -eq $y1) { break }
    $e2 = 2 * $err
    if ($e2 -gt -$dy) { $err -= $dy; $x0 += $sx }
    if ($e2 -lt  $dx) { $err += $dx; $y0 += $sy }
  }
}

# ── Deterministic per-name RNG ─────────────────────────────────────
$script:RNG_STATE = 1
function Get-NameSeed {
  param([string]$name)
  $h = 5381
  foreach ($c in $name.GetEnumerator()) {
    $h = (($h * 33) + [int][char]$c) -band 0x7fffffff
  }
  return $h
}
function RngInit { param([string]$name) $script:RNG_STATE = (Get-NameSeed $name) -bor 1 }
function RngPick {
  param([int]$mod)
  $script:RNG_STATE = (($script:RNG_STATE * 1103515245) + 12345) -band 0x7fffffff
  if ($mod -le 1) { return 0 }
  return $script:RNG_STATE % $mod
}

# ── Building draws ────────────────────────────────────────────────
#
# Buildings render onto a 32×32 canvas. The base footprint anchors
# to the bottom centre (the "ground line" is row 30, so y=31 is the
# faint shadow row beneath). Higher levels add more detail: extra
# crenellations, banners, embellishments, halo glows. Per Clay each
# upgrade tier should read distinctly even at thumbnail size.

$BUILDING_W = 32
$BUILDING_H = 32

# Tier 1 = level 1; Tier 2 = mid level; Tier 3 = max level. Builders
# multiply detail steps by this index, plus all visible thresholds
# inside the draw function compare against `$detail` directly.
function Detail-Level {
  param([int]$level, [int]$maxLevel)
  # Three buckets — early/mid/late — each scaling visible flair.
  # Returns 1..maxLevel-clamped detail index used for thresholding.
  if ($level -le 1) { return 0 }
  if ($maxLevel -le 3) { return [Math]::Min(2, $level - 1) }
  $third = [Math]::Max(1, [int]($maxLevel / 3))
  if ($level -le $third)         { return 1 }
  if ($level -le ($third * 2))   { return 2 }
  return 3
}

# Ground shadow row — a soft ellipse so the building reads as
# resting on terrain rather than floating.
function Draw-GroundShadow {
  param($bmp, [int]$cx, [int]$y, [int]$halfW)
  $shadow = [System.Drawing.Color]::FromArgb(120, 0x05, 0x05, 0x0a)
  for ($i = -$halfW; $i -le $halfW; $i++) {
    Set-Px $bmp ($cx + $i) $y $shadow
  }
  Set-Px $bmp ($cx - $halfW + 1) ($y - 1) $shadow
  Set-Px $bmp ($cx + $halfW - 1) ($y - 1) $shadow
}

# ── Town Hall (levels 1..10) ──────────────────────────────────────
function Draw-Building-TownHall {
  param($bmp, [int]$level)
  RngInit "townhall-$level"
  $detail = Detail-Level $level 10

  $cx = 16
  Draw-GroundShadow $bmp $cx 30 9

  # Base / footprint widens at higher TH tiers
  $baseW = 14
  if ($detail -ge 2) { $baseW = 16 }
  if ($detail -ge 3) { $baseW = 18 }
  $baseH = 10
  if ($detail -ge 2) { $baseH = 12 }
  $baseX = $cx - [int]($baseW / 2)
  $baseY = 30 - $baseH

  # Stone walls
  Fill-Rect $bmp $baseX $baseY $baseW $baseH $BRAND.Stone
  # Highlight column on the left
  Fill-Rect $bmp $baseX $baseY 1 $baseH $BRAND.StoneHi
  Fill-Rect $bmp ($baseX + $baseW - 1) $baseY 1 $baseH $BRAND.StoneDk
  # Brick courses — horizontal lines every 3 rows
  for ($y = $baseY + 2; $y -lt ($baseY + $baseH - 1); $y += 3) {
    for ($x = $baseX; $x -lt ($baseX + $baseW); $x++) {
      Set-Px $bmp $x $y $BRAND.StoneDk
    }
  }

  # Door / gate — central, wider at higher levels
  $doorW = 4
  if ($detail -ge 2) { $doorW = 5 }
  if ($detail -ge 3) { $doorW = 6 }
  $doorH = 5
  if ($detail -ge 2) { $doorH = 6 }
  $doorX = $cx - [int]($doorW / 2)
  $doorY = 30 - $doorH
  Fill-Rect $bmp $doorX $doorY $doorW $doorH $BRAND.WoodDk
  # Reinforcing band
  Fill-Rect $bmp $doorX ($doorY + [int]($doorH / 2)) $doorW 1 $BRAND.Gold
  if ($detail -ge 2) {
    # Arch over the door
    Set-Px $bmp $doorX ($doorY - 1) $BRAND.Stone
    Set-Px $bmp ($doorX + $doorW - 1) ($doorY - 1) $BRAND.Stone
    for ($x = ($doorX + 1); $x -lt ($doorX + $doorW - 1); $x++) {
      Set-Px $bmp $x ($doorY - 1) $BRAND.StoneHi
    }
  }

  # Roof — a stepped crenellated top. Number of merlons (battlement
  # teeth) scales with TH tier.
  $roofY = $baseY - 1
  $merlonCount = 3
  if ($detail -ge 2) { $merlonCount = 4 }
  if ($detail -ge 3) { $merlonCount = 5 }
  $merlonStep = [int]($baseW / ($merlonCount * 2 - 1))
  for ($i = 0; $i -lt $merlonCount; $i++) {
    $mx = $baseX + ($i * 2 * $merlonStep)
    Fill-Rect $bmp $mx $roofY $merlonStep 1 $BRAND.Stone
  }

  # Central tower — taller at higher tiers
  $towerW = 6
  if ($detail -ge 2) { $towerW = 7 }
  $towerH = 5
  if ($detail -ge 2) { $towerH = 7 }
  if ($detail -ge 3) { $towerH = 9 }
  $towerX = $cx - [int]($towerW / 2)
  $towerY = $baseY - $towerH
  Fill-Rect $bmp $towerX $towerY $towerW $towerH $BRAND.Stone
  Fill-Rect $bmp $towerX $towerY 1 $towerH $BRAND.StoneHi
  Fill-Rect $bmp ($towerX + $towerW - 1) $towerY 1 $towerH $BRAND.StoneDk
  # Tower window
  $winY = $towerY + 2
  if ($detail -ge 2) { $winY = $towerY + 3 }
  Set-Px $bmp $cx $winY $BRAND.Gold
  Set-Px $bmp ($cx - 1) $winY $BRAND.WoodDk
  Set-Px $bmp ($cx + 1) $winY $BRAND.WoodDk

  # Roof cap — pointed pennant
  $capY = $towerY - 1
  if ($detail -ge 1) {
    Fill-Rect $bmp ($cx - 1) $capY 3 1 $BRAND.Violet
    Set-Px $bmp $cx ($capY - 1) $BRAND.Violet
  }
  # Pennant flag (mid-tier+)
  if ($detail -ge 2) {
    Set-Px $bmp ($cx - 2) ($capY - 1) $BRAND.Crimson
    Set-Px $bmp ($cx - 3) ($capY - 1) $BRAND.Crimson
    Set-Px $bmp ($cx - 2) $capY $BRAND.Crimson
  }
  # Gold finial (max tier)
  if ($detail -ge 3) {
    Set-Px $bmp $cx ($capY - 2) $BRAND.Gold
    Set-Px $bmp $cx ($capY - 3) $BRAND.GoldHi
  }

  # Side flanking towers (epic tier only)
  if ($detail -ge 3) {
    foreach ($dir in @(-1, 1)) {
      $sx = $cx + ($dir * ([int]($baseW / 2) - 1))
      $stH = 4
      Fill-Rect $bmp ($sx - 1) ($baseY - $stH) 2 $stH $BRAND.Stone
      Set-Px $bmp ($sx - 1) ($baseY - $stH) $BRAND.StoneHi
      Set-Px $bmp ($sx + 1) ($baseY - $stH) $BRAND.StoneDk
      # Tiny battlement cap
      Set-Px $bmp ($sx - 1) ($baseY - $stH - 1) $BRAND.Stone
      Set-Px $bmp ($sx + 1) ($baseY - $stH - 1) $BRAND.Stone
    }
  }

  # Magical halo (legendary-tier — TH 9+)
  if ($level -ge 9) {
    $glow = [System.Drawing.Color]::FromArgb(120, 0xa9, 0x8f, 0xff)
    for ($i = -3; $i -le 3; $i++) {
      Set-Px $bmp ($cx + $i) ($towerY - 3) $glow
    }
    Set-Px $bmp ($cx - 4) ($towerY - 2) $glow
    Set-Px $bmp ($cx + 4) ($towerY - 2) $glow
  }
}

# ── Wall (levels 1..8) ────────────────────────────────────────────
function Draw-Building-Wall {
  param($bmp, [int]$level)
  RngInit "wall-$level"
  $detail = Detail-Level $level 8

  $cx = 16
  Draw-GroundShadow $bmp $cx 30 8

  # Base — fortified rectangle, tapered top
  $w = 20
  $h = 14
  if ($detail -ge 2) { $h = 16 }
  $x0 = $cx - [int]($w / 2)
  $y0 = 30 - $h
  Fill-Rect $bmp $x0 $y0 $w $h $BRAND.Stone
  Fill-Rect $bmp $x0 $y0 1 $h $BRAND.StoneHi
  Fill-Rect $bmp ($x0 + $w - 1) $y0 1 $h $BRAND.StoneDk

  # Brick courses
  for ($y = $y0 + 2; $y -lt ($y0 + $h - 1); $y += 3) {
    for ($x = $x0; $x -lt ($x0 + $w); $x++) {
      Set-Px $bmp $x $y $BRAND.StoneDk
    }
    # Stagger every other row
    if ($detail -ge 1) {
      for ($x = $x0 + 1; $x -lt ($x0 + $w); $x += 3) {
        Set-Px $bmp $x ($y + 1) $BRAND.StoneDk
      }
    }
  }

  # Crenellations on top
  $merlonStep = 4
  if ($detail -ge 2) { $merlonStep = 3 }
  for ($i = $x0; $i -lt ($x0 + $w); $i += $merlonStep) {
    Fill-Rect $bmp $i ($y0 - 1) 2 1 $BRAND.Stone
  }

  # Iron banding at higher tiers
  if ($detail -ge 2) {
    Fill-Rect $bmp $x0 ($y0 + 2) $w 1 $BRAND.Steel
    Fill-Rect $bmp $x0 ($y0 + $h - 4) $w 1 $BRAND.Steel
    # Rivets
    for ($x = $x0 + 2; $x -lt ($x0 + $w); $x += 4) {
      Set-Px $bmp $x ($y0 + 2) $BRAND.SteelHi
      Set-Px $bmp $x ($y0 + $h - 4) $BRAND.SteelHi
    }
  }

  # Gold-trim banner (max tier)
  if ($detail -ge 3) {
    Set-Px $bmp ($cx - 1) ($y0 + 4) $BRAND.Gold
    Set-Px $bmp $cx ($y0 + 4) $BRAND.GoldHi
    Set-Px $bmp ($cx + 1) ($y0 + 4) $BRAND.Gold
    Set-Px $bmp $cx ($y0 + 5) $BRAND.Crimson
    Set-Px $bmp $cx ($y0 + 6) $BRAND.Crimson
  }
}

# ── Cannon (levels 1..7) ──────────────────────────────────────────
function Draw-Building-Cannon {
  param($bmp, [int]$level)
  RngInit "cannon-$level"
  $detail = Detail-Level $level 7

  $cx = 16
  Draw-GroundShadow $bmp $cx 30 7

  # Carriage / base
  $cw = 14
  if ($detail -ge 2) { $cw = 16 }
  $ch = 5
  $cy0 = 30 - $ch
  $cx0 = $cx - [int]($cw / 2)
  Fill-Rect $bmp $cx0 $cy0 $cw $ch $BRAND.Wood
  Fill-Rect $bmp $cx0 $cy0 $cw 1 $BRAND.WoodHi
  Fill-Rect $bmp $cx0 ($cy0 + $ch - 1) $cw 1 $BRAND.WoodDk
  # Reinforcing bands
  Fill-Rect $bmp ($cx0 + 2) $cy0 1 $ch $BRAND.Steel
  Fill-Rect $bmp ($cx0 + $cw - 3) $cy0 1 $ch $BRAND.Steel

  # Wheels
  $whY = 30
  Set-Px $bmp ($cx0 + 1) $whY $BRAND.SteelDk
  Set-Px $bmp ($cx0 + 1) ($whY - 1) $BRAND.SteelHi
  Set-Px $bmp ($cx0 + $cw - 2) $whY $BRAND.SteelDk
  Set-Px $bmp ($cx0 + $cw - 2) ($whY - 1) $BRAND.SteelHi

  # Barrel — steel cylinder, points up-right, longer + thicker at higher tiers
  $barLen = 10
  if ($detail -ge 2) { $barLen = 12 }
  if ($detail -ge 3) { $barLen = 14 }
  $barW = 3
  if ($detail -ge 2) { $barW = 4 }

  # Barrel base attaches to carriage centre, sloping up-right
  $bx0 = $cx + 1
  $by0 = $cy0 - 1
  for ($i = 0; $i -lt $barLen; $i++) {
    # 45° slope: roughly 2 px horizontal per 1 vertical
    $bx = $bx0 + [int]($i * 0.7)
    $by = $by0 - [int]($i * 0.5)
    Fill-Rect $bmp $bx $by $barW 1 $BRAND.Steel
    Set-Px $bmp $bx $by $BRAND.SteelHi
    Set-Px $bmp ($bx + $barW - 1) $by $BRAND.SteelDk
  }
  # Muzzle ring at tip
  $muzzleX = $bx0 + [int]($barLen * 0.7)
  $muzzleY = $by0 - [int]($barLen * 0.5)
  Fill-Rect $bmp $muzzleX $muzzleY ($barW + 1) 1 $BRAND.SteelDk

  # Smoke / glow at muzzle (mid+ tier)
  if ($detail -ge 2) {
    Set-Px $bmp ($muzzleX + $barW) $muzzleY $BRAND.Gold
    Set-Px $bmp ($muzzleX + $barW + 1) ($muzzleY - 1) $BRAND.GoldHi
  }
  if ($detail -ge 3) {
    # Cannonball ready
    Fill-Rect $bmp ($muzzleX + $barW) ($muzzleY - 1) 2 2 $BRAND.Ink
    Set-Px $bmp ($muzzleX + $barW + 1) ($muzzleY - 1) $BRAND.Crimson
  }
}

# ── Archer Tower (levels 1..7) ────────────────────────────────────
function Draw-Building-ArcherTower {
  param($bmp, [int]$level)
  RngInit "archerTower-$level"
  $detail = Detail-Level $level 7

  $cx = 16
  Draw-GroundShadow $bmp $cx 30 6

  # Base — stone column
  $bw = 10
  if ($detail -ge 2) { $bw = 12 }
  $bh = 18
  if ($detail -ge 2) { $bh = 20 }
  if ($detail -ge 3) { $bh = 22 }
  $bx = $cx - [int]($bw / 2)
  $by = 30 - $bh
  Fill-Rect $bmp $bx $by $bw $bh $BRAND.Stone
  Fill-Rect $bmp $bx $by 1 $bh $BRAND.StoneHi
  Fill-Rect $bmp ($bx + $bw - 1) $by 1 $bh $BRAND.StoneDk

  # Stone courses
  for ($y = $by + 3; $y -lt ($by + $bh - 1); $y += 4) {
    for ($x = $bx; $x -lt ($bx + $bw); $x++) {
      Set-Px $bmp $x $y $BRAND.StoneDk
    }
  }

  # Wooden roof — pointed
  $roofW = $bw + 2
  $roofX = $cx - [int]($roofW / 2)
  $roofY = $by - 3
  Fill-Rect $bmp $roofX $roofY $roofW 1 $BRAND.Wood
  Fill-Rect $bmp ($roofX + 1) ($roofY - 1) ($roofW - 2) 1 $BRAND.Wood
  Fill-Rect $bmp ($roofX + 2) ($roofY - 2) ($roofW - 4) 1 $BRAND.WoodHi
  if ($detail -ge 2) {
    Set-Px $bmp $cx ($roofY - 3) $BRAND.Wood
  }

  # Window slits (vertical arrow loops)
  $slitY = $by + 4
  if ($detail -ge 2) { $slitY = $by + 5 }
  Fill-Rect $bmp $cx $slitY 1 3 $BRAND.Ink
  if ($detail -ge 2) {
    Fill-Rect $bmp ($cx - 3) ($slitY + 4) 1 2 $BRAND.Ink
    Fill-Rect $bmp ($cx + 3) ($slitY + 4) 1 2 $BRAND.Ink
  }
  # Archer silhouette at the top (mid+ tier)
  if ($detail -ge 2) {
    Set-Px $bmp $cx ($by + 1) $BRAND.Cloth
    Set-Px $bmp $cx ($by + 2) $BRAND.Cloth
    # Bow arc
    Set-Px $bmp ($cx + 1) ($by + 1) $BRAND.Wood
    Set-Px $bmp ($cx + 2) ($by + 2) $BRAND.Wood
  }
  # Quiver of arrows (max tier)
  if ($detail -ge 3) {
    Set-Px $bmp ($cx - 2) ($by + 1) $BRAND.WoodHi
    Set-Px $bmp ($cx - 2) ($by) $BRAND.Crimson
    Set-Px $bmp ($cx - 3) ($by) $BRAND.Crimson
  }
}

# ── Trap (levels 1..3) ────────────────────────────────────────────
function Draw-Building-Trap {
  param($bmp, [int]$level)
  RngInit "trap-$level"
  $detail = Detail-Level $level 3

  $cx = 16
  Draw-GroundShadow $bmp $cx 30 6

  # Trap = sunken plate flush with ground. Pressure-plate or rune.
  # L1: simple iron plate. L2: spikes around the rim. L3: glowing rune.
  $w = 10
  $h = 3
  $x0 = $cx - [int]($w / 2)
  $y0 = 30 - $h

  Fill-Rect $bmp $x0 $y0 $w $h $BRAND.SteelDk
  Fill-Rect $bmp $x0 $y0 $w 1 $BRAND.Steel
  Fill-Rect $bmp $x0 $y0 1 $h $BRAND.SteelHi
  Fill-Rect $bmp ($x0 + $w - 1) $y0 1 $h $BRAND.SteelDk
  # Centre rune dot
  Set-Px $bmp $cx ($y0 + 1) $BRAND.Crimson

  if ($detail -ge 1) {
    # Pressure-plate teeth
    for ($i = $x0 + 1; $i -lt ($x0 + $w - 1); $i += 2) {
      Set-Px $bmp $i ($y0 - 1) $BRAND.SteelHi
    }
  }
  if ($detail -ge 2) {
    # Spike rim
    Set-Px $bmp ($x0 - 1) ($y0 + 1) $BRAND.Steel
    Set-Px $bmp ($x0 + $w) ($y0 + 1) $BRAND.Steel
    # Glowing centre rune
    Set-Px $bmp ($cx - 1) ($y0 + 1) $BRAND.Violet
    Set-Px $bmp ($cx + 1) ($y0 + 1) $BRAND.Violet
    # Halo
    $glow = [System.Drawing.Color]::FromArgb(140, 0x9a, 0x82, 0xff)
    Set-Px $bmp $cx ($y0 - 1) $glow
    Set-Px $bmp ($cx - 2) $y0 $glow
    Set-Px $bmp ($cx + 2) $y0 $glow
  }
}

# ── Storage (levels 1..4) ─────────────────────────────────────────
function Draw-Building-Storage {
  param($bmp, [int]$level)
  RngInit "storage-$level"
  $detail = Detail-Level $level 4

  $cx = 16
  Draw-GroundShadow $bmp $cx 30 8

  # Storage = squat barrel/silo. Higher levels = wider + extra
  # storage barrels around the base.
  $bw = 10
  if ($detail -ge 2) { $bw = 12 }
  $bh = 12
  if ($detail -ge 2) { $bh = 14 }
  $bx = $cx - [int]($bw / 2)
  $by = 30 - $bh

  Fill-Rect $bmp $bx $by $bw $bh $BRAND.Wood
  Fill-Rect $bmp $bx $by 1 $bh $BRAND.WoodHi
  Fill-Rect $bmp ($bx + $bw - 1) $by 1 $bh $BRAND.WoodDk
  # Iron hoops
  Fill-Rect $bmp $bx ($by + 2) $bw 1 $BRAND.SteelDk
  Fill-Rect $bmp $bx ($by + 6) $bw 1 $BRAND.SteelDk
  Fill-Rect $bmp $bx ($by + 10) $bw 1 $BRAND.SteelDk
  # Rivets on each hoop
  if ($detail -ge 1) {
    for ($x = $bx + 1; $x -lt ($bx + $bw); $x += 3) {
      Set-Px $bmp $x ($by + 2) $BRAND.SteelHi
      Set-Px $bmp $x ($by + 6) $BRAND.SteelHi
      Set-Px $bmp $x ($by + 10) $BRAND.SteelHi
    }
  }
  # Lid
  Fill-Rect $bmp $bx ($by - 1) $bw 1 $BRAND.WoodDk
  Fill-Rect $bmp ($bx + 2) ($by - 2) ($bw - 4) 1 $BRAND.Wood
  # Padlock
  Set-Px $bmp $cx ($by + 6) $BRAND.Gold
  if ($detail -ge 1) {
    Set-Px $bmp $cx ($by + 7) $BRAND.GoldHi
  }

  # Side barrels (epic tier)
  if ($detail -ge 3) {
    foreach ($dir in @(-1, 1)) {
      $sbx = $cx + ($dir * [int]($bw / 2 + 2))
      $sbw = 4; $sbh = 6
      $sbx0 = $sbx - [int]($sbw / 2)
      $sby0 = 30 - $sbh
      Fill-Rect $bmp $sbx0 $sby0 $sbw $sbh $BRAND.Wood
      Fill-Rect $bmp $sbx0 ($sby0 + 1) $sbw 1 $BRAND.SteelDk
      Fill-Rect $bmp $sbx0 ($sby0 + 4) $sbw 1 $BRAND.SteelDk
      Set-Px $bmp $sbx0 $sby0 $BRAND.WoodHi
    }
  }
}

# ── Barracks (levels 1..4) ────────────────────────────────────────
function Draw-Building-Barracks {
  param($bmp, [int]$level)
  RngInit "barracks-$level"
  $detail = Detail-Level $level 4

  $cx = 16
  Draw-GroundShadow $bmp $cx 30 9

  # Wide low building with a peaked roof. Higher tiers add flag,
  # weapon racks, more windows.
  $bw = 18
  if ($detail -ge 2) { $bw = 20 }
  $bh = 8
  $bx = $cx - [int]($bw / 2)
  $by = 30 - $bh

  Fill-Rect $bmp $bx $by $bw $bh $BRAND.Stone
  Fill-Rect $bmp $bx $by 1 $bh $BRAND.StoneHi
  Fill-Rect $bmp ($bx + $bw - 1) $by 1 $bh $BRAND.StoneDk
  # Door — wide open archway
  $dw = 4
  $dx = $cx - [int]($dw / 2)
  $dy = 30 - 5
  Fill-Rect $bmp $dx $dy $dw 5 $BRAND.WoodDk

  # Windows
  Fill-Rect $bmp ($bx + 2) ($by + 2) 2 2 $BRAND.Gold
  Fill-Rect $bmp ($bx + $bw - 4) ($by + 2) 2 2 $BRAND.Gold
  if ($detail -ge 2) {
    Fill-Rect $bmp ($bx + 2) ($by + 5) 2 2 $BRAND.Gold
    Fill-Rect $bmp ($bx + $bw - 4) ($by + 5) 2 2 $BRAND.Gold
  }

  # Peaked wooden roof
  $rH = 5
  if ($detail -ge 2) { $rH = 6 }
  for ($i = 0; $i -lt $rH; $i++) {
    $rW = $bw - ($i * 2)
    if ($rW -le 0) { break }
    $rX = $cx - [int]($rW / 2)
    $rY = $by - 1 - $i
    Fill-Rect $bmp $rX $rY $rW 1 $BRAND.Wood
    Set-Px $bmp $rX $rY $BRAND.WoodDk
    Set-Px $bmp ($rX + $rW - 1) $rY $BRAND.WoodHi
  }
  # Roof eaves shadow
  Fill-Rect $bmp $bx ($by - 1) $bw 1 $BRAND.WoodHi

  # Flag at the peak
  if ($detail -ge 1) {
    Set-Px $bmp $cx ($by - 1 - $rH) $BRAND.Wood
    Set-Px $bmp ($cx + 1) ($by - 1 - $rH) $BRAND.Violet
    Set-Px $bmp ($cx + 2) ($by - 1 - $rH) $BRAND.Violet
  }
  # Weapon rack flanking door (max tier)
  if ($detail -ge 3) {
    foreach ($dir in @(-1, 1)) {
      $wx = $cx + ($dir * 5)
      Set-Px $bmp $wx ($dy + 1) $BRAND.Steel
      Set-Px $bmp $wx ($dy + 2) $BRAND.Steel
      Set-Px $bmp $wx ($dy + 3) $BRAND.Wood
      Set-Px $bmp $wx ($dy + 4) $BRAND.Wood
    }
  }
}

# ── War Tent (levels 1..3) ────────────────────────────────────────
function Draw-Building-WarTent {
  param($bmp, [int]$level)
  RngInit "warTent-$level"
  $detail = Detail-Level $level 3

  $cx = 16
  Draw-GroundShadow $bmp $cx 30 8

  # Pyramid tent. Higher tier = taller + ornate flag.
  $h = 14
  if ($detail -ge 2) { $h = 16 }
  if ($detail -ge 3) { $h = 18 }
  $baseW = 18

  $tipY = 30 - $h
  # Triangular silhouette
  for ($i = 0; $i -lt $h; $i++) {
    $w = [int](($baseW * $i) / $h)
    if ($w -lt 1) { $w = 1 }
    $x0 = $cx - [int]($w / 2)
    $y = $tipY + $i
    Fill-Rect $bmp $x0 $y $w 1 $BRAND.Crimson
    Set-Px $bmp $x0 $y $BRAND.Wood
    Set-Px $bmp ($x0 + $w - 1) $y $BRAND.WoodDk
  }
  # Centre fold seam
  for ($i = 1; $i -lt $h; $i++) {
    Set-Px $bmp $cx ($tipY + $i) $BRAND.WoodDk
  }
  # Door slit
  Fill-Rect $bmp ($cx - 1) (30 - 5) 2 4 $BRAND.Ink

  # Banner pole at the tip
  Set-Px $bmp $cx ($tipY - 1) $BRAND.Wood
  Set-Px $bmp $cx ($tipY - 2) $BRAND.Wood
  if ($detail -ge 1) {
    Fill-Rect $bmp ($cx + 1) ($tipY - 2) 3 1 $BRAND.Violet
    Set-Px $bmp ($cx + 3) ($tipY - 1) $BRAND.Violet
  }
  # Two flags at top tier
  if ($detail -ge 2) {
    Set-Px $bmp $cx ($tipY - 3) $BRAND.Gold
  }
  # Crossed swords (max tier)
  if ($detail -ge 3) {
    # Left of door
    Set-Px $bmp ($cx - 4) (30 - 4) $BRAND.SteelHi
    Set-Px $bmp ($cx - 5) (30 - 3) $BRAND.SteelHi
    Set-Px $bmp ($cx - 6) (30 - 2) $BRAND.Steel
    Set-Px $bmp ($cx + 4) (30 - 4) $BRAND.SteelHi
    Set-Px $bmp ($cx + 5) (30 - 3) $BRAND.SteelHi
    Set-Px $bmp ($cx + 6) (30 - 2) $BRAND.Steel
  }
}

# ── Building dispatcher ───────────────────────────────────────────
function Draw-Building {
  param($bmp, [string]$kind, [int]$level)
  switch ($kind) {
    'townhall'    { Draw-Building-TownHall    $bmp $level }
    'wall'        { Draw-Building-Wall        $bmp $level }
    'cannon'      { Draw-Building-Cannon      $bmp $level }
    'archerTower' { Draw-Building-ArcherTower $bmp $level }
    'trap'        { Draw-Building-Trap        $bmp $level }
    'storage'     { Draw-Building-Storage     $bmp $level }
    'barracks'    { Draw-Building-Barracks    $bmp $level }
    'warTent'     { Draw-Building-WarTent     $bmp $level }
    default       { throw "Unknown building kind: $kind" }
  }
}

# Catalogue mirror — keep in sync with discord-bot/clash-content.js
# BUILDINGS table max levels.
$BUILDING_LEVELS = @{
  townhall    = 10
  wall        = 8
  cannon      = 7
  archerTower = 7
  trap        = 3
  storage     = 4
  barracks    = 4
  warTent     = 3
}

function Build-Buildings {
  Write-Host '── Clash building sprites ──' -ForegroundColor Cyan
  $total = 0
  foreach ($kind in $BUILDING_LEVELS.Keys) {
    $maxLevel = $BUILDING_LEVELS[$kind]
    for ($lv = 1; $lv -le $maxLevel; $lv++) {
      $bmp = New-Canvas $BUILDING_W $BUILDING_H
      Draw-Building $bmp $kind $lv
      Save-Canvas $bmp (Join-Path $buildingDir ("{0}-L{1}.png" -f $kind, $lv))
      $total++
    }
    Write-Host ("  {0}: L1..L{1}" -f $kind, $maxLevel) -ForegroundColor Gray
  }
  Write-Host ("  total building sprites: {0}" -f $total) -ForegroundColor Green
}

# ── Troops (24×24) ────────────────────────────────────────────────
$TROOP_W = 24
$TROOP_H = 24

# Each troop is a small humanoid silhouette in a 24×24 canvas with a
# distinctive weapon / robe / posture so glances on a roster screen
# read instantly. Rarity (common/rare/epic) drives palette pop.

$RARITY_ACCENT = @{
  common = $BRAND.StoneHi
  rare   = $BRAND.VioletHi
  epic   = $BRAND.Gold
}

function Draw-TroopBody {
  param($bmp, $skinPalette, $clothPrimary, $clothShadow)
  # 24×24 figure, anchored to bottom-centre. Head at top, body below.
  $cx = 12
  # Head (3×3)
  Fill-Rect $bmp ($cx - 1) 5 3 3 $skinPalette
  Set-Px $bmp ($cx - 1) 5 $BRAND.Ink
  Set-Px $bmp ($cx + 1) 5 $BRAND.Ink
  Set-Px $bmp ($cx - 1) 7 $BRAND.Ink
  Set-Px $bmp ($cx + 1) 7 $BRAND.Ink
  # Body (5×6)
  Fill-Rect $bmp ($cx - 2) 9 5 6 $clothPrimary
  Fill-Rect $bmp ($cx - 2) 9 1 6 $clothShadow
  Fill-Rect $bmp ($cx + 2) 9 1 6 $clothShadow
  # Belt
  Fill-Rect $bmp ($cx - 2) 14 5 1 $BRAND.Leather
  # Legs (2×4)
  Fill-Rect $bmp ($cx - 2) 15 2 5 $clothShadow
  Fill-Rect $bmp ($cx + 1) 15 2 5 $clothShadow
  # Boots
  Fill-Rect $bmp ($cx - 2) 20 2 1 $BRAND.LeatherHi
  Fill-Rect $bmp ($cx + 1) 20 2 1 $BRAND.LeatherHi
  # Ground shadow
  $sh = [System.Drawing.Color]::FromArgb(120, 0x05, 0x05, 0x0a)
  for ($i = -3; $i -le 3; $i++) {
    Set-Px $bmp ($cx + $i) 22 $sh
  }
}

# ── Scrapper — common scrappy melee, wrench/club ──────────────────
function Draw-Troop-Scrapper {
  param($bmp)
  RngInit "scrapper"
  Draw-TroopBody $bmp $BRAND.Skin $BRAND.LeatherHi $BRAND.Leather
  # Wrench in right hand — wide club head
  Set-Px $bmp 16 11 $BRAND.Wood
  Set-Px $bmp 17 11 $BRAND.Wood
  Set-Px $bmp 18 11 $BRAND.SteelHi
  Set-Px $bmp 18 10 $BRAND.SteelHi
  Set-Px $bmp 19 10 $BRAND.Steel
  Set-Px $bmp 19 9  $BRAND.Steel
  # Bandana
  Fill-Rect $bmp 11 4 3 1 $BRAND.Crimson
}

# ── Bolt Knight — rare plate-armoured swordsman ───────────────────
function Draw-Troop-BoltKnight {
  param($bmp)
  RngInit "boltKnight"
  Draw-TroopBody $bmp $BRAND.Skin $BRAND.Steel $BRAND.SteelDk
  # Plate highlight (chest)
  Fill-Rect $bmp 11 10 3 2 $BRAND.SteelHi
  # Helm — replace head with helmet
  Fill-Rect $bmp 10 4 5 4 $BRAND.SteelDk
  Fill-Rect $bmp 11 5 3 1 $BRAND.SteelHi
  # Visor slit
  Fill-Rect $bmp 11 6 3 1 $BRAND.Ink
  # Sword in right hand — longer than scrapper's wrench
  Set-Px $bmp 16 11 $BRAND.Wood
  Set-Px $bmp 17 11 $BRAND.SteelHi
  Set-Px $bmp 17 10 $BRAND.Steel
  Set-Px $bmp 17 9  $BRAND.Steel
  Set-Px $bmp 17 8  $BRAND.Steel
  Set-Px $bmp 17 7  $BRAND.SteelHi
  Set-Px $bmp 16 9  $BRAND.Steel
  Set-Px $bmp 18 9  $BRAND.Steel
  # Voltaic gem on chest (rare accent)
  Set-Px $bmp 12 11 $BRAND.VioletHi
}

# ── Archer — common ranged ────────────────────────────────────────
function Draw-Troop-Archer {
  param($bmp)
  RngInit "archerLite"
  Draw-TroopBody $bmp $BRAND.Skin $BRAND.Wood $BRAND.WoodDk
  # Hood drape behind head
  Fill-Rect $bmp 10 4 5 2 $BRAND.WoodDk
  # Bow held vertically in left hand
  Set-Px $bmp 7 7 $BRAND.Wood
  Set-Px $bmp 6 8 $BRAND.Wood
  Set-Px $bmp 6 9 $BRAND.WoodHi
  Set-Px $bmp 6 10 $BRAND.WoodHi
  Set-Px $bmp 6 11 $BRAND.Wood
  Set-Px $bmp 7 12 $BRAND.Wood
  # Bowstring
  Set-Px $bmp 7 8 $BRAND.Cloth
  Set-Px $bmp 7 9 $BRAND.Cloth
  Set-Px $bmp 7 10 $BRAND.Cloth
  Set-Px $bmp 7 11 $BRAND.Cloth
  # Arrow nocked
  Set-Px $bmp 8 10 $BRAND.WoodHi
  Set-Px $bmp 9 10 $BRAND.WoodHi
}

# ── Voltaic Mage — epic ranged AOE caster ─────────────────────────
function Draw-Troop-VoltaicMage {
  param($bmp)
  RngInit "voltaicMage"
  Draw-TroopBody $bmp $BRAND.Skin $BRAND.Violet $BRAND.VioletDk
  # Robe sleeves (epic flair)
  Fill-Rect $bmp 9 12 1 3 $BRAND.Violet
  Fill-Rect $bmp 14 12 1 3 $BRAND.Violet
  # Pointed hat
  Fill-Rect $bmp 10 3 5 1 $BRAND.VioletDk
  Fill-Rect $bmp 11 2 3 1 $BRAND.VioletDk
  Set-Px $bmp 12 1 $BRAND.Gold
  # Eyes glow
  Set-Px $bmp 11 7 $BRAND.Green
  Set-Px $bmp 13 7 $BRAND.Green
  # Staff in right hand — top orb
  Set-Px $bmp 16 11 $BRAND.WoodDk
  Set-Px $bmp 16 10 $BRAND.Wood
  Set-Px $bmp 16 9  $BRAND.Wood
  Set-Px $bmp 16 8  $BRAND.WoodHi
  # Orb
  Fill-Rect $bmp 15 6 3 2 $BRAND.Violet
  Set-Px $bmp 16 6 $BRAND.VioletHi
  Set-Px $bmp 16 5 $BRAND.Green
  # Sparkle halo
  $glow = [System.Drawing.Color]::FromArgb(140, 0x5b, 0xff, 0x95)
  Set-Px $bmp 14 5 $glow
  Set-Px $bmp 18 5 $glow
  Set-Px $bmp 16 4 $glow
  # Gold belt buckle (epic)
  Set-Px $bmp 12 14 $BRAND.Gold
}

# ── Sapper Rogue — rare wall-buster with explosives ───────────────
function Draw-Troop-SapperRogue {
  param($bmp)
  RngInit "sapperRogue"
  Draw-TroopBody $bmp $BRAND.Skin $BRAND.SteelDk $BRAND.Ink
  # Hood
  Fill-Rect $bmp 10 4 5 2 $BRAND.Ink
  Fill-Rect $bmp 11 4 3 1 $BRAND.SteelDk
  # Mask — only eyes visible
  Fill-Rect $bmp 10 7 5 1 $BRAND.Ink
  Set-Px $bmp 11 7 $BRAND.Crimson
  Set-Px $bmp 13 7 $BRAND.Crimson
  # Bomb in right hand — round black with fuse
  Fill-Rect $bmp 16 11 3 3 $BRAND.Ink
  Set-Px $bmp 17 11 $BRAND.SteelHi
  Set-Px $bmp 17 10 $BRAND.Wood   # Fuse
  Set-Px $bmp 18 9  $BRAND.Gold   # Spark
  Set-Px $bmp 17 9  $BRAND.Crimson
  # Belt of charges (rare)
  Set-Px $bmp 10 14 $BRAND.Crimson
  Set-Px $bmp 14 14 $BRAND.Crimson
}

# ── Healer Cleric — rare support, robes + halo ────────────────────
function Draw-Troop-HealerCleric {
  param($bmp)
  RngInit "healerCleric"
  Draw-TroopBody $bmp $BRAND.Skin $BRAND.Cloth $BRAND.ClothDk
  # Hood
  Fill-Rect $bmp 10 4 5 2 $BRAND.ClothDk
  # Halo above head
  $glow = [System.Drawing.Color]::FromArgb(140, 0x6e, 0xe0, 0xc0)
  Fill-Rect $bmp 10 3 5 1 $glow
  Set-Px $bmp 11 2 $glow
  Set-Px $bmp 13 2 $glow
  # Holy symbol on chest — cross
  Set-Px $bmp 12 11 $BRAND.Gold
  Set-Px $bmp 12 12 $BRAND.Gold
  Set-Px $bmp 11 12 $BRAND.Gold
  Set-Px $bmp 13 12 $BRAND.Gold
  Set-Px $bmp 12 13 $BRAND.Gold
  # Staff with green orb
  Set-Px $bmp 16 11 $BRAND.WoodDk
  Set-Px $bmp 16 10 $BRAND.Wood
  Set-Px $bmp 16 9  $BRAND.Wood
  Set-Px $bmp 16 8  $BRAND.WoodHi
  # Orb (green = healing)
  Fill-Rect $bmp 15 6 3 2 $BRAND.Teal
  Set-Px $bmp 16 6 $BRAND.Green
}

function Draw-Troop {
  param($bmp, [string]$troopId)
  switch ($troopId) {
    'scrapper'     { Draw-Troop-Scrapper     $bmp }
    'boltKnight'   { Draw-Troop-BoltKnight   $bmp }
    'archerLite'   { Draw-Troop-Archer       $bmp }
    'voltaicMage'  { Draw-Troop-VoltaicMage  $bmp }
    'sapperRogue'  { Draw-Troop-SapperRogue  $bmp }
    'healerCleric' { Draw-Troop-HealerCleric $bmp }
    default        { throw "Unknown troop id: $troopId" }
  }
}

# Catalogue mirror — keep in sync with TROOPS_PERSONAL in
# discord-bot/clash-content.js. Garrison uses the same six (subset
# of four) — same sprites apply to both.
$TROOPS = @('scrapper', 'boltKnight', 'archerLite', 'voltaicMage', 'sapperRogue', 'healerCleric')

function Build-Troops {
  Write-Host '── Clash troop sprites ──' -ForegroundColor Cyan
  foreach ($troopId in $TROOPS) {
    $bmp = New-Canvas $TROOP_W $TROOP_H
    Draw-Troop $bmp $troopId
    Save-Canvas $bmp (Join-Path $troopDir ("{0}.png" -f $troopId))
  }
  Write-Host ("  troops: {0}" -f $TROOPS.Count) -ForegroundColor Green
}

# ── Top-level driver ──────────────────────────────────────────────
Build-Buildings
Build-Troops

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "Output: $clashDir"
