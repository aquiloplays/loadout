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
  [string]$Only    = '',    # comma list: champions,legendaries,rares,uncommons,commons,tokens (legacy)
  [string]$Manifest = '',   # path to tools/.card-manifest.json — defaults to alongside this script
  [string]$IdsFile  = '',   # optional file with one card id per line; restricts the run
  [int]$Skip = 0,           # skip first N cards (paging for resumable runs)
  [int]$Take = 0            # render only N cards (paging); 0 = all
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

# ── Uncommons (20) ───────────────────────────────────────────────

function Draw-Card-Scrapper {
  param($bmp)
  Rng-Init 'u.scrapper'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $a = Draw-Humanoid $bmp $SKIN_GREEN $MAT_LEATHER -torsoW 14 -torsoH 18 -legH 12 -reach 18
  # Rusty knife held forward
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 2) ($a.handY + 6) 2 $MAT_IRON
  Set-Pixel $bmp ($a.handRx + 2) ($a.handY - 2) $MAT_IRON.top
  # Wild hair tufts
  Fill-Box $bmp ($CARD_CX - 5) ($a.headTop - 1) 11 1 $MAT_LEATHER.deep
  Set-Pixel $bmp ($CARD_CX - 4) ($a.headTop - 2) $MAT_LEATHER.deep
  Set-Pixel $bmp ($CARD_CX + 4) ($a.headTop - 2) $MAT_LEATHER.deep
  # Yellow goblin eyes
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#fff080')
}

function Draw-Card-ShieldGuard {
  param($bmp)
  Rng-Init 'u.shieldguard'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $a = Draw-Humanoid $bmp $SKIN_FAIR $MAT_IRON -torsoW 16 -accent $BRAND.Gold
  # Pot helm
  Fill-Box $bmp ($CARD_CX - 6) ($a.headY - 5) 12 7 $MAT_IRON.shadow
  Set-Pixel $bmp ($CARD_CX - 6) ($a.headY - 5) $MAT_IRON.high
  # Visor slit
  Fill-Box $bmp ($CARD_CX - 4) ($a.headY) 9 1 (Color-FromHex '#040408')
  # Tower shield
  Stroke-Box $bmp ($a.handLx - 4) ($a.handY - 12) 8 18 $MAT_IRON.deep $MAT_STEEL.base
  Fill-Box $bmp ($a.handLx - 3) ($a.handY - 11) 1 16 $MAT_STEEL.high
  Set-Pixel $bmp ($a.handLx - 1) ($a.handY - 4) $BRAND.Gold
  Set-Pixel $bmp $a.handLx ($a.handY - 4) $BRAND.Gold
}

function Draw-Card-GlassCat {
  param($bmp)
  Rng-Init 'u.glasscat'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $crystal = @{
    deep   = (Color-FromHex '#3a5060');
    shadow = (Color-FromHex '#6a8aa0');
    base   = (Color-FromHex '#a8c8d8');
    high   = (Color-FromHex '#d8eaf0');
    top    = (Color-FromHex '#ffffff');
  }
  # Crouched cat body
  Shade-Oval $bmp $CARD_CX 60 14 6 $crystal
  # Head
  Shade-Disc $bmp ($CARD_CX + 11) 52 5 $crystal
  # Pointed ears
  Set-Pixel $bmp ($CARD_CX + 8) 47 $crystal.high
  Set-Pixel $bmp ($CARD_CX + 9) 46 $crystal.base
  Set-Pixel $bmp ($CARD_CX + 14) 47 $crystal.high
  Set-Pixel $bmp ($CARD_CX + 15) 46 $crystal.base
  # Glowing eyes
  Set-Pixel $bmp ($CARD_CX + 9) 52 (Color-FromHex '#7c5cff')
  Set-Pixel $bmp ($CARD_CX + 13) 52 (Color-FromHex '#7c5cff')
  # Legs (4 short prisms)
  for ($i = 0; $i -lt 4; $i++) {
    $lx = $CARD_CX - 10 + $i * 7
    Fill-Box $bmp $lx 64 3 8 $crystal.shadow
    Set-Pixel $bmp $lx 64 $crystal.high
  }
  # Crystalline tail
  Line-Pixel $bmp ($CARD_CX - 13) 58 ($CARD_CX - 20) 44 $crystal.high
  Line-Pixel $bmp ($CARD_CX - 14) 58 ($CARD_CX - 21) 44 $crystal.base
  # Refraction sparkle
  Set-Pixel $bmp ($CARD_CX + 4) 54 $crystal.top
  Set-Pixel $bmp ($CARD_CX - 4) 60 $crystal.top
}

function Draw-Card-HoneyBadger {
  param($bmp)
  Rng-Init 'u.honeybadger'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $body = @{
    deep   = (Color-FromHex '#0a0a0a');
    shadow = (Color-FromHex '#1c1c1c');
    base   = (Color-FromHex '#2a2a2a');
    high   = (Color-FromHex '#4a4a4a');
    top    = (Color-FromHex '#6a6a6a');
  }
  Shade-Oval $bmp $CARD_CX 62 17 7 $body
  # White stripe along back
  Fill-Box $bmp ($CARD_CX - 12) 56 24 3 (Color-FromHex '#f0f0e0')
  for ($x = ($CARD_CX - 12); $x -le ($CARD_CX + 11); $x++) {
    Set-Pixel $bmp $x 56 (Color-FromHex '#fff8e8')
  }
  # Head
  Shade-Disc $bmp ($CARD_CX + 13) 56 5 $body
  Fill-Box $bmp ($CARD_CX + 11) 55 5 2 (Color-FromHex '#f0f0e0')   # white face stripe
  # Eyes — angry
  Set-Pixel $bmp ($CARD_CX + 12) 57 $BRAND.Crimson
  Set-Pixel $bmp ($CARD_CX + 14) 57 $BRAND.Crimson
  # Sharp teeth bared
  Set-Pixel $bmp ($CARD_CX + 16) 59 (Color-FromHex '#f0f0e0')
  Set-Pixel $bmp ($CARD_CX + 17) 59 (Color-FromHex '#f0f0e0')
  # Poison drip — green
  Set-Pixel $bmp ($CARD_CX + 16) 61 $NATURE.high
  Set-Pixel $bmp ($CARD_CX + 17) 62 $NATURE.base
  # Legs
  for ($i = 0; $i -lt 4; $i++) {
    $lx = $CARD_CX - 10 + $i * 7
    Fill-Box $bmp $lx 67 3 6 $body.shadow
  }
  # Tail
  Line-Pixel $bmp ($CARD_CX - 14) 62 ($CARD_CX - 19) 56 $body.shadow
}

function Draw-Card-SpittingRat {
  param($bmp)
  Rng-Init 'u.spittingrat'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $body = @{
    deep   = (Color-FromHex '#2a2010');
    shadow = (Color-FromHex '#4a3818');
    base   = (Color-FromHex '#6a5028');
    high   = (Color-FromHex '#967040');
    top    = (Color-FromHex '#b89058');
  }
  Shade-Oval $bmp $CARD_CX 64 14 6 $body
  Shade-Disc $bmp ($CARD_CX + 11) 58 5 $body
  # Ears — round
  Shade-Disc $bmp ($CARD_CX + 8) 53 2 $body
  Shade-Disc $bmp ($CARD_CX + 13) 53 2 $body
  # Eye
  Set-Pixel $bmp ($CARD_CX + 12) 58 (Color-FromHex '#040408')
  # Snout + spit
  Fill-Box $bmp ($CARD_CX + 15) 59 3 2 $body.shadow
  Set-Pixel $bmp ($CARD_CX + 18) 59 $NATURE.high
  Set-Pixel $bmp ($CARD_CX + 19) 58 $NATURE.base
  Set-Pixel $bmp ($CARD_CX + 20) 57 $NATURE.shadow
  # Legs
  for ($i = 0; $i -lt 4; $i++) {
    $lx = $CARD_CX - 8 + $i * 6
    Fill-Box $bmp $lx 69 2 5 $body.shadow
  }
  # Tail — long thin
  for ($i = 0; $i -lt 10; $i++) {
    $tx = $CARD_CX - 12 - $i
    $ty = 62 + [int]([Math]::Round([Math]::Sin($i * 0.5) * 3))
    Set-Pixel $bmp $tx $ty $body.shadow
  }
}

function Draw-Card-RuneSinger {
  param($bmp)
  Rng-Init 'u.runesinger'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $cloth = @{
    deep   = (Color-FromHex '#1a3a18');
    shadow = (Color-FromHex '#3a6a30');
    base   = (Color-FromHex '#5a9a48');
    high   = (Color-FromHex '#86c068');
    top    = (Color-FromHex '#b4e088');
  }
  $a = Draw-Humanoid $bmp $SKIN_FAIR $cloth -accent $MAT_GOLD.base
  # Bard cap with feather
  Fill-Box $bmp ($CARD_CX - 5) ($a.headTop - 2) 11 3 $cloth.deep
  Set-Pixel $bmp ($CARD_CX - 5) ($a.headTop - 2) $cloth.high
  for ($i = 0; $i -lt 4; $i++) {
    Set-Pixel $bmp ($CARD_CX + 5 + $i) ($a.headTop - 3 - $i) $BRAND.Crimson
  }
  # Lute body in front of torso
  Shade-Oval $bmp ($CARD_CX + 2) ($a.torsoY + 12) 8 6 $MAT_WOOD_LIGHT
  # Lute neck up to left
  Draw-Shaft $bmp ($CARD_CX - 4) ($a.headTop + 4) ($a.torsoY + 12) 2 $MAT_WOOD_DARK
  # Strings
  for ($i = 0; $i -lt 3; $i++) {
    Line-Pixel $bmp ($CARD_CX - 4) ($a.headTop + 6 + $i) ($CARD_CX + 5) ($a.torsoY + 12 + $i - 1) (Color-FromHex '#e8d090')
  }
  # Rune glow on lute
  Set-Pixel $bmp ($CARD_CX + 2) ($a.torsoY + 11) (Color-FromHex '#fff0a0')
  Set-Pixel $bmp ($CARD_CX + 2) ($a.torsoY + 13) (Color-FromHex '#fff0a0')
}

function Draw-Card-StoutWarden {
  param($bmp)
  Rng-Init 'u.stoutwarden'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $a = Draw-Humanoid $bmp $SKIN_TAN $MAT_IRON -torsoW 22 -torsoH 24 -reach 26
  # Heavy domed helm
  Fill-Box $bmp ($CARD_CX - 7) ($a.headY - 6) 14 8 $MAT_IRON.shadow
  Set-Pixel $bmp ($CARD_CX - 7) ($a.headY - 6) $MAT_IRON.high
  Set-Pixel $bmp ($CARD_CX + 6) ($a.headY - 6) $MAT_IRON.high
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY) 11 2 (Color-FromHex '#040408')
  # Beard sticking out
  Fill-Box $bmp ($CARD_CX - 3) ($a.headY + 3) 7 3 (Color-FromHex '#8a5a30')
  # Hammer in right
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 10) ($a.handY + 4) 2 $MAT_WOOD_DARK
  Fill-Box $bmp ($a.handRx) ($a.handY - 13) 5 4 $MAT_IRON.base
  Set-Pixel $bmp ($a.handRx) ($a.handY - 13) $MAT_IRON.high
  # Small shield on left
  Shade-Disc $bmp ($a.handLx - 1) ($a.handY) 5 $MAT_IRON -RimLight
  Set-Pixel $bmp ($a.handLx - 1) $a.handY $MAT_GOLD.top
}

function Draw-Card-ScoutArcher {
  param($bmp)
  Rng-Init 'u.scoutarcher'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $green = @{
    deep   = (Color-FromHex '#0c2a18');
    shadow = (Color-FromHex '#1c4a28');
    base   = (Color-FromHex '#347040');
    high   = (Color-FromHex '#5e9460');
    top    = (Color-FromHex '#9cc888');
  }
  $a = Draw-Humanoid $bmp $SKIN_FAIR $MAT_LEATHER -accent $green.base
  # Hood
  for ($i = 0; $i -lt 3; $i++) {
    $w = 12 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 1 + $i) $w 1 $green.shadow
  }
  # Bow drawn
  for ($y = ($a.handY - 12); $y -le ($a.handY + 6); $y++) {
    $bx = ($a.handLx - 1) + [int]([Math]::Round(2 * [Math]::Sin(($y - $a.handY) * 0.16)))
    Set-Pixel $bmp $bx $y $MAT_WOOD_DARK.base
  }
  for ($y = ($a.handY - 12); $y -le ($a.handY + 6); $y++) {
    Set-Pixel $bmp ($a.handLx + 1) $y (Color-FromHex '#d8d0b8')
  }
  # Arrow nocked toward upper-right (reach)
  Line-Pixel $bmp ($a.handLx + 2) ($a.handY - 3) ($a.handRx + 6) ($a.handY - 8) $MAT_WOOD_LIGHT.base
  Set-Pixel $bmp ($a.handRx + 7) ($a.handY - 9) $MAT_STEEL.top
  Set-Pixel $bmp ($a.handRx + 7) ($a.handY - 10) $MAT_STEEL.high
}

