# Procedural HD pixel-art sprite generator for the Boltbound card
# roster (discord-bot/cards-content.js).
#
# Per CARD-GAME-DESIGN.md §3 the sprite convention matches the Clash +
# Character systems — SUBJECT-ONLY pixel art on a transparent canvas.
# The card UI (frame, mana cost, name, atk/hp pips, text) is rendered
# by consumers (Discord embed renderer, web battler, pack opener) on
# top of this sprite, so we paint only the figure / scene.
#
# Output paths (committed to git):
#   aquilo-gg/sprites/cards/<cardId>.png        common/uncommon/rare/champion static
#   aquilo-gg/sprites/cards/<cardId>.png        legendary tier: 4-frame APNG
#
# Legendary tier writes per-frame PNGs into
# aquilo-gg/sprites/_card-legendary-frames/<slug>-fx-<N>.png; the
# companion tools/build-card-apng.mjs script stitches them into APNGs
# at cards/<cardId>.png (overwriting the placeholder static).
#
# Canvas: 64×80. Ground row 78. Figure footprint centered on column 32.
#
# Regenerate from scratch:
#   pwsh -ExecutionPolicy Bypass -File tools/build-card-sprites.ps1
#   node tools/build-card-apng.mjs
#
# Pass-by-pass: switch with -Only champions|legendaries|rares|uncommons|commons|tokens

[CmdletBinding()]
param(
  [string]$OutRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'aquilo-gg/sprites'),
  [string]$Only    = ''     # comma list: champions,legendaries,rares,uncommons,commons,tokens
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib-pixel.ps1')

