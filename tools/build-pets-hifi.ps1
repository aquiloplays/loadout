# Hi-fi pet sprite generator.
#
# Companion to build-sprites.ps1's small in-corner pet pass — that one
# bakes 18×23 pets into the bottom-right of the 64×80 character canvas
# so character.js can composite a pet next to the hero. This script
# renders the SAME 8 species × 4 colours at proper portrait scale —
# 128×128 canvas, pet content occupying ~96×96 — for the standalone
# tamagotchi UI on aquilo.gg/play/pet.
#
# Why two sprite tracks: the in-frame paper-doll pet has to fit a tiny
# corner gutter without colliding with the hero figure; the /play UI
# renders at 192px and the corner-sized art looks postage-stamp at
# that scale. Same palettes, same species, much more pixel real estate.
#
# Output paths (committed to git):
#   aquilo-gg/sprites/pet/hifi/<species>-<colour>.png   (128×128, 32 files)
#   aquilo-gg/sprites/pet/hifi/mood-<kind>.png          (128×128, 3 files)
#
# To regenerate from scratch:
#   pwsh -ExecutionPolicy Bypass -File tools/build-pets-hifi.ps1

[CmdletBinding()]
param(
  [string]$OutRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'aquilo-gg/sprites')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib-pixel.ps1')

# ── Canvas geometry ────────────────────────────────────────────────
$HF_W   = 128
$HF_H   = 128
$HF_CX  = 64                  # vertical centreline (figure midline)
$HF_GND = 116                 # ground row (where shadow sits)

# Per-species anchors. Body centre + head centre are tuned so the
# two silhouettes overlap at the neck (no visible gap) and the body
# bottom + paws clear the ground line at y=116 without poking out
# the bottom of the canvas.
#
# Default sitting quadruped silhouette (cat/dog/fox/bunny):
#   head:  cy=44, ry≈22  → head spans y 22..66
#   body:  cy=90, ry≈22  → body spans y 68..112
# Species with merged head+body (owl/slime/frog) override individually.
$HF_BODY_CY = 90
$HF_HEAD_CY = 44

