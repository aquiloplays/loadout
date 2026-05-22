# Clash v2 HD sprite generator — 96×96 buildings / 64×64 troops.
#
# CLASH-EXPANSION-DESIGN.md §9 — "current sprites render too small".
# v2 doubles the linear scale, packs more detail per sprite (course
# joints, individual shingles, rivet rings on barrels, pennant
# stitching), and adds all the new kinds from E1 + E3 (collectors,
# vaults, defenses, traps, troops).
#
# Output paths (committed to git):
#   aquilo-gg/sprites/clash-v2/buildings/<kind>-L<level>.png
#   aquilo-gg/sprites/clash-v2/buildings/wall-L<n>-<bitmask2>.png  (16 per level)
#   aquilo-gg/sprites/clash-v2/troops/<troopId>.png
#
# The v1 sprite paths (clash/...) stay live for the legacy OBS overlay.
# The clash-v2 paths are what the new editor + Twitch panel read,
# emitted by spriteIdForBuildingV2 in discord-bot/clash-content.js.
#
# Regenerate from scratch:
#   pwsh -ExecutionPolicy Bypass -File tools/build-clash-sprites-v2.ps1

[CmdletBinding()]
param(
  [string]$OutRoot = '',
  [string[]]$Only = @()   # optional list of kinds to render (skip everything else)
)
$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $OutRoot) {
  $OutRoot = Join-Path (Split-Path -Parent $scriptDir) 'aquilo-gg/sprites'
}
. (Join-Path $scriptDir 'lib-pixel.ps1')

$clashDir    = Join-Path $OutRoot 'clash-v2'
$buildingDir = Join-Path $clashDir 'buildings'
$troopDir    = Join-Path $clashDir 'troops'
$backdropDir = Join-Path $clashDir 'backdrop'
foreach ($d in @($clashDir, $buildingDir, $troopDir, $backdropDir)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# 2× v1 canvas. Bottom-centre anchored so multi-cell footprints line up.
$BUILDING_W = 96
$BUILDING_H = 96
$TROOP_W    = 64
$TROOP_H    = 64
$GROUND_Y_B = 92
$GROUND_Y_T = 60

# Tier bucket from level/maxLevel — same logic as v1 so visual tiers
# step in lockstep with the 1×→3× sprite rebuild.
function Tier-Index {
  param([int]$level, [int]$maxLevel)
  if ($level -le 1) { return 0 }
  if ($maxLevel -le 3) { return [Math]::Min(2, $level - 1) }
  $third = [Math]::Max(1, [int]($maxLevel / 3))
  if ($level -le $third)         { return 1 }
  if ($level -le ($third * 2))   { return 2 }
  return 3
}

function Should-Render {
  param([string]$kind)
  if (-not $Only -or $Only.Count -eq 0) { return $true }
  return ($Only -contains $kind)
}

# Wide ground shadow under building.
function Draw-GroundShadow {
  param($bmp, [int]$cx, [int]$y, [int]$halfW)
  $shadow = (Color-FromHex '#040510')
  for ($dx = -$halfW; $dx -le $halfW; $dx++) {
    $a = 170 - [Math]::Abs($dx) * (150 / [Math]::Max(1, $halfW))
    if ($a -lt 20) { continue }
    Blend-Pixel $bmp ($cx + $dx) $y (With-Alpha $shadow ([int]$a))
  }
  for ($dx = -$halfW + 3; $dx -le ($halfW - 3); $dx++) {
    Blend-Pixel $bmp ($cx + $dx) ($y - 1) (With-Alpha $shadow 70)
  }
  for ($dx = -$halfW + 5; $dx -le ($halfW - 5); $dx++) {
    Blend-Pixel $bmp ($cx + $dx) ($y - 2) (With-Alpha $shadow 30)
  }
}

function Apply-Rarity-Glow {
  param($bmp, [string]$rarity, [int]$radius = 3, [int]$alpha = 110)
  $color = switch ($rarity) {
    'common'    { Color-FromHex '#a8a8b0' }
    'uncommon'  { Color-FromHex '#5be098' }
    'rare'      { Color-FromHex '#6ec0ff' }
    'epic'      { Color-FromHex '#cb9aff' }
    'legendary' { Color-FromHex '#fff0a0' }
    default     { Color-FromHex '#cb9aff' }
  }
  Add-GlowHalo $bmp $color $radius $alpha
}

# Triangle pennant flag — 6×4 with crimson body.
function Draw-Pennant-V2 {
  param($bmp, [int]$px, [int]$py, $color)
  for ($i = 0; $i -lt 6; $i++) {
    for ($j = 0; $j -lt 4; $j++) {
      if ($i -ge ($j + 3)) { continue }  # cut diagonal taper
      Set-Pixel $bmp ($px + $i) ($py + $j) $color
    }
  }
  Set-Pixel $bmp ($px + 1) ($py + 1) (Mix-Color $color (Color-FromHex '#ffffff') 0.35)
}

# Crenellated parapet — row of merlons above the top edge.
function Draw-Crenel {
  param($bmp, [int]$x0, [int]$y0, [int]$width, [int]$merlonW, [int]$merlonH, $ramp)
  for ($i = $x0; $i -lt ($x0 + $width); $i += ($merlonW * 2)) {
    Fill-Box $bmp $i ($y0 - $merlonH) $merlonW $merlonH $ramp.base
    Fill-Box $bmp $i ($y0 - $merlonH) $merlonW 1 $ramp.high
    Set-Pixel $bmp ($i + $merlonW - 1) ($y0 - $merlonH) $ramp.shadow
  }
}

# Shingle-tiled pitched roof — overlapping rows.
function Draw-Roof-Shingled {
  param($bmp, [int]$cx, [int]$baseY, [int]$baseW, [int]$peakH, $ramp)
  $rows = [Math]::Max(3, [int]($peakH / 2))
  for ($r = 0; $r -lt $peakH; $r++) {
    $w = $baseW - ($r * 2)
    if ($w -le 0) { break }
    $x0 = $cx - [int]($w / 2)
    $col = if (($r % 3) -eq 0) { $ramp.shadow } else { $ramp.base }
    Fill-Box $bmp $x0 ($baseY - $r) $w 1 $col
    Set-Pixel $bmp $x0 ($baseY - $r) $ramp.deep
    Set-Pixel $bmp ($x0 + $w - 1) ($baseY - $r) $ramp.shadow
    # Shingle pattern — every other column gets a notch
    if (($r % 2) -eq 0) {
      for ($x = $x0 + 2; $x -lt ($x0 + $w - 1); $x += 4) {
        Set-Pixel $bmp $x ($baseY - $r) $ramp.deep
      }
    }
  }
  Set-Pixel $bmp $cx ($baseY - $peakH) $ramp.top
}

# ── Buildings ───────────────────────────────────────────────────────

# Town Hall — flagship building, 96×96 canvas, scaled per level tier.
function Draw-Building-TownHall {
  param($bmp, [int]$level)
  Rng-Init "townhall-$level"
  $t = Tier-Index $level 10
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 30

  # Stone base
  $baseW = 48 + ($t * 4)
  $baseH = 28 + ($t * 4)
  $baseX = $cx - [int]($baseW / 2)
  $baseY = $GROUND_Y_B - $baseH
  Shade-Box $bmp $baseX $baseY $baseW $baseH $MAT_STONE -RimLight

  # Stone courses
  for ($y = $baseY + 6; $y -lt ($baseY + $baseH - 1); $y += 7) {
    for ($x = ($baseX + 1); $x -lt ($baseX + $baseW - 1); $x++) {
      Set-Pixel $bmp $x $y $MAT_STONE.shadow
    }
    $shift = ([int](($y - $baseY) / 7) % 2) * 5
    for ($x = ($baseX + 4 + $shift); $x -lt ($baseX + $baseW); $x += 9) {
      for ($v = 0; $v -lt 6; $v++) {
        if (($y - $v) -gt $baseY) { Set-Pixel $bmp $x ($y - $v) $MAT_STONE.shadow }
      }
    }
  }

  # Wooden door arch
  $doorW = 12 + $t * 2
  $doorH = 14 + $t * 2
  $doorX = $cx - [int]($doorW / 2)
  $doorY = $GROUND_Y_B - $doorH
  Shade-Box $bmp $doorX $doorY $doorW $doorH $MAT_WOOD_DARK
  # Door planks
  for ($x = $doorX + 2; $x -lt ($doorX + $doorW - 1); $x += 3) {
    for ($y = $doorY + 1; $y -lt ($doorY + $doorH - 1); $y++) {
      Set-Pixel $bmp $x $y $MAT_WOOD_DARK.deep
    }
  }
  # Arch trim
  for ($x = $doorX; $x -lt ($doorX + $doorW); $x++) {
    Set-Pixel $bmp $x ($doorY - 1) $MAT_STONE.high
    Set-Pixel $bmp $x ($doorY - 2) $MAT_STONE.base
  }
  Set-Pixel $bmp $doorX ($doorY - 2) $MAT_STONE.shadow
  Set-Pixel $bmp ($doorX + $doorW - 1) ($doorY - 2) $MAT_STONE.shadow
  # Gold band on door
  if ($t -ge 1) {
    Fill-Box $bmp $doorX ($doorY + [int]($doorH / 2)) $doorW 2 $MAT_GOLD.base
    Fill-Box $bmp $doorX ($doorY + [int]($doorH / 2)) $doorW 1 $MAT_GOLD.high
  }
  # Door handle
  Set-Pixel $bmp ($doorX + 2) ($doorY + [int]($doorH / 2) + 2) $MAT_GOLD.top
  Set-Pixel $bmp ($doorX + $doorW - 3) ($doorY + [int]($doorH / 2) + 2) $MAT_GOLD.top

  # Crenellations on base
  Draw-Crenel $bmp $baseX $baseY $baseW 4 3 $MAT_STONE

  # Central tower
  $towerW = 18 + $t * 3
  $towerH = 20 + $t * 5
  $towerX = $cx - [int]($towerW / 2)
  $towerY = $baseY - $towerH
  Shade-Box $bmp $towerX $towerY $towerW $towerH $MAT_STONE -RimLight
  # Tower courses
  for ($y = $towerY + 5; $y -lt ($towerY + $towerH - 1); $y += 6) {
    for ($x = ($towerX + 1); $x -lt ($towerX + $towerW - 1); $x++) {
      Set-Pixel $bmp $x $y $MAT_STONE.shadow
    }
  }
  # Window — gold glow
  $winY = $towerY + 6 + $t
  $winX = $cx - 2
  Fill-Box $bmp $winX $winY 4 5 $BRAND.Ink
  for ($x = 0; $x -lt 4; $x++) {
    Set-Pixel $bmp ($winX + $x) ($winY + 1) $MAT_GOLD.base
    Set-Pixel $bmp ($winX + $x) ($winY + 2) $MAT_GOLD.high
    Set-Pixel $bmp ($winX + $x) ($winY + 3) $MAT_GOLD.base
  }
  Set-Pixel $bmp ($winX + 1) ($winY + 2) $MAT_GOLD.top
  # Arched window top
  Set-Pixel $bmp $winX $winY $MAT_STONE.deep
  Set-Pixel $bmp ($winX + 3) $winY $MAT_STONE.deep

  # Conical roof
  if ($t -ge 1) {
    $roofH = 7 + $t * 2
    Draw-Roof-Shingled $bmp $cx ($towerY - 1) ($towerW + 2) $roofH $MAT_WOOD_DARK
    Set-Pixel $bmp $cx ($towerY - $roofH - 1) $MAT_GOLD.top
    Set-Pixel $bmp $cx ($towerY - $roofH - 2) $MAT_GOLD.high
  }

  # Flagpole + pennant
  if ($t -ge 2) {
    $px = $cx + 6
    $py = $towerY - 6
    for ($i = 0; $i -lt 10; $i++) {
      Set-Pixel $bmp $px ($py - $i) $MAT_STEEL.base
    }
    Set-Pixel $bmp $px ($py - 10) $MAT_GOLD.top
    Draw-Pennant-V2 $bmp ($px + 1) ($py - 9) $BRAND.Crimson
  }

  # Flanking towers
  if ($t -ge 3) {
    foreach ($dir in @(-1, 1)) {
      $sx = $cx + $dir * ([int]($baseW / 2) - 4)
      $stH = 10
      $stW = 6
      Shade-Box $bmp ($sx - 2) ($baseY - $stH) $stW $stH $MAT_STONE
      # Mini-pennant
      Set-Pixel $bmp $sx ($baseY - $stH - 1) $MAT_STEEL.base
      Set-Pixel $bmp $sx ($baseY - $stH - 2) $MAT_STEEL.base
      Set-Pixel $bmp ($sx + 1) ($baseY - $stH - 2) $BRAND.Violet
      Set-Pixel $bmp ($sx + 2) ($baseY - $stH - 2) $BRAND.Violet
    }
  }

  if ($level -ge 9) { Apply-Rarity-Glow $bmp 'legendary' 3 130 }
  elseif ($level -ge 6) { Apply-Rarity-Glow $bmp 'epic' 2 80 }
}

# ── Wall renderer with 4-bit bitmask ───────────────────────────────
#
# Per CLASH-EXPANSION-DESIGN.md §6.3: each wall segment is 1×1 and
# the sprite variant depends on a 4-bit N/E/S/W neighbor mask. We
# render the segment as a stout stone block + connectors extending
# outward for each set bit.

function Draw-Wall-V2 {
  param($bmp, [int]$level, [int]$mask4)
  Rng-Init "wall-$level-$mask4"
  $t = Tier-Index $level 8
  $cx = 48
  $cy = $GROUND_Y_B - 22

  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 1) 22

  # Central post — taller as level rises
  $postW = 28
  $postH = 32 + $t * 4
  $postX = $cx - [int]($postW / 2)
  $postY = $cy - [int]($postH / 2)
  Shade-Box $bmp $postX $postY $postW $postH $MAT_STONE -RimLight
  # Brick courses
  for ($y = $postY + 5; $y -lt ($postY + $postH - 1); $y += 6) {
    $shift = ([int](($y - $postY) / 6) % 2) * 5
    for ($x = ($postX + 1); $x -lt ($postX + $postW - 1); $x++) {
      Set-Pixel $bmp $x $y $MAT_STONE.shadow
    }
    for ($x = ($postX + 4 + $shift); $x -lt ($postX + $postW); $x += 9) {
      for ($v = 0; $v -lt 4; $v++) {
        if (($y - $v) -gt $postY) { Set-Pixel $bmp $x ($y - $v) $MAT_STONE.shadow }
      }
    }
  }

  # Crenellations on top
  Draw-Crenel $bmp $postX $postY $postW 4 3 $MAT_STONE

  # Iron banding (mid+)
  if ($t -ge 1) {
    Fill-Box $bmp $postX ($postY + 4) $postW 2 $MAT_STEEL.base
    Fill-Box $bmp $postX ($postY + $postH - 6) $postW 2 $MAT_STEEL.base
    for ($x = ($postX + 3); $x -lt ($postX + $postW); $x += 6) {
      Draw-Rivet $bmp $x ($postY + 5) $MAT_STEEL
      Draw-Rivet $bmp $x ($postY + $postH - 5) $MAT_STEEL
    }
  }

  # Connectors — extend toward each set neighbor bit
  $connW = 16
  $connH = 22 + $t * 2
  $connY = $cy - [int]($connH / 2)

  # N (bit 8) — extend up
  if (($mask4 -band 8) -ne 0) {
    Fill-Box $bmp ($cx - 4) ($postY - 6) 8 6 $MAT_STONE.base
    for ($y = $postY - 6; $y -lt $postY; $y++) {
      Set-Pixel $bmp ($cx - 4) $y $MAT_STONE.high
      Set-Pixel $bmp ($cx + 3) $y $MAT_STONE.shadow
    }
  }
  # E (bit 4) — extend right
  if (($mask4 -band 4) -ne 0) {
    Fill-Box $bmp ($postX + $postW) ($connY + 4) 6 ($connH - 8) $MAT_STONE.base
    for ($x = ($postX + $postW); $x -lt ($postX + $postW + 6); $x++) {
      Set-Pixel $bmp $x ($connY + 4) $MAT_STONE.high
      Set-Pixel $bmp $x ($connY + $connH - 5) $MAT_STONE.shadow
    }
  }
  # S (bit 2) — extend down
  if (($mask4 -band 2) -ne 0) {
    Fill-Box $bmp ($cx - 4) ($postY + $postH) 8 6 $MAT_STONE.base
    for ($y = ($postY + $postH); $y -lt ($postY + $postH + 6); $y++) {
      Set-Pixel $bmp ($cx - 4) $y $MAT_STONE.high
      Set-Pixel $bmp ($cx + 3) $y $MAT_STONE.shadow
    }
  }
  # W (bit 1) — extend left
  if (($mask4 -band 1) -ne 0) {
    Fill-Box $bmp ($postX - 6) ($connY + 4) 6 ($connH - 8) $MAT_STONE.base
    for ($x = ($postX - 6); $x -lt $postX; $x++) {
      Set-Pixel $bmp $x ($connY + 4) $MAT_STONE.high
      Set-Pixel $bmp $x ($connY + $connH - 5) $MAT_STONE.shadow
    }
  }

  # Banner (top tier)
  if ($t -ge 2) {
    Fill-Box $bmp ($cx - 3) ($postY + 11) 7 8 $BRAND.Crimson
    Set-Pixel $bmp ($cx - 3) ($postY + 11) $MAT_GOLD.high
    Set-Pixel $bmp ($cx + 3) ($postY + 11) $MAT_GOLD.shadow
    Set-Pixel $bmp $cx ($postY + 15) $MAT_GOLD.top
  }

  if ($level -ge 7) { Apply-Rarity-Glow $bmp 'epic' 2 80 }
}