$cardDir   = Join-Path $OutRoot 'cards'
$framesDir = Join-Path $OutRoot '_card-legendary-frames'
foreach ($d in @($cardDir, $framesDir)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

$CARD_W = 64
$CARD_H = 80
$GROUND_Y = 78      # row just above the bottom — feet rest here
$CARD_CX  = 32      # horizontal centre column

function Want { param([string]$key) return ($Only -eq '') -or ($Only.Split(',') -contains $key) }

# ── Skin tones shared across all character cards ──────────────────
$SKIN_FAIR = @{
  deep   = (Color-FromHex '#7a4830');
  shadow = (Color-FromHex '#b07a55');
  base   = (Color-FromHex '#e8c098');
  high   = (Color-FromHex '#f8dab2');
  top    = (Color-FromHex '#ffeed0');
}
$SKIN_TAN = @{
  deep   = (Color-FromHex '#5a3418');
  shadow = (Color-FromHex '#8a5a2c');
  base   = (Color-FromHex '#c08858');
  high   = (Color-FromHex '#e0a878');
  top    = (Color-FromHex '#f4c898');
}
$SKIN_PALE = @{
  deep   = (Color-FromHex '#946c50');
  shadow = (Color-FromHex '#c89c80');
  base   = (Color-FromHex '#f0d4ba');
  high   = (Color-FromHex '#ffe6d0');
  top    = (Color-FromHex '#fff4e2');
}
$SKIN_GREEN = @{   # goblins, imps
  deep   = (Color-FromHex '#1a3a18');
  shadow = (Color-FromHex '#3a6a30');
  base   = (Color-FromHex '#5e9a4c');
  high   = (Color-FromHex '#8ec078');
  top    = (Color-FromHex '#b4dca0');
}
$SKIN_GREY = @{    # zombies, skeletons base
  deep   = (Color-FromHex '#2a2e3a');
  shadow = (Color-FromHex '#4a4e5a');
  base   = (Color-FromHex '#787e8c');
  high   = (Color-FromHex '#a0a6b4');
  top    = (Color-FromHex '#c8ccd6');
}
$SKIN_BONE = @{    # skeletons, lich
  deep   = (Color-FromHex '#605a48');
  shadow = (Color-FromHex '#a89a78');
  base   = (Color-FromHex '#d8c8a0');
  high   = (Color-FromHex '#f0e4c0');
  top    = (Color-FromHex '#fff8dc');
}
$SKIN_PURPLE = @{  # nyx / shadow
  deep   = (Color-FromHex '#2a1a4a');
  shadow = (Color-FromHex '#4a2e7a');
  base   = (Color-FromHex '#7a5cb0');
  high   = (Color-FromHex '#a888d4');
  top    = (Color-FromHex '#d0b8ec');
}

# ── Helper: head with eyes + simple mouth ─────────────────────────
function Draw-Head {
  param(
    $bmp, [int]$cx, [int]$cy, [int]$r, $skin,
    $eyeColor = $null, [switch]$NoMouth
  )
  Shade-Disc $bmp $cx $cy $r $skin
  if (-not $eyeColor) { $eyeColor = (Color-FromHex '#1a1422') }
  $eyeY = $cy
  Set-Pixel $bmp ($cx - 2) $eyeY $eyeColor
  Set-Pixel $bmp ($cx + 2) $eyeY $eyeColor
  if (-not $NoMouth) {
    Set-Pixel $bmp ($cx - 1) ($cy + 2) $skin.shadow
    Set-Pixel $bmp $cx       ($cy + 2) $skin.shadow
  }
}

# ── Helper: torso block (armored or robed) ────────────────────────
function Draw-Torso {
  param(
    $bmp, [int]$cx, [int]$topY, [int]$w, [int]$h, $ramp,
    [switch]$RimLight, $accent = $null
  )
  $x = $cx - [int]($w / 2)
  Shade-Box $bmp $x $topY $w $h $ramp -RimLight:$RimLight
  if ($accent) {
    # Central accent stripe
    $sx = $cx
    for ($yy = $topY + 1; $yy -lt ($topY + $h - 1); $yy++) {
      Set-Pixel $bmp $sx $yy $accent
    }
  }
}

# ── Helper: legs ──────────────────────────────────────────────────
function Draw-Legs {
  param(
    $bmp, [int]$cx, [int]$topY, [int]$h, $ramp,
    [int]$legW = 4, [int]$gap = 2
  )
  $lx = $cx - $legW - [int]($gap / 2)
  $rx = $cx + [int]($gap / 2) + 1
  Shade-Box $bmp $lx $topY $legW $h $ramp
  Shade-Box $bmp $rx $topY $legW $h $ramp
}

# ── Helper: arms ──────────────────────────────────────────────────
function Draw-Arms {
  param(
    $bmp, [int]$cx, [int]$topY, [int]$h, $ramp,
    [int]$armW = 3, [int]$reach = 12
  )
  $lx = $cx - [int]($reach / 2) - $armW + 1
  $rx = $cx + [int]($reach / 2)
  Shade-Box $bmp $lx $topY $armW $h $ramp
  Shade-Box $bmp $rx $topY $armW $h $ramp
}

# ── Helper: humanoid base (head + neck + torso + arms + legs) ────
# Used as a starting template for most character cards. Customise
# afterwards (hat, weapon, gear) over the top.
function Draw-Humanoid {
  param(
    $bmp, $skin, $bodyRamp,
    [int]$cx = $CARD_CX,
    [int]$headY = 22,     # head centre y
    [int]$headR = 7,
    [int]$torsoW = 18,
    [int]$torsoH = 22,
    [int]$legH  = 16,
    [int]$reach = 22,     # arm-spread (centre-to-centre)
    $accent = $null
  )
  # Head
  Draw-Head $bmp $cx $headY $headR $skin
  # Neck
  Fill-Box $bmp ($cx - 2) ($headY + $headR) 5 2 $skin.shadow
  # Torso
  $torsoY = $headY + $headR + 2
  Draw-Torso $bmp $cx $torsoY $torsoW $torsoH $bodyRamp -RimLight -accent $accent
  # Arms (hanging beside torso)
  $armY = $torsoY + 1
  Draw-Arms $bmp $cx $armY ($torsoH - 4) $bodyRamp -reach ($torsoW + 6)
  # Hands
  $handY = $armY + $torsoH - 4
  $handLx = $cx - [int](($torsoW + 6) / 2) - 1
  $handRx = $cx + [int](($torsoW + 6) / 2) - 1
  Fill-Box $bmp $handLx $handY 3 3 $skin.base
  Set-Pixel $bmp $handLx $handY $skin.high
  Fill-Box $bmp $handRx $handY 3 3 $skin.base
  Set-Pixel $bmp ($handRx + 2) $handY $skin.shadow
  # Legs
  $legY = $torsoY + $torsoH
  Draw-Legs $bmp $cx $legY $legH $bodyRamp
  # Feet (boots — slightly wider, dark)
  $bootRamp = $MAT_LEATHER
  $footY = $legY + $legH
  $lx = $cx - 5
  $rx = $cx + 1
  Fill-Box $bmp $lx $footY 5 2 $bootRamp.shadow
  Fill-Box $bmp $rx $footY 5 2 $bootRamp.shadow
  Set-Pixel $bmp $lx $footY $bootRamp.high
  Set-Pixel $bmp $rx $footY $bootRamp.high
  # Return key Y rows for hat/weapon placement
  return @{
    headTop = $headY - $headR;
    headY   = $headY;
    headBot = $headY + $headR;
    torsoY  = $torsoY;
    torsoH  = $torsoH;
    handLx  = $handLx;
    handRx  = $handRx;
    handY   = $handY;
    legY    = $legY;
  }
}

# ── Helper: ground shadow under the figure ────────────────────────
function Draw-GroundShadow-Card {
  param($bmp, [int]$cx, [int]$y, [int]$halfW)
  $shadow = (Color-FromHex '#040408')
  for ($dx = -$halfW; $dx -le $halfW; $dx++) {
    $a = 130 - [Math]::Abs($dx) * (110 / [Math]::Max(1, $halfW))
    if ($a -lt 20) { continue }
    Blend-Pixel $bmp ($cx + $dx) $y (With-Alpha $shadow ([int]$a))
  }
}

# ── Helper: apply rarity glow halo using lib-pixel Add-GlowHalo ──
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

# ── Helper: spell-card glyph background ───────────────────────────
# Spells don't have a figure — they're a symbolic glyph centered on
# the canvas with a magic-circle backdrop.
function Draw-MagicCircle {
  param(
    $bmp, [int]$cx, [int]$cy, [int]$radius,
    $color, [int]$alpha = 90, [switch]$Runes
  )
  # Outer ring
  $segs = 60
  for ($i = 0; $i -lt $segs; $i++) {
    $ang = $i * (2 * [Math]::PI / $segs)
    $rx = [int]([Math]::Round($cx + [Math]::Cos($ang) * $radius))
    $ry = [int]([Math]::Round($cy + [Math]::Sin($ang) * $radius))
    Blend-Pixel $bmp $rx $ry (With-Alpha $color $alpha)
  }
  # Inner dotted ring
  $r2 = [int]([Math]::Round($radius * 0.7))
  for ($i = 0; $i -lt 12; $i++) {
    $ang = $i * (2 * [Math]::PI / 12)
    $rx = [int]([Math]::Round($cx + [Math]::Cos($ang) * $r2))
    $ry = [int]([Math]::Round($cy + [Math]::Sin($ang) * $r2))
    Blend-Pixel $bmp $rx $ry (With-Alpha $color ([int]($alpha * 1.4)))
  }
  if ($Runes) {
    # 4 rune marks at cardinal points
    foreach ($pt in @(@(0, -$radius), @(0, $radius), @(-$radius, 0), @($radius, 0))) {
      $rx = $cx + $pt[0]
      $ry = $cy + $pt[1]
      Set-Pixel $bmp $rx $ry $color
      Set-Pixel $bmp ($rx - 1) $ry (With-Alpha $color 180)
      Set-Pixel $bmp ($rx + 1) $ry (With-Alpha $color 180)
      Set-Pixel $bmp $rx ($ry - 1) (With-Alpha $color 180)
      Set-Pixel $bmp $rx ($ry + 1) (With-Alpha $color 180)
    }
  }
}

# ── Helper: lightning bolt path ───────────────────────────────────
function Draw-Bolt {
  param(
    $bmp, [int]$x0, [int]$y0, [int]$x1, [int]$y1,
    $color, $glow = $null
  )
  # Zigzag through 4 segments
  $kx = [int](($x0 + $x1) / 2)
  $ky = [int](($y0 + $y1) / 2)
  $mx1 = $kx + 2
  $my1 = $ky - 3
  $mx2 = $kx - 2
  $my2 = $ky + 2
  Line-Pixel $bmp $x0 $y0 $mx1 $my1 $color
  Line-Pixel $bmp $mx1 $my1 $mx2 $my2 $color
  Line-Pixel $bmp $mx2 $my2 $x1 $y1 $color
  if ($glow) {
    # Glow outline (thicker version, semi-transparent)
    foreach ($p in @(@($x0,$y0,$mx1,$my1), @($mx1,$my1,$mx2,$my2), @($mx2,$my2,$x1,$y1))) {
      $gx0 = $p[0]; $gy0 = $p[1]; $gx1 = $p[2]; $gy1 = $p[3]
      Line-Pixel $bmp $gx0 ($gy0 + 1) $gx1 ($gy1 + 1) (With-Alpha $glow 140)
      Line-Pixel $bmp ($gx0 + 1) $gy0 ($gx1 + 1) $gy1 (With-Alpha $glow 140)
    }
  }
}

# ── Helper: + cross icon for heal spells ─────────────────────────
function Draw-HealCross {
  param($bmp, [int]$cx, [int]$cy, [int]$size, $ramp)
  $half = [int]($size / 2)
  $arm  = [int]($size / 4)
  if ($arm -lt 1) { $arm = 1 }
  Shade-Box $bmp ($cx - $arm) ($cy - $half) ($arm * 2 + 1) $size $ramp
  Shade-Box $bmp ($cx - $half) ($cy - $arm) $size ($arm * 2 + 1) $ramp
}

# ── Helper: flame plume ──────────────────────────────────────────
function Draw-Flame {
  param($bmp, [int]$cx, [int]$baseY, [int]$h, $ramp)
  for ($i = 0; $i -lt $h; $i++) {
    $w = [Math]::Max(1, [int]([Math]::Round(($h - $i) * 0.6)))
    $halfL = [int]($w / 2)
    $y = $baseY - $i
    for ($dx = -$halfL; $dx -le $halfL; $dx++) {
      $col = if ($i -gt $h * 0.7)        { $ramp.top }
             elseif ($i -gt $h * 0.45)   { $ramp.high }
             elseif ($i -gt $h * 0.2)    { $ramp.base }
             else                        { $ramp.shadow }
      Set-Pixel $bmp ($cx + $dx) $y $col
    }
  }
}

$FIRE = @{
  deep   = (Color-FromHex '#3a0a00');
  shadow = (Color-FromHex '#a02c08');
  base   = (Color-FromHex '#f06028');
  high   = (Color-FromHex '#ffaa3c');
  top    = (Color-FromHex '#fff0a0');
}
$ARCANE = @{
  deep   = (Color-FromHex '#10084a');
  shadow = (Color-FromHex '#3a1ca8');
  base   = (Color-FromHex '#7c5cff');
  high   = (Color-FromHex '#a890ff');
  top    = (Color-FromHex '#e0d0ff');
}
$HOLY = @{
  deep   = (Color-FromHex '#6a4a08');
  shadow = (Color-FromHex '#c08428');
  base   = (Color-FromHex '#f0c050');
  high   = (Color-FromHex '#ffe89c');
  top    = (Color-FromHex '#fff8d8');
}
$NATURE = @{
  deep   = (Color-FromHex '#0a3a18');
  shadow = (Color-FromHex '#206a30');
  base   = (Color-FromHex '#3aa848');
  high   = (Color-FromHex '#6ed078');
  top    = (Color-FromHex '#b4f0bc');
}
$SHADOW = @{
  deep   = (Color-FromHex '#040308');
  shadow = (Color-FromHex '#0e0a18');
  base   = (Color-FromHex '#1a1428');
  high   = (Color-FromHex '#322848');
  top    = (Color-FromHex '#5a4a78');
}

# =====================================================================
# ── CARD DRAW FUNCTIONS ─────────────────────────────────────────────
# =====================================================================
#
# Each function takes ($bmp) and paints a 64×80 subject. Rarity glow is
# applied centrally by the dispatcher after the draw based on the card's
# rarity (so individual draws stay focused on the figure).

# ── Champions (5) ────────────────────────────────────────────────

function Draw-Card-ChampWarrior {
  param($bmp)
  Rng-Init 'champ.warrior'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $a = Draw-Humanoid $bmp $SKIN_FAIR $MAT_STEEL -accent $MAT_GOLD.base
  # Plumed helm (steel + red plume)
  Fill-Box $bmp ($CARD_CX - 7) ($a.headTop - 3) 14 5 $MAT_STEEL.shadow
  for ($x = $CARD_CX - 7; $x -le $CARD_CX + 6; $x++) {
    Set-Pixel $bmp $x ($a.headTop - 3) $MAT_STEEL.high
  }
  # Visor slit
  Fill-Box $bmp ($CARD_CX - 4) ($a.headY - 1) 9 2 (Color-FromHex '#040408')
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY $BRAND.Crimson
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY $BRAND.Crimson
  # Plume on top
  $plume = $BRAND.Crimson
  for ($y = ($a.headTop - 9); $y -le ($a.headTop - 4); $y++) {
    Set-Pixel $bmp $CARD_CX $y $plume
    Set-Pixel $bmp ($CARD_CX - 1) $y (With-Alpha $plume 200)
  }
  Set-Pixel $bmp $CARD_CX ($a.headTop - 9) $MAT_GOLD.top
  # Sword (right hand) — long blade up-right
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 22) ($a.handY + 1) 4 $MAT_STEEL -Fuller -accent $MAT_GOLD.base
  # Crossguard
  Fill-Box $bmp ($a.handRx - 2) ($a.handY) 9 2 $MAT_GOLD.base
  Set-Pixel $bmp ($a.handRx - 2) $a.handY $MAT_GOLD.high
  Set-Pixel $bmp ($a.handRx + 6) ($a.handY + 1) $MAT_GOLD.shadow
  Draw-Grip $bmp ($a.handRx + 2) ($a.handY + 2) ($a.handY + 4) 2 $MAT_LEATHER
  # Round shield (left hand)
  Shade-Disc $bmp ($a.handLx - 1) ($a.handY) 6 $MAT_STEEL -RimLight
  # Shield boss + cross
  Set-Pixel $bmp ($a.handLx - 1) $a.handY $MAT_GOLD.top
  Fill-Box $bmp ($a.handLx - 1) ($a.handY - 3) 1 7 $MAT_GOLD.base
  Fill-Box $bmp ($a.handLx - 4) $a.handY 7 1 $MAT_GOLD.base
}