# ── Palettes — mirrored from build-sprites.ps1 ─────────────────────
# Kept in sync by hand. If you add a new species/colour there, mirror
# it here. Duplicating to avoid touching build-sprites.ps1 (concurrent
# sessions may be editing that file).
$PET_PALETTES_HIFI = @{
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

function HiFi-Ramp { param([string]$key)
  $pal = $PET_PALETTES_HIFI[$key]
  if (-not $pal) { throw "Unknown pet palette: $key" }
  return @{
    deep   = Color-FromHex $pal.deep;
    shadow = Color-FromHex $pal.shadow;
    base   = Color-FromHex $pal.base;
    high   = Color-FromHex $pal.high;
    top    = Color-FromHex $pal.top;
    eye    = Color-FromHex $pal.eye;
  }
}

# ── Shared helpers ────────────────────────────────────────────────

function Draw-HiFiGround { param($bmp, [int]$cx)
  # Soft elliptical shadow under the pet — alpha-blended so it darkens
  # whatever's underneath without solid-coloring the ground line.
  $shadow = (Color-FromHex '#080810')
  for ($dx = -28; $dx -le 28; $dx++) {
    $a = 130 - [int]([Math]::Abs($dx) * 4.0)
    if ($a -lt 24) { continue }
    Blend-Pixel $bmp ($cx + $dx) $HF_GND (With-Alpha $shadow $a)
  }
  for ($dx = -22; $dx -le 22; $dx++) {
    $a = 90 - [int]([Math]::Abs($dx) * 3.0)
    if ($a -lt 20) { continue }
    Blend-Pixel $bmp ($cx + $dx) ($HF_GND - 1) (With-Alpha $shadow $a)
  }
  for ($dx = -16; $dx -le 16; $dx++) {
    $a = 60 - [int]([Math]::Abs($dx) * 3.0)
    if ($a -lt 16) { continue }
    Blend-Pixel $bmp ($cx + $dx) ($HF_GND + 1) (With-Alpha $shadow $a)
  }
}

function Draw-HiFiEye {
  param($bmp, [int]$cx, [int]$cy, $pal, [int]$pupilSize = 2)
  # Sclera (white) — 3-wide rounded eye base
  $white = Color-FromHex '#ffffff'
  $offWhite = Color-FromHex '#e6e6f0'
  Fill-Box $bmp ($cx - 2) ($cy - 1) 5 3 $white
  Set-Pixel $bmp ($cx - 2) ($cy - 1) $offWhite
  Set-Pixel $bmp ($cx + 2) ($cy - 1) $offWhite
  Set-Pixel $bmp ($cx - 2) ($cy + 1) $offWhite
  Set-Pixel $bmp ($cx + 2) ($cy + 1) $offWhite
  # Outline
  Set-Pixel $bmp ($cx - 3) $cy $pal.deep
  Set-Pixel $bmp ($cx + 3) $cy $pal.deep
  Set-Pixel $bmp ($cx - 2) ($cy - 2) $pal.shadow
  Set-Pixel $bmp ($cx + 2) ($cy - 2) $pal.shadow
  Set-Pixel $bmp ($cx - 2) ($cy + 2) $pal.shadow
  Set-Pixel $bmp ($cx + 2) ($cy + 2) $pal.shadow
  # Pupil (iris colour)
  if ($pupilSize -ge 2) {
    Fill-Box $bmp ($cx - 1) $cy 3 1 $pal.eye
    Set-Pixel $bmp $cx ($cy + 1) $pal.eye
    Set-Pixel $bmp $cx ($cy - 1) $pal.eye
  } else {
    Set-Pixel $bmp $cx $cy $pal.eye
  }
  # Glint
  Set-Pixel $bmp ($cx - 1) ($cy - 1) $white
}

function Draw-HiFiCheek {
  param($bmp, [int]$cx, [int]$cy)
  # Soft cheek blush — alpha pinks across 3px
  $blush = Color-FromHex '#ff8aa0'
  Blend-Pixel $bmp $cx $cy (With-Alpha $blush 120)
  Blend-Pixel $bmp ($cx - 1) $cy (With-Alpha $blush 80)
  Blend-Pixel $bmp ($cx + 1) $cy (With-Alpha $blush 80)
  Blend-Pixel $bmp $cx ($cy + 1) (With-Alpha $blush 50)
}

function Draw-HiFiSparkle {
  param($bmp, [int]$cx, [int]$cy, $color)
  Set-Pixel $bmp $cx $cy $color
  Set-Pixel $bmp ($cx + 1) $cy $color
  Set-Pixel $bmp ($cx - 1) $cy $color
  Set-Pixel $bmp $cx ($cy + 1) $color
  Set-Pixel $bmp $cx ($cy - 1) $color
}

# ── Cat ────────────────────────────────────────────────────────────
function Draw-HiFi-Cat {
  param($bmp, $pal)
  $cx = $HF_CX
  Draw-HiFiGround $bmp $cx
  # Body — sitting cat oval
  Shade-Oval $bmp $cx $HF_BODY_CY 28 22 $pal
  # Belly highlight band
  for ($dy = 0; $dy -lt 14; $dy++) {
    for ($dx = -8; $dx -le 8; $dx++) {
      $y = $HF_BODY_CY + 6 + $dy
      $x = $cx + $dx
      $nx = $dx / 9.0; $ny = ($dy - 7) / 9.0
      if ($nx * $nx + $ny * $ny -lt 0.85) {
        Set-Pixel $bmp $x $y $pal.high
      }
    }
  }
  # Front paws (sitting)
  Fill-Box $bmp ($cx - 14) ($HF_BODY_CY + 20) 7 4 $pal.shadow
  Fill-Box $bmp ($cx + 8) ($HF_BODY_CY + 20) 7 4 $pal.shadow
  Fill-Box $bmp ($cx - 14) ($HF_BODY_CY + 21) 6 2 $pal.base
  Fill-Box $bmp ($cx + 8) ($HF_BODY_CY + 21) 6 2 $pal.base
  # Toe beans
  Set-Pixel $bmp ($cx - 11) ($HF_BODY_CY + 22) (Color-FromHex '#ffb0b8')
  Set-Pixel $bmp ($cx - 8) ($HF_BODY_CY + 22) (Color-FromHex '#ffb0b8')
  Set-Pixel $bmp ($cx + 11) ($HF_BODY_CY + 22) (Color-FromHex '#ffb0b8')
  Set-Pixel $bmp ($cx + 8) ($HF_BODY_CY + 22) (Color-FromHex '#ffb0b8')
  # Head — round
  Shade-Oval $bmp $cx $HF_HEAD_CY 22 20 $pal
  # Ears — triangular tufts pointing UP. i=0 is the tip (narrow),
  # i=10 is the base (wide) sitting on top of head.
  for ($i = 0; $i -lt 11; $i++) {
    $w = [int]([Math]::Round($i * 0.9)) + 1
    $col = if ($i -lt 2) { $pal.shadow } elseif ($i -lt 6) { $pal.base } else { $pal.high }
    $y = $HF_HEAD_CY - 22 + $i
    # Left ear (centre column cx-15)
    $lx = $cx - 15 - [int]([Math]::Floor(($w - 1) / 2))
    Fill-Box $bmp $lx $y $w 1 $col
    # Right ear (centre column cx+15)
    $rx = $cx + 15 - [int]([Math]::Floor(($w - 1) / 2))
    Fill-Box $bmp $rx $y $w 1 $col
    # Outer edge shadow
    if ($w -gt 2) {
      Set-Pixel $bmp $lx $y $pal.deep
      Set-Pixel $bmp ($lx + $w - 1) $y $pal.deep
      Set-Pixel $bmp $rx $y $pal.deep
      Set-Pixel $bmp ($rx + $w - 1) $y $pal.deep
    }
  }
  # Inner ear pink — small triangle inside each ear
  $pink = Color-FromHex '#ffb8c0'
  $pinkDk = Color-FromHex '#ff8090'
  Fill-Box $bmp ($cx - 16) ($HF_HEAD_CY - 17) 3 4 $pink
  Set-Pixel $bmp ($cx - 16) ($HF_HEAD_CY - 14) $pinkDk
  Fill-Box $bmp ($cx + 14) ($HF_HEAD_CY - 17) 3 4 $pink
  Set-Pixel $bmp ($cx + 16) ($HF_HEAD_CY - 14) $pinkDk
  # Eyes
  Draw-HiFiEye $bmp ($cx - 7) ($HF_HEAD_CY - 2) $pal 3
  Draw-HiFiEye $bmp ($cx + 7) ($HF_HEAD_CY - 2) $pal 3
  # Nose
  Fill-Box $bmp ($cx - 1) ($HF_HEAD_CY + 5) 3 2 (Color-FromHex '#e88ca8')
  Set-Pixel $bmp $cx ($HF_HEAD_CY + 5) (Color-FromHex '#ffa8c0')
  # Mouth
  Set-Pixel $bmp ($cx - 2) ($HF_HEAD_CY + 8) $pal.deep
  Set-Pixel $bmp ($cx - 1) ($HF_HEAD_CY + 9) $pal.deep
  Set-Pixel $bmp $cx ($HF_HEAD_CY + 9) $pal.deep
  Set-Pixel $bmp ($cx + 1) ($HF_HEAD_CY + 9) $pal.deep
  Set-Pixel $bmp ($cx + 2) ($HF_HEAD_CY + 8) $pal.deep
  # Whiskers (short brush strokes)
  for ($i = 0; $i -lt 6; $i++) {
    Set-Pixel $bmp ($cx - 14 - $i) ($HF_HEAD_CY + 6 + ($i % 3) - 1) $pal.high
    Set-Pixel $bmp ($cx + 13 + $i) ($HF_HEAD_CY + 6 + ($i % 3) - 1) $pal.high
  }
  # Cheek blush
  Draw-HiFiCheek $bmp ($cx - 12) ($HF_HEAD_CY + 6)
  Draw-HiFiCheek $bmp ($cx + 12) ($HF_HEAD_CY + 6)
  # Curling tail — wraps right side
  $tailPts = @(
    @{x=$cx+22; y=$HF_BODY_CY+18},
    @{x=$cx+26; y=$HF_BODY_CY+12},
    @{x=$cx+30; y=$HF_BODY_CY+4},
    @{x=$cx+32; y=$HF_BODY_CY-4},
    @{x=$cx+30; y=$HF_BODY_CY-12},
    @{x=$cx+24; y=$HF_BODY_CY-16}
  )
  foreach ($p in $tailPts) {
    Fill-Box $bmp ($p.x - 1) ($p.y - 1) 3 3 $pal.base
  }
  # Highlight on tail
  Set-Pixel $bmp ($cx + 27) $HF_BODY_CY $pal.high
  Set-Pixel $bmp ($cx + 31) ($HF_BODY_CY) $pal.high
  Set-Pixel $bmp ($cx + 31) ($HF_BODY_CY - 5) $pal.top
  # Tail tip
  Set-Pixel $bmp ($cx + 23) ($HF_BODY_CY - 17) $pal.top
}

# ── Dog ────────────────────────────────────────────────────────────
function Draw-HiFi-Dog {
  param($bmp, $pal)
  $cx = $HF_CX
  Draw-HiFiGround $bmp $cx
  # Body — chunkier, sitting
  Shade-Oval $bmp $cx ($HF_BODY_CY - 2) 30 22 $pal
  # Belly + chest highlight
  Fill-Box $bmp ($cx - 7) ($HF_BODY_CY - 4) 14 14 $pal.high
  Set-Pixel $bmp ($cx - 3) $HF_BODY_CY $pal.top
  Set-Pixel $bmp ($cx + 2) $HF_BODY_CY $pal.top
  # Front paws
  Fill-Box $bmp ($cx - 16) ($HF_BODY_CY + 18) 8 6 $pal.shadow
  Fill-Box $bmp ($cx + 8) ($HF_BODY_CY + 18) 8 6 $pal.shadow
  Fill-Box $bmp ($cx - 16) ($HF_BODY_CY + 20) 7 3 $pal.base
  Fill-Box $bmp ($cx + 9) ($HF_BODY_CY + 20) 7 3 $pal.base
  # Toe lines
  Set-Pixel $bmp ($cx - 12) ($HF_BODY_CY + 23) $pal.deep
  Set-Pixel $bmp ($cx - 9) ($HF_BODY_CY + 23) $pal.deep
  Set-Pixel $bmp ($cx + 12) ($HF_BODY_CY + 23) $pal.deep
  Set-Pixel $bmp ($cx + 15) ($HF_BODY_CY + 23) $pal.deep
  # Head — round
  Shade-Oval $bmp $cx $HF_HEAD_CY 22 20 $pal
  # Snout — protruding muzzle
  Fill-Box $bmp ($cx - 6) ($HF_HEAD_CY + 4) 13 12 $pal.base
  Fill-Box $bmp ($cx - 5) ($HF_HEAD_CY + 5) 11 10 $pal.high
  Set-Pixel $bmp ($cx - 6) ($HF_HEAD_CY + 4) $pal.shadow
  Set-Pixel $bmp ($cx + 6) ($HF_HEAD_CY + 4) $pal.shadow
  Set-Pixel $bmp ($cx - 6) ($HF_HEAD_CY + 15) $pal.deep
  Set-Pixel $bmp ($cx + 6) ($HF_HEAD_CY + 15) $pal.deep
  # Nose
  Fill-Box $bmp ($cx - 2) ($HF_HEAD_CY + 6) 5 3 (Color-FromHex '#1a1018')
  Set-Pixel $bmp ($cx - 1) ($HF_HEAD_CY + 6) (Color-FromHex '#5a4040')
  # Mouth
  Set-Pixel $bmp $cx ($HF_HEAD_CY + 11) $pal.deep
  Set-Pixel $bmp ($cx - 2) ($HF_HEAD_CY + 12) $pal.deep
  Set-Pixel $bmp ($cx + 2) ($HF_HEAD_CY + 12) $pal.deep
  Set-Pixel $bmp ($cx - 4) ($HF_HEAD_CY + 13) $pal.deep
  Set-Pixel $bmp ($cx + 4) ($HF_HEAD_CY + 13) $pal.deep
  # Tongue
  Fill-Box $bmp ($cx - 1) ($HF_HEAD_CY + 13) 3 2 (Color-FromHex '#ff7a98')
  Set-Pixel $bmp $cx ($HF_HEAD_CY + 14) (Color-FromHex '#c84a68')
  # Floppy ears (down)
  Fill-Box $bmp ($cx - 24) ($HF_HEAD_CY - 8) 7 22 $pal.shadow
  Fill-Box $bmp ($cx - 23) ($HF_HEAD_CY - 6) 5 19 $pal.base
  Fill-Box $bmp ($cx - 23) ($HF_HEAD_CY - 4) 1 16 $pal.deep
  Fill-Box $bmp ($cx + 17) ($HF_HEAD_CY - 8) 7 22 $pal.shadow
  Fill-Box $bmp ($cx + 18) ($HF_HEAD_CY - 6) 5 19 $pal.base
  Fill-Box $bmp ($cx + 22) ($HF_HEAD_CY - 4) 1 16 $pal.deep
  # Eyes
  Draw-HiFiEye $bmp ($cx - 8) ($HF_HEAD_CY - 1) $pal 3
  Draw-HiFiEye $bmp ($cx + 8) ($HF_HEAD_CY - 1) $pal 3
  # Eyebrow tufts (sweet face)
  Set-Pixel $bmp ($cx - 10) ($HF_HEAD_CY - 6) $pal.deep
  Set-Pixel $bmp ($cx - 8) ($HF_HEAD_CY - 6) $pal.deep
  Set-Pixel $bmp ($cx + 8) ($HF_HEAD_CY - 6) $pal.deep
  Set-Pixel $bmp ($cx + 10) ($HF_HEAD_CY - 6) $pal.deep
  # Wagging tail (curl up right side)
  Fill-Box $bmp ($cx + 24) ($HF_BODY_CY - 4) 4 12 $pal.base
  Set-Pixel $bmp ($cx + 24) ($HF_BODY_CY - 4) $pal.shadow
  Fill-Box $bmp ($cx + 26) ($HF_BODY_CY - 4) 4 8 $pal.base
  Set-Pixel $bmp ($cx + 26) ($HF_BODY_CY - 4) $pal.shadow
  Set-Pixel $bmp ($cx + 28) ($HF_BODY_CY - 4) $pal.top
}

# ── Owl ────────────────────────────────────────────────────────────
function Draw-HiFi-Owl {
  param($bmp, $pal)
  $cx = $HF_CX
  Draw-HiFiGround $bmp $cx
  # Body — tall oval, head + body merged (like a stout owl)
  Shade-Oval $bmp $cx ($HF_HEAD_CY + 30) 28 38 $pal
  # Chest stripe — lighter feathers
  Fill-Box $bmp ($cx - 10) ($HF_HEAD_CY + 10) 21 38 $pal.high
  # V-shaped chest feather pattern
  for ($i = 0; $i -lt 10; $i++) {
    $y = $HF_HEAD_CY + 14 + $i * 3
    if ($i % 2 -eq 0) {
      Set-Pixel $bmp ($cx - 6) $y $pal.base
      Set-Pixel $bmp ($cx + 6) $y $pal.base
      Set-Pixel $bmp ($cx - 4) ($y + 1) $pal.base
      Set-Pixel $bmp ($cx + 4) ($y + 1) $pal.base
    } else {
      Set-Pixel $bmp ($cx - 2) $y $pal.shadow
      Set-Pixel $bmp ($cx + 2) $y $pal.shadow
    }
  }
  # Ear tufts (pointed)
  for ($i = 0; $i -lt 8; $i++) {
    $w = 8 - $i
    if ($w -le 0) { continue }
    $col = if ($i -lt 2) { $pal.top } elseif ($i -lt 4) { $pal.base } else { $pal.shadow }
    Fill-Box $bmp ($cx - 18 + $i) ($HF_HEAD_CY - 18 + $i) $w 1 $col
    Fill-Box $bmp ($cx + 10) ($HF_HEAD_CY - 18 + $i) $w 1 $col
  }
  # Big eyes — disc with sclera + iris
  $disc = @{
    deep = Color-FromHex '#aaa890';
    shadow = Color-FromHex '#d4d2b8';
    base = Color-FromHex '#fff8e0';
    high = Color-FromHex '#ffffff';
    top = Color-FromHex '#ffffff';
  }
  Shade-Disc $bmp ($cx - 8) ($HF_HEAD_CY) 7 $disc
  Shade-Disc $bmp ($cx + 8) ($HF_HEAD_CY) 7 $disc
  # Iris
  Fill-Box $bmp ($cx - 10) ($HF_HEAD_CY - 2) 5 5 $pal.eye
  Fill-Box $bmp ($cx + 6) ($HF_HEAD_CY - 2) 5 5 $pal.eye
  Set-Pixel $bmp ($cx - 8) ($HF_HEAD_CY) (Color-FromHex '#000000')
  Set-Pixel $bmp ($cx + 8) ($HF_HEAD_CY) (Color-FromHex '#000000')
  # Eye glints
  Set-Pixel $bmp ($cx - 9) ($HF_HEAD_CY - 2) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($cx + 7) ($HF_HEAD_CY - 2) (Color-FromHex '#ffffff')
  # Beak — yellow triangle below eyes
  $beak = Color-FromHex '#f0b429'
  $beakDk = Color-FromHex '#a07020'
  Fill-Box $bmp ($cx - 1) ($HF_HEAD_CY + 6) 3 2 $beak
  Set-Pixel $bmp $cx ($HF_HEAD_CY + 8) $beak
  Set-Pixel $bmp $cx ($HF_HEAD_CY + 9) $beakDk
  Set-Pixel $bmp ($cx - 1) ($HF_HEAD_CY + 8) $beakDk
  Set-Pixel $bmp ($cx + 1) ($HF_HEAD_CY + 8) $beakDk
  # Wings folded against body
  for ($y = 0; $y -lt 16; $y++) {
    Set-Pixel $bmp ($cx - 24 + [int]([Math]::Sin($y * 0.3) * 2)) ($HF_HEAD_CY + 16 + $y) $pal.deep
    Set-Pixel $bmp ($cx + 24 - [int]([Math]::Sin($y * 0.3) * 2)) ($HF_HEAD_CY + 16 + $y) $pal.deep
    if ($y % 3 -eq 0) {
      Set-Pixel $bmp ($cx - 22) ($HF_HEAD_CY + 16 + $y) $pal.shadow
      Set-Pixel $bmp ($cx + 22) ($HF_HEAD_CY + 16 + $y) $pal.shadow
    }
  }
  # Feet — yellow talons
  Fill-Box $bmp ($cx - 8) ($HF_GND - 4) 6 4 $beak
  Fill-Box $bmp ($cx + 2) ($HF_GND - 4) 6 4 $beak
  Set-Pixel $bmp ($cx - 8) ($HF_GND - 4) $beakDk
  Set-Pixel $bmp ($cx - 3) ($HF_GND - 4) $beakDk
  Set-Pixel $bmp ($cx + 2) ($HF_GND - 4) $beakDk
  Set-Pixel $bmp ($cx + 7) ($HF_GND - 4) $beakDk
  # Talon claws
  Set-Pixel $bmp ($cx - 7) ($HF_GND) $beakDk
  Set-Pixel $bmp ($cx - 5) ($HF_GND) $beakDk
  Set-Pixel $bmp ($cx - 3) ($HF_GND) $beakDk
  Set-Pixel $bmp ($cx + 3) ($HF_GND) $beakDk
  Set-Pixel $bmp ($cx + 5) ($HF_GND) $beakDk
  Set-Pixel $bmp ($cx + 7) ($HF_GND) $beakDk
}

# ── Fox ────────────────────────────────────────────────────────────
function Draw-HiFi-Fox {
  param($bmp, $pal)
  $cx = $HF_CX
  Draw-HiFiGround $bmp $cx
  # Body — sleek, slightly forward-leaning
  Shade-Oval $bmp $cx $HF_BODY_CY 26 18 $pal
  # White belly + chest
  $whiteBelly = Color-FromHex '#fff5e8'
  $whiteShade = Color-FromHex '#e0d4c0'
  Fill-Box $bmp ($cx - 8) $HF_BODY_CY 17 18 $whiteBelly
  Set-Pixel $bmp ($cx - 8) $HF_BODY_CY $whiteShade
  Set-Pixel $bmp ($cx + 8) $HF_BODY_CY $whiteShade
  # Front paws (dark socks)
  Fill-Box $bmp ($cx - 14) ($HF_BODY_CY + 16) 6 8 $pal.deep
  Fill-Box $bmp ($cx + 8) ($HF_BODY_CY + 16) 6 8 $pal.deep
  Set-Pixel $bmp ($cx - 14) ($HF_BODY_CY + 16) $pal.shadow
  Set-Pixel $bmp ($cx + 13) ($HF_BODY_CY + 16) $pal.shadow
  # Head — triangular silhouette
  Shade-Oval $bmp $cx ($HF_HEAD_CY + 2) 18 18 $pal
  # White muzzle/chin
  Fill-Box $bmp ($cx - 5) ($HF_HEAD_CY + 8) 11 10 $whiteBelly
  Set-Pixel $bmp ($cx - 5) ($HF_HEAD_CY + 8) $whiteShade
  Set-Pixel $bmp ($cx + 5) ($HF_HEAD_CY + 8) $whiteShade
  # Pointed snout
  Fill-Box $bmp ($cx - 2) ($HF_HEAD_CY + 12) 5 6 $whiteBelly
  Fill-Box $bmp ($cx - 1) ($HF_HEAD_CY + 14) 3 4 $pal.base
  # Nose
  Fill-Box $bmp $cx ($HF_HEAD_CY + 14) 1 2 (Color-FromHex '#1a1018')
  Set-Pixel $bmp ($cx + 1) ($HF_HEAD_CY + 13) (Color-FromHex '#1a1018')
  # Pointed ears — triangular
  for ($i = 0; $i -lt 11; $i++) {
    $w = 9 - $i
    if ($w -le 0) { continue }
    $col = if ($i -lt 2) { $pal.top } elseif ($i -lt 5) { $pal.base } elseif ($i -lt 8) { $pal.shadow } else { $pal.deep }
    Fill-Box $bmp ($cx - 17 + $i) ($HF_HEAD_CY - 17 + $i) $w 1 $col
    Fill-Box $bmp ($cx + 8) ($HF_HEAD_CY - 17 + $i) $w 1 $col
  }
  # Inner ear (dark for fox)
  Fill-Box $bmp ($cx - 14) ($HF_HEAD_CY - 12) 3 4 $pal.deep
  Fill-Box $bmp ($cx + 11) ($HF_HEAD_CY - 12) 3 4 $pal.deep
  # Eyes (slightly almond)
  Draw-HiFiEye $bmp ($cx - 6) ($HF_HEAD_CY) $pal 3
  Draw-HiFiEye $bmp ($cx + 6) ($HF_HEAD_CY) $pal 3
  # Mouth
  Set-Pixel $bmp ($cx - 1) ($HF_HEAD_CY + 16) $pal.deep
  Set-Pixel $bmp ($cx + 1) ($HF_HEAD_CY + 16) $pal.deep
  # Big bushy tail — curves up to right (the iconic fox tail)
  $tailPts = @(
    @{x=$cx+18; y=$HF_BODY_CY+8; r=4},
    @{x=$cx+24; y=$HF_BODY_CY+2; r=5},
    @{x=$cx+28; y=$HF_BODY_CY-6; r=5},
    @{x=$cx+28; y=$HF_BODY_CY-14; r=4},
    @{x=$cx+24; y=$HF_BODY_CY-20; r=3}
  )
  foreach ($p in $tailPts) {
    Shade-Oval $bmp $p.x $p.y $p.r $p.r $pal
  }
  # White tail tip
  Fill-Box $bmp ($cx + 22) ($HF_BODY_CY - 22) 5 4 $whiteBelly
  Set-Pixel $bmp ($cx + 22) ($HF_BODY_CY - 22) $whiteShade
  Set-Pixel $bmp ($cx + 26) ($HF_BODY_CY - 22) $whiteShade
}

# ── Slime ──────────────────────────────────────────────────────────
function Draw-HiFi-Slime {
  param($bmp, $pal)
  $cx = $HF_CX
  Draw-HiFiGround $bmp $cx
  # Slime body — wide dome with a flat base
  for ($dy = 0; $dy -lt 44; $dy++) {
    $y = $HF_GND - 4 - $dy
    $radius = if ($dy -lt 30) {
      [int]([Math]::Sqrt(900 - ($dy - 30) * ($dy - 30) * 0.6))
    } else { 36 - $dy }
    if ($radius -le 0) { continue }
    if ($radius -gt 32) { $radius = 32 }
    for ($dx = -$radius; $dx -le $radius; $dx++) {
      $x = $cx + $dx
      $t = ($dx * 1.0 / $radius) + ($dy * 0.5 / 44) - 0.6
      $col = if ($t -lt -0.55) { $pal.top }
             elseif ($t -lt -0.30) { $pal.high }
             elseif ($t -lt 0.20) { $pal.base }
             elseif ($t -lt 0.50) { $pal.shadow }
             else { $pal.deep }
      Set-Pixel $bmp $x $y $col
    }
  }
  # Highlight blob (specular)
  Fill-Box $bmp ($cx - 18) ($HF_GND - 38) 8 4 $pal.top
  Fill-Box $bmp ($cx - 16) ($HF_GND - 42) 6 4 $pal.top
  Fill-Box $bmp ($cx - 14) ($HF_GND - 35) 4 2 (Color-FromHex '#ffffff')
  # Secondary highlight
  Set-Pixel $bmp ($cx + 14) ($HF_GND - 20) $pal.high
  Set-Pixel $bmp ($cx + 16) ($HF_GND - 18) $pal.high
  # Bubbles inside (translucent inner highlights)
  Set-Pixel $bmp ($cx + 8) ($HF_GND - 32) $pal.top
  Set-Pixel $bmp ($cx + 10) ($HF_GND - 30) $pal.high
  Set-Pixel $bmp ($cx - 4) ($HF_GND - 14) $pal.top
  Set-Pixel $bmp ($cx + 2) ($HF_GND - 8) $pal.high
  # Cute face
  Draw-HiFiEye $bmp ($cx - 8) ($HF_GND - 22) $pal 3
  Draw-HiFiEye $bmp ($cx + 8) ($HF_GND - 22) $pal 3
  # Smile
  Set-Pixel $bmp ($cx - 3) ($HF_GND - 15) $pal.deep
  Set-Pixel $bmp ($cx - 2) ($HF_GND - 14) $pal.deep
  Set-Pixel $bmp ($cx - 1) ($HF_GND - 13) $pal.deep
  Set-Pixel $bmp $cx ($HF_GND - 13) $pal.deep
  Set-Pixel $bmp ($cx + 1) ($HF_GND - 13) $pal.deep
  Set-Pixel $bmp ($cx + 2) ($HF_GND - 14) $pal.deep
  Set-Pixel $bmp ($cx + 3) ($HF_GND - 15) $pal.deep
  # Cheek
  Draw-HiFiCheek $bmp ($cx - 13) ($HF_GND - 17)
  Draw-HiFiCheek $bmp ($cx + 13) ($HF_GND - 17)
  # Antenna droplet (cute)
  Set-Pixel $bmp $cx ($HF_GND - 50) $pal.top
  Fill-Box $bmp ($cx - 1) ($HF_GND - 49) 3 2 $pal.high
  Set-Pixel $bmp $cx ($HF_GND - 47) $pal.base
  Set-Pixel $bmp $cx ($HF_GND - 46) $pal.base
  Set-Pixel $bmp $cx ($HF_GND - 45) $pal.shadow
  # Floor puddle drips
  Set-Pixel $bmp ($cx - 28) ($HF_GND - 6) $pal.shadow
  Set-Pixel $bmp ($cx - 27) ($HF_GND - 5) $pal.base
  Set-Pixel $bmp ($cx + 28) ($HF_GND - 6) $pal.shadow
  Set-Pixel $bmp ($cx + 27) ($HF_GND - 5) $pal.base
}

# ── Dragonling ─────────────────────────────────────────────────────
function Draw-HiFi-Dragonling {
  param($bmp, $pal)
  $cx = $HF_CX
  Draw-HiFiGround $bmp $cx
  # Body — dragon-sized round belly
  Shade-Oval $bmp $cx $HF_BODY_CY 28 22 $pal
  # Belly scales (lighter)
  Fill-Box $bmp ($cx - 10) $HF_BODY_CY 21 18 $pal.high
  for ($i = 0; $i -lt 5; $i++) {
    $y = $HF_BODY_CY + 10 + $i * 4
    Set-Pixel $bmp ($cx - 6) $y $pal.top
    Set-Pixel $bmp ($cx - 2) $y $pal.top
    Set-Pixel $bmp ($cx + 2) $y $pal.top
    Set-Pixel $bmp ($cx + 6) $y $pal.top
  }
  # Front clawed feet
  Fill-Box $bmp ($cx - 14) ($HF_BODY_CY + 18) 8 6 $pal.deep
  Fill-Box $bmp ($cx + 6) ($HF_BODY_CY + 18) 8 6 $pal.deep
  Set-Pixel $bmp ($cx - 14) ($HF_BODY_CY + 23) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($cx - 10) ($HF_BODY_CY + 23) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($cx + 9) ($HF_BODY_CY + 23) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($cx + 13) ($HF_BODY_CY + 23) (Color-FromHex '#ffffff')
  # Head — rounded with snout (bigger to match body proportions)
  Shade-Oval $bmp $cx ($HF_HEAD_CY + 2) 24 22 $pal
  # Snout
  Fill-Box $bmp ($cx - 5) ($HF_HEAD_CY + 6) 11 12 $pal.base
  Set-Pixel $bmp ($cx - 5) ($HF_HEAD_CY + 4) $pal.shadow
  Set-Pixel $bmp ($cx + 5) ($HF_HEAD_CY + 4) $pal.shadow
  Set-Pixel $bmp ($cx - 5) ($HF_HEAD_CY + 15) $pal.deep
  Set-Pixel $bmp ($cx + 5) ($HF_HEAD_CY + 15) $pal.deep
  # Nostrils
  Set-Pixel $bmp ($cx - 2) ($HF_HEAD_CY + 8) $pal.deep
  Set-Pixel $bmp ($cx + 2) ($HF_HEAD_CY + 8) $pal.deep
  # Tooth peek
  Set-Pixel $bmp ($cx - 2) ($HF_HEAD_CY + 14) (Color-FromHex '#ffffff')
  Set-Pixel $bmp ($cx + 2) ($HF_HEAD_CY + 14) (Color-FromHex '#ffffff')
  # Horns (curved up from forehead)
  Fill-Box $bmp ($cx - 11) ($HF_HEAD_CY - 16) 3 8 $pal.shadow
  Set-Pixel $bmp ($cx - 11) ($HF_HEAD_CY - 16) $pal.deep
  Set-Pixel $bmp ($cx - 9) ($HF_HEAD_CY - 8) $pal.base
  Fill-Box $bmp ($cx + 9) ($HF_HEAD_CY - 16) 3 8 $pal.shadow
  Set-Pixel $bmp ($cx + 11) ($HF_HEAD_CY - 16) $pal.deep
  Set-Pixel $bmp ($cx + 9) ($HF_HEAD_CY - 8) $pal.base
  # Eyes
  Draw-HiFiEye $bmp ($cx - 7) ($HF_HEAD_CY - 1) $pal 3
  Draw-HiFiEye $bmp ($cx + 7) ($HF_HEAD_CY - 1) $pal 3
  # Eye ridges
  Set-Pixel $bmp ($cx - 9) ($HF_HEAD_CY - 5) $pal.deep
  Set-Pixel $bmp ($cx - 7) ($HF_HEAD_CY - 5) $pal.deep
  Set-Pixel $bmp ($cx + 7) ($HF_HEAD_CY - 5) $pal.deep
  Set-Pixel $bmp ($cx + 9) ($HF_HEAD_CY - 5) $pal.deep
  # Wings (folded against body, visible at top)
  for ($i = 0; $i -lt 16; $i++) {
    $y = $HF_BODY_CY - 10 + $i
    $w = if ($i -lt 8) { 6 + $i } else { 16 - $i }
    if ($w -gt 0) {
      Fill-Box $bmp ($cx - 28) $y 4 1 $pal.shadow
      Set-Pixel $bmp ($cx - 28) $y $pal.deep
      Fill-Box $bmp ($cx + 24) $y 4 1 $pal.shadow
      Set-Pixel $bmp ($cx + 27) $y $pal.deep
    }
  }
  # Spike ridges down back
  for ($i = 0; $i -lt 5; $i++) {
    $y = $HF_BODY_CY - 10 + $i * 5
    Fill-Box $bmp $cx $y 1 3 $pal.top
    Set-Pixel $bmp ($cx - 1) ($y + 1) $pal.high
  }
  # Tail with spike tip
  Fill-Box $bmp ($cx + 18) ($HF_BODY_CY + 16) 12 4 $pal.base
  Fill-Box $bmp ($cx + 24) ($HF_BODY_CY + 10) 8 4 $pal.base
  Set-Pixel $bmp ($cx + 30) $HF_BODY_CY $pal.top
  Set-Pixel $bmp ($cx + 30) ($HF_BODY_CY - 2) $pal.high
  Set-Pixel $bmp ($cx + 31) ($HF_BODY_CY - 4) $pal.shadow
}

# ── Frog ───────────────────────────────────────────────────────────
function Draw-HiFi-Frog {
  param($bmp, $pal)
  $cx = $HF_CX
  Draw-HiFiGround $bmp $cx
  # Body — squat, wide
  Shade-Oval $bmp $cx $HF_BODY_CY 30 18 $pal
  # Lighter belly stripe
  Fill-Box $bmp ($cx - 10) ($HF_BODY_CY + 10) 21 16 $pal.high
  Set-Pixel $bmp ($cx - 8) ($HF_BODY_CY + 18) $pal.top
  Set-Pixel $bmp ($cx + 8) ($HF_BODY_CY + 18) $pal.top
  # Long back legs splayed
  Fill-Box $bmp ($cx - 26) ($HF_BODY_CY + 14) 8 10 $pal.base
  Fill-Box $bmp ($cx + 18) ($HF_BODY_CY + 14) 8 10 $pal.base
  # Long front legs/feet
  Fill-Box $bmp ($cx - 18) ($HF_BODY_CY + 20) 4 4 $pal.shadow
  Fill-Box $bmp ($cx + 14) ($HF_BODY_CY + 20) 4 4 $pal.shadow
  # Webbed feet
  Fill-Box $bmp ($cx - 30) ($HF_BODY_CY + 22) 12 4 $pal.shadow
  Fill-Box $bmp ($cx + 18) ($HF_BODY_CY + 22) 12 4 $pal.shadow
  Set-Pixel $bmp ($cx - 28) ($HF_BODY_CY + 24) $pal.deep
  Set-Pixel $bmp ($cx - 24) ($HF_BODY_CY + 24) $pal.deep
  Set-Pixel $bmp ($cx - 20) ($HF_BODY_CY + 24) $pal.deep
  Set-Pixel $bmp ($cx + 21) ($HF_BODY_CY + 24) $pal.deep
  Set-Pixel $bmp ($cx + 25) ($HF_BODY_CY + 24) $pal.deep
  Set-Pixel $bmp ($cx + 29) ($HF_BODY_CY + 24) $pal.deep
  # Head — wider than tall, merged with body
  Shade-Oval $bmp $cx ($HF_HEAD_CY + 6) 22 16 $pal
  # Eyes — bulging on top of head (frog-style)
  Shade-Disc $bmp ($cx - 12) ($HF_HEAD_CY - 6) 7 $pal
  Shade-Disc $bmp ($cx + 12) ($HF_HEAD_CY - 6) 7 $pal
  # Eye sclera
  $white = Color-FromHex '#ffffff'
  Fill-Box $bmp ($cx - 14) ($HF_HEAD_CY - 8) 5 5 $white
  Fill-Box $bmp ($cx + 10) ($HF_HEAD_CY - 8) 5 5 $white
  # Pupil
  Fill-Box $bmp ($cx - 13) ($HF_HEAD_CY - 7) 2 3 (Color-FromHex '#0a0a14')
  Fill-Box $bmp ($cx + 11) ($HF_HEAD_CY - 7) 2 3 (Color-FromHex '#0a0a14')
  # Mouth (wide line)
  for ($i = -10; $i -le 10; $i++) {
    Set-Pixel $bmp ($cx + $i) ($HF_HEAD_CY + 10) $pal.deep
  }
  Set-Pixel $bmp ($cx - 11) ($HF_HEAD_CY + 11) $pal.deep
  Set-Pixel $bmp ($cx + 11) ($HF_HEAD_CY + 11) $pal.deep
  # Cheek blush
  Draw-HiFiCheek $bmp ($cx - 16) ($HF_HEAD_CY + 4)
  Draw-HiFiCheek $bmp ($cx + 16) ($HF_HEAD_CY + 4)
  # Nostrils
  Set-Pixel $bmp ($cx - 3) ($HF_HEAD_CY + 3) $pal.deep
  Set-Pixel $bmp ($cx + 3) ($HF_HEAD_CY + 3) $pal.deep
  # Spots (cute spots on back)
  Set-Pixel $bmp ($cx - 14) ($HF_BODY_CY - 4) $pal.shadow
  Fill-Box $bmp ($cx - 15) ($HF_BODY_CY + 5) 3 2 $pal.shadow
  Set-Pixel $bmp ($cx + 12) ($HF_BODY_CY - 2) $pal.shadow
  Fill-Box $bmp ($cx + 11) ($HF_BODY_CY + 7) 3 2 $pal.shadow
  Set-Pixel $bmp ($cx) ($HF_BODY_CY + 2) $pal.shadow
}

# ── Bunny ──────────────────────────────────────────────────────────
function Draw-HiFi-Bunny {
  param($bmp, $pal)
  $cx = $HF_CX
  Draw-HiFiGround $bmp $cx
  # Body — egg-shaped, sitting
  Shade-Oval $bmp $cx $HF_BODY_CY 24 22 $pal
  # Belly (lighter)
  Fill-Box $bmp ($cx - 8) $HF_BODY_CY 17 18 $pal.high
  Set-Pixel $bmp ($cx - 2) ($HF_BODY_CY + 14) $pal.top
  Set-Pixel $bmp ($cx + 2) ($HF_BODY_CY + 14) $pal.top
  # Tucked front paws
  Fill-Box $bmp ($cx - 10) ($HF_BODY_CY + 20) 6 4 $pal.shadow
  Fill-Box $bmp ($cx + 4) ($HF_BODY_CY + 20) 6 4 $pal.shadow
  Fill-Box $bmp ($cx - 9) ($HF_BODY_CY + 21) 4 2 $pal.base
  Fill-Box $bmp ($cx + 5) ($HF_BODY_CY + 21) 4 2 $pal.base
  # Tucked back foot
  Fill-Box $bmp ($cx - 22) ($HF_BODY_CY + 16) 10 8 $pal.shadow
  Fill-Box $bmp ($cx - 22) ($HF_BODY_CY + 18) 9 5 $pal.base
  Set-Pixel $bmp ($cx - 19) ($HF_BODY_CY + 22) $pal.deep
  Set-Pixel $bmp ($cx - 16) ($HF_BODY_CY + 22) $pal.deep
  # Head — round
  Shade-Oval $bmp $cx ($HF_HEAD_CY + 6) 18 16 $pal
  # Long upright ears
  for ($i = 0; $i -lt 28; $i++) {
    $w = if ($i -lt 4) { 5 - $i } elseif ($i -gt 24) { 28 - $i } else { 4 }
    if ($w -le 0) { continue }
    $col = if ($i % 3 -eq 0) { $pal.high } else { $pal.base }
    Fill-Box $bmp ($cx - 16) ($HF_HEAD_CY - 22 + $i) $w 1 $col
    Set-Pixel $bmp ($cx - 16) ($HF_HEAD_CY - 22 + $i) $pal.shadow
    Set-Pixel $bmp ($cx - 16 + $w - 1) ($HF_HEAD_CY - 22 + $i) $pal.shadow
    Fill-Box $bmp ($cx + 12) ($HF_HEAD_CY - 22 + $i) $w 1 $col
    Set-Pixel $bmp ($cx + 12) ($HF_HEAD_CY - 22 + $i) $pal.shadow
    Set-Pixel $bmp ($cx + 12 + $w - 1) ($HF_HEAD_CY - 22 + $i) $pal.shadow
  }
  # Pink inner ear
  $pink = Color-FromHex '#ffb8c8'
  Fill-Box $bmp ($cx - 15) ($HF_HEAD_CY - 18) 2 16 $pink
  Fill-Box $bmp ($cx + 13) ($HF_HEAD_CY - 18) 2 16 $pink
  # Eyes (closed sleepy crescents would be cute but show bright open eyes for energy)
  Draw-HiFiEye $bmp ($cx - 6) ($HF_HEAD_CY + 2) $pal 3
  Draw-HiFiEye $bmp ($cx + 6) ($HF_HEAD_CY + 2) $pal 3
  # Pink nose (Y-shape)
  Fill-Box $bmp ($cx - 1) ($HF_HEAD_CY + 8) 3 2 $pink
  Set-Pixel $bmp $cx ($HF_HEAD_CY + 10) $pal.deep
  # Mouth
  Set-Pixel $bmp ($cx - 1) ($HF_HEAD_CY + 11) $pal.deep
  Set-Pixel $bmp ($cx + 1) ($HF_HEAD_CY + 11) $pal.deep
  Set-Pixel $bmp ($cx - 2) ($HF_HEAD_CY + 12) $pal.deep
  Set-Pixel $bmp ($cx + 2) ($HF_HEAD_CY + 12) $pal.deep
  # Cheek
  Draw-HiFiCheek $bmp ($cx - 10) ($HF_HEAD_CY + 9)
  Draw-HiFiCheek $bmp ($cx + 10) ($HF_HEAD_CY + 9)
  # Whisker hint
  Set-Pixel $bmp ($cx - 12) ($HF_HEAD_CY + 9) $pal.shadow
  Set-Pixel $bmp ($cx + 12) ($HF_HEAD_CY + 9) $pal.shadow
  # Fluffy tail (visible behind body, right side)
  Shade-Disc $bmp ($cx + 18) ($HF_BODY_CY + 12) 4 $pal
  Set-Pixel $bmp ($cx + 16) ($HF_BODY_CY + 10) $pal.top
  Set-Pixel $bmp ($cx + 17) ($HF_BODY_CY + 9) $pal.top
}

# ── Build pets ─────────────────────────────────────────────────────
function Draw-PetHiFi {
  param($bmp, [string]$species, [string]$colour)
  $key = "$species-$colour"
  $pal = HiFi-Ramp $key
  switch ($species) {
    'cat'        { Draw-HiFi-Cat        $bmp $pal }
    'dog'        { Draw-HiFi-Dog        $bmp $pal }
    'owl'        { Draw-HiFi-Owl        $bmp $pal }
    'fox'        { Draw-HiFi-Fox        $bmp $pal }
    'slime'      { Draw-HiFi-Slime      $bmp $pal }
    'dragonling' { Draw-HiFi-Dragonling $bmp $pal }
    'frog'       { Draw-HiFi-Frog       $bmp $pal }
    'bunny'      { Draw-HiFi-Bunny      $bmp $pal }
    default      { throw "Unknown species: $species" }
  }
}

function Build-PetsHiFi {
  Write-Host '── Pets (hi-fi 128x128) ──' -ForegroundColor Cyan
  $hifiDir = Join-Path $OutRoot 'pet/hifi'
  New-Item -ItemType Directory -Force -Path $hifiDir | Out-Null
  $count = 0
  foreach ($key in ($PET_PALETTES_HIFI.Keys | Sort-Object)) {
    $parts = $key -split '-', 2
    $species = $parts[0]
    $colour  = $parts[1]
    $bmp = New-CanvasFx $HF_W $HF_H
    Draw-PetHiFi $bmp $species $colour
    Save-CanvasFx $bmp (Join-Path $hifiDir ("{0}-{1}.png" -f $species, $colour))
    $count++
  }
  Write-Host ("  variants: {0}" -f $count) -ForegroundColor Green
}

# ── Mood overlays (hi-fi) ──────────────────────────────────────────
# Positioned upper-right of the canvas — sits over the pet's head
# when composited. Each ~40×40 stamp.
$HF_MOOD_X = 84
$HF_MOOD_Y = 12

function Draw-HiFi-Mood-Hungry { param($bmp)
  $bowl    = Color-FromHex '#a86028'
  $bowlHi  = Color-FromHex '#d4843c'
  $bowlDeep = Color-FromHex '#603810'
  $crumb   = Color-FromHex '#f0b429'
  $crumbHi = Color-FromHex '#ffe098'
  # Bubble background (speech-bubble feel)
  $bubble = Color-FromHex '#fff8e0'
  $bubbleEdge = Color-FromHex '#c08858'
  for ($y = 0; $y -lt 32; $y++) {
    for ($x = 0; $x -lt 32; $x++) {
      $dx = $x - 16; $dy = $y - 16
      $d2 = $dx*$dx + $dy*$dy
      if ($d2 -lt 196) {
        Set-Pixel $bmp ($HF_MOOD_X + $x) ($HF_MOOD_Y + $y) $bubble
      } elseif ($d2 -lt 232) {
        Set-Pixel $bmp ($HF_MOOD_X + $x) ($HF_MOOD_Y + $y) $bubbleEdge
      }
    }
  }
  # Bowl
  $bx = $HF_MOOD_X + 8
  $by = $HF_MOOD_Y + 18
  Fill-Box $bmp $bx ($by + 4) 16 2 $bowl
  Fill-Box $bmp ($bx + 1) ($by + 6) 14 4 $bowl
  Fill-Box $bmp ($bx + 2) ($by + 10) 12 1 $bowlDeep
  Set-Pixel $bmp ($bx + 2) ($by + 6) $bowlHi
  Set-Pixel $bmp ($bx + 3) ($by + 6) $bowlHi
  # Crumbs / question marks
  Fill-Box $bmp ($HF_MOOD_X + 12) ($HF_MOOD_Y + 6) 2 2 $crumb
  Fill-Box $bmp ($HF_MOOD_X + 16) ($HF_MOOD_Y + 10) 2 2 $crumb
  Fill-Box $bmp ($HF_MOOD_X + 20) ($HF_MOOD_Y + 6) 2 2 $crumb
  Set-Pixel $bmp ($HF_MOOD_X + 12) ($HF_MOOD_Y + 6) $crumbHi
  Set-Pixel $bmp ($HF_MOOD_X + 20) ($HF_MOOD_Y + 6) $crumbHi
}

function Draw-HiFi-Mood-Sad { param($bmp)
  $drop    = Color-FromHex '#3a86ff'
  $dropHi  = Color-FromHex '#a0c4ff'
  $dropDp  = Color-FromHex '#1a3680'
  $bubble = Color-FromHex '#dcedff'
  $bubbleEdge = Color-FromHex '#5080c0'
  for ($y = 0; $y -lt 32; $y++) {
    for ($x = 0; $x -lt 32; $x++) {
      $dx = $x - 16; $dy = $y - 16
      $d2 = $dx*$dx + $dy*$dy
      if ($d2 -lt 196) {
        Set-Pixel $bmp ($HF_MOOD_X + $x) ($HF_MOOD_Y + $y) $bubble
      } elseif ($d2 -lt 232) {
        Set-Pixel $bmp ($HF_MOOD_X + $x) ($HF_MOOD_Y + $y) $bubbleEdge
      }
    }
  }
  # Big teardrop in centre
  $tx = $HF_MOOD_X + 16
  $ty = $HF_MOOD_Y + 8
  for ($i = 0; $i -lt 16; $i++) {
    $w = if ($i -lt 3) { $i + 1 } elseif ($i -lt 12) { [int]([Math]::Round(3 + ($i - 3) * 0.55)) } else { 16 - $i }
    if ($w -le 0) { continue }
    Fill-Box $bmp ($tx - $w) ($ty + $i) ($w * 2 + 1) 1 $drop
    Set-Pixel $bmp ($tx - $w) ($ty + $i) $dropDp
    Set-Pixel $bmp ($tx + $w) ($ty + $i) $dropDp
  }
  # Highlight
  Set-Pixel $bmp ($tx - 1) ($ty + 5) $dropHi
  Set-Pixel $bmp ($tx) ($ty + 4) $dropHi
  Set-Pixel $bmp ($tx + 1) ($ty + 6) $dropHi
  Fill-Box $bmp ($tx - 1) ($ty + 7) 2 2 $dropHi
}

function Draw-HiFi-Mood-Dirty { param($bmp)
  $fly  = Color-FromHex '#222228'
  $wing = Color-FromHex '#9aa1b4'
  $stink = Color-FromHex '#5b9050'
  $bubble = Color-FromHex '#e0f0d8'
  $bubbleEdge = Color-FromHex '#6a8a4a'
  for ($y = 0; $y -lt 32; $y++) {
    for ($x = 0; $x -lt 32; $x++) {
      $dx = $x - 16; $dy = $y - 16
      $d2 = $dx*$dx + $dy*$dy
      if ($d2 -lt 196) {
        Set-Pixel $bmp ($HF_MOOD_X + $x) ($HF_MOOD_Y + $y) $bubble
      } elseif ($d2 -lt 232) {
        Set-Pixel $bmp ($HF_MOOD_X + $x) ($HF_MOOD_Y + $y) $bubbleEdge
      }
    }
  }
  # Fly body in centre
  $fx = $HF_MOOD_X + 16
  $fy = $HF_MOOD_Y + 16
  Fill-Box $bmp ($fx - 2) ($fy - 1) 5 3 $fly
  Set-Pixel $bmp ($fx + 1) ($fy) $wing
  # Wings
  Fill-Box $bmp ($fx - 5) ($fy - 4) 4 3 $wing
  Fill-Box $bmp ($fx + 2) ($fy - 4) 4 3 $wing
  Set-Pixel $bmp ($fx - 5) ($fy - 4) $fly
  Set-Pixel $bmp ($fx + 5) ($fy - 4) $fly
  # Stink clouds around
  Fill-Box $bmp ($fx - 12) ($fy - 6) 3 2 $stink
  Fill-Box $bmp ($fx + 9) ($fy - 6) 3 2 $stink
  Fill-Box $bmp ($fx - 12) ($fy + 4) 3 2 $stink
  Fill-Box $bmp ($fx + 9) ($fy + 4) 3 2 $stink
  Fill-Box $bmp ($fx - 1) ($fy - 10) 3 2 $stink
  Fill-Box $bmp ($fx - 1) ($fy + 8) 3 2 $stink
  # Squiggle trail
  Set-Pixel $bmp ($fx - 8) ($fy) $fly
  Set-Pixel $bmp ($fx - 7) ($fy - 1) $fly
  Set-Pixel $bmp ($fx - 6) ($fy) $fly
  Set-Pixel $bmp ($fx - 5) ($fy - 1) $fly
}

function Build-MoodsHiFi {
  Write-Host '── Mood overlays (hi-fi) ──' -ForegroundColor Cyan
  $hifiDir = Join-Path $OutRoot 'pet/hifi'
  New-Item -ItemType Directory -Force -Path $hifiDir | Out-Null
  $moods = @(
    @{ name = 'hungry'; drawer = ${function:Draw-HiFi-Mood-Hungry} }
    @{ name = 'sad';    drawer = ${function:Draw-HiFi-Mood-Sad}    }
    @{ name = 'dirty';  drawer = ${function:Draw-HiFi-Mood-Dirty}  }
  )
  $count = 0
  foreach ($m in $moods) {
    $bmp = New-CanvasFx $HF_W $HF_H
    & $m.drawer $bmp
    Save-CanvasFx $bmp (Join-Path $hifiDir ("mood-{0}.png" -f $m.name))
    $count++
  }
  Write-Host ("  moods: {0}" -f $count) -ForegroundColor Green
}

# ── Driver ─────────────────────────────────────────────────────────
Build-PetsHiFi
Build-MoodsHiFi

Write-Host ''
Write-Host 'Pets hi-fi pass complete.' -ForegroundColor Green
Write-Host "Output: $(Join-Path $OutRoot 'pet/hifi')"