# Cannon — wood carriage + steel barrel, level adds extra rings.
function Draw-Building-Cannon {
  param($bmp, [int]$level)
  Rng-Init "cannon-$level"
  $t = Tier-Index $level 7
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 24

  # Carriage
  $cw = 42 + $t * 4
  $ch = 14
  $cy0 = $GROUND_Y_B - $ch
  $cx0 = $cx - [int]($cw / 2)
  Shade-Box $bmp $cx0 $cy0 $cw $ch $MAT_WOOD_DARK -RimLight
  # Wood plank lines
  for ($x = ($cx0 + 2); $x -lt ($cx0 + $cw - 1); $x += 4) {
    Fill-Box $bmp $x ($cy0 + 1) 1 ($ch - 2) $MAT_WOOD_DARK.shadow
  }
  # Iron bands at ends
  Fill-Box $bmp ($cx0 + 4) $cy0 2 $ch $MAT_STEEL.base
  Fill-Box $bmp ($cx0 + $cw - 6) $cy0 2 $ch $MAT_STEEL.base
  Draw-Rivet $bmp ($cx0 + 5) ($cy0 + 2) $MAT_STEEL
  Draw-Rivet $bmp ($cx0 + 5) ($cy0 + $ch - 3) $MAT_STEEL
  Draw-Rivet $bmp ($cx0 + $cw - 5) ($cy0 + 2) $MAT_STEEL
  Draw-Rivet $bmp ($cx0 + $cw - 5) ($cy0 + $ch - 3) $MAT_STEEL

  # Wheels — bigger
  Shade-Disc $bmp ($cx0 + 5) $GROUND_Y_B 5 $MAT_STEEL
  Shade-Disc $bmp ($cx0 + $cw - 6) $GROUND_Y_B 5 $MAT_STEEL
  # Wheel hubs
  Set-Pixel $bmp ($cx0 + 5) $GROUND_Y_B $MAT_GOLD.top
  Set-Pixel $bmp ($cx0 + $cw - 6) $GROUND_Y_B $MAT_GOLD.top
  # Wheel spokes (cross)
  Line-Pixel $bmp ($cx0 + 2) $GROUND_Y_B ($cx0 + 8) $GROUND_Y_B $MAT_STEEL.deep
  Line-Pixel $bmp ($cx0 + 5) ($GROUND_Y_B - 3) ($cx0 + 5) ($GROUND_Y_B + 3) $MAT_STEEL.deep
  Line-Pixel $bmp ($cx0 + $cw - 9) $GROUND_Y_B ($cx0 + $cw - 3) $GROUND_Y_B $MAT_STEEL.deep
  Line-Pixel $bmp ($cx0 + $cw - 6) ($GROUND_Y_B - 3) ($cx0 + $cw - 6) ($GROUND_Y_B + 3) $MAT_STEEL.deep

  # Barrel — sloped up-right, segmented rings
  $barLen = 28 + $t * 4
  $barW = 8 + [int]($t / 2)
  $bx0 = $cx + 2
  $by0 = $cy0 - 2
  for ($i = 0; $i -lt $barLen; $i++) {
    $bx = $bx0 + [int]($i * 0.75)
    $by = $by0 - [int]($i * 0.55)
    for ($w = 0; $w -lt $barW; $w++) {
      Set-Pixel $bmp $bx ($by + $w) $MAT_STEEL.base
    }
    Set-Pixel $bmp $bx $by $MAT_STEEL.high
    Set-Pixel $bmp $bx ($by + $barW - 1) $MAT_STEEL.shadow
    # Rings every 5px
    if (($i % 6) -eq 4) {
      for ($w = 0; $w -lt $barW; $w++) {
        Set-Pixel $bmp $bx ($by + $w) $MAT_STEEL.deep
      }
    }
  }
  # Muzzle flash hint (decorative)
  $tipX = $bx0 + [int]($barLen * 0.75)
  $tipY = $by0 - [int]($barLen * 0.55)
  Set-Pixel $bmp ($tipX + 1) ($tipY + 1) $MAT_STEEL.deep
  Set-Pixel $bmp ($tipX + 1) ($tipY + $barW - 2) $MAT_STEEL.deep

  if ($t -ge 2) {
    # Brass crest on carriage face
    Draw-Gem $bmp ($cx0 + 5) ($cy0 + 8) 5 $GEM_TOPAZ
  }
  if ($level -ge 6) { Apply-Rarity-Glow $bmp 'epic' 2 70 }
}

# Archer Tower — stone tower with shingled cap + crenellated platform.
function Draw-Building-ArcherTower {
  param($bmp, [int]$level)
  Rng-Init "archerTower-$level"
  $t = Tier-Index $level 7
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 26

  $tw = 28 + $t * 2
  $th = 50 + $t * 4
  $tx = $cx - [int]($tw / 2)
  $ty = $GROUND_Y_B - $th
  Shade-Box $bmp $tx $ty $tw $th $MAT_STONE -RimLight
  # Brick courses
  for ($y = $ty + 6; $y -lt ($ty + $th - 1); $y += 7) {
    $shift = ([int](($y - $ty) / 7) % 2) * 5
    for ($x = ($tx + 1); $x -lt ($tx + $tw - 1); $x++) {
      Set-Pixel $bmp $x $y $MAT_STONE.shadow
    }
    for ($x = ($tx + 3 + $shift); $x -lt ($tx + $tw); $x += 8) {
      for ($v = 0; $v -lt 5; $v++) {
        if (($y - $v) -gt $ty) { Set-Pixel $bmp $x ($y - $v) $MAT_STONE.shadow }
      }
    }
  }

  # Slot window
  $slotY = $ty + 22
  Fill-Box $bmp ($cx - 1) $slotY 2 7 $BRAND.Ink
  Set-Pixel $bmp ($cx - 2) ($slotY - 1) $MAT_STONE.deep
  Set-Pixel $bmp ($cx + 1) ($slotY - 1) $MAT_STONE.deep

  # Crenellated parapet
  Draw-Crenel $bmp $tx $ty $tw 4 4 $MAT_STONE

  # Shingled cap (mid+)
  if ($t -ge 1) {
    Draw-Roof-Shingled $bmp $cx ($ty - 1) ($tw + 2) (8 + $t * 2) $MAT_WOOD_DARK
  }

  # Archer silhouette in window
  if ($t -ge 1) {
    Set-Pixel $bmp ($cx - 1) ($slotY + 2) $MAT_LEATHER.deep
    Set-Pixel $bmp $cx ($slotY + 2) $MAT_LEATHER.deep
    Set-Pixel $bmp ($cx - 1) ($slotY + 4) $MAT_LEATHER.deep
  }

  # Pennant (top tier)
  if ($t -ge 2) {
    $px = $cx + [int]($tw / 2) + 1
    $py = $ty - 4
    for ($i = 0; $i -lt 6; $i++) {
      Set-Pixel $bmp $px ($py - $i) $MAT_STEEL.base
    }
    Draw-Pennant-V2 $bmp ($px + 1) ($py - 5) $BRAND.Violet
  }

  if ($level -ge 6) { Apply-Rarity-Glow $bmp 'epic' 2 70 }
}

# Storage — squat wooden coffer with iron bands, gold heart-glow on top.
function Draw-Building-Storage {
  param($bmp, [int]$level)
  Rng-Init "storage-$level"
  $t = Tier-Index $level 4
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 26

  $w = 56 + $t * 4
  $h = 36 + $t * 4
  $x0 = $cx - [int]($w / 2)
  $y0 = $GROUND_Y_B - $h
  Shade-Box $bmp $x0 $y0 $w $h $MAT_WOOD_DARK -RimLight
  # Plank lines
  for ($x = ($x0 + 4); $x -lt ($x0 + $w - 1); $x += 6) {
    Fill-Box $bmp $x ($y0 + 1) 1 ($h - 2) $MAT_WOOD_DARK.shadow
  }
  # Iron straps
  Fill-Box $bmp $x0 ($y0 + 4) $w 3 $MAT_STEEL.base
  Fill-Box $bmp $x0 ($y0 + $h - 7) $w 3 $MAT_STEEL.base
  Fill-Box $bmp $x0 ($y0 + 4) $w 1 $MAT_STEEL.high
  Fill-Box $bmp $x0 ($y0 + $h - 7) $w 1 $MAT_STEEL.high
  for ($x = ($x0 + 4); $x -lt ($x0 + $w); $x += 6) {
    Draw-Rivet $bmp $x ($y0 + 5) $MAT_STEEL
    Draw-Rivet $bmp $x ($y0 + $h - 6) $MAT_STEEL
  }

  # Padlock + clasp
  Fill-Box $bmp ($cx - 3) ($y0 + [int]($h / 2) - 4) 6 8 $MAT_GOLD.base
  Set-Pixel $bmp ($cx - 3) ($y0 + [int]($h / 2) - 4) $MAT_GOLD.high
  Set-Pixel $bmp ($cx + 2) ($y0 + [int]($h / 2) - 4) $MAT_GOLD.shadow
  Set-Pixel $bmp $cx ($y0 + [int]($h / 2)) $BRAND.Ink   # keyhole

  # Gold pile spilling over rim (mid+)
  if ($t -ge 1) {
    Draw-Roof-Shingled $bmp $cx ($y0 - 1) ($w - 6) 6 $MAT_GOLD
    # Coin sparkles
    Set-Pixel $bmp ($cx - 8) ($y0 - 3) $MAT_GOLD.top
    Set-Pixel $bmp ($cx + 6) ($y0 - 4) $MAT_GOLD.top
    Set-Pixel $bmp $cx ($y0 - 5) $MAT_GOLD.top
  }
  if ($level -ge 3) { Apply-Rarity-Glow $bmp 'legendary' 2 60 }
}

# Barracks — long tent + flag at one end.
function Draw-Building-Barracks {
  param($bmp, [int]$level)
  Rng-Init "barracks-$level"
  $t = Tier-Index $level 4
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 28

  $w = 56 + $t * 4
  $h = 32 + $t * 2
  $x0 = $cx - [int]($w / 2)
  $y0 = $GROUND_Y_B - $h

  # Canvas tent body — diagonal stripes
  $cloth = $MAT_CLOTH_LINEN
  Shade-Box $bmp $x0 ($y0 + 8) $w ($h - 8) $cloth -RimLight
  for ($y = ($y0 + 10); $y -lt ($y0 + $h); $y += 4) {
    for ($x = ($x0 + 2); $x -lt ($x0 + $w); $x += 6) {
      Set-Pixel $bmp $x $y $cloth.shadow
      Set-Pixel $bmp ($x + 1) $y $cloth.shadow
    }
  }
  # Roof — peaked
  for ($i = 0; $i -lt 12; $i++) {
    $rw = $w - $i * 2
    if ($rw -lt 4) { break }
    $rx = $cx - [int]($rw / 2)
    Fill-Box $bmp $rx ($y0 + 7 - $i) $rw 1 $cloth.base
    Set-Pixel $bmp $rx ($y0 + 7 - $i) $cloth.shadow
    Set-Pixel $bmp ($rx + $rw - 1) ($y0 + 7 - $i) $cloth.high
  }
  # Tent ridge pole
  Fill-Box $bmp $x0 ($y0 + 7) $w 1 $MAT_WOOD_DARK.base
  Set-Pixel $bmp $x0 ($y0 + 7) $MAT_WOOD_DARK.shadow
  Set-Pixel $bmp ($x0 + $w - 1) ($y0 + 7) $MAT_WOOD_DARK.shadow

  # Entry flap
  Fill-Box $bmp ($cx - 5) ($y0 + 18) 10 ($h - 18) $MAT_WOOD_DARK.shadow
  Set-Pixel $bmp ($cx - 5) ($y0 + 18) $MAT_WOOD_DARK.high
  Set-Pixel $bmp ($cx + 4) ($y0 + 18) $MAT_WOOD_DARK.deep
  # Crossed swords above flap
  Line-Pixel $bmp ($cx - 4) ($y0 + 12) ($cx + 4) ($y0 + 16) $MAT_STEEL.high
  Line-Pixel $bmp ($cx + 4) ($y0 + 12) ($cx - 4) ($y0 + 16) $MAT_STEEL.high

  # Flag on left pole (mid+)
  if ($t -ge 1) {
    for ($y = 0; $y -lt 18; $y++) {
      Set-Pixel $bmp $x0 ($y0 - 5 + $y) $MAT_WOOD_DARK.base
    }
    Draw-Pennant-V2 $bmp ($x0 + 1) ($y0 - 3) $BRAND.Crimson
  }
  if ($t -ge 2) {
    # Banner side panel
    Fill-Box $bmp ($x0 + $w - 8) ($y0 + 14) 6 12 $BRAND.Violet
    Set-Pixel $bmp ($x0 + $w - 8) ($y0 + 14) $MAT_GOLD.high
    Set-Pixel $bmp ($x0 + $w - 3) ($y0 + 14) $MAT_GOLD.shadow
  }
}

