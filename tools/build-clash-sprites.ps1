# Procedural HD pixel-art sprite generator for the Clash building +
# troop roster.
#
# Phase-4 quality bar (Clay 2026-05-21): larger canvas, 5-tone
# material ramps (stone / wood / thatch / steel / cloth), rim light,
# rivets / shingles / banner pennants / glow halos for max-tier.
#
# Output paths (committed to git):
#   aquilo-gg/sprites/clash/buildings/<kind>-L<level>.png
#   aquilo-gg/sprites/clash/troops/<troopId>.png
#
# Canvas:
#   buildings = 48×48 (footprint anchored bottom-centre, ground row 46)
#   troops    = 32×32 (footprint anchored bottom-centre, ground row 30)
#
# Regenerate from scratch:
#   pwsh -ExecutionPolicy Bypass -File tools/build-clash-sprites.ps1

[CmdletBinding()]
param(
  [string]$OutRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'aquilo-gg/sprites')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib-pixel.ps1')

$clashDir    = Join-Path $OutRoot 'clash'
$buildingDir = Join-Path $clashDir 'buildings'
$troopDir    = Join-Path $clashDir 'troops'
foreach ($d in @($clashDir, $buildingDir, $troopDir)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

$BUILDING_W = 48
$BUILDING_H = 48
$TROOP_W    = 32
$TROOP_H    = 32

$GROUND_Y_B = 46    # row y for building base
$GROUND_Y_T = 30    # row y for troop base

# Tier index: 1..3 buckets from current level / maxLevel.
function Tier-Index {
  param([int]$level, [int]$maxLevel)
  if ($level -le 1) { return 0 }
  if ($maxLevel -le 3) { return [Math]::Min(2, $level - 1) }
  $third = [Math]::Max(1, [int]($maxLevel / 3))
  if ($level -le $third)         { return 1 }
  if ($level -le ($third * 2))   { return 2 }
  return 3
}

# Ground shadow under a building
function Draw-GroundShadow {
  param($bmp, [int]$cx, [int]$y, [int]$halfW)
  $shadow = (Color-FromHex '#050510')
  for ($dx = -$halfW; $dx -le $halfW; $dx++) {
    $a = 150 - [Math]::Abs($dx) * (130 / [Math]::Max(1, $halfW))
    if ($a -lt 20) { continue }
    Blend-Pixel $bmp ($cx + $dx) $y (With-Alpha $shadow ([int]$a))
  }
  for ($dx = -$halfW + 2; $dx -le ($halfW - 2); $dx++) {
    Blend-Pixel $bmp ($cx + $dx) ($y - 1) (With-Alpha $shadow 50)
  }
}

# Pennant flag at a pole — small triangle in brand colour
function Draw-Pennant {
  param($bmp, [int]$px, [int]$py, $color)
  Set-Pixel $bmp $px $py $color
  Set-Pixel $bmp ($px + 1) $py $color
  Set-Pixel $bmp ($px + 2) $py $color
  Set-Pixel $bmp ($px + 3) $py $color
  Set-Pixel $bmp $px ($py + 1) $color
  Set-Pixel $bmp ($px + 1) ($py + 1) $color
  Set-Pixel $bmp ($px + 2) ($py + 1) $color
  Set-Pixel $bmp ($px + 3) ($py + 1) $color
  Set-Pixel $bmp $px ($py + 2) $color
  Set-Pixel $bmp ($px + 1) ($py + 2) $color
}

# ── Town Hall ──
function Draw-Building-TownHall {
  param($bmp, [int]$level)
  Rng-Init "townhall-$level"
  $t = Tier-Index $level 10
  $cx = 24
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 1) 14

  # Stone base
  $baseW = 22 + ($t * 2)
  $baseH = 14 + ($t * 2)
  $baseX = $cx - [int]($baseW / 2)
  $baseY = $GROUND_Y_B - $baseH
  Shade-Box $bmp $baseX $baseY $baseW $baseH $MAT_STONE -RimLight

  # Stone courses (horizontal joints) — broken pattern
  for ($y = $baseY + 3; $y -lt ($baseY + $baseH - 1); $y += 4) {
    for ($x = ($baseX + 1); $x -lt ($baseX + $baseW - 1); $x++) {
      Set-Pixel $bmp $x $y $MAT_STONE.shadow
    }
    # Vertical staggered joints
    $shift = ([int](($y - $baseY) / 4) % 2) * 3
    for ($x = ($baseX + 2 + $shift); $x -lt ($baseX + $baseW); $x += 5) {
      for ($v = 0; $v -lt 3; $v++) {
        if (($y - $v) -gt $baseY) {
          Set-Pixel $bmp $x ($y - $v) $MAT_STONE.shadow
        }
      }
    }
  }

  # Door — wooden archway
  $doorW = 6 + $t
  $doorH = 7 + $t
  $doorX = $cx - [int]($doorW / 2)
  $doorY = $GROUND_Y_B - $doorH
  Shade-Box $bmp $doorX $doorY $doorW $doorH $MAT_WOOD_DARK
  # Arch
  Set-Pixel $bmp $doorX ($doorY - 1) $MAT_STONE.shadow
  Set-Pixel $bmp ($doorX + $doorW - 1) ($doorY - 1) $MAT_STONE.shadow
  for ($x = ($doorX + 1); $x -lt ($doorX + $doorW - 1); $x++) {
    Set-Pixel $bmp $x ($doorY - 1) $MAT_STONE.high
  }
  # Gold band on door
  if ($t -ge 1) {
    Fill-Box $bmp $doorX ($doorY + [int]($doorH / 2)) $doorW 1 $MAT_GOLD.base
  }
  # Door handle
  Set-Pixel $bmp ($doorX + 1) ($doorY + [int]($doorH / 2) + 1) $MAT_GOLD.high

  # Crenellated battlements
  $merlonCount = 5 + $t
  $merlonStep = [Math]::Max(2, [int]($baseW / ($merlonCount * 2 - 1)))
  for ($i = 0; $i -lt $merlonCount; $i++) {
    $mx = $baseX + ($i * 2 * $merlonStep)
    Fill-Box $bmp $mx ($baseY - 1) $merlonStep 1 $MAT_STONE.high
    Set-Pixel $bmp $mx ($baseY - 1) $MAT_STONE.top
  }

  # Central tower
  $towerW = 8 + $t
  $towerH = 8 + $t * 2
  $towerX = $cx - [int]($towerW / 2)
  $towerY = $baseY - $towerH
  Shade-Box $bmp $towerX $towerY $towerW $towerH $MAT_STONE -RimLight
  # Stone courses on tower
  for ($y = $towerY + 3; $y -lt ($towerY + $towerH - 1); $y += 3) {
    for ($x = ($towerX + 1); $x -lt ($towerX + $towerW - 1); $x++) {
      Set-Pixel $bmp $x $y $MAT_STONE.shadow
    }
  }
  # Tower windows — golden glow
  $winY = $towerY + 3 + $t
  Set-Pixel $bmp ($cx - 1) $winY $MAT_GOLD.base
  Set-Pixel $bmp $cx $winY $MAT_GOLD.top
  Set-Pixel $bmp ($cx + 1) $winY $MAT_GOLD.base
  Set-Pixel $bmp ($cx - 1) ($winY - 1) $MAT_WOOD_DARK.deep
  Set-Pixel $bmp ($cx + 1) ($winY - 1) $MAT_WOOD_DARK.deep

  # Conical roof on tower
  if ($t -ge 1) {
    $roofH = 3 + $t
    for ($i = 0; $i -lt $roofH; $i++) {
      $w = $towerW - $i * 2
      if ($w -lt 1) { break }
      $x0 = $cx - [int]($w / 2)
      Fill-Box $bmp $x0 ($towerY - 1 - $i) $w 1 $MAT_WOOD_DARK.base
      Set-Pixel $bmp $x0 ($towerY - 1 - $i) $MAT_WOOD_DARK.shadow
      Set-Pixel $bmp ($x0 + $w - 1) ($towerY - 1 - $i) $MAT_WOOD_DARK.high
    }
    # Roof tip + finial
    Set-Pixel $bmp $cx ($towerY - 1 - $roofH) $MAT_GOLD.top
  }

  # Banner pennant
  if ($t -ge 2) {
    $px = $cx + 2
    $py = $towerY - 2
    # Flagpole
    for ($i = 0; $i -lt 5; $i++) {
      Set-Pixel $bmp $px ($py - $i) $MAT_STEEL.base
    }
    Set-Pixel $bmp $px ($py - 5) $MAT_GOLD.top
    Draw-Pennant $bmp ($px + 1) ($py - 4) $BRAND.Violet
  }

  # Flanking towers (top tier)
  if ($t -ge 3) {
    foreach ($dir in @(-1, 1)) {
      $sx = $cx + $dir * ([int]($baseW / 2) - 2)
      $stH = 5
      Shade-Box $bmp ($sx - 1) ($baseY - $stH) 3 $stH $MAT_STONE
      Set-Pixel $bmp $sx ($baseY - $stH - 1) $MAT_STONE.high
    }
  }

  # Legendary halo (level 9+)
  if ($level -ge 9) {
    Apply-Rarity-Glow $bmp 'legendary'
  }
}