function Draw-Card-ChampMage {
  param($bmp)
  Rng-Init 'champ.mage'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  # Body is robe — arcane purple
  $robe = @{
    deep   = (Color-FromHex '#1a0c40');
    shadow = (Color-FromHex '#3a1f7a');
    base   = (Color-FromHex '#5a3eb8');
    high   = (Color-FromHex '#8a72e0');
    top    = (Color-FromHex '#c0a8f8');
  }
  $a = Draw-Humanoid $bmp $SKIN_PALE $robe -accent $MAT_GOLD.base
  # Pointed wizard hat
  for ($i = 0; $i -lt 12; $i++) {
    $w = 12 - $i
    if ($w -lt 1) { $w = 1 }
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 2 - $i) $w 1 $robe.base
    Set-Pixel $bmp $x0 ($a.headTop - 2 - $i) $robe.shadow
    Set-Pixel $bmp ($x0 + $w - 1) ($a.headTop - 2 - $i) $robe.high
  }
  Set-Pixel $bmp $CARD_CX ($a.headTop - 13) $MAT_GOLD.top
  # Hat brim
  Fill-Box $bmp ($CARD_CX - 8) ($a.headTop - 2) 17 1 $robe.deep
  Set-Pixel $bmp ($CARD_CX - 8) ($a.headTop - 2) $robe.shadow
  Set-Pixel $bmp ($CARD_CX + 8) ($a.headTop - 2) $robe.shadow
  # Glowing eyes (arcane blue)
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#8acfff')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#8acfff')
  # Beard
  Fill-Box $bmp ($CARD_CX - 3) ($a.headBot - 2) 7 3 (Color-FromHex '#b0b0c8')
  Set-Pixel $bmp ($CARD_CX - 3) ($a.headBot - 2) (Color-FromHex '#d8d8e8')
  # Staff in right hand
  Draw-Shaft $bmp ($a.handRx + 2) ($a.headTop - 6) ($a.handY + 6) 2 $MAT_WOOD_DARK
  # Arcane orb at top
  Shade-Disc $bmp ($a.handRx + 2) ($a.headTop - 8) 4 $ARCANE -RimLight
  # Sparks
  Set-Pixel $bmp ($a.handRx + 5) ($a.headTop - 12) $ARCANE.top
  Set-Pixel $bmp ($a.handRx - 1) ($a.headTop - 10) $ARCANE.high
  # Belt/sash gold
  Fill-Box $bmp ($CARD_CX - 9) ($a.torsoY + 14) 19 2 $MAT_GOLD.base
  Set-Pixel $bmp $CARD_CX ($a.torsoY + 14) $MAT_GOLD.top
}