function Draw-Card-Bloodhound {
  param($bmp)
  Rng-Init 'u.bloodhound'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 16
  $fur = @{
    deep   = (Color-FromHex '#3a0c08');
    shadow = (Color-FromHex '#6a1c14');
    base   = (Color-FromHex '#a83828');
    high   = (Color-FromHex '#d8583c');
    top    = (Color-FromHex '#f88058');
  }
  # Big body
  Shade-Oval $bmp $CARD_CX 60 20 9 $fur
  # Head
  Shade-Disc $bmp ($CARD_CX + 14) 50 7 $fur
  # Snout
  Fill-Box $bmp ($CARD_CX + 19) 52 5 3 $fur.shadow
  Set-Pixel $bmp ($CARD_CX + 23) 52 (Color-FromHex '#040404')
  # Eyes red
  Set-Pixel $bmp ($CARD_CX + 13) 50 (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX + 16) 50 (Color-FromHex '#fff080')
  # Floppy ears
  Fill-Box $bmp ($CARD_CX + 9) 52 4 8 $fur.shadow
  Fill-Box $bmp ($CARD_CX + 17) 52 4 8 $fur.shadow
  # Fangs dripping
  Set-Pixel $bmp ($CARD_CX + 21) 54 (Color-FromHex '#f0f0d8')
  Set-Pixel $bmp ($CARD_CX + 22) 54 (Color-FromHex '#f0f0d8')
  Set-Pixel $bmp ($CARD_CX + 21) 55 $BRAND.Crimson
  # Legs
  for ($i = 0; $i -lt 4; $i++) {
    $lx = $CARD_CX - 12 + $i * 8
    Fill-Box $bmp $lx 66 4 7 $fur.shadow
  }
  # Tail
  Line-Pixel $bmp ($CARD_CX - 16) 56 ($CARD_CX - 22) 48 $fur.base
}

function Draw-Card-DaggerThief {
  param($bmp)
  Rng-Init 'u.daggerthief'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  # Half-transparent body for stealth feel
  $a = Draw-Humanoid $bmp $SKIN_TAN $SHADOW -accent $BRAND.Crimson
  # Deep hood
  for ($i = 0; $i -lt 5; $i++) {
    $w = 13 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 2 + $i) $w 1 $SHADOW.deep
  }
  # Face shadowed except eyes
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY - 1) 11 4 (Color-FromHex '#08080c')
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY $BRAND.Crimson
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY $BRAND.Crimson
  # Dagger
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 2) ($a.handY + 7) 2 $MAT_STEEL
  # Smoke wisps (stealth)
  foreach ($p in @(@(-8,52),@(8,54),@(-4,72),@(6,72))) {
    Blend-Pixel $bmp ($CARD_CX + $p[0]) $p[1] (With-Alpha $SHADOW.high 120)
  }
}

function Draw-Card-WarPriest {
  param($bmp)
  Rng-Init 'u.warpriest'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $robe = @{
    deep   = (Color-FromHex '#3a1a08');
    shadow = (Color-FromHex '#6a3018');
    base   = (Color-FromHex '#a85028');
    high   = (Color-FromHex '#d8783c');
    top    = (Color-FromHex '#f4a868');
  }
  $a = Draw-Humanoid $bmp $SKIN_PALE $robe -accent $MAT_GOLD.base
  # Pot helm with gold trim
  Fill-Box $bmp ($CARD_CX - 6) ($a.headY - 6) 12 5 $MAT_IRON.shadow
  Fill-Box $bmp ($CARD_CX - 6) ($a.headY - 6) 12 1 $MAT_GOLD.base
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY - 1) 11 2 (Color-FromHex '#040408')
  # Holy cross emblem on helm
  Set-Pixel $bmp $CARD_CX ($a.headY - 4) $MAT_GOLD.top
  Set-Pixel $bmp $CARD_CX ($a.headY - 3) $MAT_GOLD.top
  Set-Pixel $bmp ($CARD_CX - 1) ($a.headY - 3) $MAT_GOLD.top
  Set-Pixel $bmp ($CARD_CX + 1) ($a.headY - 3) $MAT_GOLD.top
  # Flanged mace
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 12) ($a.handY + 4) 2 $MAT_WOOD_LIGHT
  Shade-Disc $bmp ($a.handRx + 2) ($a.handY - 14) 4 $MAT_IRON -RimLight
  for ($i = 0; $i -lt 4; $i++) {
    $ang = $i * [Math]::PI / 2 + 0.4
    $rx = ($a.handRx + 2) + [int]([Math]::Round([Math]::Cos($ang) * 4))
    $ry = ($a.handY - 14) + [int]([Math]::Round([Math]::Sin($ang) * 4))
    Set-Pixel $bmp $rx $ry $MAT_IRON.high
  }
}

function Draw-Card-TankKnight {
  param($bmp)
  Rng-Init 'u.tankknight'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 16
  $a = Draw-Humanoid $bmp $SKIN_FAIR $MAT_STEEL -torsoW 24 -torsoH 26 -reach 28
  # Heavy closed helm
  Fill-Box $bmp ($CARD_CX - 8) ($a.headY - 7) 16 10 $MAT_STEEL.shadow
  for ($x = ($CARD_CX - 8); $x -le ($CARD_CX + 7); $x++) {
    Set-Pixel $bmp $x ($a.headY - 7) $MAT_STEEL.high
  }
  Fill-Box $bmp ($CARD_CX - 6) ($a.headY) 13 2 (Color-FromHex '#040408')
  # Cross-slit
  Fill-Box $bmp $CARD_CX ($a.headY - 4) 1 6 (Color-FromHex '#040408')
  # Tower shield in front
  Stroke-Box $bmp ($CARD_CX - 14) ($a.handY - 14) 10 22 $MAT_STEEL.deep $MAT_STEEL.base
  for ($y = ($a.handY - 13); $y -lt ($a.handY + 8); $y++) {
    Set-Pixel $bmp ($CARD_CX - 13) $y $MAT_STEEL.high
  }
  # Shield emblem — lion silhouette block
  Fill-Box $bmp ($CARD_CX - 11) ($a.handY - 8) 4 8 $MAT_GOLD.base
  Set-Pixel $bmp ($CARD_CX - 9) ($a.handY - 9) $MAT_GOLD.top
  # Shield aura (shield keyword)
  Add-GlowHalo $bmp (Color-FromHex '#a8c8ff') 1 80
}

function Draw-Card-CopperGolem {
  param($bmp)
  Rng-Init 'u.coppergolem'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $a = Draw-Humanoid $bmp $MAT_COPPER $MAT_COPPER -torsoW 22 -torsoH 22 -reach 24 -accent $MAT_GOLD.base
  # Plated boxy head
  Fill-Box $bmp ($CARD_CX - 6) ($a.headY - 5) 12 10 $MAT_COPPER.base
  Stroke-Box $bmp ($CARD_CX - 6) ($a.headY - 5) 12 10 $MAT_COPPER.deep
  Set-Pixel $bmp ($CARD_CX - 5) ($a.headY - 4) $MAT_COPPER.high
  Set-Pixel $bmp ($CARD_CX + 4) ($a.headY + 3) $MAT_COPPER.shadow
  # Glowing slit eyes
  Fill-Box $bmp ($CARD_CX - 3) $a.headY 2 1 $FIRE.top
  Fill-Box $bmp ($CARD_CX + 2) $a.headY 2 1 $FIRE.top
  # Rivets
  Draw-Rivet $bmp ($CARD_CX - 8) ($a.torsoY + 4) $MAT_COPPER
  Draw-Rivet $bmp ($CARD_CX + 8) ($a.torsoY + 4) $MAT_COPPER
  Draw-Rivet $bmp ($CARD_CX - 8) ($a.torsoY + 16) $MAT_COPPER
  Draw-Rivet $bmp ($CARD_CX + 8) ($a.torsoY + 16) $MAT_COPPER
  # Glowing core
  Shade-Disc $bmp $CARD_CX ($a.torsoY + 10) 3 (Build-Ramp '#ff8030')
}

function Draw-Card-IronVanguard {
  param($bmp)
  Rng-Init 'u.ironvanguard'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $a = Draw-Humanoid $bmp $SKIN_FAIR $MAT_IRON -torsoW 22 -torsoH 24 -reach 26
  # Sallet helm w/ visor
  Fill-Box $bmp ($CARD_CX - 7) ($a.headY - 5) 14 8 $MAT_IRON.shadow
  for ($x = ($CARD_CX - 7); $x -le ($CARD_CX + 6); $x++) {
    Set-Pixel $bmp $x ($a.headY - 5) $MAT_IRON.high
  }
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY) 11 1 (Color-FromHex '#040408')
  # Halberd in right hand
  Draw-Shaft $bmp ($a.handRx + 2) ($a.headY - 12) ($a.handY + 8) 2 $MAT_WOOD_DARK
  # Axe head
  Fill-Box $bmp ($a.handRx) ($a.headY - 14) 7 5 $MAT_IRON.base
  Set-Pixel $bmp ($a.handRx) ($a.headY - 14) $MAT_IRON.high
  # Spike
  Set-Pixel $bmp ($a.handRx + 2) ($a.headY - 16) $MAT_IRON.top
  Set-Pixel $bmp ($a.handRx + 2) ($a.headY - 17) $MAT_IRON.high
  # Round shield small
  Shade-Disc $bmp ($a.handLx - 1) ($a.handY) 5 $MAT_STEEL -RimLight
}

function Draw-Card-BoltCarrier {
  param($bmp)
  Rng-Init 'u.boltcarrier'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $coat = @{
    deep   = (Color-FromHex '#1a1828');
    shadow = (Color-FromHex '#2c2c44');
    base   = (Color-FromHex '#4a4a66');
    high   = (Color-FromHex '#7c7e9a');
    top    = (Color-FromHex '#a8aac4');
  }
  $a = Draw-Humanoid $bmp $SKIN_TAN $coat -accent $ARCANE.base
  # Hood
  for ($i = 0; $i -lt 3; $i++) {
    $w = 12 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 1 + $i) $w 1 $coat.deep
  }
  # Backpack with bolt runes — wider than torso
  Fill-Box $bmp ($CARD_CX - 12) ($a.torsoY + 2) 4 18 $coat.shadow
  Fill-Box $bmp ($CARD_CX + 8) ($a.torsoY + 2) 4 18 $coat.shadow
  for ($i = 0; $i -lt 3; $i++) {
    Set-Pixel $bmp ($CARD_CX - 10) ($a.torsoY + 5 + $i * 5) $ARCANE.top
    Set-Pixel $bmp ($CARD_CX + 10) ($a.torsoY + 5 + $i * 5) $ARCANE.top
  }
}

# ── Uncommon spells (5) ──────────────────────────────────────────

function Draw-Card-BoltBolt {
  param($bmp)
  Rng-Init 'u.boltbolt'
  Draw-MagicCircle $bmp $CARD_CX 40 22 $ARCANE.base 100 -Runes
  Draw-Bolt $bmp ($CARD_CX - 8) 14 ($CARD_CX + 8) 66 (Color-FromHex '#fff0a0') $ARCANE.high
  # Thicker centre
  Line-Pixel $bmp ($CARD_CX - 7) 16 ($CARD_CX + 7) 64 (Color-FromHex '#fff8d8')
  # Centre spark
  Shade-Disc $bmp $CARD_CX 40 3 (Build-Ramp '#fff8d8')
}

function Draw-Card-SmallHeal {
  param($bmp)
  Rng-Init 'u.smallheal'
  Draw-MagicCircle $bmp $CARD_CX 40 20 $HOLY.base 100 -Runes
  Draw-HealCross $bmp $CARD_CX 40 14 $HOLY
  # Sparkles around
  foreach ($p in @(@(-12,26),@(11,26),@(0,18),@(-9,52),@(8,52))) {
    Set-Pixel $bmp ($CARD_CX + $p[0]) $p[1] $HOLY.top
  }
}

function Draw-Card-SmallBuff {
  # Smithing Touch — anvil with golden glow + hammer
  param($bmp)
  Rng-Init 'u.smallbuff'
  Draw-MagicCircle $bmp $CARD_CX 42 22 $MAT_GOLD.base 100 -Runes
  # Anvil block
  Stroke-Box $bmp ($CARD_CX - 10) 52 20 6 $MAT_IRON.deep $MAT_IRON.base
  Fill-Box $bmp ($CARD_CX - 10) 52 20 1 $MAT_IRON.high
  Fill-Box $bmp ($CARD_CX - 13) 53 3 3 $MAT_IRON.shadow   # horn
  # Glow rising from anvil
  for ($y = 50; $y -ge 28; $y--) {
    $w = [int](6 - ($y - 28) * 0.18)
    if ($w -lt 1) { continue }
    for ($dx = -$w; $dx -le $w; $dx++) {
      $a2 = 110 - [Math]::Abs($dx) * 14
      if ($a2 -gt 0) { Blend-Pixel $bmp ($CARD_CX + $dx) $y (With-Alpha $MAT_GOLD.top $a2) }
    }
  }
  # +1/+1 mark — small cross icon at top
  Draw-HealCross $bmp $CARD_CX 28 8 $MAT_GOLD
}

function Draw-Card-FireBolt {
  param($bmp)
  Rng-Init 'u.firebolt'
  Draw-MagicCircle $bmp $CARD_CX 42 22 $FIRE.base 110 -Runes
  # Flame bolt — vertical flame arc with rocket tail
  Draw-Flame $bmp $CARD_CX 64 30 $FIRE
  # Bolt head + trail
  Shade-Disc $bmp $CARD_CX 28 4 (Build-Ramp '#fff8d8')
  Set-Pixel $bmp ($CARD_CX - 1) 26 (Color-FromHex '#fff8d8')
  Set-Pixel $bmp $CARD_CX 24 (Color-FromHex '#fff8d8')
}

function Draw-Card-CardDraw2 {
  param($bmp)
  Rng-Init 'u.cardraw2'
  Draw-MagicCircle $bmp $CARD_CX 40 22 $ARCANE.base 100 -Runes
  # Two cards fanned
  $c1x = $CARD_CX - 7
  $c2x = $CARD_CX + 7
  Stroke-Box $bmp ($c1x - 7) 32 13 22 $MAT_WOOD_DARK.deep (Color-FromHex '#f0e0a0')
  Stroke-Box $bmp ($c2x - 6) 30 13 22 $MAT_WOOD_DARK.deep (Color-FromHex '#f0e0a0')
  # Card faces — runes
  Fill-Box $bmp ($c1x - 5) 36 8 3 $ARCANE.shadow
  Fill-Box $bmp ($c2x - 4) 34 8 3 $ARCANE.shadow
  Set-Pixel $bmp ($c1x - 1) 44 $ARCANE.top
  Set-Pixel $bmp ($c2x) 42 $ARCANE.top
  # Sparkles
  foreach ($p in @(@(-12,22),@(11,22),@(0,18))) {
    Set-Pixel $bmp ($CARD_CX + $p[0]) $p[1] $ARCANE.top
  }
}