# ── Wall ──
function Draw-Building-Wall {
  param($bmp, [int]$level)
  Rng-Init "wall-$level"
  $t = Tier-Index $level 8
  $cx = 24
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 1) 12

  $w = 30
  $h = 20 + $t * 2
  $x0 = $cx - [int]($w / 2)
  $y0 = $GROUND_Y_B - $h
  Shade-Box $bmp $x0 $y0 $w $h $MAT_STONE -RimLight

  # Brick pattern — staggered
  for ($y = $y0 + 3; $y -lt ($y0 + $h - 1); $y += 4) {
    $shift = ([int](($y - $y0) / 4) % 2) * 4
    for ($x = ($x0 + 1); $x -lt ($x0 + $w - 1); $x++) {
      Set-Pixel $bmp $x $y $MAT_STONE.shadow
    }
    for ($x = ($x0 + 2 + $shift); $x -lt ($x0 + $w); $x += 7) {
      for ($v = 0; $v -lt 3; $v++) {
        if (($y - $v) -gt $y0) {
          Set-Pixel $bmp $x ($y - $v) $MAT_STONE.shadow
        }
      }
    }
  }

  # Crenellations
  $merlonStep = 4
  if ($t -ge 1) { $merlonStep = 3 }
  for ($i = $x0; $i -lt ($x0 + $w); $i += $merlonStep) {
    Fill-Box $bmp $i ($y0 - 1) 2 1 $MAT_STONE.high
  }

  # Iron banding (mid+)
  if ($t -ge 1) {
    Fill-Box $bmp $x0 ($y0 + 3) $w 1 $MAT_STEEL.base
    Fill-Box $bmp $x0 ($y0 + $h - 5) $w 1 $MAT_STEEL.base
    Fill-Box $bmp $x0 ($y0 + 2) $w 1 $MAT_STEEL.high
    for ($x = ($x0 + 2); $x -lt ($x0 + $w); $x += 4) {
      Draw-Rivet $bmp $x ($y0 + 3) $MAT_STEEL
      Draw-Rivet $bmp $x ($y0 + $h - 5) $MAT_STEEL
    }
  }

  # Gold pennant banner (top tier)
  if ($t -ge 2) {
    Fill-Box $bmp ($cx - 2) ($y0 + 7) 5 5 $BRAND.Crimson
    Set-Pixel $bmp ($cx - 2) ($y0 + 7) $MAT_GOLD.high
    Set-Pixel $bmp ($cx + 2) ($y0 + 7) $MAT_GOLD.shadow
    Set-Pixel $bmp $cx ($y0 + 9) $MAT_GOLD.top
  }
  if ($level -ge 7) { Apply-Rarity-Glow $bmp 'epic' }
}