function Draw-Card-ChampRogue {
  param($bmp)
  Rng-Init 'champ.rogue'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $a = Draw-Humanoid $bmp $SKIN_TAN $MAT_LEATHER_BLACK -accent $BRAND.Crimson
  # Hood — large overhang
  for ($i = 0; $i -lt 6; $i++) {
    $w = 16 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 2 + $i) $w 1 $MAT_LEATHER_BLACK.deep
    Set-Pixel $bmp $x0 ($a.headTop - 2 + $i) $MAT_LEATHER_BLACK.shadow
    Set-Pixel $bmp ($x0 + $w - 1) ($a.headTop - 2 + $i) $MAT_LEATHER_BLACK.base
  }
  # Face mostly in shadow — only glowing eye glints
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY - 1) 11 4 (Color-FromHex '#08050c')
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY $BRAND.Crimson
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY $BRAND.Crimson
  # Twin daggers — one in each hand pointing down-out
  Draw-Blade $bmp ($a.handLx - 1) ($a.handY + 1) ($a.handY + 10) 2 $MAT_STEEL
  Set-Pixel $bmp ($a.handLx - 1) ($a.handY + 10) $MAT_STEEL.top
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY + 1) ($a.handY + 10) 2 $MAT_STEEL
  # Crossbelts (X across chest)
  Line-Pixel $bmp ($CARD_CX - 7) ($a.torsoY + 2) ($CARD_CX + 7) ($a.torsoY + 12) $MAT_LEATHER.base
  Line-Pixel $bmp ($CARD_CX + 7) ($a.torsoY + 2) ($CARD_CX - 7) ($a.torsoY + 12) $MAT_LEATHER.base
  # Throwing knives on belt
  Set-Pixel $bmp ($CARD_CX - 5) ($a.torsoY + 14) $MAT_STEEL.high
  Set-Pixel $bmp ($CARD_CX - 2) ($a.torsoY + 14) $MAT_STEEL.high
  Set-Pixel $bmp ($CARD_CX + 1) ($a.torsoY + 14) $MAT_STEEL.high
  Set-Pixel $bmp ($CARD_CX + 4) ($a.torsoY + 14) $MAT_STEEL.high
}

