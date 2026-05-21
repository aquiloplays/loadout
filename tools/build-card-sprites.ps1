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

# ── Legendaries — heroes (5) ─────────────────────────────────────

function Draw-Card-LegSolara {
  # Solara the Sunblade — radiant golden sword + flowing sun cloak
  param($bmp)
  Rng-Init 'leg.solara'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 16
  # Sun-radiance backdrop — 8 rays from behind the head
  $rayCol = With-Alpha (Color-FromHex '#fff0a0') 90
  for ($i = 0; $i -lt 12; $i++) {
    $ang = $i * (2 * [Math]::PI / 12) - [Math]::PI / 2
    for ($d = 8; $d -lt 22; $d++) {
      $rx = $CARD_CX + [int]([Math]::Round([Math]::Cos($ang) * $d))
      $ry = 20 + [int]([Math]::Round([Math]::Sin($ang) * $d * 0.8))
      Blend-Pixel $bmp $rx $ry $rayCol
    }
  }
  $gold = @{
    deep   = (Color-FromHex '#6a4a08');
    shadow = (Color-FromHex '#a87820');
    base   = (Color-FromHex '#e8b438');
    high   = (Color-FromHex '#ffd870');
    top    = (Color-FromHex '#fff8c8');
  }
  $a = Draw-Humanoid $bmp $SKIN_FAIR $gold -accent (Color-FromHex '#ffefb0')
  # Crown of sunrays
  for ($i = 0; $i -lt 7; $i++) {
    $ang = ($i - 3) * 0.45
    $cx2 = $CARD_CX + [int]([Math]::Round([Math]::Sin($ang) * 8))
    $cy2 = ($a.headTop - 1) - [int]([Math]::Round([Math]::Cos($ang) * 5))
    Set-Pixel $bmp $cx2 $cy2 $gold.top
    Set-Pixel $bmp $cx2 ($cy2 - 1) $gold.high
  }
  # Hair — long blond locks framing face
  Fill-Box $bmp ($CARD_CX - 8) ($a.headY - 4) 3 8 $gold.shadow
  Fill-Box $bmp ($CARD_CX + 6) ($a.headY - 4) 3 8 $gold.shadow
  Set-Pixel $bmp ($CARD_CX - 7) ($a.headY - 4) $gold.high
  # Eyes — bright gold
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#fff080')
  # Sunblade — broadsword held diagonally with radiant glow
  $bladeTop = 8
  $bladeBot = $a.handY + 1
  Draw-Blade $bmp ($a.handRx + 3) $bladeTop $bladeBot 5 $gold -Fuller -accent (Color-FromHex '#ffe890')
  # Glow on the blade
  for ($y = $bladeTop; $y -le $bladeBot; $y++) {
    Blend-Pixel $bmp ($a.handRx + 1) $y (With-Alpha (Color-FromHex '#fff8c0') 90)
    Blend-Pixel $bmp ($a.handRx + 5) $y (With-Alpha (Color-FromHex '#fff8c0') 90)
  }
  # Crossguard — winged
  Fill-Box $bmp ($a.handRx - 1) ($a.handY) 9 2 $gold.high
  Set-Pixel $bmp ($a.handRx - 2) ($a.handY + 1) $gold.shadow
  Set-Pixel $bmp ($a.handRx + 8) ($a.handY + 1) $gold.shadow
  Draw-Grip $bmp ($a.handRx + 3) ($a.handY + 2) ($a.handY + 5) 2 $MAT_LEATHER
  # Sun emblem on chest
  Shade-Disc $bmp $CARD_CX ($a.torsoY + 10) 4 $gold -RimLight
}

function Draw-Card-LegKorrik {
  # Korrik the Bonecrusher — hulking armored figure with maul + spiked shoulders
  param($bmp)
  Rng-Init 'leg.korrik'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 18
  $a = Draw-Humanoid $bmp $SKIN_GREY $MAT_IRON -torsoW 24 -torsoH 24 -reach 28 -accent $BRAND.Crimson
  # Helm — closed iron with mohawk crest
  Fill-Box $bmp ($CARD_CX - 8) ($a.headY - 7) 16 12 $MAT_IRON.shadow
  for ($x = ($CARD_CX - 8); $x -le ($CARD_CX + 7); $x++) {
    Set-Pixel $bmp $x ($a.headY - 7) $MAT_IRON.high
  }
  # Visor slit — burning eyes
  Fill-Box $bmp ($CARD_CX - 6) ($a.headY) 13 2 (Color-FromHex '#08040c')
  Set-Pixel $bmp ($CARD_CX - 3) ($a.headY + 1) $BRAND.Crimson
  Set-Pixel $bmp ($CARD_CX + 3) ($a.headY + 1) $BRAND.Crimson
  Set-Pixel $bmp ($CARD_CX - 3) $a.headY (Color-FromHex '#ff6048')
  Set-Pixel $bmp ($CARD_CX + 3) $a.headY (Color-FromHex '#ff6048')
  # Mohawk crest — bone spikes
  for ($i = 0; $i -lt 5; $i++) {
    Set-Pixel $bmp $CARD_CX ($a.headY - 8 - $i) $SKIN_BONE.high
    Set-Pixel $bmp ($CARD_CX - 1) ($a.headY - 8 - $i) $SKIN_BONE.shadow
  }
  # Spiked pauldrons (shoulder spikes)
  foreach ($sx in @(($CARD_CX - 13), ($CARD_CX + 12))) {
    Shade-Disc $bmp $sx ($a.torsoY + 3) 4 $MAT_IRON -RimLight
    Set-Pixel $bmp $sx ($a.torsoY - 2) $MAT_IRON.top
    Set-Pixel $bmp $sx ($a.torsoY - 1) $MAT_IRON.high
  }
  # Massive two-handed maul — diagonal across the body
  $mh = $a.handRx + 1
  # Shaft from right hand up to upper-right
  Draw-Shaft $bmp $mh ($a.handY - 4) ($GROUND_Y - 4) 3 $MAT_WOOD_DARK
  # Hammer head — wide block at the top
  $hx = $mh - 5
  $hy = $a.handY - 12
  Stroke-Box $bmp $hx $hy 12 8 $MAT_IRON.deep $MAT_IRON.base
  Fill-Box $bmp ($hx + 1) ($hy + 1) 10 1 $MAT_IRON.high
  Fill-Box $bmp ($hx + 1) ($hy + 6) 10 1 $MAT_IRON.shadow
  # Spikes on top of hammer
  Set-Pixel $bmp ($hx + 2) ($hy - 1) $MAT_IRON.top
  Set-Pixel $bmp ($hx + 5) ($hy - 1) $MAT_IRON.top
  Set-Pixel $bmp ($hx + 8) ($hy - 1) $MAT_IRON.top
  Set-Pixel $bmp ($hx + 11) ($hy - 1) $MAT_IRON.top
  # Bloodstain
  Set-Pixel $bmp ($hx + 3) ($hy + 3) $BRAND.Crimson
  Set-Pixel $bmp ($hx + 8) ($hy + 4) $BRAND.Crimson
}

