# CR-1 expansion sprite generator.
#
# Consumes tools/expansion-cards.json (produced by
# tools/dump-expansion-manifest.mjs) and renders ~1,170 64×80 sprites
# under aquilo-gg/sprites/cards/ via a small set of archetype
# templates parameterised by family palette + rarity detail tier.
#
# Quality bar matches the original 82-sprite pass: silhouette + 3-5
# tone shading, accent details that scale up with rarity, animated
# APNG halo for legendaries (4 frames). No emoji.
#
# Templates (one per visualArchetype produced by cards-expansion.js):
#   humanoid-warrior  · humanoid-mage  · humanoid-rogue  · humanoid-priest
#   beast-quad        · beast-bird
#   undead-skeleton   · undead-zombie
#   elemental-fire    · elemental-frost · elemental-storm
#   construct-golem
#   dragon-flier
#   demon-fiend
#   spell-bolt · spell-circle · spell-heal · spell-buff · spell-leaf ·
#   spell-skull · spell-eye · spell-sun · spell-rune · spell-gear ·
#   spell-pact · spell-star · spell-crystal · spell-flame · spell-key ·
#   spell-bomb · spell-dragon
#
# Usage:
#   node tools/dump-expansion-manifest.mjs           # refresh manifest
#   pwsh -File tools/build-card-sprites-expansion.ps1
#   pwsh -File tools/build-card-sprites-expansion.ps1 -Family beast
#   pwsh -File tools/build-card-sprites-expansion.ps1 -Limit 10
#   node tools/build-card-apng.mjs                   # stitch legendary APNGs
#
# Idempotent — re-running overwrites.

[CmdletBinding()]
param(
  [string]$OutRoot = '',
  [string]$Family  = '',      # restrict to a single family id (beast, fire, ...)
  [string]$Archetype = '',    # restrict to a single visualArchetype
  [int]$Limit       = 0,      # 0 = unlimited; positive = stop after N sprites
  [switch]$Force              # overwrite even if the PNG already exists
)
$ErrorActionPreference = 'Stop'
# $PSScriptRoot is empty under some -File launches; derive from MyInvocation.
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $OutRoot) { $OutRoot = Join-Path (Split-Path -Parent $ScriptDir) 'aquilo-gg/sprites' }
. (Join-Path $ScriptDir 'lib-pixel.ps1')