# ── Cannon ──
function Draw-Building-Cannon {
  param($bmp, [int]$level)
  Rng-Init "cannon-$level"
  $t = Tier-Index $level 7
  $cx = 24
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 1) 11

  # Carriage
  $cw = 20 + $t * 2
  $ch = 7
  $cy0 = $GROUND_Y_B - $ch
  $cx0 = $cx - [int]($cw / 2)
  Shade-Box $bmp $cx0 $cy0 $cw $ch $MAT_WOOD_DARK -RimLight
  # Iron bands at carriage ends
  Fill-Box $bmp ($cx0 + 2) $cy0 1 $ch $MAT_STEEL.base
  Fill-Box $bmp ($cx0 + $cw - 3) $cy0 1 $ch $MAT_STEEL.base
  Draw-Rivet $bmp ($cx0 + 2) ($cy0 + 1) $MAT_STEEL
  Draw-Rivet $bmp ($cx0 + $cw - 3) ($cy0 + 1) $MAT_STEEL

  # Wheels
  $whY = $GROUND_Y_B
  Shade-Disc $bmp ($cx0 + 2) $whY 2 $MAT_STEEL
  Shade-Disc $bmp ($cx0 + $cw - 3) $whY 2 $MAT_STEEL
  Set-Pixel $bmp ($cx0 + 2) $whY (Color-FromHex '#000000')
  Set-Pixel $bmp ($cx0 + $cw - 3) $whY (Color-FromHex '#000000')

  # Barrel — sloped up-right
  $barLen = 14 + $t * 2
  $barW = 4 + [int]($t / 2)
  $bx0 = $cx + 1
  $by0 = $cy0 - 1
  for ($i = 0; $i -lt $barLen; $i++) {
    $bx = $bx0 + [int]($i * 0.75)
    $by = $by0 - [int]($i * 0.55)
    for ($w = 0; $w -lt $barW; $w++) {
      Set-Pixel $bmp $bx ($by + $w) $MAT_STEEL.base
    }
    Set-Pixel $bmp $bx $by $MAT_STEEL.high
    Set-Pixel $bmp $bx ($by + $barW - 1) $MAT_STEEL.shadow
    # Banded ring every 4 px
    if (($i % 4) -eq 0 -and $i -gt 0) {
      Set-Pixel $bmp $bx $by $MAT_STEEL.top
      Set-Pixel $bmp ($bx + 1) $by $MAT_STEEL.top
    }
  }
  # Muzzle ring at tip
  $muzzleX = $bx0 + [int]($barLen * 0.75)
  $muzzleY = $by0 - [int]($barLen * 0.55)
  for ($w = 0; $w -lt ($barW + 1); $w++) {
    Set-Pixel $bmp $muzzleX ($muzzleY + $w - 1) $MAT_STEEL.deep
  }
  # Muzzle flash glow (mid+)
  if ($t -ge 1) {
    Blend-Pixel $bmp ($muzzleX + 1) $muzzleY (With-Alpha $MAT_GOLD.top 180)
    Blend-Pixel $bmp ($muzzleX + 2) ($muzzleY - 1) (With-Alpha $MAT_GOLD.high 140)
    Blend-Pixel $bmp ($muzzleX + 1) ($muzzleY + 1) (With-Alpha (Color-FromHex '#ff7040') 140)
  }
  # Cannonball ready (top tier)
  if ($t -ge 2) {
    Shade-Disc $bmp ($muzzleX + 2) $muzzleY 1.5 $MAT_OBSIDIAN
  }
  if ($level -ge 6) { Apply-Rarity-Glow $bmp 'epic' }
}