function Draw-Card-LegMireth {
  # Mireth, Vault Whisperer — slim hooded figure with floating arcane sigil
  param($bmp)
  Rng-Init 'leg.mireth'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  # Backdrop — magic circle behind
  Draw-MagicCircle $bmp $CARD_CX 38 22 (Color-FromHex '#7c5cff') 70 -Runes
  $robe = @{
    deep   = (Color-FromHex '#0a0a30');
    shadow = (Color-FromHex '#1c1a5c');
    base   = (Color-FromHex '#3e3a98');
    high   = (Color-FromHex '#6a64d0');
    top    = (Color-FromHex '#a8a4f0');
  }
  $a = Draw-Humanoid $bmp $SKIN_PALE $robe -accent (Color-FromHex '#cab8ff')
  # Deep hood
  for ($i = 0; $i -lt 5; $i++) {
    $w = 14 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 2 + $i) $w 1 $robe.deep
    Set-Pixel $bmp $x0 ($a.headTop - 2 + $i) $robe.shadow
  }
  # Face hidden — only luminous violet eyes
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY - 1) 11 4 (Color-FromHex '#080414')
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#cab8ff')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#cab8ff')
  Set-Pixel $bmp ($CARD_CX - 2) ($a.headY - 1) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($CARD_CX + 2) ($a.headY - 1) (Color-FromHex '#ffffff')
  # Hands raised — palms out, glyph hovering above
  Fill-Box $bmp ($a.handLx + 1) ($a.handY - 6) 3 4 $SKIN_PALE.base
  Fill-Box $bmp ($a.handRx - 1) ($a.handY - 6) 3 4 $SKIN_PALE.base
  # Floating arcane glyph between the hands
  $gx = $CARD_CX; $gy = $a.handY - 4
  Draw-Gem $bmp $gx $gy 7 $GEM_VOLTAIC
  # Sparkles
  Set-Pixel $bmp ($gx - 5) ($gy - 3) (Color-FromHex '#fff0a0')
  Set-Pixel $bmp ($gx + 5) ($gy - 2) (Color-FromHex '#fff0a0')
  Set-Pixel $bmp ($gx - 3) ($gy + 4) (Color-FromHex '#a890ff')
  Set-Pixel $bmp ($gx + 4) ($gy + 4) (Color-FromHex '#a890ff')
}

function Draw-Card-LegThalor {
  # Thalor the Stormwarden — caped figure with crackling lightning over head
  param($bmp)
  Rng-Init 'leg.thalor'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 16
  # Storm cloud behind upper area
  $cloud = With-Alpha (Color-FromHex '#5a607a') 160
  for ($x = 8; $x -lt 56; $x++) {
    for ($y = 4; $y -lt 14; $y++) {
      $dx = ($x - 32) / 18.0
      $dy = ($y - 9) / 4.0
      if (($dx*$dx + $dy*$dy) -lt 1.0) { Blend-Pixel $bmp $x $y $cloud }
    }
  }
  $armor = @{
    deep   = (Color-FromHex '#0a1a30');
    shadow = (Color-FromHex '#1a3460');
    base   = (Color-FromHex '#3458a8');
    high   = (Color-FromHex '#6a92e0');
    top    = (Color-FromHex '#aac8ff');
  }
  $a = Draw-Humanoid $bmp $SKIN_TAN $armor -accent (Color-FromHex '#a8e0ff')
  # Long flowing cape behind
  Fill-Box $bmp ($CARD_CX - 13) ($a.torsoY + 2) 3 ($a.torsoH + 12) $armor.deep
  Fill-Box $bmp ($CARD_CX + 10) ($a.torsoY + 2) 3 ($a.torsoH + 12) $armor.deep
  Set-Pixel $bmp ($CARD_CX - 13) ($a.torsoY + 2) $armor.shadow
  Set-Pixel $bmp ($CARD_CX + 12) ($a.torsoY + $a.torsoH + 12) $armor.deep
  # Open helm — winged
  Fill-Box $bmp ($CARD_CX - 7) ($a.headY - 6) 14 8 $armor.shadow
  Set-Pixel $bmp ($CARD_CX - 7) ($a.headY - 6) $armor.high
  # Wing crests
  for ($i = 0; $i -lt 4; $i++) {
    Set-Pixel $bmp ($CARD_CX - 8 - $i) ($a.headY - 6 + $i) $armor.high
    Set-Pixel $bmp ($CARD_CX + 7 + $i) ($a.headY - 6 + $i) $armor.high
  }
  # Glowing blue eyes
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#a8e0ff')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#a8e0ff')
  # Lightning bolt arcing above
  Draw-Bolt $bmp ($CARD_CX - 12) 6 ($CARD_CX + 12) 14 (Color-FromHex '#fff0a0') (Color-FromHex '#a8c8ff')
  Draw-Bolt $bmp ($CARD_CX + 10) 4 ($CARD_CX - 6) 12 (Color-FromHex '#fff0a0') (Color-FromHex '#a8c8ff')
  # Lightning glaive in right hand
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 18) ($a.handY + 6) 2 $MAT_WOOD_DARK
  # Glaive head — bolt-shape
  Set-Pixel $bmp ($a.handRx + 2) ($a.handY - 19) $armor.top
  Line-Pixel $bmp ($a.handRx + 2) ($a.handY - 18) ($a.handRx + 5) ($a.handY - 22) (Color-FromHex '#fff0a0')
  Line-Pixel $bmp ($a.handRx + 2) ($a.handY - 18) ($a.handRx - 1) ($a.handY - 22) (Color-FromHex '#fff0a0')
}

function Draw-Card-LegNyx {
  # Nyx, Pact-Bound — shadow figure with chained mask + violet flame eyes
  param($bmp)
  Rng-Init 'leg.nyx'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  # Violet smoke backdrop
  for ($i = 0; $i -lt 30; $i++) {
    $sx = $CARD_CX + (Rng-Range -12 12)
    $sy = (Rng-Range 14 60)
    $a2 = (Rng-Range 30 100)
    Blend-Pixel $bmp $sx $sy (With-Alpha $ARCANE.shadow $a2)
  }
  $a = Draw-Humanoid $bmp $SKIN_PURPLE $SHADOW -accent $ARCANE.base
  # Hood
  for ($i = 0; $i -lt 4; $i++) {
    $w = 14 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 2 + $i) $w 1 $SHADOW.deep
    Set-Pixel $bmp $x0 ($a.headTop - 2 + $i) $SHADOW.high
  }
  # Mask — pale skull mask
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY - 2) 11 6 $SKIN_BONE.shadow
  Set-Pixel $bmp ($CARD_CX - 5) ($a.headY - 2) $SKIN_BONE.high
  Set-Pixel $bmp ($CARD_CX + 5) ($a.headY - 2) $SKIN_BONE.deep
  # Mask eyes — violet flame
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY $ARCANE.base
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY $ARCANE.base
  Set-Pixel $bmp ($CARD_CX - 2) ($a.headY - 1) $ARCANE.high
  Set-Pixel $bmp ($CARD_CX + 2) ($a.headY - 1) $ARCANE.high
  Set-Pixel $bmp ($CARD_CX - 2) ($a.headY - 2) $ARCANE.top
  Set-Pixel $bmp ($CARD_CX + 2) ($a.headY - 2) $ARCANE.top
  # Mask mouth — stitched line
  for ($x = ($CARD_CX - 3); $x -le ($CARD_CX + 3); $x++) {
    Set-Pixel $bmp $x ($a.headY + 3) $SHADOW.deep
  }
  # Chains around chest — diagonal links
  for ($i = 0; $i -lt 6; $i++) {
    $cx2 = $CARD_CX - 8 + $i * 3
    $cy2 = $a.torsoY + 4 + ($i % 2) * 4
    Set-Pixel $bmp $cx2 $cy2 $MAT_IRON.high
    Set-Pixel $bmp ($cx2 + 1) $cy2 $MAT_IRON.shadow
    Set-Pixel $bmp $cx2 ($cy2 + 1) $MAT_IRON.shadow
  }
  # Pact dagger in right hand — violet-edged
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 8) ($a.handY + 1) 2 $SHADOW -accent $ARCANE.base
  Set-Pixel $bmp ($a.handRx + 2) ($a.handY - 8) $ARCANE.top
}

