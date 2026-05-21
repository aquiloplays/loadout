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

# ── Top-level driver (incremental — full pipeline added later) ─────
$repoRoot = Split-Path -Parent $PSScriptRoot

if (Want 'figure')  { Build-Figure }
if (Want 'hair')    { Build-Hair }
if (Want 'eyes')    { Build-Eyes }
if (Want 'accent')  { Build-Accents }

Write-Host ''
Write-Host 'Figure pass complete.' -ForegroundColor Green
Write-Host "Output: $OutRoot"