# ── Commons — minions (20) ───────────────────────────────────────

function Draw-Card-Acolyte {
  param($bmp)
  Rng-Init 'c.acolyte'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $robe = $MAT_CLOTH_LINEN
  $a = Draw-Humanoid $bmp $SKIN_PALE $robe -torsoW 14 -torsoH 20 -reach 18
  # Hood
  for ($i = 0; $i -lt 3; $i++) {
    $w = 12 - $i; $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 1 + $i) $w 1 $robe.shadow
  }
  Set-Pixel $bmp $CARD_CX ($a.torsoY + 8) $MAT_GOLD.top
  # Small candle in hand
  Fill-Box $bmp ($a.handRx + 1) ($a.handY - 4) 2 4 (Color-FromHex '#e8d090')
  Set-Pixel $bmp ($a.handRx + 1) ($a.handY - 6) $FIRE.top
  Set-Pixel $bmp ($a.handRx + 2) ($a.handY - 7) $FIRE.high
}

function Draw-Card-GobRunt {
  param($bmp)
  Rng-Init 'c.gobrunt'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $a = Draw-Humanoid $bmp $SKIN_GREEN $MAT_LEATHER -torsoW 12 -torsoH 16 -legH 10 -reach 16
  # Pointy ears
  Set-Pixel $bmp ($CARD_CX - 7) ($a.headY - 1) $SKIN_GREEN.high
  Set-Pixel $bmp ($CARD_CX - 8) ($a.headY) $SKIN_GREEN.base
  Set-Pixel $bmp ($CARD_CX + 6) ($a.headY - 1) $SKIN_GREEN.high
  Set-Pixel $bmp ($CARD_CX + 7) ($a.headY) $SKIN_GREEN.base
  # Yellow eyes
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#fff080')
  # Small club
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 6) ($a.handY + 4) 2 $MAT_WOOD_DARK
  Shade-Disc $bmp ($a.handRx + 2) ($a.handY - 8) 3 $MAT_WOOD_DARK
}

function Draw-Card-IronGuard {
  param($bmp)
  Rng-Init 'c.ironguard'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $a = Draw-Humanoid $bmp $SKIN_FAIR $MAT_IRON -accent $BRAND.Crimson
  # Open helm
  Fill-Box $bmp ($CARD_CX - 6) ($a.headY - 5) 12 5 $MAT_IRON.shadow
  Set-Pixel $bmp ($CARD_CX - 6) ($a.headY - 5) $MAT_IRON.high
  Set-Pixel $bmp ($CARD_CX + 5) ($a.headY - 5) $MAT_IRON.high
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY) 11 1 (Color-FromHex '#040408')
  # Spear in right
  Draw-Shaft $bmp ($a.handRx + 2) ($a.headY - 16) ($a.handY + 6) 2 $MAT_WOOD_DARK
  Set-Pixel $bmp ($a.handRx + 2) ($a.headY - 17) $MAT_STEEL.top
  Set-Pixel $bmp ($a.handRx + 1) ($a.headY - 16) $MAT_STEEL.high
  Set-Pixel $bmp ($a.handRx + 3) ($a.headY - 16) $MAT_STEEL.high
}

function Draw-Card-Imp {
  param($bmp)
  Rng-Init 'c.imp'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $skin = @{
    deep   = (Color-FromHex '#3a0a08');
    shadow = (Color-FromHex '#6a181c');
    base   = (Color-FromHex '#a83028');
    high   = (Color-FromHex '#d8584c');
    top    = (Color-FromHex '#f0806c');
  }
  $a = Draw-Humanoid $bmp $skin $MAT_LEATHER -torsoW 12 -torsoH 16 -legH 10 -reach 14
  # Horns
  for ($i = 0; $i -lt 3; $i++) {
    Set-Pixel $bmp ($CARD_CX - 4 + $i) ($a.headTop - $i) $MAT_OBSIDIAN.high
    Set-Pixel $bmp ($CARD_CX + 3 - $i) ($a.headTop - $i) $MAT_OBSIDIAN.high
  }
  # Wings
  Fill-Box $bmp ($CARD_CX - 12) ($a.torsoY + 2) 3 8 (Color-FromHex '#2a0606')
  Fill-Box $bmp ($CARD_CX + 9) ($a.torsoY + 2) 3 8 (Color-FromHex '#2a0606')
  Set-Pixel $bmp ($CARD_CX - 12) ($a.torsoY + 1) $skin.shadow
  Set-Pixel $bmp ($CARD_CX + 11) ($a.torsoY + 1) $skin.shadow
  # Yellow eyes
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#fff080')
  # Tail
  Line-Pixel $bmp ($CARD_CX - 6) ($a.legY + 8) ($CARD_CX - 12) ($a.legY + 14) $skin.shadow
}

function Draw-Card-Skeleton {
  param($bmp)
  Rng-Init 'c.skeleton'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $a = Draw-Humanoid $bmp $SKIN_BONE $MAT_CLOTH_WOOL -torsoW 12 -torsoH 18
  # Skull face
  Fill-Box $bmp ($CARD_CX - 3) ($a.headY - 1) 3 3 (Color-FromHex '#040408')
  Fill-Box $bmp ($CARD_CX + 1) ($a.headY - 1) 3 3 (Color-FromHex '#040408')
  # Toothy jaw
  for ($i = 0; $i -lt 5; $i++) {
    Set-Pixel $bmp ($CARD_CX - 2 + $i) ($a.headY + 3) $SKIN_BONE.deep
  }
  # Ribs through cloth
  for ($i = 0; $i -lt 3; $i++) {
    Fill-Box $bmp ($CARD_CX - 4) ($a.torsoY + 4 + $i * 4) 9 1 $SKIN_BONE.shadow
  }
  # Rusty sword
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 10) ($a.handY + 4) 2 $MAT_IRON
}

function Draw-Card-Lookout {
  param($bmp)
  Rng-Init 'c.lookout'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $a = Draw-Humanoid $bmp $SKIN_FAIR $MAT_LEATHER -torsoW 14 -torsoH 20
  # Wide-brimmed hat
  Fill-Box $bmp ($CARD_CX - 8) ($a.headTop - 1) 17 1 $MAT_LEATHER.deep
  Fill-Box $bmp ($CARD_CX - 5) ($a.headTop - 3) 11 2 $MAT_LEATHER.shadow
  Set-Pixel $bmp ($CARD_CX - 5) ($a.headTop - 3) $MAT_LEATHER.high
  # Telescope eye
  Fill-Box $bmp ($CARD_CX + 4) ($a.headY - 1) 5 3 $MAT_IRON.shadow
  Set-Pixel $bmp ($CARD_CX + 8) $a.headY (Color-FromHex '#a8c8ff')
  # Spear in left
  Draw-Shaft $bmp ($a.handLx - 1) ($a.headY - 14) ($a.handY + 6) 2 $MAT_WOOD_DARK
  Set-Pixel $bmp ($a.handLx - 1) ($a.headY - 15) $MAT_STEEL.top
}

function Draw-Card-Swordhand {
  param($bmp)
  Rng-Init 'c.swordhand'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $a = Draw-Humanoid $bmp $SKIN_FAIR $MAT_IRON -accent $BRAND.Crimson
  # Coif
  Fill-Box $bmp ($CARD_CX - 6) ($a.headY - 5) 12 5 $MAT_IRON.shadow
  Set-Pixel $bmp ($CARD_CX - 6) ($a.headY - 5) $MAT_IRON.high
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY - 1) 11 1 (Color-FromHex '#040408')
  # Arming sword
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 14) ($a.handY + 2) 3 $MAT_STEEL -Fuller
  Fill-Box $bmp $a.handRx ($a.handY + 2) 5 1 $MAT_IRON.high
}

function Draw-Card-Bowman {
  param($bmp)
  Rng-Init 'c.bowman'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $a = Draw-Humanoid $bmp $SKIN_TAN $MAT_LEATHER -torsoW 14 -accent (Color-FromHex '#5e9460')
  # Hood
  for ($i = 0; $i -lt 3; $i++) {
    $w = 12 - $i; $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 1 + $i) $w 1 (Color-FromHex '#3e6038')
  }
  # Bow
  for ($y = ($a.handY - 10); $y -le ($a.handY + 4); $y++) {
    $bx = ($a.handLx - 1) + [int]([Math]::Round(2 * [Math]::Sin(($y - $a.handY) * 0.2)))
    Set-Pixel $bmp $bx $y $MAT_WOOD_DARK.base
  }
  # Quiver on back
  Fill-Box $bmp ($CARD_CX + 8) ($a.torsoY + 2) 4 12 $MAT_WOOD_DARK.shadow
  Set-Pixel $bmp ($CARD_CX + 9) ($a.torsoY + 1) $MAT_WOOD_LIGHT.high
  Set-Pixel $bmp ($CARD_CX + 11) ($a.torsoY) $MAT_STEEL.top
}

function Draw-Card-PageWizard {
  param($bmp)
  Rng-Init 'c.pagewizard'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $robe = @{
    deep   = (Color-FromHex '#0c1a4a');
    shadow = (Color-FromHex '#1c3478');
    base   = (Color-FromHex '#3458b8');
    high   = (Color-FromHex '#6088e0');
    top    = (Color-FromHex '#a4b8f0');
  }
  $a = Draw-Humanoid $bmp $SKIN_PALE $robe -torsoW 14 -accent $MAT_GOLD.base
  # Small wizard hat
  for ($i = 0; $i -lt 7; $i++) {
    $w = 9 - $i; if ($w -lt 1) { $w = 1 }
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 1 - $i) $w 1 $robe.base
  }
  Set-Pixel $bmp $CARD_CX ($a.headTop - 8) $MAT_GOLD.top
  # Book in hands
  Stroke-Box $bmp ($CARD_CX - 4) ($a.handY - 4) 9 6 $robe.deep (Color-FromHex '#f0e0a0')
}

function Draw-Card-Wolf {
  param($bmp)
  Rng-Init 'c.wolf'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $fur = @{
    deep   = (Color-FromHex '#2a2a32');
    shadow = (Color-FromHex '#43434f');
    base   = (Color-FromHex '#6a6b7b');
    high   = (Color-FromHex '#9598a8');
    top    = (Color-FromHex '#c1c4d2');
  }
  Shade-Oval $bmp $CARD_CX 60 17 8 $fur
  Shade-Disc $bmp ($CARD_CX + 13) 52 6 $fur
  # Ears pointed up
  Set-Pixel $bmp ($CARD_CX + 9) 46 $fur.high
  Set-Pixel $bmp ($CARD_CX + 10) 45 $fur.base
  Set-Pixel $bmp ($CARD_CX + 16) 46 $fur.high
  Set-Pixel $bmp ($CARD_CX + 17) 45 $fur.base
  # Snout + teeth
  Fill-Box $bmp ($CARD_CX + 17) 54 4 3 $fur.shadow
  Set-Pixel $bmp ($CARD_CX + 20) 54 (Color-FromHex '#040404')
  Set-Pixel $bmp ($CARD_CX + 20) 56 (Color-FromHex '#f0f0d8')
  # Eyes yellow
  Set-Pixel $bmp ($CARD_CX + 12) 52 (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX + 15) 52 (Color-FromHex '#fff080')
  # Legs
  for ($i = 0; $i -lt 4; $i++) {
    $lx = $CARD_CX - 10 + $i * 7
    Fill-Box $bmp $lx 65 3 8 $fur.shadow
  }
  # Tail
  Line-Pixel $bmp ($CARD_CX - 14) 56 ($CARD_CX - 20) 48 $fur.shadow
}

function Draw-Card-Captain {
  param($bmp)
  Rng-Init 'c.captain'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $coat = @{
    deep   = (Color-FromHex '#3a0a14');
    shadow = (Color-FromHex '#6a141c');
    base   = (Color-FromHex '#a82428');
    high   = (Color-FromHex '#d8483c');
    top    = (Color-FromHex '#f47058');
  }
  $a = Draw-Humanoid $bmp $SKIN_FAIR $coat -accent $MAT_GOLD.base
  # Tricorne hat with feather
  Fill-Box $bmp ($CARD_CX - 9) ($a.headTop - 1) 19 2 $coat.deep
  Fill-Box $bmp ($CARD_CX - 6) ($a.headTop - 3) 13 2 $coat.shadow
  Set-Pixel $bmp ($CARD_CX - 9) ($a.headTop - 1) $coat.shadow
  Set-Pixel $bmp ($CARD_CX + 9) ($a.headTop - 1) $coat.shadow
  for ($i = 0; $i -lt 5; $i++) {
    Set-Pixel $bmp ($CARD_CX + 6 + $i) ($a.headTop - 4 - $i) (Color-FromHex '#fff0a0')
  }
  # Saber in right hand
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 16) ($a.handY + 2) 3 $MAT_STEEL -Fuller
  # Gold buttons row
  for ($i = 0; $i -lt 4; $i++) {
    Set-Pixel $bmp $CARD_CX ($a.torsoY + 3 + $i * 4) $MAT_GOLD.top
  }
}