# ── Legendaries — bosses (5) ─────────────────────────────────────

function Draw-Card-LegBoneTyrant {
  # The Bone Tyrant — towering skeletal warlord on a small mound
  param($bmp)
  Rng-Init 'leg.bonetyrant'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 18
  $a = Draw-Humanoid $bmp $SKIN_BONE $MAT_OBSIDIAN -torsoW 22 -torsoH 24 -reach 26 -accent $BRAND.Crimson
  # Skull face — eyes hollow, jaw fanged
  Draw-Head $bmp $CARD_CX $a.headY 7 $SKIN_BONE
  # Eye sockets — dark hollows with red gleam
  Fill-Box $bmp ($CARD_CX - 3) ($a.headY - 1) 3 3 (Color-FromHex '#040408')
  Fill-Box $bmp ($CARD_CX + 1) ($a.headY - 1) 3 3 (Color-FromHex '#040408')
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY $BRAND.Crimson
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY $BRAND.Crimson
  # Fanged jaw — vertical lines
  for ($i = 0; $i -lt 5; $i++) {
    Set-Pixel $bmp ($CARD_CX - 2 + $i) ($a.headY + 3) $SHADOW.deep
  }
  Set-Pixel $bmp ($CARD_CX - 1) ($a.headY + 4) $SKIN_BONE.high
  Set-Pixel $bmp ($CARD_CX + 1) ($a.headY + 4) $SKIN_BONE.high
  # Crown of bones — 5 spikes
  for ($i = 0; $i -lt 5; $i++) {
    $cx2 = $CARD_CX - 8 + $i * 4
    Set-Pixel $bmp $cx2 ($a.headTop - 1) $SKIN_BONE.high
    Set-Pixel $bmp $cx2 ($a.headTop - 2) $SKIN_BONE.base
    Set-Pixel $bmp $cx2 ($a.headTop - 3) $SKIN_BONE.shadow
  }
  Fill-Box $bmp ($CARD_CX - 9) $a.headTop 18 1 $MAT_GOLD.shadow
  # Ribcage showing through torn cloak
  for ($i = 0; $i -lt 4; $i++) {
    Fill-Box $bmp ($CARD_CX - 6) ($a.torsoY + 4 + $i * 4) 13 2 $SKIN_BONE.shadow
    Set-Pixel $bmp ($CARD_CX - 6) ($a.torsoY + 4 + $i * 4) $SKIN_BONE.high
  }
  # Sceptre in right hand — bone with red gem
  Draw-Shaft $bmp ($a.handRx + 3) ($a.handY - 18) ($a.handY + 5) 2 $SKIN_BONE
  Draw-Gem $bmp ($a.handRx + 3) ($a.handY - 20) 5 $GEM_RUBY
}

function Draw-Card-LegVoltaicWyrm {
  # Voltaic Wyrm — serpentine dragon coiled vertically, crackling with bolts
  param($bmp)
  Rng-Init 'leg.voltaicwyrm'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 18
  $wyrm = @{
    deep   = (Color-FromHex '#1a0c40');
    shadow = (Color-FromHex '#3a1f7a');
    base   = (Color-FromHex '#5e3acc');
    high   = (Color-FromHex '#8a6ee8');
    top    = (Color-FromHex '#c0a8ff');
  }
  # S-curve serpent body — sine wave from bottom to top
  for ($y = $GROUND_Y; $y -ge 14; $y--) {
    $t = ($GROUND_Y - $y) / 64.0
    $cx2 = $CARD_CX + [int]([Math]::Round([Math]::Sin($t * [Math]::PI * 2.3) * 14))
    $w   = [int]([Math]::Max(2, 7 - $t * 3))    # taper toward tail
    $halfL = [int]($w / 2)
    for ($dx = -$halfL; $dx -le $halfL; $dx++) {
      $col = if ($dx -lt 0) { $wyrm.high } elseif ($dx -eq 0) { $wyrm.base } else { $wyrm.shadow }
      Set-Pixel $bmp ($cx2 + $dx) $y $col
    }
    # Spine highlights
    if (($y % 3) -eq 0) { Set-Pixel $bmp ($cx2 - $halfL) $y $wyrm.top }
  }
  # Dragon head at top of curve
  $hx = $CARD_CX + [int]([Math]::Round([Math]::Sin(([Math]::PI * 2.3) * (64/64.0)) * 14))
  $hy = 14
  Shade-Oval $bmp $hx $hy 7 5 $wyrm
  # Horns
  Set-Pixel $bmp ($hx - 5) ($hy - 5) $wyrm.high
  Set-Pixel $bmp ($hx - 6) ($hy - 6) $wyrm.high
  Set-Pixel $bmp ($hx + 5) ($hy - 5) $wyrm.high
  Set-Pixel $bmp ($hx + 6) ($hy - 6) $wyrm.high
  # Glowing yellow eyes
  Set-Pixel $bmp ($hx - 2) $hy (Color-FromHex '#fff0a0')
  Set-Pixel $bmp ($hx + 2) $hy (Color-FromHex '#fff0a0')
  # Lightning crackles along the body
  Draw-Bolt $bmp ($CARD_CX - 14) 38 ($CARD_CX + 16) 32 (Color-FromHex '#fff0a0') $wyrm.top
  Draw-Bolt $bmp ($CARD_CX - 8) 60 ($CARD_CX + 12) 54 (Color-FromHex '#fff0a0') $wyrm.top
}