# ── Archer Tower ──
function Draw-Building-ArcherTower {
  param($bmp, [int]$level)
  Rng-Init "archerTower-$level"
  $t = Tier-Index $level 7
  $cx = 24
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 1) 10

  # Base column
  $bw = 14 + $t * 2
  $bh = 26 + $t * 2
  $bx = $cx - [int]($bw / 2)
  $by = $GROUND_Y_B - $bh
  Shade-Box $bmp $bx $by $bw $bh $MAT_STONE -RimLight

  # Stone courses
  for ($y = $by + 4; $y -lt ($by + $bh - 1); $y += 5) {
    for ($x = ($bx + 1); $x -lt ($bx + $bw - 1); $x++) {
      Set-Pixel $bmp $x $y $MAT_STONE.shadow
    }
  }

  # Crow's nest platform — slight overhang
  $nestW = $bw + 2
  $nestX = $cx - [int]($nestW / 2)
  $nestY = $by - 1
  Fill-Box $bmp $nestX $nestY $nestW 1 $MAT_WOOD_DARK.deep
  Fill-Box $bmp $nestX ($nestY - 1) $nestW 1 $MAT_WOOD_DARK.base
  Fill-Box $bmp ($nestX + 1) ($nestY - 2) ($nestW - 2) 1 $MAT_WOOD_DARK.high

  # Conical roof
  $roofH = 4 + $t
  $roofW = $nestW + 2
  for ($i = 0; $i -lt $roofH; $i++) {
    $w = $roofW - $i * 2
    if ($w -lt 1) { break }
    $x0 = $cx - [int]($w / 2)
    $y = $nestY - 3 - $i
    Fill-Box $bmp $x0 $y $w 1 $MAT_WOOD_DARK.base
    Set-Pixel $bmp $x0 $y $MAT_WOOD_DARK.shadow
    Set-Pixel $bmp ($x0 + $w - 1) $y $MAT_WOOD_DARK.high
    # Shingle pattern
    if (($i % 2) -eq 0) {
      Set-Pixel $bmp ($x0 + 1) $y $MAT_WOOD_DARK.deep
    }
  }
  # Roof finial
  Set-Pixel $bmp $cx ($nestY - 3 - $roofH) $MAT_GOLD.top

  # Arrow loops (vertical slits)
  $slitY = $by + 5
  Fill-Box $bmp $cx $slitY 1 4 $BRAND.Ink
  if ($t -ge 1) {
    Fill-Box $bmp ($cx - 4) ($slitY + 5) 1 3 $BRAND.Ink
    Fill-Box $bmp ($cx + 4) ($slitY + 5) 1 3 $BRAND.Ink
  }
  if ($t -ge 2) {
    Fill-Box $bmp ($cx - 4) ($slitY + 12) 1 3 $BRAND.Ink
    Fill-Box $bmp ($cx + 4) ($slitY + 12) 1 3 $BRAND.Ink
  }
  # Door at base
  Fill-Box $bmp ($cx - 2) ($GROUND_Y_B - 5) 4 5 $MAT_WOOD_DARK.deep
  Set-Pixel $bmp $cx ($GROUND_Y_B - 3) $MAT_GOLD.high   # door handle

  # Archer silhouette on top (mid+)
  if ($t -ge 2) {
    Fill-Box $bmp ($cx - 1) ($nestY - 4) 2 2 $MAT_LEATHER.base
    Set-Pixel $bmp $cx ($nestY - 5) $MAT_LEATHER.shadow   # hood
    # Bow being drawn
    Set-Pixel $bmp ($cx + 2) ($nestY - 5) $MAT_WOOD_DARK.high
    Set-Pixel $bmp ($cx + 3) ($nestY - 4) $MAT_WOOD_DARK.high
    Set-Pixel $bmp ($cx + 3) ($nestY - 3) $MAT_WOOD_DARK.high
  }
  if ($level -ge 6) { Apply-Rarity-Glow $bmp 'epic' }
}

# ── Trap ──
function Draw-Building-Trap {
  param($bmp, [int]$level)
  Rng-Init "trap-$level"
  $t = Tier-Index $level 3
  $cx = 24
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 1) 10

  # Sunken metal plate
  $w = 16 + $t * 2
  $h = 5
  $x0 = $cx - [int]($w / 2)
  $y0 = $GROUND_Y_B - $h
  Shade-Box $bmp $x0 $y0 $w $h $MAT_STEEL -RimLight
  # Recessed centre
  Fill-Box $bmp ($x0 + 1) ($y0 + 2) ($w - 2) 1 $MAT_STEEL.deep

  # Centre rune
  $accent = if ($t -ge 1) { $BRAND.Violet } else { $BRAND.Crimson }
  Set-Pixel $bmp $cx ($y0 + 2) $accent
  Set-Pixel $bmp ($cx - 1) ($y0 + 2) (With-Alpha $accent 200)
  Set-Pixel $bmp ($cx + 1) ($y0 + 2) (With-Alpha $accent 200)

  # Pressure-plate spikes (mid+)
  if ($t -ge 1) {
    for ($i = $x0 + 2; $i -lt ($x0 + $w - 1); $i += 3) {
      Set-Pixel $bmp $i ($y0 - 1) $MAT_STEEL.high
      Set-Pixel $bmp $i ($y0 - 2) $MAT_STEEL.top
    }
  }

  # Rune glow + halo
  if ($t -ge 2) {
    Apply-Rarity-Glow $bmp 'epic'
  }
}

# ── Storage ──
function Draw-Building-Storage {
  param($bmp, [int]$level)
  Rng-Init "storage-$level"
  $t = Tier-Index $level 4
  $cx = 24
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 1) 12

  $bw = 16 + $t * 2
  $bh = 18 + $t * 2
  $bx = $cx - [int]($bw / 2)
  $by = $GROUND_Y_B - $bh
  Shade-Box $bmp $bx $by $bw $bh $MAT_WOOD_DARK -RimLight

  # Iron hoops
  foreach ($yy in @(($by + 3), ($by + 9), ($by + 14))) {
    Fill-Box $bmp $bx $yy $bw 1 $MAT_STEEL.shadow
    Fill-Box $bmp $bx ($yy + 1) $bw 1 $MAT_STEEL.high
    # Rivets along hoop
    for ($x = ($bx + 2); $x -lt ($bx + $bw); $x += 4) {
      Set-Pixel $bmp $x $yy $MAT_STEEL.top
    }
  }

  # Wood plank vertical lines
  for ($x = ($bx + 3); $x -lt ($bx + $bw); $x += 4) {
    for ($y = $by; $y -lt ($by + $bh); $y++) {
      if (($y - $by) % 3 -ne 0) {
        Set-Pixel $bmp $x $y $MAT_WOOD_DARK.deep
      }
    }
  }

  # Lid + padlock
  Fill-Box $bmp $bx ($by - 1) $bw 1 $MAT_WOOD_DARK.deep
  Fill-Box $bmp ($bx + 2) ($by - 2) ($bw - 4) 1 $MAT_WOOD_DARK.shadow
  Fill-Box $bmp ($bx + 3) ($by - 3) ($bw - 6) 1 $MAT_WOOD_DARK.base
  # Padlock
  $lockX = $cx
  $lockY = $by + 6
  Shade-Box $bmp ($lockX - 1) $lockY 3 4 $MAT_GOLD
  Set-Pixel $bmp $lockX ($lockY + 2) $MAT_GOLD.deep
  # Shackle
  Set-Pixel $bmp ($lockX - 1) ($lockY - 1) $MAT_GOLD.shadow
  Set-Pixel $bmp $lockX ($lockY - 1) $MAT_GOLD.high
  Set-Pixel $bmp ($lockX + 1) ($lockY - 1) $MAT_GOLD.shadow

  # Overflow piles (top tier — coins spilling)
  if ($t -ge 2) {
    Set-Pixel $bmp ($bx + 1) ($GROUND_Y_B - 1) $MAT_GOLD.top
    Set-Pixel $bmp ($bx + 2) ($GROUND_Y_B - 1) $MAT_GOLD.high
    Set-Pixel $bmp ($bx + 1) $GROUND_Y_B $MAT_GOLD.base
    Set-Pixel $bmp ($bx + $bw - 2) $GROUND_Y_B $MAT_GOLD.base
    Set-Pixel $bmp ($bx + $bw - 1) ($GROUND_Y_B - 1) $MAT_GOLD.top
  }
  # Side barrels (top tier)
  if ($t -ge 3) {
    foreach ($dir in @(-1, 1)) {
      $sbx = $cx + $dir * ([int]($bw / 2) + 3)
      $sbw = 5; $sbh = 8
      Shade-Box $bmp ($sbx - [int]($sbw / 2)) ($GROUND_Y_B - $sbh) $sbw $sbh $MAT_WOOD_DARK
      Fill-Box $bmp ($sbx - [int]($sbw / 2)) ($GROUND_Y_B - $sbh + 1) $sbw 1 $MAT_STEEL.base
      Fill-Box $bmp ($sbx - [int]($sbw / 2)) ($GROUND_Y_B - 2) $sbw 1 $MAT_STEEL.base
    }
  }
}