function Draw-Card-Boar {
  param($bmp)
  Rng-Init 'c.boar'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 16
  $fur = @{
    deep   = (Color-FromHex '#2a1a08');
    shadow = (Color-FromHex '#4a2e14');
    base   = (Color-FromHex '#6a481c');
    high   = (Color-FromHex '#946a34');
    top    = (Color-FromHex '#b08a4c');
  }
  Shade-Oval $bmp $CARD_CX 60 19 10 $fur
  Shade-Disc $bmp ($CARD_CX + 14) 56 6 $fur
  # Snout
  Fill-Box $bmp ($CARD_CX + 18) 58 4 4 $fur.shadow
  Set-Pixel $bmp ($CARD_CX + 21) 59 (Color-FromHex '#040404')
  Set-Pixel $bmp ($CARD_CX + 21) 60 (Color-FromHex '#040404')
  # Tusks
  Set-Pixel $bmp ($CARD_CX + 19) 61 $SKIN_BONE.top
  Set-Pixel $bmp ($CARD_CX + 19) 62 $SKIN_BONE.high
  Set-Pixel $bmp ($CARD_CX + 22) 61 $SKIN_BONE.top
  Set-Pixel $bmp ($CARD_CX + 22) 62 $SKIN_BONE.high
  # Eye
  Set-Pixel $bmp ($CARD_CX + 14) 55 (Color-FromHex '#fff080')
  # Bristled back
  for ($x = ($CARD_CX - 12); $x -le ($CARD_CX + 8); $x += 2) {
    Set-Pixel $bmp $x 49 $fur.deep
    Set-Pixel $bmp $x 50 $fur.shadow
  }
  # Legs
  for ($i = 0; $i -lt 4; $i++) {
    $lx = $CARD_CX - 11 + $i * 7
    Fill-Box $bmp $lx 66 3 7 $fur.shadow
  }
}

function Draw-Card-Cleric4 {
  param($bmp)
  Rng-Init 'c.cleric4'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $robe = $MAT_CLOTH_LINEN
  $a = Draw-Humanoid $bmp $SKIN_PALE $robe -accent $MAT_GOLD.base
  # Halo
  $halo = With-Alpha (Color-FromHex '#fff0a0') 180
  for ($ang = 40; $ang -lt 320; $ang += 18) {
    $rad = $ang * [Math]::PI / 180
    $hx = $CARD_CX + [int]([Math]::Round([Math]::Cos($rad) * 7))
    $hy = ($a.headTop - 2) - [int]([Math]::Round([Math]::Sin($rad) * 3))
    Blend-Pixel $bmp $hx $hy $halo
  }
  # Cross on chest
  Draw-HealCross $bmp $CARD_CX ($a.torsoY + 10) 5 $MAT_GOLD
  # Mace
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 10) ($a.handY + 4) 2 $MAT_WOOD_LIGHT
  Shade-Disc $bmp ($a.handRx + 2) ($a.handY - 12) 3 $MAT_IRON
}

function Draw-Card-Zombie4 {
  param($bmp)
  Rng-Init 'c.zombie4'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $skin = @{
    deep   = (Color-FromHex '#1a3a18');
    shadow = (Color-FromHex '#3a5a28');
    base   = (Color-FromHex '#5e7a3c');
    high   = (Color-FromHex '#849858');
    top    = (Color-FromHex '#a8b878');
  }
  $a = Draw-Humanoid $bmp $skin $MAT_CLOTH_WOOL -torsoW 16 -torsoH 22
  # Hollow eyes
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX - 2) ($a.headY - 1) (Color-FromHex '#040408')
  Set-Pixel $bmp ($CARD_CX + 2) ($a.headY - 1) (Color-FromHex '#040408')
  # Drooping mouth
  Set-Pixel $bmp ($CARD_CX - 1) ($a.headY + 3) $skin.deep
  Set-Pixel $bmp $CARD_CX ($a.headY + 3) $skin.deep
  Set-Pixel $bmp ($CARD_CX + 1) ($a.headY + 3) $skin.deep
  # Torn cloth tears
  Set-Pixel $bmp ($CARD_CX - 5) ($a.torsoY + 10) $skin.deep
  Set-Pixel $bmp ($CARD_CX + 4) ($a.torsoY + 14) $skin.deep
  # Outstretched arm (the right arm reaches further)
  Fill-Box $bmp ($a.handRx + 2) ($a.handY - 4) 5 3 $skin.base
}

function Draw-Card-Knight5 {
  param($bmp)
  Rng-Init 'c.knight5'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $a = Draw-Humanoid $bmp $SKIN_FAIR $MAT_STEEL -torsoW 22 -torsoH 24 -reach 26 -accent $BRAND.Crimson
  # Great helm
  Fill-Box $bmp ($CARD_CX - 7) ($a.headY - 6) 14 9 $MAT_STEEL.shadow
  Set-Pixel $bmp ($CARD_CX - 7) ($a.headY - 6) $MAT_STEEL.high
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY) 11 2 (Color-FromHex '#040408')
  # Long sword
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 16) ($a.handY + 2) 3 $MAT_STEEL -Fuller
  Fill-Box $bmp ($a.handRx) ($a.handY + 2) 5 1 $MAT_GOLD.base
  # Kite shield
  Stroke-Box $bmp ($a.handLx - 4) ($a.handY - 8) 7 14 $MAT_STEEL.deep $MAT_STEEL.base
  Set-Pixel $bmp ($a.handLx - 1) ($a.handY - 4) $BRAND.Crimson
  Set-Pixel $bmp ($a.handLx - 1) ($a.handY - 2) $BRAND.Crimson
  Set-Pixel $bmp ($a.handLx - 2) ($a.handY - 3) $BRAND.Crimson
  Set-Pixel $bmp $a.handLx ($a.handY - 3) $BRAND.Crimson
}

function Draw-Card-Troll5 {
  param($bmp)
  Rng-Init 'c.troll5'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 18
  $skin = @{
    deep   = (Color-FromHex '#1a2a08');
    shadow = (Color-FromHex '#3a4818');
    base   = (Color-FromHex '#5e7028');
    high   = (Color-FromHex '#84903c');
    top    = (Color-FromHex '#b0b860');
  }
  $a = Draw-Humanoid $bmp $skin $MAT_LEATHER -torsoW 24 -torsoH 26 -reach 30 -headR 9
  # Tusks
  Set-Pixel $bmp ($CARD_CX - 3) ($a.headY + 3) $SKIN_BONE.high
  Set-Pixel $bmp ($CARD_CX + 3) ($a.headY + 3) $SKIN_BONE.high
  Set-Pixel $bmp ($CARD_CX - 3) ($a.headY + 4) $SKIN_BONE.top
  Set-Pixel $bmp ($CARD_CX + 3) ($a.headY + 4) $SKIN_BONE.top
  # Yellow eyes
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#fff080')
  # Crude club
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 16) ($a.handY + 4) 3 $MAT_WOOD_DARK
  Fill-Box $bmp ($a.handRx) ($a.handY - 18) 7 5 $MAT_WOOD_DARK.base
  Set-Pixel $bmp ($a.handRx) ($a.handY - 18) $MAT_WOOD_DARK.high
  # Iron spikes on club
  Set-Pixel $bmp ($a.handRx + 2) ($a.handY - 19) $MAT_IRON.top
  Set-Pixel $bmp ($a.handRx + 4) ($a.handY - 19) $MAT_IRON.top
}

function Draw-Card-Guardian5 {
  param($bmp)
  Rng-Init 'c.guardian5'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 16
  $a = Draw-Humanoid $bmp $SKIN_GREY $MAT_STONE -torsoW 24 -torsoH 26 -reach 30 -headR 8
  # Stone face — square
  Fill-Box $bmp ($CARD_CX - 7) ($a.headY - 5) 14 12 $MAT_STONE.base
  Stroke-Box $bmp ($CARD_CX - 7) ($a.headY - 5) 14 12 $MAT_STONE.shadow
  Set-Pixel $bmp ($CARD_CX - 3) $a.headY (Color-FromHex '#a8c8ff')
  Set-Pixel $bmp ($CARD_CX + 3) $a.headY (Color-FromHex '#a8c8ff')
  # Tower shield + maul
  Stroke-Box $bmp ($CARD_CX - 14) ($a.handY - 10) 9 20 $MAT_STONE.deep $MAT_STONE.base
  Set-Pixel $bmp ($CARD_CX - 10) ($a.handY - 1) $MAT_GOLD.top
  # Cracks in stone
  Line-Pixel $bmp ($CARD_CX - 5) ($a.torsoY + 4) ($CARD_CX + 3) ($a.torsoY + 14) $MAT_STONE.deep
}

function Draw-Card-Ogre6 {
  param($bmp)
  Rng-Init 'c.ogre6'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 20
  $skin = @{
    deep   = (Color-FromHex '#1a1a10');
    shadow = (Color-FromHex '#3a3a20');
    base   = (Color-FromHex '#6a6038');
    high   = (Color-FromHex '#90865a');
    top    = (Color-FromHex '#b8b078');
  }
  $a = Draw-Humanoid $bmp $skin $MAT_LEATHER -torsoW 28 -torsoH 28 -reach 34 -headR 10 -legH 14
  # Single big eye
  Fill-Box $bmp ($CARD_CX - 2) ($a.headY - 1) 5 4 (Color-FromHex '#fff8d8')
  Fill-Box $bmp ($CARD_CX - 1) ($a.headY) 3 2 (Color-FromHex '#040408')
  # Tusks
  Set-Pixel $bmp ($CARD_CX - 4) ($a.headY + 5) $SKIN_BONE.high
  Set-Pixel $bmp ($CARD_CX + 4) ($a.headY + 5) $SKIN_BONE.high
  # Massive crude weapon — boulder on stick
  Draw-Shaft $bmp ($a.handRx + 3) ($a.handY - 16) ($a.handY + 6) 3 $MAT_WOOD_DARK
  Shade-Disc $bmp ($a.handRx + 3) ($a.handY - 18) 5 $MAT_STONE -RimLight
}

function Draw-Card-Warlord6 {
  param($bmp)
  Rng-Init 'c.warlord6'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 16
  $a = Draw-Humanoid $bmp $SKIN_TAN $MAT_OBSIDIAN -torsoW 24 -torsoH 26 -reach 30 -accent $BRAND.Crimson
  # Horned helm
  Fill-Box $bmp ($CARD_CX - 7) ($a.headY - 6) 14 8 $MAT_OBSIDIAN.shadow
  Set-Pixel $bmp ($CARD_CX - 9) ($a.headY - 5) $MAT_IRON.high
  Set-Pixel $bmp ($CARD_CX - 10) ($a.headY - 6) $MAT_IRON.base
  Set-Pixel $bmp ($CARD_CX + 8) ($a.headY - 5) $MAT_IRON.high
  Set-Pixel $bmp ($CARD_CX + 9) ($a.headY - 6) $MAT_IRON.base
  Fill-Box $bmp ($CARD_CX - 5) ($a.headY) 11 2 $BRAND.Crimson
  # Two-handed axe
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 18) ($a.handY + 6) 2 $MAT_WOOD_DARK
  Fill-Box $bmp ($a.handRx - 1) ($a.handY - 20) 9 6 $MAT_IRON.base
  Set-Pixel $bmp ($a.handRx - 1) ($a.handY - 20) $MAT_IRON.high
  Set-Pixel $bmp ($a.handRx + 7) ($a.handY - 14) $MAT_IRON.shadow
  # Crimson sash
  Fill-Box $bmp ($CARD_CX - 11) ($a.torsoY + 10) 23 2 $BRAND.Crimson
}

function Draw-Card-Warbear7 {
  param($bmp)
  Rng-Init 'c.warbear7'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 20
  $fur = @{
    deep   = (Color-FromHex '#1a0c08');
    shadow = (Color-FromHex '#3a1c10');
    base   = (Color-FromHex '#5e3018');
    high   = (Color-FromHex '#8a4828');
    top    = (Color-FromHex '#b06038');
  }
  # Large body
  Shade-Oval $bmp $CARD_CX 60 22 11 $fur
  # Plate barding on body
  Fill-Box $bmp ($CARD_CX - 18) 56 36 4 $MAT_STEEL.base
  Stroke-Box $bmp ($CARD_CX - 18) 56 36 4 $MAT_STEEL.shadow
  Draw-Rivet $bmp ($CARD_CX - 14) 58 $MAT_STEEL
  Draw-Rivet $bmp ($CARD_CX) 58 $MAT_STEEL
  Draw-Rivet $bmp ($CARD_CX + 14) 58 $MAT_STEEL
  # Head with armored cap
  Shade-Disc $bmp ($CARD_CX + 14) 48 7 $fur
  Fill-Box $bmp ($CARD_CX + 9) 44 12 4 $MAT_STEEL.shadow
  Set-Pixel $bmp ($CARD_CX + 14) 42 $MAT_STEEL.top
  # Eyes red
  Set-Pixel $bmp ($CARD_CX + 12) 48 $BRAND.Crimson
  Set-Pixel $bmp ($CARD_CX + 16) 48 $BRAND.Crimson
  # Snout + roaring teeth
  Fill-Box $bmp ($CARD_CX + 19) 50 4 4 $fur.shadow
  Set-Pixel $bmp ($CARD_CX + 21) 53 (Color-FromHex '#f0f0d8')
  Set-Pixel $bmp ($CARD_CX + 22) 53 (Color-FromHex '#f0f0d8')
  # Legs
  for ($i = 0; $i -lt 4; $i++) {
    $lx = $CARD_CX - 14 + $i * 9
    Fill-Box $bmp $lx 67 5 7 $fur.shadow
    Set-Pixel $bmp $lx 67 $fur.high
  }
}

# ── Common spells (11) ───────────────────────────────────────────

function Draw-Card-Bolt1 {
  param($bmp)
  Rng-Init 'c.bolt1'
  Draw-MagicCircle $bmp $CARD_CX 40 18 $ARCANE.base 80
  Draw-Bolt $bmp ($CARD_CX - 6) 22 ($CARD_CX + 6) 58 (Color-FromHex '#fff0a0') $ARCANE.high
}

function Draw-Card-Heal1 {
  param($bmp)
  Rng-Init 'c.heal1'
  Draw-MagicCircle $bmp $CARD_CX 40 18 $HOLY.base 80
  Draw-HealCross $bmp $CARD_CX 40 10 $HOLY
}

function Draw-Card-SmolSpell {
  param($bmp)
  Rng-Init 'c.smolspell'
  Draw-MagicCircle $bmp $CARD_CX 40 20 $ARCANE.base 90 -Runes
  # Spark cluster
  Shade-Disc $bmp $CARD_CX 40 5 (Build-Ramp '#a890ff') -RimLight
  foreach ($p in @(@(-7,32),@(7,32),@(-7,48),@(7,48),@(0,28),@(0,52))) {
    Set-Pixel $bmp ($CARD_CX + $p[0]) $p[1] $ARCANE.top
  }
}