function Draw-Card-LegVaultLich {
  # The Vault Lich — robed undead caster cradling a glowing tome
  param($bmp)
  Rng-Init 'leg.vaultlich'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $robe = @{
    deep   = (Color-FromHex '#0a1a14');
    shadow = (Color-FromHex '#1a3a28');
    base   = (Color-FromHex '#2f6648');
    high   = (Color-FromHex '#5a9268');
    top    = (Color-FromHex '#90c098');
  }
  $a = Draw-Humanoid $bmp $SKIN_BONE $robe -accent (Color-FromHex '#9affc0')
  # Hood high + sharp
  for ($i = 0; $i -lt 7; $i++) {
    $w = 14 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 6 + $i) $w 1 $robe.deep
    Set-Pixel $bmp $x0 ($a.headTop - 6 + $i) $robe.shadow
    Set-Pixel $bmp ($x0 + $w - 1) ($a.headTop - 6 + $i) $robe.high
  }
  # Skull face — sunken
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY - 1) 11 4 (Color-FromHex '#080814')
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#9affc0')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#9affc0')
  Set-Pixel $bmp ($CARD_CX - 2) ($a.headY - 1) (Color-FromHex '#e0fff0')
  Set-Pixel $bmp ($CARD_CX + 2) ($a.headY - 1) (Color-FromHex '#e0fff0')
  # Floating tome between hands
  $tx = $CARD_CX; $ty = $a.handY - 4
  Stroke-Box $bmp ($tx - 6) ($ty - 4) 12 8 (Color-FromHex '#3a1808') (Color-FromHex '#6a2a14')
  Fill-Box $bmp ($tx - 5) ($ty - 3) 10 6 (Color-FromHex '#f0e0a0')
  # Pages flipping
  Line-Pixel $bmp ($tx - 5) ($ty - 3) ($tx + 4) ($ty + 2) (Color-FromHex '#d8c878')
  Line-Pixel $bmp ($tx - 5) ($ty + 2) ($tx + 4) ($ty - 3) (Color-FromHex '#d8c878')
  # Glow above tome
  Shade-Disc $bmp $tx ($ty - 9) 3 (Build-Ramp '#9affc0') -RimLight
  Set-Pixel $bmp $tx ($ty - 11) (Color-FromHex '#fff8d8')
}

function Draw-Card-LegWarchief {
  # Goblin Warchief — armored goblin with two big axes + scrappy banner
  param($bmp)
  Rng-Init 'leg.warchief'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $a = Draw-Humanoid $bmp $SKIN_GREEN $MAT_LEATHER -accent $BRAND.Crimson
  # Tribal helm — fur + horns
  Fill-Box $bmp ($CARD_CX - 7) ($a.headY - 6) 14 5 (Color-FromHex '#3a2410')
  for ($x = ($CARD_CX - 7); $x -le ($CARD_CX + 6); $x++) {
    Set-Pixel $bmp $x ($a.headY - 6) (Color-FromHex '#5e3a20')
  }
  # Horns — curving outward
  Set-Pixel $bmp ($CARD_CX - 8) ($a.headY - 7) $SKIN_BONE.high
  Set-Pixel $bmp ($CARD_CX - 9) ($a.headY - 8) $SKIN_BONE.base
  Set-Pixel $bmp ($CARD_CX + 7) ($a.headY - 7) $SKIN_BONE.high
  Set-Pixel $bmp ($CARD_CX + 8) ($a.headY - 8) $SKIN_BONE.base
  # Yellow goblin eyes + tusks
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX - 2) ($a.headY + 3) $SKIN_BONE.high
  Set-Pixel $bmp ($CARD_CX + 2) ($a.headY + 3) $SKIN_BONE.high
  # Two axes — one in each hand
  # Left axe — held low
  Draw-Shaft $bmp ($a.handLx) ($a.handY - 4) ($a.handY + 10) 2 $MAT_WOOD_DARK
  # Axe head left
  Fill-Box $bmp ($a.handLx - 4) ($a.handY - 4) 4 6 $MAT_IRON.base
  Set-Pixel $bmp ($a.handLx - 4) ($a.handY - 4) $MAT_IRON.high
  Set-Pixel $bmp ($a.handLx - 5) ($a.handY - 1) $MAT_IRON.high
  # Right axe — held high (overhead)
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 12) ($a.handY + 2) 2 $MAT_WOOD_DARK
  Fill-Box $bmp ($a.handRx + 3) ($a.handY - 14) 5 5 $MAT_IRON.base
  Set-Pixel $bmp ($a.handRx + 3) ($a.handY - 14) $MAT_IRON.high
  Set-Pixel $bmp ($a.handRx + 8) ($a.handY - 11) $MAT_IRON.shadow
  # Tribal warpaint on chest — red stripes
  Set-Pixel $bmp ($CARD_CX - 3) ($a.torsoY + 6) $BRAND.Crimson
  Set-Pixel $bmp $CARD_CX ($a.torsoY + 6) $BRAND.Crimson
  Set-Pixel $bmp ($CARD_CX + 3) ($a.torsoY + 6) $BRAND.Crimson
}

function Draw-Card-LegHollowKing {
  # The Hollow King — gaunt crowned figure on shadowed throne fragment
  param($bmp)
  Rng-Init 'leg.hollowking'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 18
  # Throne backdrop — two tall obsidian uprights
  Shade-Box $bmp 8 14 6 60 $MAT_OBSIDIAN
  Shade-Box $bmp 50 14 6 60 $MAT_OBSIDIAN
  # Backplate
  Shade-Box $bmp 18 18 28 24 $MAT_OBSIDIAN
  # Sceptre/king body
  $robe = @{
    deep   = (Color-FromHex '#040408');
    shadow = (Color-FromHex '#101428');
    base   = (Color-FromHex '#202840');
    high   = (Color-FromHex '#404a6a');
    top    = (Color-FromHex '#5e6a90');
  }
  $a = Draw-Humanoid $bmp $SKIN_PURPLE $robe -accent $MAT_GOLD.base
  # Hollow crown — 5 tall spikes
  for ($i = 0; $i -lt 5; $i++) {
    $cx2 = $CARD_CX - 8 + $i * 4
    $h2 = if ($i -eq 2) { 7 } else { 5 }
    for ($k = 0; $k -lt $h2; $k++) {
      Set-Pixel $bmp $cx2 ($a.headTop - 1 - $k) $MAT_GOLD.high
    }
    Set-Pixel $bmp $cx2 ($a.headTop - $h2) $MAT_GOLD.top
  }
  Fill-Box $bmp ($CARD_CX - 9) $a.headTop 18 2 $MAT_GOLD.shadow
  # Face — empty void with two pale eyes
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY - 2) 11 7 (Color-FromHex '#040408')
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#d0d8ff')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#d0d8ff')
  Set-Pixel $bmp ($CARD_CX - 2) ($a.headY - 1) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($CARD_CX + 2) ($a.headY - 1) (Color-FromHex '#ffffff')
  # Scepter — long with gem
  Draw-Shaft $bmp ($a.handRx + 2) ($a.headTop - 4) ($a.handY + 6) 2 $MAT_OBSIDIAN
  Draw-Gem $bmp ($a.handRx + 2) ($a.headTop - 6) 5 $GEM_ONYX
  Set-Pixel $bmp ($a.handRx + 2) ($a.headTop - 8) $MAT_GOLD.top
}

# ── Rares — minions (7) ──────────────────────────────────────────

