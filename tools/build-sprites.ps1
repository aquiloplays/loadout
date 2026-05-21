# Procedural HD pixel-art sprite generator for the Loadout character +
# gear + pet system.
#
# Phase-4 quality bar (Clay 2026-05-21): larger canvas (64×80),
# 5-tone material ramps, single upper-left light source with rim
# light, surface detail (fullers / grain / rivets / facets), genuine
# material distinction (metal / wood / cloth / leather / gem), and
# proper glow auras for legendary tier. Significantly higher fidelity
# than the original 40×56 pass.
#
# Output paths (committed to git):
#   aquilo-gg/sprites/figure/body-<bodyType>-<skinTone>.png
#   aquilo-gg/sprites/figure/hair-<style>.png   (palette-swapped at render)
#   aquilo-gg/sprites/figure/eyes-<color>.png
#   aquilo-gg/sprites/figure/accent-<name>.png
#   aquilo-gg/sprites/gear/<slot>/<id>.png
#   aquilo-gg/sprites/pet/<species>-<color>.png  (or .apng for animated)
#   aquilo-gg/sprites/gear/fx/<slug>.png         (legendary halo APNG)
#
# Canvas: 64×80. Figure footprint 36×60 anchored x:14..49 / y:20..79.
# Headroom above (rows 0..19) carries tall hair, plumes, helmets.
#
# To regenerate from scratch:
#   pwsh -ExecutionPolicy Bypass -File tools/build-sprites.ps1
#   node tools/build-apng.mjs               # stitch legendary halo APNGs

[CmdletBinding()]
param(
  [string]$OutRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'aquilo-gg/sprites'),
  [int]$CanvasW   = 64,
  [int]$CanvasH   = 80,
  [int]$FigureW   = 36,
  [int]$FigureH   = 60,
  [string]$Only   = ''     # comma list: figure,defaultclothing,hair,eyes,accent,weapons,head,chest,legs,boots,trinket,pets,legendary,moods
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib-pixel.ps1')

# ── Paths ──────────────────────────────────────────────────────────
$figDir  = Join-Path $OutRoot 'figure'
$gearDir = Join-Path $OutRoot 'gear'
$petDir  = Join-Path $OutRoot 'pet'
foreach ($d in @($figDir, $gearDir, $petDir,
                  (Join-Path $gearDir 'weapon'), (Join-Path $gearDir 'head'),
                  (Join-Path $gearDir 'chest'),  (Join-Path $gearDir 'legs'),
                  (Join-Path $gearDir 'boots'),  (Join-Path $gearDir 'trinket'))) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# ── Figure geometry constants ──────────────────────────────────────
# Anchored to canvas; gear functions use these to align grips, head
# slots, chest seam, etc. character.js's compositor stacks layers
# pixel-perfect (no offsets) so every sprite is the same size and any
# part of the layer outside the figure footprint shows through.
$FIG_OX   = [int](($CanvasW - $FigureW) / 2)    # = 14
$FIG_OY   = $CanvasH - $FigureH                 # = 20  (figure top)
$HEAD_X   = $FIG_OX + 10                        # = 24
$HEAD_W   = 16
$HEAD_Y   = $FIG_OY                             # = 20
$HEAD_H   = 18
$NECK_X   = $FIG_OX + 15                        # = 29
$NECK_W   = 6
$NECK_Y   = $HEAD_Y + $HEAD_H                   # = 38
$TORSO_X  = $FIG_OX + 6                         # = 20  (stocky) — slim narrows by 2 each side
$TORSO_W  = 24
$TORSO_Y  = $NECK_Y + 1                         # = 39
$TORSO_H  = 22
$ARM_W    = 3
$ARM_LX   = $FIG_OX + 3                         # left arm: 17..19
$ARM_RX   = $FIG_OX + 30                        # right arm: 44..46
$ARM_Y    = $TORSO_Y + 1                        # = 40
$ARM_H    = 17
$HAND_W   = 4
$HAND_LX  = $FIG_OX + 2                         # 16..19
$HAND_RX  = $FIG_OX + 30                        # 44..47
$HAND_Y   = $ARM_Y + $ARM_H                     # = 57
$LEG_Y    = $TORSO_Y + $TORSO_H                 # = 61
$LEG_W    = 6
$LEG_GAP  = 2
$LEG_LX   = $FIG_OX + 10                        # 24..29
$LEG_RX   = $LEG_LX + $LEG_W + $LEG_GAP         # 32..37
$LEG_H    = 13
$FOOT_Y   = $LEG_Y + $LEG_H                     # = 74
$FOOT_H   = 5                                   # row 74..78
$GRIP_X   = $HAND_RX + 1                        # = 45  weapon centre column
$GRIP_TOPY = $HAND_Y                            # weapon grip top
$GRIP_BOTY = $HAND_Y + 4                        # weapon grip bottom

function Want { param([string]$key) return ($Only -eq '') -or ($Only.Split(',') -contains $key) }

# ── Brand palette (for accents / glows) ────────────────────────────
# Already loaded from lib-pixel.ps1 as $BRAND.

# ── Skin / hair / eye palettes (5-tone HD ramps) ───────────────────
# Each entry is { deep; shadow; base; high; top }. Skin uses a
# warmer ramp than metal — slight saturation drop at the highlights
# so it doesn't read as plastic.
$SKIN_TONES = @{
  fair        = @{ deep='#9c6e4a'; shadow='#c89972'; base='#f4d7b8'; high='#ffe8d0'; top='#fff5e6' };
  porcelain   = @{ deep='#a08568'; shadow='#cab098'; base='#f0d6bc'; high='#ffe6cc'; top='#fff2dc' };
  rose        = @{ deep='#a25a4c'; shadow='#c88474'; base='#eebcad'; high='#fcd2c4'; top='#ffe2d6' };
  tan         = @{ deep='#6a4628'; shadow='#a07048'; base='#c89770'; high='#e7b894'; top='#f4d0aa' };
  olive       = @{ deep='#523816'; shadow='#80622e'; base='#b08c5a'; high='#cfa973'; top='#e0c08a' };
  bronze      = @{ deep='#42220a'; shadow='#7a4818'; base='#a86c39'; high='#c98a53'; top='#dfa66c' };
  umber       = @{ deep='#321a0a'; shadow='#5a3618'; base='#7c4b25'; high='#9e6438'; top='#b67a4a' };
  ebony       = @{ deep='#1a0e08'; shadow='#3a2316'; base='#52311e'; high='#6f4326'; top='#8a5832' };
  pale_violet = @{ deep='#6c5c80'; shadow='#9486a8'; base='#b6a8c8'; high='#d6c8e6'; top='#ecdcf6' };
  ash         = @{ deep='#42454e'; shadow='#6b6e78'; base='#8d909a'; high='#b2b5be'; top='#cdd0d8' };
}

# Hair authored against a reference "brown" 5-tone ramp; character.js
# palette-swaps to chosen hair colour at render time.
$HAIR_REF = @{
  deep   = '#22120b';
  shadow = '#3b251a';
  base   = '#5a3a26';
  high   = '#7a5236';
  top    = '#a07248';
}
$HAIR_COLOURS = @{
  brown   = $HAIR_REF;
  black   = @{ deep='#08080a'; shadow='#161618'; base='#2a2a30'; high='#42424a'; top='#5a5b66' };
  blonde  = @{ deep='#6c4e10'; shadow='#a37a30'; base='#d4a64a'; high='#f4d27a'; top='#fff0b8' };
  red     = @{ deep='#4a100a'; shadow='#7a2018'; base='#b53420'; high='#d8553a'; top='#f08060' };
  grey    = @{ deep='#3e424a'; shadow='#5f636c'; base='#878b95'; high='#b3b8c2'; top='#d2d6de' };
  white   = @{ deep='#a4a8b2'; shadow='#c8ccd6'; base='#e6e9ef'; high='#ffffff'; top='#ffffff' };
  violet  = @{ deep='#3a2880'; shadow='#5a40b0'; base='#7c5cff'; high='#a890ff'; top='#cdb8ff' };
  teal    = @{ deep='#1a5a4a'; shadow='#2f8a78'; base='#5fc4a8'; high='#92e6cd'; top='#bdf5e0' };
  pink    = @{ deep='#852048'; shadow='#c14688'; base='#e87ab0'; high='#ffabcf'; top='#ffd0e2' };
  mint    = @{ deep='#22784a'; shadow='#3da76c'; base='#5be098'; high='#90ffc4'; top='#c4ffe0' };
  silver  = @{ deep='#525868'; shadow='#7a8090'; base='#a8afbc'; high='#d4d8e0'; top='#eef0f5' };
  copper  = @{ deep='#68260a'; shadow='#9c4a1f'; base='#cf7240'; high='#f09866'; top='#ffb88a' };
  navy    = @{ deep='#0a1230'; shadow='#172046'; base='#293a78'; high='#3e539c'; top='#5a72c0' };
  forest  = @{ deep='#0a2410'; shadow='#1a3a20'; base='#2e5c34'; high='#4b8550'; top='#74a878' };
}
$EYE_COLOURS = @{
  brown  = '#5a3a18';
  blue   = '#3a86ff';
  green  = '#46d160';
  hazel  = '#8a6a30';
  amber  = '#e8a830';
  violet = '#9a82ff';
  silver = '#a8b0bc';
  pink   = '#e87ab0';
}

# Ramp-from-hash helper for palette table.
function Tone-FromHash {
  param($hashtable, [string]$key)
  if (-not $hashtable.ContainsKey($key)) { return $null }
  $entry = $hashtable[$key]
  return @{
    deep   = Color-FromHex $entry.deep;
    shadow = Color-FromHex $entry.shadow;
    base   = Color-FromHex $entry.base;
    high   = Color-FromHex $entry.high;
    top    = Color-FromHex $entry.top;
  }
}

# ══════════════════════════════════════════════════════════════════
#                       FIGURE — body
# ══════════════════════════════════════════════════════════════════

# Draws the base humanoid silhouette. Body anatomy at HD fidelity:
# rounded head (oval shade), tapered torso, articulated arms with
# elbow + hand definition, defined legs with knee suggestion.
function Draw-Body {
  param($bmp, [string]$bodyType, $skinRamp)
  $ink = $BRAND.Ink
  $slim = ($bodyType -eq 'slim')

  $torsoX  = if ($slim) { $TORSO_X + 2 } else { $TORSO_X }
  $torsoW  = if ($slim) { $TORSO_W - 4 } else { $TORSO_W }
  # Arms hug the torso edge for both body types
  $armLX   = if ($slim) { $ARM_LX + 2 } else { $ARM_LX }
  $armRX   = if ($slim) { $ARM_RX - 2 } else { $ARM_RX }
  $handLX  = if ($slim) { $HAND_LX + 2 } else { $HAND_LX }
  $handRX  = if ($slim) { $HAND_RX - 2 } else { $HAND_RX }
  $headW   = if ($slim) { 14 } else { 16 }
  $headX   = [int](($CanvasW - $headW) / 2)

  # Head — oval volume with rim light
  $hCx = $headX + [int]($headW / 2)
  $hCy = $HEAD_Y + [int]($HEAD_H / 2)
  Shade-Oval $bmp $hCx $hCy ($headW * 0.52) ($HEAD_H * 0.52) $skinRamp
  # Cheek shadows — pull the face out of the round oval
  Set-Pixel $bmp ($headX + 1)              ($HEAD_Y + 10) $skinRamp.shadow
  Set-Pixel $bmp ($headX + $headW - 2)     ($HEAD_Y + 10) $skinRamp.shadow
  Set-Pixel $bmp ($headX + 1)              ($HEAD_Y + 11) $skinRamp.deep
  Set-Pixel $bmp ($headX + $headW - 2)     ($HEAD_Y + 11) $skinRamp.deep
  # Ear suggestions — small shaded notches on either side
  Set-Pixel $bmp $headX                    ($HEAD_Y + 9)  $skinRamp.shadow
  Set-Pixel $bmp $headX                    ($HEAD_Y + 10) $skinRamp.deep
  Set-Pixel $bmp ($headX + $headW - 1)     ($HEAD_Y + 9)  $skinRamp.shadow
  Set-Pixel $bmp ($headX + $headW - 1)     ($HEAD_Y + 10) $skinRamp.deep
  # Nose — single shadow pixel down centre below eye line
  Set-Pixel $bmp $hCx                      ($HEAD_Y + 11) $skinRamp.shadow
  Set-Pixel $bmp $hCx                      ($HEAD_Y + 12) $skinRamp.deep
  Set-Pixel $bmp ($hCx - 1)                ($HEAD_Y + 12) $skinRamp.shadow
  # Mouth — small lip line, slightly off-centre for character
  Set-Pixel $bmp ($hCx - 1)                ($HEAD_Y + 14) $skinRamp.deep
  Set-Pixel $bmp $hCx                      ($HEAD_Y + 14) $skinRamp.deep
  Set-Pixel $bmp ($hCx - 1)                ($HEAD_Y + 15) $skinRamp.shadow
  # Jaw shadow row to pull cheekbones forward
  for ($i = 0; $i -lt $headW - 2; $i++) {
    Set-Pixel $bmp ($headX + 1 + $i) ($HEAD_Y + $HEAD_H - 2) $skinRamp.shadow
  }
  # Slight chin highlight on left side
  Set-Pixel $bmp ($headX + 2) ($HEAD_Y + $HEAD_H - 3) $skinRamp.high

  # Neck — small tapered block, shadow-shifted (neck sits in head shadow)
  Fill-Box $bmp $NECK_X $NECK_Y $NECK_W 3 $skinRamp.shadow
  Set-Pixel $bmp $NECK_X $NECK_Y $skinRamp.base
  Set-Pixel $bmp ($NECK_X + $NECK_W - 1) $NECK_Y $skinRamp.deep
  # Collarbone hint
  Set-Pixel $bmp ($NECK_X + 1) ($NECK_Y + 2) $skinRamp.high

  # Torso — tapered slightly toward the waist
  for ($y = 0; $y -lt $TORSO_H; $y++) {
    $taper = [int]([Math]::Min(2, ($y / 8)))
    $w = $torsoW - $taper * 2
    $x = $torsoX + $taper
    Fill-Box $bmp $x ($TORSO_Y + $y) $w 1 $skinRamp.base
    # Edges
    Set-Pixel $bmp $x ($TORSO_Y + $y) $skinRamp.high
    Set-Pixel $bmp ($x + $w - 1) ($TORSO_Y + $y) $skinRamp.shadow
  }
  # Subtle chest highlight on upper-left
  for ($i = 0; $i -lt 4; $i++) {
    Set-Pixel $bmp ($torsoX + 2 + $i) ($TORSO_Y + 2) $skinRamp.high
  }
  # Pectoral / sternum shadow
  Set-Pixel $bmp ($torsoX + [int]($torsoW / 2)) ($TORSO_Y + 5) $skinRamp.shadow
  # Belly shading
  for ($i = 0; $i -lt 3; $i++) {
    Set-Pixel $bmp ($torsoX + [int]($torsoW / 2)) ($TORSO_Y + 10 + $i) $skinRamp.shadow
  }
  # Lower torso shadow row
  Fill-Box $bmp $torsoX ($TORSO_Y + $TORSO_H - 1) $torsoW 1 $skinRamp.shadow

  # Arms — tapered cylinders
  foreach ($side in @(@{x=$armLX; mirror=$false}, @{x=$armRX; mirror=$true})) {
    $ax = $side.x
    for ($y = 0; $y -lt $ARM_H; $y++) {
      $w = 3
      if ($y -ge 8) { $w = 2 }   # forearm thinner
      $offset = 0
      if ($y -ge 8 -and $side.mirror) { $offset = 1 }   # right forearm anchors right
      Fill-Box $bmp ($ax + $offset) ($ARM_Y + $y) $w 1 $skinRamp.base
      # Shading
      if ($side.mirror) {
        Set-Pixel $bmp ($ax + $offset) ($ARM_Y + $y) $skinRamp.high
        Set-Pixel $bmp ($ax + $offset + $w - 1) ($ARM_Y + $y) $skinRamp.shadow
      } else {
        Set-Pixel $bmp ($ax + $offset) ($ARM_Y + $y) $skinRamp.high
        Set-Pixel $bmp ($ax + $offset + $w - 1) ($ARM_Y + $y) $skinRamp.shadow
      }
    }
    # Shoulder cap — brighter pixel
    Set-Pixel $bmp ($ax + 1) $ARM_Y $skinRamp.top
    # Elbow shadow
    Set-Pixel $bmp ($ax + 1) ($ARM_Y + 7) $skinRamp.shadow
  }

  # Hands — 4x4 with a subtle thumb hint
  foreach ($side in @(@{x=$handLX; mirror=$false}, @{x=$handRX; mirror=$true})) {
    $hx = $side.x
    Fill-Box $bmp $hx $HAND_Y 3 4 $skinRamp.base
    Set-Pixel $bmp $hx $HAND_Y $skinRamp.high
    Set-Pixel $bmp ($hx + 2) ($HAND_Y + 3) $skinRamp.shadow
    Set-Pixel $bmp $hx ($HAND_Y + 3) $skinRamp.shadow
    # Thumb pixel
    if ($side.mirror) {
      Set-Pixel $bmp ($hx + 3) ($HAND_Y + 1) $skinRamp.base
      Set-Pixel $bmp ($hx + 3) ($HAND_Y + 2) $skinRamp.shadow
    } else {
      Set-Pixel $bmp ($hx - 1) ($HAND_Y + 1) $skinRamp.base
      Set-Pixel $bmp ($hx - 1) ($HAND_Y + 2) $skinRamp.shadow
    }
  }

  # Legs — tapered with knee highlight
  foreach ($side in @($LEG_LX, $LEG_RX)) {
    for ($y = 0; $y -lt $LEG_H; $y++) {
      $w = $LEG_W - [int]($y / 7)
      if ($w -lt 4) { $w = 4 }
      $x = $side + [int](($LEG_W - $w) / 2)
      Fill-Box $bmp $x ($LEG_Y + $y) $w 1 $skinRamp.base
      Set-Pixel $bmp $x ($LEG_Y + $y) $skinRamp.high
      Set-Pixel $bmp ($x + $w - 1) ($LEG_Y + $y) $skinRamp.shadow
    }
    # Knee highlight
    Set-Pixel $bmp ($side + 1) ($LEG_Y + 6) $skinRamp.top
    Set-Pixel $bmp ($side + 2) ($LEG_Y + 7) $skinRamp.shadow
  }

  # Feet — flesh-tone, will be covered by boots gear when equipped
  foreach ($side in @($LEG_LX, $LEG_RX)) {
    Fill-Box $bmp $side $FOOT_Y $LEG_W 4 $skinRamp.shadow
    for ($i = 0; $i -lt $LEG_W; $i++) {
      Set-Pixel $bmp ($side + $i) $FOOT_Y $skinRamp.base
    }
    Set-Pixel $bmp ($side + 1) $FOOT_Y $skinRamp.high
    # Toe / shoe-line shadow
    Fill-Box $bmp $side ($FOOT_Y + 3) $LEG_W 1 $skinRamp.deep
  }

  # Ground shadow — soft alpha ellipse beneath feet
  $shadow = With-Alpha (Color-FromHex '#080810') 150
  for ($i = -8; $i -le 8; $i++) {
    $a = 150 - [Math]::Abs($i) * 12
    if ($a -lt 30) { continue }
    Blend-Pixel $bmp (32 + $i) 79 (With-Alpha (Color-FromHex '#080810') $a)
  }
}