function Draw-Card-FlameSword {
  param($bmp)
  Rng-Init 'c.flamesword'
  Draw-MagicCircle $bmp $CARD_CX 40 22 $FIRE.base 100 -Runes
  # Sword vertical
  Draw-Blade $bmp $CARD_CX 16 50 4 $MAT_STEEL -Fuller -accent $FIRE.top
  Fill-Box $bmp ($CARD_CX - 5) 52 11 2 $MAT_GOLD.base
  Draw-Grip $bmp $CARD_CX 54 64 2 $MAT_LEATHER
  Set-Pixel $bmp $CARD_CX 66 $MAT_GOLD.top
  # Flames licking the blade
  for ($y = 14; $y -lt 52; $y += 4) {
    Blend-Pixel $bmp ($CARD_CX - 3) $y (With-Alpha $FIRE.high 180)
    Blend-Pixel $bmp ($CARD_CX + 3) $y (With-Alpha $FIRE.high 180)
    Blend-Pixel $bmp ($CARD_CX - 5) ($y + 2) (With-Alpha $FIRE.base 120)
    Blend-Pixel $bmp ($CARD_CX + 5) ($y + 2) (With-Alpha $FIRE.base 120)
  }
}

function Draw-Card-HealFlash {
  param($bmp)
  Rng-Init 'c.healflash'
  Draw-MagicCircle $bmp $CARD_CX 40 22 $HOLY.base 110 -Runes
  Draw-HealCross $bmp $CARD_CX 40 16 $HOLY
  # Radiant flash lines
  for ($ang = 0; $ang -lt 360; $ang += 30) {
    $rad = $ang * [Math]::PI / 180
    $rx = $CARD_CX + [int]([Math]::Round([Math]::Cos($rad) * 12))
    $ry = 40 + [int]([Math]::Round([Math]::Sin($rad) * 12))
    Set-Pixel $bmp $rx $ry $HOLY.top
    $rx2 = $CARD_CX + [int]([Math]::Round([Math]::Cos($rad) * 16))
    $ry2 = 40 + [int]([Math]::Round([Math]::Sin($rad) * 16))
    Blend-Pixel $bmp $rx2 $ry2 (With-Alpha $HOLY.top 160)
  }
}

function Draw-Card-BoltVolley {
  param($bmp)
  Rng-Init 'c.boltvolley'
  Draw-MagicCircle $bmp $CARD_CX 40 22 $ARCANE.base 100 -Runes
  Draw-Bolt $bmp ($CARD_CX - 14) 18 ($CARD_CX - 10) 62 (Color-FromHex '#fff0a0') $ARCANE.high
  Draw-Bolt $bmp ($CARD_CX - 2) 16 ($CARD_CX + 2) 64 (Color-FromHex '#fff0a0') $ARCANE.high
  Draw-Bolt $bmp ($CARD_CX + 10) 18 ($CARD_CX + 14) 62 (Color-FromHex '#fff0a0') $ARCANE.high
}

function Draw-Card-CardDraw1 {
  param($bmp)
  Rng-Init 'c.cardraw1'
  Draw-MagicCircle $bmp $CARD_CX 40 22 $ARCANE.base 100 -Runes
  Stroke-Box $bmp ($CARD_CX - 7) 28 14 24 $MAT_WOOD_DARK.deep (Color-FromHex '#f0e0a0')
  # Card face rune
  Fill-Box $bmp ($CARD_CX - 5) 32 10 4 $ARCANE.shadow
  Set-Pixel $bmp $CARD_CX 40 $ARCANE.top
  Set-Pixel $bmp ($CARD_CX - 3) 46 $ARCANE.high
  Set-Pixel $bmp ($CARD_CX + 2) 46 $ARCANE.high
}

function Draw-Card-Smite {
  param($bmp)
  Rng-Init 'c.smiteminion'
  Draw-MagicCircle $bmp $CARD_CX 40 22 $HOLY.base 100 -Runes
  # Pointing hand from above
  Fill-Box $bmp ($CARD_CX - 4) 18 8 8 $SKIN_PALE.base
  Set-Pixel $bmp ($CARD_CX - 4) 18 $SKIN_PALE.high
  # Pointing finger
  Fill-Box $bmp ($CARD_CX - 1) 26 2 8 $SKIN_PALE.base
  # Beam of light
  for ($y = 34; $y -lt 64; $y++) {
    Blend-Pixel $bmp $CARD_CX $y (With-Alpha $HOLY.top 220)
    Blend-Pixel $bmp ($CARD_CX - 1) $y (With-Alpha $HOLY.high 180)
    Blend-Pixel $bmp ($CARD_CX + 1) $y (With-Alpha $HOLY.high 180)
    Blend-Pixel $bmp ($CARD_CX - 2) $y (With-Alpha $HOLY.base 100)
    Blend-Pixel $bmp ($CARD_CX + 2) $y (With-Alpha $HOLY.base 100)
  }
  # Impact flash at bottom
  Shade-Disc $bmp $CARD_CX 66 4 (Build-Ramp '#fff8d8')
}

function Draw-Card-ShieldSelf {
  param($bmp)
  Rng-Init 'c.shieldself'
  Draw-MagicCircle $bmp $CARD_CX 40 22 (Color-FromHex '#a8c8ff') 110 -Runes
  # Shield outline (kite)
  $shadeRamp = @{
    deep   = (Color-FromHex '#1a3a60');
    shadow = (Color-FromHex '#3a5e98');
    base   = (Color-FromHex '#5a8ad0');
    high   = (Color-FromHex '#9cc0f0');
    top    = (Color-FromHex '#d8e8ff');
  }
  for ($y = 26; $y -lt 58; $y++) {
    $w = if ($y -lt 50) { 9 - [Math]::Abs($y - 38) / 4 } else { [int]([Math]::Max(2, 9 - ($y - 50) * 1.5)) }
    $halfL = [int]($w)
    for ($dx = -$halfL; $dx -le $halfL; $dx++) {
      $col = if ([Math]::Abs($dx) -lt 2) { $shadeRamp.top }
             elseif ([Math]::Abs($dx) -lt 4) { $shadeRamp.high }
             elseif ([Math]::Abs($dx) -lt 6) { $shadeRamp.base }
             else { $shadeRamp.shadow }
      Set-Pixel $bmp ($CARD_CX + $dx) $y $col
    }
  }
  # Cross emblem
  Draw-HealCross $bmp $CARD_CX 38 6 $MAT_GOLD
}

function Draw-Card-FireBreath {
  param($bmp)
  Rng-Init 'c.firebreath'
  # Conical flame breath from upper-left to lower-right
  for ($i = 0; $i -lt 40; $i++) {
    $t = $i / 40.0
    $cx = 10 + [int]([Math]::Round($t * 44))
    $cy = 18 + [int]([Math]::Round($t * 44))
    $r = [int]([Math]::Round(2 + $t * 8))
    $col = if ($t -lt 0.3) { $FIRE.top }
           elseif ($t -lt 0.55) { $FIRE.high }
           elseif ($t -lt 0.8) { $FIRE.base }
           else { $FIRE.shadow }
    Shade-Disc $bmp $cx $cy $r @{ deep=$FIRE.deep; shadow=$FIRE.shadow; base=$col; high=$col; top=$col }
  }
  # Source ember at upper-left
  Shade-Disc $bmp 10 18 3 (Build-Ramp '#fff8d8') -RimLight
}

function Draw-Card-Battlecry {
  # War horn with sound waves
  param($bmp)
  Rng-Init 'c.battlecry'
  Draw-MagicCircle $bmp $CARD_CX 40 22 $BRAND.Crimson 100 -Runes
  # Horn — curved cone shape
  for ($i = 0; $i -lt 22; $i++) {
    $w = 2 + [int]($i * 0.4)
    $x = ($CARD_CX - 14) + $i
    $y = 38 + [int]([Math]::Sin($i * 0.18) * 2)
    Fill-Box $bmp $x ($y - $w) 2 ($w * 2) $MAT_GOLD.base
    Set-Pixel $bmp $x ($y - $w) $MAT_GOLD.high
    Set-Pixel $bmp $x ($y + $w) $MAT_GOLD.shadow
  }
  # Sound waves emanating from bell
  for ($ang = -30; $ang -le 30; $ang += 15) {
    $rad = $ang * [Math]::PI / 180
    for ($d = 4; $d -lt 20; $d += 4) {
      $rx = ($CARD_CX + 12) + [int]([Math]::Round([Math]::Cos($rad) * $d))
      $ry = 40 + [int]([Math]::Round([Math]::Sin($rad) * $d))
      Set-Pixel $bmp $rx $ry $BRAND.Crimson
    }
  }
}

# ── Tokens (2) ───────────────────────────────────────────────────

function Draw-Card-BoneKnight {
  param($bmp)
  Rng-Init 'tok.boneknight'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $a = Draw-Humanoid $bmp $SKIN_BONE $MAT_OBSIDIAN -accent $BRAND.Crimson
  # Skull face
  Fill-Box $bmp ($CARD_CX - 3) ($a.headY - 1) 3 3 (Color-FromHex '#040408')
  Fill-Box $bmp ($CARD_CX + 1) ($a.headY - 1) 3 3 (Color-FromHex '#040408')
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY $BRAND.Crimson
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY $BRAND.Crimson
  for ($i = 0; $i -lt 5; $i++) {
    Set-Pixel $bmp ($CARD_CX - 2 + $i) ($a.headY + 3) $SKIN_BONE.deep
  }
  # Helm crown
  Fill-Box $bmp ($CARD_CX - 7) ($a.headY - 5) 14 3 $MAT_OBSIDIAN.shadow
  Set-Pixel $bmp ($CARD_CX - 4) ($a.headY - 6) $MAT_OBSIDIAN.high
  Set-Pixel $bmp ($CARD_CX) ($a.headY - 7) $MAT_OBSIDIAN.high
  Set-Pixel $bmp ($CARD_CX + 4) ($a.headY - 6) $MAT_OBSIDIAN.high
  # Skeletal sword
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 12) ($a.handY + 2) 3 $MAT_IRON -Fuller
  # Round shield bone
  Shade-Disc $bmp ($a.handLx - 1) $a.handY 5 $SKIN_BONE -RimLight
  Set-Pixel $bmp ($a.handLx - 1) $a.handY $BRAND.Crimson
}