# Trap — small bomb-style 1×1 pressure plate. Shown as a small dome.
function Draw-Building-Trap {
  param($bmp, [int]$level)
  Rng-Init "trap-$level"
  $t = Tier-Index $level 3
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 1) 12

  # Pressure plate
  $w = 22 + $t * 2
  $h = 6
  $x0 = $cx - [int]($w / 2)
  $y0 = $GROUND_Y_B - $h
  Shade-Box $bmp $x0 $y0 $w $h $MAT_STEEL -RimLight
  for ($x = ($x0 + 2); $x -lt ($x0 + $w - 1); $x += 3) {
    Draw-Rivet $bmp $x ($y0 + 1) $MAT_STEEL
    Draw-Rivet $bmp $x ($y0 + $h - 2) $MAT_STEEL
  }
  # Center dome
  Shade-Disc $bmp $cx ($y0 - 1) 5 $MAT_OBSIDIAN
  # Crimson warning ring
  Blend-Pixel $bmp ($cx - 4) ($y0 - 1) (With-Alpha $BRAND.Crimson 200)
  Blend-Pixel $bmp ($cx + 4) ($y0 - 1) (With-Alpha $BRAND.Crimson 200)
  Blend-Pixel $bmp $cx ($y0 - 6) (With-Alpha $BRAND.Crimson 200)
  # Center spark
  Set-Pixel $bmp $cx ($y0 - 2) $BRAND.Crimson
  Set-Pixel $bmp ($cx - 1) ($y0 - 1) $BRAND.GoldHi
  if ($level -ge 3) { Apply-Rarity-Glow $bmp 'rare' 2 70 }
}

# War Tent — sturdy tent with battle banners + tactical map.
function Draw-Building-WarTent {
  param($bmp, [int]$level)
  Rng-Init "warTent-$level"
  $t = Tier-Index $level 3
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 26

  $w = 50 + $t * 2
  $h = 36
  $x0 = $cx - [int]($w / 2)
  $y0 = $GROUND_Y_B - $h
  # Wool tent body
  Shade-Box $bmp $x0 ($y0 + 10) $w ($h - 10) $MAT_CLOTH_WOOL -RimLight
  # Stripes
  for ($x = ($x0 + 3); $x -lt ($x0 + $w); $x += 8) {
    Fill-Box $bmp $x ($y0 + 11) 2 ($h - 12) $BRAND.Crimson
  }
  # Conical roof
  for ($i = 0; $i -lt 10; $i++) {
    $rw = $w - $i * 2 - 6
    if ($rw -lt 4) { break }
    $rx = $cx - [int]($rw / 2)
    Fill-Box $bmp $rx ($y0 + 9 - $i) $rw 1 $MAT_CLOTH_WOOL.base
    Set-Pixel $bmp $rx ($y0 + 9 - $i) $MAT_CLOTH_WOOL.shadow
    Set-Pixel $bmp ($rx + $rw - 1) ($y0 + 9 - $i) $MAT_CLOTH_WOOL.high
  }
  # Flagpole on top
  for ($y = 0; $y -lt 10; $y++) {
    Set-Pixel $bmp $cx ($y0 - 4 + $y) $MAT_STEEL.base
  }
  Set-Pixel $bmp $cx ($y0 - 5) $MAT_GOLD.top
  Draw-Pennant-V2 $bmp ($cx + 1) ($y0 - 3) $BRAND.Crimson

  # Entry
  Fill-Box $bmp ($cx - 4) ($y0 + 22) 8 ($h - 22) $MAT_LEATHER.deep
  # Crossed banners
  Fill-Box $bmp ($x0 + 6) ($y0 + 16) 4 8 $BRAND.Violet
  Set-Pixel $bmp ($x0 + 6) ($y0 + 16) $MAT_GOLD.high
  Fill-Box $bmp ($x0 + $w - 10) ($y0 + 16) 4 8 $BRAND.Violet
  Set-Pixel $bmp ($x0 + $w - 7) ($y0 + 16) $MAT_GOLD.shadow

  # Tactical map glyph on entry
  if ($t -ge 1) {
    Draw-Gem $bmp $cx ($y0 + 17) 5 $GEM_TOPAZ
  }
  if ($level -ge 3) { Apply-Rarity-Glow $bmp 'epic' 2 90 }
}

# ── Collectors (Sawmill / Quarry / Forge / Mint) ───────────────────
#
# Shared archetype: a small workshop with a tinted-roof + the
# resource pile visible on top. The kind-specific colour ramp + pile
# shape make each one read distinctly.

function Draw-Collector-Generic {
  param(
    $bmp, [int]$level, [string]$kind,
    $bodyRamp, $roofRamp, $pileRamp, [string]$pileShape
  )
  Rng-Init "$kind-$level"
  $t = Tier-Index $level 5
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 26

  # Workshop body
  $w = 50 + $t * 2
  $h = 30 + $t * 2
  $x0 = $cx - [int]($w / 2)
  $y0 = $GROUND_Y_B - $h
  Shade-Box $bmp $x0 $y0 $w $h $bodyRamp -RimLight
  # Plank/stone joints
  for ($x = ($x0 + 4); $x -lt ($x0 + $w - 1); $x += 7) {
    Fill-Box $bmp $x ($y0 + 1) 1 ($h - 2) $bodyRamp.shadow
  }
  # Window
  Fill-Box $bmp ($x0 + 6) ($y0 + 12) 8 8 $BRAND.Ink
  Set-Pixel $bmp ($x0 + 9) ($y0 + 15) $MAT_GOLD.high
  Set-Pixel $bmp ($x0 + 10) ($y0 + 15) $MAT_GOLD.top
  # Door
  Fill-Box $bmp ($cx + 6) ($y0 + 14) 9 ($h - 14) $MAT_WOOD_DARK.deep
  Set-Pixel $bmp ($cx + 6) ($y0 + 14) $MAT_WOOD_DARK.high
  Set-Pixel $bmp ($cx + 13) ($y0 + 18) $MAT_GOLD.top   # door knob
  # Shingled roof
  Draw-Roof-Shingled $bmp $cx ($y0 - 1) ($w + 4) (8 + $t) $roofRamp

  # Resource pile / chimney
  switch ($pileShape) {
    'logs' {
      # Stacked logs out front-left
      for ($i = 0; $i -lt 3; $i++) {
        Shade-Disc $bmp ($x0 + 4 + $i * 4) ($GROUND_Y_B - 4) 3 $pileRamp
        Set-Pixel $bmp ($x0 + 4 + $i * 4) ($GROUND_Y_B - 4) $pileRamp.shadow
      }
    }
    'stones' {
      # Pile of cut stones to the right
      Shade-Disc $bmp ($x0 + $w - 8) ($GROUND_Y_B - 4) 4 $pileRamp
      Shade-Disc $bmp ($x0 + $w - 4) ($GROUND_Y_B - 3) 3 $pileRamp
      Shade-Disc $bmp ($x0 + $w - 11) ($GROUND_Y_B - 6) 3 $pileRamp
    }
    'chimney' {
      # Smokestack
      $ch_x = $cx - 12
      $ch_y = $y0 - 18
      Fill-Box $bmp $ch_x $ch_y 6 18 $MAT_STONE.base
      Fill-Box $bmp $ch_x $ch_y 1 18 $MAT_STONE.high
      Fill-Box $bmp ($ch_x + 5) $ch_y 1 18 $MAT_STONE.shadow
      Fill-Box $bmp ($ch_x - 1) ($ch_y - 2) 8 2 $MAT_STONE.deep
      # Glow at base
      Blend-Pixel $bmp ($ch_x + 2) ($ch_y + 17) (With-Alpha $BRAND.Crimson 200)
      Blend-Pixel $bmp ($ch_x + 3) ($ch_y + 17) (With-Alpha $BRAND.GoldHi 200)
      # Smoke puff
      Blend-Pixel $bmp ($ch_x + 2) ($ch_y - 4) (With-Alpha (Color-FromHex '#88858a') 180)
      Blend-Pixel $bmp ($ch_x + 4) ($ch_y - 6) (With-Alpha (Color-FromHex '#a8a5aa') 140)
    }
    'coins' {
      # Coin pile out front
      for ($i = 0; $i -lt 6; $i++) {
        Set-Pixel $bmp ($x0 + 4 + ($i * 3)) ($GROUND_Y_B - 2) $pileRamp.base
        Set-Pixel $bmp ($x0 + 4 + ($i * 3) + 1) ($GROUND_Y_B - 2) $pileRamp.high
        Set-Pixel $bmp ($x0 + 4 + ($i * 3)) ($GROUND_Y_B - 3) $pileRamp.high
      }
      Set-Pixel $bmp ($x0 + 8) ($GROUND_Y_B - 4) $pileRamp.top
      Set-Pixel $bmp ($x0 + 14) ($GROUND_Y_B - 4) $pileRamp.top
    }
  }

  # Brand banner (top tier)
  if ($t -ge 3) {
    Draw-Pennant-V2 $bmp ($cx - 8) ($y0 - 14) $BRAND.Violet
    Line-Pixel $bmp ($cx - 8) ($y0 - 14) ($cx - 8) ($y0 - 6) $MAT_STEEL.base
  }
  if ($level -ge 4) { Apply-Rarity-Glow $bmp 'epic' 2 70 }
}

function Draw-Building-Sawmill   { param($b,$l) Draw-Collector-Generic $b $l 'sawmill'  $MAT_WOOD_LIGHT $MAT_WOOD_DARK $MAT_WOOD_LIGHT 'logs' }
function Draw-Building-Quarry    { param($b,$l) Draw-Collector-Generic $b $l 'quarry'   $MAT_STONE      $MAT_WOOD_DARK $MAT_STONE      'stones' }
function Draw-Building-Forge     { param($b,$l) Draw-Collector-Generic $b $l 'forge'    $MAT_STONE      $MAT_IRON      $MAT_IRON       'chimney' }
function Draw-Building-Mint      { param($b,$l) Draw-Collector-Generic $b $l 'mint'     $MAT_STONE      $MAT_BRONZE    $MAT_GOLD       'coins' }

# Workshop — small forge-y workshop with anvil + tool icons
function Draw-Building-Workshop {
  param($bmp, [int]$level)
  Rng-Init "workshop-$level"
  $t = Tier-Index $level 4
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 22

  $w = 44 + $t * 2
  $h = 28 + $t * 2
  $x0 = $cx - [int]($w / 2)
  $y0 = $GROUND_Y_B - $h
  Shade-Box $bmp $x0 $y0 $w $h $MAT_WOOD_DARK -RimLight
  # Plank lines
  for ($x = ($x0 + 4); $x -lt ($x0 + $w - 1); $x += 6) {
    Fill-Box $bmp $x ($y0 + 1) 1 ($h - 2) $MAT_WOOD_DARK.deep
  }
  # Slate roof
  Draw-Roof-Shingled $bmp $cx ($y0 - 1) ($w + 2) (10 + $t) $MAT_STEEL
  # Open garage front showing anvil + sparks
  Fill-Box $bmp ($cx - 8) ($y0 + 10) 16 ($h - 10) $BRAND.Ink
  # Anvil silhouette
  Fill-Box $bmp ($cx - 5) ($y0 + 14) 10 4 $MAT_IRON.base
  Fill-Box $bmp ($cx - 3) ($y0 + 18) 6 6 $MAT_IRON.base
  Set-Pixel $bmp ($cx - 5) ($y0 + 14) $MAT_IRON.high
  Set-Pixel $bmp ($cx + 4) ($y0 + 14) $MAT_IRON.shadow
  # Spark
  Set-Pixel $bmp ($cx + 5) ($y0 + 12) $BRAND.GoldHi
  Set-Pixel $bmp ($cx + 6) ($y0 + 13) $BRAND.Gold
  Set-Pixel $bmp ($cx - 6) ($y0 + 12) $BRAND.GoldHi

  # Hanging tool icons (wrench)
  if ($t -ge 1) {
    Set-Pixel $bmp ($x0 + 4) ($y0 + 4) $MAT_STEEL.high
    Set-Pixel $bmp ($x0 + 4) ($y0 + 5) $MAT_STEEL.base
    Set-Pixel $bmp ($x0 + 4) ($y0 + 6) $MAT_STEEL.base
    Set-Pixel $bmp ($x0 + 5) ($y0 + 4) $MAT_STEEL.top
  }
}

# Builder's Hut — small house with builder hat on top.
function Draw-Building-BuildersHut {
  param($bmp, [int]$level)
  Rng-Init "buildersHut-$level"
  $t = Tier-Index $level 4
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 20

  $w = 36 + $t * 2
  $h = 28 + $t * 2
  $x0 = $cx - [int]($w / 2)
  $y0 = $GROUND_Y_B - $h
  Shade-Box $bmp $x0 $y0 $w $h $MAT_WOOD_LIGHT -RimLight
  # Slats
  for ($x = ($x0 + 3); $x -lt ($x0 + $w - 1); $x += 5) {
    Fill-Box $bmp $x ($y0 + 1) 1 ($h - 2) $MAT_WOOD_LIGHT.shadow
  }
  # Thatched roof
  Draw-Roof-Shingled $bmp $cx ($y0 - 1) ($w + 4) (10 + $t) $MAT_THATCH
  # Door
  Fill-Box $bmp ($cx - 4) ($y0 + 16) 8 ($h - 16) $MAT_WOOD_DARK.shadow
  Set-Pixel $bmp ($cx + 3) ($y0 + 20) $MAT_GOLD.top
  # Window
  Fill-Box $bmp ($x0 + 4) ($y0 + 8) 6 6 $BRAND.Ink
  Set-Pixel $bmp ($x0 + 6) ($y0 + 10) $MAT_GOLD.top
  # Hammer on a stand outside
  for ($y = 0; $y -lt 10; $y++) {
    Set-Pixel $bmp ($x0 + $w + 3) ($GROUND_Y_B - $y) $MAT_WOOD_DARK.base
  }
  Fill-Box $bmp ($x0 + $w + 1) ($GROUND_Y_B - 11) 6 4 $MAT_IRON.base
  Set-Pixel $bmp ($x0 + $w + 1) ($GROUND_Y_B - 11) $MAT_IRON.high

  if ($t -ge 2) {
    # Pennant
    Line-Pixel $bmp $cx ($y0 - 12) $cx ($y0 - 4) $MAT_STEEL.base
    Draw-Pennant-V2 $bmp ($cx + 1) ($y0 - 12) $BRAND.Gold
  }
}

# Vault — armoured rectangular safe matching the resource colour.
function Draw-Vault-Generic {
  param($bmp, [int]$level, [string]$kind, $accentColor)
  Rng-Init "$kind-$level"
  $t = Tier-Index $level 4
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 22

  $w = 44 + $t * 2
  $h = 36 + $t * 2
  $x0 = $cx - [int]($w / 2)
  $y0 = $GROUND_Y_B - $h
  Shade-Box $bmp $x0 $y0 $w $h $MAT_IRON -RimLight

  # Door panels (4 panels)
  Fill-Box $bmp ($x0 + 4) ($y0 + 4) ($w - 8) 2 $MAT_IRON.shadow
  Fill-Box $bmp ($x0 + 4) ($y0 + $h - 6) ($w - 8) 2 $MAT_IRON.shadow
  Line-Pixel $bmp ($cx) ($y0 + 4) ($cx) ($y0 + $h - 4) $MAT_IRON.shadow
  Line-Pixel $bmp ($x0 + 4) ([int]($y0 + $h / 2)) ($x0 + $w - 4) ([int]($y0 + $h / 2)) $MAT_IRON.shadow

  # Big circular dial
  Shade-Disc $bmp $cx ([int]($y0 + $h / 2)) 7 $MAT_GOLD -RimLight
  Set-Pixel $bmp $cx ([int]($y0 + $h / 2) - 5) $BRAND.Ink
  # Resource accent insignia
  Fill-Box $bmp ($cx - 8) ($y0 + 6) 16 4 $accentColor
  Set-Pixel $bmp ($cx - 8) ($y0 + 6) (Mix-Color $accentColor (Color-FromHex '#ffffff') 0.4)
  Set-Pixel $bmp ($cx + 7) ($y0 + 6) (Mix-Color $accentColor (Color-FromHex '#000000') 0.4)

  # Corner rivets
  Draw-Rivet $bmp ($x0 + 3) ($y0 + 3) $MAT_STEEL
  Draw-Rivet $bmp ($x0 + $w - 4) ($y0 + 3) $MAT_STEEL
  Draw-Rivet $bmp ($x0 + 3) ($y0 + $h - 4) $MAT_STEEL
  Draw-Rivet $bmp ($x0 + $w - 4) ($y0 + $h - 4) $MAT_STEEL

  if ($t -ge 2) {
    # Top crest
    Draw-Gem $bmp $cx ($y0 - 2) 5 (Gem-Palette $kind)
  }
  if ($level -ge 4) { Apply-Rarity-Glow $bmp 'legendary' 2 80 }
}

