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
  [string]$Only   = ''     # comma list: figure,hair,eyes,accent,weapons,head,chest,legs,boots,trinket,pets,legendary,moods
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

# ── Top-level driver (incremental — full pipeline added later) ─────
$repoRoot = Split-Path -Parent $PSScriptRoot

if (Want 'figure')   { Build-Figure }
if (Want 'hair')     { Build-Hair }
if (Want 'eyes')     { Build-Eyes }
if (Want 'accent')   { Build-Accents }
if (Want 'weapons')  { Build-Weapons -repoRoot $repoRoot }

Write-Host ''
Write-Host 'Pass complete.' -ForegroundColor Green
Write-Host "Output: $OutRoot"