function Draw-Card-GobScrap {
  param($bmp)
  Rng-Init 'tok.gobscrap'
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 8
  $a = Draw-Humanoid $bmp $SKIN_GREEN $MAT_LEATHER -torsoW 10 -torsoH 14 -legH 10 -reach 14
  # Pointed ears
  Set-Pixel $bmp ($CARD_CX - 6) ($a.headY) $SKIN_GREEN.high
  Set-Pixel $bmp ($CARD_CX - 7) ($a.headY + 1) $SKIN_GREEN.base
  Set-Pixel $bmp ($CARD_CX + 5) ($a.headY) $SKIN_GREEN.high
  Set-Pixel $bmp ($CARD_CX + 6) ($a.headY + 1) $SKIN_GREEN.base
  # Yellow eyes
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#fff080')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY (Color-FromHex '#fff080')
  # Tiny knife
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 1) ($a.handY + 4) 1 $MAT_IRON
  # Scrap mail patch
  Set-Pixel $bmp ($CARD_CX - 2) ($a.torsoY + 4) $MAT_IRON.high
  Set-Pixel $bmp ($CARD_CX + 1) ($a.torsoY + 6) $MAT_IRON.high
  Set-Pixel $bmp $CARD_CX ($a.torsoY + 10) $MAT_IRON.high
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
  'u.scrapper'       = 'Draw-Card-Scrapper'
  'u.shieldguard'    = 'Draw-Card-ShieldGuard'
  'u.glasscat'       = 'Draw-Card-GlassCat'
  'u.honeybadger'    = 'Draw-Card-HoneyBadger'
  'u.spittingrat'    = 'Draw-Card-SpittingRat'
  'u.runesinger'     = 'Draw-Card-RuneSinger'
  'u.stoutwarden'    = 'Draw-Card-StoutWarden'
  'u.scoutarcher'    = 'Draw-Card-ScoutArcher'
  'u.bloodhound'     = 'Draw-Card-Bloodhound'
  'u.daggerthief'    = 'Draw-Card-DaggerThief'
  'u.warpriest'      = 'Draw-Card-WarPriest'
  'u.tankknight'     = 'Draw-Card-TankKnight'
  'u.coppergolem'    = 'Draw-Card-CopperGolem'
  'u.ironvanguard'   = 'Draw-Card-IronVanguard'
  'u.boltcarrier'    = 'Draw-Card-BoltCarrier'
  'u.boltbolt'       = 'Draw-Card-BoltBolt'
  'u.smallheal'      = 'Draw-Card-SmallHeal'
  'u.smallbuff'      = 'Draw-Card-SmallBuff'
  'u.firebolt'       = 'Draw-Card-FireBolt'
  'u.cardraw2'       = 'Draw-Card-CardDraw2'
  'c.acolyte'        = 'Draw-Card-Acolyte'
  'c.gobrunt'        = 'Draw-Card-GobRunt'
  'c.ironguard'      = 'Draw-Card-IronGuard'
  'c.imp'            = 'Draw-Card-Imp'
  'c.skeleton'       = 'Draw-Card-Skeleton'
  'c.lookout'        = 'Draw-Card-Lookout'
  'c.swordhand'      = 'Draw-Card-Swordhand'
  'c.bowman'         = 'Draw-Card-Bowman'
  'c.pagewizard'     = 'Draw-Card-PageWizard'
  'c.wolf'           = 'Draw-Card-Wolf'
  'c.captain'        = 'Draw-Card-Captain'
  'c.boar'           = 'Draw-Card-Boar'
  'c.cleric4'        = 'Draw-Card-Cleric4'
  'c.zombie4'        = 'Draw-Card-Zombie4'
  'c.knight5'        = 'Draw-Card-Knight5'
  'c.troll5'         = 'Draw-Card-Troll5'
  'c.guardian5'      = 'Draw-Card-Guardian5'
  'c.ogre6'          = 'Draw-Card-Ogre6'
  'c.warlord6'       = 'Draw-Card-Warlord6'
  'c.warbear7'       = 'Draw-Card-Warbear7'
  'c.bolt1'          = 'Draw-Card-Bolt1'
  'c.heal1'          = 'Draw-Card-Heal1'
  'c.smolspell'      = 'Draw-Card-SmolSpell'
  'c.flamesword'     = 'Draw-Card-FlameSword'
  'c.healflash'      = 'Draw-Card-HealFlash'
  'c.boltvolley'     = 'Draw-Card-BoltVolley'
  'c.cardraw1'       = 'Draw-Card-CardDraw1'
  'c.smiteminion'    = 'Draw-Card-Smite'
  'c.shieldself'     = 'Draw-Card-ShieldSelf'
  'c.firebreath'     = 'Draw-Card-FireBreath'
  'c.battlecry'      = 'Draw-Card-Battlecry'
  'tok.boneknight'   = 'Draw-Card-BoneKnight'
  'tok.gobscrap'     = 'Draw-Card-GobScrap'
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
  'u.scrapper'      = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.shieldguard'   = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.glasscat'      = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.honeybadger'   = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.spittingrat'   = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.runesinger'    = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.stoutwarden'   = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.scoutarcher'   = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.bloodhound'    = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.daggerthief'   = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.warpriest'     = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.tankknight'    = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.coppergolem'   = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.ironvanguard'  = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.boltcarrier'   = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.boltbolt'      = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.smallheal'     = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.smallbuff'     = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.firebolt'      = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'u.cardraw2'      = @{ rarity = 'uncommon';  pass = 'uncommons' }
  'c.acolyte'       = @{ rarity = 'common';    pass = 'commons' }
  'c.gobrunt'       = @{ rarity = 'common';    pass = 'commons' }
  'c.ironguard'     = @{ rarity = 'common';    pass = 'commons' }
  'c.imp'           = @{ rarity = 'common';    pass = 'commons' }
  'c.skeleton'      = @{ rarity = 'common';    pass = 'commons' }
  'c.lookout'       = @{ rarity = 'common';    pass = 'commons' }
  'c.swordhand'     = @{ rarity = 'common';    pass = 'commons' }
  'c.bowman'        = @{ rarity = 'common';    pass = 'commons' }
  'c.pagewizard'    = @{ rarity = 'common';    pass = 'commons' }
  'c.wolf'          = @{ rarity = 'common';    pass = 'commons' }
  'c.captain'       = @{ rarity = 'common';    pass = 'commons' }
  'c.boar'          = @{ rarity = 'common';    pass = 'commons' }
  'c.cleric4'       = @{ rarity = 'common';    pass = 'commons' }
  'c.zombie4'       = @{ rarity = 'common';    pass = 'commons' }
  'c.knight5'       = @{ rarity = 'common';    pass = 'commons' }
  'c.troll5'        = @{ rarity = 'common';    pass = 'commons' }
  'c.guardian5'     = @{ rarity = 'common';    pass = 'commons' }
  'c.ogre6'         = @{ rarity = 'common';    pass = 'commons' }
  'c.warlord6'      = @{ rarity = 'common';    pass = 'commons' }
  'c.warbear7'      = @{ rarity = 'common';    pass = 'commons' }
  'c.bolt1'         = @{ rarity = 'common';    pass = 'commons' }
  'c.heal1'         = @{ rarity = 'common';    pass = 'commons' }
  'c.smolspell'     = @{ rarity = 'common';    pass = 'commons' }
  'c.flamesword'    = @{ rarity = 'common';    pass = 'commons' }
  'c.healflash'     = @{ rarity = 'common';    pass = 'commons' }
  'c.boltvolley'    = @{ rarity = 'common';    pass = 'commons' }
  'c.cardraw1'      = @{ rarity = 'common';    pass = 'commons' }
  'c.smiteminion'   = @{ rarity = 'common';    pass = 'commons' }
  'c.shieldself'    = @{ rarity = 'common';    pass = 'commons' }
  'c.firebreath'    = @{ rarity = 'common';    pass = 'commons' }
  'c.battlecry'     = @{ rarity = 'common';    pass = 'commons' }
  'tok.boneknight'  = @{ rarity = 'common';    pass = 'tokens' }
  'tok.gobscrap'    = @{ rarity = 'common';    pass = 'tokens' }
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

# =====================================================================
# ── 2026-05-21 EXPANSION — manifest-driven procedural rendering ─────
# =====================================================================
#
# CARD-GAME-DESIGN.md §13 grows the catalogue from 82 to ~1,500 cards
# via cards-catalog-gen.js. Hand-curated draw functions (above) handle
# champions, the original legendaries, original rares — anything that
# has a $CARD_DRAW entry. Everything else dispatches to a family
# template based on its manifest entry (palette + skin + weapon
# variant + rarity), so every card gets a unique-feeling sprite
# without per-card authoring.
#
# Run order:
#   node tools/dump-card-manifest.mjs        # 1. write tools/.card-manifest.json
#   pwsh tools/build-card-sprites.ps1        # 2. render all cards in the manifest
#   node tools/build-card-apng.mjs           # 3. stitch legendary APNGs

# ── Manifest loader ──────────────────────────────────────────────────

function Load-Manifest {
  $path = $Manifest
  if (-not $path) { $path = Join-Path $PSScriptRoot '.card-manifest.json' }
  if (-not (Test-Path $path)) {
    Write-Host ("  ! manifest not found at {0} - falling back to legacy CARD_META set ({1} cards)" -f $path, $CARD_META.Count) -ForegroundColor Yellow
    return $null
  }
  $raw = Get-Content -Raw -Path $path
  return ConvertFrom-Json $raw
}

# ── Palette + skin lookup tables ─────────────────────────────────────

$PALETTE_BY_KEY = @{
  'leather'        = $MAT_LEATHER
  'leather-black'  = $MAT_LEATHER_BLACK
  'steel'          = $MAT_STEEL
  'iron'           = $MAT_IRON
  'bronze'         = $MAT_BRONZE
  'gold'           = $MAT_GOLD
  'silver'         = $MAT_SILVER
  'arcane'         = $ARCANE
  'fire'           = $FIRE
  'frost'          = @{
    deep   = (Color-FromHex '#0a3060');
    shadow = (Color-FromHex '#2a70c0');
    base   = (Color-FromHex '#6ab0ec');
    high   = (Color-FromHex '#a8d8ff');
    top    = (Color-FromHex '#e0f0ff');
  }
  'holy'           = $HOLY
  'shadow'         = $SHADOW
  'nature'         = $NATURE
  'voltaic'        = @{
    deep   = (Color-FromHex '#08086c');
    shadow = (Color-FromHex '#2820c0');
    base   = (Color-FromHex '#6452ff');
    high   = (Color-FromHex '#a890ff');
    top    = (Color-FromHex '#e8dcff');
  }
  'wood'           = $MAT_WOOD_DARK
  'stone'          = $MAT_STONE
  'cloth-linen'    = $MAT_CLOTH_LINEN
}
function Palette-Lookup { param([string]$k) if ($PALETTE_BY_KEY.ContainsKey($k)) { return $PALETTE_BY_KEY[$k] } else { return $MAT_IRON } }

$SKIN_BY_KEY = @{
  'fair'    = $SKIN_FAIR
  'tan'     = $SKIN_TAN
  'pale'    = $SKIN_PALE
  'green'   = $SKIN_GREEN
  'grey'    = $SKIN_GREY
  'bone'    = $SKIN_BONE
  'purple'  = $SKIN_PURPLE
  # Synthetic skins for elementals / non-human family templates
  'red'     = @{
    deep   = (Color-FromHex '#3a0a08');
    shadow = (Color-FromHex '#7a1a14');
    base   = (Color-FromHex '#c8362a');
    high   = (Color-FromHex '#e87055');
    top    = (Color-FromHex '#f8b09a');
  }
  'fire'    = $FIRE
  'ice'     = @{
    deep   = (Color-FromHex '#0a3060');
    shadow = (Color-FromHex '#2a70c0');
    base   = (Color-FromHex '#6ab0ec');
    high   = (Color-FromHex '#a8d8ff');
    top    = (Color-FromHex '#e0f0ff');
  }
  'electric' = @{
    deep   = (Color-FromHex '#5c4a10');
    shadow = (Color-FromHex '#9a8830');
    base   = (Color-FromHex '#f4e068');
    high   = (Color-FromHex '#fff09a');
    top    = (Color-FromHex '#fffbe0');
  }
  'stone'   = $MAT_STONE
}
function Skin-Lookup { param([string]$k) if ($SKIN_BY_KEY.ContainsKey($k)) { return $SKIN_BY_KEY[$k] } else { return $SKIN_FAIR } }

# ── Weapon sprites — small composable bits ───────────────────────────
#
# Each takes ($bmp, $anchor) where $anchor is the hash from
# Draw-Humanoid (handRx, handY, etc.) and paints a weapon in/over the
# right hand.

function Weapon-Sword { param($bmp, $a, $ramp) Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 18) ($a.handY + 1) 3 $ramp -Fuller; Fill-Box $bmp ($a.handRx) ($a.handY) 7 2 $MAT_BRONZE.base }
function Weapon-Dagger { param($bmp, $a, $ramp) Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 6) ($a.handY + 1) 2 $ramp; Set-Pixel $bmp ($a.handRx + 2) ($a.handY - 6) $ramp.top }
function Weapon-Axe { param($bmp, $a, $ramp)
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 14) ($a.handY + 2) 2 $MAT_WOOD_DARK
  # Axe head — triangle blob right of shaft
  Fill-Box $bmp ($a.handRx + 3) ($a.handY - 14) 6 5 $ramp.shadow
  Fill-Box $bmp ($a.handRx + 3) ($a.handY - 13) 6 3 $ramp.base
  Set-Pixel $bmp ($a.handRx + 8) ($a.handY - 14) $ramp.top
  Set-Pixel $bmp ($a.handRx + 8) ($a.handY - 12) $ramp.high
}
function Weapon-Hammer { param($bmp, $a, $ramp)
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 14) ($a.handY + 2) 2 $MAT_WOOD_DARK
  Fill-Box $bmp ($a.handRx) ($a.handY - 16) 6 5 $ramp.shadow
  Fill-Box $bmp ($a.handRx) ($a.handY - 15) 6 3 $ramp.base
  Set-Pixel $bmp ($a.handRx) ($a.handY - 16) $ramp.top
  Set-Pixel $bmp ($a.handRx + 5) ($a.handY - 14) $ramp.shadow
}
function Weapon-Staff { param($bmp, $a, $ramp)
  Draw-Shaft $bmp ($a.handRx + 2) ($a.headTop - 6) ($a.handY + 6) 2 $MAT_WOOD_DARK
  Shade-Disc $bmp ($a.handRx + 2) ($a.headTop - 8) 3 $ramp -RimLight
}
function Weapon-Orb { param($bmp, $a, $ramp)
  Shade-Disc $bmp ($a.handRx + 3) ($a.handY) 4 $ramp -RimLight
}
function Weapon-Bow { param($bmp, $a, $ramp)
  # Vertical bow arc to the right of the figure
  for ($y = -8; $y -le 8; $y++) {
    $dx = [int]([Math]::Round(3 - [Math]::Abs($y) * 0.25))
    Set-Pixel $bmp ($a.handRx + 4 + $dx) ($a.handY + $y) $ramp.base
  }
  # Bowstring
  Line-Pixel $bmp ($a.handRx + 4) ($a.handY - 8) ($a.handRx + 4) ($a.handY + 8) $MAT_CLOTH_LINEN.high
}
function Weapon-Crossbow { param($bmp, $a, $ramp)
  Fill-Box $bmp ($a.handRx) ($a.handY) 8 3 $MAT_WOOD_DARK.base
  Fill-Box $bmp ($a.handRx + 2) ($a.handY - 2) 4 2 $ramp.shadow
  Set-Pixel $bmp ($a.handRx + 7) ($a.handY + 1) $MAT_STEEL.high
}
function Weapon-Halberd { param($bmp, $a, $ramp)
  Draw-Shaft $bmp ($a.handRx + 2) ($a.headTop - 8) ($a.handY + 8) 2 $MAT_WOOD_DARK
  Draw-Blade $bmp ($a.handRx + 2) ($a.headTop - 10) ($a.headTop - 4) 2 $ramp
  Fill-Box $bmp ($a.handRx + 3) ($a.headTop - 8) 4 3 $ramp.shadow
  Set-Pixel $bmp ($a.handRx + 5) ($a.headTop - 8) $ramp.high
}
function Weapon-Mace { param($bmp, $a, $ramp)
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 12) ($a.handY + 2) 2 $MAT_WOOD_DARK
  Shade-Disc $bmp ($a.handRx + 2) ($a.handY - 13) 3 $ramp -RimLight
  # Mace spikes
  Set-Pixel $bmp ($a.handRx + 2) ($a.handY - 16) $ramp.top
  Set-Pixel $bmp ($a.handRx - 1) ($a.handY - 13) $ramp.high
  Set-Pixel $bmp ($a.handRx + 5) ($a.handY - 13) $ramp.high
}
function Weapon-Cutlass { param($bmp, $a, $ramp)
  Draw-Blade $bmp ($a.handRx + 2) ($a.handY - 14) ($a.handY + 1) 3 $ramp -Fuller
  Fill-Box $bmp ($a.handRx - 1) ($a.handY) 9 2 $MAT_BRONZE.base
  # Curved guard
  Set-Pixel $bmp ($a.handRx + 7) ($a.handY - 1) $MAT_BRONZE.high
  Set-Pixel $bmp ($a.handRx + 8) ($a.handY) $MAT_BRONZE.shadow
}
function Weapon-Club { param($bmp, $a, $ramp)
  Draw-Shaft $bmp ($a.handRx + 2) ($a.handY - 10) ($a.handY + 2) 3 $MAT_WOOD_DARK
  Fill-Box $bmp ($a.handRx + 1) ($a.handY - 12) 5 3 $MAT_WOOD_DARK.deep
}
function Weapon-Lute { param($bmp, $a, $ramp)
  Shade-Oval $bmp ($a.handRx + 3) ($a.handY) 4 5 $MAT_WOOD_LIGHT
  Line-Pixel $bmp ($a.handRx + 3) ($a.handY - 4) ($a.handRx + 3) ($a.handY - 10) $MAT_WOOD_DARK.base
  Set-Pixel $bmp ($a.handRx + 3) ($a.handY - 1) (Color-FromHex '#08080c')
}