function Draw-Building-LumberVault { param($b,$l) Draw-Vault-Generic $b $l 'lumberVault' (Color-FromHex '#8a5c30') }
function Draw-Building-StoneVault  { param($b,$l) Draw-Vault-Generic $b $l 'stoneVault'  (Color-FromHex '#aab1c0') }
function Draw-Building-IronVault   { param($b,$l) Draw-Vault-Generic $b $l 'ironVault'   (Color-FromHex '#7c736c') }
function Draw-Building-GoldVault   { param($b,$l) Draw-Vault-Generic $b $l 'goldVault'   (Color-FromHex '#f4c84a') }

# ── E3 Defenses ────────────────────────────────────────────────────

# Mortar — wide squat tube, blast hint.
function Draw-Building-Mortar {
  param($bmp, [int]$level)
  Rng-Init "mortar-$level"
  $t = Tier-Index $level 6
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 26

  # Base platform
  $bw = 48 + $t * 2
  $bh = 12
  $bx = $cx - [int]($bw / 2)
  $by = $GROUND_Y_B - $bh
  Shade-Box $bmp $bx $by $bw $bh $MAT_STONE -RimLight
  # Sandbags
  for ($x = ($bx + 2); $x -lt ($bx + $bw); $x += 8) {
    Shade-Oval $bmp ($x + 3) $by 5 3 $MAT_CLOTH_LINEN
  }

  # Mortar tube — wide, short, pointed up
  $tubeW = 22 + $t * 2
  $tubeH = 22 + $t * 2
  $tx = $cx - [int]($tubeW / 2)
  $ty = $by - $tubeH
  Shade-Box $bmp $tx $ty $tubeW $tubeH $MAT_IRON -RimLight
  # Rim
  Fill-Box $bmp $tx $ty $tubeW 3 $MAT_IRON.deep
  Fill-Box $bmp ($tx + 2) ($ty + 1) ($tubeW - 4) 1 $MAT_IRON.shadow
  # Reinforcement rings
  for ($y = ($ty + 5); $y -lt ($ty + $tubeH - 1); $y += 5) {
    Fill-Box $bmp $tx $y $tubeW 1 $MAT_IRON.shadow
  }
  # Inside cavity (dark)
  Fill-Box $bmp ($tx + 3) ($ty + 2) ($tubeW - 6) 4 $BRAND.Ink

  # Shell ready-to-fire (peeking out)
  Shade-Disc $bmp $cx ($ty + 1) 4 $MAT_OBSIDIAN
  Set-Pixel $bmp $cx ($ty - 2) $BRAND.Crimson
  Set-Pixel $bmp ($cx + 1) ($ty - 3) $BRAND.GoldHi

  # Crank handle on side (mid+)
  if ($t -ge 1) {
    Shade-Disc $bmp ($tx + $tubeW + 3) ($ty + [int]($tubeH / 2)) 3 $MAT_STEEL
    Set-Pixel $bmp ($tx + $tubeW + 3) ($ty + [int]($tubeH / 2)) $MAT_GOLD.top
  }
  if ($level -ge 5) { Apply-Rarity-Glow $bmp 'epic' 2 80 }
}

# Mage Tower — slim tower with floating crystal orb.
function Draw-Building-MageTower {
  param($bmp, [int]$level)
  Rng-Init "mageTower-$level"
  $t = Tier-Index $level 5
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 22

  # Tower
  $tw = 22 + $t * 2
  $th = 56 + $t * 4
  $tx = $cx - [int]($tw / 2)
  $ty = $GROUND_Y_B - $th
  $tower = @{
    deep   = (Color-FromHex '#1a1240');
    shadow = (Color-FromHex '#322470');
    base   = (Color-FromHex '#4d3aa8');
    high   = (Color-FromHex '#7c5cff');
    top    = (Color-FromHex '#a890ff');
  }
  Shade-Box $bmp $tx $ty $tw $th $tower -RimLight
  # Stone block joints
  for ($y = ($ty + 6); $y -lt ($ty + $th - 1); $y += 7) {
    for ($x = ($tx + 1); $x -lt ($tx + $tw - 1); $x++) {
      Set-Pixel $bmp $x $y $tower.shadow
    }
  }
  # Mystic runes
  Set-Pixel $bmp ($cx - 4) ($ty + 18) $BRAND.Teal
  Set-Pixel $bmp ($cx + 3) ($ty + 26) $BRAND.Teal
  Set-Pixel $bmp $cx ($ty + 34) $BRAND.Teal

  # Crystal orb on top
  Shade-Disc $bmp $cx ($ty - 4) 6 (@{
    deep   = (Color-FromHex '#1a1078');
    shadow = (Color-FromHex '#3a2cc4');
    base   = (Color-FromHex '#7c5cff');
    high   = (Color-FromHex '#b098ff');
    top    = (Color-FromHex '#e8dcff');
  }) -RimLight
  # Orb base
  Fill-Box $bmp ($cx - 3) ($ty - 1) 6 2 $MAT_GOLD.base
  Set-Pixel $bmp ($cx - 3) ($ty - 1) $MAT_GOLD.high
  Set-Pixel $bmp ($cx + 2) ($ty - 1) $MAT_GOLD.shadow

  # Floating spell motes
  Set-Pixel $bmp ($cx - 8) ($ty - 6) $BRAND.Teal
  Set-Pixel $bmp ($cx + 7) ($ty - 4) (Color-FromHex '#a890ff')
  Set-Pixel $bmp ($cx - 5) ($ty - 9) (Color-FromHex '#e8dcff')

  # Window with glow
  Fill-Box $bmp ($cx - 2) ($ty + 30) 4 6 $BRAND.Ink
  Fill-Box $bmp ($cx - 2) ($ty + 31) 4 1 $BRAND.Teal
  Set-Pixel $bmp $cx ($ty + 33) $BRAND.Teal

  Apply-Rarity-Glow $bmp 'epic' 3 100
  if ($level -ge 4) { Apply-Rarity-Glow $bmp 'legendary' 2 60 }
}

# Skyward Bow — tall ballista pointed up at the sky.
function Draw-Building-SkywardBow {
  param($bmp, [int]$level)
  Rng-Init "skywardBow-$level"
  $t = Tier-Index $level 5
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 24

  # Stone platform
  $pw = 40 + $t * 2
  $ph = 14
  $px = $cx - [int]($pw / 2)
  $py = $GROUND_Y_B - $ph
  Shade-Box $bmp $px $py $pw $ph $MAT_STONE -RimLight

  # Wooden mount + pivot
  Shade-Box $bmp ($cx - 5) ($py - 8) 10 8 $MAT_WOOD_DARK
  Draw-Rivet $bmp ($cx - 3) ($py - 4) $MAT_STEEL
  Draw-Rivet $bmp ($cx + 2) ($py - 4) $MAT_STEEL

  # Vertical ballista arms — curved up
  for ($y = 0; $y -lt 36; $y++) {
    $curve = [int]([Math]::Sin(($y / 36.0) * [Math]::PI) * (4 + $t))
    Set-Pixel $bmp ($cx - 12 - $curve) ($py - 10 - $y) $MAT_WOOD_DARK.shadow
    Set-Pixel $bmp ($cx - 11 - $curve) ($py - 10 - $y) $MAT_WOOD_DARK.base
    Set-Pixel $bmp ($cx + 12 + $curve) ($py - 10 - $y) $MAT_WOOD_DARK.shadow
    Set-Pixel $bmp ($cx + 11 + $curve) ($py - 10 - $y) $MAT_WOOD_DARK.base
  }
  # Tips
  Set-Pixel $bmp ($cx - 15) ($py - 46) $MAT_STEEL.top
  Set-Pixel $bmp ($cx + 15) ($py - 46) $MAT_STEEL.top
  # Bowstring (straight + nocked arrow)
  for ($y = -46; $y -lt -10; $y++) {
    Set-Pixel $bmp $cx ($py + $y) (Color-FromHex '#f0e6c8')
  }
  # Arrow body
  for ($y = -30; $y -lt -10; $y++) {
    Set-Pixel $bmp ($cx - 1) ($py + $y) $MAT_WOOD_DARK.base
    Set-Pixel $bmp ($cx + 1) ($py + $y) $MAT_WOOD_DARK.shadow
  }
  # Arrowhead (steel)
  for ($y = -34; $y -lt -30; $y++) {
    $w = $y + 34
    Fill-Box $bmp ($cx - $w) ($py + $y) (2 * $w + 1) 1 $MAT_STEEL.base
    Set-Pixel $bmp ($cx - $w) ($py + $y) $MAT_STEEL.high
    Set-Pixel $bmp ($cx + $w) ($py + $y) $MAT_STEEL.shadow
  }
  Set-Pixel $bmp $cx ($py - 34) $MAT_STEEL.top
  # Fletches at the bottom of arrow
  Set-Pixel $bmp ($cx - 2) ($py - 12) $BRAND.Crimson
  Set-Pixel $bmp ($cx + 2) ($py - 12) $BRAND.Crimson

  if ($level -ge 4) { Apply-Rarity-Glow $bmp 'epic' 2 70 }
}

# Bomb Tower — cone-shaped tower with bombs stacked at top.
function Draw-Building-BombTower {
  param($bmp, [int]$level)
  Rng-Init "bombTower-$level"
  $t = Tier-Index $level 4
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 22

  $tw = 24 + $t * 2
  $th = 42 + $t * 3
  $tx = $cx - [int]($tw / 2)
  $ty = $GROUND_Y_B - $th
  Shade-Box $bmp $tx $ty $tw $th $MAT_STONE -RimLight
  # Brick courses
  for ($y = ($ty + 5); $y -lt ($ty + $th - 1); $y += 6) {
    for ($x = ($tx + 1); $x -lt ($tx + $tw - 1); $x++) {
      Set-Pixel $bmp $x $y $MAT_STONE.shadow
    }
  }
  # Stacked bombs on top platform
  Shade-Disc $bmp ($cx - 5) ($ty - 3) 4 $MAT_OBSIDIAN
  Shade-Disc $bmp ($cx + 5) ($ty - 3) 4 $MAT_OBSIDIAN
  Shade-Disc $bmp $cx ($ty - 8) 4 $MAT_OBSIDIAN
  # Fuses
  Set-Pixel $bmp ($cx - 5) ($ty - 7) $MAT_WOOD_DARK.base
  Set-Pixel $bmp ($cx + 5) ($ty - 7) $MAT_WOOD_DARK.base
  Set-Pixel $bmp $cx ($ty - 12) $BRAND.Crimson
  Set-Pixel $bmp ($cx - 1) ($ty - 11) $BRAND.GoldHi

  # Warning stripes on tower
  Fill-Box $bmp $tx ($ty + 10) $tw 2 $BRAND.Crimson
  Fill-Box $bmp $tx ($ty + 14) $tw 1 $BRAND.GoldHi
  if ($level -ge 3) { Apply-Rarity-Glow $bmp 'rare' 2 70 }
}

# Voltaic Coil — slim tesla coil, sparks at the top.
function Draw-Building-VoltaicCoil {
  param($bmp, [int]$level)
  Rng-Init "voltaicCoil-$level"
  $t = Tier-Index $level 5
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 14

  # Base
  Shade-Box $bmp ($cx - 11) ($GROUND_Y_B - 8) 22 8 $MAT_STEEL -RimLight
  Draw-Rivet $bmp ($cx - 8) ($GROUND_Y_B - 5) $MAT_STEEL
  Draw-Rivet $bmp ($cx + 7) ($GROUND_Y_B - 5) $MAT_STEEL

  # Vertical pole
  $poleH = 50 + $t * 4
  $poleX = $cx
  for ($y = 0; $y -lt $poleH; $y++) {
    Set-Pixel $bmp ($poleX - 1) ($GROUND_Y_B - 8 - $y) $MAT_COPPER.shadow
    Set-Pixel $bmp $poleX     ($GROUND_Y_B - 8 - $y) $MAT_COPPER.base
    Set-Pixel $bmp ($poleX + 1) ($GROUND_Y_B - 8 - $y) $MAT_COPPER.high
  }
  # Coils — copper rings spaced along the pole
  for ($y = 8; $y -lt $poleH; $y += 6) {
    $ringY = $GROUND_Y_B - 8 - $y
    Shade-Oval $bmp $cx $ringY (5 + [int]($t / 2)) 2 $MAT_COPPER
  }

  # Top orb — crackling voltaic sphere
  $orbY = $GROUND_Y_B - 8 - $poleH - 4
  Shade-Disc $bmp $cx $orbY 5 (@{
    deep=(Color-FromHex '#1a1078');
    shadow=(Color-FromHex '#3a2cc4');
    base=(Color-FromHex '#7c5cff');
    high=(Color-FromHex '#b098ff');
    top=(Color-FromHex '#fff8ff');
  }) -RimLight
  # Lightning bolts radiating out
  Line-Pixel $bmp ($cx - 8) ($orbY - 2) ($cx - 4) ($orbY - 1) (Color-FromHex '#e8dcff')
  Line-Pixel $bmp ($cx + 8) ($orbY + 2) ($cx + 4) ($orbY + 1) (Color-FromHex '#e8dcff')
  Line-Pixel $bmp $cx ($orbY - 8) ($cx + 1) ($orbY - 4) $BRAND.Teal

  Apply-Rarity-Glow $bmp 'epic' 3 130
}

# Heavy Cannon — bigger version of Cannon, double barrel + battlement.
function Draw-Building-HeavyCannon {
  param($bmp, [int]$level)
  Rng-Init "heavyCannon-$level"
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 32

  # Stone bunker base
  $bw = 60
  $bh = 22
  $bx = $cx - [int]($bw / 2)
  $by = $GROUND_Y_B - $bh
  Shade-Box $bmp $bx $by $bw $bh $MAT_STONE -RimLight
  # Crenellations
  Draw-Crenel $bmp $bx $by $bw 4 4 $MAT_STONE

  # Iron mount
  Shade-Box $bmp ($cx - 12) ($by - 4) 24 6 $MAT_IRON -RimLight
  Draw-Rivet $bmp ($cx - 8) ($by - 2) $MAT_IRON
  Draw-Rivet $bmp ($cx + 7) ($by - 2) $MAT_IRON

  # TWO barrels
  foreach ($dx in @(-6, 6)) {
    $barLen = 30
    $barW = 7
    $bx0 = $cx + $dx
    $by0 = $by - 6
    for ($i = 0; $i -lt $barLen; $i++) {
      $bx2 = $bx0 + [int]($i * 0.75)
      $by2 = $by0 - [int]($i * 0.5)
      for ($w = 0; $w -lt $barW; $w++) {
        Set-Pixel $bmp $bx2 ($by2 + $w) $MAT_STEEL.base
      }
      Set-Pixel $bmp $bx2 $by2 $MAT_STEEL.high
      Set-Pixel $bmp $bx2 ($by2 + $barW - 1) $MAT_STEEL.shadow
      if (($i % 7) -eq 5) {
        for ($w = 0; $w -lt $barW; $w++) {
          Set-Pixel $bmp $bx2 ($by2 + $w) $MAT_STEEL.deep
        }
      }
    }
  }
  # Brass crest
  Draw-Gem $bmp $cx ($by + 8) 7 $GEM_TOPAZ
  Apply-Rarity-Glow $bmp 'legendary' 2 90
}