# ── Barracks ──
function Draw-Building-Barracks {
  param($bmp, [int]$level)
  Rng-Init "barracks-$level"
  $t = Tier-Index $level 4
  $cx = 24
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 1) 14

  $bw = 28 + $t * 2
  $bh = 12
  $bx = $cx - [int]($bw / 2)
  $by = $GROUND_Y_B - $bh
  Shade-Box $bmp $bx $by $bw $bh $MAT_STONE -RimLight
  # Stone courses
  for ($y = $by + 3; $y -lt ($by + $bh - 1); $y += 3) {
    for ($x = ($bx + 1); $x -lt ($bx + $bw - 1); $x++) {
      Set-Pixel $bmp $x $y $MAT_STONE.shadow
    }
  }
  # Door — wide archway
  $dw = 6
  $dx = $cx - [int]($dw / 2)
  $dy = $GROUND_Y_B - 7
  Fill-Box $bmp $dx $dy $dw 7 $MAT_WOOD_DARK.deep
  Set-Pixel $bmp $dx ($dy - 1) $MAT_STONE.shadow
  Set-Pixel $bmp ($dx + $dw - 1) ($dy - 1) $MAT_STONE.shadow
  # Door bands
  Fill-Box $bmp $dx ($dy + 2) $dw 1 $MAT_STEEL.base
  Fill-Box $bmp $dx ($dy + 5) $dw 1 $MAT_STEEL.base
  # Windows — glowing yellow
  Fill-Box $bmp ($bx + 3) ($by + 3) 3 3 $MAT_GOLD.base
  Fill-Box $bmp ($bx + 3) ($by + 3) 3 1 $MAT_GOLD.top
  Fill-Box $bmp ($bx + $bw - 6) ($by + 3) 3 3 $MAT_GOLD.base
  Fill-Box $bmp ($bx + $bw - 6) ($by + 3) 3 1 $MAT_GOLD.top
  Set-Pixel $bmp ($bx + 4) ($by + 4) $MAT_WOOD_DARK.deep  # window cross
  Set-Pixel $bmp ($bx + $bw - 5) ($by + 4) $MAT_WOOD_DARK.deep

  # Peaked roof
  $rH = 8 + $t
  for ($i = 0; $i -lt $rH; $i++) {
    $rW = $bw - ($i * 2)
    if ($rW -le 0) { break }
    $rX = $cx - [int]($rW / 2)
    $rY = $by - 1 - $i
    Fill-Box $bmp $rX $rY $rW 1 $MAT_WOOD_DARK.base
    Set-Pixel $bmp $rX $rY $MAT_WOOD_DARK.shadow
    Set-Pixel $bmp ($rX + $rW - 1) $rY $MAT_WOOD_DARK.high
    if (($i % 2) -eq 0) {
      Fill-Box $bmp $rX $rY $rW 1 $MAT_WOOD_DARK.shadow
      Set-Pixel $bmp ($rX + 1) $rY $MAT_WOOD_DARK.high
    }
  }
  # Roof eaves shadow
  Fill-Box $bmp $bx ($by - 1) $bw 1 $MAT_WOOD_DARK.deep

  # Flag at peak
  if ($t -ge 1) {
    Set-Pixel $bmp $cx ($by - 1 - $rH) $MAT_GOLD.top
    Set-Pixel $bmp $cx ($by - 2 - $rH) $MAT_STEEL.high
    Fill-Box $bmp ($cx + 1) ($by - 2 - $rH) 4 2 $BRAND.Violet
    Set-Pixel $bmp ($cx + 1) ($by - 2 - $rH) $MAT_GOLD.high
  }
  # Crossed weapons over door (top tier)
  if ($t -ge 2) {
    Line-Pixel $bmp ($cx - 4) ($GROUND_Y_B - 1) ($cx - 1) ($dy - 1) $MAT_STEEL.base
    Line-Pixel $bmp ($cx + 4) ($GROUND_Y_B - 1) ($cx + 1) ($dy - 1) $MAT_STEEL.base
    Set-Pixel $bmp ($cx - 4) ($GROUND_Y_B - 1) $MAT_LEATHER.base
    Set-Pixel $bmp ($cx + 4) ($GROUND_Y_B - 1) $MAT_LEATHER.base
  }
}