function Draw-Card-VoltaicMage {
  param($bmp)
  Rng-Init 'r.voltaicmage'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $robe = @{
    deep   = (Color-FromHex '#1a0c40');
    shadow = (Color-FromHex '#3a1f7a');
    base   = $BRAND.Violet;
    high   = $BRAND.VioletHi;
    top    = (Color-FromHex '#cab8ff');
  }
  $a = Draw-Humanoid $bmp $SKIN_PALE $robe -accent (Color-FromHex '#fff080')
  # Pointed hat
  for ($i = 0; $i -lt 10; $i++) {
    $w = 10 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 2 - $i) $w 1 $robe.base
    Set-Pixel $bmp $x0 ($a.headTop - 2 - $i) $robe.shadow
    Set-Pixel $bmp ($x0 + $w - 1) ($a.headTop - 2 - $i) $robe.high
  }
  Set-Pixel $bmp $CARD_CX ($a.headTop - 11) (Color-FromHex '#fff080')
  Fill-Box $bmp ($CARD_CX - 7) ($a.headTop - 2) 15 1 $robe.deep
  # Glowing green eyes
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#5bff95')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#5bff95')
  # Staff with orb
  Draw-Shaft $bmp ($a.handRx + 2) ($a.headTop - 6) ($a.handY + 6) 2 $MAT_WOOD_DARK
  Shade-Disc $bmp ($a.handRx + 2) ($a.headTop - 8) 3 $ARCANE -RimLight
  Set-Pixel $bmp ($a.handRx + 2) ($a.headTop - 10) (Color-FromHex '#5bff95')
}

function Draw-Card-Sapper {
  param($bmp)
  Rng-Init 'r.sapper'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $a = Draw-Humanoid $bmp $SKIN_TAN $MAT_LEATHER_BLACK -accent $BRAND.Crimson
  # Hood
  for ($i = 0; $i -lt 4; $i++) {
    $w = 12 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 1 + $i) $w 1 $MAT_LEATHER_BLACK.deep
  }
  # Mask
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY) 11 3 (Color-FromHex '#08050c')
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY $BRAND.Crimson
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY $BRAND.Crimson
  # Bomb in right hand
  Shade-Disc $bmp ($a.handRx + 3) ($a.handY - 2) 4 $MAT_OBSIDIAN -RimLight
  Set-Pixel $bmp ($a.handRx + 3) ($a.handY - 6) $MAT_WOOD_DARK.high
  Set-Pixel $bmp ($a.handRx + 3) ($a.handY - 7) $MAT_WOOD_DARK.base
  Set-Pixel $bmp ($a.handRx + 4) ($a.handY - 8) $BRAND.Crimson
  Set-Pixel $bmp ($a.handRx + 4) ($a.handY - 9) (Color-FromHex '#fff0a0')
  # Knife in left hand
  Draw-Blade $bmp ($a.handLx - 1) ($a.handY - 2) ($a.handY + 8) 2 $MAT_STEEL
  # Belt of charges
  for ($i = 0; $i -lt 4; $i++) {
    Set-Pixel $bmp ($CARD_CX - 6 + $i * 4) ($a.torsoY + 14) $BRAND.Crimson
    Set-Pixel $bmp ($CARD_CX - 6 + $i * 4) ($a.torsoY + 15) $MAT_LEATHER.deep
  }
}

function Draw-Card-BoltKnight {
  param($bmp)
  Rng-Init 'r.boltknight'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $a = Draw-Humanoid $bmp $SKIN_FAIR $MAT_STEEL -torsoW 22 -accent (Color-FromHex '#a8c8ff')
  # Visored helm with crest
  Fill-Box $bmp ($CARD_CX - 7) ($a.headY - 6) 14 8 $MAT_STEEL.shadow
  for ($x = ($CARD_CX - 7); $x -le ($CARD_CX + 6); $x++) {
    Set-Pixel $bmp $x ($a.headY - 6) $MAT_STEEL.high
  }
  # Crest
  for ($i = 0; $i -lt 3; $i++) {
    Set-Pixel $bmp $CARD_CX ($a.headY - 7 - $i) (Color-FromHex '#a8c8ff')
  }
  # Visor
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY) 11 2 (Color-FromHex '#08080c')
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#a8c8ff')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#a8c8ff')
  # Round shield with bolt emblem (taunt)
  Shade-Disc $bmp ($a.handLx - 1) ($a.handY) 7 $MAT_STEEL -RimLight
  Draw-Bolt $bmp ($a.handLx - 4) ($a.handY - 4) ($a.handLx + 2) ($a.handY + 4) (Color-FromHex '#fff0a0') (Color-FromHex '#a8c8ff')
  # Long sword in right hand
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 14) ($a.handY + 2) 3 $MAT_STEEL -Fuller
  Fill-Box $bmp ($a.handRx) ($a.handY + 2) 5 1 $MAT_GOLD.base
}

function Draw-Card-HealerCleric {
  param($bmp)
  Rng-Init 'r.healercleric'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $robe = $MAT_CLOTH_LINEN
  $a = Draw-Humanoid $bmp $SKIN_PALE $robe -accent $MAT_GOLD.base
  # Hood lowered
  for ($i = 0; $i -lt 3; $i++) {
    $w = 12 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 1 + $i) $w 1 $robe.shadow
  }
  # Halo
  $halo = With-Alpha (Color-FromHex '#fff0a0') 200
  for ($ang = 30; $ang -lt 330; $ang += 18) {
    $rad = $ang * [Math]::PI / 180
    $hx = $CARD_CX + [int]([Math]::Round([Math]::Cos($rad) * 8))
    $hy = ($a.headTop - 3) - [int]([Math]::Round([Math]::Sin($rad) * 3))
    Blend-Pixel $bmp $hx $hy $halo
  }
  # Holy cross on chest
  Draw-HealCross $bmp $CARD_CX ($a.torsoY + 10) 6 $MAT_GOLD
  # Staff with green orb
  Draw-Shaft $bmp ($a.handRx + 2) ($a.headTop - 4) ($a.handY + 4) 2 $MAT_WOOD_LIGHT
  Shade-Disc $bmp ($a.handRx + 2) ($a.headTop - 6) 3 $NATURE -RimLight
}

function Draw-Card-ArcherTwin {
  param($bmp)
  Rng-Init 'r.archertwin'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 18
  # Two smaller archer figures side by side
  $green = @{
    deep   = (Color-FromHex '#0c2a18');
    shadow = (Color-FromHex '#1c4a28');
    base   = (Color-FromHex '#347040');
    high   = (Color-FromHex '#5e9460');
    top    = (Color-FromHex '#9cc888');
  }
  # Left archer
  $aL = Draw-Humanoid $bmp $SKIN_FAIR $green -cx ($CARD_CX - 10) -torsoW 12 -reach 16 -accent (Color-FromHex '#d8c878')
  # Right archer
  $aR = Draw-Humanoid $bmp $SKIN_FAIR $green -cx ($CARD_CX + 10) -torsoW 12 -reach 16 -accent (Color-FromHex '#d8c878')
  # Twin bows — small short bows in inner hands
  for ($y = ($aL.handY - 8); $y -le ($aL.handY + 4); $y++) {
    Set-Pixel $bmp ($CARD_CX - 4) $y $MAT_WOOD_DARK.base
    Set-Pixel $bmp ($CARD_CX + 4) $y $MAT_WOOD_DARK.base
  }
  Set-Pixel $bmp ($CARD_CX - 4) ($aL.handY - 8) $MAT_WOOD_DARK.high
  Set-Pixel $bmp ($CARD_CX + 4) ($aR.handY - 8) $MAT_WOOD_DARK.high
  # Arrows nocked outward
  Set-Pixel $bmp ($CARD_CX - 5) ($aL.handY - 2) $MAT_WOOD_LIGHT.base
  Set-Pixel $bmp ($CARD_CX - 6) ($aL.handY - 2) $MAT_STEEL.top
  Set-Pixel $bmp ($CARD_CX + 5) ($aR.handY - 2) $MAT_WOOD_LIGHT.base
  Set-Pixel $bmp ($CARD_CX + 6) ($aR.handY - 2) $MAT_STEEL.top
}