function Place-Weapon {
  param($bmp, $a, [string]$w, $rarityRamp = $null)
  $ramp = if ($rarityRamp) { $rarityRamp } else { $MAT_STEEL }
  switch ($w) {
    'sword'    { Weapon-Sword    $bmp $a $ramp; break }
    'dagger'   { Weapon-Dagger   $bmp $a $ramp; break }
    'axe'      { Weapon-Axe      $bmp $a $ramp; break }
    'hammer'   { Weapon-Hammer   $bmp $a $ramp; break }
    'staff'    { Weapon-Staff    $bmp $a $ramp; break }
    'orb'      { Weapon-Orb      $bmp $a $ramp; break }
    'bow'      { Weapon-Bow      $bmp $a $MAT_WOOD_DARK; break }
    'crossbow' { Weapon-Crossbow $bmp $a $ramp; break }
    'halberd'  { Weapon-Halberd  $bmp $a $ramp; break }
    'mace'     { Weapon-Mace     $bmp $a $ramp; break }
    'cutlass'  { Weapon-Cutlass  $bmp $a $ramp; break }
    'club'     { Weapon-Club     $bmp $a $ramp; break }
    'lute'     { Weapon-Lute     $bmp $a $ramp; break }
    default    { } # no weapon
  }
}

# ── Rarity-scaled adornments ─────────────────────────────────────────
#
# CARD-GAME-DESIGN.md §15.2 — common = bare; uncommon = +sigil pip;
# rare = +gem + emblem stripe + rim light; legendary = +halo + sigil
# aura + double rim. Halo is applied centrally by Render-Card, so we
# only paint the figure-level adornments here.

function Adorn-ByRarity {
  param($bmp, [string]$rarity, $palette, $skin, [int]$variantSeed)
  if ($rarity -eq 'common') { return }
  $accent = Rarity-Accent $rarity
  if ($rarity -eq 'uncommon') {
    # Single sigil pip in the lower-left corner
    Set-Pixel $bmp 4 70 $accent
    Set-Pixel $bmp 5 70 (With-Alpha $accent 180)
    Set-Pixel $bmp 4 71 (With-Alpha $accent 180)
  } elseif ($rarity -eq 'rare' -or $rarity -eq 'legendary') {
    # Accent gem in lower-left; emblem stripe along bottom
    $gem = Gem-Palette ($palette.base.ToString())
    Draw-Gem $bmp 5 72 3 $gem
    # Emblem stripe (rarity-tinted) along the very bottom
    for ($x = 8; $x -lt 56; $x += 2) {
      Set-Pixel $bmp $x 79 (With-Alpha $accent 150)
    }
    # Double-rim hint for legendaries (the halo pulse does the rest)
    if ($rarity -eq 'legendary') {
      for ($x = 0; $x -lt 64; $x += 4) {
        Blend-Pixel $bmp $x 0 (With-Alpha $accent 90)
        Blend-Pixel $bmp $x 79 (With-Alpha $accent 90)
      }
    }
  }
}

# ── Family templates ────────────────────────────────────────────────
#
# Each takes ($bmp, $manifestEntry) and paints a 64×80 subject. They
# rely entirely on existing lib-pixel primitives + the weapon helpers
# above, so a single ~30-line function covers an entire family of
# 30-50 cards.

function Family-Humanoid { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $skin = Skin-Lookup $m.skin
  $pal  = Palette-Lookup $m.palette
  $a = Draw-Humanoid $bmp $skin $pal -accent (Rarity-Accent $m.rarity)
  if ($m.weapon) { Place-Weapon $bmp $a $m.weapon $pal }
}

function Family-HumanoidSmall { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $skin = Skin-Lookup $m.skin
  $pal  = Palette-Lookup $m.palette
  # Shorter, stockier — head lower, smaller torso
  $a = Draw-Humanoid $bmp $skin $pal -headY 28 -headR 6 -torsoW 16 -torsoH 18 -legH 12 -accent (Rarity-Accent $m.rarity)
  if ($m.weapon) { Place-Weapon $bmp $a $m.weapon $pal }
  # Tiny dot eyes — already drawn, but give one a glint for menace
  Set-Pixel $bmp ($CARD_CX - 2) ($a.headY) (Color-FromHex '#f8514a')
}

function Family-HumanoidArmor { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $skin = Skin-Lookup $m.skin
  $pal  = Palette-Lookup $m.palette
  $a = Draw-Humanoid $bmp $skin $pal -accent $MAT_GOLD.base
  # Helm — full closed visor
  Fill-Box $bmp ($CARD_CX - 7) ($a.headTop - 3) 14 5 $pal.shadow
  for ($x = $CARD_CX - 7; $x -le $CARD_CX + 6; $x++) {
    Set-Pixel $bmp $x ($a.headTop - 3) $pal.high
  }
  # Visor slit
  Fill-Box $bmp ($CARD_CX - 4) ($a.headY - 1) 9 2 (Color-FromHex '#040408')
  Set-Pixel $bmp ($CARD_CX - 2) ($a.headY) $MAT_GOLD.top
  Set-Pixel $bmp ($CARD_CX + 2) ($a.headY) $MAT_GOLD.top
  # Pauldrons (shoulder plates)
  Shade-Disc $bmp ($CARD_CX - 9) ($a.torsoY + 1) 3 $pal -RimLight
  Shade-Disc $bmp ($CARD_CX + 9) ($a.torsoY + 1) 3 $pal -RimLight
  if ($m.weapon) { Place-Weapon $bmp $a $m.weapon $pal }
}

function Family-HumanoidRobed { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $skin = Skin-Lookup $m.skin
  $pal  = Palette-Lookup $m.palette
  # Robe — larger torso, no legs visible (robe sweep)
  $a = Draw-Humanoid $bmp $skin $pal -torsoH 28 -legH 4 -accent (Rarity-Accent $m.rarity)
  # Hood — overhanging cowl
  for ($i = 0; $i -lt 5; $i++) {
    $w = 14 - $i
    $x0 = $CARD_CX - [int]($w / 2)
    Fill-Box $bmp $x0 ($a.headTop - 2 + $i) $w 1 $pal.deep
    Set-Pixel $bmp $x0 ($a.headTop - 2 + $i) $pal.shadow
    Set-Pixel $bmp ($x0 + $w - 1) ($a.headTop - 2 + $i) $pal.base
  }
  if ($m.weapon) { Place-Weapon $bmp $a $m.weapon $pal }
}

function Family-HumanoidSkeletal { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $pal  = Palette-Lookup $m.palette
  $a = Draw-Humanoid $bmp $SKIN_BONE $pal -accent (Rarity-Accent $m.rarity)
  # Hollow eye sockets (overdraw the default eyes with deeper shadow)
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY $SKIN_BONE.deep
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY $SKIN_BONE.deep
  Set-Pixel $bmp ($CARD_CX - 2) ($a.headY - 1) $SKIN_BONE.shadow
  Set-Pixel $bmp ($CARD_CX + 2) ($a.headY - 1) $SKIN_BONE.shadow
  # Rib lines on torso
  for ($r = 0; $r -lt 3; $r++) {
    Line-Pixel $bmp ($CARD_CX - 6) ($a.torsoY + 4 + $r * 3) ($CARD_CX + 6) ($a.torsoY + 4 + $r * 3) $SKIN_BONE.deep
  }
  if ($m.weapon) { Place-Weapon $bmp $a $m.weapon $pal }
}

function Family-Beast { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 16
  $skin = Skin-Lookup $m.skin
  # Quadruped silhouette — body ellipse + 4 legs + head
  Shade-Oval $bmp $CARD_CX 50 16 8 $skin
  # Head — left side
  Shade-Disc $bmp 18 40 6 $skin -RimLight
  Set-Pixel $bmp 15 40 (Color-FromHex '#040408')
  Set-Pixel $bmp 16 39 (Color-FromHex '#f0c050')
  # Ears
  Fill-Box $bmp 14 34 3 3 $skin.shadow
  Set-Pixel $bmp 15 34 $skin.high
  Fill-Box $bmp 21 34 3 3 $skin.shadow
  # Legs (4)
  Fill-Box $bmp 24 56 3 8 $skin.shadow
  Fill-Box $bmp 30 58 3 8 $skin.shadow
  Fill-Box $bmp 40 56 3 8 $skin.shadow
  Fill-Box $bmp 46 58 3 8 $skin.shadow
  Set-Pixel $bmp 24 56 $skin.high
  Set-Pixel $bmp 40 56 $skin.high
  # Tail
  Line-Pixel $bmp 48 48 56 38 $skin.base
}

function Family-BeastSmall { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 8
  $skin = Skin-Lookup $m.skin
  # Tiny vermin — squat body, small head, tail
  Shade-Oval $bmp $CARD_CX 60 8 4 $skin
  Shade-Disc $bmp ($CARD_CX - 6) 56 3 $skin -RimLight
  # Red eye
  Set-Pixel $bmp ($CARD_CX - 7) 56 (Color-FromHex '#f8514a')
  # Tail
  Line-Pixel $bmp ($CARD_CX + 6) 60 ($CARD_CX + 14) 50 $skin.shadow
  # Tiny feet
  Fill-Box $bmp ($CARD_CX - 4) 64 2 2 $skin.deep
  Fill-Box $bmp ($CARD_CX) 64 2 2 $skin.deep
  Fill-Box $bmp ($CARD_CX + 4) 64 2 2 $skin.deep
}

function Family-CreatureElemental { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $pal = Palette-Lookup $m.palette
  # Roiling body — concentric ovals
  Shade-Oval $bmp $CARD_CX 48 16 18 $pal
  Shade-Oval $bmp $CARD_CX 42 10 12 @{ deep = $pal.shadow; shadow = $pal.base; base = $pal.high; high = $pal.top; top = $pal.top }
  # Two glowing eyes
  Set-Pixel $bmp ($CARD_CX - 4) 42 $pal.top
  Set-Pixel $bmp ($CARD_CX + 4) 42 $pal.top
  Set-Pixel $bmp ($CARD_CX - 5) 42 (With-Alpha $pal.top 200)
  Set-Pixel $bmp ($CARD_CX + 5) 42 (With-Alpha $pal.top 200)
  # Wisps / extrusions
  for ($i = 0; $i -lt 5; $i++) {
    $x = $CARD_CX + (Rng-Pick 17) - 8
    $y = 30 + (Rng-Pick 8)
    Blend-Pixel $bmp $x $y (With-Alpha $pal.high 180)
  }
}

function Family-CreatureTree { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 14
  $pal = Palette-Lookup $m.palette
  $foliage = $NATURE
  # Trunk
  Fill-Box $bmp ($CARD_CX - 6) 40 12 38 $pal.base
  for ($y = 40; $y -lt 78; $y++) {
    Set-Pixel $bmp ($CARD_CX - 6) $y $pal.high
    Set-Pixel $bmp ($CARD_CX + 5) $y $pal.shadow
  }
  # Knothole eyes
  Set-Pixel $bmp ($CARD_CX - 3) 55 (Color-FromHex '#fff0a0')
  Set-Pixel $bmp ($CARD_CX + 3) 55 (Color-FromHex '#fff0a0')
  # Foliage crown
  Shade-Oval $bmp $CARD_CX 28 18 12 $foliage
  Shade-Oval $bmp ($CARD_CX - 8) 32 8 8 $foliage
  Shade-Oval $bmp ($CARD_CX + 8) 30 8 8 $foliage
  # Branch arms
  Line-Pixel $bmp ($CARD_CX - 6) 48 ($CARD_CX - 16) 42 $pal.shadow
  Line-Pixel $bmp ($CARD_CX + 6) 48 ($CARD_CX + 16) 42 $pal.shadow
}

function Family-CreatureGolem { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 16
  $pal = Palette-Lookup $m.palette
  # Big blocky body
  Shade-Box $bmp ($CARD_CX - 12) 36 24 30 $pal -RimLight
  # Smaller head block
  Shade-Box $bmp ($CARD_CX - 7) 22 14 14 $pal -RimLight
  # Eye slits
  Fill-Box $bmp ($CARD_CX - 5) 29 4 2 (Color-FromHex '#040408')
  Fill-Box $bmp ($CARD_CX + 1) 29 4 2 (Color-FromHex '#040408')
  Set-Pixel $bmp ($CARD_CX - 4) 30 (Color-FromHex '#6ec0ff')
  Set-Pixel $bmp ($CARD_CX + 2) 30 (Color-FromHex '#6ec0ff')
  # Rune cores on chest (rarity gem)
  $gem = Gem-Palette 'voltaic'
  Draw-Gem $bmp $CARD_CX 50 5 $gem
  # Arm-blocks
  Shade-Box $bmp ($CARD_CX - 18) 40 6 18 $pal
  Shade-Box $bmp ($CARD_CX + 12) 40 6 18 $pal
  # Leg-blocks
  Shade-Box $bmp ($CARD_CX - 8) 66 6 12 $pal
  Shade-Box $bmp ($CARD_CX + 2) 66 6 12 $pal
}