function Draw-Card-ChampRanger {
  param($bmp)
  Rng-Init 'champ.ranger'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  # Body — forest leather + green cloth
  $cloak = @{
    deep   = (Color-FromHex '#0c2a18');
    shadow = (Color-FromHex '#1c4a28');
    base   = (Color-FromHex '#347040');
    high   = (Color-FromHex '#5e9460');
    top    = (Color-FromHex '#9cc888');
  }
  $a = Draw-Humanoid $bmp $SKIN_FAIR $MAT_LEATHER -accent $cloak.base
  # Hood up — green hood
  for ($i = 0; $i -lt 5; $i++) {
    $w = 14 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 2 + $i) $w 1 $cloak.shadow
    Set-Pixel $bmp ($x0 + $w - 1) ($a.headTop - 2 + $i) $cloak.high
  }
  # Show face below the hood lip
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#2e4f1c')   # forest eyes
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#2e4f1c')
  # Cloak flowing from shoulders
  Fill-Box $bmp ($CARD_CX - 11) ($a.torsoY) 4 ($a.torsoH + 4) $cloak.shadow
  Fill-Box $bmp ($CARD_CX + 8) ($a.torsoY) 4 ($a.torsoH + 4) $cloak.shadow
  Set-Pixel $bmp ($CARD_CX - 11) ($a.torsoY) $cloak.high
  Set-Pixel $bmp ($CARD_CX + 11) ($a.torsoY + $a.torsoH + 3) $cloak.deep
  # Bow — drawn vertically in left hand
  $bowX = $a.handLx - 2
  for ($y = ($a.handY - 18); $y -le ($a.handY + 10); $y++) {
    $bx = $bowX + [int]([Math]::Round(2 * [Math]::Sin(($y - ($a.handY - 4)) * 0.18)))
    Set-Pixel $bmp $bx $y $MAT_WOOD_DARK.base
    Set-Pixel $bmp ($bx - 1) $y $MAT_WOOD_DARK.shadow
  }
  # Bowstring straight
  for ($y = ($a.handY - 18); $y -le ($a.handY + 10); $y++) {
    Set-Pixel $bmp ($bowX + 1) $y (Color-FromHex '#d8d0b8')
  }
  # Arrow nocked — angled across
  Line-Pixel $bmp ($bowX + 2) ($a.handY - 4) ($a.handRx + 3) ($a.handY - 6) $MAT_WOOD_LIGHT.base
  # Arrowhead
  Set-Pixel $bmp ($a.handRx + 4) ($a.handY - 6) $MAT_STEEL.top
  Set-Pixel $bmp ($a.handRx + 4) ($a.handY - 7) $MAT_STEEL.high
  # Fletching
  Set-Pixel $bmp ($bowX + 2) ($a.handY - 3) $BRAND.Crimson
  Set-Pixel $bmp ($bowX + 1) ($a.handY - 3) $BRAND.Crimson
}