$cardDir   = Join-Path $OutRoot 'cards'
$framesDir = Join-Path $OutRoot '_card-legendary-frames'
foreach ($d in @($cardDir, $framesDir)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

$CARD_W = 64
$CARD_H = 80
$GROUND_Y = 78
$CARD_CX  = 32

# ── Palettes — one per family, mapped from paletteHint ───────────────

$PAL = @{}
function Mk-Ramp { param([string]$deep, [string]$shadow, [string]$base, [string]$high, [string]$top)
  return @{ deep = (Color-FromHex $deep); shadow = (Color-FromHex $shadow); base = (Color-FromHex $base); high = (Color-FromHex $high); top = (Color-FromHex $top); }
}
$PAL['fur-brown']      = Mk-Ramp '#1c0c04' '#4a2810' '#7a4818' '#aa7838' '#d8a868'
$PAL['bone-grey']      = Mk-Ramp '#181a20' '#3a3e48' '#6a6e7a' '#a0a4ae' '#d0d4dc'
$PAL['flame-orange']   = Mk-Ramp '#3a0a00' '#8a2400' '#d04408' '#f08428' '#ffd068'
$PAL['ice-cyan']       = Mk-Ramp '#0a2034' '#1a4068' '#3878a8' '#78b8d8' '#d0f0f8'
$PAL['voltaic-blue']   = Mk-Ramp '#0a0a3a' '#2828a8' '#5050ec' '#9890ff' '#e4e0ff'
$PAL['shadow-violet']  = Mk-Ramp '#0a0418' '#221038' '#4a2868' '#7a5098' '#b890d8'
$PAL['gold-cream']     = Mk-Ramp '#3a2808' '#8a6818' '#d0a440' '#f0d488' '#fff8d0'
$PAL['arcane-purple']  = Mk-Ramp '#10084a' '#3018a0' '#6840d8' '#a888f0' '#e0c8ff'
$PAL['leaf-green']     = Mk-Ramp '#0a2818' '#205838' '#3a9858' '#78c878' '#c0f0c0'
$PAL['iron-grey']      = Mk-Ramp '#181818' '#383838' '#686868' '#a0a0a0' '#d8d8d8'
$PAL['goblin-green']   = Mk-Ramp '#0a3010' '#206020' '#509030' '#90c060' '#d8f098'
$PAL['dragon-crimson'] = Mk-Ramp '#3a0408' '#7a1818' '#c83838' '#f07878' '#ffc8c8'
$PAL['demon-magenta']  = Mk-Ramp '#380020' '#780848' '#b81878' '#e870b0' '#ffc8e0'
$PAL['fae-rose']       = Mk-Ramp '#3a1438' '#7a3070' '#c060a8' '#e898d0' '#fff0fa'
$PAL['vault-gold']     = Mk-Ramp '#3a2400' '#8a6010' '#d09818' '#f0c860' '#fff0a8'

function Get-Palette { param([string]$hint)
  if ($PAL.ContainsKey($hint)) { return $PAL[$hint] }
  return $PAL['fur-brown']
}

# Rarity-tier detail multipliers — higher rarity = more layered detail.
function Detail-Tier { param([string]$rarity)
  switch ($rarity) {
    'common'    { return @{ accents = 0; rim = $false; halo = $false } }
    'uncommon'  { return @{ accents = 1; rim = $true;  halo = $false } }
    'rare'      { return @{ accents = 2; rim = $true;  halo = $true  } }
    'legendary' { return @{ accents = 3; rim = $true;  halo = $true  } }
    'token'     { return @{ accents = 0; rim = $false; halo = $false } }
    default     { return @{ accents = 0; rim = $false; halo = $false } }
  }
}

# ── Shared utilities ────────────────────────────────────────────────

function Draw-GroundShadow-Card {
  param($bmp, [int]$cx, [int]$y, [int]$halfW)
  $shadow = (Color-FromHex '#040408')
  for ($dx = -$halfW; $dx -le $halfW; $dx++) {
    $a = 130 - [Math]::Abs($dx) * (110 / [Math]::Max(1, $halfW))
    if ($a -lt 20) { continue }
    Blend-Pixel $bmp ($cx + $dx) $y (With-Alpha $shadow ([int]$a))
  }
}

function Apply-Card-Glow {
  param($bmp, [string]$rarity)
  $cfg = switch ($rarity) {
    'champion'  { @{ color = (Color-FromHex '#fff0a0'); r = 2; a = 90 } }
    'common'    { @{ color = (Color-FromHex '#a8a8b0'); r = 1; a = 50 } }
    'uncommon'  { @{ color = (Color-FromHex '#5be098'); r = 1; a = 90 } }
    'rare'      { @{ color = (Color-FromHex '#6ec0ff'); r = 2; a = 100 } }
    'legendary' { @{ color = (Color-FromHex '#fff0a0'); r = 3; a = 140 } }
    default     { @{ color = (Color-FromHex '#a8a8b0'); r = 1; a = 50 } }
  }
  Add-GlowHalo $bmp $cfg.color $cfg.r $cfg.a
}

# Eye color picks lightly differ by family palette to add per-family
# read.
function Eye-Color { param([string]$paletteHint)
  switch ($paletteHint) {
    'flame-orange'  { return (Color-FromHex '#ffd060') }
    'ice-cyan'      { return (Color-FromHex '#a0e0ff') }
    'voltaic-blue'  { return (Color-FromHex '#80a0ff') }
    'shadow-violet' { return (Color-FromHex '#c890ff') }
    'demon-magenta' { return (Color-FromHex '#ff60a0') }
    'fae-rose'      { return (Color-FromHex '#ff90e0') }
    'goblin-green'  { return (Color-FromHex '#ffd048') }
    'dragon-crimson'{ return (Color-FromHex '#ffa040') }
    default         { return (Color-FromHex '#1a1422') }
  }
}

# Skin/body palette for "humanoid"-like archetypes — different per
# family so the silhouette reads.
function Skin-Of { param([string]$paletteHint)
  switch ($paletteHint) {
    'shadow-violet' { return @{ deep=(Color-FromHex '#2a1a4a'); shadow=(Color-FromHex '#4a2e7a'); base=(Color-FromHex '#7a5cb0'); high=(Color-FromHex '#a888d4'); top=(Color-FromHex '#d0b8ec') } }
    'goblin-green'  { return @{ deep=(Color-FromHex '#1a3a18'); shadow=(Color-FromHex '#3a6a30'); base=(Color-FromHex '#5e9a4c'); high=(Color-FromHex '#8ec078'); top=(Color-FromHex '#b4dca0') } }
    'demon-magenta' { return @{ deep=(Color-FromHex '#3a0820'); shadow=(Color-FromHex '#7a2050'); base=(Color-FromHex '#b04880'); high=(Color-FromHex '#d878a8'); top=(Color-FromHex '#f0a8c8') } }
    'flame-orange'  { return @{ deep=(Color-FromHex '#5a2010'); shadow=(Color-FromHex '#a04020'); base=(Color-FromHex '#d87038'); high=(Color-FromHex '#f0a468'); top=(Color-FromHex '#ffd098') } }
    'fae-rose'      { return @{ deep=(Color-FromHex '#946c50'); shadow=(Color-FromHex '#c89c80'); base=(Color-FromHex '#f0d4ba'); high=(Color-FromHex '#ffe6d0'); top=(Color-FromHex '#fff4e2') } }
    default         { return @{ deep=(Color-FromHex '#7a4830'); shadow=(Color-FromHex '#b07a55'); base=(Color-FromHex '#e8c098'); high=(Color-FromHex '#f8dab2'); top=(Color-FromHex '#ffeed0') } }
  }
}

# ── Archetype: humanoid-warrior (generic) ────────────────────────────

function Draw-Arch-HumanoidWarrior {
  param($bmp, $palette, $card, $tier)
  $skin = Skin-Of $card.paletteHint
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  # Head
  $headY = 22
  $headR = 7
  Shade-Disc $bmp $CARD_CX $headY $headR $skin
  $eyeCol = Eye-Color $card.paletteHint
  Set-Pixel $bmp ($CARD_CX - 2) $headY $eyeCol
  Set-Pixel $bmp ($CARD_CX + 2) $headY $eyeCol
  # Helm (band across forehead, full helm if uncommon+)
  if ($tier.accents -ge 1) {
    Fill-Box $bmp ($CARD_CX - 7) ($headY - $headR - 2) 14 5 $palette.shadow
    for ($x = $CARD_CX - 7; $x -le $CARD_CX + 6; $x++) { Set-Pixel $bmp $x ($headY - $headR - 2) $palette.high }
  }
  if ($tier.accents -ge 2) {
    Fill-Box $bmp ($CARD_CX - 4) ($headY - 1) 9 2 (Color-FromHex '#040408')
    Set-Pixel $bmp ($CARD_CX - 2) $headY $palette.top
    Set-Pixel $bmp ($CARD_CX + 2) $headY $palette.top
  }
  # Torso
  $torsoY = $headY + $headR + 2
  $torsoW = 18
  $torsoH = 22
  Shade-Box $bmp ($CARD_CX - 9) $torsoY $torsoW $torsoH $palette -RimLight:$tier.rim
  # Accent stripe
  for ($yy = $torsoY + 1; $yy -lt $torsoY + $torsoH - 1; $yy++) { Set-Pixel $bmp $CARD_CX $yy $palette.top }
  # Arms (boxes hanging beside torso)
  Shade-Box $bmp ($CARD_CX - 14) ($torsoY + 1) 3 ($torsoH - 4) $palette
  Shade-Box $bmp ($CARD_CX + 12) ($torsoY + 1) 3 ($torsoH - 4) $palette
  # Hands
  Fill-Box $bmp ($CARD_CX - 15) ($torsoY + $torsoH - 4) 3 3 $skin.base
  Fill-Box $bmp ($CARD_CX + 13) ($torsoY + $torsoH - 4) 3 3 $skin.base
  # Legs
  $legY = $torsoY + $torsoH
  $legH = 16
  Shade-Box $bmp ($CARD_CX - 5) $legY 4 $legH $palette
  Shade-Box $bmp ($CARD_CX + 2) $legY 4 $legH $palette
  # Boots
  Fill-Box $bmp ($CARD_CX - 6) ($legY + $legH) 5 2 $palette.deep
  Fill-Box $bmp ($CARD_CX + 1) ($legY + $legH) 5 2 $palette.deep
  # Weapon arm (rare+): sword on right side, up-right
  if ($tier.accents -ge 2) {
    $bladeRamp = @{ deep=(Color-FromHex '#181a20'); shadow=(Color-FromHex '#48505a'); base=(Color-FromHex '#888c98'); high=(Color-FromHex '#c0c4cc'); top=(Color-FromHex '#f0f0f4') }
    Draw-Blade $bmp ($CARD_CX + 16) ($torsoY + $torsoH - 24) ($torsoY + $torsoH - 2) 3 $bladeRamp
  }
}

# ── Archetype: humanoid-mage ─────────────────────────────────────────

function Draw-Arch-HumanoidMage {
  param($bmp, $palette, $card, $tier)
  $skin = Skin-Of $card.paletteHint
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $headY = 24
  $headR = 7
  # Pointed wizard hat (rarity scales height)
  $hatH = if ($tier.accents -ge 2) { 14 } elseif ($tier.accents -ge 1) { 10 } else { 6 }
  for ($i = 0; $i -lt $hatH; $i++) {
    $w = [Math]::Max(1, $hatH - $i)
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($headY - $headR - 2 - $i) $w 1 $palette.base
    Set-Pixel $bmp $x0 ($headY - $headR - 2 - $i) $palette.shadow
    Set-Pixel $bmp ($x0 + $w - 1) ($headY - $headR - 2 - $i) $palette.high
  }
  # Hat tip jewel for rare+
  if ($tier.accents -ge 2) { Set-Pixel $bmp $CARD_CX ($headY - $headR - 1 - $hatH) $palette.top }
  # Head
  Shade-Disc $bmp $CARD_CX $headY $headR $skin
  $eye = Eye-Color $card.paletteHint
  Set-Pixel $bmp ($CARD_CX - 2) $headY $eye
  Set-Pixel $bmp ($CARD_CX + 2) $headY $eye
  # Robe (wider at bottom)
  $torsoY = $headY + $headR + 1
  for ($yy = 0; $yy -lt 28; $yy++) {
    $w = 14 + [int]($yy * 0.5)
    $x0 = $CARD_CX - [int]($w / 2)
    $col = if ($yy % 8 -lt 2) { $palette.shadow } else { $palette.base }
    Fill-Box $bmp $x0 ($torsoY + $yy) $w 1 $col
    if ($tier.rim) { Set-Pixel $bmp $x0 ($torsoY + $yy) $palette.high }
  }
  # Sleeves
  Shade-Box $bmp ($CARD_CX - 13) ($torsoY + 3) 3 12 $palette
  Shade-Box $bmp ($CARD_CX + 11) ($torsoY + 3) 3 12 $palette
  # Staff (right hand)
  if ($tier.accents -ge 1) {
    $staffRamp = @{ deep=(Color-FromHex '#2a1a08'); shadow=(Color-FromHex '#6a4818'); base=(Color-FromHex '#a07840'); high=(Color-FromHex '#d0a868'); top=(Color-FromHex '#f0d8a0') }
    Shade-Box $bmp ($CARD_CX + 13) ($torsoY) 2 22 $staffRamp
    Shade-Disc $bmp ($CARD_CX + 14) ($torsoY - 3) 3 $palette
  }
}

# ── Archetype: humanoid-rogue ────────────────────────────────────────

function Draw-Arch-HumanoidRogue {
  param($bmp, $palette, $card, $tier)
  $skin = Skin-Of $card.paletteHint
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 11
  $headY = 24
  $headR = 6
  # Hood — palette shadow, peaked
  for ($i = 0; $i -lt 14; $i++) {
    $w = 14 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($headY - $headR + $i - 6) $w 1 $palette.shadow
    if ($i -eq 0) { Set-Pixel $bmp $x0 ($headY - $headR + $i - 6) $palette.deep }
  }
  Shade-Disc $bmp $CARD_CX $headY $headR $skin
  $eye = Eye-Color $card.paletteHint
  # Hooded eyes — narrow slit
  Set-Pixel $bmp ($CARD_CX - 2) $headY $eye
  Set-Pixel $bmp ($CARD_CX + 2) $headY $eye
  # Cloak/torso
  $torsoY = $headY + $headR
  Shade-Box $bmp ($CARD_CX - 8) $torsoY 16 24 $palette
  # Cloak wings (rare+)
  if ($tier.accents -ge 2) {
    Shade-Box $bmp ($CARD_CX - 12) ($torsoY + 4) 3 16 $palette
    Shade-Box $bmp ($CARD_CX + 9)  ($torsoY + 4) 3 16 $palette
  }
  # Daggers
  if ($tier.accents -ge 1) {
    $bladeRamp = @{ deep=(Color-FromHex '#181a20'); shadow=(Color-FromHex '#48505a'); base=(Color-FromHex '#888c98'); high=(Color-FromHex '#c0c4cc'); top=(Color-FromHex '#f0f0f4') }
    Draw-Blade $bmp ($CARD_CX - 14) ($torsoY + 10) ($torsoY + 22) 2 $bladeRamp
    Draw-Blade $bmp ($CARD_CX + 12) ($torsoY + 10) ($torsoY + 22) 2 $bladeRamp
  }
  # Legs
  $legY = $torsoY + 24
  Shade-Box $bmp ($CARD_CX - 4) $legY 3 12 $palette
  Shade-Box $bmp ($CARD_CX + 2) $legY 3 12 $palette
}

# ── Archetype: humanoid-priest ───────────────────────────────────────

function Draw-Arch-HumanoidPriest {
  param($bmp, $palette, $card, $tier)
  $skin = Skin-Of $card.paletteHint
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $headY = 22
  $headR = 7
  # Halo for rare+
  if ($tier.accents -ge 2) {
    $halo = $palette.top
    for ($a = 0; $a -lt 60; $a++) {
      $ang = $a * (2 * [Math]::PI / 60)
      $rx = [int]([Math]::Round($CARD_CX + [Math]::Cos($ang) * 11))
      $ry = [int]([Math]::Round(($headY - $headR - 4) + [Math]::Sin($ang) * 3))
      Blend-Pixel $bmp $rx $ry (With-Alpha $halo 160)
    }
  }
  # Hood / coif
  Fill-Box $bmp ($CARD_CX - 8) ($headY - $headR - 2) 16 5 $palette.shadow
  Shade-Disc $bmp $CARD_CX $headY $headR $skin
  $eye = Eye-Color $card.paletteHint
  Set-Pixel $bmp ($CARD_CX - 2) $headY $eye
  Set-Pixel $bmp ($CARD_CX + 2) $headY $eye
  # Robe
  $torsoY = $headY + $headR + 1
  for ($yy = 0; $yy -lt 28; $yy++) {
    $w = 16 + [int]($yy * 0.4)
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($torsoY + $yy) $w 1 $palette.base
    if ($yy -gt 10 -and $yy -lt 20) { Set-Pixel $bmp $CARD_CX ($torsoY + $yy) $palette.top }
  }
  # Cross on chest (uncommon+)
  if ($tier.accents -ge 1) {
    Fill-Box $bmp ($CARD_CX - 1) ($torsoY + 6) 2 8 $palette.top
    Fill-Box $bmp ($CARD_CX - 3) ($torsoY + 9) 6 2 $palette.top
  }
}

# ── Archetype: beast-quad ────────────────────────────────────────────

function Draw-Arch-BeastQuad {
  param($bmp, $palette, $card, $tier)
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 16
  # Body (oval)
  Shade-Disc $bmp ($CARD_CX - 3) 52 9 $palette -RimLight:$tier.rim
  Fill-Box $bmp ($CARD_CX - 8) 50 16 8 $palette.base
  # Spots/stripes (rare+)
  if ($tier.accents -ge 2) {
    for ($k = 0; $k -lt 4; $k++) {
      $sx = $CARD_CX - 6 + $k * 4
      Fill-Box $bmp $sx 50 2 6 $palette.shadow
    }
  }
  # Head (front)
  Shade-Disc $bmp ($CARD_CX + 9) 44 6 $palette
  # Eye
  $eye = Eye-Color $card.paletteHint
  Set-Pixel $bmp ($CARD_CX + 11) 43 $eye
  # Ear
  Fill-Box $bmp ($CARD_CX + 11) 36 3 3 $palette.shadow
  Set-Pixel $bmp ($CARD_CX + 12) 36 $palette.high
  # Snout (uncommon+)
  if ($tier.accents -ge 1) {
    Fill-Box $bmp ($CARD_CX + 13) 45 3 3 $palette.deep
    Set-Pixel $bmp ($CARD_CX + 14) 46 $palette.top
  }
  # Legs (4)
  Fill-Box $bmp ($CARD_CX - 8) 58 3 8 $palette.shadow
  Fill-Box $bmp ($CARD_CX - 4) 58 3 8 $palette.shadow
  Fill-Box $bmp ($CARD_CX + 3) 58 3 8 $palette.shadow
  Fill-Box $bmp ($CARD_CX + 7) 58 3 8 $palette.shadow
  # Tail
  Fill-Box $bmp ($CARD_CX - 11) 50 3 2 $palette.shadow
  Fill-Box $bmp ($CARD_CX - 12) 48 2 3 $palette.shadow
  # Fangs (rare+ predator)
  if ($tier.accents -ge 2) {
    Set-Pixel $bmp ($CARD_CX + 14) 48 (Color-FromHex '#f0f0f4')
    Set-Pixel $bmp ($CARD_CX + 15) 48 (Color-FromHex '#f0f0f4')
  }
}

# ── Archetype: beast-bird ────────────────────────────────────────────

function Draw-Arch-BeastBird {
  param($bmp, $palette, $card, $tier)
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 11
  # Body
  Shade-Disc $bmp $CARD_CX 50 8 $palette -RimLight:$tier.rim
  # Wings (extend outward)
  for ($i = 0; $i -lt 10; $i++) {
    $y = 46 + [int]($i / 2)
    Fill-Box $bmp ($CARD_CX - 16 + $i) $y 4 2 $palette.shadow
    Fill-Box $bmp ($CARD_CX + 12 - $i) $y 4 2 $palette.shadow
  }
  # Head
  Shade-Disc $bmp $CARD_CX 38 5 $palette
  # Beak
  Fill-Box $bmp ($CARD_CX + 4) 39 4 2 $palette.deep
  Set-Pixel $bmp ($CARD_CX + 7) 39 $palette.top
  # Eye
  $eye = Eye-Color $card.paletteHint
  Set-Pixel $bmp ($CARD_CX + 1) 37 $eye
  # Tail (rare+)
  if ($tier.accents -ge 2) {
    Fill-Box $bmp ($CARD_CX - 1) 60 3 6 $palette.high
    Fill-Box $bmp ($CARD_CX - 3) 64 7 2 $palette.shadow
  }
  # Legs
  Fill-Box $bmp ($CARD_CX - 2) 58 1 6 $palette.deep
  Fill-Box $bmp ($CARD_CX + 1) 58 1 6 $palette.deep
}

# ── Archetype: undead-skeleton ───────────────────────────────────────

function Draw-Arch-UndeadSkeleton {
  param($bmp, $palette, $card, $tier)
  $bone = @{ deep=(Color-FromHex '#5a5448'); shadow=(Color-FromHex '#a89a78'); base=(Color-FromHex '#d8c8a0'); high=(Color-FromHex '#f0e4c0'); top=(Color-FromHex '#fff8dc') }
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  # Skull
  $headY = 22
  Shade-Disc $bmp $CARD_CX $headY 7 $bone
  # Eye sockets (dark holes)
  Fill-Box $bmp ($CARD_CX - 3) ($headY - 1) 2 3 (Color-FromHex '#000000')
  Fill-Box $bmp ($CARD_CX + 1) ($headY - 1) 2 3 (Color-FromHex '#000000')
  # Glowy eyes for rare+
  if ($tier.accents -ge 2) {
    Set-Pixel $bmp ($CARD_CX - 2) $headY $palette.top
    Set-Pixel $bmp ($CARD_CX + 2) $headY $palette.top
  }
  # Teeth row
  for ($i = 0; $i -lt 5; $i++) {
    Set-Pixel $bmp ($CARD_CX - 2 + $i) ($headY + 4) $bone.top
    Set-Pixel $bmp ($CARD_CX - 2 + $i) ($headY + 5) $bone.deep
  }
  # Ribcage torso — strips of bone
  $torsoY = $headY + 7
  for ($y = 0; $y -lt 16; $y += 3) {
    Fill-Box $bmp ($CARD_CX - 8) ($torsoY + $y) 16 2 $bone.shadow
    Set-Pixel $bmp ($CARD_CX) ($torsoY + $y) $bone.top
  }
  # Spine
  Fill-Box $bmp $CARD_CX $torsoY 1 16 $bone.base
  # Arms
  Fill-Box $bmp ($CARD_CX - 13) ($torsoY + 1) 2 14 $bone.shadow
  Fill-Box $bmp ($CARD_CX + 11) ($torsoY + 1) 2 14 $bone.shadow
  # Legs
  $legY = $torsoY + 18
  Fill-Box $bmp ($CARD_CX - 4) $legY 2 14 $bone.shadow
  Fill-Box $bmp ($CARD_CX + 2) $legY 2 14 $bone.shadow
  # Sash/cape in family palette (uncommon+) for read
  if ($tier.accents -ge 1) {
    Fill-Box $bmp ($CARD_CX - 10) ($torsoY - 1) 4 22 $palette.shadow
  }
  # Weapon (rare+): scythe handle right
  if ($tier.accents -ge 2) {
    $haftRamp = @{ deep=(Color-FromHex '#2a1a08'); shadow=(Color-FromHex '#6a4818'); base=(Color-FromHex '#a07840'); high=(Color-FromHex '#d0a868'); top=(Color-FromHex '#f0d8a0') }
    Shade-Box $bmp ($CARD_CX + 14) ($torsoY) 2 28 $haftRamp
    Fill-Box $bmp ($CARD_CX + 12) ($torsoY - 1) 6 2 (Color-FromHex '#c0c4cc')
  }
}

# ── Archetype: undead-zombie ─────────────────────────────────────────

function Draw-Arch-UndeadZombie {
  param($bmp, $palette, $card, $tier)
  $rot = @{ deep=(Color-FromHex '#1a2a18'); shadow=(Color-FromHex '#3a5a30'); base=(Color-FromHex '#5e8a48'); high=(Color-FromHex '#8eb070'); top=(Color-FromHex '#b4d098') }
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  # Head (lurching, slightly offset)
  Shade-Disc $bmp ($CARD_CX + 1) 22 7 $rot
  # Eyes (white pupils)
  Set-Pixel $bmp ($CARD_CX - 2) 21 (Color-FromHex '#f0f0f4')
  Set-Pixel $bmp ($CARD_CX + 3) 21 (Color-FromHex '#f0f0f4')
  Set-Pixel $bmp ($CARD_CX - 2) 22 (Color-FromHex '#000000')
  Set-Pixel $bmp ($CARD_CX + 3) 22 (Color-FromHex '#000000')
  # Torn shirt (palette)
  $torsoY = 31
  Shade-Box $bmp ($CARD_CX - 9) $torsoY 18 22 $palette
  # Random rot patches
  if ($tier.accents -ge 1) {
    Fill-Box $bmp ($CARD_CX - 5) ($torsoY + 5) 4 3 $rot.shadow
    Fill-Box $bmp ($CARD_CX + 3) ($torsoY + 11) 3 4 $rot.shadow
  }
  # Arms (outstretched, hanging)
  Shade-Box $bmp ($CARD_CX - 13) ($torsoY + 1) 3 18 $rot
  Shade-Box $bmp ($CARD_CX + 11) ($torsoY + 1) 3 18 $rot
  # Legs
  Shade-Box $bmp ($CARD_CX - 5) ($torsoY + 22) 4 14 $palette
  Shade-Box $bmp ($CARD_CX + 1) ($torsoY + 22) 4 14 $palette
}

# ── Archetype: elemental-* (fire/frost/storm) ────────────────────────

function Draw-Arch-Elemental {
  param($bmp, $palette, $card, $tier, [string]$kind)
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  # Core orb
  Shade-Disc $bmp $CARD_CX 44 8 $palette -RimLight:$tier.rim
  # Inner brighter core
  Shade-Disc $bmp $CARD_CX 44 4 @{ deep=$palette.shadow; shadow=$palette.base; base=$palette.high; high=$palette.top; top=$palette.top }
  # Body flames/spikes around the orb — direction depends on kind
  switch ($kind) {
    'fire' {
      # Flames pluming upward
      for ($i = 0; $i -lt 12; $i++) {
        $w = [Math]::Max(1, [int]([Math]::Round((12 - $i) * 0.7)))
        $halfL = [int]($w / 2)
        $y = 34 - $i
        for ($dx = -$halfL; $dx -le $halfL; $dx++) {
          $col = if ($i -gt 9) { $palette.top } elseif ($i -gt 5) { $palette.high } elseif ($i -gt 2) { $palette.base } else { $palette.shadow }
          Set-Pixel $bmp ($CARD_CX + $dx) $y $col
        }
      }
    }
    'frost' {
      # Ice crystal spikes radiating from orb
      for ($i = 0; $i -lt 6; $i++) {
        $ang = $i * ([Math]::PI / 3)
        $x1 = [int]([Math]::Round($CARD_CX + [Math]::Cos($ang) * 14))
        $y1 = [int]([Math]::Round(44 + [Math]::Sin($ang) * 14))
        Line-Pixel $bmp $CARD_CX 44 $x1 $y1 $palette.high
        Set-Pixel $bmp $x1 $y1 $palette.top
      }
    }
    'storm' {
      # Lightning bolt zigzag
      Draw-Bolt $bmp ($CARD_CX - 4) 30 ($CARD_CX + 6) 58 $palette.top $palette.high
      Draw-Bolt $bmp ($CARD_CX + 6) 30 ($CARD_CX - 4) 58 $palette.high $palette.base
    }
  }
  # Floating embers/sparkles (rare+)
  if ($tier.accents -ge 2) {
    for ($k = 0; $k -lt 5; $k++) {
      $px = $CARD_CX - 14 + ($k * 7)
      $py = 26 + ($k % 2) * 4
      Blend-Pixel $bmp $px $py (With-Alpha $palette.top 200)
    }
  }
  # Ground glow under orb
  Blend-Pixel $bmp $CARD_CX 60 (With-Alpha $palette.top 180)
}

# ── Archetype: construct-golem ───────────────────────────────────────

function Draw-Arch-ConstructGolem {
  param($bmp, $palette, $card, $tier)
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  # Boxy head
  Shade-Box $bmp ($CARD_CX - 6) 16 12 12 $palette -RimLight:$tier.rim
  # Visor (glowy)
  Fill-Box $bmp ($CARD_CX - 4) 22 9 2 (Color-FromHex '#040408')
  if ($tier.accents -ge 1) {
    Set-Pixel $bmp ($CARD_CX - 3) 23 $palette.top
    Set-Pixel $bmp ($CARD_CX + 3) 23 $palette.top
  }
  # Body block
  $torsoY = 30
  Shade-Box $bmp ($CARD_CX - 10) $torsoY 20 22 $palette -RimLight:$tier.rim
  # Rivets at corners
  if ($tier.accents -ge 1) {
    foreach ($pt in @(@(-9, 1), @(8, 1), @(-9, 19), @(8, 19))) {
      Set-Pixel $bmp ($CARD_CX + $pt[0]) ($torsoY + $pt[1]) $palette.top
    }
  }
  # Chest emblem (rare+)
  if ($tier.accents -ge 2) {
    Fill-Box $bmp ($CARD_CX - 2) ($torsoY + 8) 4 6 $palette.top
  }
  # Arms (block)
  Shade-Box $bmp ($CARD_CX - 14) ($torsoY + 1) 4 18 $palette
  Shade-Box $bmp ($CARD_CX + 10) ($torsoY + 1) 4 18 $palette
  # Legs
  Shade-Box $bmp ($CARD_CX - 6) ($torsoY + 22) 5 14 $palette
  Shade-Box $bmp ($CARD_CX + 1) ($torsoY + 22) 5 14 $palette
}

# ── Archetype: dragon-flier ──────────────────────────────────────────

function Draw-Arch-DragonFlier {
  param($bmp, $palette, $card, $tier)
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  # Body (curving)
  Shade-Disc $bmp $CARD_CX 48 10 $palette -RimLight:$tier.rim
  Fill-Box $bmp ($CARD_CX - 4) 42 9 14 $palette.base
  # Scales (rare+)
  if ($tier.accents -ge 2) {
    for ($y = 42; $y -lt 56; $y += 3) {
      for ($x = -4; $x -lt 5; $x += 3) {
        Set-Pixel $bmp ($CARD_CX + $x) $y $palette.high
      }
    }
  }
  # Head with snout
  Shade-Disc $bmp ($CARD_CX + 4) 36 5 $palette
  # Snout extension
  Fill-Box $bmp ($CARD_CX + 7) 37 4 3 $palette.shadow
  # Eye
  $eye = Eye-Color $card.paletteHint
  Set-Pixel $bmp ($CARD_CX + 5) 35 $eye
  # Wings (large, swept back)
  for ($i = 0; $i -lt 14; $i++) {
    $y = 36 + $i
    Fill-Box $bmp ($CARD_CX - 18 + [int]($i * 0.3)) $y (12 - [int]($i * 0.5)) 1 $palette.shadow
    Fill-Box $bmp ($CARD_CX + 6 + [int]($i * 0.5)) $y (12 - [int]($i * 0.5)) 1 $palette.shadow
  }
  # Wing membrane edges
  if ($tier.rim) {
    for ($i = 0; $i -lt 14; $i++) {
      Set-Pixel $bmp ($CARD_CX - 18 + [int]($i * 0.3)) (36 + $i) $palette.high
    }
  }
  # Tail
  Fill-Box $bmp ($CARD_CX - 11) 56 4 2 $palette.shadow
  Fill-Box $bmp ($CARD_CX - 14) 58 4 2 $palette.shadow
  # Legs
  Fill-Box $bmp ($CARD_CX - 5) 58 3 8 $palette.shadow
  Fill-Box $bmp ($CARD_CX + 3) 58 3 8 $palette.shadow
}

# ── Archetype: demon-fiend ───────────────────────────────────────────

function Draw-Arch-DemonFiend {
  param($bmp, $palette, $card, $tier)
  $skin = Skin-Of 'demon-magenta'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $headY = 22
  # Horned head
  Shade-Disc $bmp $CARD_CX $headY 7 $skin
  # Horns
  Fill-Box $bmp ($CARD_CX - 6) ($headY - 8) 2 4 $palette.deep
  Fill-Box $bmp ($CARD_CX + 4) ($headY - 8) 2 4 $palette.deep
  Set-Pixel $bmp ($CARD_CX - 6) ($headY - 9) $palette.top
  Set-Pixel $bmp ($CARD_CX + 5) ($headY - 9) $palette.top
  # Glowing eyes
  Set-Pixel $bmp ($CARD_CX - 2) $headY $palette.top
  Set-Pixel $bmp ($CARD_CX + 2) $headY $palette.top
  # Fanged mouth
  Set-Pixel $bmp ($CARD_CX - 1) ($headY + 3) (Color-FromHex '#f0f0f4')
  Set-Pixel $bmp ($CARD_CX + 1) ($headY + 3) (Color-FromHex '#f0f0f4')
  # Body
  $torsoY = $headY + 8
  Shade-Box $bmp ($CARD_CX - 9) $torsoY 18 22 $palette -RimLight:$tier.rim
  # Spikes on shoulders
  if ($tier.accents -ge 1) {
    for ($i = 0; $i -lt 3; $i++) {
      Set-Pixel $bmp ($CARD_CX - 9 - $i) ($torsoY + $i) $palette.shadow
      Set-Pixel $bmp ($CARD_CX + 8 + $i) ($torsoY + $i) $palette.shadow
    }
  }
  # Tail
  if ($tier.accents -ge 2) {
    Fill-Box $bmp ($CARD_CX + 12) ($torsoY + 14) 3 2 $palette.shadow
    Fill-Box $bmp ($CARD_CX + 15) ($torsoY + 12) 2 4 $palette.deep
  }
  # Legs
  $legY = $torsoY + 22
  Shade-Box $bmp ($CARD_CX - 5) $legY 4 14 $palette
  Shade-Box $bmp ($CARD_CX + 1) $legY 4 14 $palette
}

# ── Archetype: spell-* (multiple glyph variants) ─────────────────────

function Draw-Bolt {
  param($bmp, [int]$x0, [int]$y0, [int]$x1, [int]$y1, $color, $glow = $null)
  $kx = [int](($x0 + $x1) / 2)
  $ky = [int](($y0 + $y1) / 2)
  $mx1 = $kx + 2; $my1 = $ky - 3
  $mx2 = $kx - 2; $my2 = $ky + 2
  Line-Pixel $bmp $x0 $y0 $mx1 $my1 $color
  Line-Pixel $bmp $mx1 $my1 $mx2 $my2 $color
  Line-Pixel $bmp $mx2 $my2 $x1 $y1 $color
  if ($glow) {
    foreach ($p in @(@($x0,$y0,$mx1,$my1), @($mx1,$my1,$mx2,$my2), @($mx2,$my2,$x1,$y1))) {
      Line-Pixel $bmp $p[0] ($p[1] + 1) $p[2] ($p[3] + 1) (With-Alpha $glow 140)
      Line-Pixel $bmp ($p[0] + 1) $p[1] ($p[2] + 1) $p[3] (With-Alpha $glow 140)
    }
  }
}

function Draw-Blade {
  param($bmp, [int]$cx, [int]$topY, [int]$bottomY, [int]$halfW, $ramp)
  $w = $halfW * 2 + 1
  for ($y = $topY; $y -le $bottomY; $y++) {
    Fill-Box $bmp ($cx - $halfW) $y $w 1 $ramp.base
    Set-Pixel $bmp ($cx - $halfW) $y $ramp.high
    Set-Pixel $bmp ($cx + $halfW) $y $ramp.shadow
  }
  # Tip (point)
  Set-Pixel $bmp $cx ($topY - 1) $ramp.top
  # Base
  Fill-Box $bmp ($cx - $halfW) ($bottomY + 1) $w 1 $ramp.shadow
}

function Draw-MagicCircle {
  param($bmp, [int]$cx, [int]$cy, [int]$radius, $color, [int]$alpha = 90, [switch]$Runes)
  $segs = 60
  for ($i = 0; $i -lt $segs; $i++) {
    $ang = $i * (2 * [Math]::PI / $segs)
    $rx = [int]([Math]::Round($cx + [Math]::Cos($ang) * $radius))
    $ry = [int]([Math]::Round($cy + [Math]::Sin($ang) * $radius))
    Blend-Pixel $bmp $rx $ry (With-Alpha $color $alpha)
  }
  $r2 = [int]([Math]::Round($radius * 0.7))
  for ($i = 0; $i -lt 12; $i++) {
    $ang = $i * (2 * [Math]::PI / 12)
    $rx = [int]([Math]::Round($cx + [Math]::Cos($ang) * $r2))
    $ry = [int]([Math]::Round($cy + [Math]::Sin($ang) * $r2))
    Blend-Pixel $bmp $rx $ry (With-Alpha $color ([int]($alpha * 1.4)))
  }
}

function Draw-Arch-Spell {
  param($bmp, $palette, $card, $tier, [string]$glyph)
  # Backdrop magic circle
  Draw-MagicCircle $bmp $CARD_CX 44 22 $palette.shadow 90
  Draw-MagicCircle $bmp $CARD_CX 44 14 $palette.high 130
  # Centered glyph based on `glyph` ID
  switch ($glyph) {
    'bolt'    { Draw-Bolt $bmp ($CARD_CX - 6) 30 ($CARD_CX + 6) 58 $palette.top $palette.high }
    'circle'  { Shade-Disc $bmp $CARD_CX 44 8 $palette -RimLight:$tier.rim }
    'flame'   {
      for ($i = 0; $i -lt 14; $i++) {
        $w = [Math]::Max(1, [int]([Math]::Round((14 - $i) * 0.7)))
        $halfL = [int]($w / 2)
        $y = 56 - $i
        for ($dx = -$halfL; $dx -le $halfL; $dx++) {
          $col = if ($i -gt 10) { $palette.top } elseif ($i -gt 6) { $palette.high } elseif ($i -gt 3) { $palette.base } else { $palette.shadow }
          Set-Pixel $bmp ($CARD_CX + $dx) $y $col
        }
      }
    }
    'crystal' {
      # Diamond shape
      for ($i = 0; $i -lt 14; $i++) {
        $w = [Math]::Min($i, 14 - $i) * 2 + 1
        $x0 = $CARD_CX - [int]($w / 2)
        $y = 30 + $i
        Fill-Box $bmp $x0 $y $w 1 $palette.base
        Set-Pixel $bmp $x0 $y $palette.high
        Set-Pixel $bmp ($x0 + $w - 1) $y $palette.shadow
      }
    }
    'leaf'    {
      # Leaf shape — pointed ellipse
      for ($i = 0; $i -lt 22; $i++) {
        $w = [Math]::Max(1, [int](6 * [Math]::Sin([Math]::PI * $i / 22)))
        $x0 = $CARD_CX - $w
        Fill-Box $bmp $x0 (30 + $i) ($w * 2 + 1) 1 $palette.base
      }
      # Vein
      Fill-Box $bmp $CARD_CX 30 1 22 $palette.shadow
    }
    'skull'   {
      Shade-Disc $bmp $CARD_CX 40 8 @{ deep=(Color-FromHex '#5a5448'); shadow=(Color-FromHex '#a89a78'); base=(Color-FromHex '#d8c8a0'); high=(Color-FromHex '#f0e4c0'); top=(Color-FromHex '#fff8dc') }
      Fill-Box $bmp ($CARD_CX - 3) 39 2 3 (Color-FromHex '#000000')
      Fill-Box $bmp ($CARD_CX + 1) 39 2 3 (Color-FromHex '#000000')
      Fill-Box $bmp ($CARD_CX - 2) 50 5 2 $palette.deep
    }
    'eye'     {
      # Almond eye
      Shade-Disc $bmp $CARD_CX 44 8 @{ deep=(Color-FromHex '#040408'); shadow=(Color-FromHex '#0e0a18'); base=(Color-FromHex '#1a1428'); high=(Color-FromHex '#322848'); top=(Color-FromHex '#5a4a78') }
      Shade-Disc $bmp $CARD_CX 44 4 @{ deep=$palette.deep; shadow=$palette.shadow; base=$palette.base; high=$palette.high; top=$palette.top }
      Set-Pixel $bmp $CARD_CX 44 (Color-FromHex '#000000')
    }
    'sun'     {
      Shade-Disc $bmp $CARD_CX 44 7 @{ deep=$palette.shadow; shadow=$palette.base; base=$palette.high; high=$palette.top; top=$palette.top }
      for ($i = 0; $i -lt 8; $i++) {
        $ang = $i * ([Math]::PI / 4)
        $x = [int]([Math]::Round($CARD_CX + [Math]::Cos($ang) * 12))
        $y = [int]([Math]::Round(44 + [Math]::Sin($ang) * 12))
        Line-Pixel $bmp $CARD_CX 44 $x $y $palette.top
      }
    }
    'rune'    {
      # Rune square with inner glyph
      Fill-Box $bmp ($CARD_CX - 7) 36 14 14 $palette.shadow
      for ($x = $CARD_CX - 7; $x -le $CARD_CX + 6; $x++) {
        Set-Pixel $bmp $x 36 $palette.high
        Set-Pixel $bmp $x 49 $palette.deep
      }
      # Inner mark
      Fill-Box $bmp ($CARD_CX - 1) 39 2 8 $palette.top
      Fill-Box $bmp ($CARD_CX - 4) 42 8 2 $palette.top
    }
    'gear'    {
      Shade-Disc $bmp $CARD_CX 44 7 $palette
      for ($i = 0; $i -lt 8; $i++) {
        $ang = $i * ([Math]::PI / 4)
        $x = [int]([Math]::Round($CARD_CX + [Math]::Cos($ang) * 9))
        $y = [int]([Math]::Round(44 + [Math]::Sin($ang) * 9))
        Fill-Box $bmp ($x - 1) ($y - 1) 3 3 $palette.shadow
      }
      Shade-Disc $bmp $CARD_CX 44 2 @{ deep=$palette.deep; shadow=$palette.shadow; base=$palette.base; high=$palette.high; top=$palette.top }
    }
    'pact'    {
      # Pentagram-ish hexagon for pacts
      for ($i = 0; $i -lt 6; $i++) {
        $ang = $i * ([Math]::PI / 3)
        $x = [int]([Math]::Round($CARD_CX + [Math]::Cos($ang) * 12))
        $y = [int]([Math]::Round(44 + [Math]::Sin($ang) * 12))
        $angN = (($i + 2) % 6) * ([Math]::PI / 3)
        $xN = [int]([Math]::Round($CARD_CX + [Math]::Cos($angN) * 12))
        $yN = [int]([Math]::Round(44 + [Math]::Sin($angN) * 12))
        Line-Pixel $bmp $x $y $xN $yN $palette.high
      }
    }
    'star'    {
      # 5-point star
      for ($i = 0; $i -lt 5; $i++) {
        $ang = -[Math]::PI / 2 + $i * (2 * [Math]::PI / 5)
        $x = [int]([Math]::Round($CARD_CX + [Math]::Cos($ang) * 13))
        $y = [int]([Math]::Round(44 + [Math]::Sin($ang) * 13))
        $angN = -[Math]::PI / 2 + (($i + 2) % 5) * (2 * [Math]::PI / 5)
        $xN = [int]([Math]::Round($CARD_CX + [Math]::Cos($angN) * 13))
        $yN = [int]([Math]::Round(44 + [Math]::Sin($angN) * 13))
        Line-Pixel $bmp $x $y $xN $yN $palette.top
      }
    }
    'key'     {
      # Key shape — circle head + shaft + teeth
      Shade-Disc $bmp $CARD_CX 34 5 $palette
      Fill-Box $bmp ($CARD_CX - 1) 38 2 18 $palette.base
      Fill-Box $bmp $CARD_CX 48 4 2 $palette.high
      Fill-Box $bmp $CARD_CX 52 4 2 $palette.high
    }
    'bomb'    {
      # Round bomb with fuse
      Shade-Disc $bmp $CARD_CX 50 8 $palette
      Fill-Box $bmp $CARD_CX 40 1 5 $palette.shadow
      # Sparking fuse
      Set-Pixel $bmp $CARD_CX 39 (Color-FromHex '#ffe080')
      Set-Pixel $bmp ($CARD_CX + 1) 38 (Color-FromHex '#ffe080')
    }
    'dragon'  {
      # Stylised dragon head silhouette
      Shade-Disc $bmp $CARD_CX 44 8 $palette
      Fill-Box $bmp ($CARD_CX - 8) 38 3 4 $palette.deep
      Fill-Box $bmp ($CARD_CX + 5) 38 3 4 $palette.deep
      # Flame breath
      for ($i = 0; $i -lt 8; $i++) {
        $w = 6 - $i
        if ($w -lt 1) { break }
        Fill-Box $bmp ($CARD_CX - [int]($w / 2)) (52 + $i) $w 1 $palette.top
      }
    }
    default   { Shade-Disc $bmp $CARD_CX 44 8 $palette }
  }
}

# ── Archetype dispatcher ────────────────────────────────────────────

function Dispatch-Archetype {
  param($bmp, $card)
  $arch = [string]$card.visualArchetype
  $palette = Get-Palette ([string]$card.paletteHint)
  $tier = Detail-Tier ([string]$card.rarity)
  switch -Regex ($arch) {
    '^humanoid-warrior$' { Draw-Arch-HumanoidWarrior $bmp $palette $card $tier; return }
    '^humanoid-mage$'    { Draw-Arch-HumanoidMage    $bmp $palette $card $tier; return }
    '^humanoid-rogue$'   { Draw-Arch-HumanoidRogue   $bmp $palette $card $tier; return }
    '^humanoid-priest$'  { Draw-Arch-HumanoidPriest  $bmp $palette $card $tier; return }
    '^beast-quad$'       { Draw-Arch-BeastQuad       $bmp $palette $card $tier; return }
    '^beast-bird$'       { Draw-Arch-BeastBird       $bmp $palette $card $tier; return }
    '^undead-skeleton$'  { Draw-Arch-UndeadSkeleton  $bmp $palette $card $tier; return }
    '^undead-zombie$'    { Draw-Arch-UndeadZombie    $bmp $palette $card $tier; return }
    '^elemental-fire$'   { Draw-Arch-Elemental       $bmp $palette $card $tier 'fire';   return }
    '^elemental-frost$'  { Draw-Arch-Elemental       $bmp $palette $card $tier 'frost';  return }
    '^elemental-storm$'  { Draw-Arch-Elemental       $bmp $palette $card $tier 'storm';  return }
    '^construct-golem$'  { Draw-Arch-ConstructGolem  $bmp $palette $card $tier; return }
    '^dragon-flier$'     { Draw-Arch-DragonFlier     $bmp $palette $card $tier; return }
    '^demon-fiend$'      { Draw-Arch-DemonFiend      $bmp $palette $card $tier; return }
    '^spell-(.+)$' {
      $glyph = $Matches[1]
      Draw-Arch-Spell $bmp $palette $card $tier $glyph
      return
    }
    default {
      # Fallback — generic humanoid warrior so we never error.
      Draw-Arch-HumanoidWarrior $bmp $palette $card $tier
    }
  }
}

# ── Main loop ───────────────────────────────────────────────────────

$manifestPath = Join-Path $ScriptDir 'expansion-cards.json'
if (-not (Test-Path $manifestPath)) {
  throw "Manifest not found: $manifestPath`nRun: node tools/dump-expansion-manifest.mjs"
}
$cards = Get-Content $manifestPath -Raw | ConvertFrom-Json
Write-Host ("Loaded {0} cards from manifest." -f $cards.Count) -ForegroundColor Cyan

$rendered = 0
$skipped = 0
foreach ($card in $cards) {
  if ($Family    -ne '' -and $card.family -ne $Family) { continue }
  if ($Archetype -ne '' -and $card.visualArchetype -ne $Archetype) { continue }

  $outPath = Join-Path $cardDir ("{0}.png" -f $card.id)
  if ((Test-Path $outPath) -and (-not $Force)) {
    $skipped++
    continue
  }

  if ($card.rarity -eq 'legendary') {
    # 4-frame APNG halo for legendaries
    for ($f = 0; $f -lt 4; $f++) {
      $bmp = New-CanvasFx $CARD_W $CARD_H
      Dispatch-Archetype $bmp $card
      $r = @(3, 4, 5, 4)[$f]
      $a = @(120, 160, 200, 160)[$f]
      Add-GlowHalo $bmp (Color-FromHex '#fff0a0') $r $a
      $outFrame = Join-Path $framesDir ("{0}-fx-{1}.png" -f $card.id, $f)
      Save-CanvasFx $bmp $outFrame
    }
    # Static fallback
    $bmp = New-CanvasFx $CARD_W $CARD_H
    Dispatch-Archetype $bmp $card
    Add-GlowHalo $bmp (Color-FromHex '#fff0a0') 4 160
    Save-CanvasFx $bmp $outPath
  } else {
    $bmp = New-CanvasFx $CARD_W $CARD_H
    Dispatch-Archetype $bmp $card
    Apply-Card-Glow $bmp $card.rarity
    Save-CanvasFx $bmp $outPath
  }

  $rendered++
  if (($rendered % 25) -eq 0) {
    Write-Host ("  rendered {0} so far..." -f $rendered) -ForegroundColor DarkGray
  }
  if ($Limit -gt 0 -and $rendered -ge $Limit) { break }
}

Write-Host ("Done. Rendered: {0}, skipped (exists): {1}." -f $rendered, $skipped) -ForegroundColor Green