function Draw-Card-BoltEngineer {
  param($bmp)
  Rng-Init 'r.boltengineer'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $coat = @{
    deep   = (Color-FromHex '#3a1e08');
    shadow = (Color-FromHex '#6a3e1c');
    base   = (Color-FromHex '#a06028');
    high   = (Color-FromHex '#d8924c');
    top    = (Color-FromHex '#f4c478');
  }
  $a = Draw-Humanoid $bmp $SKIN_TAN $coat -accent (Color-FromHex '#a8c8ff')
  # Goggles on head
  Fill-Box $bmp ($CARD_CX - 4) ($a.headY - 1) 9 3 $MAT_IRON.deep
  Set-Pixel $bmp ($CARD_CX - 3) $a.headY (Color-FromHex '#a8c8ff')
  Set-Pixel $bmp ($CARD_CX + 3) $a.headY (Color-FromHex '#a8c8ff')
  Set-Pixel $bmp ($CARD_CX - 3) ($a.headY - 1) $MAT_IRON.high
  Set-Pixel $bmp ($CARD_CX + 3) ($a.headY - 1) $MAT_IRON.high
  Fill-Box $bmp ($CARD_CX - 1) $a.headY 3 1 $MAT_IRON.shadow
  # Tinker cap
  for ($x = ($CARD_CX - 6); $x -le ($CARD_CX + 5); $x++) {
    Set-Pixel $bmp $x ($a.headTop - 1) $coat.deep
  }
  Fill-Box $bmp ($CARD_CX - 5) ($a.headTop - 3) 11 2 $coat.shadow
  # Wrench in right hand
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 8) ($a.handY + 4) 2 $MAT_IRON
  Fill-Box $bmp ($a.handRx + 1) ($a.handY - 10) 5 3 $MAT_IRON.base
  Set-Pixel $bmp ($a.handRx + 1) ($a.handY - 10) $MAT_IRON.high
  Set-Pixel $bmp ($a.handRx + 5) ($a.handY - 9) $MAT_IRON.shadow
  Set-Pixel $bmp ($a.handRx + 3) ($a.handY - 9) (Color-FromHex '#000000')
  # Coil in left hand (mana battery)
  Shade-Disc $bmp $a.handLx ($a.handY - 2) 3 $ARCANE
  Set-Pixel $bmp $a.handLx ($a.handY - 4) (Color-FromHex '#fff0a0')
}

function Draw-Card-VaultSniffer {
  # Small fox-like critter — body low to ground, glowing nose
  param($bmp)
  Rng-Init 'r.vaultsniffer'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $fur = @{
    deep   = (Color-FromHex '#4a1a08');
    shadow = (Color-FromHex '#7a3618');
    base   = (Color-FromHex '#a8521c');
    high   = (Color-FromHex '#d8843c');
    top    = (Color-FromHex '#ffac68');
  }
  # Body — long oval lying horizontally
  Shade-Oval $bmp $CARD_CX 60 18 8 $fur
  # Head — at right side
  Shade-Disc $bmp ($CARD_CX + 14) 54 6 $fur
  # Snout
  Fill-Box $bmp ($CARD_CX + 19) 56 4 2 $fur.shadow
  Set-Pixel $bmp ($CARD_CX + 22) 56 $ARCANE.top    # glowing nose
  Set-Pixel $bmp ($CARD_CX + 22) 55 $ARCANE.high
  # Ears — pointed
  Set-Pixel $bmp ($CARD_CX + 11) 49 $fur.high
  Set-Pixel $bmp ($CARD_CX + 11) 48 $fur.base
  Set-Pixel $bmp ($CARD_CX + 16) 48 $fur.high
  Set-Pixel $bmp ($CARD_CX + 17) 47 $fur.base
  # Eye
  Set-Pixel $bmp ($CARD_CX + 14) 53 (Color-FromHex '#fff080')
  # Legs — four short stubs
  for ($i = 0; $i -lt 4; $i++) {
    $lx = $CARD_CX - 13 + $i * 8
    Fill-Box $bmp $lx 66 3 6 $fur.shadow
    Set-Pixel $bmp $lx 66 $fur.high
  }
  # Bushy tail curling up
  Shade-Oval $bmp ($CARD_CX - 16) 54 4 8 $fur
  Set-Pixel $bmp ($CARD_CX - 16) 46 $fur.top
}

# ── Rares — spells (7) ───────────────────────────────────────────

function Draw-Card-ForgeBrand {
  # Anvil + hammer + glowing brand
  param($bmp)
  Rng-Init 'r.forgebrand'
  Draw-MagicCircle $bmp $CARD_CX 40 24 (Color-FromHex '#ff8030') 80 -Runes
  # Anvil — block shape
  Stroke-Box $bmp ($CARD_CX - 14) 50 28 8 $MAT_IRON.deep $MAT_IRON.base
  Fill-Box $bmp ($CARD_CX - 14) 50 28 1 $MAT_IRON.high
  Fill-Box $bmp ($CARD_CX - 14) 57 28 1 $MAT_IRON.shadow
  # Horn left
  Fill-Box $bmp ($CARD_CX - 18) 51 4 3 $MAT_IRON.shadow
  Set-Pixel $bmp ($CARD_CX - 18) 51 $MAT_IRON.high
  # Pedestal
  Fill-Box $bmp ($CARD_CX - 10) 58 20 10 $MAT_IRON.shadow
  Fill-Box $bmp ($CARD_CX - 12) 68 24 4 $MAT_IRON.deep
  # Glowing brand on anvil
  Fill-Box $bmp ($CARD_CX - 6) 48 12 2 $FIRE.base
  Fill-Box $bmp ($CARD_CX - 6) 49 12 1 $FIRE.high
  Set-Pixel $bmp ($CARD_CX - 2) 48 $FIRE.top
  Set-Pixel $bmp ($CARD_CX + 1) 48 $FIRE.top
  # Sparks
  foreach ($p in @(@(-8,42),@(2,38),@(8,44),@(-3,32))) {
    Set-Pixel $bmp ($CARD_CX + $p[0]) $p[1] $FIRE.top
  }
  # Hammer hovering above
  $hx = $CARD_CX + 8
  Draw-Shaft $bmp $hx 18 38 2 $MAT_WOOD_DARK
  Fill-Box $bmp ($hx - 4) 14 9 6 $MAT_IRON.base
  Set-Pixel $bmp ($hx - 4) 14 $MAT_IRON.high
  Set-Pixel $bmp ($hx + 4) 19 $MAT_IRON.shadow
}