function Build-Figure {
  Write-Host '── Building figure bodies ──' -ForegroundColor Cyan
  $count = 0
  foreach ($body in @('slim','stocky')) {
    foreach ($skin in $SKIN_TONES.Keys) {
      $ramp = Tone-FromHash $SKIN_TONES $skin
      $bmp = New-CanvasFx $CanvasW $CanvasH
      Draw-Body $bmp $body $ramp
      Save-CanvasFx $bmp (Join-Path $figDir ("body-{0}-{1}.png" -f $body, $skin))
      $count++
    }
  }
  Write-Host "  figure bodies: $count" -ForegroundColor Green
}

# ── Default clothing ──────────────────────────────────────────────
# A single fixed-look figure layer that renders between the body
# (z=20) and any equipped chest/legs gear (z=30/40). Ensures a brand-
# new character with nothing equipped looks dressed (linen tunic +
# trousers) instead of standing in their underwear. Equipped chest
# gear paints over the tunic at rows 38..60; equipped legs gear
# paints over the trousers at rows 61..73 — so picking up a Hide Vest
# / Mithril Plate replaces the default tunic exactly the way it
# already replaces the bare-torso skin.
function Draw-DefaultClothing {
  param($bmp)
  $shirt = $MAT_CLOTH_LINEN
  $pants = @{
    deep   = (Color-FromHex '#2a1a08');
    shadow = (Color-FromHex '#4a3018');
    base   = (Color-FromHex '#6e4a24');
    high   = (Color-FromHex '#8e6238');
    top    = (Color-FromHex '#aa7c4c');
  }
  $transparent = [System.Drawing.Color]::FromArgb(0,0,0,0)

  # ── Tunic (rows 39..60, x = 20..43 — matches stocky torso) ──
  $cx = 32
  $top = 39
  $bot = 60
  $w = 24
  $hx = $cx - [int]($w / 2)
  $h = $bot - $top + 1
  Shade-Box $bmp $hx $top $w $h $shirt

  # Round the upper corners — softens the shirt into shoulders so
  # it doesn't read as a flat-topped sandwich-board.
  Set-Pixel $bmp $hx              $top $transparent
  Set-Pixel $bmp ($hx + $w - 1)   $top $transparent

  # V-neckline — 3-row triangular cut so the neck reads as "shirt
  # with collar" rather than "shirt that swallows the head".
  for ($i = 0; $i -lt 3; $i++) {
    $cw = 3 - $i
    if ($cw -le 0) { break }
    $cleft = $cx - [int]($cw / 2)
    for ($k = 0; $k -lt $cw; $k++) {
      Set-Pixel $bmp ($cleft + $k) ($top + $i) $transparent
    }
  }
  # Neckline trim — single shadow row around the V so the cut has
  # a clean edge against the body skin behind it.
  Set-Pixel $bmp ($cx - 2) $top       $shirt.deep
  Set-Pixel $bmp ($cx + 2) $top       $shirt.deep
  Set-Pixel $bmp ($cx - 2) ($top + 1) $shirt.shadow
  Set-Pixel $bmp ($cx + 2) ($top + 1) $shirt.shadow
  Set-Pixel $bmp ($cx - 1) ($top + 2) $shirt.shadow
  Set-Pixel $bmp ($cx + 1) ($top + 2) $shirt.shadow

  # Fold lines — subtle vertical drape suggestion every 4 rows.
  for ($y = $top + 4; $y -lt $bot; $y += 4) {
    Set-Pixel $bmp ($cx - 5) $y $shirt.shadow
    Set-Pixel $bmp ($cx + 5) $y $shirt.high
  }
  # Lace tie down the centre — two paired stitch dots.
  Set-Pixel $bmp ($cx - 1) ($top + 3) $shirt.deep
  Set-Pixel $bmp ($cx + 1) ($top + 3) $shirt.deep
  Set-Pixel $bmp ($cx - 1) ($top + 5) $shirt.deep
  Set-Pixel $bmp ($cx + 1) ($top + 5) $shirt.deep

  # Belt at the waist — one leather row + buckle.
  Fill-Box $bmp $hx ($bot - 1) $w 1 $MAT_LEATHER.shadow
  Fill-Box $bmp $hx $bot       $w 1 $MAT_LEATHER.deep
  Fill-Box $bmp ($cx - 1) ($bot - 1) 3 2 $MAT_LEATHER.base
  Set-Pixel $bmp $cx ($bot - 1) $MAT_LEATHER.high

  # ── Trousers (rows 61..73, on each leg) ──────────────────────
  $pTop = 61
  $pBot = 73
  $pH = $pBot - $pTop + 1
  foreach ($side in @($LEG_LX, $LEG_RX)) {
    Shade-Box $bmp $side $pTop $LEG_W $pH $pants
    # Outer-leg seam — single shadow column down the side.
    Set-Pixel $bmp ($side + $LEG_W - 1) ($pTop + 2) $pants.deep
    Set-Pixel $bmp ($side + $LEG_W - 1) ($pTop + 6) $pants.deep
    # Knee patch — single dim row to hint at fabric wear.
    Fill-Box $bmp $side ($pTop + 6) $LEG_W 1 $pants.shadow
    Set-Pixel $bmp ($side + 1) ($pTop + 6) $pants.deep
    # Trouser hem — darker row at the cuff.
    Fill-Box $bmp $side $pBot $LEG_W 1 $pants.deep
  }
}

function Build-DefaultClothing {
  Write-Host '── Default clothing ──' -ForegroundColor Cyan
  $bmp = New-CanvasFx $CanvasW $CanvasH
  Draw-DefaultClothing $bmp
  Save-CanvasFx $bmp (Join-Path $figDir 'default-clothing.png')
  Write-Host '  default-clothing: 1' -ForegroundColor Green
}

# ══════════════════════════════════════════════════════════════════
#                       FIGURE — hair
# ══════════════════════════════════════════════════════════════════

# Hair is authored at the reference brown 5-tone ramp. character.js
# palette-swaps to other colours. Each style is a procedural drawing
# on the 64×80 canvas that sits around the head (rows 14..36) and may
# extend up into the headroom or down past the shoulders.

function Get-HairRamp {
  return @{
    deep   = Color-FromHex $HAIR_REF.deep;
    shadow = Color-FromHex $HAIR_REF.shadow;
    base   = Color-FromHex $HAIR_REF.base;
    high   = Color-FromHex $HAIR_REF.high;
    top    = Color-FromHex $HAIR_REF.top;
  }
}

# Common skullcap that wraps the upper head — used as base for most
# styles. Lays down a 5-tone shaded dome.
function Draw-HairCap {
  param($bmp, $ramp, [int]$thickness = 5, [int]$widen = 1)
  $cx = 32
  $top = $HEAD_Y - 1
  $w = $HEAD_W + $widen * 2
  $x0 = $cx - [int]($w / 2)
  for ($i = 0; $i -lt $thickness; $i++) {
    $rowW = $w - [int]($i / 2)
    $rowX = $cx - [int]($rowW / 2)
    Fill-Box $bmp $rowX ($top + $i) $rowW 1 $ramp.base
    # Top row brightest
    if ($i -eq 0) {
      for ($j = 0; $j -lt $rowW - 2; $j++) {
        Set-Pixel $bmp ($rowX + 1 + $j) $top $ramp.high
      }
      Set-Pixel $bmp ($rowX + 2) $top $ramp.top
    }
    # Upper-left highlight stripe (light source)
    if ($i -lt 3) {
      Set-Pixel $bmp ($rowX + 1) ($top + $i) $ramp.high
    }
    # Bottom shadow
    if ($i -eq $thickness - 1) {
      for ($j = 0; $j -lt $rowW; $j++) {
        Set-Pixel $bmp ($rowX + $j) ($top + $i) $ramp.shadow
      }
    }
    # Edges
    Set-Pixel $bmp $rowX ($top + $i) $ramp.shadow
    Set-Pixel $bmp ($rowX + $rowW - 1) ($top + $i) $ramp.deep
  }
}

function Draw-Hair {
  param($bmp, [string]$style)
  $ramp = Get-HairRamp
  switch ($style) {
    'bald' { return }
    'short-tousled' {
      Draw-HairCap $bmp $ramp 6 1
      # Tousled fringe falling over forehead
      for ($i = 0; $i -lt 6; $i++) {
        $y = $HEAD_Y + 4 + ($i % 2)
        Set-Pixel $bmp ($HEAD_X + 2 + $i) $y $ramp.base
        Set-Pixel $bmp ($HEAD_X + 2 + $i) ($y - 1) $ramp.shadow
      }
      # Stray pixels above
      Set-Pixel $bmp ($HEAD_X + 4)  ($HEAD_Y - 4) $ramp.base
      Set-Pixel $bmp ($HEAD_X + 4)  ($HEAD_Y - 5) $ramp.shadow
      Set-Pixel $bmp ($HEAD_X + 10) ($HEAD_Y - 5) $ramp.base
      Set-Pixel $bmp ($HEAD_X + 10) ($HEAD_Y - 6) $ramp.shadow
      Set-Pixel $bmp ($HEAD_X + 7)  ($HEAD_Y - 6) $ramp.high
    }
    'long-straight' {
      Draw-HairCap $bmp $ramp 6 1
      # Long curtain down both sides past the shoulders
      $leftX  = $HEAD_X - 2
      $rightX = $HEAD_X + $HEAD_W + 1
      for ($y = $HEAD_Y + 4; $y -le ($TORSO_Y + 14); $y++) {
        Set-Pixel $bmp $leftX $y $ramp.shadow
        Set-Pixel $bmp ($leftX + 1) $y $ramp.base
        Set-Pixel $bmp ($leftX + 2) $y $ramp.high
        Set-Pixel $bmp $rightX $y $ramp.shadow
        Set-Pixel $bmp ($rightX - 1) $y $ramp.base
        Set-Pixel $bmp ($rightX - 2) $y $ramp.high
      }
      # Hair tips
      for ($i = 0; $i -lt 3; $i++) {
        Set-Pixel $bmp ($leftX + $i) ($TORSO_Y + 15) $ramp.deep
        Set-Pixel $bmp ($rightX - $i) ($TORSO_Y + 15) $ramp.deep
      }
      # Forehead fringe — slight bangs
      Fill-Box $bmp ($HEAD_X + 2) ($HEAD_Y + 3) 12 1 $ramp.shadow
      for ($i = 0; $i -lt 4; $i++) {
        Set-Pixel $bmp ($HEAD_X + 3 + $i * 2) ($HEAD_Y + 4) $ramp.base
      }
    }
    'bun' {
      Draw-HairCap $bmp $ramp 6 1
      # Round bun on top
      $bx = 32; $by = $HEAD_Y - 5
      Shade-Disc $bmp $bx $by 3.0 $ramp
      # Small loose strand falling down on the side
      Set-Pixel $bmp ($HEAD_X - 1) ($HEAD_Y + 7) $ramp.shadow
      Set-Pixel $bmp ($HEAD_X - 1) ($HEAD_Y + 8) $ramp.base
      Set-Pixel $bmp ($HEAD_X - 1) ($HEAD_Y + 9) $ramp.deep
    }
    'mohawk' {
      # Shaved sides — thin shadow band along the temple
      Set-Pixel $bmp ($HEAD_X)       ($HEAD_Y + 3) $ramp.deep
      Set-Pixel $bmp ($HEAD_X + 1)   ($HEAD_Y + 2) $ramp.shadow
      Set-Pixel $bmp ($HEAD_X + $HEAD_W - 1) ($HEAD_Y + 3) $ramp.deep
      Set-Pixel $bmp ($HEAD_X + $HEAD_W - 2) ($HEAD_Y + 2) $ramp.shadow
      # Central crest — tapered tall stripe rising into the headroom
      $cx = 32
      for ($y = 0; $y -lt 10; $y++) {
        $w = 4 - [int]($y / 3)
        $x0 = $cx - [int]($w / 2)
        Fill-Box $bmp $x0 ($HEAD_Y - 7 + $y) $w 1 $ramp.base
        Set-Pixel $bmp $x0 ($HEAD_Y - 7 + $y) $ramp.high
        Set-Pixel $bmp ($x0 + $w - 1) ($HEAD_Y - 7 + $y) $ramp.shadow
      }
      Set-Pixel $bmp $cx ($HEAD_Y - 7) $ramp.top
      Set-Pixel $bmp ($cx - 1) ($HEAD_Y - 6) $ramp.top
    }
    'braids' {
      Draw-HairCap $bmp $ramp 6 1
      # Two thick braids — segmented squares with shadow rings
      foreach ($side in @(@{x=($HEAD_X - 2)}, @{x=($HEAD_X + $HEAD_W + 1)})) {
        $bx = $side.x
        for ($i = 0; $i -lt 4; $i++) {
          $by = $HEAD_Y + 6 + $i * 4
          Shade-Box $bmp $bx $by 3 3 $ramp
          # Twist accent — diagonal high pixel
          Set-Pixel $bmp ($bx + 1) ($by + 1) $ramp.top
          Set-Pixel $bmp ($bx + 2) ($by + 2) $ramp.deep
        }
        # Tip
        Set-Pixel $bmp ($bx + 1) ($HEAD_Y + 22) $ramp.deep
      }
    }
    'curly-afro' {
      # Halo of curls around the head — concentric clusters of base/shadow
      $cx = 32; $cy = $HEAD_Y + 4
      for ($dy = -7; $dy -le 6; $dy++) {
        for ($dx = -10; $dx -le 10; $dx++) {
          $d = [Math]::Sqrt($dx * $dx + $dy * $dy * 1.3)
          if ($d -gt 9.5 -or $d -lt 6.5) { continue }
          # Pattern: ring of curls
          $col = if ((($dx + $dy * 2) % 3) -eq 0) { $ramp.shadow } else { $ramp.base }
          Set-Pixel $bmp ($cx + $dx) ($cy + $dy) $col
        }
      }
      # Inner fill
      for ($dy = -6; $dy -le 5; $dy++) {
        for ($dx = -8; $dx -le 8; $dx++) {
          $d = [Math]::Sqrt($dx * $dx + $dy * $dy * 1.3)
          if ($d -gt 6.5) { continue }
          # Don't overwrite the face area (avoid covering eye row at y=HEAD_Y+5..7)
          $py = $cy + $dy
          $px = $cx + $dx
          if ($py -ge ($HEAD_Y + 4) -and $py -le ($HEAD_Y + 11)) {
            # face zone — only paint edges
            if ($px -le ($HEAD_X + 2) -or $px -ge ($HEAD_X + $HEAD_W - 3)) {
              Set-Pixel $bmp $px $py $ramp.base
            }
            continue
          }
          Set-Pixel $bmp $px $py $ramp.base
        }
      }
      # Highlight specks
      Set-Pixel $bmp ($cx - 4) ($cy - 4) $ramp.top
      Set-Pixel $bmp ($cx + 3) ($cy - 5) $ramp.high
      Set-Pixel $bmp ($cx - 6) ($cy - 1) $ramp.high
    }
    'pixie' {
      Draw-HairCap $bmp $ramp 5 1
      # Uneven fringe across forehead
      Set-Pixel $bmp ($HEAD_X + 2) ($HEAD_Y + 3) $ramp.base
      Set-Pixel $bmp ($HEAD_X + 5) ($HEAD_Y + 4) $ramp.base
      Set-Pixel $bmp ($HEAD_X + 8) ($HEAD_Y + 3) $ramp.base
      Set-Pixel $bmp ($HEAD_X + 11) ($HEAD_Y + 4) $ramp.base
      # Punky uplift on the right
      Set-Pixel $bmp ($HEAD_X + $HEAD_W - 1) ($HEAD_Y - 2) $ramp.base
      Set-Pixel $bmp ($HEAD_X + $HEAD_W)     ($HEAD_Y - 3) $ramp.base
      Set-Pixel $bmp ($HEAD_X + $HEAD_W - 2) ($HEAD_Y - 3) $ramp.shadow
    }
    'ponytail' {
      Draw-HairCap $bmp $ramp 6 1
      # Tie at the back of the head
      $tx = $HEAD_X + $HEAD_W; $ty = $HEAD_Y + 5
      Shade-Box $bmp $tx $ty 3 3 $ramp
      # Ponytail falling down + slightly back
      for ($i = 0; $i -lt 18; $i++) {
        $px = $tx + 1 + [int]($i / 8)
        $py = $ty + 3 + $i
        Set-Pixel $bmp ($px - 1) $py $ramp.shadow
        Set-Pixel $bmp $px $py $ramp.base
        Set-Pixel $bmp ($px + 1) $py $ramp.high
        if (($i % 4) -eq 2) {
          Set-Pixel $bmp $px $py $ramp.top
        }
      }
      # Tip flare
      Set-Pixel $bmp ($tx + 4) ($ty + 21) $ramp.shadow
      Set-Pixel $bmp ($tx + 2) ($ty + 22) $ramp.deep
    }
    'shaved-sides' {
      # Flat-top: cap only on the very top, thin shadow on temples
      Draw-HairCap $bmp $ramp 3 0
      # Stubble shadow on the sides
      for ($y = $HEAD_Y + 2; $y -le ($HEAD_Y + 6); $y++) {
        Set-Pixel $bmp ($HEAD_X)              $y $ramp.deep
        Set-Pixel $bmp ($HEAD_X + 1)          $y $ramp.shadow
        Set-Pixel $bmp ($HEAD_X + $HEAD_W -1) $y $ramp.deep
        Set-Pixel $bmp ($HEAD_X + $HEAD_W -2) $y $ramp.shadow
      }
    }
    'mullet' {
      Draw-HairCap $bmp $ramp 5 0
      # Long flowing back behind the neck
      for ($i = 0; $i -lt 14; $i++) {
        $w = 8 - [int]($i / 4)
        $x0 = 32 - [int]($w / 2)
        $y = $HEAD_Y + 5 + $i
        Fill-Box $bmp $x0 $y $w 1 $ramp.base
        Set-Pixel $bmp $x0 $y $ramp.high
        Set-Pixel $bmp ($x0 + $w - 1) $y $ramp.shadow
        if (($i % 3) -eq 0) {
          Set-Pixel $bmp ($x0 + [int]($w / 2)) $y $ramp.top
        }
      }
    }
    'wizard-long' {
      Draw-HairCap $bmp $ramp 6 1
      # Long curtain all the way to the feet (wizard beard sold separately)
      foreach ($side in @(@{x=($HEAD_X - 2)}, @{x=($HEAD_X + $HEAD_W + 1)})) {
        $sx = $side.x
        $dir = if ($sx -lt 32) { -1 } else { 1 }
        for ($y = $HEAD_Y + 5; $y -le ($CanvasH - 3); $y++) {
          $px = $sx + $dir * [int](($y - $HEAD_Y - 5) / 20)
          Set-Pixel $bmp $px $y $ramp.base
          Set-Pixel $bmp ($px - $dir) $y $ramp.shadow
          Set-Pixel $bmp ($px + $dir) $y $ramp.high
          if (($y % 8) -eq 0) {
            Set-Pixel $bmp $px $y $ramp.top
          }
        }
      }
    }
    default {
      Draw-HairCap $bmp $ramp 5 1
    }
  }
}