# Inferno Tower — narrow tower with flame jet at top.
function Draw-Building-InfernoTower {
  param($bmp, [int]$level)
  Rng-Init "infernoTower-$level"
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 20

  $tw = 18
  $th = 64
  $tx = $cx - [int]($tw / 2)
  $ty = $GROUND_Y_B - $th
  $hot = @{
    deep   = (Color-FromHex '#3a0a08');
    shadow = (Color-FromHex '#7a1818');
    base   = (Color-FromHex '#b03020');
    high   = (Color-FromHex '#e85a30');
    top    = (Color-FromHex '#f8a050');
  }
  Shade-Box $bmp $tx $ty $tw $th $hot -RimLight
  # Soot streaks
  for ($y = ($ty + 5); $y -lt ($ty + $th - 1); $y += 6) {
    for ($x = ($tx + 1); $x -lt ($tx + $tw - 1); $x++) {
      Set-Pixel $bmp $x $y $hot.deep
    }
  }
  # Gold rings
  Fill-Box $bmp $tx ($ty + 12) $tw 2 $MAT_GOLD.base
  Fill-Box $bmp $tx ($ty + 38) $tw 2 $MAT_GOLD.base
  Fill-Box $bmp $tx ($ty + 12) $tw 1 $MAT_GOLD.high
  Fill-Box $bmp $tx ($ty + 38) $tw 1 $MAT_GOLD.high

  # Flame plume at top
  Shade-Oval $bmp $cx ($ty - 6) 8 7 $hot
  Shade-Disc $bmp $cx ($ty - 12) 4 (@{
    deep=$hot.shadow; shadow=$hot.base; base=$hot.high; high=$hot.top; top=(Color-FromHex '#fff8c0');
  })
  Set-Pixel $bmp $cx ($ty - 16) (Color-FromHex '#fff8c0')

  # Embers floating
  Set-Pixel $bmp ($cx - 9) ($ty - 4) $hot.top
  Set-Pixel $bmp ($cx + 8) ($ty - 8) $hot.high
  Set-Pixel $bmp ($cx - 6) ($ty - 14) $BRAND.GoldHi

  Apply-Rarity-Glow $bmp 'legendary' 3 130
}

# Eagle Eye — 3×3 footprint, tall watchtower with eagle perched on top.
function Draw-Building-EagleEye {
  param($bmp, [int]$level)
  Rng-Init "eagleEye-$level"
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 2) 36

  # Wide stone base
  $bw = 70
  $bh = 18
  $bx = $cx - [int]($bw / 2)
  $by = $GROUND_Y_B - $bh
  Shade-Box $bmp $bx $by $bw $bh $MAT_STONE -RimLight

  # Tower body
  $tw = 30
  $th = 56
  $tx = $cx - [int]($tw / 2)
  $ty = $by - $th
  Shade-Box $bmp $tx $ty $tw $th $MAT_STONE -RimLight
  # Brick courses
  for ($y = ($ty + 6); $y -lt ($ty + $th - 1); $y += 7) {
    for ($x = ($tx + 1); $x -lt ($tx + $tw - 1); $x++) {
      Set-Pixel $bmp $x $y $MAT_STONE.shadow
    }
  }
  # Multiple slot windows facing every direction
  foreach ($wy in @(15, 30, 45)) {
    Fill-Box $bmp ($cx - 2) ($ty + $wy) 4 6 $BRAND.Ink
    Set-Pixel $bmp $cx ($ty + $wy + 2) $MAT_GOLD.top
  }
  # Crenellated top
  Draw-Crenel $bmp $tx $ty $tw 4 4 $MAT_STONE

  # Eagle perched on top
  $eyY = $ty - 12
  Shade-Oval $bmp $cx ($eyY + 2) 6 4 $MAT_WOOD_DARK
  Fill-Box $bmp ($cx - 3) ($eyY - 1) 6 3 $MAT_WOOD_DARK.base
  Fill-Box $bmp ($cx - 6) ($eyY - 2) 3 1 $MAT_WOOD_DARK.shadow  # wing
  Fill-Box $bmp ($cx + 3) ($eyY - 2) 3 1 $MAT_WOOD_DARK.shadow  # wing
  Set-Pixel $bmp $cx ($eyY - 2) $MAT_WOOD_DARK.high
  Set-Pixel $bmp ($cx - 1) ($eyY - 1) $BRAND.GoldHi   # eye
  Set-Pixel $bmp ($cx + 1) ($eyY - 1) $BRAND.GoldHi
  Set-Pixel $bmp $cx ($eyY) $BRAND.Gold   # beak

  # Gold finial pennants on base corners
  foreach ($dir in @(-1, 1)) {
    $sx = $cx + $dir * 30
    for ($y = 0; $y -lt 12; $y++) {
      Set-Pixel $bmp $sx ($by - $y) $MAT_GOLD.base
    }
    Draw-Pennant-V2 $bmp ($sx + 1) ($by - 11) $BRAND.Crimson
  }
  Apply-Rarity-Glow $bmp 'legendary' 3 140
}

# ── E3 Traps ───────────────────────────────────────────────────────

# Each trap is a small 1×1 ground marker — distinct icon per kind.

function Draw-Trap-Base { param($bmp, [int]$level, $accentColor, [string]$kind)
  Rng-Init "$kind-$level"
  $t = Tier-Index $level 3
  $cx = 48
  Draw-GroundShadow $bmp $cx ($GROUND_Y_B + 1) 14

  $w = 26 + $t * 2
  $h = 8
  $x0 = $cx - [int]($w / 2)
  $y0 = $GROUND_Y_B - $h
  Shade-Box $bmp $x0 $y0 $w $h $MAT_STEEL -RimLight
  for ($x = ($x0 + 3); $x -lt ($x0 + $w - 1); $x += 4) {
    Draw-Rivet $bmp $x ($y0 + 1) $MAT_STEEL
    Draw-Rivet $bmp $x ($y0 + $h - 2) $MAT_STEEL
  }
}

function Draw-Building-SpringTrap { param($bmp,$level)
  Draw-Trap-Base $bmp $level (Color-FromHex '#5be098') 'springTrap'
  $cx = 48
  # Coiled spring
  Shade-Disc $bmp $cx ($GROUND_Y_B - 10) 5 $MAT_STEEL
  for ($r = 0; $r -lt 4; $r++) {
    Set-Pixel $bmp ($cx - 4 + $r) ($GROUND_Y_B - 12 - $r * 2) $MAT_STEEL.high
    Set-Pixel $bmp ($cx + 4 - $r) ($GROUND_Y_B - 12 - $r * 2) $MAT_STEEL.shadow
  }
  Set-Pixel $bmp $cx ($GROUND_Y_B - 22) $MAT_STEEL.top
  if ($level -ge 3) { Apply-Rarity-Glow $bmp 'rare' 2 70 }
}

function Draw-Building-SkyMine { param($bmp,$level)
  Draw-Trap-Base $bmp $level (Color-FromHex '#6ec0ff') 'skyMine'
  $cx = 48
  # Mine with spikes pointing up
  Shade-Disc $bmp $cx ($GROUND_Y_B - 12) 6 $MAT_OBSIDIAN -RimLight
  foreach ($a in @(-1.6, -1.2, -2.0, -2.4, -0.8, -2.8)) {
    $tx = [int]($cx + [Math]::Cos($a) * 9)
    $ty = [int](($GROUND_Y_B - 12) + [Math]::Sin($a) * 9)
    Line-Pixel $bmp $cx ($GROUND_Y_B - 12) $tx $ty $MAT_STEEL.base
    Set-Pixel $bmp $tx $ty $MAT_STEEL.top
  }
  # Blue glow
  Set-Pixel $bmp $cx ($GROUND_Y_B - 14) $BRAND.Teal
  Apply-Rarity-Glow $bmp 'rare' 2 80
}

function Draw-Building-StaticTrap { param($bmp,$level)
  Draw-Trap-Base $bmp $level (Color-FromHex '#cb9aff') 'staticTrap'
  $cx = 48
  # Cone with electric arcs
  for ($i = 0; $i -lt 10; $i++) {
    $w = 10 - $i
    Fill-Box $bmp ($cx - [int]($w / 2)) ($GROUND_Y_B - 10 - $i) $w 1 $MAT_COPPER.base
    Set-Pixel $bmp ($cx - [int]($w / 2)) ($GROUND_Y_B - 10 - $i) $MAT_COPPER.shadow
    Set-Pixel $bmp ($cx + [int]($w / 2)) ($GROUND_Y_B - 10 - $i) $MAT_COPPER.high
  }
  # Arc bolts
  Line-Pixel $bmp ($cx - 6) ($GROUND_Y_B - 18) ($cx - 3) ($GROUND_Y_B - 22) (Color-FromHex '#a890ff')
  Line-Pixel $bmp ($cx + 6) ($GROUND_Y_B - 16) ($cx + 3) ($GROUND_Y_B - 22) (Color-FromHex '#a890ff')
  Set-Pixel $bmp $cx ($GROUND_Y_B - 24) (Color-FromHex '#e8dcff')
  Apply-Rarity-Glow $bmp 'epic' 2 100
}

function Draw-Building-Caltrops { param($bmp,$level)
  Draw-Trap-Base $bmp $level (Color-FromHex '#a0a8b0') 'caltrops'
  $cx = 48
  # Multiple caltrop spikes scattered around
  foreach ($p in @(@(-8,-2), @(0,-3), @(8,-1), @(-4,-5), @(5,-5))) {
    $px = $cx + $p[0]; $py = $GROUND_Y_B - 8 + $p[1]
    # Cross shape (top-down view)
    Line-Pixel $bmp ($px - 2) $py ($px + 2) $py $MAT_STEEL.base
    Line-Pixel $bmp $px ($py - 2) $px ($py + 2) $MAT_STEEL.base
    Set-Pixel $bmp $px $py $MAT_STEEL.top
    Set-Pixel $bmp ($px - 2) $py $MAT_STEEL.high
    Set-Pixel $bmp ($px + 2) $py $MAT_STEEL.shadow
  }
}

function Draw-Building-InfernoTrap { param($bmp,$level)
  Draw-Trap-Base $bmp $level (Color-FromHex '#f8514a') 'infernoTrap'
  $cx = 48
  # Flame jet
  $hot = @{
    deep   = (Color-FromHex '#3a0a08');
    shadow = (Color-FromHex '#7a1818');
    base   = (Color-FromHex '#e85a30');
    high   = (Color-FromHex '#f8a050');
    top    = (Color-FromHex '#fff8c0');
  }
  Shade-Oval $bmp $cx ($GROUND_Y_B - 11) 5 6 $hot
  Shade-Disc $bmp $cx ($GROUND_Y_B - 16) 3 $hot
  Set-Pixel $bmp $cx ($GROUND_Y_B - 18) (Color-FromHex '#fff8c0')
  # Embers
  Set-Pixel $bmp ($cx - 5) ($GROUND_Y_B - 14) $hot.high
  Set-Pixel $bmp ($cx + 5) ($GROUND_Y_B - 12) $hot.base
  Apply-Rarity-Glow $bmp 'epic' 2 110
}

function Draw-Building-DecoyBanner { param($bmp,$level)
  Draw-Trap-Base $bmp $level (Color-FromHex '#f0b429') 'decoyBanner'
  $cx = 48
  # Tall pole with a flapping flag
  for ($y = 0; $y -lt 20; $y++) {
    Set-Pixel $bmp $cx ($GROUND_Y_B - 8 - $y) $MAT_WOOD_DARK.base
  }
  Set-Pixel $bmp $cx ($GROUND_Y_B - 28) $MAT_GOLD.top
  # Banner
  Fill-Box $bmp ($cx + 1) ($GROUND_Y_B - 26) 8 6 $BRAND.Crimson
  Set-Pixel $bmp ($cx + 1) ($GROUND_Y_B - 26) $BRAND.GoldHi
  Set-Pixel $bmp ($cx + 9) ($GROUND_Y_B - 26) (Mix-Color $BRAND.Crimson (Color-FromHex '#000000') 0.4)
  # Skull symbol on banner
  Set-Pixel $bmp ($cx + 4) ($GROUND_Y_B - 24) $BRAND.GoldHi
  Set-Pixel $bmp ($cx + 5) ($GROUND_Y_B - 24) $BRAND.GoldHi
  Set-Pixel $bmp ($cx + 4) ($GROUND_Y_B - 23) (Color-FromHex '#000000')
  Set-Pixel $bmp ($cx + 5) ($GROUND_Y_B - 23) (Color-FromHex '#000000')
}

# ── Troops ─────────────────────────────────────────────────────────

$SKIN_BASE = @{
  deep   = (Color-FromHex '#6a4828');
  shadow = (Color-FromHex '#a07048');
  base   = (Color-FromHex '#e7c299');
  high   = (Color-FromHex '#ffd8b8');
  top    = (Color-FromHex '#ffeacc');
}
$SKIN_GOBLIN = @{
  deep   = (Color-FromHex '#1c3818');
  shadow = (Color-FromHex '#3a702c');
  base   = (Color-FromHex '#5ca838');
  high   = (Color-FromHex '#8cd058');
  top    = (Color-FromHex '#b8e88c');
}

# Body silhouette for a humanoid troop at 64×64 — head, torso, legs.
# Caller draws gear/weapons on top. Skin + cloth ramps parameterise.
function Draw-Troop-Base-V2 {
  param($bmp, $skin, $cloth)
  $cx = 32
  # Ground shadow
  $shadow = (Color-FromHex '#040510')
  for ($i = -10; $i -le 10; $i++) {
    $a = 170 - [Math]::Abs($i) * 14
    if ($a -lt 30) { continue }
    Blend-Pixel $bmp ($cx + $i) ($GROUND_Y_T + 1) (With-Alpha $shadow $a)
  }
  for ($i = -7; $i -le 7; $i++) {
    Blend-Pixel $bmp ($cx + $i) $GROUND_Y_T (With-Alpha $shadow 80)
  }

  # Head
  Shade-Disc $bmp $cx 14 6 $skin -RimLight
  # Eyes
  Set-Pixel $bmp ($cx - 2) 14 (Color-FromHex '#1a1416')
  Set-Pixel $bmp ($cx + 2) 14 (Color-FromHex '#1a1416')
  # Mouth
  Set-Pixel $bmp $cx 17 (Color-FromHex '#5a2818')
  # Neck
  Fill-Box $bmp ($cx - 2) 21 5 2 $skin.shadow
  # Torso (cloth/armour)
  Shade-Box $bmp ($cx - 8) 22 17 18 $cloth -RimLight
  # Belt
  Fill-Box $bmp ($cx - 8) 36 17 2 $MAT_LEATHER.shadow
  Set-Pixel $bmp $cx 37 $MAT_GOLD.top
  # Legs
  Shade-Box $bmp ($cx - 7) 40 6 16 $cloth
  Shade-Box $bmp ($cx + 1) 40 6 16 $cloth
  # Boots
  Fill-Box $bmp ($cx - 7) 55 6 4 $MAT_LEATHER.deep
  Fill-Box $bmp ($cx + 1) 55 6 4 $MAT_LEATHER.deep
  Set-Pixel $bmp ($cx - 5) 55 $MAT_LEATHER.high
  Set-Pixel $bmp ($cx + 3) 55 $MAT_LEATHER.high
  # Arms
  Fill-Box $bmp ($cx - 10) 24 2 14 $cloth.base
  Fill-Box $bmp ($cx + 9) 24 2 14 $cloth.base
  Set-Pixel $bmp ($cx - 10) 24 $cloth.high
  Set-Pixel $bmp ($cx + 9) 24 $cloth.high
  # Hands
  Set-Pixel $bmp ($cx - 10) 38 $skin.base
  Set-Pixel $bmp ($cx + 10) 38 $skin.base
  Set-Pixel $bmp ($cx - 9) 38 $skin.base
  Set-Pixel $bmp ($cx + 9) 38 $skin.base
}