function Family-CreatureDragon { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 18
  $pal = Palette-Lookup $m.palette
  # Big body curve
  Shade-Oval $bmp $CARD_CX 52 18 14 $pal
  # Head — left side, long snout
  Shade-Oval $bmp 18 36 8 5 $pal
  Fill-Box $bmp 10 35 8 4 $pal.shadow
  Set-Pixel $bmp 10 36 $pal.high
  Set-Pixel $bmp 11 35 $pal.top
  # Eye
  Set-Pixel $bmp 16 36 (Color-FromHex '#fff0a0')
  Set-Pixel $bmp 16 35 (Color-FromHex '#fff0a0')
  # Wings (folded)
  for ($i = 0; $i -lt 8; $i++) {
    Line-Pixel $bmp ($CARD_CX + 4) (38 + $i) ($CARD_CX + 18 - $i) (44 + $i) (With-Alpha $pal.shadow 220)
  }
  # Horns
  Line-Pixel $bmp 18 31 20 26 $pal.deep
  Line-Pixel $bmp 21 31 23 26 $pal.deep
  # Tail
  Line-Pixel $bmp 50 56 60 44 $pal.shadow
  # Legs
  Fill-Box $bmp ($CARD_CX - 8) 64 4 12 $pal.shadow
  Fill-Box $bmp ($CARD_CX + 4) 64 4 12 $pal.shadow
}

function Family-CreatureZombie { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 12
  $skin = Skin-Lookup $m.skin
  $pal = Palette-Lookup $m.palette
  $a = Draw-Humanoid $bmp $skin $pal
  # Slouched / asymmetric — repaint one arm dropped
  Fill-Box $bmp ($a.handLx - 1) ($a.handY + 4) 3 6 $skin.shadow
  # Hollow eye + drool
  Set-Pixel $bmp ($CARD_CX - 2) $a.headY (Color-FromHex '#fff0a0')
  Set-Pixel $bmp ($CARD_CX + 2) $a.headY $skin.deep
  Set-Pixel $bmp ($CARD_CX) ($a.headY + 3) (Color-FromHex '#94c850')
}

function Family-CreatureWisp { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $pal = Palette-Lookup $m.palette
  # Central orb
  Shade-Disc $bmp $CARD_CX 38 9 $pal -RimLight
  # Trailing wisps below
  for ($i = 0; $i -lt 8; $i++) {
    $w = 6 - [int]($i * 0.7)
    if ($w -lt 1) { $w = 1 }
    $x0 = $CARD_CX - [int]($w / 2)
    $y = 50 + $i * 2
    for ($x = $x0; $x -lt $x0 + $w; $x++) {
      Blend-Pixel $bmp $x $y (With-Alpha $pal.high (180 - $i * 18))
    }
  }
  # Glowing eyes / heart-pixel
  Set-Pixel $bmp ($CARD_CX - 2) 36 $pal.top
  Set-Pixel $bmp ($CARD_CX + 2) 36 $pal.top
}

function Family-CreatureImp { param($bmp, $m)
  Rng-Init $m.id
  Draw-GroundShadow-Card $bmp $CARD_CX ($GROUND_Y + 1) 10
  $skin = Skin-Lookup $m.skin
  $pal  = Palette-Lookup $m.palette
  # Stocky body
  Shade-Oval $bmp $CARD_CX 52 10 9 $skin
  # Head
  Shade-Disc $bmp $CARD_CX 36 7 $skin -RimLight
  # Horns
  Line-Pixel $bmp ($CARD_CX - 4) 30 ($CARD_CX - 6) 25 $skin.deep
  Line-Pixel $bmp ($CARD_CX + 4) 30 ($CARD_CX + 6) 25 $skin.deep
  # Glowing eyes
  Set-Pixel $bmp ($CARD_CX - 2) 36 (Color-FromHex '#fff0a0')
  Set-Pixel $bmp ($CARD_CX + 2) 36 (Color-FromHex '#fff0a0')
  # Mouth — fangs
  Fill-Box $bmp ($CARD_CX - 2) 39 5 1 (Color-FromHex '#040408')
  Set-Pixel $bmp ($CARD_CX - 1) 40 $MAT_BONE.high
  Set-Pixel $bmp ($CARD_CX + 1) 40 $MAT_BONE.high
  # Wings
  for ($i = 0; $i -lt 5; $i++) {
    Line-Pixel $bmp ($CARD_CX - 10 - $i) (45 + $i) ($CARD_CX - 6) (43 + $i) (With-Alpha $pal.shadow 200)
    Line-Pixel $bmp ($CARD_CX + 10 + $i) (45 + $i) ($CARD_CX + 6) (43 + $i) (With-Alpha $pal.shadow 200)
  }
  # Tail
  Line-Pixel $bmp ($CARD_CX) 62 ($CARD_CX + 8) 70 $skin.shadow
  Set-Pixel $bmp ($CARD_CX + 9) 71 (Color-FromHex '#f8514a')
}

# Shim: $MAT_BONE is referenced by Family-CreatureImp; alias to the bone skin
$MAT_BONE = $SKIN_BONE

# ── Spell glyphs ────────────────────────────────────────────────────
#
# Spells don't draw a figure — they paint a school-specific glyph
# centred on a magic circle.

function Spell-Glyph { param($bmp, $m)
  Rng-Init $m.id
  $pal = Palette-Lookup $m.palette
  $cx = $CARD_CX; $cy = 40
  # Magic circle backdrop
  Draw-MagicCircle $bmp $cx $cy 22 $pal.high 100 -Runes
  switch ($m.glyph) {
    'flame' {
      Draw-Flame $bmp $cx ($cy + 14) 22 $pal
    }
    'crystal' {
      $gem = Gem-Palette 'sapphire'
      Draw-Gem $bmp $cx $cy 11 $gem
      # Frost spikes
      Line-Pixel $bmp $cx ($cy - 20) $cx ($cy + 18) (With-Alpha $pal.top 220)
      Line-Pixel $bmp ($cx - 14) $cy ($cx + 14) $cy (With-Alpha $pal.top 220)
    }
    'cross' {
      Draw-HealCross $bmp $cx $cy 16 $HOLY
      # Glow
      Shade-Disc $bmp $cx $cy 4 @{ deep=$HOLY.deep; shadow=$HOLY.shadow; base=$HOLY.high; high=$HOLY.top; top=$HOLY.top }
    }
    'skull' {
      Shade-Disc $bmp $cx ($cy - 2) 9 $SKIN_BONE -RimLight
      Fill-Box $bmp ($cx - 4) ($cy - 1) 3 3 (Color-FromHex '#08080c')
      Fill-Box $bmp ($cx + 1) ($cy - 1) 3 3 (Color-FromHex '#08080c')
      Fill-Box $bmp ($cx - 1) ($cy + 4) 3 2 (Color-FromHex '#08080c')
      Set-Pixel $bmp ($cx - 3) $cy (Color-FromHex '#f8514a')
      Set-Pixel $bmp ($cx + 2) $cy (Color-FromHex '#f8514a')
    }
    'leaf' {
      # Stylised leaf — drawn as two arcs
      Shade-Oval $bmp $cx $cy 10 16 $NATURE
      Line-Pixel $bmp $cx ($cy - 16) $cx ($cy + 16) $NATURE.deep
      for ($i = 0; $i -lt 6; $i++) {
        Line-Pixel $bmp $cx ($cy - 12 + $i * 5) ($cx - 6 + $i) ($cy - 12 + $i * 5 + 3) $NATURE.shadow
        Line-Pixel $bmp $cx ($cy - 12 + $i * 5) ($cx + 6 - $i) ($cy - 12 + $i * 5 + 3) $NATURE.shadow
      }
    }
    'sigil' {
      # Concentric circles + cardinal runes already drawn — add a bright
      # core glyph
      Draw-Gem $bmp $cx $cy 7 (Gem-Palette 'amethyst')
      Set-Pixel $bmp $cx ($cy - 18) $pal.top
      Set-Pixel $bmp $cx ($cy + 18) $pal.top
      Set-Pixel $bmp ($cx - 18) $cy $pal.top
      Set-Pixel $bmp ($cx + 18) $cy $pal.top
    }
    'bolt' {
      # Big jagged lightning bolt — top to bottom
      Draw-Bolt $bmp ($cx - 8) ($cy - 18) ($cx + 8) ($cy + 18) $pal.top $pal.high
      Draw-Bolt $bmp ($cx + 6) ($cy - 12) ($cx - 4) ($cy + 12) $pal.high $pal.base
    }
    default {
      Draw-Gem $bmp $cx $cy 7 (Gem-Palette 'voltaic')
    }
  }
}

# ── Family dispatcher ───────────────────────────────────────────────

function Family-Dispatch {
  param($bmp, $m)
  $t = $m.template
  if (-not $t -and $m.family -eq 'spell') { $t = 'spell' }
  switch ($t) {
    'humanoid'             { Family-Humanoid          $bmp $m; break }
    'humanoid-small'       { Family-HumanoidSmall     $bmp $m; break }
    'humanoid-armor'       { Family-HumanoidArmor     $bmp $m; break }
    'humanoid-robed'       { Family-HumanoidRobed     $bmp $m; break }
    'humanoid-skeletal'    { Family-HumanoidSkeletal  $bmp $m; break }
    'beast'                { Family-Beast             $bmp $m; break }
    'beast-small'          { Family-BeastSmall        $bmp $m; break }
    'creature-elemental'   { Family-CreatureElemental $bmp $m; break }
    'creature-tree'        { Family-CreatureTree      $bmp $m; break }
    'creature-golem'       { Family-CreatureGolem     $bmp $m; break }
    'creature-dragon'      { Family-CreatureDragon    $bmp $m; break }
    'creature-zombie'      { Family-CreatureZombie    $bmp $m; break }
    'creature-wisp'        { Family-CreatureWisp      $bmp $m; break }
    'creature-imp'         { Family-CreatureImp       $bmp $m; break }
    'spell'                { Spell-Glyph              $bmp $m; break }
    default {
      # Unknown template — fall back to a generic humanoid so the
      # sprite at least exists. Logged so we can audit later.
      Family-Humanoid $bmp $m
    }
  }
  Adorn-ByRarity $bmp $m.rarity (Palette-Lookup $m.palette) (Skin-Lookup $m.skin) (NameSeed $m.id)
}

# ── Render-Card (manifest-aware) ────────────────────────────────────
#
# Replaces the legacy Render-Card. For each card:
#   1. If a $CARD_DRAW entry exists (hand-curated), use that.
#   2. Else dispatch to the family template.
#   3. Apply rarity glow.
#   4. For legendaries: emit 4 halo-pulse frames for the APNG stitch.

function Render-CardX {
  param($m)   # manifest entry
  if ($m.token) { return }    # tokens already drawn by hand-curated set
  $cardId = $m.id
  $rarity = $m.rarity

  $drawer = $null
  if ($CARD_DRAW.ContainsKey($cardId)) { $drawer = $CARD_DRAW[$cardId] }

  $renderFigure = {
    param($bmp)
    if ($drawer) {
      & $drawer $bmp
    } else {
      Family-Dispatch $bmp $m
    }
  }

  if ($rarity -eq 'legendary') {
    for ($f = 0; $f -lt 4; $f++) {
      $bmp = New-CanvasFx $CARD_W $CARD_H
      & $renderFigure $bmp
      $r = @(3, 4, 5, 4)[$f]
      $a = @(120, 160, 200, 160)[$f]
      Add-GlowHalo $bmp (Color-FromHex '#fff0a0') $r $a
      Save-CanvasFx $bmp (Join-Path $framesDir ("{0}-fx-{1}.png" -f $cardId, $f))
    }
    $bmp = New-CanvasFx $CARD_W $CARD_H
    & $renderFigure $bmp
    Add-GlowHalo $bmp (Color-FromHex '#fff0a0') 4 160
    Save-CanvasFx $bmp (Join-Path $cardDir ("{0}.png" -f $cardId))
    return
  }

  $bmp = New-CanvasFx $CARD_W $CARD_H
  & $renderFigure $bmp
  Apply-Card-Glow $bmp $rarity
  Save-CanvasFx $bmp (Join-Path $cardDir ("{0}.png" -f $cardId))
}

# ── Build pass (manifest-driven) ────────────────────────────────────

function Build-CardsX {
  $manifest = Load-Manifest
  if (-not $manifest) {
    # Legacy fallback — render the original 82 hand-curated cards.
    $count = 0
    foreach ($cardId in $CARD_META.Keys) {
      $meta = $CARD_META[$cardId]
      if (-not (Want $meta.pass)) { continue }
      Render-Card $cardId
      $count++
    }
    Write-Host ("  cards rendered (legacy): {0}" -f $count) -ForegroundColor Green
    return
  }
  $entries = $manifest.cards
  if ($IdsFile -and (Test-Path $IdsFile)) {
    $wanted = @{}
    Get-Content $IdsFile | ForEach-Object { $wanted[$_.Trim()] = $true }
    $entries = $entries | Where-Object { $wanted.ContainsKey($_.id) }
    Write-Host ("  filtered by IdsFile: {0} cards" -f $entries.Count) -ForegroundColor Yellow
  }
  if ($Skip -gt 0) { $entries = $entries | Select-Object -Skip $Skip }
  if ($Take -gt 0) { $entries = $entries | Select-Object -First $Take }

  $total = $entries.Count
  Write-Host ("  rendering {0} cards from manifest…" -f $total) -ForegroundColor Cyan
  $count = 0
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  foreach ($m in $entries) {
    if ($m.token) { continue }   # tokens drawn by hand-curated set
    Render-CardX $m
    $count++
    if (($count % 50) -eq 0) {
      $pct = [int](($count / $total) * 100)
      $eta = if ($count -gt 0) { [int](($sw.Elapsed.TotalSeconds / $count) * ($total - $count)) } else { 0 }
      Write-Host ("    {0}/{1} ({2}%) eta {3}s" -f $count, $total, $pct, $eta) -ForegroundColor DarkGray
    }
  }
  $sw.Stop()
  Write-Host ("  cards rendered: {0} in {1:n1}s" -f $count, $sw.Elapsed.TotalSeconds) -ForegroundColor Green
}

Write-Host '── Boltbound card sprites ──' -ForegroundColor Cyan
Build-CardsX
Write-Host 'Done.' -ForegroundColor Green