# ── War Tent ──
function Draw-Building-WarTent {
  param($bmp, [int]$level)
  Rng-Init "warTent-$level"
  $t = Tier-Index $level 3
  $cx = 24
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 1) 13

  $h = 20 + $t * 4
  $baseW = 26
  $tipY = $GROUND_Y_B - $h
  $tentCol = $BRAND.Crimson
  $tentDk = (Color-FromHex '#8a1818')
  $tentHi = (Color-FromHex '#ff7060')

  # Triangular pyramid shape
  for ($i = 0; $i -lt $h; $i++) {
    $w = [int]([Math]::Min($baseW, ($baseW * $i) / [Math]::Max(1, $h * 0.85)))
    if ($w -lt 2) { $w = 2 }
    $x0 = $cx - [int]($w / 2)
    $y = $tipY + $i
    Fill-Box $bmp $x0 $y $w 1 $tentCol
    Set-Pixel $bmp $x0 $y $tentDk
    Set-Pixel $bmp ($x0 + $w - 1) $y $tentDk
    Set-Pixel $bmp ($x0 + 1) $y $tentHi
    # Vertical stripe seam down centre
    if (($i % 4) -eq 0) {
      Set-Pixel $bmp $cx $y $tentDk
    }
  }

  # Door slit (dark trapezoid)
  Fill-Box $bmp ($cx - 2) ($GROUND_Y_B - 7) 4 7 $BRAND.Ink
  # Tied-back curtain flaps
  Set-Pixel $bmp ($cx - 3) ($GROUND_Y_B - 1) $tentHi
  Set-Pixel $bmp ($cx + 3) ($GROUND_Y_B - 1) $tentHi

  # Banner pole at tip
  Set-Pixel $bmp $cx ($tipY - 1) $MAT_WOOD_DARK.base
  Set-Pixel $bmp $cx ($tipY - 2) $MAT_WOOD_DARK.high
  Set-Pixel $bmp $cx ($tipY - 3) $MAT_GOLD.top
  if ($t -ge 1) {
    Draw-Pennant $bmp ($cx + 1) ($tipY - 3) $BRAND.Violet
  }
  # Second flag
  if ($t -ge 2) {
    Set-Pixel $bmp $cx ($tipY - 4) $MAT_GOLD.top
    Draw-Pennant $bmp ($cx + 1) ($tipY - 5) $BRAND.Gold
  }
  # Crossed swords flanking door (top tier)
  if ($t -ge 2) {
    foreach ($side in @(-1, 1)) {
      $sx = $cx + $side * 5
      Line-Pixel $bmp $sx ($GROUND_Y_B - 5) ($sx + $side) ($GROUND_Y_B - 1) $MAT_STEEL.base
      Set-Pixel $bmp $sx ($GROUND_Y_B - 5) $MAT_STEEL.top
      Set-Pixel $bmp ($sx + $side) ($GROUND_Y_B - 6) $MAT_STEEL.base
    }
  }
}

# Building dispatcher
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

# Catalogue mirror
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
      $bmp = New-CanvasFx $BUILDING_W $BUILDING_H
      Draw-Building $bmp $kind $lv
      Save-CanvasFx $bmp (Join-Path $buildingDir ("{0}-L{1}.png" -f $kind, $lv))
      $total++
    }
    Write-Host ("  {0}: L1..L{1}" -f $kind, $maxLevel) -ForegroundColor Gray
  }
  Write-Host ("  total building sprites: {0}" -f $total) -ForegroundColor Green
}

# ── Troops (32×32) ──
# Each troop is a small humanoid silhouette: head + body + weapon +
# accessory. Rarity drives palette pop. Same HD bar — proper material
# shading, rim light, glow halo for epic.

function Draw-Troop-Base {
  param($bmp, $skinRamp, $clothRamp)
  $cx = 16
  # Head (5x5 oval)
  Shade-Oval $bmp $cx 7 2.8 2.8 $skinRamp
  # Eyes
  Set-Pixel $bmp ($cx - 1) 7 $BRAND.Ink
  Set-Pixel $bmp ($cx + 1) 7 $BRAND.Ink
  Set-Pixel $bmp $cx 8 $skinRamp.shadow      # nose
  Set-Pixel $bmp $cx 9 $skinRamp.deep        # mouth
  # Body
  Shade-Box $bmp ($cx - 4) 11 8 9 $clothRamp -RimLight
  # Belt
  Fill-Box $bmp ($cx - 4) 18 8 1 $MAT_LEATHER.deep
  Fill-Box $bmp ($cx - 4) 19 8 1 $MAT_LEATHER.base
  Set-Pixel $bmp $cx 18 $MAT_GOLD.top
  # Legs
  Shade-Box $bmp ($cx - 4) 20 3 8 $clothRamp
  Shade-Box $bmp ($cx + 1) 20 3 8 $clothRamp
  # Boots
  Fill-Box $bmp ($cx - 4) 27 3 2 $MAT_LEATHER.deep
  Fill-Box $bmp ($cx + 1) 27 3 2 $MAT_LEATHER.deep
  Set-Pixel $bmp ($cx - 3) 27 $MAT_LEATHER.high
  Set-Pixel $bmp ($cx + 2) 27 $MAT_LEATHER.high
  # Arms
  Fill-Box $bmp ($cx - 5) 12 1 7 $clothRamp.base
  Fill-Box $bmp ($cx + 4) 12 1 7 $clothRamp.base
  Set-Pixel $bmp ($cx - 5) 12 $clothRamp.high
  Set-Pixel $bmp ($cx + 4) 12 $clothRamp.high
  # Hands
  Set-Pixel $bmp ($cx - 5) 19 $skinRamp.base
  Set-Pixel $bmp ($cx + 4) 19 $skinRamp.base
  # Ground shadow
  $shadow = (Color-FromHex '#050510')
  for ($i = -4; $i -le 4; $i++) {
    $a = 130 - [Math]::Abs($i) * 18
    if ($a -lt 30) { continue }
    Blend-Pixel $bmp ($cx + $i) 30 (With-Alpha $shadow $a)
  }
}