function Draw-Card-GobPowder {
  # Goblin Powder — wooden keg with crimson fuse
  param($bmp)
  Rng-Init 'r.gobpowder'
  Draw-MagicCircle $bmp $CARD_CX 40 22 $BRAND.Crimson 80 -Runes
  # Keg body — barrel shape (oval body + flat top/bottom)
  Shade-Oval $bmp $CARD_CX 48 16 18 $MAT_WOOD_DARK
  # Bands
  foreach ($y in @(36, 42, 56, 62)) {
    Fill-Box $bmp ($CARD_CX - 12) $y 24 2 $MAT_IRON.shadow
    for ($x = ($CARD_CX - 11); $x -le ($CARD_CX + 11); $x++) {
      Set-Pixel $bmp $x $y $MAT_IRON.high
    }
  }
  # Skull mark on front
  Shade-Disc $bmp $CARD_CX 50 4 $SKIN_BONE
  Set-Pixel $bmp ($CARD_CX - 2) 49 (Color-FromHex '#080404')
  Set-Pixel $bmp ($CARD_CX + 2) 49 (Color-FromHex '#080404')
  Set-Pixel $bmp ($CARD_CX - 1) 52 (Color-FromHex '#080404')
  Set-Pixel $bmp ($CARD_CX + 1) 52 (Color-FromHex '#080404')
  # Fuse
  Line-Pixel $bmp $CARD_CX 30 ($CARD_CX + 4) 18 $MAT_WOOD_LIGHT.shadow
  Line-Pixel $bmp ($CARD_CX + 1) 30 ($CARD_CX + 5) 18 $MAT_WOOD_LIGHT.high
  # Spark at fuse tip
  Set-Pixel $bmp ($CARD_CX + 4) 17 $FIRE.top
  Set-Pixel $bmp ($CARD_CX + 5) 16 $FIRE.high
  Set-Pixel $bmp ($CARD_CX + 6) 15 $FIRE.base
  Set-Pixel $bmp ($CARD_CX + 3) 16 (Color-FromHex '#fff0a0')
}

function Draw-Card-VoltaicSurge {
  # Two parallel lightning bolts splitting the canvas
  param($bmp)
  Rng-Init 'r.voltaicsurge'
  Draw-MagicCircle $bmp $CARD_CX 40 26 (Color-FromHex '#7c5cff') 90 -Runes
  Draw-Bolt $bmp ($CARD_CX - 10) 12 ($CARD_CX - 6) 68 (Color-FromHex '#fff0a0') $ARCANE.top
  Draw-Bolt $bmp ($CARD_CX + 6) 12 ($CARD_CX + 10) 68 (Color-FromHex '#fff0a0') $ARCANE.top
  # Thicker centre highlight
  for ($y = 14; $y -lt 66; $y += 4) {
    Set-Pixel $bmp ($CARD_CX - 8) $y (Color-FromHex '#fff8d8')
    Set-Pixel $bmp ($CARD_CX + 8) $y (Color-FromHex '#fff8d8')
  }
  # Centre sparkle
  Shade-Disc $bmp $CARD_CX 40 4 $ARCANE -RimLight
  Set-Pixel $bmp $CARD_CX 38 (Color-FromHex '#fff0a0')
}

function Draw-Card-VaultSeal {
  # Magical sigil — runic seal with arcane lock
  param($bmp)
  Rng-Init 'r.vaultseal'
  # Outer ring + inner ring
  Draw-MagicCircle $bmp $CARD_CX 40 26 $ARCANE.base 120 -Runes
  Draw-MagicCircle $bmp $CARD_CX 40 18 $ARCANE.high 140
  # Central interlocking triangle/star (6-point)
  $r = 14
  for ($k = 0; $k -lt 6; $k++) {
    $ang0 = $k * [Math]::PI / 3
    $ang1 = (($k + 2) % 6) * [Math]::PI / 3
    $x0 = $CARD_CX + [int]([Math]::Round([Math]::Cos($ang0) * $r))
    $y0 = 40 + [int]([Math]::Round([Math]::Sin($ang0) * $r))
    $x1 = $CARD_CX + [int]([Math]::Round([Math]::Cos($ang1) * $r))
    $y1 = 40 + [int]([Math]::Round([Math]::Sin($ang1) * $r))
    Line-Pixel $bmp $x0 $y0 $x1 $y1 $ARCANE.top
  }
  # Lock core — keyhole
  Shade-Disc $bmp $CARD_CX 40 5 $MAT_GOLD -RimLight
  Set-Pixel $bmp $CARD_CX 39 $ARCANE.deep
  Set-Pixel $bmp $CARD_CX 40 $ARCANE.deep
  Set-Pixel $bmp $CARD_CX 41 $ARCANE.deep
  Set-Pixel $bmp ($CARD_CX - 1) 42 $ARCANE.deep
  Set-Pixel $bmp ($CARD_CX + 1) 42 $ARCANE.deep
}

function Draw-Card-BoltStorm {
  # Multiple bolts rain down across the canvas
  param($bmp)
  Rng-Init 'r.boltstorm'
  # Storm cloud at top
  $cloud = With-Alpha (Color-FromHex '#3a4258') 200
  for ($x = 4; $x -lt 60; $x++) {
    for ($y = 4; $y -lt 22; $y++) {
      $dx = ($x - 32) / 24.0
      $dy = ($y - 12) / 8.0
      $d = $dx*$dx + $dy*$dy
      if ($d -lt 1.0) {
        Blend-Pixel $bmp $x $y $cloud
        if ($d -lt 0.6) { Blend-Pixel $bmp $x $y (With-Alpha (Color-FromHex '#2a2f44') 150) }
      }
    }
  }
  # 5 bolts striking down from cloud at varied x positions
  $xs = @(12, 22, 32, 44, 54)
  foreach ($x in $xs) {
    Draw-Bolt $bmp $x 18 ($x + (Rng-Range -3 3)) 72 (Color-FromHex '#fff0a0') $ARCANE.high
    # Impact flash
    Blend-Pixel $bmp $x 72 (With-Alpha (Color-FromHex '#fff0a0') 200)
    Set-Pixel $bmp ($x - 1) 73 (With-Alpha (Color-FromHex '#fff0a0') 140)
    Set-Pixel $bmp ($x + 1) 73 (With-Alpha (Color-FromHex '#fff0a0') 140)
  }
}

function Draw-Card-Mend {
  # Healing hands with cross light
  param($bmp)
  Rng-Init 'r.mend'
  Draw-MagicCircle $bmp $CARD_CX 40 22 $HOLY.base 100 -Runes
  # Two cupped hands at bottom
  $skin = $SKIN_PALE
  Fill-Box $bmp ($CARD_CX - 12) 52 9 8 $skin.base
  Fill-Box $bmp ($CARD_CX + 3) 52 9 8 $skin.base
  # Knuckles
  for ($i = 0; $i -lt 3; $i++) {
    Set-Pixel $bmp ($CARD_CX - 10 + $i * 3) 52 $skin.high
    Set-Pixel $bmp ($CARD_CX + 5 + $i * 3) 52 $skin.high
  }
  Set-Pixel $bmp ($CARD_CX - 12) 60 $skin.shadow
  Set-Pixel $bmp ($CARD_CX + 11) 60 $skin.shadow
  # Light cross hovering between hands
  Draw-HealCross $bmp $CARD_CX 36 10 $HOLY
  # Sparkles
  foreach ($p in @(@(-8,24),@(7,22),@(0,18),@(-3,52),@(4,50))) {
    Set-Pixel $bmp ($CARD_CX + $p[0]) $p[1] $HOLY.top
  }
}