function Draw-Troop-V2-Scrapper { param($bmp)
  Rng-Init "scrapper"
  Draw-Troop-Base-V2 $bmp $SKIN_BASE $MAT_LEATHER
  $cx = 32
  # Crimson bandana
  Fill-Box $bmp ($cx - 5) 9 11 2 $BRAND.Crimson
  Set-Pixel $bmp ($cx - 5) 9 (Color-FromHex '#8a1818')
  # Trailing knot
  Set-Pixel $bmp ($cx + 6) 11 $BRAND.Crimson
  Set-Pixel $bmp ($cx + 7) 12 $BRAND.Crimson
  # Big wrench in right hand
  Fill-Box $bmp ($cx + 9) 26 2 14 $MAT_WOOD_DARK.base
  Set-Pixel $bmp ($cx + 10) 26 $MAT_WOOD_DARK.high
  Shade-Box $bmp ($cx + 8) 22 5 5 $MAT_STEEL -RimLight
  Set-Pixel $bmp ($cx + 9) 23 $MAT_STEEL.top
  Set-Pixel $bmp ($cx + 11) 23 $MAT_STEEL.shadow
  Apply-Rarity-Glow $bmp 'common' 1 50
}

function Draw-Troop-V2-BoltKnight { param($bmp)
  Rng-Init "boltKnight"
  Draw-Troop-Base-V2 $bmp $SKIN_BASE $MAT_STEEL
  $cx = 32
  # Helmet
  Shade-Box $bmp ($cx - 6) 8 13 11 $MAT_STEEL -RimLight
  Fill-Box $bmp ($cx - 6) 14 13 2 $BRAND.Ink   # visor slit
  Set-Pixel $bmp ($cx - 3) 15 $BRAND.Teal      # eye glow
  Set-Pixel $bmp ($cx + 3) 15 $BRAND.Teal
  Set-Pixel $bmp $cx 8 $MAT_STEEL.top   # peak
  # Pauldrons
  Shade-Box $bmp ($cx - 12) 22 5 6 $MAT_STEEL
  Shade-Box $bmp ($cx + 8) 22 5 6 $MAT_STEEL
  # Voltaic gem on chest
  Draw-Gem $bmp $cx 28 6 $GEM_VOLTAIC
  # Sword in right hand
  Draw-Blade $bmp ($cx + 12) 8 30 5 $MAT_STEEL -Fuller
  Fill-Box $bmp ($cx + 9) 30 7 2 $MAT_STEEL.base   # crossguard
  Draw-Grip $bmp ($cx + 12) 32 36 2 $MAT_LEATHER
  Apply-Rarity-Glow $bmp 'rare' 2 80
}

function Draw-Troop-V2-Archer { param($bmp)
  Rng-Init "archerLite"
  Draw-Troop-Base-V2 $bmp $SKIN_BASE $MAT_WOOD_DARK
  $cx = 32
  # Hood drape
  Fill-Box $bmp ($cx - 6) 8 13 7 $MAT_WOOD_DARK.deep
  Set-Pixel $bmp $cx 8 $MAT_WOOD_DARK.high
  # Quiver on back
  Fill-Box $bmp ($cx + 8) 22 4 14 $MAT_LEATHER.deep
  Set-Pixel $bmp ($cx + 8) 22 $MAT_LEATHER.high
  # Arrow fletches sticking out
  for ($i = 0; $i -lt 3; $i++) {
    Set-Pixel $bmp ($cx + 8 + $i) 20 (Color-FromHex '#e0d0b0')
    Set-Pixel $bmp ($cx + 8 + $i) 18 $MAT_WOOD_DARK.high
  }
  # Bow held vertically (left)
  for ($y = 0; $y -lt 30; $y++) {
    $offset = [int]([Math]::Sin(($y / 30.0) * [Math]::PI) * 4)
    Set-Pixel $bmp ($cx - 14 - $offset) (16 + $y) $MAT_WOOD_DARK.base
    Set-Pixel $bmp ($cx - 13 - $offset) (16 + $y) $MAT_WOOD_DARK.high
  }
  # Bowstring
  for ($y = 18; $y -lt 46; $y++) {
    Set-Pixel $bmp ($cx - 10) $y (Color-FromHex '#f0e6c8')
  }
  # Nocked arrow
  for ($x = ($cx - 8); $x -lt ($cx + 2); $x++) {
    Set-Pixel $bmp $x 32 $MAT_WOOD_DARK.high
  }
  Set-Pixel $bmp ($cx + 2) 32 $MAT_STEEL.top
}

function Draw-Troop-V2-VoltaicMage { param($bmp)
  Rng-Init "voltaicMage"
  $robe = @{
    deep   = (Color-FromHex '#1a0c40');
    shadow = (Color-FromHex '#3a1f7a');
    base   = $BRAND.Violet;
    high   = $BRAND.VioletHi;
    top    = (Color-FromHex '#d0c0ff');
  }
  Draw-Troop-Base-V2 $bmp $SKIN_BASE $robe
  $cx = 32
  # Pointed hat
  for ($i = 0; $i -lt 12; $i++) {
    $w = 12 - $i
    $x0 = $cx - [int]($w / 2)
    Fill-Box $bmp $x0 (20 - $i) $w 1 $robe.base
    Set-Pixel $bmp $x0 (20 - $i) $robe.shadow
    Set-Pixel $bmp ($x0 + $w - 1) (20 - $i) $robe.high
  }
  Set-Pixel $bmp $cx 7 $BRAND.GoldHi
  # Brim
  Fill-Box $bmp ($cx - 8) 20 17 2 $robe.deep
  Set-Pixel $bmp ($cx - 8) 20 $robe.shadow
  Set-Pixel $bmp ($cx + 8) 20 $robe.shadow
  # Glowing eyes
  Set-Pixel $bmp ($cx - 2) 14 $BRAND.Teal
  Set-Pixel $bmp ($cx + 2) 14 $BRAND.Teal
  # Staff with voltaic orb
  for ($y = 12; $y -lt 50; $y++) {
    Set-Pixel $bmp ($cx + 12) $y $MAT_WOOD_DARK.base
    Set-Pixel $bmp ($cx + 11) $y $MAT_WOOD_DARK.shadow
  }
  Shade-Disc $bmp ($cx + 12) 9 5 (@{
    deep=(Color-FromHex '#1a1078'); shadow=(Color-FromHex '#3a2cc4'); base=(Color-FromHex '#7c5cff');
    high=(Color-FromHex '#cab8ff'); top=(Color-FromHex '#ffffff');
  })
  Set-Pixel $bmp ($cx + 12) 7 $BRAND.Teal
  # Sparkle motes around staff
  Set-Pixel $bmp ($cx + 18) 5 $BRAND.Teal
  Set-Pixel $bmp ($cx + 8) 6 (Color-FromHex '#a890ff')
  Set-Pixel $bmp ($cx + 16) 12 $BRAND.Teal
  Apply-Rarity-Glow $bmp 'epic' 3 110
}

function Draw-Troop-V2-SapperRogue { param($bmp)
  Rng-Init "sapperRogue"
  Draw-Troop-Base-V2 $bmp $SKIN_BASE $MAT_LEATHER_BLACK
  $cx = 32
  # Hood
  Fill-Box $bmp ($cx - 6) 8 13 10 $MAT_LEATHER_BLACK.deep
  Set-Pixel $bmp $cx 8 $MAT_LEATHER_BLACK.shadow
  # Mask
  Fill-Box $bmp ($cx - 6) 14 13 2 $BRAND.Ink
  Set-Pixel $bmp ($cx - 2) 14 $BRAND.Crimson   # red eyes
  Set-Pixel $bmp ($cx + 2) 14 $BRAND.Crimson
  # Bomb in right hand
  Shade-Disc $bmp ($cx + 10) 28 4 $MAT_OBSIDIAN
  # Fuse
  for ($y = 0; $y -lt 6; $y++) {
    Set-Pixel $bmp ($cx + 10) (23 - $y) $MAT_WOOD_DARK.high
  }
  Set-Pixel $bmp ($cx + 11) 17 $BRAND.Crimson  # spark
  Set-Pixel $bmp ($cx + 10) 16 $BRAND.GoldHi
  # Belt of charges
  for ($i = 0; $i -lt 4; $i++) {
    Set-Pixel $bmp ($cx - 7 + $i * 4) 38 $BRAND.Crimson
    Set-Pixel $bmp ($cx - 7 + $i * 4) 39 $BRAND.Crimson
  }
  # Knife in left hand
  Draw-Blade $bmp ($cx - 11) 26 40 4 $MAT_STEEL
}

function Draw-Troop-V2-HealerCleric { param($bmp)
  Rng-Init "healerCleric"
  $robe = $MAT_CLOTH_LINEN
  Draw-Troop-Base-V2 $bmp $SKIN_BASE $robe
  $cx = 32
  # Hood
  Fill-Box $bmp ($cx - 6) 8 13 10 $robe.shadow
  Set-Pixel $bmp $cx 8 $robe.high
  # Halo above head
  $glow = With-Alpha (Color-FromHex '#fff0a0') 200
  for ($x = ($cx - 7); $x -le ($cx + 7); $x++) {
    Blend-Pixel $bmp $x 4 $glow
  }
  Blend-Pixel $bmp ($cx - 8) 5 (With-Alpha (Color-FromHex '#fff0a0') 150)
  Blend-Pixel $bmp ($cx + 8) 5 (With-Alpha (Color-FromHex '#fff0a0') 150)
  # Holy cross on chest
  Fill-Box $bmp ($cx - 1) 27 3 10 $MAT_GOLD.base
  Fill-Box $bmp ($cx - 4) 31 9 3 $MAT_GOLD.base
  Set-Pixel $bmp $cx 27 $MAT_GOLD.top
  # Staff with green orb
  for ($y = 12; $y -lt 50; $y++) {
    Set-Pixel $bmp ($cx + 12) $y $MAT_WOOD_DARK.base
    Set-Pixel $bmp ($cx + 11) $y $MAT_WOOD_DARK.shadow
  }
  Shade-Disc $bmp ($cx + 12) 9 5 (@{
    deep=(Color-FromHex '#1a3a30'); shadow=(Color-FromHex '#2f8a78'); base=(Color-FromHex '#5fc4a8');
    high=(Color-FromHex '#92e6cd'); top=(Color-FromHex '#bdf5e0');
  })
  Set-Pixel $bmp ($cx + 12) 7 (Color-FromHex '#5bff95')
}

function Draw-Troop-V2-Sneak { param($bmp)
  Rng-Init "sneak"
  Draw-Troop-Base-V2 $bmp $SKIN_GOBLIN $MAT_LEATHER_BLACK
  $cx = 32
  # Pointed goblin ears
  Set-Pixel $bmp ($cx - 7) 11 $SKIN_GOBLIN.shadow
  Set-Pixel $bmp ($cx - 8) 12 $SKIN_GOBLIN.shadow
  Set-Pixel $bmp ($cx - 7) 12 $SKIN_GOBLIN.base
  Set-Pixel $bmp ($cx + 7) 11 $SKIN_GOBLIN.shadow
  Set-Pixel $bmp ($cx + 8) 12 $SKIN_GOBLIN.shadow
  Set-Pixel $bmp ($cx + 7) 12 $SKIN_GOBLIN.base
  # Hood
  Fill-Box $bmp ($cx - 5) 9 11 3 $MAT_LEATHER_BLACK.deep
  # Climbing hook (grappling iron in right hand)
  Fill-Box $bmp ($cx + 9) 26 2 8 $MAT_WOOD_DARK.base
  Shade-Box $bmp ($cx + 8) 22 5 5 $MAT_IRON -RimLight
  Set-Pixel $bmp ($cx + 7) 22 $MAT_IRON.high
  Set-Pixel $bmp ($cx + 13) 22 $MAT_IRON.shadow
  # Rope coil at belt
  Set-Pixel $bmp ($cx - 5) 37 $MAT_WOOD_DARK.base
  Set-Pixel $bmp ($cx - 4) 37 $MAT_WOOD_DARK.high
}

function Draw-Troop-V2-BatteringRam { param($bmp)
  Rng-Init "batteringRam"
  $cx = 32
  # Heavily armoured troop carrying a giant log
  Draw-Troop-Base-V2 $bmp $SKIN_BASE $MAT_IRON
  # Heavy helmet (full face)
  Shade-Box $bmp ($cx - 7) 7 15 14 $MAT_IRON -RimLight
  Set-Pixel $bmp $cx 7 $MAT_IRON.top
  # Eye slot
  Fill-Box $bmp ($cx - 5) 12 11 2 $BRAND.Ink
  Set-Pixel $bmp ($cx - 2) 13 $BRAND.Crimson
  Set-Pixel $bmp ($cx + 2) 13 $BRAND.Crimson
  # Ram log overhead, horizontal
  $ramY = 28
  Fill-Box $bmp 4 ($ramY - 5) 56 10 $MAT_WOOD_DARK.base
  for ($x = 4; $x -lt 60; $x += 6) {
    Fill-Box $bmp $x ($ramY - 5) 1 10 $MAT_WOOD_DARK.shadow
  }
  Set-Pixel $bmp 4 ($ramY - 5) $MAT_WOOD_DARK.deep
  Set-Pixel $bmp 4 ($ramY + 4) $MAT_WOOD_DARK.deep
  # Iron head at right end
  Shade-Box $bmp 56 ($ramY - 6) 8 12 $MAT_IRON -RimLight
  Draw-Rivet $bmp 58 ($ramY - 4) $MAT_IRON
  Draw-Rivet $bmp 60 ($ramY - 4) $MAT_IRON
  Draw-Rivet $bmp 58 ($ramY + 3) $MAT_IRON
  Draw-Rivet $bmp 60 ($ramY + 3) $MAT_IRON
  # Iron bands around log
  Fill-Box $bmp 18 ($ramY - 5) 2 10 $MAT_IRON.base
  Fill-Box $bmp 36 ($ramY - 5) 2 10 $MAT_IRON.base
  Apply-Rarity-Glow $bmp 'rare' 2 70
}