$SKIN_BASE = @{
  deep   = (Color-FromHex '#6a4828');
  shadow = (Color-FromHex '#a07048');
  base   = (Color-FromHex '#e7c299');
  high   = (Color-FromHex '#ffd8b8');
  top    = (Color-FromHex '#ffeacc');
}

function Draw-Troop-Scrapper {
  param($bmp)
  Rng-Init "scrapper"
  Draw-Troop-Base $bmp $SKIN_BASE $MAT_LEATHER
  # Bandana
  Fill-Box $bmp 13 5 6 1 $BRAND.Crimson
  Set-Pixel $bmp 13 5 (Color-FromHex '#8a1818')
  # Wrench in right hand
  for ($y = 0; $y -lt 7; $y++) {
    Set-Pixel $bmp 22 (13 + $y) $MAT_WOOD_DARK.base
    Set-Pixel $bmp 21 (13 + $y) $MAT_WOOD_DARK.shadow
  }
  Shade-Box $bmp 21 10 4 3 $MAT_STEEL -RimLight
  Set-Pixel $bmp 24 11 $MAT_STEEL.top
}

function Draw-Troop-BoltKnight {
  param($bmp)
  Rng-Init "boltKnight"
  Draw-Troop-Base $bmp $SKIN_BASE $MAT_STEEL
  # Helmet
  Shade-Box $bmp 13 4 6 6 $MAT_STEEL -RimLight
  Fill-Box $bmp 13 7 6 1 $BRAND.Ink   # visor slit
  Set-Pixel $bmp 16 4 $MAT_STEEL.top   # peak
  # Pauldrons
  Shade-Box $bmp 11 11 3 3 $MAT_STEEL
  Shade-Box $bmp 18 11 3 3 $MAT_STEEL
  # Voltaic gem on chest
  Draw-Gem $bmp 16 14 3 $GEM_VOLTAIC
  # Sword in right hand
  Draw-Blade $bmp 23 5 14 3 $MAT_STEEL -Fuller
  Fill-Box $bmp 22 15 3 1 $MAT_STEEL.base   # crossguard
  Draw-Grip $bmp 23 16 18 1 $MAT_LEATHER
}

function Draw-Troop-Archer {
  param($bmp)
  Rng-Init "archerLite"
  Draw-Troop-Base $bmp $SKIN_BASE $MAT_WOOD_DARK
  # Hood drape
  Fill-Box $bmp 13 4 6 3 $MAT_WOOD_DARK.deep
  Set-Pixel $bmp 16 4 $MAT_WOOD_DARK.high
  # Quiver on back
  Fill-Box $bmp 19 11 2 7 $MAT_LEATHER.deep
  Set-Pixel $bmp 19 11 $MAT_LEATHER.high
  # Arrow fletches sticking out top
  Set-Pixel $bmp 19 10 (Color-FromHex '#e0d0b0')
  Set-Pixel $bmp 20 10 (Color-FromHex '#e0d0b0')
  Set-Pixel $bmp 19 9 $MAT_WOOD_DARK.high
  Set-Pixel $bmp 20 9 $MAT_WOOD_DARK.high
  # Bow held vertically in left hand
  for ($y = 0; $y -lt 14; $y++) {
    $offset = if ($y -lt 7) { [int]([Math]::Sin(($y / 7.0) * [Math]::PI) * 2) } else { [int]([Math]::Sin((($y - 7) / 7.0) * [Math]::PI) * 2) }
    Set-Pixel $bmp (10 - $offset) (8 + $y) $MAT_WOOD_DARK.base
    Set-Pixel $bmp (11 - $offset) (8 + $y) $MAT_WOOD_DARK.high
    Set-Pixel $bmp (9 - $offset)  (8 + $y) $MAT_WOOD_DARK.shadow
  }
  # Bowstring (vertical)
  for ($y = 9; $y -lt 22; $y++) {
    Set-Pixel $bmp 12 $y (Color-FromHex '#f0e6c8')
  }
  # Arrow nocked
  for ($x = 13; $x -lt 17; $x++) {
    Set-Pixel $bmp $x 15 $MAT_WOOD_DARK.high
  }
  Set-Pixel $bmp 17 15 $MAT_STEEL.top   # arrowhead
}

function Draw-Troop-VoltaicMage {
  param($bmp)
  Rng-Init "voltaicMage"
  $robe = @{
    deep = (Color-FromHex '#1a0c40');
    shadow = (Color-FromHex '#3a1f7a');
    base = $BRAND.Violet;
    high = $BRAND.VioletHi;
    top = (Color-FromHex '#d0c0ff');
  }
  Draw-Troop-Base $bmp $SKIN_BASE $robe
  # Pointed hat
  for ($i = 0; $i -lt 6; $i++) {
    $w = 6 - $i
    $x0 = 16 - [int]($w / 2)
    Fill-Box $bmp $x0 (10 - $i) $w 1 $robe.base
    Set-Pixel $bmp $x0 (10 - $i) $robe.shadow
    Set-Pixel $bmp ($x0 + $w - 1) (10 - $i) $robe.high
  }
  Set-Pixel $bmp 16 3 $BRAND.Gold
  # Brim
  Fill-Box $bmp 12 10 8 1 $robe.deep
  # Glowing green eyes
  Set-Pixel $bmp 15 7 (Color-FromHex '#5bff95')
  Set-Pixel $bmp 17 7 (Color-FromHex '#5bff95')
  # Sleeves (wider at hands)
  Fill-Box $bmp 10 17 2 3 $robe.shadow
  Fill-Box $bmp 20 17 2 3 $robe.shadow
  # Staff with orb at top
  for ($y = 6; $y -lt 22; $y++) {
    Set-Pixel $bmp 23 $y $MAT_WOOD_DARK.base
    Set-Pixel $bmp 22 $y $MAT_WOOD_DARK.shadow
  }
  # Orb at the top
  Shade-Disc $bmp 23 4 3 (PetRamp @{deep='#1a0c40'; shadow='#3a1f7a'; base='#7c5cff'; high='#cab8ff'; top='#ffffff'; eye='#5bff95'})
  Set-Pixel $bmp 23 3 (Color-FromHex '#5bff95')
  # Sparkle motes
  Set-Pixel $bmp 26 2 (Color-FromHex '#5bff95')
  Set-Pixel $bmp 20 3 (Color-FromHex '#a890ff')
  Set-Pixel $bmp 25 6 (Color-FromHex '#5bff95')
  # Belt buckle gold
  Set-Pixel $bmp 16 18 $MAT_GOLD.top
  Apply-Rarity-Glow $bmp 'epic'
}