function Draw-Card-Resurrect {
  # Phoenix-style flame circle / ankh glow rising from ash
  param($bmp)
  Rng-Init 'r.resurrect'
  Draw-MagicCircle $bmp $CARD_CX 42 26 $FIRE.high 120 -Runes
  # Ash pile at bottom
  for ($x = ($CARD_CX - 10); $x -le ($CARD_CX + 10); $x++) {
    $y = 70 - [int]([Math]::Round([Math]::Sin(($x - $CARD_CX) * 0.4 + 2) * 2))
    Set-Pixel $bmp $x $y (Color-FromHex '#3a3028')
    Set-Pixel $bmp $x ($y + 1) (Color-FromHex '#2a2018')
    Set-Pixel $bmp $x ($y + 2) (Color-FromHex '#1a1410')
  }
  # Rising phoenix silhouette — diamond shape with wings
  # Body
  Draw-Flame $bmp $CARD_CX 64 22 $FIRE
  # Wings spread
  for ($i = 0; $i -lt 12; $i++) {
    $t = $i / 12.0
    $wx = [int]([Math]::Round(12 * $t))
    $wy = 50 - $i
    $col = if ($t -lt 0.4) { $FIRE.top } elseif ($t -lt 0.7) { $FIRE.high } else { $FIRE.base }
    Set-Pixel $bmp ($CARD_CX - $wx) $wy $col
    Set-Pixel $bmp ($CARD_CX + $wx) $wy $col
    Set-Pixel $bmp ($CARD_CX - $wx) ($wy + 1) $FIRE.shadow
    Set-Pixel $bmp ($CARD_CX + $wx) ($wy + 1) $FIRE.shadow
  }
  # Glowing head
  Shade-Disc $bmp $CARD_CX 30 4 (Build-Ramp '#fff0a0') -RimLight
  Set-Pixel $bmp $CARD_CX 27 (Color-FromHex '#fff8d8')
}

# Pass dispatcher dict — { cardId -> Draw function name }
$CARD_DRAW = @{
  'champ.warrior'    = 'Draw-Card-ChampWarrior'
  'champ.mage'       = 'Draw-Card-ChampMage'
  'champ.rogue'      = 'Draw-Card-ChampRogue'
  'champ.ranger'     = 'Draw-Card-ChampRanger'
  'champ.healer'     = 'Draw-Card-ChampHealer'
  'leg.solara'       = 'Draw-Card-LegSolara'
  'leg.korrik'       = 'Draw-Card-LegKorrik'
  'leg.mireth'       = 'Draw-Card-LegMireth'
  'leg.thalor'       = 'Draw-Card-LegThalor'
  'leg.nyx'          = 'Draw-Card-LegNyx'
  'leg.bonetyrant'   = 'Draw-Card-LegBoneTyrant'
  'leg.voltaicwyrm'  = 'Draw-Card-LegVoltaicWyrm'
  'leg.vaultlich'    = 'Draw-Card-LegVaultLich'
  'leg.warchief'     = 'Draw-Card-LegWarchief'
  'leg.hollowking'   = 'Draw-Card-LegHollowKing'
  'r.voltaicmage'    = 'Draw-Card-VoltaicMage'
  'r.sapper'         = 'Draw-Card-Sapper'
  'r.boltknight'     = 'Draw-Card-BoltKnight'
  'r.healercleric'   = 'Draw-Card-HealerCleric'
  'r.archertwin'     = 'Draw-Card-ArcherTwin'
  'r.boltengineer'   = 'Draw-Card-BoltEngineer'
  'r.vaultsniffer'   = 'Draw-Card-VaultSniffer'
  'r.forgebrand'     = 'Draw-Card-ForgeBrand'
  'r.gobpowder'      = 'Draw-Card-GobPowder'
  'r.voltaicsurge'   = 'Draw-Card-VoltaicSurge'
  'r.vaultseal'      = 'Draw-Card-VaultSeal'
  'r.boltstorm'      = 'Draw-Card-BoltStorm'
  'r.mend'           = 'Draw-Card-Mend'
  'r.resurrect'      = 'Draw-Card-Resurrect'
}

# Card metadata — drives rarity glow + pass filtering. Mirrors
# cards-content.js but tracked locally so we don't need to parse JS.
# Updated as each pass adds cards.
$CARD_META = @{
  'champ.warrior'   = @{ rarity = 'champion';  pass = 'champions' }
  'champ.mage'      = @{ rarity = 'champion';  pass = 'champions' }
  'champ.rogue'     = @{ rarity = 'champion';  pass = 'champions' }
  'champ.ranger'    = @{ rarity = 'champion';  pass = 'champions' }
  'champ.healer'    = @{ rarity = 'champion';  pass = 'champions' }
  'leg.solara'      = @{ rarity = 'legendary'; pass = 'legendaries' }
  'leg.korrik'      = @{ rarity = 'legendary'; pass = 'legendaries' }
  'leg.mireth'      = @{ rarity = 'legendary'; pass = 'legendaries' }
  'leg.thalor'      = @{ rarity = 'legendary'; pass = 'legendaries' }
  'leg.nyx'         = @{ rarity = 'legendary'; pass = 'legendaries' }
  'leg.bonetyrant'  = @{ rarity = 'legendary'; pass = 'legendaries' }
  'leg.voltaicwyrm' = @{ rarity = 'legendary'; pass = 'legendaries' }
  'leg.vaultlich'   = @{ rarity = 'legendary'; pass = 'legendaries' }
  'leg.warchief'    = @{ rarity = 'legendary'; pass = 'legendaries' }
  'leg.hollowking'  = @{ rarity = 'legendary'; pass = 'legendaries' }
  'r.voltaicmage'   = @{ rarity = 'rare';      pass = 'rares' }
  'r.sapper'        = @{ rarity = 'rare';      pass = 'rares' }
  'r.boltknight'    = @{ rarity = 'rare';      pass = 'rares' }
  'r.healercleric'  = @{ rarity = 'rare';      pass = 'rares' }
  'r.archertwin'    = @{ rarity = 'rare';      pass = 'rares' }
  'r.boltengineer'  = @{ rarity = 'rare';      pass = 'rares' }
  'r.vaultsniffer'  = @{ rarity = 'rare';      pass = 'rares' }
  'r.forgebrand'    = @{ rarity = 'rare';      pass = 'rares' }
  'r.gobpowder'     = @{ rarity = 'rare';      pass = 'rares' }
  'r.voltaicsurge'  = @{ rarity = 'rare';      pass = 'rares' }
  'r.vaultseal'     = @{ rarity = 'rare';      pass = 'rares' }
  'r.boltstorm'     = @{ rarity = 'rare';      pass = 'rares' }
  'r.mend'          = @{ rarity = 'rare';      pass = 'rares' }
  'r.resurrect'     = @{ rarity = 'rare';      pass = 'rares' }
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