function Draw-Card-ChampHealer {
  param($bmp)
  Rng-Init 'champ.healer'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  # White / cream robe
  $robe = @{
    deep   = (Color-FromHex '#7a6a4a');
    shadow = (Color-FromHex '#b8a878');
    base   = (Color-FromHex '#e6d8b0');
    high   = (Color-FromHex '#fff0c8');
    top    = (Color-FromHex '#fff8e0');
  }
  $a = Draw-Humanoid $bmp $SKIN_PALE $robe -accent $MAT_GOLD.base
  # Hood lowered — short
  for ($i = 0; $i -lt 3; $i++) {
    $w = 14 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 1 + $i) $w 1 $robe.shadow
  }
  # Golden halo above head
  $halo = With-Alpha (Color-FromHex '#fff0a0') 220
  for ($ang = 0; $ang -lt 360; $ang += 12) {
    $rad = $ang * [Math]::PI / 180
    $hx = $CARD_CX + [int]([Math]::Round([Math]::Cos($rad) * 9))
    $hy = ($a.headTop - 5) + [int]([Math]::Round([Math]::Sin($rad) * 4))
    if ($hy -lt $a.headTop - 1) { Blend-Pixel $bmp $hx $hy $halo }
  }
  # Holy cross on chest
  Draw-HealCross $bmp $CARD_CX ($a.torsoY + 10) 7 $MAT_GOLD
  # Mace in right hand
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 10) ($a.handY + 5) 2 $MAT_WOOD_LIGHT
  Shade-Disc $bmp ($a.handRx + 2) ($a.handY - 12) 4 $MAT_GOLD -RimLight
  # Left hand raised slightly — healing light
  Shade-Disc $bmp ($a.handLx) ($a.handY - 2) 3 (Build-Ramp '#7cff90') -RimLight
  Set-Pixel $bmp ($a.handLx) ($a.handY - 4) (Color-FromHex '#fff8d8')
}