# Shared helper used by VoltaicMage above — moved from build-sprites.ps1 form
function PetRamp { param([hashtable]$h)
  return @{
    deep   = Color-FromHex $h.deep;
    shadow = Color-FromHex $h.shadow;
    base   = Color-FromHex $h.base;
    high   = Color-FromHex $h.high;
    top    = Color-FromHex $h.top;
  }
}

function Draw-Troop-SapperRogue {
  param($bmp)
  Rng-Init "sapperRogue"
  Draw-Troop-Base $bmp $SKIN_BASE $MAT_LEATHER_BLACK
  # Hood
  Fill-Box $bmp 13 4 6 5 $MAT_LEATHER_BLACK.deep
  Set-Pixel $bmp 16 4 $MAT_LEATHER_BLACK.shadow
  # Mask — only eyes visible
  Fill-Box $bmp 13 7 6 1 $BRAND.Ink
  Set-Pixel $bmp 15 7 $BRAND.Crimson   # eye glint
  Set-Pixel $bmp 17 7 $BRAND.Crimson
  # Bomb in right hand
  Shade-Disc $bmp 22 13 2 $MAT_OBSIDIAN
  # Fuse
  Set-Pixel $bmp 22 11 $MAT_WOOD_DARK.high
  Set-Pixel $bmp 22 10 $MAT_WOOD_DARK.base
  Set-Pixel $bmp 23 9 $MAT_GOLD.top
  Set-Pixel $bmp 22 9 $BRAND.Crimson  # spark
  # Belt of charges
  Set-Pixel $bmp 13 18 $BRAND.Crimson
  Set-Pixel $bmp 16 18 $BRAND.Crimson
  Set-Pixel $bmp 19 18 $BRAND.Crimson
  # Knife in left hand
  Draw-Blade $bmp 9 13 19 2 $MAT_STEEL
}

function Draw-Troop-HealerCleric {
  param($bmp)
  Rng-Init "healerCleric"
  $robe = $MAT_CLOTH_LINEN
  Draw-Troop-Base $bmp $SKIN_BASE $robe
  # Hood
  Fill-Box $bmp 13 4 6 5 $robe.shadow
  Set-Pixel $bmp 16 4 $robe.high
  # Halo above head
  $glow = With-Alpha (Color-FromHex '#fff0a0') 200
  for ($x = 13; $x -lt 20; $x++) {
    Blend-Pixel $bmp $x 2 $glow
  }
  Set-Pixel $bmp 14 1 (With-Alpha (Color-FromHex '#fff0a0') 150)
  Set-Pixel $bmp 18 1 (With-Alpha (Color-FromHex '#fff0a0') 150)
  # Holy cross on chest
  Fill-Box $bmp 16 13 1 5 $MAT_GOLD.base
  Fill-Box $bmp 14 15 5 1 $MAT_GOLD.base
  Set-Pixel $bmp 16 13 $MAT_GOLD.top
  Set-Pixel $bmp 14 15 $MAT_GOLD.high
  # Staff with green orb (healing)
  for ($y = 6; $y -lt 22; $y++) {
    Set-Pixel $bmp 23 $y $MAT_WOOD_DARK.base
    Set-Pixel $bmp 22 $y $MAT_WOOD_DARK.shadow
  }
  Shade-Disc $bmp 23 4 3 (PetRamp @{deep='#1a3a30'; shadow='#2f8a78'; base='#5fc4a8'; high='#92e6cd'; top='#bdf5e0'})
  Set-Pixel $bmp 23 3 (Color-FromHex '#5bff95')
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

$TROOPS = @('scrapper', 'boltKnight', 'archerLite', 'voltaicMage', 'sapperRogue', 'healerCleric')

function Build-Troops {
  Write-Host '── Clash troop sprites ──' -ForegroundColor Cyan
  foreach ($troopId in $TROOPS) {
    $bmp = New-CanvasFx $TROOP_W $TROOP_H
    Draw-Troop $bmp $troopId
    Save-CanvasFx $bmp (Join-Path $troopDir ("{0}.png" -f $troopId))
  }
  Write-Host ("  troops: {0}" -f $TROOPS.Count) -ForegroundColor Green
}

# Apply-Rarity-Glow lives in build-sprites.ps1 in the character build,
# but is general-purpose. Local copy for this script.
function Apply-Rarity-Glow {
  param($bmp, [string]$rarity)
  $color = switch ($rarity) {
    'common'    { Color-FromHex '#a8a8b0' }
    'uncommon'  { Color-FromHex '#5be098' }
    'rare'      { Color-FromHex '#6ec0ff' }
    'epic'      { Color-FromHex '#cb9aff' }
    'legendary' { Color-FromHex '#fff0a0' }
    default     { Color-FromHex '#cb9aff' }
  }
  Add-GlowHalo $bmp $color 2 110
}

Build-Buildings
Build-Troops

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "Output: $clashDir"