function Draw-Troop-V2-Skyrider { param($bmp)
  Rng-Init "skyrider"
  $cx = 32
  # Wing glider above, troop dangling below
  # Top: kite wings
  for ($i = 0; $i -lt 12; $i++) {
    $w = 26 - $i * 2
    if ($w -lt 4) { break }
    $x0 = $cx - [int]($w / 2)
    Fill-Box $bmp $x0 (4 + $i) $w 1 $BRAND.Crimson
    Set-Pixel $bmp $x0 (4 + $i) (Color-FromHex '#8a1818')
    Set-Pixel $bmp ($x0 + $w - 1) (4 + $i) (Color-FromHex '#c83838')
  }
  Set-Pixel $bmp $cx 4 $BRAND.GoldHi
  # Ribs
  Line-Pixel $bmp ($cx - 12) 6 $cx 14 $MAT_WOOD_DARK.base
  Line-Pixel $bmp ($cx + 12) 6 $cx 14 $MAT_WOOD_DARK.base
  Line-Pixel $bmp $cx 4 $cx 14 $MAT_WOOD_DARK.base
  # Pilot harness
  Draw-Troop-Base-V2 $bmp $SKIN_GOBLIN $MAT_LEATHER
  # Goggles
  Set-Pixel $bmp ($cx - 3) 14 $BRAND.Gold
  Set-Pixel $bmp ($cx - 2) 14 $BRAND.Gold
  Set-Pixel $bmp ($cx + 2) 14 $BRAND.Gold
  Set-Pixel $bmp ($cx + 3) 14 $BRAND.Gold
  # Cloud puff under feet to suggest air
  Blend-Pixel $bmp ($cx - 4) 60 (With-Alpha (Color-FromHex '#d8e0f0') 200)
  Blend-Pixel $bmp ($cx + 4) 60 (With-Alpha (Color-FromHex '#d8e0f0') 200)
  Apply-Rarity-Glow $bmp 'rare' 2 70
}

function Draw-Troop-V2-PlagueDoctor { param($bmp)
  Rng-Init "plagueDoctor"
  $robe = @{
    deep   = (Color-FromHex '#0a1816');
    shadow = (Color-FromHex '#143028');
    base   = (Color-FromHex '#1f4a3c');
    high   = (Color-FromHex '#347458');
    top    = (Color-FromHex '#5a9c76');
  }
  Draw-Troop-Base-V2 $bmp $SKIN_BASE $robe
  $cx = 32
  # Wide-brim hat
  Fill-Box $bmp ($cx - 10) 8 21 2 $robe.deep
  Set-Pixel $bmp ($cx - 10) 8 $robe.shadow
  Set-Pixel $bmp ($cx + 10) 8 $robe.shadow
  # Hat dome
  Shade-Box $bmp ($cx - 5) 4 11 5 $robe -RimLight
  # Beak mask
  Fill-Box $bmp ($cx - 2) 14 5 5 $MAT_LEATHER.base
  Line-Pixel $bmp ($cx + 2) 14 ($cx + 5) 19 $MAT_LEATHER.deep   # beak tip
  Set-Pixel $bmp ($cx + 5) 19 $MAT_LEATHER.shadow
  # Lens eyes (glowing green)
  Shade-Disc $bmp ($cx - 2) 14 1 (@{
    deep=(Color-FromHex '#0a3018'); shadow=(Color-FromHex '#2a6034'); base=(Color-FromHex '#5fc4a8'); high=(Color-FromHex '#92e6cd'); top=(Color-FromHex '#bdf5e0');
  })
  # Vial in right hand (toxic green)
  Fill-Box $bmp ($cx + 11) 30 3 6 (Color-FromHex '#5fc4a8')
  Set-Pixel $bmp ($cx + 11) 30 (Color-FromHex '#bdf5e0')
  Fill-Box $bmp ($cx + 11) 29 3 1 $MAT_STEEL.high   # cap
  Apply-Rarity-Glow $bmp 'rare' 2 70
}

function Draw-Troop-V2-LightningSapper { param($bmp)
  Rng-Init "lightningSapper"
  $robe = @{
    deep   = (Color-FromHex '#1a1078');
    shadow = (Color-FromHex '#3a2cc4');
    base   = (Color-FromHex '#7c5cff');
    high   = (Color-FromHex '#b098ff');
    top    = (Color-FromHex '#e8dcff');
  }
  Draw-Troop-Base-V2 $bmp $SKIN_BASE $robe
  $cx = 32
  # Spiked-hair helm w/ goggles
  Shade-Box $bmp ($cx - 6) 8 13 7 $MAT_LEATHER_BLACK -RimLight
  Set-Pixel $bmp ($cx - 4) 13 $BRAND.Teal
  Set-Pixel $bmp ($cx + 4) 13 $BRAND.Teal
  # Lightning trail across torso
  Line-Pixel $bmp ($cx - 6) 26 ($cx + 6) 36 $BRAND.Teal
  Line-Pixel $bmp ($cx - 4) 28 ($cx + 4) 34 (Color-FromHex '#e8dcff')
  # Chain-shock device in right hand (small generator)
  Shade-Box $bmp ($cx + 9) 24 7 7 $MAT_COPPER -RimLight
  Set-Pixel $bmp ($cx + 12) 25 $BRAND.Teal
  Set-Pixel $bmp ($cx + 13) 26 (Color-FromHex '#e8dcff')
  # Lightning arc emanating from device
  Line-Pixel $bmp ($cx + 16) 24 ($cx + 18) 22 $BRAND.Teal
  Line-Pixel $bmp ($cx + 18) 22 ($cx + 16) 20 $BRAND.Teal
  Apply-Rarity-Glow $bmp 'epic' 3 120
}

function Draw-Troop-V2-StormCaller { param($bmp)
  Rng-Init "stormCaller"
  $robe = @{
    deep   = (Color-FromHex '#0a1632');
    shadow = (Color-FromHex '#1c3050');
    base   = (Color-FromHex '#365280');
    high   = (Color-FromHex '#6a8aba');
    top    = (Color-FromHex '#a4c0e0');
  }
  $cx = 32
  # Air rider — cloud platform underneath
  for ($x = 4; $x -lt 60; $x++) {
    $cloudY = 56 + [int]([Math]::Sin($x * 0.3) * 2)
    Blend-Pixel $bmp $x $cloudY (With-Alpha (Color-FromHex '#d8e0f0') 220)
    Blend-Pixel $bmp $x ($cloudY + 1) (With-Alpha (Color-FromHex '#a8b8d0') 200)
  }
  Draw-Troop-Base-V2 $bmp $SKIN_BASE $robe
  # Hood + cape billowing
  Fill-Box $bmp ($cx - 7) 8 15 7 $robe.deep
  Set-Pixel $bmp $cx 8 $robe.high
  # Eyes (glowing yellow lightning)
  Set-Pixel $bmp ($cx - 2) 14 $BRAND.GoldHi
  Set-Pixel $bmp ($cx + 2) 14 $BRAND.GoldHi
  # Cape trail
  Fill-Box $bmp ($cx - 12) 22 4 16 $robe.shadow
  Fill-Box $bmp ($cx + 9) 22 4 16 $robe.shadow
  # Lightning in upraised hand
  Line-Pixel $bmp ($cx - 14) 12 ($cx - 12) 22 $BRAND.GoldHi
  Line-Pixel $bmp ($cx - 12) 22 ($cx - 10) 28 (Color-FromHex '#fff8c0')
  Set-Pixel $bmp ($cx - 14) 10 (Color-FromHex '#fff8c0')
  Apply-Rarity-Glow $bmp 'epic' 3 130
}

# ── Goblin troops ─────────────────────────────────────────────────

function Draw-Troop-V2-GoblinScrapper { param($bmp)
  Rng-Init "goblinScrapper"
  Draw-Troop-Base-V2 $bmp $SKIN_GOBLIN $MAT_LEATHER
  $cx = 32
  # Pointy ears
  Set-Pixel $bmp ($cx - 7) 11 $SKIN_GOBLIN.shadow
  Set-Pixel $bmp ($cx - 8) 13 $SKIN_GOBLIN.shadow
  Set-Pixel $bmp ($cx + 7) 11 $SKIN_GOBLIN.shadow
  Set-Pixel $bmp ($cx + 8) 13 $SKIN_GOBLIN.shadow
  # Yellow eyes
  Set-Pixel $bmp ($cx - 2) 14 $BRAND.GoldHi
  Set-Pixel $bmp ($cx + 2) 14 $BRAND.GoldHi
  # Crooked teeth
  Set-Pixel $bmp ($cx - 1) 18 (Color-FromHex '#e0c8a0')
  Set-Pixel $bmp ($cx + 1) 18 (Color-FromHex '#e0c8a0')
  # Crude club
  Fill-Box $bmp ($cx + 9) 22 3 16 $MAT_WOOD_DARK.base
  Set-Pixel $bmp ($cx + 10) 22 $MAT_WOOD_DARK.high
  Shade-Box $bmp ($cx + 7) 18 7 6 $MAT_WOOD_DARK
}

function Draw-Troop-V2-GoblinArcher { param($bmp)
  Rng-Init "goblinArcher"
  Draw-Troop-Base-V2 $bmp $SKIN_GOBLIN $MAT_LEATHER
  $cx = 32
  Set-Pixel $bmp ($cx - 7) 11 $SKIN_GOBLIN.shadow
  Set-Pixel $bmp ($cx + 7) 11 $SKIN_GOBLIN.shadow
  Set-Pixel $bmp ($cx - 2) 14 $BRAND.GoldHi
  Set-Pixel $bmp ($cx + 2) 14 $BRAND.GoldHi
  # Crude shortbow
  for ($y = 0; $y -lt 20; $y++) {
    $offset = [int]([Math]::Sin(($y / 20.0) * [Math]::PI) * 3)
    Set-Pixel $bmp ($cx - 11 - $offset) (22 + $y) $MAT_WOOD_DARK.base
  }
  for ($y = 24; $y -lt 40; $y++) {
    Set-Pixel $bmp ($cx - 8) $y (Color-FromHex '#f0e6c8')
  }
  # Quiver
  Fill-Box $bmp ($cx + 6) 24 3 12 $MAT_LEATHER.deep
  Set-Pixel $bmp ($cx + 7) 22 (Color-FromHex '#e0d0b0')
}

function Draw-Troop-V2-GoblinSapper { param($bmp)
  Rng-Init "goblinSapper"
  Draw-Troop-Base-V2 $bmp $SKIN_GOBLIN $MAT_LEATHER_BLACK
  $cx = 32
  Set-Pixel $bmp ($cx - 7) 11 $SKIN_GOBLIN.shadow
  Set-Pixel $bmp ($cx + 7) 11 $SKIN_GOBLIN.shadow
  Set-Pixel $bmp ($cx - 2) 14 $BRAND.Crimson
  Set-Pixel $bmp ($cx + 2) 14 $BRAND.Crimson
  # HUGE bomb strapped to chest
  Shade-Disc $bmp $cx 32 7 $MAT_OBSIDIAN -RimLight
  Set-Pixel $bmp $cx 24 $MAT_WOOD_DARK.base
  Set-Pixel $bmp $cx 22 $BRAND.Crimson
  Set-Pixel $bmp ($cx + 1) 21 $BRAND.GoldHi
  Set-Pixel $bmp ($cx - 1) 22 $BRAND.GoldHi
  Apply-Rarity-Glow $bmp 'rare' 2 90
}

function Draw-Troop-V2-GoblinChief { param($bmp)
  Rng-Init "goblinChief"
  $cloth = @{
    deep=(Color-FromHex '#2a0e08'); shadow=(Color-FromHex '#5a1c14'); base=(Color-FromHex '#8a2c20');
    high=(Color-FromHex '#b85040'); top=(Color-FromHex '#d87060');
  }
  Draw-Troop-Base-V2 $bmp $SKIN_GOBLIN $cloth
  $cx = 32
  # Skull helm
  Shade-Box $bmp ($cx - 6) 6 13 9 $MAT_IRON -RimLight
  # Horns
  Line-Pixel $bmp ($cx - 5) 6 ($cx - 9) 2 $MAT_IRON.base
  Line-Pixel $bmp ($cx + 5) 6 ($cx + 9) 2 $MAT_IRON.base
  Set-Pixel $bmp ($cx - 9) 2 $MAT_IRON.top
  Set-Pixel $bmp ($cx + 9) 2 $MAT_IRON.top
  # Glowing red eyes
  Set-Pixel $bmp ($cx - 2) 12 $BRAND.Crimson
  Set-Pixel $bmp ($cx + 2) 12 $BRAND.Crimson
  Set-Pixel $bmp ($cx - 2) 13 $BRAND.GoldHi
  Set-Pixel $bmp ($cx + 2) 13 $BRAND.GoldHi
  # Big iron axe
  Fill-Box $bmp ($cx + 10) 14 2 26 $MAT_WOOD_DARK.base
  Shade-Box $bmp ($cx + 8) 10 9 6 $MAT_IRON -RimLight
  for ($x = ($cx + 8); $x -lt ($cx + 17); $x++) {
    Set-Pixel $bmp $x 10 $MAT_IRON.top
  }
  # Trophy bones on belt
  Set-Pixel $bmp ($cx - 6) 38 (Color-FromHex '#e0d0b0')
  Set-Pixel $bmp ($cx + 5) 38 (Color-FromHex '#e0d0b0')
  Apply-Rarity-Glow $bmp 'rare' 2 80
}

function Draw-Troop-V2-GoblinMage { param($bmp)
  Rng-Init "goblinMage"
  $robe = @{
    deep   = (Color-FromHex '#240a40');
    shadow = (Color-FromHex '#4a1a78');
    base   = (Color-FromHex '#7c3acb');
    high   = (Color-FromHex '#a878f0');
    top    = (Color-FromHex '#d8b8ff');
  }
  Draw-Troop-Base-V2 $bmp $SKIN_GOBLIN $robe
  $cx = 32
  # Pointed hat
  for ($i = 0; $i -lt 10; $i++) {
    $w = 10 - $i
    $x0 = $cx - [int]($w / 2)
    Fill-Box $bmp $x0 (20 - $i) $w 1 $robe.base
    Set-Pixel $bmp $x0 (20 - $i) $robe.shadow
  }
  Set-Pixel $bmp $cx 11 $BRAND.Crimson
  # Brim
  Fill-Box $bmp ($cx - 7) 20 15 1 $robe.deep
  # Skull-staff
  for ($y = 14; $y -lt 50; $y++) {
    Set-Pixel $bmp ($cx + 12) $y $MAT_WOOD_DARK.base
  }
  Shade-Disc $bmp ($cx + 12) 11 4 (@{
    deep=(Color-FromHex '#3a1818'); shadow=(Color-FromHex '#6a2a2a'); base=(Color-FromHex '#a0a0a0');
    high=(Color-FromHex '#cbcbcb'); top=(Color-FromHex '#ebebeb');
  })
  Set-Pixel $bmp ($cx + 11) 11 $BRAND.Crimson
  Set-Pixel $bmp ($cx + 13) 11 $BRAND.Crimson
  Apply-Rarity-Glow $bmp 'epic' 3 100
}