# Pass dispatcher dict — { cardId -> Draw function name }
$CARD_DRAW = @{
  'champ.warrior' = 'Draw-Card-ChampWarrior'
  'champ.mage'    = 'Draw-Card-ChampMage'
  'champ.rogue'   = 'Draw-Card-ChampRogue'
  'champ.ranger'  = 'Draw-Card-ChampRanger'
  'champ.healer'  = 'Draw-Card-ChampHealer'
}

# Card metadata — drives rarity glow + pass filtering. Mirrors
# cards-content.js but tracked locally so we don't need to parse JS.
# Updated as each pass adds cards.
$CARD_META = @{
  'champ.warrior' = @{ rarity = 'champion'; pass = 'champions' }
  'champ.mage'    = @{ rarity = 'champion'; pass = 'champions' }
  'champ.rogue'   = @{ rarity = 'champion'; pass = 'champions' }
  'champ.ranger'  = @{ rarity = 'champion'; pass = 'champions' }
  'champ.healer'  = @{ rarity = 'champion'; pass = 'champions' }
}

# Render one card -> aquilo-gg/sprites/cards/<id>.png. Legendary
# subjects are also rendered to per-frame PNGs in $framesDir so the
# companion APNG script can stitch them. We write 4 frames where the
# halo radius pulses; the figure itself is identical across frames.
function Render-Card {
  param([string]$cardId)
  $meta = $CARD_META[$cardId]
  if (-not $meta) { throw "Render-Card: no metadata for $cardId" }
  $fn = $CARD_DRAW[$cardId]
  if (-not $fn) { throw "Render-Card: no draw function for $cardId" }

  if ($meta.rarity -eq 'legendary') {
    # Emit 4 halo-pulse frames; static PNG keeps frame 0 as a fallback
    # for consumers that don't grok APNG.
    for ($f = 0; $f -lt 4; $f++) {
      $bmp = New-CanvasFx $CARD_W $CARD_H
      & $fn $bmp
      # Pulse halo radius 3..5..3 across the 4 frames
      $r = @(3, 4, 5, 4)[$f]
      $a = @(120, 160, 200, 160)[$f]
      Add-GlowHalo $bmp (Color-FromHex '#fff0a0') $r $a
      $outFrame = Join-Path $framesDir ("{0}-fx-{1}.png" -f $cardId, $f)
      Save-CanvasFx $bmp $outFrame
    }
    # Also write a static placeholder so the .png URL works even before
    # APNG stitch runs. build-card-apng.mjs overwrites this.
    $bmp = New-CanvasFx $CARD_W $CARD_H
    & $fn $bmp
    Add-GlowHalo $bmp (Color-FromHex '#fff0a0') 4 160
    Save-CanvasFx $bmp (Join-Path $cardDir ("{0}.png" -f $cardId))
    return
  }

  $bmp = New-CanvasFx $CARD_W $CARD_H
  & $fn $bmp
  Apply-Card-Glow $bmp $meta.rarity
  Save-CanvasFx $bmp (Join-Path $cardDir ("{0}.png" -f $cardId))
}

# Build pass — render every registered card whose pass matches $Only.
function Build-Cards {
  $count = 0
  foreach ($cardId in $CARD_META.Keys) {
    $meta = $CARD_META[$cardId]
    if (-not (Want $meta.pass)) { continue }
    Render-Card $cardId
    $count++
  }
  Write-Host ("  cards rendered: {0}" -f $count) -ForegroundColor Green
}

Write-Host '── Boltbound card sprites ──' -ForegroundColor Cyan
Build-Cards
Write-Host 'Done.' -ForegroundColor Green