function Build-Hair {
  Write-Host '── Building hair layers ──' -ForegroundColor Cyan
  $count = 0
  foreach ($style in @('short-tousled','long-straight','bun','mohawk','braids',
                        'curly-afro','pixie','ponytail','bald','shaved-sides',
                        'mullet','wizard-long')) {
    $bmp = New-CanvasFx $CanvasW $CanvasH
    Draw-Hair $bmp $style
    Save-CanvasFx $bmp (Join-Path $figDir ("hair-{0}.png" -f $style))
    $count++
  }
  Write-Host "  hair styles: $count" -ForegroundColor Green
}

# ══════════════════════════════════════════════════════════════════
#                       FIGURE — eyes + accents
# ══════════════════════════════════════════════════════════════════
#
# Eyes sit at face row HEAD_Y+7..9, two pixels per eye plus a tiny
# specular highlight. Pupil colour drives the visible eye.

function Draw-Eyes {
  param($bmp, $color)
  $ink = $BRAND.Ink
  # Eye y-band sits a third of the way down the face
  $ey  = $HEAD_Y + 8
  # Inner edge of head determines eye position
  $lex = $HEAD_X + 3
  $rex = $HEAD_X + 10
  # Sclera (white) — 3 wide
  $sclera = Color-FromHex '#f4f0e8'
  Fill-Box $bmp $lex $ey 3 2 $sclera
  Fill-Box $bmp $rex $ey 3 2 $sclera
  # Pupil — 2 wide, slightly inset
  Fill-Box $bmp ($lex + 1) $ey 2 2 $color
  Fill-Box $bmp ($rex + 1) $ey 2 2 $color
  # Specular highlight (single white pixel upper-left of each pupil)
  Set-Pixel $bmp ($lex + 1) $ey (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($rex + 1) $ey (Color-FromHex '#ffffff')
  # Upper eyelid line
  Set-Pixel $bmp $lex ($ey - 1) $ink
  Set-Pixel $bmp ($lex + 1) ($ey - 1) $ink
  Set-Pixel $bmp ($lex + 2) ($ey - 1) $ink
  Set-Pixel $bmp $rex ($ey - 1) $ink
  Set-Pixel $bmp ($rex + 1) ($ey - 1) $ink
  Set-Pixel $bmp ($rex + 2) ($ey - 1) $ink
  # Lower lash
  Set-Pixel $bmp ($lex + 1) ($ey + 2) $ink
  Set-Pixel $bmp ($rex + 1) ($ey + 2) $ink
}

function Build-Eyes {
  Write-Host '── Building eye layers ──' -ForegroundColor Cyan
  $count = 0
  foreach ($name in $EYE_COLOURS.Keys) {
    $bmp = New-CanvasFx $CanvasW $CanvasH
    Draw-Eyes $bmp (Color-FromHex $EYE_COLOURS[$name])
    Save-CanvasFx $bmp (Join-Path $figDir ("eyes-{0}.png" -f $name))
    $count++
  }
  Write-Host "  eye colours: $count" -ForegroundColor Green
}

function Draw-Accent-Freckles { param($bmp)
  $c = [System.Drawing.Color]::FromArgb(180, 120, 80, 50)
  Set-Pixel $bmp ($HEAD_X + 4) ($HEAD_Y + 11) $c
  Set-Pixel $bmp ($HEAD_X + 6) ($HEAD_Y + 12) $c
  Set-Pixel $bmp ($HEAD_X + 8) ($HEAD_Y + 11) $c
  Set-Pixel $bmp ($HEAD_X + 10) ($HEAD_Y + 12) $c
  Set-Pixel $bmp ($HEAD_X + 5) ($HEAD_Y + 13) $c
  Set-Pixel $bmp ($HEAD_X + 9) ($HEAD_Y + 13) $c
}
function Draw-Accent-EyeShadow { param($bmp)
  $c = [System.Drawing.Color]::FromArgb(180, 0x7c, 0x5c, 0xff)
  Fill-Box $bmp ($HEAD_X + 3) ($HEAD_Y + 7) 3 1 $c
  Fill-Box $bmp ($HEAD_X + 10) ($HEAD_Y + 7) 3 1 $c
}
function Draw-Accent-FaceScar { param($bmp)
  $c = (Color-FromHex '#c87870')
  $c2 = (Color-FromHex '#a85040')
  Set-Pixel $bmp ($HEAD_X + 11) ($HEAD_Y + 6) $c2
  Set-Pixel $bmp ($HEAD_X + 11) ($HEAD_Y + 7) $c
  Set-Pixel $bmp ($HEAD_X + 11) ($HEAD_Y + 8) $c
  Set-Pixel $bmp ($HEAD_X + 11) ($HEAD_Y + 9) $c2
  Set-Pixel $bmp ($HEAD_X + 11) ($HEAD_Y + 10) $c
  Set-Pixel $bmp ($HEAD_X + 11) ($HEAD_Y + 11) $c2
}
function Draw-Accent-BeautyMark { param($bmp)
  Set-Pixel $bmp ($HEAD_X + 5) ($HEAD_Y + 12) $BRAND.Ink
  Set-Pixel $bmp ($HEAD_X + 4) ($HEAD_Y + 12) (Color-FromHex '#3a2a20')
}
function Draw-Accent-GlassesRound { param($bmp)
  $ink = $BRAND.Ink
  $glass = With-Alpha (Color-FromHex '#88c4ff') 80
  # Left ring
  Stroke-Box $bmp ($HEAD_X + 2) ($HEAD_Y + 7) 5 4 $ink
  # Right ring
  Stroke-Box $bmp ($HEAD_X + 9) ($HEAD_Y + 7) 5 4 $ink
  # Bridge
  Set-Pixel $bmp ($HEAD_X + 7) ($HEAD_Y + 8) $ink
  Set-Pixel $bmp ($HEAD_X + 8) ($HEAD_Y + 8) $ink
  # Lens tint
  Fill-Box $bmp ($HEAD_X + 3) ($HEAD_Y + 8) 3 2 $glass
  Fill-Box $bmp ($HEAD_X + 10) ($HEAD_Y + 8) 3 2 $glass
  # Highlight glint
  Set-Pixel $bmp ($HEAD_X + 3) ($HEAD_Y + 8) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($HEAD_X + 10) ($HEAD_Y + 8) (Color-FromHex '#ffffff')
}

function Build-Accents {
  Write-Host '── Building accent layers ──' -ForegroundColor Cyan
  $accents = @{
    freckles      = (Get-Item function:Draw-Accent-Freckles);
    'eye-shadow'  = (Get-Item function:Draw-Accent-EyeShadow);
    'face-scar'   = (Get-Item function:Draw-Accent-FaceScar);
    'beauty-mark' = (Get-Item function:Draw-Accent-BeautyMark);
    'glasses-round' = (Get-Item function:Draw-Accent-GlassesRound);
  }
  $count = 0
  foreach ($name in $accents.Keys) {
    $bmp = New-CanvasFx $CanvasW $CanvasH
    & $accents[$name].ScriptBlock $bmp
    Save-CanvasFx $bmp (Join-Path $figDir ("accent-{0}.png" -f $name))
    $count++
  }
  Write-Host "  accent flair: $count" -ForegroundColor Green
}

# ══════════════════════════════════════════════════════════════════
#                       GEAR — catalogue parser
# ══════════════════════════════════════════════════════════════════
#
# Catalogue rows live in discord-bot/dungeon.js (SHOP_POOL) +
# discord-bot/clash-content.js (Voltaic gear). Parser is grep-style
# regex over the single-line array literals. Same shape as the
# original Phase-3 build.

function Read-Catalogue {
  param([string]$repoRoot)
  $dungeonPath = Join-Path $repoRoot 'discord-bot/dungeon.js'
  $clashPath   = Join-Path $repoRoot 'discord-bot/clash-content.js'
  $catalogue = @()
  $rowRx = "^\s*\[\s*'(?<slot>[^']+)',\s*'(?<rarity>[^']+)',\s*'(?<name>(?:[^'\\]|\\.)+)',\s*'[^']*',\s*\d+,\s*\d+,\s*\d+,\s*'(?<setName>[^']*)',\s*'(?<weaponType>[^']*)',\s*'(?<preferredClass>[^']*)',\s*'(?<ability>[^']*)'\s*\]"
  Get-Content $dungeonPath | ForEach-Object {
    if ($_ -match $rowRx) {
      $catalogue += [PSCustomObject]@{
        slot           = $matches['slot']
        rarity         = $matches['rarity']
        name           = $matches['name'] -replace "\\'", "'"
        setName        = $matches['setName']
        weaponType     = $matches['weaponType']
        preferredClass = $matches['preferredClass']
        ability        = $matches['ability']
      }
    }
  }
  if (Test-Path $clashPath) {
    Get-Content $clashPath | ForEach-Object {
      if ($_ -match $rowRx) {
        $catalogue += [PSCustomObject]@{
          slot           = $matches['slot']
          rarity         = $matches['rarity']
          name           = $matches['name'] -replace "\\'", "'"
          setName        = $matches['setName']
          weaponType     = $matches['weaponType']
          preferredClass = $matches['preferredClass']
          ability        = $matches['ability']
        }
      }
    }
  }
  return $catalogue
}

# ══════════════════════════════════════════════════════════════════
#                       GEAR — weapons
# ══════════════════════════════════════════════════════════════════
#
# All weapons anchor to the right hand at grip column GRIP_X=45,
# y=57..61. Blades / shafts / heads extend UP into the canvas above;
# pommels extend DOWN past the hand. Polearms / staves push into the
# headroom rows.
#
# Per Clay's "every piece unique" directive: Rng-Init off the piece
# name then pick variation knobs (blade length, gem position, etc.)
# so two pieces of the same archetype + rarity still look distinct.

# Add a soft glow halo around opaque pixels — used for epic/legendary.
function Apply-Rarity-Glow {
  param($bmp, [string]$rarity)
  $d = Rarity-Detail $rarity
  if ($d -lt 3) { return }
  $color = if ($d -ge 4) {
    Color-FromHex '#fff0a0'
  } else {
    Color-FromHex '#cb9aff'
  }
  Add-GlowHalo $bmp $color 2 110
}

# ── Sword (single + two-hand) ─────────────────────────────────────
function Draw-Weapon-Sword {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity

  # Knobs
  $bladeLen   = Rng-Range 22 32
  $bladeWidth = Rng-Range 3 5
  $crossguard = Rng-Range 6 11
  $hiltLen    = Rng-Range 4 6
  $pommelKind = Rng-Pick 5   # 0=ball, 1=wedge, 2=disc, 3=skull, 4=gem

  $gx = $GRIP_X
  $gripBotY = $GRIP_BOTY
  $cgY = $gripBotY - $hiltLen
  $bladeBotY = $cgY - 1
  $bladeTopY = $bladeBotY - $bladeLen + 1

  # Blade — tapered prism with fuller
  $bladeAccent = if ($detail -ge 2) { $accent } else { $null }
  Draw-Blade $bmp $gx $bladeTopY $bladeBotY $bladeWidth $metal -Fuller:($bladeWidth -ge 4) -accent $bladeAccent

  # Crossguard — beam centred on grip, slightly tapered at the ends
  $cgX = $gx - [int]($crossguard / 2)
  for ($i = 0; $i -lt $crossguard; $i++) {
    $col = $metal.base
    Set-Pixel $bmp ($cgX + $i) $cgY $col
    Set-Pixel $bmp ($cgX + $i) ($cgY + 1) $metal.shadow
  }
  # Edge highlights
  Set-Pixel $bmp $cgX $cgY $metal.high
  Set-Pixel $bmp ($cgX + $crossguard - 1) $cgY $metal.shadow
  Set-Pixel $bmp ($cgX + 1) $cgY $metal.top
  # Decorative crossguard tips
  if ($detail -ge 1) {
    Set-Pixel $bmp $cgX ($cgY - 1) $metal.shadow
    Set-Pixel $bmp ($cgX + $crossguard - 1) ($cgY - 1) $metal.shadow
    Set-Pixel $bmp $cgX ($cgY + 2) $metal.deep
    Set-Pixel $bmp ($cgX + $crossguard - 1) ($cgY + 2) $metal.deep
  }
  if ($detail -ge 3) {
    # Decorative scrollwork — gem at the centre top
    Set-Pixel $bmp $gx ($cgY - 1) $accent
  }

  # Grip — leather wrap
  Draw-Grip $bmp $gx ($cgY + 2) $gripBotY 3

  # Pommel — varies by kind
  $py = $gripBotY + 1
  switch ($pommelKind) {
    0 {
      Shade-Disc $bmp $gx ($py + 1) 1.6 $metal
    }
    1 {
      # Wedge
      Fill-Box $bmp ($gx - 1) $py 3 2 $metal.base
      Set-Pixel $bmp ($gx - 1) $py $metal.high
      Set-Pixel $bmp ($gx + 1) ($py + 1) $metal.shadow
      Set-Pixel $bmp $gx $py $metal.top
    }
    2 {
      # Disc — flat
      Fill-Box $bmp ($gx - 2) $py 5 1 $metal.shadow
      Fill-Box $bmp ($gx - 1) ($py + 1) 3 1 $metal.base
      Set-Pixel $bmp $gx ($py + 1) $metal.high
    }
    3 {
      # Skull — head with eye sockets (common+ wields differ)
      Shade-Disc $bmp $gx ($py + 1) 2.0 $metal
      Set-Pixel $bmp ($gx - 1) $py $metal.deep
      Set-Pixel $bmp ($gx + 1) $py $metal.deep
    }
    4 {
      # Gem pommel
      $gem = if ($detail -ge 2) { Gem-Palette $name } else { @{ deep='#3a3a40'; shadow='#5a606e'; core='#838b9c'; high='#aab1c0'; top='#d0d6e2' } }
      Draw-Gem $bmp $gx ($py + 1) 3 $gem -Round
    }
  }

  # Legendary etch + halo
  if ($detail -ge 4) {
    # Inscribed runes along blade midline
    $accent2 = Color-FromHex '#fff0a0'
    for ($i = 4; $i -lt ($bladeLen - 4); $i += 3) {
      Set-Pixel $bmp $gx ($bladeBotY - $i) $accent2
    }
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Axe ────────────────────────────────────────────────────────────
function Draw-Weapon-Axe {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity

  $gx = $GRIP_X
  $gripBotY = $GRIP_BOTY
  $shaftLen = Rng-Range 28 36
  $headW = Rng-Range 7 10
  $headH = Rng-Range 8 12
  $doubleSided = (Rng-Pick 3) -eq 0
  $shaftTopY = $gripBotY - $shaftLen

  # Shaft
  Draw-Shaft $bmp $gx $shaftTopY $gripBotY 3 $MAT_WOOD_DARK

  # Head — sits at top, biased to one side (right for single-bit)
  $hy = $shaftTopY - 1
  $hx = $gx + 1
  for ($y = 0; $y -lt $headH; $y++) {
    $rowW = $headW
    # Curve the edge to make a crescent
    $edgeBow = [int]([Math]::Sin($y / ($headH - 1.0) * [Math]::PI) * 2)
    $w = $rowW + $edgeBow
    Fill-Box $bmp $hx ($hy + $y) $w 1 $metal.base
    Set-Pixel $bmp $hx ($hy + $y) $metal.high
    Set-Pixel $bmp ($hx + $w - 1) ($hy + $y) $metal.top
    if ($y -eq 0)             { Fill-Box $bmp $hx ($hy + $y) $w 1 $metal.high }
    if ($y -eq ($headH - 1))  { Fill-Box $bmp $hx ($hy + $y) $w 1 $metal.shadow }
  }
  # Edge gleam strip
  for ($y = 1; $y -lt ($headH - 1); $y++) {
    Set-Pixel $bmp ($hx + $headW + [int]([Math]::Sin($y / ($headH - 1.0) * [Math]::PI) * 2)) ($hy + $y) $metal.top
  }
  # Inner shadow notch
  Set-Pixel $bmp $hx ($hy + [int]($headH / 2)) $metal.deep
  # Rivets attaching head to shaft
  Draw-Rivet $bmp $hx ($hy + 2) $metal
  Draw-Rivet $bmp $hx ($hy + $headH - 3) $metal

  # Double-bit on the left side
  if ($doubleSided) {
    $lhx = $gx - $headW
    for ($y = 0; $y -lt $headH; $y++) {
      $edgeBow = [int]([Math]::Sin($y / ($headH - 1.0) * [Math]::PI) * 2)
      $w = $headW + $edgeBow
      Fill-Box $bmp ($lhx - $edgeBow) ($hy + $y) $w 1 $metal.base
      Set-Pixel $bmp ($lhx - $edgeBow) ($hy + $y) $metal.top
      Set-Pixel $bmp ($lhx + $w - 1 - $edgeBow) ($hy + $y) $metal.shadow
    }
  }
  # Spike on top
  if ($detail -ge 1) {
    Set-Pixel $bmp $gx ($hy - 1) $metal.base
    Set-Pixel $bmp $gx ($hy - 2) $metal.high
    Set-Pixel $bmp $gx ($hy - 3) $metal.top
  }
  # Rune accent
  if ($detail -ge 2) {
    Set-Pixel $bmp ($hx + 2) ($hy + [int]($headH / 2)) $accent
  }
  # Butt cap
  Shade-Disc $bmp $gx ($gripBotY + 2) 1.5 $metal
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Hammer ─────────────────────────────────────────────────────────
function Draw-Weapon-Hammer {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity

  $gx = $GRIP_X
  $gripBotY = $GRIP_BOTY
  $shaftLen = Rng-Range 26 34
  $headW = Rng-Range 9 13
  $headH = Rng-Range 6 9
  $shaftTopY = $gripBotY - $shaftLen

  # Shaft — wood with iron bands
  Draw-Shaft $bmp $gx $shaftTopY $gripBotY 3 $MAT_WOOD_DARK
  # Iron bands
  if ($detail -ge 1) {
    Fill-Box $bmp ($gx - 1) ($shaftTopY + 4) 3 1 $metal.shadow
    Fill-Box $bmp ($gx - 1) ($gripBotY - 6) 3 1 $metal.shadow
  }

  # Head — heavy block on top
  $hx = $gx - [int]($headW / 2)
  $hy = $shaftTopY - $headH + 1
  Shade-Box $bmp $hx $hy $headW $headH $metal -RimLight
  # Strike face — top + bottom edges
  Fill-Box $bmp $hx $hy $headW 1 $metal.top
  Fill-Box $bmp $hx ($hy + $headH - 1) $headW 1 $metal.deep
  # Rivets in corners
  Draw-Rivet $bmp ($hx + 1) ($hy + 1) $metal
  Draw-Rivet $bmp ($hx + $headW - 2) ($hy + 1) $metal
  Draw-Rivet $bmp ($hx + 1) ($hy + $headH - 2) $metal
  Draw-Rivet $bmp ($hx + $headW - 2) ($hy + $headH - 2) $metal

  # Optional rear spike or back-claw
  if ((Rng-Pick 2) -eq 0 -and $detail -ge 2) {
    Set-Pixel $bmp ($hx - 1) ($hy + [int]($headH / 2)) $metal.base
    Set-Pixel $bmp ($hx - 2) ($hy + [int]($headH / 2)) $metal.shadow
    Set-Pixel $bmp ($hx + $headW)     ($hy + [int]($headH / 2)) $metal.base
    Set-Pixel $bmp ($hx + $headW + 1) ($hy + [int]($headH / 2)) $metal.shadow
  }
  # Rune accent (rare+)
  if ($detail -ge 2) {
    Set-Pixel $bmp ($hx + [int]($headW / 2)) ($hy + [int]($headH / 2)) $accent
  }
  # Butt cap
  Shade-Disc $bmp $gx ($gripBotY + 2) 1.5 $metal
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Dagger ────────────────────────────────────────────────────────
function Draw-Weapon-Dagger {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity

  $gx = $GRIP_X
  $gripBotY = $GRIP_BOTY
  $bladeLen = Rng-Range 12 18
  $bladeWidth = Rng-Range 2 3
  $hiltLen = 4
  $cgY = $gripBotY - $hiltLen
  $bladeBotY = $cgY - 1
  $bladeTopY = $bladeBotY - $bladeLen + 1

  Draw-Blade $bmp $gx $bladeTopY $bladeBotY $bladeWidth $metal -Fuller:($bladeWidth -ge 3)

  # Small crossguard
  $cgW = 5
  $cgX = $gx - 2
  Fill-Box $bmp $cgX $cgY $cgW 1 $metal.base
  Set-Pixel $bmp $cgX $cgY $metal.high
  Set-Pixel $bmp ($cgX + $cgW - 1) $cgY $metal.shadow

  # Grip — narrow leather
  Draw-Grip $bmp $gx ($cgY + 1) $gripBotY 3

  # Pommel — small gem or disc
  if ($detail -ge 2) {
    $gem = Gem-Palette $name
    Draw-Gem $bmp $gx ($gripBotY + 2) 3 $gem -Round
  } else {
    Shade-Disc $bmp $gx ($gripBotY + 2) 1.3 $metal
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Bow ────────────────────────────────────────────────────────────
function Draw-Weapon-Bow {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity
  $wood = if ($detail -ge 2) { $MAT_WOOD_LIGHT } else { $MAT_WOOD_DARK }

  $gx = $GRIP_X
  $gripY = ($GRIP_TOPY + $GRIP_BOTY) / 2
  $bowH = Rng-Range 32 42
  $curve = Rng-Range 4 7
  $topY = $gripY - [int]($bowH / 2)
  $botY = $gripY + [int]($bowH / 2)

  # Limbs — curve outward then back. Plot as smooth arc.
  for ($i = 0; $i -lt [int]($bowH / 2); $i++) {
    $t = $i / ($bowH * 0.5)
    $offset = [int]([Math]::Sin($t * [Math]::PI) * $curve)
    foreach ($side in @(($gripY - $i), ($gripY + $i + 1))) {
      $y = [int]$side
      Set-Pixel $bmp ($gx - $offset - 1) $y $wood.shadow
      Set-Pixel $bmp ($gx - $offset)     $y $wood.base
      Set-Pixel $bmp ($gx - $offset + 1) $y $wood.high
    }
  }
  # Tip nocks
  Set-Pixel $bmp ($gx - 1) $topY $metal.shadow
  Set-Pixel $bmp ($gx - 1) $botY $metal.shadow
  Set-Pixel $bmp $gx ($topY - 1) $metal.high
  Set-Pixel $bmp $gx ($botY + 1) $metal.high

  # Bowstring — vertical line, brand-colour on epic+
  $stringCol = if ($detail -ge 3) { $accent } else { Color-FromHex '#e6dcc4' }
  for ($y = $topY + 1; $y -le ($botY - 1); $y++) {
    Set-Pixel $bmp ($gx + 1) $y $stringCol
  }

  # Grip wrap
  Draw-Grip $bmp $gx ($gripY - 2) ($gripY + 2) 3

  # Decorative wrap rings
  if ($detail -ge 2) {
    foreach ($yy in @(($topY + 5), ($botY - 5))) {
      Set-Pixel $bmp ($gx - 1) $yy $metal.shadow
      Set-Pixel $bmp $gx $yy $accent
      Set-Pixel $bmp ($gx + 1) $yy $metal.high
    }
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Crossbow ──────────────────────────────────────────────────────
function Draw-Weapon-Crossbow {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity
  $wood = if ($detail -ge 2) { $MAT_WOOD_LIGHT } else { $MAT_WOOD_DARK }

  $gx = $GRIP_X
  $gripY = ($GRIP_TOPY + $GRIP_BOTY) / 2

  # Stock — vertical wooden block with shaped butt
  Shade-Box $bmp ($gx - 2) ($gripY - 4) 5 14 $wood
  # Trigger guard
  Fill-Box $bmp ($gx - 2) ($gripY + 7) 5 1 $metal.shadow
  Set-Pixel $bmp ($gx + 2) ($gripY + 7) $metal.high

  # Limbs — wide horizontal arc near top of stock
  $limbY = $gripY - 6
  $limbW = Rng-Range 10 14
  for ($x = -$limbW; $x -le $limbW; $x++) {
    $y = $limbY + [int]([Math]::Pow([Math]::Abs($x) / [double]$limbW, 2) * 3)
    Set-Pixel $bmp ($gx + $x) $y $wood.base
    Set-Pixel $bmp ($gx + $x) ($y - 1) $wood.high
    Set-Pixel $bmp ($gx + $x) ($y + 1) $wood.shadow
  }
  # Tip caps
  Set-Pixel $bmp ($gx - $limbW) ($limbY) $metal.base
  Set-Pixel $bmp ($gx + $limbW) ($limbY) $metal.base
  # String stretched flat across limbs
  $stringCol = if ($detail -ge 3) { $accent } else { Color-FromHex '#e6dcc4' }
  for ($x = (-$limbW + 1); $x -le ($limbW - 1); $x++) {
    Set-Pixel $bmp ($gx + $x) ($limbY + 3) $stringCol
  }
  # Bolt loaded
  for ($y = ($limbY); $y -lt ($limbY + 5); $y++) {
    Set-Pixel $bmp $gx $y $metal.base
  }
  Set-Pixel $bmp $gx ($limbY - 1) $metal.top
  # Fletching
  Set-Pixel $bmp ($gx - 1) ($limbY + 4) $accent
  Set-Pixel $bmp ($gx + 1) ($limbY + 4) $accent
  # Rune (rare+)
  if ($detail -ge 2) {
    Set-Pixel $bmp $gx ($gripY + 2) $accent
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Wand ──────────────────────────────────────────────────────────
function Draw-Weapon-Wand {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity

  $gx = $GRIP_X
  $gripBotY = $GRIP_BOTY
  $wandLen = Rng-Range 18 24
  $tipShape = Rng-Pick 4   # 0=crystal, 1=ball, 2=star, 3=trident
  $top = $gripBotY - $wandLen

  # Wand body — slim wooden rod
  Draw-Shaft $bmp $gx ($top + 3) $gripBotY 2 $MAT_WOOD_DARK

  # Tip — bright gem cluster
  $gem = Gem-Palette $name
  switch ($tipShape) {
    0 {
      # Crystal — vertical diamond
      Draw-Gem $bmp $gx ($top + 2) 5 $gem
    }
    1 {
      Draw-Gem $bmp $gx ($top + 2) 5 $gem -Round
    }
    2 {
      # Star — 5 arms
      $core = Color-FromHex $gem.core
      $high = Color-FromHex $gem.high
      $top2 = Color-FromHex $gem.top
      Set-Pixel $bmp $gx $top $top2
      Set-Pixel $bmp $gx ($top + 1) $high
      Set-Pixel $bmp $gx ($top + 2) $core
      Set-Pixel $bmp $gx ($top + 3) $high
      Set-Pixel $bmp ($gx - 2) ($top + 2) $high
      Set-Pixel $bmp ($gx + 2) ($top + 2) $high
      Set-Pixel $bmp ($gx - 1) ($top + 2) $core
      Set-Pixel $bmp ($gx + 1) ($top + 2) $core
      Set-Pixel $bmp ($gx - 1) ($top + 1) $high
      Set-Pixel $bmp ($gx + 1) ($top + 1) $high
    }
    3 {
      # Trident — three prongs
      $core = Color-FromHex $gem.core
      $high = Color-FromHex $gem.high
      Set-Pixel $bmp $gx ($top) $high
      Set-Pixel $bmp $gx ($top + 1) $core
      Set-Pixel $bmp ($gx - 2) ($top) $high
      Set-Pixel $bmp ($gx - 2) ($top + 1) $core
      Set-Pixel $bmp ($gx + 2) ($top) $high
      Set-Pixel $bmp ($gx + 2) ($top + 1) $core
      Set-Pixel $bmp ($gx - 1) ($top + 1) $core
      Set-Pixel $bmp ($gx + 1) ($top + 1) $core
    }
  }
  # Grip wrap
  Draw-Grip $bmp $gx ($gripBotY - 3) $gripBotY 2
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Staff ─────────────────────────────────────────────────────────
function Draw-Weapon-Staff {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity

  $gx = $GRIP_X
  $gripBotY = $GRIP_BOTY
  $staffLen = Rng-Range 36 48
  $headShape = Rng-Pick 4   # 0=orb, 1=ring, 2=horns, 3=claw
  $top = $gripBotY - $staffLen

  # Long shaft
  Draw-Shaft $bmp $gx ($top + 4) $gripBotY 3 $MAT_WOOD_DARK

  $gem = Gem-Palette $name
  switch ($headShape) {
    0 {
      Draw-Gem $bmp $gx ($top + 2) 5 $gem -Round
      # Mounting cage
      Set-Pixel $bmp ($gx - 3) ($top + 2) $metal.shadow
      Set-Pixel $bmp ($gx + 3) ($top + 2) $metal.shadow
      Set-Pixel $bmp ($gx - 3) ($top + 4) $metal.base
      Set-Pixel $bmp ($gx + 3) ($top + 4) $metal.base
    }
    1 {
      # Ring with floating gem in centre
      Stroke-Box $bmp ($gx - 3) ($top) 7 6 $metal.base
      # Inner highlights
      Set-Pixel $bmp ($gx - 2) $top $metal.high
      Set-Pixel $bmp ($gx + 2) ($top + 5) $metal.deep
      # Gem floating in centre
      Draw-Gem $bmp $gx ($top + 2) 3 $gem
    }
    2 {
      # Horns (curving up + outward)
      foreach ($side in @(-1, 1)) {
        for ($i = 0; $i -lt 5; $i++) {
          $x = $gx + $side * (1 + $i)
          $y = $top + 3 - $i
          if ($i -lt 2) { $y = $top + 3 - $i }
          else { $y = $top + 4 - $i }
          Set-Pixel $bmp $x $y $metal.base
          Set-Pixel $bmp ($x + $side * (-1)) $y $metal.shadow
          Set-Pixel $bmp ($x + $side * 1) $y $metal.high
        }
      }
      # Skull at the base
      Draw-Gem $bmp $gx ($top + 3) 3 $gem -Round
    }
    3 {
      # Talon / claw — 3 finger gripper
      $core = Color-FromHex $gem.core
      $high = Color-FromHex $gem.high
      Draw-Gem $bmp $gx ($top + 3) 3 $gem -Round
      foreach ($side in @(-3, -1, 1, 3)) {
        Set-Pixel $bmp ($gx + $side) ($top + 1) $metal.base
        Set-Pixel $bmp ($gx + $side) $top $metal.high
        Set-Pixel $bmp ($gx + $side - [Math]::Sign($side)) ($top + 2) $metal.shadow
      }
    }
  }
  # Wrap at grip
  Draw-Grip $bmp $gx ($gripBotY - 4) $gripBotY 3
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Orb ───────────────────────────────────────────────────────────
function Draw-Weapon-Orb {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $detail = Rarity-Detail $rarity
  $accent = Rarity-Accent $rarity

  # Floating sphere near the hand
  $cx = $GRIP_X + 1
  $cy = $GRIP_TOPY - 4
  $r = Rng-Range 4 5
  $gem = Gem-Palette $name

  # Outer ring (metal mount with crescents)
  Shade-Disc $bmp $cx $cy ($r + 0.6) $metal
  # Inner gem
  Draw-Gem $bmp $cx $cy ([int]($r * 1.5)) $gem -Round
  # Mounting clasps
  Set-Pixel $bmp ($cx - $r - 1) $cy $metal.shadow
  Set-Pixel $bmp ($cx + $r + 1) $cy $metal.shadow
  Set-Pixel $bmp $cx ($cy - $r - 1) $metal.high
  Set-Pixel $bmp $cx ($cy + $r + 1) $metal.deep

  # Sparkle motes around the orb (rare+)
  if ($detail -ge 2) {
    Set-Pixel $bmp ($cx - $r - 2) ($cy - 1) $accent
    Set-Pixel $bmp ($cx + $r + 2) ($cy + 2) $accent
    Set-Pixel $bmp ($cx) ($cy - $r - 3) $accent
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Tome ──────────────────────────────────────────────────────────
function Draw-Weapon-Tome {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity

  $bx = $GRIP_X - 4
  $by = $GRIP_TOPY - 14
  $bw = Rng-Range 10 13
  $bh = Rng-Range 14 18

  # Cover — dark leather with metal trim
  $cover = if ($detail -ge 3) { $metal } else { $MAT_LEATHER }
  Shade-Box $bmp $bx $by $bw $bh $cover -RimLight
  # Spine
  Fill-Box $bmp $bx $by 1 $bh $cover.deep
  Fill-Box $bmp ($bx + 1) $by 1 $bh $cover.high
  # Page edge (right side)
  for ($y = 1; $y -lt ($bh - 1); $y++) {
    Set-Pixel $bmp ($bx + $bw - 1) ($by + $y) (Color-FromHex '#fff5da')
    Set-Pixel $bmp ($bx + $bw) ($by + $y) (Color-FromHex '#c4ab78')
  }
  # Metal corners
  foreach ($corner in @(@{x=$bx; y=$by}, @{x=($bx + $bw - 1); y=$by}, @{x=$bx; y=($by + $bh - 1)}, @{x=($bx + $bw - 1); y=($by + $bh - 1)})) {
    Set-Pixel $bmp $corner.x $corner.y $metal.base
    Set-Pixel $bmp $corner.x ($corner.y + 1) $metal.shadow
  }
  # Centre emblem — gem inset
  $gem = Gem-Palette $name
  Draw-Gem $bmp ($bx + [int]($bw / 2)) ($by + [int]($bh / 2)) 5 $gem
  # Clasp band wrapping the cover
  if ($detail -ge 2) {
    $bandY = $by + [int]($bh / 2) + 3
    Fill-Box $bmp $bx $bandY $bw 1 $metal.shadow
    Set-Pixel $bmp ($bx + [int]($bw / 2)) $bandY $accent
  }
  # Ribbon bookmark (epic+)
  if ($detail -ge 3) {
    $rx = $bx + [int]($bw * 0.7)
    for ($y = 0; $y -lt 4; $y++) {
      Set-Pixel $bmp $rx ($by + $bh + $y) (Color-FromHex '#c83040')
    }
    Set-Pixel $bmp ($rx + 1) ($by + $bh + 3) (Color-FromHex '#8a1a28')
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Holy (cross / sigil) ──────────────────────────────────────────
function Draw-Weapon-Holy {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity

  $gx = $GRIP_X
  $gripBotY = $GRIP_BOTY
  $h = Rng-Range 14 20
  $arm = Rng-Range 5 8
  $top = $gripBotY - $h

  # Vertical bar
  Shade-Box $bmp ($gx - 1) $top 3 $h $metal -RimLight
  # Crossbar
  $cy = $top + 4
  Shade-Box $bmp ($gx - $arm) $cy ($arm * 2 + 1) 3 $metal -RimLight
  # Gem centre
  $gem = Gem-Palette $name
  Draw-Gem $bmp $gx ($cy + 1) 3 $gem
  # Decorative tips
  if ($detail -ge 1) {
    Set-Pixel $bmp $gx ($top - 1) $metal.top
    Set-Pixel $bmp ($gx - $arm - 1) ($cy + 1) $metal.top
    Set-Pixel $bmp ($gx + $arm + 1) ($cy + 1) $metal.top
    Set-Pixel $bmp $gx ($gripBotY + 1) $metal.high
  }
  # Engraved rune trail down the lower bar
  if ($detail -ge 2) {
    Set-Pixel $bmp $gx ($cy + 4) $accent
    Set-Pixel $bmp $gx ($cy + 6) $accent
    Set-Pixel $bmp $gx ($cy + 8) $accent
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Sling ─────────────────────────────────────────────────────────
function Draw-Weapon-Sling {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $detail = Rarity-Detail $rarity
  $metal = Rarity-Metal $rarity

  $gx = $GRIP_X
  $gy = $GRIP_TOPY
  # Y-shape sling — two strap loops + pouch at bottom
  # Upper strap fork
  Line-Pixel $bmp ($gx - 2) ($gy - 6) ($gx) ($gy - 1) $MAT_LEATHER.base
  Line-Pixel $bmp ($gx + 2) ($gy - 6) ($gx) ($gy - 1) $MAT_LEATHER.base
  Line-Pixel $bmp ($gx - 2) ($gy - 7) ($gx) ($gy - 2) $MAT_LEATHER.shadow
  Line-Pixel $bmp ($gx + 2) ($gy - 7) ($gx) ($gy - 2) $MAT_LEATHER.shadow
  # Pouch
  Shade-Disc $bmp $gx ($gy + 5) 3.5 $MAT_LEATHER
  # Stone inside the pouch
  if ($detail -ge 1) {
    Shade-Disc $bmp $gx ($gy + 5) 1.5 $MAT_STONE
  }
  # Decorative coil at top of strap
  if ($detail -ge 2) {
    Set-Pixel $bmp ($gx - 3) ($gy - 8) (Rarity-Accent $rarity)
  }
}

# ── Polearm ───────────────────────────────────────────────────────
function Draw-Weapon-Polearm {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity

  $gx = $GRIP_X
  $gripBotY = $GRIP_BOTY
  $shaftLen = Rng-Range 42 52
  $headStyle = Rng-Pick 4   # 0=halberd, 1=spear, 2=glaive, 3=trident
  $top = $gripBotY - $shaftLen

  Draw-Shaft $bmp $gx ($top + 6) $gripBotY 3 $MAT_WOOD_DARK

  switch ($headStyle) {
    0 {
      # Halberd — axe blade + top spike
      Fill-Box $bmp ($gx + 1) ($top + 1) 5 5 $metal.base
      Stroke-Box $bmp ($gx + 1) ($top + 1) 5 5 $metal.shadow
      # Edge highlight
      for ($i = 0; $i -lt 5; $i++) {
        Set-Pixel $bmp ($gx + 5) ($top + 1 + $i) $metal.top
      }
      # Top spike
      for ($i = 0; $i -lt 6; $i++) {
        Set-Pixel $bmp $gx ($top + $i) $metal.base
      }
      Set-Pixel $bmp $gx $top $metal.top
      Set-Pixel $bmp ($gx - 1) ($top + 1) $metal.shadow
      # Back hook
      Set-Pixel $bmp ($gx - 1) ($top + 4) $metal.base
      Set-Pixel $bmp ($gx - 2) ($top + 5) $metal.shadow
    }
    1 {
      # Long spear — narrow point with leaf shape
      Draw-Blade $bmp $gx ($top - 1) ($top + 7) 4 $metal -Fuller
    }
    2 {
      # Glaive — curved sweeping blade
      for ($y = 0; $y -lt 9; $y++) {
        $w = if ($y -lt 4) { 2 + $y } else { 6 - [int](($y - 4) * 0.6) }
        for ($i = 0; $i -lt $w; $i++) {
          Set-Pixel $bmp ($gx + 1 + $i) ($top + 1 + $y) $metal.base
        }
        Set-Pixel $bmp ($gx + 1) ($top + 1 + $y) $metal.shadow
        Set-Pixel $bmp ($gx + $w) ($top + 1 + $y) $metal.top
      }
    }
    3 {
      # Trident — three prongs
      foreach ($x in @(-2, 0, 2)) {
        Set-Pixel $bmp ($gx + $x) ($top) $metal.top
        Set-Pixel $bmp ($gx + $x) ($top + 1) $metal.high
        Set-Pixel $bmp ($gx + $x) ($top + 2) $metal.base
        Set-Pixel $bmp ($gx + $x) ($top + 3) $metal.shadow
      }
      # Crossbar tying prongs
      Fill-Box $bmp ($gx - 2) ($top + 4) 5 1 $metal.base
    }
  }
  # Wrap above grip
  Draw-Grip $bmp $gx ($gripBotY - 6) ($gripBotY - 1) 3
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ── Weapon dispatcher ─────────────────────────────────────────────
function Draw-Weapon {
  param($bmp, [string]$weaponType, [string]$name, [string]$rarity)
  switch ($weaponType) {
    'sword'    { Draw-Weapon-Sword    $bmp $name $rarity }
    'axe'      { Draw-Weapon-Axe      $bmp $name $rarity }
    'hammer'   { Draw-Weapon-Hammer   $bmp $name $rarity }
    'dagger'   { Draw-Weapon-Dagger   $bmp $name $rarity }
    'bow'      { Draw-Weapon-Bow      $bmp $name $rarity }
    'crossbow' { Draw-Weapon-Crossbow $bmp $name $rarity }
    'wand'     { Draw-Weapon-Wand     $bmp $name $rarity }
    'staff'    { Draw-Weapon-Staff    $bmp $name $rarity }
    'orb'      { Draw-Weapon-Orb      $bmp $name $rarity }
    'tome'     { Draw-Weapon-Tome     $bmp $name $rarity }
    'holy'     { Draw-Weapon-Holy     $bmp $name $rarity }
    'sling'    { Draw-Weapon-Sling    $bmp $name $rarity }
    'polearm'  { Draw-Weapon-Polearm  $bmp $name $rarity }
    default    { Draw-Weapon-Sword    $bmp $name $rarity }
  }
}

function Build-Weapons {
  param([string]$repoRoot)
  Write-Host '── Building weapon sprites ──' -ForegroundColor Cyan
  $catalogue = Read-Catalogue -repoRoot $repoRoot
  $weapons = $catalogue | Where-Object { $_.slot -eq 'weapon' }
  $count = 0
  foreach ($p in $weapons) {
    $bmp = New-CanvasFx $CanvasW $CanvasH
    Draw-Weapon $bmp $p.weaponType $p.name $p.rarity
    $slug = Slugify $p.name
    Save-CanvasFx $bmp (Join-Path $gearDir ("weapon/{0}.png" -f $slug))
    $count++
  }
  Write-Host "  weapons: $count" -ForegroundColor Green
}

# ══════════════════════════════════════════════════════════════════
#                       GEAR — head (helmets / hats / hoods)
# ══════════════════════════════════════════════════════════════════
#
# Head gear sits over the figure head (rows 20..37 inclusive) and
# can extend up into the headroom (rows 0..19) for plumes / crowns.
# Helmets cover hair; soft caps leave hair visible at the back via
# transparent fill.

# Full plate helmet — dome + visor + cheek guards
function Draw-Head-Helmet {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity

  $hx = 23; $hy = 17; $hw = 18; $hh = 21
  $plume = Rng-Pick 5     # 0=none, 1=spike, 2=fin, 3=crown, 4=horns
  $visor = Rng-Pick 3     # 0=full slit, 1=t-slit, 2=open-face

  # Dome with rounded top — cut top-corner pixels for shape
  Shade-Box $bmp $hx $hy $hw $hh $metal -RimLight
  Set-Pixel $bmp $hx $hy ([System.Drawing.Color]::FromArgb(0,0,0,0))
  Set-Pixel $bmp ($hx + $hw - 1) $hy ([System.Drawing.Color]::FromArgb(0,0,0,0))
  Set-Pixel $bmp $hx ($hy + 1) $metal.shadow
  Set-Pixel $bmp ($hx + $hw - 1) ($hy + 1) $metal.shadow
  # Top crown highlight strip
  for ($x = 0; $x -lt $hw - 4; $x++) {
    Set-Pixel $bmp ($hx + 2 + $x) ($hy + 1) $metal.high
  }
  Set-Pixel $bmp ($hx + 3) ($hy + 1) $metal.top
  # Visor band
  $vy = $hy + 7
  switch ($visor) {
    0 {  # Full visor with slit
      Fill-Box $bmp $hx $vy $hw 4 $metal.shadow
      Fill-Box $bmp ($hx + 3) ($vy + 1) ($hw - 6) 1 $BRAND.Ink
      Set-Pixel $bmp ($hx + 4) ($vy + 1) (Color-FromHex '#3a3f50')   # interior glow
      Set-Pixel $bmp ($hx + $hw - 5) ($vy + 1) (Color-FromHex '#3a3f50')
      # Breath slits
      for ($x = 4; $x -lt ($hw - 4); $x += 2) {
        Set-Pixel $bmp ($hx + $x) ($vy + 3) $metal.deep
      }
    }
    1 {  # T-slit
      Fill-Box $bmp $hx $vy $hw 4 $metal.shadow
      Fill-Box $bmp ($hx + 8) $vy 2 4 $BRAND.Ink
      Fill-Box $bmp ($hx + 3) ($vy + 1) ($hw - 6) 1 $BRAND.Ink
    }
    2 {  # Open face — eyes show through
      Fill-Box $bmp ($hx + 2) $vy 5 3 $BRAND.Ink
      Fill-Box $bmp ($hx + $hw - 7) $vy 5 3 $BRAND.Ink
      # Brow ridge
      Fill-Box $bmp $hx ($vy - 1) $hw 1 $metal.high
    }
  }
  # Cheek guards extending down
  Fill-Box $bmp $hx ($hy + $hh - 2) 2 3 $metal.shadow
  Fill-Box $bmp ($hx + $hw - 2) ($hy + $hh - 2) 2 3 $metal.shadow
  # Rivets at temples
  if ($detail -ge 1) {
    Draw-Rivet $bmp ($hx + 1) ($hy + 5) $metal
    Draw-Rivet $bmp ($hx + $hw - 2) ($hy + 5) $metal
  }
  # Crest / plume on top
  switch ($plume) {
    1 {  # Spike
      for ($y = 0; $y -lt 9; $y++) {
        Set-Pixel $bmp (32) ($hy - 1 - $y) $metal.base
      }
      Set-Pixel $bmp 32 ($hy - 10) $metal.top
      Set-Pixel $bmp 31 ($hy - 6) $metal.high
    }
    2 {  # Plume (swept back) — coloured by rarity accent
      for ($y = 0; $y -lt 8; $y++) {
        for ($x = 0; $x -lt 6; $x++) {
          $px = 32 + $x
          $py = $hy - 1 - $y + [int]($x / 2)
          $col = if ((($x + $y) % 2) -eq 0) { $accent } else { With-Alpha $accent 200 }
          Set-Pixel $bmp $px $py $col
        }
      }
    }
    3 {  # Crown — jagged merlons + gem
      for ($x = 0; $x -lt $hw; $x += 3) {
        Set-Pixel $bmp ($hx + $x) ($hy - 1) $metal.base
        Set-Pixel $bmp ($hx + $x) ($hy - 2) $metal.high
        Set-Pixel $bmp ($hx + $x + 1) ($hy - 1) $metal.shadow
      }
      $gem = Gem-Palette $name
      Draw-Gem $bmp 32 ($hy - 2) 3 $gem
    }
    4 {  # Horns — curving back
      foreach ($dir in @(-1, 1)) {
        for ($i = 0; $i -lt 7; $i++) {
          $x = 32 + $dir * (2 + $i)
          $y = $hy - 1 - $i + [int]($i / 3)
          Set-Pixel $bmp $x $y $metal.base
          Set-Pixel $bmp ($x - $dir) $y $metal.shadow
          Set-Pixel $bmp ($x + $dir) $y $metal.high
        }
      }
    }
  }
  # Rune accent (rare+)
  if ($detail -ge 2) {
    Set-Pixel $bmp 32 ($hy + 4) $accent
    Set-Pixel $bmp 31 ($hy + 5) $accent
    Set-Pixel $bmp 33 ($hy + 5) $accent
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# Soft fabric cap / hood / wide-brim hat / wizard hat / circlet
function Draw-Head-Cap {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $detail = Rarity-Detail $rarity
  $accent = Rarity-Accent $rarity
  $lower = $name.ToLower()
  $cx = 32

  $shape = Rng-Pick 4
  if ($lower -match 'hood|cowl') { $shape = 3 }
  if ($lower -match 'wizard|pointy|pointed|peaked') { $shape = 2 }
  if ($lower -match 'brim|stetson|tricorn|wayfarer') { $shape = 1 }
  if ($lower -match 'circlet|tiara|crown|diadem|coronet') { $shape = 4 }

  # Material ramp: cloth/linen for soft caps; metal for circlets
  $mat = $MAT_CLOTH_WOOL
  if ($shape -eq 4) { $mat = Rarity-Metal $rarity }
  elseif ($lower -match 'leather') { $mat = $MAT_LEATHER }
  elseif ($lower -match 'silk|robe|cloth') { $mat = $MAT_CLOTH_LINEN }
  elseif ($detail -ge 3) { $mat = $MAT_CLOTH_LINEN }

  switch ($shape) {
    0 {  # Skullcap
      Shade-Box $bmp ($cx - 8) 22 16 5 $mat -RimLight
      # Rim band
      Fill-Box $bmp ($cx - 8) 27 16 1 $mat.deep
      if ($detail -ge 1) {
        Fill-Box $bmp ($cx - 8) 26 16 1 $accent
      }
      # Top tuft
      Set-Pixel $bmp $cx 21 $mat.high
    }
    1 {  # Wide-brim hat
      # Wide horizontal brim
      Fill-Box $bmp ($cx - 11) 27 22 2 $mat.base
      Fill-Box $bmp ($cx - 11) 27 22 1 $mat.high
      Fill-Box $bmp ($cx - 11) 28 22 1 $mat.shadow
      # Crown
      Shade-Box $bmp ($cx - 5) 19 10 8 $mat -RimLight
      # Hat band
      Fill-Box $bmp ($cx - 5) 24 10 1 $mat.shadow
      if ($detail -ge 1) {
        Fill-Box $bmp ($cx - 5) 25 10 1 $accent
      }
      # Decorative feather (epic+)
      if ($detail -ge 3) {
        for ($y = 0; $y -lt 6; $y++) {
          Set-Pixel $bmp ($cx + 5 + [int]($y / 3)) (18 - $y) $accent
          Set-Pixel $bmp ($cx + 4 + [int]($y / 3)) (18 - $y) $mat.deep
        }
      }
    }
    2 {  # Wizard cone hat
      # Cone — taper down
      for ($y = 0; $y -lt 14; $y++) {
        $w = $y + 1
        $x0 = $cx - [int]($w / 2)
        Fill-Box $bmp $x0 (22 - $y + 7) $w 1 $mat.base
        Set-Pixel $bmp $x0 (22 - $y + 7) $mat.shadow
        Set-Pixel $bmp ($x0 + $w - 1) (22 - $y + 7) $mat.high
      }
      # Tip + curl
      Set-Pixel $bmp $cx 9 $mat.top
      Set-Pixel $bmp ($cx + 1) 10 $mat.base
      Set-Pixel $bmp ($cx + 1) 11 $mat.shadow
      # Brim
      Fill-Box $bmp ($cx - 8) 26 16 1 $mat.shadow
      Fill-Box $bmp ($cx - 8) 27 16 1 $mat.deep
      # Stars on hat (epic+)
      if ($detail -ge 3) {
        Set-Pixel $bmp ($cx - 1) 18 $accent
        Set-Pixel $bmp ($cx + 2) 20 $accent
        Set-Pixel $bmp ($cx + 4) 24 $accent
      }
    }
    3 {  # Hood — pointed cowl
      # Outer hood drape
      for ($y = 0; $y -lt 18; $y++) {
        $w = 18 - [int]($y / 3)
        if ($y -lt 3) { $w = 6 + $y * 4 }
        $x0 = $cx - [int]($w / 2)
        Fill-Box $bmp $x0 (15 + $y) $w 1 $mat.base
        Set-Pixel $bmp $x0 (15 + $y) $mat.shadow
        Set-Pixel $bmp ($x0 + $w - 1) (15 + $y) $mat.deep
      }
      # Face hole (transparent) — show face through opening
      Fill-Box $bmp ($cx - 5) 24 10 8 ([System.Drawing.Color]::FromArgb(0,0,0,0))
      # Hood inner shadow ring around face
      for ($y = 0; $y -lt 8; $y++) {
        Set-Pixel $bmp ($cx - 6) (24 + $y) $mat.deep
        Set-Pixel $bmp ($cx + 5) (24 + $y) $mat.deep
      }
      Fill-Box $bmp ($cx - 6) 23 12 1 $mat.deep
      # Trim
      if ($detail -ge 2) {
        Set-Pixel $bmp ($cx - 7) 24 $accent
        Set-Pixel $bmp ($cx + 6) 24 $accent
      }
    }
    4 {  # Circlet — thin metal band + central gem
      Fill-Box $bmp ($cx - 8) 25 16 2 $mat.base
      Fill-Box $bmp ($cx - 8) 25 16 1 $mat.high
      Fill-Box $bmp ($cx - 8) 26 16 1 $mat.shadow
      # Side spikes
      Set-Pixel $bmp ($cx - 7) 24 $mat.base
      Set-Pixel $bmp ($cx + 6) 24 $mat.base
      Set-Pixel $bmp ($cx - 8) 24 $mat.high
      Set-Pixel $bmp ($cx + 7) 24 $mat.high
      # Central gem
      $gem = Gem-Palette $name
      Draw-Gem $bmp $cx 24 3 $gem
      Set-Pixel $bmp $cx 22 $mat.high
    }
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# Dispatch on name keyword + hash
function Draw-Head {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $lower = $name.ToLower()
  if ($lower -match 'helm|coif|sallet|barbute|visor|drak|ironclad|warmask|maw|skull') {
    Draw-Head-Helmet $bmp $name $rarity
  } elseif ($lower -match 'cap|hat|hood|wayfarer|circlet|crown|tiara|diadem|coronet|cowl|wizard') {
    Draw-Head-Cap $bmp $name $rarity
  } else {
    if ((Rng-Pick 2) -eq 0) { Draw-Head-Helmet $bmp $name $rarity }
    else                    { Draw-Head-Cap    $bmp $name $rarity }
  }
}

# ══════════════════════════════════════════════════════════════════
#                       GEAR — chest (plate / robe / tunic / mail)
# ══════════════════════════════════════════════════════════════════
#
# Chest covers rows 38..60 (torso). Width = 24 (stocky) or 20 (slim);
# we paint at the wider 24 width and let compositor squash to slim.

function Draw-Chest {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity
  $lower = $name.ToLower()

  # Variant detection
  $variant = Rng-Pick 4    # 0=plate, 1=robe, 2=tunic, 3=mail
  if ($lower -match 'plate|cuirass|carapace|ironclad|hauberk') { $variant = 0 }
  elseif ($lower -match 'robe|vestment|drape|cloak|cassock') { $variant = 1 }
  elseif ($lower -match 'tunic|jerkin|gambeson|jacket') { $variant = 2 }
  elseif ($lower -match 'mail|chainmail|chain') { $variant = 3 }

  $cx = 32
  $top = 38
  $bot = 61
  $w = 26   # slightly wider than torso to overlap shoulders cleanly
  $hx = $cx - [int]($w / 2)
  $h = $bot - $top

  switch ($variant) {
    0 {  # Plate
      Shade-Box $bmp $hx $top $w $h $metal -RimLight
      # Pectoral seam (down centre)
      Fill-Box $bmp $cx $top 1 $h $metal.shadow
      # Top neckline V-cut
      Fill-Box $bmp ($cx - 2) $top 5 1 $metal.deep
      # Shoulder pauldrons — bumps on the upper outer
      foreach ($side in @(-1, 1)) {
        $sx = $cx + $side * 11
        Shade-Box $bmp ($sx - 1) ($top - 1) 4 5 $metal -RimLight
        Draw-Rivet $bmp $sx ($top + 1) $metal
      }
      # Belt
      Fill-Box $bmp $hx ($bot - 3) $w 2 $MAT_LEATHER.shadow
      Fill-Box $bmp $hx ($bot - 3) $w 1 $MAT_LEATHER.base
      Fill-Box $bmp $hx ($bot - 2) $w 1 $MAT_LEATHER.deep
      # Belt buckle
      Fill-Box $bmp ($cx - 1) ($bot - 3) 3 2 $metal.base
      Set-Pixel $bmp $cx ($bot - 3) $metal.top
      # Rivets along the breast plate
      Draw-Rivet $bmp ($hx + 3) ($top + 4) $metal
      Draw-Rivet $bmp ($hx + $w - 4) ($top + 4) $metal
      Draw-Rivet $bmp ($hx + 3) ($top + 12) $metal
      Draw-Rivet $bmp ($hx + $w - 4) ($top + 12) $metal
      # Heraldic crest (rare+)
      if ($detail -ge 2) {
        $gem = Gem-Palette $name
        Draw-Gem $bmp $cx ($top + 6) 3 $gem
      }
    }
    1 {  # Robe
      $cloth = if ($lower -match 'silk|royal|seasilk') { $MAT_CLOTH_LINEN } else { $MAT_CLOTH_WOOL }
      # Slight flare toward bottom
      for ($y = 0; $y -lt $h; $y++) {
        $rowW = $w + [int]($y / 4)
        $rowX = $cx - [int]($rowW / 2)
        Fill-Box $bmp $rowX ($top + $y) $rowW 1 $cloth.base
        Set-Pixel $bmp $rowX ($top + $y) $cloth.high
        Set-Pixel $bmp ($rowX + $rowW - 1) ($top + $y) $cloth.shadow
        # Vertical fold lines (every 4 rows)
        if ((($top + $y) % 4) -eq 0) {
          Set-Pixel $bmp ($rowX + 5)              ($top + $y) $cloth.shadow
          Set-Pixel $bmp ($rowX + $rowW - 6)      ($top + $y) $cloth.high
        }
      }
      # Sash across the torso (diagonal accent)
      $sashCol = if ($detail -ge 2) { $accent } else { $cloth.deep }
      for ($y = 0; $y -lt 4; $y++) {
        Fill-Box $bmp ($hx - 1) ($top + 4 + $y) ($w + 1) 1 $sashCol
      }
      # Hem trim
      if ($detail -ge 2) {
        Fill-Box $bmp ($hx - 1) ($bot - 1) ($w + 2) 1 $accent
      }
      # Embroidered glyph (epic+)
      if ($detail -ge 3) {
        $gem = Gem-Palette $name
        Draw-Gem $bmp $cx ($top + 14) 3 $gem
      }
    }
    2 {  # Tunic / jerkin
      $cloth = $MAT_LEATHER
      Shade-Box $bmp $hx $top $w $h $cloth -RimLight
      # Front lacing
      for ($y = 1; $y -lt ($h - 3); $y += 2) {
        Set-Pixel $bmp ($cx - 1) ($top + $y) $MAT_LEATHER.deep
        Set-Pixel $bmp ($cx + 1) ($top + $y) $MAT_LEATHER.deep
        Set-Pixel $bmp $cx ($top + $y) $cloth.high
      }
      # Collar
      Fill-Box $bmp ($cx - 3) $top 7 1 $cloth.deep
      Fill-Box $bmp ($cx - 3) ($top + 1) 7 1 $cloth.high
      # Belt
      Fill-Box $bmp $hx ($bot - 4) $w 2 $MAT_LEATHER.deep
      Fill-Box $bmp $hx ($bot - 4) $w 1 $MAT_LEATHER.high
      # Belt buckle
      Fill-Box $bmp ($cx - 1) ($bot - 4) 3 2 $metal.base
      Set-Pixel $bmp $cx ($bot - 4) $metal.top
      # Stitch pattern along shoulders
      if ($detail -ge 1) {
        for ($x = 1; $x -lt 6; $x += 2) {
          Set-Pixel $bmp ($hx + $x) ($top + 2) $cloth.high
          Set-Pixel $bmp ($hx + $w - 1 - $x) ($top + 2) $cloth.high
        }
      }
    }
    3 {  # Mail / chain
      # Background dark cloth gambeson
      Fill-Box $bmp $hx $top $w $h $metal.deep
      # Dotted ring pattern overlay
      for ($y = 0; $y -lt $h; $y++) {
        for ($x = 0; $x -lt $w; $x++) {
          $cellX = $x; $cellY = $y
          # Stagger every other row
          $shift = if (($y % 2) -eq 0) { 0 } else { 1 }
          if ((($x + $shift) % 2) -eq 0 -and ($y % 2) -eq 0) {
            Set-Pixel $bmp ($hx + $x) ($top + $y) $metal.base
            Set-Pixel $bmp ($hx + $x) ($top + $y - 1) $metal.high
          }
        }
      }
      # Pauldrons
      foreach ($side in @(-1, 1)) {
        $sx = $cx + $side * 11
        Shade-Box $bmp ($sx - 1) ($top - 1) 4 5 $metal -RimLight
      }
      # Belt
      Fill-Box $bmp $hx ($bot - 3) $w 2 $MAT_LEATHER.shadow
      Fill-Box $bmp $hx ($bot - 3) $w 1 $MAT_LEATHER.high
      # Buckle
      Fill-Box $bmp ($cx - 1) ($bot - 3) 3 2 $metal.base
      # Tabard hanging in front (rare+)
      if ($detail -ge 2) {
        Fill-Box $bmp ($cx - 3) ($top + 4) 7 14 $accent
        Set-Pixel $bmp ($cx - 3) ($top + 4) $metal.deep
        Set-Pixel $bmp ($cx + 3) ($top + 4) $metal.deep
        # Crest on tabard
        $gem = Gem-Palette $name
        Draw-Gem $bmp $cx ($top + 10) 3 $gem
      }
    }
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ══════════════════════════════════════════════════════════════════
#                       GEAR — legs (greaves / pants / skirt)
# ══════════════════════════════════════════════════════════════════
function Draw-Legs {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity
  $lower = $name.ToLower()

  $cx = 32
  $top = 61
  $bot = 74
  $h = $bot - $top

  $variant = Rng-Pick 3
  if ($lower -match 'greaves|plate|sabaton|legguard|cuisses') { $variant = 0 }
  elseif ($lower -match 'skirt|dress|kilt|robe') { $variant = 2 }
  elseif ($lower -match 'pants|trousers|breeches|leggings') { $variant = 1 }

  switch ($variant) {
    0 {  # Plate greaves
      foreach ($side in @(($LEG_LX), ($LEG_RX))) {
        Shade-Box $bmp $side $top $LEG_W $h $metal -RimLight
        # Knee plate
        Shade-Disc $bmp ($side + 2) ($top + 6) 2.5 $metal
        # Rivets
        Draw-Rivet $bmp ($side + 1) ($top + 1) $metal
        Draw-Rivet $bmp ($side + $LEG_W - 2) ($top + 1) $metal
        Draw-Rivet $bmp ($side + 1) ($top + $h - 2) $metal
        Draw-Rivet $bmp ($side + $LEG_W - 2) ($top + $h - 2) $metal
        # Etch line down centre
        if ($detail -ge 2) {
          Fill-Box $bmp ($side + [int]($LEG_W / 2)) $top 1 $h $metal.shadow
          Set-Pixel $bmp ($side + [int]($LEG_W / 2)) ($top + 2) $accent
        }
      }
    }
    1 {  # Pants / breeches
      $cloth = if ($lower -match 'leather') { $MAT_LEATHER } else { $MAT_CLOTH_WOOL }
      foreach ($side in @(($LEG_LX), ($LEG_RX))) {
        Shade-Box $bmp $side $top $LEG_W $h $cloth
        # Stitch line
        Set-Pixel $bmp ($side + [int]($LEG_W / 2)) $top $cloth.shadow
        # Knee patch
        Fill-Box $bmp $side ($top + 6) $LEG_W 1 $cloth.deep
        if ($detail -ge 2) {
          # Side stripe
          Fill-Box $bmp ($side + $LEG_W - 1) $top 1 $h $accent
        }
      }
    }
    2 {  # Skirt / robe lower
      $cloth = $MAT_CLOTH_LINEN
      # Skirt fans out as it descends
      for ($y = 0; $y -lt $h; $y++) {
        $w = 16 + [int]($y / 2)
        $x0 = $cx - [int]($w / 2)
        Fill-Box $bmp $x0 ($top + $y) $w 1 $cloth.base
        Set-Pixel $bmp $x0 ($top + $y) $cloth.high
        Set-Pixel $bmp ($x0 + $w - 1) ($top + $y) $cloth.shadow
        # Pleat lines
        if ((($y * 7) % 3) -eq 0) {
          Set-Pixel $bmp ($x0 + 4) ($top + $y) $cloth.shadow
          Set-Pixel $bmp ($x0 + $w - 5) ($top + $y) $cloth.high
        }
      }
      # Hem trim
      if ($detail -ge 1) {
        Fill-Box $bmp ($cx - 12) ($bot - 1) 24 1 $accent
      }
    }
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

# ══════════════════════════════════════════════════════════════════
#                       GEAR — boots
# ══════════════════════════════════════════════════════════════════
function Draw-Boots {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity
  $lower = $name.ToLower()

  $top = 72
  $bot = 79

  $variant = Rng-Pick 3
  if ($lower -match 'plate|iron|sabaton|steel') { $variant = 0 }
  elseif ($lower -match 'sandal|sole|slipper|foot') { $variant = 2 }
  elseif ($lower -match 'boot|tread|stalker|tracker') { $variant = 1 }

  foreach ($side in @(($LEG_LX), ($LEG_RX))) {
    switch ($variant) {
      0 {  # Sabatons
        # Shaft (covering ankle)
        Shade-Box $bmp $side $top ($LEG_W) 5 $metal -RimLight
        # Toe extension (slightly forward)
        Shade-Box $bmp $side ($top + 4) ($LEG_W + 1) 3 $metal
        # Rivets at top
        Draw-Rivet $bmp ($side + 1) ($top + 1) $metal
        Draw-Rivet $bmp ($side + $LEG_W - 2) ($top + 1) $metal
        # Knee/calf decoration band
        Fill-Box $bmp $side ($top + 3) $LEG_W 1 $metal.deep
        if ($detail -ge 1) {
          Set-Pixel $bmp ($side + 1) ($top + 4) $accent
        }
        # Toe spike (rare+)
        if ($detail -ge 2) {
          Set-Pixel $bmp ($side + $LEG_W) ($bot - 1) $metal.top
        }
      }
      1 {  # Soft leather boots
        Shade-Box $bmp $side $top $LEG_W 7 $MAT_LEATHER -RimLight
        # Cuff
        Fill-Box $bmp ($side - 1) $top ($LEG_W + 2) 1 $MAT_LEATHER.high
        Fill-Box $bmp ($side - 1) ($top + 1) ($LEG_W + 2) 1 $MAT_LEATHER.deep
        # Laces
        if ($detail -ge 1) {
          for ($y = 0; $y -lt 4; $y++) {
            Set-Pixel $bmp ($side + 1 + ($y % 2)) ($top + 3 + $y) $accent
            Set-Pixel $bmp ($side + $LEG_W - 2 - ($y % 2)) ($top + 3 + $y) $accent
          }
          # Crossed lace pattern
          Line-Pixel $bmp ($side + 1) ($top + 3) ($side + $LEG_W - 2) ($top + 5) $MAT_LEATHER.deep
        }
        # Sole shadow
        Fill-Box $bmp $side ($bot - 1) $LEG_W 1 $MAT_LEATHER.deep
      }
      2 {  # Sandals
        # Sole only
        Fill-Box $bmp $side ($bot - 1) $LEG_W 1 $MAT_LEATHER.deep
        Fill-Box $bmp $side ($bot - 2) $LEG_W 1 $MAT_LEATHER.shadow
        # Strap weave
        Line-Pixel $bmp $side ($top + 2) ($side + $LEG_W - 1) ($top + 4) $MAT_LEATHER.base
        Line-Pixel $bmp ($side + $LEG_W - 1) ($top + 2) $side ($top + 4) $MAT_LEATHER.base
        # Ankle strap
        if ($detail -ge 1) {
          Fill-Box $bmp $side $top $LEG_W 1 $MAT_LEATHER.base
          Set-Pixel $bmp ($side + 1) $top $MAT_LEATHER.high
        }
      }
    }
  }
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

function Build-GearSlot {
  param([string]$repoRoot, [string]$slot, $drawer)
  $catalogue = Read-Catalogue -repoRoot $repoRoot
  $pieces = $catalogue | Where-Object { $_.slot -eq $slot }
  $count = 0
  foreach ($p in $pieces) {
    $bmp = New-CanvasFx $CanvasW $CanvasH
    & $drawer $bmp $p.name $p.rarity
    $slug = Slugify $p.name
    Save-CanvasFx $bmp (Join-Path $gearDir ("{0}/{1}.png" -f $slot, $slug))
    $count++
  }
  Write-Host ("  {0}: {1}" -f $slot, $count) -ForegroundColor Green
}

function Build-Head    { param([string]$repoRoot) Write-Host '── Head gear ──' -ForegroundColor Cyan; Build-GearSlot $repoRoot 'head'    ${function:Draw-Head} }
function Build-Chest   { param([string]$repoRoot) Write-Host '── Chest gear ──' -ForegroundColor Cyan; Build-GearSlot $repoRoot 'chest'   ${function:Draw-Chest} }
function Build-Legs    { param([string]$repoRoot) Write-Host '── Legs gear ──' -ForegroundColor Cyan; Build-GearSlot $repoRoot 'legs'    ${function:Draw-Legs} }
function Build-Boots   { param([string]$repoRoot) Write-Host '── Boots gear ──' -ForegroundColor Cyan; Build-GearSlot $repoRoot 'boots'   ${function:Draw-Boots} }

# ══════════════════════════════════════════════════════════════════
#                       GEAR — trinkets
# ══════════════════════════════════════════════════════════════════
#
# Trinkets split into two render zones:
#   • Back-cape  (z=10) — capes, cloaks, wings, mantles, drapes, veils
#   • Front      (z=45) — amulets, charms, rings, sigils, brooches
# Detection follows the same keyword rules as the existing compositor
# (see character.js — back-cape regex).

function Draw-Trinket {
  param($bmp, [string]$name, [string]$rarity)
  Rng-Init $name
  $metal = Rarity-Metal $rarity
  $accent = Rarity-Accent $rarity
  $detail = Rarity-Detail $rarity
  $lower = $name.ToLower()

  # ── Back-cape family ──
  if ($lower -match 'cape|cloak|mantle|drape|veil') {
    $cloth = if ($lower -match 'silk|royal|aurora|spectral') { $MAT_CLOTH_LINEN } else { $MAT_CLOTH_WOOL }
    # Cape colour shifts with rarity — accent-tinted on epic+
    if ($detail -ge 3) {
      $cloth = @{
        deep   = With-Alpha $accent 0 | ForEach-Object { Mix-Color $cloth.deep $accent 0.4 }
        shadow = Mix-Color $cloth.shadow $accent 0.5
        base   = Mix-Color $cloth.base   $accent 0.55
        high   = Mix-Color $cloth.high   $accent 0.6
        top    = Mix-Color $cloth.top    $accent 0.5
      }
    }
    # Drape hangs from collar (row 36) to feet (row 78)
    $top = 36; $bot = 78
    for ($y = $top; $y -le $bot; $y++) {
      # Widens as it descends; gentle billowing curve
      $w = 22 + [int]([Math]::Sin(($y - $top) / [double]($bot - $top) * [Math]::PI) * 6)
      $rowX = 32 - [int]($w / 2)
      Fill-Box $bmp $rowX $y $w 1 $cloth.base
      Set-Pixel $bmp $rowX $y $cloth.shadow
      Set-Pixel $bmp ($rowX + $w - 1) $y $cloth.deep
      # Vertical fold lines (every 5 rows + shift by RNG)
      if ((($y * 3) % 5) -eq 0) {
        Set-Pixel $bmp ($rowX + 5) $y $cloth.shadow
        Set-Pixel $bmp ($rowX + $w - 6) $y $cloth.high
      }
      if ((($y * 5) % 7) -eq 0) {
        Set-Pixel $bmp ($rowX + [int]($w / 2) - 3) $y $cloth.shadow
        Set-Pixel $bmp ($rowX + [int]($w / 2) + 3) $y $cloth.shadow
      }
    }
    # Collar trim
    Fill-Box $bmp 21 35 22 1 $cloth.deep
    Fill-Box $bmp 21 34 22 1 $cloth.shadow
    # Hem trim (rare+)
    if ($detail -ge 2) {
      Fill-Box $bmp 12 $bot 40 1 $accent
      Fill-Box $bmp 12 ($bot - 1) 40 1 $cloth.high
    }
    # Clasp at neck
    $gem = Gem-Palette $name
    Draw-Gem $bmp 32 35 3 $gem
    # Wing feather pattern overlay (uncommon+) on wing-named trinkets
    if ($lower -match 'wing|feather' -and $detail -ge 1) {
      foreach ($side in @(-1, 1)) {
        for ($y = 0; $y -lt 12; $y++) {
          $py = $top + 4 + $y * 3
          $px = 32 + $side * (8 + [int]($y / 3))
          Set-Pixel $bmp $px $py $cloth.high
          Set-Pixel $bmp ($px - $side) $py $cloth.shadow
        }
      }
    }
    if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
    return
  }

  # ── Wings (winged trinket separately) ──
  if ($lower -match 'wings?(\W|$)') {
    $featherCol = if ($detail -ge 3) { $accent } else { (Color-FromHex '#cbd2e0') }
    foreach ($side in @(-1, 1)) {
      for ($y = 0; $y -lt 16; $y++) {
        $featherW = 4 + [int]($y / 4)
        $px = 32 + $side * 12
        $py = 38 + $y
        for ($i = 0; $i -lt $featherW; $i++) {
          $col = if (($i % 2) -eq 0) { $featherCol } else { $MAT_CLOTH_WOOL.shadow }
          Set-Pixel $bmp ($px + $side * $i) $py $col
        }
        Set-Pixel $bmp ($px + $side * $featherW) $py $MAT_CLOTH_WOOL.deep
      }
    }
    if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
    return
  }

  # ── Ring (small, sits over chest) ──
  if ($lower -match 'ring|band|signet') {
    $cx = 32; $cy = 48
    Stroke-Box $bmp ($cx - 2) ($cy - 2) 5 5 $metal.base
    # Top arch highlight
    Set-Pixel $bmp ($cx - 1) ($cy - 2) $metal.high
    Set-Pixel $bmp $cx ($cy - 2) $metal.top
    Set-Pixel $bmp ($cx + 1) ($cy - 2) $metal.high
    # Gem set in the top
    $gem = Gem-Palette $name
    Draw-Gem $bmp $cx ($cy - 1) 3 $gem
    # Halo (epic+)
    if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
    return
  }

  # ── Amulet / pendant / charm / sigil — chain + central gem ──
  if ($lower -match 'amulet|pendant|charm|sigil|brooch|talisman|locket|necklace|crystal|coin|claw|tooth|gem|orb|stone|sapphire|ruby|emerald|diamond|jewel|focus|relic|core|crest|medal|heart|tear|eye') {
    $cx = 32
    $cy = 49
    # Chain — two diagonal segments going up to nape
    for ($i = 0; $i -lt 8; $i++) {
      Set-Pixel $bmp ($cx - 2 - $i) ($cy - 3 - $i) $metal.high
      Set-Pixel $bmp ($cx - 3 - $i) ($cy - 3 - $i) $metal.shadow
      Set-Pixel $bmp ($cx + 2 + $i) ($cy - 3 - $i) $metal.high
      Set-Pixel $bmp ($cx + 3 + $i) ($cy - 3 - $i) $metal.shadow
    }
    # Bezel — metal frame around the gem
    Shade-Box $bmp ($cx - 3) ($cy - 2) 7 6 $metal -RimLight
    # Central gem
    $gem = Gem-Palette $name
    if ($lower -match 'orb|sphere|core|moon|sun|eye|heart') {
      Draw-Gem $bmp $cx ($cy + 1) 5 $gem -Round
    } else {
      Draw-Gem $bmp $cx ($cy + 1) 5 $gem
    }
    # Decorative bezel prongs at corners
    if ($detail -ge 1) {
      Set-Pixel $bmp ($cx - 3) ($cy - 2) $metal.top
      Set-Pixel $bmp ($cx + 3) ($cy - 2) $metal.top
      Set-Pixel $bmp ($cx - 3) ($cy + 3) $metal.deep
      Set-Pixel $bmp ($cx + 3) ($cy + 3) $metal.deep
    }
    # Halo
    if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
    return
  }

  # ── Default — small bauble on the chest ──
  $cx = 32; $cy = 49
  $gem = Gem-Palette $name
  Shade-Box $bmp ($cx - 3) ($cy - 2) 7 6 $metal -RimLight
  Draw-Gem $bmp $cx ($cy + 1) 5 $gem
  if ($detail -ge 3) { Apply-Rarity-Glow $bmp $rarity }
}

function Build-Trinket { param([string]$repoRoot) Write-Host '── Trinket gear ──' -ForegroundColor Cyan; Build-GearSlot $repoRoot 'trinket' ${function:Draw-Trinket} }

# ══════════════════════════════════════════════════════════════════
#                       PETS — companion animals
# ══════════════════════════════════════════════════════════════════
#
# Pet sits in the bottom-right gutter of the canvas — to the right
# of the figure, on the ground. Anchored bottom-aligned so pet
# stands on the floor at y=79.
#
# Each species has 4 colour variants; same silhouette, only palette
# changes. Mood overlays float above the pet head.

$PET_OX = 46
$PET_OY = 56
$PET_W  = 18
$PET_H  = 23

# Species × colour palettes. Each is { deep; shadow; base; high; top; eye }.
function PetRamp { param([hashtable]$h)
  return @{
    deep   = Color-FromHex $h.deep;
    shadow = Color-FromHex $h.shadow;
    base   = Color-FromHex $h.base;
    high   = Color-FromHex $h.high;
    top    = Color-FromHex $h.top;
    eye    = Color-FromHex $h.eye;
  }
}

$PET_PALETTES = @{
  'cat-black'    = @{ deep='#000004'; shadow='#15151b'; base='#2a2a32'; high='#444452'; top='#5f6072'; eye='#5bff95' };
  'cat-tabby'    = @{ deep='#2a1a08'; shadow='#5a4022'; base='#7e5a32'; high='#a07840'; top='#c89858'; eye='#46d160' };
  'cat-ginger'   = @{ deep='#6a2a00'; shadow='#a4490c'; base='#d76d20'; high='#f5933e'; top='#ffb462'; eye='#5bff95' };
  'cat-calico'   = @{ deep='#2a1408'; shadow='#5a3018'; base='#e8d4b0'; high='#fff5da'; top='#ffffff'; eye='#3a86ff' };
  'dog-cream'    = @{ deep='#704818'; shadow='#a47840'; base='#e8c884'; high='#fff0b8'; top='#fff8d8'; eye='#3a2010' };
  'dog-spotted'  = @{ deep='#0a0a14'; shadow='#202028'; base='#f8f8fa'; high='#ffffff'; top='#ffffff'; eye='#3a2010' };
  'dog-amber'    = @{ deep='#3a2008'; shadow='#6a3a14'; base='#a86028'; high='#d4843c'; top='#f0a85a'; eye='#3a2010' };
  'dog-midnight' = @{ deep='#00000a'; shadow='#0a0a14'; base='#1c1c28'; high='#34344a'; top='#5a5a78'; eye='#5bff95' };
  'owl-barn'     = @{ deep='#5a3614'; shadow='#8a5a30'; base='#c08858'; high='#e8b888'; top='#ffd4a8'; eye='#0a0a12' };
  'owl-snowy'    = @{ deep='#70708a'; shadow='#a0a0b0'; base='#e8e8f0'; high='#ffffff'; top='#ffffff'; eye='#0a0a12' };
  'owl-sage'     = @{ deep='#2a4030'; shadow='#4a6a4a'; base='#7ca080'; high='#a8c8a8'; top='#c8e0c8'; eye='#0a0a12' };
  'owl-twilight' = @{ deep='#1a0c2a'; shadow='#3a2858'; base='#6a4ca0'; high='#9a82ff'; top='#cdb8ff'; eye='#f0b429' };
  'fox-rust'     = @{ deep='#6a1408'; shadow='#a02810'; base='#d86432'; high='#f59060'; top='#ffb088'; eye='#0a0a12' };
  'fox-arctic'   = @{ deep='#787888'; shadow='#a8a8b8'; base='#e8e8f4'; high='#ffffff'; top='#ffffff'; eye='#3a86ff' };
  'fox-plum'     = @{ deep='#280a30'; shadow='#4a2050'; base='#7c4a90'; high='#b078c8'; top='#d2a0e8'; eye='#f0b429' };
  'fox-gold'     = @{ deep='#5a3508'; shadow='#8a5a18'; base='#d49a30'; high='#f4c860'; top='#ffe098'; eye='#1c2034' };
  'slime-mint'   = @{ deep='#125030'; shadow='#2a8060'; base='#5be098'; high='#a0ffcc'; top='#d8fff0'; eye='#0a0a12' };
  'slime-cobalt' = @{ deep='#0a1c48'; shadow='#163065'; base='#3a72d8'; high='#74a8ff'; top='#a8caff'; eye='#ffffff' };
  'slime-rose'   = @{ deep='#5a1830'; shadow='#a02858'; base='#e87aa8'; high='#ffb0d0'; top='#ffd8e8'; eye='#0a0a12' };
  'slime-aurora' = @{ deep='#28186a'; shadow='#4830a0'; base='#7c5cff'; high='#a890ff'; top='#d0c0ff'; eye='#5bff95' };
  'dragonling-emerald' = @{ deep='#0a2810'; shadow='#1a5028'; base='#3a9050'; high='#5fc878'; top='#88e8a0'; eye='#f0b429' };
  'dragonling-ember'   = @{ deep='#3a0808'; shadow='#6a1010'; base='#c43020'; high='#f06040'; top='#ff8868'; eye='#f0e028' };
  'dragonling-storm'   = @{ deep='#1a2030'; shadow='#283848'; base='#506880'; high='#88a0b8'; top='#b8cce0'; eye='#5bff95' };
  'dragonling-voltaic' = @{ deep='#1a0c40'; shadow='#3a1f7a'; base='#7c5cff'; high='#a890ff'; top='#d8c8ff'; eye='#5bff95' };
  'frog-leaf'     = @{ deep='#102810'; shadow='#2a5028'; base='#4a8030'; high='#7cb850'; top='#a8e078'; eye='#f0b429' };
  'frog-lily'     = @{ deep='#0a1c2a'; shadow='#1a4060'; base='#3878a0'; high='#70b0d4'; top='#a0d4ec'; eye='#f0b429' };
  'frog-inkblot'  = @{ deep='#000006'; shadow='#0a0a14'; base='#252530'; high='#48485c'; top='#707088'; eye='#5bff95' };
  'frog-sunburst' = @{ deep='#6a3a08'; shadow='#a06820'; base='#e8a838'; high='#ffd070'; top='#ffe8a0'; eye='#1c2034' };
  'bunny-ash'        = @{ deep='#4a4e58'; shadow='#6a6e78'; base='#a0a4ac'; high='#d4d8e0'; top='#f0f2f8'; eye='#1c2034' };
  'bunny-cocoa'      = @{ deep='#2a1808'; shadow='#4a2a18'; base='#7c4a2a'; high='#a87048'; top='#d09068'; eye='#1c2034' };
  'bunny-meadow'     = @{ deep='#1a4020'; shadow='#2a6030'; base='#5fa848'; high='#90d870'; top='#b8e898'; eye='#1c2034' };
  'bunny-starlight'  = @{ deep='#3a2858'; shadow='#5a4a78'; base='#a890ff'; high='#e0d0ff'; top='#ffffff'; eye='#5bff95' };
}

function Pet-Ramp { param([string]$key)
  $pal = $PET_PALETTES[$key]
  if (-not $pal) { throw "Unknown pet palette: $key" }
  return PetRamp $pal
}

# Ground shadow under pet
function Draw-PetGround {
  param($bmp, [int]$cx)
  $shadow = (Color-FromHex '#080810')
  for ($dx = -7; $dx -le 7; $dx++) {
    $a = 150 - [Math]::Abs($dx) * 16
    if ($a -lt 30) { continue }
    Blend-Pixel $bmp ($cx + $dx) 79 (With-Alpha $shadow $a)
  }
  for ($dx = -5; $dx -le 5; $dx++) {
    Blend-Pixel $bmp ($cx + $dx) 78 (With-Alpha $shadow ([Math]::Max(20, 60 - [Math]::Abs($dx) * 8)))
  }
}

# ── Cat ────────────────────────────────────────────────────────────
function Draw-Pet-Cat {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  $cx = $ox + 9
  Draw-PetGround $bmp $cx
  # Body — sitting cat, hourglass shape
  Shade-Oval $bmp $cx ($oy + 14) 5.5 5.5 $pal
  # Lighter belly patch
  Set-Pixel $bmp ($cx - 1) ($oy + 15) $pal.high
  Set-Pixel $bmp $cx ($oy + 15) $pal.high
  Set-Pixel $bmp ($cx - 1) ($oy + 16) $pal.top
  # Head sitting on top
  Shade-Oval $bmp $cx ($oy + 5) 4 4 $pal
  # Ear tufts
  Set-Pixel $bmp ($cx - 4) ($oy + 1) $pal.base
  Set-Pixel $bmp ($cx - 3) ($oy)     $pal.base
  Set-Pixel $bmp ($cx - 3) ($oy + 1) $pal.shadow
  Set-Pixel $bmp ($cx + 3) ($oy + 1) $pal.base
  Set-Pixel $bmp ($cx + 4) ($oy)     $pal.base
  Set-Pixel $bmp ($cx + 4) ($oy + 1) $pal.shadow
  # Inner ear
  Set-Pixel $bmp ($cx - 3) ($oy + 2) (Color-FromHex '#ffb8c0')
  Set-Pixel $bmp ($cx + 3) ($oy + 2) (Color-FromHex '#ffb8c0')
  # Eyes
  Set-Pixel $bmp ($cx - 2) ($oy + 5) $pal.eye
  Set-Pixel $bmp ($cx + 2) ($oy + 5) $pal.eye
  Set-Pixel $bmp ($cx - 2) ($oy + 4) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($cx + 2) ($oy + 4) (Color-FromHex '#ffffff')
  # Nose
  Set-Pixel $bmp $cx ($oy + 6) (Color-FromHex '#e88ca8')
  # Mouth
  Set-Pixel $bmp ($cx - 1) ($oy + 7) $pal.shadow
  Set-Pixel $bmp ($cx + 1) ($oy + 7) $pal.shadow
  # Whiskers
  Set-Pixel $bmp ($cx - 4) ($oy + 6) $pal.high
  Set-Pixel $bmp ($cx + 4) ($oy + 6) $pal.high
  # Curling tail up the right side
  Line-Pixel $bmp ($cx + 5) ($oy + 17) ($cx + 7) ($oy + 13) $pal.base
  Set-Pixel $bmp ($cx + 7) ($oy + 12) $pal.base
  Set-Pixel $bmp ($cx + 7) ($oy + 11) $pal.high
  Set-Pixel $bmp ($cx + 6) ($oy + 11) $pal.top
  Set-Pixel $bmp ($cx + 8) ($oy + 12) $pal.shadow
  # Front paws
  Set-Pixel $bmp ($cx - 3) ($oy + 19) $pal.deep
  Set-Pixel $bmp ($cx + 3) ($oy + 19) $pal.deep
  Set-Pixel $bmp ($cx - 4) ($oy + 19) $pal.shadow
  Set-Pixel $bmp ($cx + 4) ($oy + 19) $pal.shadow
}

# ── Dog ────────────────────────────────────────────────────────────
function Draw-Pet-Dog {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  $cx = $ox + 9
  Draw-PetGround $bmp $cx
  # Body — chunkier, lower stance
  Shade-Oval $bmp $cx ($oy + 14) 6.5 5 $pal
  # Bottom shadow + paws
  Set-Pixel $bmp ($cx - 4) ($oy + 19) $pal.deep
  Set-Pixel $bmp ($cx - 3) ($oy + 19) $pal.deep
  Set-Pixel $bmp ($cx + 3) ($oy + 19) $pal.deep
  Set-Pixel $bmp ($cx + 4) ($oy + 19) $pal.deep
  Set-Pixel $bmp ($cx - 4) ($oy + 18) $pal.shadow
  Set-Pixel $bmp ($cx + 4) ($oy + 18) $pal.shadow
  # Head — round
  Shade-Oval $bmp $cx ($oy + 5) 4.5 4 $pal
  # Snout
  Fill-Box $bmp ($cx - 1) ($oy + 7) 3 2 $pal.base
  Set-Pixel $bmp ($cx + 1) ($oy + 8) $pal.shadow
  Set-Pixel $bmp $cx ($oy + 8) (Color-FromHex '#1a1018')   # nose tip
  # Floppy ears
  Fill-Box $bmp ($cx - 5) ($oy + 4) 1 5 $pal.shadow
  Fill-Box $bmp ($cx - 4) ($oy + 5) 1 4 $pal.deep
  Fill-Box $bmp ($cx + 4) ($oy + 4) 1 5 $pal.shadow
  Fill-Box $bmp ($cx + 3) ($oy + 5) 1 4 $pal.deep
  # Eyes
  Set-Pixel $bmp ($cx - 2) ($oy + 5) $pal.eye
  Set-Pixel $bmp ($cx + 2) ($oy + 5) $pal.eye
  Set-Pixel $bmp ($cx - 2) ($oy + 4) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($cx + 2) ($oy + 4) (Color-FromHex '#ffffff')
  # Tail — stubby wag (up + right)
  Set-Pixel $bmp ($cx + 7) ($oy + 11) $pal.base
  Set-Pixel $bmp ($cx + 8) ($oy + 10) $pal.base
  Set-Pixel $bmp ($cx + 8) ($oy + 9) $pal.high
  Set-Pixel $bmp ($cx + 7) ($oy + 12) $pal.shadow
}

# ── Owl ────────────────────────────────────────────────────────────
function Draw-Pet-Owl {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  $cx = $ox + 9
  Draw-PetGround $bmp $cx
  # Body — wide oval, sits low (head + body merged)
  Shade-Oval $bmp $cx ($oy + 11) 5.5 8 $pal
  # Chest stripe (lighter)
  Fill-Box $bmp ($cx - 2) ($oy + 9) 5 7 $pal.high
  Set-Pixel $bmp ($cx - 1) ($oy + 10) $pal.top
  # Ear tufts
  Set-Pixel $bmp ($cx - 4) ($oy + 2) $pal.base
  Set-Pixel $bmp ($cx - 3) ($oy + 1) $pal.base
  Set-Pixel $bmp ($cx + 3) ($oy + 2) $pal.base
  Set-Pixel $bmp ($cx + 4) ($oy + 1) $pal.base
  # Big circle eyes — disc + pupil + glint
  Shade-Disc $bmp ($cx - 2) ($oy + 5) 2 (PetRamp @{deep='#aaa890'; shadow='#d4d2b8'; base='#fff8e0'; high='#ffffff'; top='#ffffff'; eye='#000000'})
  Shade-Disc $bmp ($cx + 2) ($oy + 5) 2 (PetRamp @{deep='#aaa890'; shadow='#d4d2b8'; base='#fff8e0'; high='#ffffff'; top='#ffffff'; eye='#000000'})
  Set-Pixel $bmp ($cx - 2) ($oy + 5) $pal.eye
  Set-Pixel $bmp ($cx + 2) ($oy + 5) $pal.eye
  Set-Pixel $bmp ($cx - 1) ($oy + 4) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($cx + 3) ($oy + 4) (Color-FromHex '#ffffff')
  # Beak
  $beak = Color-FromHex '#f0b429'
  Set-Pixel $bmp $cx ($oy + 6) $beak
  Set-Pixel $bmp $cx ($oy + 7) (Color-FromHex '#a07020')
  # Wing edge details (folded against body)
  for ($y = 0; $y -lt 5; $y++) {
    Set-Pixel $bmp ($cx - 5) ($oy + 9 + $y) $pal.deep
    Set-Pixel $bmp ($cx + 5) ($oy + 9 + $y) $pal.deep
  }
  # Feet
  Set-Pixel $bmp ($cx - 2) ($oy + 19) $beak
  Set-Pixel $bmp ($cx - 1) ($oy + 19) $beak
  Set-Pixel $bmp ($cx + 2) ($oy + 19) $beak
  Set-Pixel $bmp ($cx + 1) ($oy + 19) $beak
}

# ── Fox ────────────────────────────────────────────────────────────
function Draw-Pet-Fox {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  $cx = $ox + 9
  Draw-PetGround $bmp $cx
  # Body — sleek, slightly hunched
  Shade-Oval $bmp $cx ($oy + 14) 5.5 5 $pal
  # Lighter belly
  Set-Pixel $bmp $cx ($oy + 15) $pal.high
  Set-Pixel $bmp ($cx + 1) ($oy + 15) $pal.top
  # Head — triangular with pointed snout
  Shade-Oval $bmp $cx ($oy + 5) 4 4 $pal
  Fill-Box $bmp ($cx - 1) ($oy + 7) 3 2 $pal.base
  Set-Pixel $bmp $cx ($oy + 8) (Color-FromHex '#1a1018')
  Set-Pixel $bmp ($cx - 1) ($oy + 8) $pal.shadow
  Set-Pixel $bmp ($cx + 1) ($oy + 8) $pal.shadow
  # Pointed ears
  Set-Pixel $bmp ($cx - 4) ($oy)     $pal.base
  Set-Pixel $bmp ($cx - 3) ($oy + 1) $pal.base
  Set-Pixel $bmp ($cx - 3) ($oy)     $pal.high
  Set-Pixel $bmp ($cx + 3) ($oy + 1) $pal.base
  Set-Pixel $bmp ($cx + 4) ($oy)     $pal.base
  Set-Pixel $bmp ($cx + 4) ($oy)     $pal.high
  # Inner ear
  Set-Pixel $bmp ($cx - 4) ($oy + 1) $pal.deep
  Set-Pixel $bmp ($cx + 4) ($oy + 1) $pal.deep
  # Eyes
  Set-Pixel $bmp ($cx - 2) ($oy + 5) $pal.eye
  Set-Pixel $bmp ($cx + 2) ($oy + 5) $pal.eye
  # Paws
  Set-Pixel $bmp ($cx - 4) ($oy + 19) $pal.deep
  Set-Pixel $bmp ($cx + 4) ($oy + 19) $pal.deep
  # Bushy tail — sweep up-back-right
  $tx = $cx + 6
  for ($i = 0; $i -lt 8; $i++) {
    $px = $tx + [int]($i * 0.4)
    $py = $oy + 14 - [int]($i * 1.0)
    Set-Pixel $bmp $px $py $pal.base
    Set-Pixel $bmp ($px - 1) $py $pal.shadow
    Set-Pixel $bmp ($px + 1) $py $pal.high
  }
  # White tail tip
  Set-Pixel $bmp ($tx + 3) ($oy + 7) $pal.top
  Set-Pixel $bmp ($tx + 4) ($oy + 6) $pal.top
  Set-Pixel $bmp ($tx + 4) ($oy + 7) $pal.high
}

# ── Slime ──────────────────────────────────────────────────────────
function Draw-Pet-Slime {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  $cx = $ox + 9
  Draw-PetGround $bmp $cx
  # Translucent dome — wide base tapering up
  for ($y = 0; $y -lt 14; $y++) {
    $py = $oy + 6 + $y
    $w = 4 + [int]($y * 0.6)
    if ($y -gt 9) { $w = 12 - ($y - 9) }
    $x0 = $cx - [int]($w / 2)
    Fill-Box $bmp $x0 $py $w 1 $pal.base
    Set-Pixel $bmp $x0 $py $pal.shadow
    Set-Pixel $bmp ($x0 + $w - 1) $py $pal.deep
  }
  # Translucent shine — upper-left arc
  for ($i = 0; $i -lt 3; $i++) {
    Set-Pixel $bmp ($cx - 3 + $i) ($oy + 8) $pal.high
  }
  Set-Pixel $bmp ($cx - 2) ($oy + 7) $pal.top
  # Inner glow speck
  Set-Pixel $bmp ($cx - 1) ($oy + 10) $pal.top
  Set-Pixel $bmp ($cx + 2) ($oy + 12) $pal.high
  # Eyes (squinting smile)
  Set-Pixel $bmp ($cx - 2) ($oy + 13) $pal.eye
  Set-Pixel $bmp ($cx + 2) ($oy + 13) $pal.eye
  Set-Pixel $bmp ($cx - 2) ($oy + 14) $pal.eye
  Set-Pixel $bmp ($cx + 2) ($oy + 14) $pal.eye
  # Smile
  Set-Pixel $bmp $cx ($oy + 15) $pal.eye
  Set-Pixel $bmp ($cx - 1) ($oy + 16) $pal.eye
  Set-Pixel $bmp ($cx + 1) ($oy + 16) $pal.eye
  # Droplet drips around the base
  Set-Pixel $bmp ($cx + 7) ($oy + 18) $pal.shadow
  Set-Pixel $bmp ($cx - 7) ($oy + 18) $pal.shadow
}

# ── Dragonling ─────────────────────────────────────────────────────
function Draw-Pet-Dragonling {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  $cx = $ox + 9
  Draw-PetGround $bmp $cx
  # Body — sturdy, scaled
  Shade-Oval $bmp $cx ($oy + 14) 5.5 5 $pal
  # Belly plating — lighter horizontal stripes
  Set-Pixel $bmp ($cx - 1) ($oy + 15) $pal.high
  Set-Pixel $bmp $cx       ($oy + 15) $pal.top
  Set-Pixel $bmp ($cx + 1) ($oy + 15) $pal.high
  Set-Pixel $bmp $cx       ($oy + 17) $pal.high
  # Head — boxy
  Shade-Box $bmp ($cx - 3) ($oy + 3) 7 5 $pal -RimLight
  # Snout extension
  Fill-Box $bmp ($cx - 4) ($oy + 6) 2 2 $pal.base
  Set-Pixel $bmp ($cx - 5) ($oy + 7) $pal.shadow
  # Horns (curving back)
  Set-Pixel $bmp ($cx - 3) ($oy + 1) $pal.high
  Set-Pixel $bmp ($cx - 2) ($oy)     $pal.top
  Set-Pixel $bmp ($cx + 3) ($oy + 1) $pal.high
  Set-Pixel $bmp ($cx + 4) ($oy)     $pal.top
  Set-Pixel $bmp ($cx + 5) ($oy - 1) $pal.high
  # Glowing eyes
  Set-Pixel $bmp ($cx - 2) ($oy + 5) $pal.eye
  Set-Pixel $bmp ($cx + 2) ($oy + 5) $pal.eye
  Set-Pixel $bmp ($cx - 2) ($oy + 6) $pal.eye
  Set-Pixel $bmp ($cx + 2) ($oy + 6) $pal.eye
  # Folded wings on back
  for ($y = 0; $y -lt 6; $y++) {
    Set-Pixel $bmp ($cx + 5) ($oy + 9 + $y) $pal.shadow
    Set-Pixel $bmp ($cx + 6) ($oy + 9 + $y) $pal.deep
    if ($y -lt 3) {
      Set-Pixel $bmp ($cx + 6) ($oy + 9 + $y) $pal.shadow
      Set-Pixel $bmp ($cx + 7) ($oy + 10 + $y) $pal.deep
    }
  }
  # Spiky tail curling up
  Line-Pixel $bmp ($cx + 5) ($oy + 17) ($cx + 8) ($oy + 12) $pal.base
  Set-Pixel $bmp ($cx + 8) ($oy + 11) $pal.high
  Set-Pixel $bmp ($cx + 9) ($oy + 11) $pal.top   # tail spike
  Set-Pixel $bmp ($cx + 9) ($oy + 12) $pal.shadow
  # Paws
  Set-Pixel $bmp ($cx - 4) ($oy + 19) $pal.deep
  Set-Pixel $bmp ($cx + 4) ($oy + 19) $pal.deep
  # Dorsal spikes
  Set-Pixel $bmp $cx ($oy + 11) $pal.high
  Set-Pixel $bmp ($cx + 2) ($oy + 11) $pal.high
}

# ── Frog ───────────────────────────────────────────────────────────
function Draw-Pet-Frog {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  $cx = $ox + 9
  Draw-PetGround $bmp $cx
  # Squat body
  Shade-Oval $bmp $cx ($oy + 13) 6.5 5 $pal
  # Lighter belly
  Fill-Box $bmp ($cx - 3) ($oy + 14) 7 4 $pal.high
  Set-Pixel $bmp $cx ($oy + 15) $pal.top
  # Head (wide, lower-set)
  Shade-Oval $bmp $cx ($oy + 7) 5 3 $pal
  # Bulging dome eyes on top — pet-base coloured volumes
  Shade-Disc $bmp ($cx - 3) ($oy + 4) 2 $pal
  Shade-Disc $bmp ($cx + 3) ($oy + 4) 2 $pal
  # Pupils
  Set-Pixel $bmp ($cx - 3) ($oy + 4) $pal.eye
  Set-Pixel $bmp ($cx + 3) ($oy + 4) $pal.eye
  Set-Pixel $bmp ($cx - 4) ($oy + 3) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($cx + 2) ($oy + 3) (Color-FromHex '#ffffff')
  # Wide grin mouth
  Fill-Box $bmp ($cx - 3) ($oy + 9) 7 1 $pal.deep
  # Spots on back (decorative)
  Set-Pixel $bmp ($cx - 2) ($oy + 12) $pal.deep
  Set-Pixel $bmp ($cx + 2) ($oy + 12) $pal.deep
  Set-Pixel $bmp $cx ($oy + 14) $pal.deep
  # Front legs (squat)
  Set-Pixel $bmp ($cx - 5) ($oy + 19) $pal.deep
  Set-Pixel $bmp ($cx - 4) ($oy + 19) $pal.shadow
  Set-Pixel $bmp ($cx + 4) ($oy + 19) $pal.shadow
  Set-Pixel $bmp ($cx + 5) ($oy + 19) $pal.deep
}

# ── Bunny ──────────────────────────────────────────────────────────
function Draw-Pet-Bunny {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  $cx = $ox + 9
  Draw-PetGround $bmp $cx
  # Body — egg-shape upright
  Shade-Oval $bmp $cx ($oy + 14) 5 5 $pal
  # Lighter belly
  Fill-Box $bmp ($cx - 2) ($oy + 15) 4 3 $pal.high
  # Head — small round
  Shade-Oval $bmp $cx ($oy + 8) 3.5 3.5 $pal
  # Long ears — tall vertical pair
  for ($y = 0; $y -lt 7; $y++) {
    Set-Pixel $bmp ($cx - 3) ($oy + $y) $pal.base
    Set-Pixel $bmp ($cx - 3) ($oy + $y) $pal.high
    Set-Pixel $bmp ($cx + 3) ($oy + $y) $pal.base
  }
  # Ear inner (pink)
  for ($y = 1; $y -lt 5; $y++) {
    Set-Pixel $bmp ($cx - 3) ($oy + $y) (Color-FromHex '#e8a8b0')
    Set-Pixel $bmp ($cx + 3) ($oy + $y) (Color-FromHex '#e8a8b0')
  }
  # Ear outer outline
  Set-Pixel $bmp ($cx - 4) ($oy + 2) $pal.shadow
  Set-Pixel $bmp ($cx - 4) ($oy + 3) $pal.shadow
  Set-Pixel $bmp ($cx - 4) ($oy + 4) $pal.shadow
  Set-Pixel $bmp ($cx + 4) ($oy + 2) $pal.shadow
  Set-Pixel $bmp ($cx + 4) ($oy + 3) $pal.shadow
  Set-Pixel $bmp ($cx + 4) ($oy + 4) $pal.shadow
  # Eyes
  Set-Pixel $bmp ($cx - 1) ($oy + 9) $pal.eye
  Set-Pixel $bmp ($cx + 1) ($oy + 9) $pal.eye
  # Nose + mouth
  Set-Pixel $bmp $cx ($oy + 10) (Color-FromHex '#e88ca8')
  Set-Pixel $bmp $cx ($oy + 11) $pal.shadow
  # Cotton tail
  Shade-Disc $bmp ($cx + 6) ($oy + 13) 1.8 (PetRamp @{deep='#a8a8b0'; shadow='#c8c8d0'; base='#ecedef'; high='#ffffff'; top='#ffffff'; eye='#0a0a12'})
  # Paws
  Set-Pixel $bmp ($cx - 3) ($oy + 19) $pal.deep
  Set-Pixel $bmp ($cx + 3) ($oy + 19) $pal.deep
}

function Draw-Pet {
  param($bmp, [string]$species, [string]$colour)
  $key = "$species-$colour"
  $pal = Pet-Ramp $key
  switch ($species) {
    'cat'        { Draw-Pet-Cat        $bmp $pal }
    'dog'        { Draw-Pet-Dog        $bmp $pal }
    'owl'        { Draw-Pet-Owl        $bmp $pal }
    'fox'        { Draw-Pet-Fox        $bmp $pal }
    'slime'      { Draw-Pet-Slime      $bmp $pal }
    'dragonling' { Draw-Pet-Dragonling $bmp $pal }
    'frog'       { Draw-Pet-Frog       $bmp $pal }
    'bunny'      { Draw-Pet-Bunny      $bmp $pal }
    default      { throw "Unknown pet species: $species" }
  }
}

function Build-Pets {
  Write-Host '── Pets ──' -ForegroundColor Cyan
  $count = 0
  foreach ($key in $PET_PALETTES.Keys) {
    $parts = $key -split '-', 2
    $species = $parts[0]
    $colour  = $parts[1]
    $bmp = New-CanvasFx $CanvasW $CanvasH
    Draw-Pet $bmp $species $colour
    Save-CanvasFx $bmp (Join-Path $petDir ("{0}-{1}.png" -f $species, $colour))
    $count++
  }
  Write-Host ("  variants: {0}" -f $count) -ForegroundColor Green
}

# ── Mood overlays ──────────────────────────────────────────────────
$MOOD_OX = 56
$MOOD_OY = 48

function Draw-Mood-Hungry { param($bmp)
  $bowl   = Color-FromHex '#a86028'
  $bowlHi = Color-FromHex '#d4843c'
  $crumb  = Color-FromHex '#f0b429'
  # Bowl rim
  Fill-Box $bmp $MOOD_OX ($MOOD_OY + 5) 7 1 $bowl
  Fill-Box $bmp ($MOOD_OX + 1) ($MOOD_OY + 6) 5 2 $bowl
  Set-Pixel $bmp ($MOOD_OX + 2) ($MOOD_OY + 6) $bowlHi
  # Question mark + crumbs above
  Set-Pixel $bmp ($MOOD_OX + 3) ($MOOD_OY + 1) $crumb
  Set-Pixel $bmp ($MOOD_OX + 4) ($MOOD_OY + 2) $crumb
  Set-Pixel $bmp ($MOOD_OX + 2) ($MOOD_OY + 3) $crumb
  Set-Pixel $bmp ($MOOD_OX + 5) ($MOOD_OY + 3) $crumb
}
function Draw-Mood-Sad { param($bmp)
  $drop   = Color-FromHex '#3a86ff'
  $dropHi = Color-FromHex '#a0c4ff'
  Set-Pixel $bmp ($MOOD_OX + 3) $MOOD_OY $drop
  Fill-Box $bmp ($MOOD_OX + 2) ($MOOD_OY + 1) 3 1 $drop
  Fill-Box $bmp ($MOOD_OX + 1) ($MOOD_OY + 2) 5 2 $drop
  Set-Pixel $bmp ($MOOD_OX + 2) ($MOOD_OY + 2) $dropHi
  Set-Pixel $bmp ($MOOD_OX + 3) ($MOOD_OY + 1) $dropHi
  Fill-Box $bmp ($MOOD_OX + 2) ($MOOD_OY + 4) 3 1 $drop
}
function Draw-Mood-Dirty { param($bmp)
  $fly  = Color-FromHex '#222228'
  $wing = Color-FromHex '#9aa1b4'
  # Fly body
  Fill-Box $bmp ($MOOD_OX + 3) ($MOOD_OY + 3) 2 1 $fly
  Set-Pixel $bmp ($MOOD_OX + 4) ($MOOD_OY + 3) $wing
  # Wings (translucent)
  Set-Pixel $bmp ($MOOD_OX + 2) ($MOOD_OY + 2) $wing
  Set-Pixel $bmp ($MOOD_OX + 5) ($MOOD_OY + 2) $wing
  # Motion trail squiggle
  Line-Pixel $bmp $MOOD_OX ($MOOD_OY + 5) ($MOOD_OX + 6) ($MOOD_OY + 5) $fly
  Set-Pixel $bmp ($MOOD_OX + 1) ($MOOD_OY + 6) $fly
  Set-Pixel $bmp ($MOOD_OX + 3) ($MOOD_OY + 6) $fly
  Set-Pixel $bmp ($MOOD_OX + 5) ($MOOD_OY + 6) $fly
  # Stink particles
  Set-Pixel $bmp ($MOOD_OX + 6) ($MOOD_OY) $fly
  Set-Pixel $bmp $MOOD_OX ($MOOD_OY + 1) $fly
}

function Build-Moods {
  Write-Host '── Mood overlays ──' -ForegroundColor Cyan
  $count = 0
  $moods = @(
    @{ name = 'hungry'; drawer = ${function:Draw-Mood-Hungry} }
    @{ name = 'sad';    drawer = ${function:Draw-Mood-Sad}    }
    @{ name = 'dirty';  drawer = ${function:Draw-Mood-Dirty}  }
  )
  foreach ($m in $moods) {
    $bmp = New-CanvasFx $CanvasW $CanvasH
    & $m.drawer $bmp
    Save-CanvasFx $bmp (Join-Path $petDir ("mood-{0}.png" -f $m.name))
    $count++
  }
  Write-Host ("  moods: {0}" -f $count) -ForegroundColor Green
}

# ── Legendaries ────────────────────────────────────────────────────
$LEGENDARIES = @(
  @{ slot = 'weapon'; name = 'Excalibur'; weaponType = 'sword' }
)

# Per-frame halo for legendary gear — 4 frames stitched into APNG.
function Draw-Legendary-FxHalo {
  param($bmp, [string]$name, [int]$frameIndex)
  $phase = $frameIndex
  $gold = $BRAND.Gold
  $hi   = $BRAND.GoldHi
  # Place halo over the weapon grip area (around GRIP_X, ARM_Y)
  $rx = $GRIP_X + 1; $ry = $GRIP_TOPY - 8
  # Outer ring — 12 radial spokes
  $radius = 6 + ($phase % 2)
  for ($a = 0; $a -lt 12; $a++) {
    $ang = ($a * 30 + $phase * 15) * [Math]::PI / 180
    $sx = $rx + [int]([Math]::Cos($ang) * $radius)
    $sy = $ry + [int]([Math]::Sin($ang) * $radius)
    Blend-Pixel $bmp $sx $sy (With-Alpha $gold 200)
  }
  # Inner sparkle
  $innerAng = ($phase * 90) * [Math]::PI / 180
  $ix = $rx + [int]([Math]::Cos($innerAng) * 3)
  $iy = $ry + [int]([Math]::Sin($innerAng) * 3)
  Set-Pixel $bmp $ix $iy $hi
  # Drifting motes
  $motes = @(
    @{ x = $rx + 7; y = $ry - 4 - $phase },
    @{ x = $rx - 8; y = $ry - 2 - $phase },
    @{ x = $rx + 4; y = $ry - 9 - (($phase + 2) % 4) }
  )
  foreach ($m in $motes) {
    Blend-Pixel $bmp $m.x $m.y (With-Alpha $gold 180)
  }
}

function Build-Legendary {
  param([string]$repoRoot)
  Write-Host '── Legendary gear ──' -ForegroundColor Cyan
  $framesDir = Join-Path $OutRoot '_legendary-frames'
  New-Item -ItemType Directory -Force -Path $framesDir | Out-Null
  $count = 0
  $frameCount = 0
  foreach ($leg in $LEGENDARIES) {
    $slug = Slugify $leg.name
    $bmp = New-CanvasFx $CanvasW $CanvasH
    if ($leg.slot -eq 'weapon') {
      Draw-Weapon $bmp $leg.weaponType $leg.name 'legendary'
    } else {
      throw "TODO: legendary draw for slot $($leg.slot)"
    }
    Save-CanvasFx $bmp (Join-Path $gearDir ("{0}/{1}.png" -f $leg.slot, $slug))
    $count++
    for ($f = 0; $f -lt 4; $f++) {
      $fxBmp = New-CanvasFx $CanvasW $CanvasH
      Draw-Legendary-FxHalo $fxBmp $leg.name $f
      Save-CanvasFx $fxBmp (Join-Path $framesDir ("{0}-fx-{1}.png" -f $slug, $f))
      $frameCount++
    }
  }
  Write-Host ("  legendaries: {0}  ({1} fx frames)" -f $count, $frameCount) -ForegroundColor Green
}

# ── Top-level driver (incremental — full pipeline added later) ─────
$repoRoot = Split-Path -Parent $PSScriptRoot

if (Want 'figure')   { Build-Figure }
if (Want 'defaultclothing' -or (Want 'figure')) { Build-DefaultClothing }
if (Want 'hair')     { Build-Hair }
if (Want 'eyes')     { Build-Eyes }
if (Want 'accent')   { Build-Accents }
if (Want 'weapons')  { Build-Weapons -repoRoot $repoRoot }
if (Want 'head')     { Build-Head   -repoRoot $repoRoot }
if (Want 'chest')    { Build-Chest  -repoRoot $repoRoot }
if (Want 'legs')     { Build-Legs   -repoRoot $repoRoot }
if (Want 'boots')    { Build-Boots  -repoRoot $repoRoot }
if (Want 'trinket')  { Build-Trinket -repoRoot $repoRoot }
if (Want 'pets')     { Build-Pets }
if (Want 'moods')    { Build-Moods }
if (Want 'legendary') { Build-Legendary -repoRoot $repoRoot }

Write-Host ''
Write-Host 'Pass complete.' -ForegroundColor Green
Write-Host "Output: $OutRoot"