function Draw-Troop-V2-GoblinKing { param($bmp)
  Rng-Init "goblinKing"
  $robe = @{
    deep=(Color-FromHex '#3a0a18'); shadow=(Color-FromHex '#7a1428'); base=(Color-FromHex '#c8203c');
    high=(Color-FromHex '#f8506a'); top=(Color-FromHex '#ffaabc');
  }
  Draw-Troop-Base-V2 $bmp $SKIN_GOBLIN $robe
  $cx = 32
  # Big golden crown
  Fill-Box $bmp ($cx - 7) 8 15 4 $MAT_GOLD.base
  Set-Pixel $bmp ($cx - 7) 8 $MAT_GOLD.shadow
  Set-Pixel $bmp ($cx + 7) 8 $MAT_GOLD.high
  # Crown spikes
  for ($i = 0; $i -lt 5; $i++) {
    $sx = $cx - 6 + $i * 3
    Fill-Box $bmp $sx 5 2 3 $MAT_GOLD.base
    Set-Pixel $bmp ($sx + 1) 4 $MAT_GOLD.top
    if ($i -eq 2) {
      Draw-Gem $bmp ($sx + 1) 6 3 $GEM_RUBY
    }
  }
  # Cape
  Fill-Box $bmp ($cx - 14) 22 4 30 (Color-FromHex '#5a0a10')
  Fill-Box $bmp ($cx + 11) 22 4 30 (Color-FromHex '#5a0a10')
  Set-Pixel $bmp ($cx - 14) 22 $MAT_GOLD.high
  Set-Pixel $bmp ($cx + 14) 22 $MAT_GOLD.high
  # Red eyes
  Set-Pixel $bmp ($cx - 2) 16 $BRAND.GoldHi
  Set-Pixel $bmp ($cx + 2) 16 $BRAND.GoldHi
  # Royal staff with skull
  for ($y = 14; $y -lt 56; $y++) {
    Set-Pixel $bmp ($cx + 14) $y $MAT_GOLD.base
    Set-Pixel $bmp ($cx + 13) $y $MAT_GOLD.shadow
  }
  Shade-Disc $bmp ($cx + 14) 10 4 (@{
    deep=$MAT_GOLD.deep; shadow=$MAT_GOLD.shadow; base=$MAT_GOLD.base; high=$MAT_GOLD.high; top=$MAT_GOLD.top;
  })
  Draw-Gem $bmp ($cx + 14) 10 5 $GEM_RUBY
  Apply-Rarity-Glow $bmp 'legendary' 3 150
}

function Draw-Troop-V2-GoblinSkyrider { param($bmp)
  Rng-Init "goblinSkyrider"
  $cx = 32
  # Bat-wing glider
  for ($i = 0; $i -lt 10; $i++) {
    $w = 22 - $i * 2
    if ($w -lt 4) { break }
    $x0 = $cx - [int]($w / 2)
    Fill-Box $bmp $x0 (4 + $i) $w 1 (Color-FromHex '#3a1c2e')
    Set-Pixel $bmp ($x0 + [int]($w / 2)) (4 + $i) (Color-FromHex '#5a2c40')
  }
  Set-Pixel $bmp $cx 4 (Color-FromHex '#1c0c18')
  Line-Pixel $bmp ($cx - 10) 6 $cx 14 (Color-FromHex '#1c0c18')
  Line-Pixel $bmp ($cx + 10) 6 $cx 14 (Color-FromHex '#1c0c18')
  Draw-Troop-Base-V2 $bmp $SKIN_GOBLIN $MAT_LEATHER_BLACK
  # Yellow eyes
  Set-Pixel $bmp ($cx - 2) 14 $BRAND.GoldHi
  Set-Pixel $bmp ($cx + 2) 14 $BRAND.GoldHi
  Blend-Pixel $bmp ($cx - 4) 60 (With-Alpha (Color-FromHex '#a8b8d0') 200)
  Blend-Pixel $bmp ($cx + 4) 60 (With-Alpha (Color-FromHex '#a8b8d0') 200)
  Apply-Rarity-Glow $bmp 'rare' 2 80
}

function Draw-Troop-V2-Wyrm { param($bmp)
  Rng-Init "wyrm"
  $cx = 32
  # Serpentine dragon — body curls across the canvas
  # Wings span top
  for ($i = 0; $i -lt 16; $i++) {
    $w = 30 - $i * 2
    if ($w -lt 6) { break }
    $x0 = $cx - [int]($w / 2)
    Fill-Box $bmp $x0 (4 + $i) $w 1 (Color-FromHex '#2a1a08')
    Set-Pixel $bmp ($x0 + 1) (4 + $i) (Color-FromHex '#6a4a18')
    Set-Pixel $bmp ($x0 + $w - 2) (4 + $i) (Color-FromHex '#6a4a18')
  }
  # Wing ribs
  Line-Pixel $bmp ($cx - 14) 6 $cx 18 (Color-FromHex '#1a0c08')
  Line-Pixel $bmp ($cx + 14) 6 $cx 18 (Color-FromHex '#1a0c08')
  Line-Pixel $bmp ($cx - 10) 4 ($cx - 4) 18 (Color-FromHex '#1a0c08')
  Line-Pixel $bmp ($cx + 10) 4 ($cx + 4) 18 (Color-FromHex '#1a0c08')

  # Body (serpentine, gold-scaled)
  $bodyRamp = $MAT_GOLD
  # Head — looking forward
  Shade-Disc $bmp $cx 26 9 $bodyRamp -RimLight
  # Snout
  Fill-Box $bmp ($cx + 4) 26 8 4 $bodyRamp.base
  Set-Pixel $bmp ($cx + 11) 26 $bodyRamp.shadow
  # Glowing red eyes
  Set-Pixel $bmp ($cx - 3) 24 $BRAND.Crimson
  Set-Pixel $bmp ($cx + 3) 24 $BRAND.Crimson
  Set-Pixel $bmp ($cx - 3) 25 $BRAND.GoldHi
  Set-Pixel $bmp ($cx + 3) 25 $BRAND.GoldHi
  # Horns
  Line-Pixel $bmp ($cx - 6) 21 ($cx - 10) 16 $bodyRamp.shadow
  Line-Pixel $bmp ($cx + 6) 21 ($cx + 10) 16 $bodyRamp.shadow
  Set-Pixel $bmp ($cx - 10) 16 $bodyRamp.top
  Set-Pixel $bmp ($cx + 10) 16 $bodyRamp.top
  # Body coils
  Shade-Oval $bmp $cx 42 14 6 $bodyRamp
  # Scale pattern
  for ($x = ($cx - 12); $x -lt ($cx + 12); $x += 3) {
    Set-Pixel $bmp $x 40 $bodyRamp.shadow
    Set-Pixel $bmp ($x + 1) 41 $bodyRamp.shadow
  }
  # Tail tip
  Line-Pixel $bmp ($cx + 14) 42 ($cx + 18) 50 $bodyRamp.base
  Set-Pixel $bmp ($cx + 18) 50 $bodyRamp.top
  # Fire breath puff in front of snout
  Blend-Pixel $bmp ($cx + 13) 27 (With-Alpha (Color-FromHex '#f8a050') 220)
  Blend-Pixel $bmp ($cx + 15) 26 (With-Alpha (Color-FromHex '#e85a30') 200)
  Blend-Pixel $bmp ($cx + 14) 28 (With-Alpha (Color-FromHex '#fff8c0') 220)
  Apply-Rarity-Glow $bmp 'legendary' 4 180
}

# ── Dispatch ───────────────────────────────────────────────────────

function Draw-Building {
  param($bmp, [string]$kind, [int]$level)
  switch ($kind) {
    'townhall'      { Draw-Building-TownHall      $bmp $level }
    'cannon'        { Draw-Building-Cannon        $bmp $level }
    'archerTower'   { Draw-Building-ArcherTower   $bmp $level }
    'storage'       { Draw-Building-Storage       $bmp $level }
    'barracks'      { Draw-Building-Barracks      $bmp $level }
    'trap'          { Draw-Building-Trap          $bmp $level }
    'warTent'       { Draw-Building-WarTent       $bmp $level }
    'sawmill'       { Draw-Building-Sawmill       $bmp $level }
    'quarry'        { Draw-Building-Quarry        $bmp $level }
    'forge'         { Draw-Building-Forge         $bmp $level }
    'mint'          { Draw-Building-Mint          $bmp $level }
    'workshop'      { Draw-Building-Workshop      $bmp $level }
    'buildersHut'   { Draw-Building-BuildersHut   $bmp $level }
    'lumberVault'   { Draw-Building-LumberVault   $bmp $level }
    'stoneVault'    { Draw-Building-StoneVault    $bmp $level }
    'ironVault'     { Draw-Building-IronVault     $bmp $level }
    'goldVault'     { Draw-Building-GoldVault     $bmp $level }
    'mortar'        { Draw-Building-Mortar        $bmp $level }
    'mageTower'     { Draw-Building-MageTower     $bmp $level }
    'skywardBow'    { Draw-Building-SkywardBow    $bmp $level }
    'bombTower'     { Draw-Building-BombTower     $bmp $level }
    'voltaicCoil'   { Draw-Building-VoltaicCoil   $bmp $level }
    'heavyCannon'   { Draw-Building-HeavyCannon   $bmp $level }
    'infernoTower'  { Draw-Building-InfernoTower  $bmp $level }
    'eagleEye'      { Draw-Building-EagleEye      $bmp $level }
    'springTrap'    { Draw-Building-SpringTrap    $bmp $level }
    'skyMine'       { Draw-Building-SkyMine       $bmp $level }
    'staticTrap'    { Draw-Building-StaticTrap    $bmp $level }
    'caltrops'      { Draw-Building-Caltrops      $bmp $level }
    'infernoTrap'   { Draw-Building-InfernoTrap   $bmp $level }
    'decoyBanner'   { Draw-Building-DecoyBanner   $bmp $level }
    default         { throw "Unknown building kind: $kind" }
  }
}

function Draw-Troop {
  param($bmp, [string]$troopId)
  switch ($troopId) {
    'scrapper'        { Draw-Troop-V2-Scrapper        $bmp }
    'boltKnight'      { Draw-Troop-V2-BoltKnight      $bmp }
    'archerLite'      { Draw-Troop-V2-Archer          $bmp }
    'voltaicMage'     { Draw-Troop-V2-VoltaicMage     $bmp }
    'sapperRogue'     { Draw-Troop-V2-SapperRogue     $bmp }
    'healerCleric'    { Draw-Troop-V2-HealerCleric    $bmp }
    'sneak'           { Draw-Troop-V2-Sneak           $bmp }
    'batteringRam'    { Draw-Troop-V2-BatteringRam    $bmp }
    'skyrider'        { Draw-Troop-V2-Skyrider        $bmp }
    'plagueDoctor'    { Draw-Troop-V2-PlagueDoctor    $bmp }
    'lightningSapper' { Draw-Troop-V2-LightningSapper $bmp }
    'stormCaller'     { Draw-Troop-V2-StormCaller     $bmp }
    'goblinScrapper'  { Draw-Troop-V2-GoblinScrapper  $bmp }
    'goblinArcher'    { Draw-Troop-V2-GoblinArcher    $bmp }
    'goblinSapper'    { Draw-Troop-V2-GoblinSapper    $bmp }
    'goblinChief'     { Draw-Troop-V2-GoblinChief     $bmp }
    'goblinMage'      { Draw-Troop-V2-GoblinMage      $bmp }
    'goblinKing'      { Draw-Troop-V2-GoblinKing      $bmp }
    'goblinSkyrider'  { Draw-Troop-V2-GoblinSkyrider  $bmp }
    'wyrm'            { Draw-Troop-V2-Wyrm            $bmp }
    default           { throw "Unknown troop id: $troopId" }
  }
}

# ── Manifest — what to render ──────────────────────────────────────

$BUILDING_MANIFEST = @(
  @{ kind='townhall';     min=1; max=10 },
  @{ kind='cannon';       min=1; max=7  },
  @{ kind='archerTower';  min=1; max=7  },
  @{ kind='storage';      min=1; max=4  },
  @{ kind='barracks';     min=1; max=4  },
  @{ kind='trap';         min=1; max=3  },
  @{ kind='warTent';      min=1; max=3  },
  @{ kind='sawmill';      min=1; max=5  },
  @{ kind='quarry';       min=1; max=5  },
  @{ kind='forge';        min=1; max=5  },
  @{ kind='mint';         min=1; max=5  },
  @{ kind='workshop';     min=1; max=4  },
  @{ kind='buildersHut';  min=1; max=4  },
  @{ kind='lumberVault';  min=1; max=4  },
  @{ kind='stoneVault';   min=1; max=4  },
  @{ kind='ironVault';    min=1; max=4  },
  @{ kind='goldVault';    min=1; max=4  },
  @{ kind='mortar';       min=1; max=6  },
  @{ kind='mageTower';    min=1; max=5  },
  @{ kind='skywardBow';   min=1; max=5  },
  @{ kind='bombTower';    min=1; max=4  },
  @{ kind='voltaicCoil';  min=1; max=5  },
  @{ kind='heavyCannon';  min=5; max=7  },
  @{ kind='infernoTower'; min=6; max=8  },
  @{ kind='eagleEye';     min=8; max=10 },
  @{ kind='springTrap';   min=1; max=3  },
  @{ kind='skyMine';      min=1; max=3  },
  @{ kind='staticTrap';   min=1; max=3  },
  @{ kind='caltrops';     min=1; max=2  },
  @{ kind='infernoTrap';  min=1; max=3  },
  @{ kind='decoyBanner';  min=1; max=2  }
)

$TROOP_MANIFEST = @(
  'scrapper','boltKnight','archerLite','voltaicMage','sapperRogue','healerCleric',
  'sneak','batteringRam','skyrider','plagueDoctor','lightningSapper','stormCaller',
  'goblinScrapper','goblinArcher','goblinSapper','goblinChief','goblinMage','goblinKing','goblinSkyrider',
  'wyrm'
)

# Render loops.
function Build-Buildings {
  Write-Host '── v2 buildings ──' -ForegroundColor Cyan
  $count = 0
  foreach ($entry in $BUILDING_MANIFEST) {
    if (-not (Should-Render $entry.kind)) { continue }
    for ($lv = $entry.min; $lv -le $entry.max; $lv++) {
      $bmp = New-CanvasFx $BUILDING_W $BUILDING_H
      Draw-Building $bmp $entry.kind $lv
      Save-CanvasFx $bmp (Join-Path $buildingDir ("{0}-L{1}.png" -f $entry.kind, $lv))
      $count++
    }
    Write-Host ("  {0,-14} L{1}..L{2}" -f $entry.kind, $entry.min, $entry.max) -ForegroundColor DarkGray
  }
  Write-Host ("  buildings: {0}" -f $count) -ForegroundColor Green
}

# Walls — 16 bitmask × 8 levels = 128 sprites. Saved as
#   wall-L<level>-<mask2>.png   where mask2 is "00".."15".
function Build-Walls {
  if ($Only -and $Only.Count -gt 0 -and -not ($Only -contains 'wall')) { return }
  Write-Host '── v2 walls (16 mask × 8 levels) ──' -ForegroundColor Cyan
  $count = 0
  for ($lv = 1; $lv -le 8; $lv++) {
    for ($mask = 0; $mask -lt 16; $mask++) {
      $bmp = New-CanvasFx $BUILDING_W $BUILDING_H
      Draw-Wall-V2 $bmp $lv $mask
      $maskStr = '{0:D2}' -f $mask
      Save-CanvasFx $bmp (Join-Path $buildingDir ("wall-L{0}-{1}.png" -f $lv, $maskStr))
      $count++
    }
    Write-Host ("  wall L{0}: 16 variants" -f $lv) -ForegroundColor DarkGray
  }
  Write-Host ("  walls: {0}" -f $count) -ForegroundColor Green
}

function Build-Troops {
  if ($Only -and $Only.Count -gt 0) {
    $wanted = $TROOP_MANIFEST | Where-Object { $Only -contains $_ }
  } else { $wanted = $TROOP_MANIFEST }
  Write-Host '── v2 troops ──' -ForegroundColor Cyan
  $count = 0
  foreach ($troopId in $wanted) {
    $bmp = New-CanvasFx $TROOP_W $TROOP_H
    Draw-Troop $bmp $troopId
    Save-CanvasFx $bmp (Join-Path $troopDir ("{0}.png" -f $troopId))
    $count++
    Write-Host ("  troop: {0}" -f $troopId) -ForegroundColor DarkGray
  }
  Write-Host ("  troops: {0}" -f $count) -ForegroundColor Green
}

Build-Buildings
Build-Walls
Build-Troops

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "Output: $clashDir"
