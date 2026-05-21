# Procedural pixel-art sprite generator for the Loadout character +
# gear + pet system.
#
# Clay said: "Make all the art in house. It doesn't have to be human
# grade but I just want it to look as good as you can make it."
#
# Quality target: rarity-readable at a glance, no two pieces look
# identical, brand palette discipline. We're not competing with an
# artisan — we're producing a coherent procedural roster.
#
# Output paths (committed to git):
#   aquilo-gg/sprites/figure/body-<bodyType>-<skinTone>.png
#   aquilo-gg/sprites/figure/hair-<style>-<color>.png
#   aquilo-gg/sprites/figure/eyes-<color>.png
#   aquilo-gg/sprites/figure/accent-<name>.png
#   aquilo-gg/sprites/gear/<slot>/<id>.png
#   aquilo-gg/sprites/pet/<species>-<color>.png  (or .apng for animated)
#
# Canvas: 40w × 56h per CHARACTER-SYSTEM-DESIGN.md §4. Figure footprint
# is 24w × 40h centred at the bottom (rows 16–56).
#
# To regenerate from scratch:
#   pwsh -ExecutionPolicy Bypass -File tools/build-sprites.ps1

[CmdletBinding()]
param(
  [string]$OutRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'aquilo-gg/sprites'),
  [int]$CanvasW   = 40,
  [int]$CanvasH   = 56,
  [int]$FigureW   = 24,
  [int]$FigureH   = 40
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

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

# ── Brand palette ───────────────────────────────────────────────────
# Locked-in across the whole system. The art language stays coherent
# even when each piece is unique.
$BRAND = @{
  Violet    = [System.Drawing.Color]::FromArgb(255, 0x7c, 0x5c, 0xff);
  VioletHi  = [System.Drawing.Color]::FromArgb(255, 0x9a, 0x82, 0xff);
  Green     = [System.Drawing.Color]::FromArgb(255, 0x5b, 0xff, 0x95);
  Teal      = [System.Drawing.Color]::FromArgb(255, 0x6e, 0xe0, 0xc0);
  Gold      = [System.Drawing.Color]::FromArgb(255, 0xf0, 0xb4, 0x29);
  Crimson   = [System.Drawing.Color]::FromArgb(255, 0xf8, 0x51, 0x49);
  Ink       = [System.Drawing.Color]::FromArgb(255, 0x0a, 0x0b, 0x12);
  Steel     = [System.Drawing.Color]::FromArgb(255, 0x4a, 0x52, 0x68);
  SteelHi   = [System.Drawing.Color]::FromArgb(255, 0x7a, 0x85, 0xa3);
  Wood      = [System.Drawing.Color]::FromArgb(255, 0x6b, 0x47, 0x2b);
  WoodHi    = [System.Drawing.Color]::FromArgb(255, 0xa6, 0x7a, 0x4f);
  Leather   = [System.Drawing.Color]::FromArgb(255, 0x5a, 0x3a, 0x22);
  LeatherHi = [System.Drawing.Color]::FromArgb(255, 0x8c, 0x5d, 0x37);
}

# ── Skin tones, hair colours, eye colours ──────────────────────────
$SKIN_TONES = @{
  fair        = @{ shadow = '#e0bca0'; base = '#f4d7b8'; high = '#ffe6cc' };
  porcelain   = @{ shadow = '#d8b89b'; base = '#f0d2b6'; high = '#fff0d8' };
  rose        = @{ shadow = '#d49a8a'; base = '#eebcad'; high = '#fcd6c9' };
  tan         = @{ shadow = '#a47148'; base = '#c89770'; high = '#e7b894' };
  olive       = @{ shadow = '#8a6a3a'; base = '#b08c5a'; high = '#cfa973' };
  bronze      = @{ shadow = '#7a4e25'; base = '#a86c39'; high = '#c98a53' };
  umber       = @{ shadow = '#5a3618'; base = '#7c4b25'; high = '#9e6438' };
  ebony       = @{ shadow = '#3a2316'; base = '#52311e'; high = '#6f4326' };
  pale_violet = @{ shadow = '#9486a8'; base = '#b6a8c8'; high = '#d6c8e6' };
  ash         = @{ shadow = '#6b6e78'; base = '#8d909a'; high = '#b2b5be' };
}

$HAIR_COLOURS = @{
  brown   = @{ shadow = '#3b251a'; base = '#5a3a26'; high = '#7a5236' };
  black   = @{ shadow = '#161618'; base = '#2a2a30'; high = '#42424a' };
  blonde  = @{ shadow = '#a37a30'; base = '#d4a64a'; high = '#f4d27a' };
  red     = @{ shadow = '#7a2018'; base = '#b53420'; high = '#d8553a' };
  grey    = @{ shadow = '#5f636c'; base = '#878b95'; high = '#b3b8c2' };
  white   = @{ shadow = '#c8ccd6'; base = '#e6e9ef'; high = '#ffffff' };
  violet  = @{ shadow = '#5a40b0'; base = '#7c5cff'; high = '#a890ff' };
  teal    = @{ shadow = '#2f8a78'; base = '#5fc4a8'; high = '#92e6cd' };
  pink    = @{ shadow = '#c14688'; base = '#e87ab0'; high = '#ffabcf' };
  mint    = @{ shadow = '#3da76c'; base = '#5be098'; high = '#90ffc4' };
  silver  = @{ shadow = '#7a8090'; base = '#a8afbc'; high = '#d4d8e0' };
  copper  = @{ shadow = '#9c4a1f'; base = '#cf7240'; high = '#f09866' };
  navy    = @{ shadow = '#172046'; base = '#293a78'; high = '#3e539c' };
  forest  = @{ shadow = '#1a3a20'; base = '#2e5c34'; high = '#4b8550' };
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

function Color-FromHex {
  param([string]$h)
  $h = $h.TrimStart('#')
  $r = [Convert]::ToInt32($h.Substring(0,2), 16)
  $g = [Convert]::ToInt32($h.Substring(2,2), 16)
  $b = [Convert]::ToInt32($h.Substring(4,2), 16)
  return [System.Drawing.Color]::FromArgb(255, $r, $g, $b)
}

# ── PNG helpers ────────────────────────────────────────────────────
# All sprites land on a 40×56 transparent canvas at integer pixel
# positions. We use SetPixel directly to keep aliasing out of pixel
# art (the GDI+ smoothing modes don't help for 1-pixel ops anyway).
function New-Canvas {
  $bmp = New-Object System.Drawing.Bitmap($CanvasW, $CanvasH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  # Clear to transparent
  for ($y = 0; $y -lt $CanvasH; $y++) {
    for ($x = 0; $x -lt $CanvasW; $x++) {
      $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    }
  }
  return $bmp
}

function Save-Canvas {
  param($bmp, [string]$path)
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Set-Px {
  param($bmp, [int]$x, [int]$y, $color)
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $CanvasW -or $y -ge $CanvasH) { return }
  $bmp.SetPixel($x, $y, $color)
}

function Fill-Rect {
  param($bmp, [int]$x, [int]$y, [int]$w, [int]$h, $color)
  for ($yy = $y; $yy -lt ($y + $h); $yy++) {
    for ($xx = $x; $xx -lt ($x + $w); $xx++) {
      Set-Px $bmp $xx $yy $color
    }
  }
}

# Draw an outline rectangle (1 px) with optional fill.
function Stroke-Rect {
  param($bmp, [int]$x, [int]$y, [int]$w, [int]$h, $stroke, $fill = $null)
  if ($fill) { Fill-Rect $bmp $x $y $w $h $fill }
  for ($i = 0; $i -lt $w; $i++) {
    Set-Px $bmp ($x + $i) $y $stroke
    Set-Px $bmp ($x + $i) ($y + $h - 1) $stroke
  }
  for ($i = 0; $i -lt $h; $i++) {
    Set-Px $bmp $x ($y + $i) $stroke
    Set-Px $bmp ($x + $w - 1) ($y + $i) $stroke
  }
}

# Trace a diagonal line (Bresenham) with a single colour.
function Draw-Line {
  param($bmp, [int]$x0, [int]$y0, [int]$x1, [int]$y1, $color)
  $dx = [Math]::Abs($x1 - $x0); $dy = [Math]::Abs($y1 - $y0)
  $sx = if ($x0 -lt $x1) { 1 } else { -1 }
  $sy = if ($y0 -lt $y1) { 1 } else { -1 }
  $err = $dx - $dy
  while ($true) {
    Set-Px $bmp $x0 $y0 $color
    if ($x0 -eq $x1 -and $y0 -eq $y1) { break }
    $e2 = 2 * $err
    if ($e2 -gt -$dy) { $err -= $dy; $x0 += $sx }
    if ($e2 -lt  $dx) { $err += $dx; $y0 += $sy }
  }
}

# ── Figure body — base humanoid silhouette ─────────────────────────
# Standardised shape so every gear sprite drops in at the exact pixel
# the figure expects. The "ghost" body is what the gear authoring
# would have shown an artist; here the same procedural code produces
# the body sprite that ships AND the implicit ghost that gear is
# positioned against.
function Draw-Body {
  param($bmp, [string]$bodyType, $skinPalette)

  $shadow = Color-FromHex $skinPalette.shadow
  $base   = Color-FromHex $skinPalette.base
  $high   = Color-FromHex $skinPalette.high
  $ink    = $BRAND.Ink

  # Figure origin (rows 16..56 by §4 spec)
  $oy = 16   # top of head
  # x-centred in canvas: figure footprint 24w, canvas 40w → x in 8..32
  $ox = 8

  $slim    = ($bodyType -eq 'slim')
  $headW   = if ($slim) { 10 } else { 12 }
  $bodyW   = if ($slim) { 12 } else { 16 }
  $headX   = $ox + [int](($FigureW - $headW) / 2)
  $headY   = $oy
  $headH   = 10

  # Head — rounded rect, two tone
  Fill-Rect $bmp $headX $headY $headW $headH $base
  # Highlights (upper-left)
  for ($y = 0; $y -lt 4; $y++) {
    for ($x = 0; $x -lt 3; $x++) {
      Set-Px $bmp ($headX + 1 + $x) ($headY + 1 + $y) $high
    }
  }
  # Bottom shadow row
  Fill-Rect $bmp $headX ($headY + $headH - 1) $headW 1 $shadow
  # Outline
  Stroke-Rect $bmp $headX $headY $headW $headH $ink

  # Neck (2×2)
  $neckW = if ($slim) { 3 } else { 4 }
  $neckX = $ox + [int](($FigureW - $neckW) / 2)
  $neckY = $headY + $headH
  Fill-Rect $bmp $neckX $neckY $neckW 2 $shadow

  # Torso — slightly tapered
  $torsoY = $neckY + 2
  $torsoX = $ox + [int](($FigureW - $bodyW) / 2)
  $torsoH = 14
  for ($y = 0; $y -lt $torsoH; $y++) {
    $taper = if ($slim) { [int]($y / 7) } else { 0 }
    $w = $bodyW - $taper
    $x = $torsoX + [int](($bodyW - $w) / 2)
    Fill-Rect $bmp $x ($torsoY + $y) $w 1 $base
    Set-Px $bmp $x ($torsoY + $y) $shadow
    Set-Px $bmp ($x + $w - 1) ($torsoY + $y) $shadow
  }
  Stroke-Rect $bmp $torsoX $torsoY $bodyW $torsoH $ink

  # Arms — 2 wide, run alongside the torso
  $armY = $torsoY + 1
  $armH = 10
  $armLX = $torsoX - 2; $armRX = $torsoX + $bodyW
  Fill-Rect $bmp $armLX $armY 2 $armH $base
  Fill-Rect $bmp $armRX $armY 2 $armH $base
  Stroke-Rect $bmp $armLX $armY 2 $armH $ink
  Stroke-Rect $bmp $armRX $armY 2 $armH $ink

  # Hands
  Fill-Rect $bmp $armLX ($armY + $armH) 2 2 $base
  Fill-Rect $bmp $armRX ($armY + $armH) 2 2 $base
  Stroke-Rect $bmp $armLX ($armY + $armH) 2 2 $ink
  Stroke-Rect $bmp $armRX ($armY + $armH) 2 2 $ink

  # Legs
  $legY = $torsoY + $torsoH
  $legH = 8
  $legW = if ($slim) { 3 } else { 4 }
  $legGap = 2
  $legLX = $torsoX + [int](($bodyW - 2 * $legW - $legGap) / 2)
  $legRX = $legLX + $legW + $legGap
  Fill-Rect $bmp $legLX $legY $legW $legH $base
  Fill-Rect $bmp $legRX $legY $legW $legH $base
  Stroke-Rect $bmp $legLX $legY $legW $legH $ink
  Stroke-Rect $bmp $legRX $legY $legW $legH $ink
}

# ── Generate figure layers ─────────────────────────────────────────
function Build-Figure {
  Write-Host '── Building figure layers ──' -ForegroundColor Cyan
  $count = 0
  foreach ($body in @('slim','stocky')) {
    foreach ($skin in $SKIN_TONES.Keys) {
      $bmp = New-Canvas
      Draw-Body $bmp $body $SKIN_TONES[$skin]
      Save-Canvas $bmp (Join-Path $figDir ("body-{0}-{1}.png" -f $body, $skin))
      $count++
    }
  }
  Write-Host "  figure bodies: $count" -ForegroundColor Green
}

# ── Hair styles ────────────────────────────────────────────────────
#
# Authored at the reference "brown" palette
#   shadow = #3b251a   base = #5a3a26   high = #7a5236
# The Worker compositor (character.js) palette-swaps to the chosen
# hairColor at render time, so we only emit one sprite per style.
#
# Each style is a self-contained procedural drawing that lands on the
# same 40×56 canvas at the same head position (head is 10 px tall
# starting at row 16, x-centred). Hair extends UPWARD into the
# headroom (rows 0..15) where helmets / plumes also live.

$HAIR_REF = @{ shadow = (Color-FromHex '#3b251a'); base = (Color-FromHex '#5a3a26'); high = (Color-FromHex '#7a5236') }

function Hair-Common-Cap {
  # Draws a small wedge of hair covering the top + back of the head,
  # used as a base for short-tousled / pixie / shaved-sides etc.
  param($bmp, [int]$x, [int]$y, [int]$w, [int]$h)
  $b = $HAIR_REF.base; $s = $HAIR_REF.shadow; $hi = $HAIR_REF.high
  Fill-Rect $bmp $x $y $w $h $b
  # shadow row along the bottom edge
  Fill-Rect $bmp $x ($y + $h - 1) $w 1 $s
  # highlight pixels along the upper-left
  for ($i = 0; $i -lt 3; $i++) {
    Set-Px $bmp ($x + 1 + $i) ($y + 1) $hi
  }
}

function Draw-Hair {
  param($bmp, [string]$style)
  $b = $HAIR_REF.base; $s = $HAIR_REF.shadow; $hi = $HAIR_REF.high
  $ink = $BRAND.Ink
  # Head footprint matches Draw-Body: 10-12px wide × 10px tall starting at row 16
  # We use the AVERAGE width (11) so the hair fits both slim + stocky
  $headX = 14   # 8 ox + 6 padding
  $headY = 16
  $headW = 12
  $headH = 10

  switch ($style) {
    'bald' {
      # No hair — just emit a fully-transparent PNG. The renderer
      # special-cases hairStyle=='bald' and skips the layer, but we
      # still emit a stub PNG so the URL is always 200.
      return
    }
    'short-tousled' {
      # Wraps the upper half of the head
      Hair-Common-Cap $bmp ($headX - 1) ($headY - 1) ($headW + 2) 6
      # A few stray tousled pixels poking up
      Set-Px $bmp ($headX + 2) ($headY - 3) $b
      Set-Px $bmp ($headX + 6) ($headY - 4) $b
      Set-Px $bmp ($headX + 9) ($headY - 2) $b
    }
    'long-straight' {
      # Cap + falls past shoulders along both sides
      Hair-Common-Cap $bmp ($headX - 1) ($headY - 1) ($headW + 2) 5
      # Drape both sides down to row 38 (mid-torso)
      for ($y = $headY + 4; $y -le 38; $y++) {
        Set-Px $bmp ($headX - 1) $y $b
        Set-Px $bmp ($headX - 2) $y $s
        Set-Px $bmp ($headX + $headW) $y $b
        Set-Px $bmp ($headX + $headW + 1) $y $s
      }
    }
    'bun' {
      # Small cap + a 3×3 round bun on top
      Hair-Common-Cap $bmp ($headX - 1) ($headY - 1) ($headW + 2) 5
      $bx = $headX + 4; $by = $headY - 4
      Fill-Rect $bmp $bx $by 4 4 $b
      Set-Px $bmp $bx $by $s
      Set-Px $bmp ($bx + 3) $by $s
      Set-Px $bmp $bx ($by + 3) $s
      Set-Px $bmp ($bx + 3) ($by + 3) $s
      Set-Px $bmp ($bx + 1) ($by + 1) $hi
    }
    'mohawk' {
      # Central stripe rising from the head, 3 px wide × 6 px tall
      $mx = $headX + 4
      for ($y = 0; $y -lt 6; $y++) {
        Fill-Rect $bmp $mx ($headY - 6 + $y) 3 1 $b
        # Shadow on the right pixel
        Set-Px $bmp ($mx + 2) ($headY - 6 + $y) $s
      }
      # Cap at the very top (highlight)
      Set-Px $bmp ($mx + 1) ($headY - 6) $hi
      # Sides shaved — no other hair pixels
    }
    'braids' {
      # Cap + two braid strands hanging beside the face
      Hair-Common-Cap $bmp ($headX - 1) ($headY - 1) ($headW + 2) 5
      # Left braid (3 segments alternating shadow/base)
      $blx = $headX - 1
      for ($i = 0; $i -lt 3; $i++) {
        $by = $headY + 5 + $i * 3
        Fill-Rect $bmp $blx $by 2 2 $b
        Fill-Rect $bmp $blx ($by + 2) 2 1 $s
      }
      # Right braid
      $brx = $headX + $headW - 1
      for ($i = 0; $i -lt 3; $i++) {
        $by = $headY + 5 + $i * 3
        Fill-Rect $bmp $brx $by 2 2 $b
        Fill-Rect $bmp $brx ($by + 2) 2 1 $s
      }
    }
    'curly-afro' {
      # Halo of pixels around the head, roughly circular
      $cx = $headX + [int]($headW / 2)
      $cy = $headY + 1
      for ($y = -6; $y -le 4; $y++) {
        for ($x = -7; $x -le 7; $x++) {
          $d = [Math]::Sqrt($x * $x + $y * $y * 1.4)
          if ($d -ge 5.5 -and $d -le 7.5) {
            $col = if (($x + $y) % 2 -eq 0) { $b } else { $s }
            Set-Px $bmp ($cx + $x) ($cy + $y) $col
          }
          elseif ($d -lt 5.5) {
            Set-Px $bmp ($cx + $x) ($cy + $y) $b
          }
        }
      }
      # A few highlight specks
      Set-Px $bmp ($cx - 3) ($cy - 3) $hi
      Set-Px $bmp ($cx + 2) ($cy - 4) $hi
    }
    'pixie' {
      # Tight crop, slightly punky — short uneven fringe
      Hair-Common-Cap $bmp ($headX - 1) ($headY - 1) ($headW + 2) 4
      # Uneven fringe across the forehead
      Set-Px $bmp ($headX + 1) ($headY + 2) $b
      Set-Px $bmp ($headX + 4) ($headY + 2) $b
      Set-Px $bmp ($headX + 8) ($headY + 2) $b
      # Punky uplift on one side
      Set-Px $bmp ($headX - 1) ($headY - 2) $b
      Set-Px $bmp ($headX - 1) ($headY - 3) $b
    }
    'ponytail' {
      # Cap + gathered hair tied at the back, falling down the spine
      Hair-Common-Cap $bmp ($headX - 1) ($headY - 1) ($headW + 2) 5
      # Tie at the nape
      $tx = $headX + 9; $ty = $headY + 4
      Fill-Rect $bmp $tx $ty 2 2 $s
      # Tail falling down the back (right of the figure)
      for ($y = 0; $y -lt 12; $y++) {
        Fill-Rect $bmp ($tx + 1) ($ty + 2 + $y) 2 1 $b
        Set-Px $bmp ($tx + 2) ($ty + 2 + $y) $s
      }
      # Slight curl at the tip
      Set-Px $bmp ($tx + 3) ($ty + 13) $b
    }
    'shaved-sides' {
      # Flat top: cap only on the upper 3 rows of the head
      Hair-Common-Cap $bmp ($headX) ($headY - 1) $headW 3
      # Tiny stubble row above the temples
      Set-Px $bmp ($headX - 1) ($headY + 1) $s
      Set-Px $bmp ($headX + $headW) ($headY + 1) $s
    }
    'mullet' {
      # Short on top + long in back
      Hair-Common-Cap $bmp ($headX - 1) ($headY - 1) ($headW + 2) 4
      # Tail falls behind the neck to mid-back
      $mx = $headX + 3
      for ($y = 0; $y -lt 9; $y++) {
        $w = 6 - [int]($y / 3)
        Fill-Rect $bmp $mx ($headY + 5 + $y) $w 1 $b
        Set-Px $bmp ($mx + $w - 1) ($headY + 5 + $y) $s
      }
    }
    'wizard-long' {
      # Cap + drapes past the figure's feet (long beard wouldn't sit
      # in the hair slot, so this is the head hair only)
      Hair-Common-Cap $bmp ($headX - 1) ($headY - 1) ($headW + 2) 6
      for ($y = $headY + 5; $y -le 50; $y++) {
        Set-Px $bmp ($headX - 1) $y $b
        Set-Px $bmp ($headX - 2) $y $s
        Set-Px $bmp ($headX + $headW) $y $b
        Set-Px $bmp ($headX + $headW + 1) $y $s
      }
      # Slight widening at the bottom
      Set-Px $bmp ($headX - 3) 49 $b
      Set-Px $bmp ($headX + $headW + 2) 49 $b
    }
    default {
      Hair-Common-Cap $bmp ($headX - 1) ($headY - 1) ($headW + 2) 5
    }
  }
}

function Build-Hair {
  Write-Host '── Building hair layers ──' -ForegroundColor Cyan
  $count = 0
  foreach ($style in @('short-tousled','long-straight','bun','mohawk','braids',
                        'curly-afro','pixie','ponytail','bald','shaved-sides',
                        'mullet','wizard-long')) {
    $bmp = New-Canvas
    Draw-Hair $bmp $style
    Save-Canvas $bmp (Join-Path $figDir ("hair-{0}.png" -f $style))
    $count++
  }
  Write-Host "  hair styles: $count" -ForegroundColor Green
}

# ── Eye overlays ───────────────────────────────────────────────────
#
# Tiny face-layer pixels. Drawn at z=65 over the body's face. Each
# colour gets its own sprite because palette-swapping a 2-pixel
# overlay is not worth the runtime cost.
#
# Eye position (matches Draw-Body's head geometry):
#   head starts at row 16, height 10
#   eyes sit at rows 20-21, columns 16-17 (left) + 22-23 (right)

function Draw-Eyes {
  param($bmp, $colour)
  $ink = $BRAND.Ink
  # Sclera dot (one pixel of skin-coloured highlight could go here
  # but we want the eye colour to read — so just colour pixels).
  $lex = 16; $rex = 22; $ey = 20
  Fill-Rect $bmp $lex $ey 2 2 $colour
  Fill-Rect $bmp $rex $ey 2 2 $colour
  # Ink the upper row to suggest the eyelid line
  Set-Px $bmp $lex $ey $ink
  Set-Px $bmp ($lex + 1) $ey $ink
  Set-Px $bmp $rex $ey $ink
  Set-Px $bmp ($rex + 1) $ey $ink
}

function Build-Eyes {
  Write-Host '── Building eye layers ──' -ForegroundColor Cyan
  $count = 0
  foreach ($name in $EYE_COLOURS.Keys) {
    $bmp = New-Canvas
    Draw-Eyes $bmp (Color-FromHex $EYE_COLOURS[$name])
    Save-Canvas $bmp (Join-Path $figDir ("eyes-{0}.png" -f $name))
    $count++
  }
  Write-Host "  eye colours: $count" -ForegroundColor Green
}

# ── Accent overlays ────────────────────────────────────────────────
#
# Small cosmetic flair at z=65 over the body's face. Six tiny
# additions — freckles, eye-shadow, face-scar, beauty-mark,
# glasses-round (sits above eyes/below hair fringe), none.

function Draw-Accent-Freckles {
  param($bmp)
  $c = [System.Drawing.Color]::FromArgb(180, 120, 80, 50)
  Set-Px $bmp 17 22 $c
  Set-Px $bmp 19 22 $c
  Set-Px $bmp 22 22 $c
}
function Draw-Accent-EyeShadow {
  param($bmp)
  $c = [System.Drawing.Color]::FromArgb(180, 0x7c, 0x5c, 0xff)
  Fill-Rect $bmp 16 19 2 1 $c
  Fill-Rect $bmp 22 19 2 1 $c
}
function Draw-Accent-FaceScar {
  param($bmp)
  $c = [System.Drawing.Color]::FromArgb(200, 200, 100, 100)
  Set-Px $bmp 22 19 $c
  Set-Px $bmp 22 20 $c
  Set-Px $bmp 22 21 $c
}
function Draw-Accent-BeautyMark {
  param($bmp)
  Set-Px $bmp 18 23 $BRAND.Ink
}
function Draw-Accent-GlassesRound {
  param($bmp)
  # Two small circles + a bridge
  $ink = $BRAND.Ink
  # Left ring
  Set-Px $bmp 15 19 $ink; Set-Px $bmp 18 19 $ink
  Set-Px $bmp 15 22 $ink; Set-Px $bmp 18 22 $ink
  Set-Px $bmp 15 20 $ink; Set-Px $bmp 15 21 $ink
  Set-Px $bmp 18 20 $ink; Set-Px $bmp 18 21 $ink
  # Right ring
  Set-Px $bmp 21 19 $ink; Set-Px $bmp 24 19 $ink
  Set-Px $bmp 21 22 $ink; Set-Px $bmp 24 22 $ink
  Set-Px $bmp 21 20 $ink; Set-Px $bmp 21 21 $ink
  Set-Px $bmp 24 20 $ink; Set-Px $bmp 24 21 $ink
  # Bridge
  Set-Px $bmp 19 20 $ink
  Set-Px $bmp 20 20 $ink
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
    $bmp = New-Canvas
    & $accents[$name].ScriptBlock $bmp
    Save-Canvas $bmp (Join-Path $figDir ("accent-{0}.png" -f $name))
    $count++
  }
  # 'none' = transparent canvas (no drawing). We don't emit a PNG for
  # it; the renderer skips the layer when accent == 'none'.
  Write-Host "  accent flair: $count (none = skipped, no PNG)" -ForegroundColor Green
}

# ══════════════════════════════════════════════════════════════════
#                   GEAR — paper-doll layers
# ══════════════════════════════════════════════════════════════════
#
# Per Clay's "every piece must be its OWN unique custom sprite — no
# reused textures, each one new" directive, no two gear sprites
# share the same pixels. We achieve uniqueness procedurally:
#
#   1. Each catalogue row supplies a stable recipe (slot, name,
#      rarity, weaponType, setName, atk/def).
#   2. A name-hashed RNG drives "knob" choices within the recipe —
#      blade length, hilt curvature, gem position, accent stripe,
#      etc. Same name always produces the same sprite (deterministic
#      regeneration) but different names produce visually distinct
#      results within a shared visual language.
#   3. Rarity escalates detail tiers:
#        common    — flat 2-shade silhouette, muted palette
#        uncommon  — 3 shades + a saturated accent pixel
#        rare      — 4 shades + coloured glint
#        epic      — 5 shades + brand-accent halo
#        legendary — 6+ shades + gem inset (animation comes in Pass 4)
#
# Canvas position is sprite-shape-decides per CHARACTER-SYSTEM-DESIGN
# §4. The figure's right hand sits around (x=28, y=37), so weapons
# anchor their grip there; heads sit over the head footprint (rows
# 6-25); chest pieces cover rows 28-42; legs rows 42-50; boots rows
# 49-55; trinkets either as back-cape (z=10) or front-ornament
# (z=45). The figure-ghost layer is implicit in the procedural
# code — no on-screen overlay is shown; we just know where the body
# is and paint gear to fit.

# ── Deterministic per-piece RNG ────────────────────────────────────
function Get-NameSeed {
  param([string]$name)
  $h = 0
  foreach ($c in $name.ToCharArray()) {
    $h = (($h * 31) -bxor [int][char]$c) -band 0x7fffffff
  }
  return $h
}
function New-NameRng {
  param([string]$name)
  $state = Get-NameSeed $name
  return {
    param([int]$mod)
    $script:_rng_state = ($script:_rng_state * 1103515245 + 12345) -band 0x7fffffff
    if (-not $script:_rng_state) {
      $script:_rng_state = (Get-NameSeed $name) -bor 1
    }
    return ($script:_rng_state % $mod)
  }.GetNewClosure()
}

# Simpler — just keep a stateful counter per name and pull mod-ed
# integers off it. Same idea, lighter syntax.
$script:RNG_STATE = 1
function RngInit { param([string]$name) $script:RNG_STATE = (Get-NameSeed $name) -bor 1 }
function RngPick {
  param([int]$mod)
  $script:RNG_STATE = (($script:RNG_STATE * 1103515245) + 12345) -band 0x7fffffff
  if ($mod -le 1) { return 0 }
  return $script:RNG_STATE % $mod
}
function RngChoice {
  param([array]$arr)
  return $arr[(RngPick $arr.Count)]
}

# ── Rarity palettes ────────────────────────────────────────────────
#
# Each rarity has a "metal" palette (for the weapon's blade /
# armour plate / etc.) and an accent colour that drives the gem,
# glow halo, and outline pop. Pieces within the same rarity share
# this palette but differ in shape/composition.

$RARITY_METAL = @{
  common    = @{ shadow = (Color-FromHex '#3a3f4d'); base = (Color-FromHex '#6a7184'); high = (Color-FromHex '#9aa1b4'); top  = (Color-FromHex '#c0c6d3') };
  uncommon  = @{ shadow = (Color-FromHex '#2a4438'); base = (Color-FromHex '#4d8268'); high = (Color-FromHex '#7cbb9c'); top  = (Color-FromHex '#a8e0c4') };
  rare      = @{ shadow = (Color-FromHex '#163065'); base = (Color-FromHex '#2e5ea8'); high = (Color-FromHex '#5a92e0'); top  = (Color-FromHex '#9bbef0') };
  epic      = @{ shadow = (Color-FromHex '#3a1f7a'); base = (Color-FromHex '#6b3fcf'); high = (Color-FromHex '#9a82ff'); top  = (Color-FromHex '#cbb8ff') };
  legendary = @{ shadow = (Color-FromHex '#7a4a10'); base = (Color-FromHex '#d68a1c'); high = (Color-FromHex '#f3c042'); top  = (Color-FromHex '#fff0a0') };
}

$RARITY_ACCENT = @{
  common    = (Color-FromHex '#a8a8b0');
  uncommon  = (Color-FromHex '#5be098');
  rare      = (Color-FromHex '#6ec0ff');
  epic      = (Color-FromHex '#ff9adb');
  legendary = (Color-FromHex '#fff0a0');
}

# Wood palette for shafts, hilts, bow limbs. Stays consistent
# regardless of rarity — the metal does the colour talking.
$WOOD = @{ shadow = (Color-FromHex '#3d2614'); base = (Color-FromHex '#6b4a2b'); high = (Color-FromHex '#9b7547') }

# Leather palette for grips, straps.
$LEATHER = @{ shadow = (Color-FromHex '#3a2316'); base = (Color-FromHex '#5e3a22'); high = (Color-FromHex '#8a5a36') }

# Rarity-tier "detail richness" — used to skip / include the
# extra-detail pixel passes that distinguish epic/legendary from
# common.
function Detail-Level {
  param([string]$rarity)
  switch ($rarity) {
    'common'    { return 0 }
    'uncommon'  { return 1 }
    'rare'      { return 2 }
    'epic'      { return 3 }
    'legendary' { return 4 }
    default     { return 0 }
  }
}

# ── Weapon archetypes ─────────────────────────────────────────────
#
# All weapons anchor their grip around (x=28..30, y=36..38). Blade /
# bowhead / etc. extends UP from there. Pommel / butt extends DOWN.
# Polearms and staves extend further up into the headroom.
#
# Each archetype function takes (bmp, name, rarity) and uses
# RngInit/RngPick to derive its per-piece knob choices from the
# name — so "Wooden Sword" and "Bronze Shortsword" produce two
# different swords sharing the common-rarity palette + general
# silhouette but no two pixels identical.

function Draw-Weapon-Sword {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity
  $ink = $BRAND.Ink

  # Knobs
  $bladeLen   = 14 + (RngPick 8)         # 14..21 px
  $bladeWidth = 2 + (RngPick 2)          # 2 or 3 px
  $crossguard = 4 + (RngPick 3)          # 4..6 px wide
  $hiltLen    = 3 + (RngPick 2)          # 3..4 px grip
  $pommel     = (RngPick 4)              # 0=ball, 1=wedge, 2=star, 3=disc

  $gx = 29                                # grip centre column
  $gripBottomY = 39 + (RngPick 2)        # 39..40 — slight variation
  $cgY = $gripBottomY - $hiltLen          # crossguard sits above grip
  $bladeBottom = $cgY - 1
  $bladeTop    = $bladeBottom - $bladeLen

  # Blade
  $halfBW = [int]($bladeWidth / 2)
  for ($y = $bladeTop; $y -le $bladeBottom; $y++) {
    # Slight taper near the tip
    $w = $bladeWidth - $(if (($y - $bladeTop) -lt 2) { 1 } else { 0 })
    if ($w -lt 1) { $w = 1 }
    $x0 = $gx - [int]($w / 2)
    Fill-Rect $bmp $x0 $y $w 1 $metal.base
    if ($w -ge 2) {
      Set-Px $bmp $x0 $y $metal.shadow
      Set-Px $bmp ($x0 + $w - 1) $y $metal.high
    }
  }
  # Tip highlight
  Set-Px $bmp $gx $bladeTop $metal.top

  # Detail: blade etching/runes for rare+
  if ($detail -ge 2 -and $bladeLen -ge 12) {
    $accent = $RARITY_ACCENT[$rarity]
    Set-Px $bmp $gx ($bladeTop + 4) $accent
    Set-Px $bmp $gx ($bladeTop + 8) $accent
  }
  # Glow halo for epic/legendary
  if ($detail -ge 3) {
    $glow = [System.Drawing.Color]::FromArgb(120, $RARITY_ACCENT[$rarity].R, $RARITY_ACCENT[$rarity].G, $RARITY_ACCENT[$rarity].B)
    for ($y = $bladeTop; $y -le $bladeBottom; $y++) {
      Set-Px $bmp ($gx - 2) $y $glow
      Set-Px $bmp ($gx + 2) $y $glow
    }
  }

  # Crossguard — horizontal bar
  $cgX = $gx - [int]($crossguard / 2)
  Fill-Rect $bmp $cgX $cgY $crossguard 1 $metal.base
  Fill-Rect $bmp $cgX ($cgY + 1) $crossguard 1 $metal.shadow
  # Decorative crossguard tips for rare+
  if ($detail -ge 2) {
    Set-Px $bmp $cgX $cgY $metal.top
    Set-Px $bmp ($cgX + $crossguard - 1) $cgY $metal.top
  }

  # Grip — leather wrap
  for ($y = ($cgY + 2); $y -le $gripBottomY; $y++) {
    Set-Px $bmp ($gx - 1) $y $LEATHER.shadow
    Set-Px $bmp $gx $y $LEATHER.base
    Set-Px $bmp ($gx + 1) $y $LEATHER.high
  }

  # Pommel
  $py = $gripBottomY + 1
  switch ($pommel) {
    0 {  # ball
      Fill-Rect $bmp ($gx - 1) $py 3 2 $metal.base
      Set-Px $bmp ($gx - 1) $py $metal.shadow
      Set-Px $bmp ($gx + 1) ($py + 1) $metal.shadow
      Set-Px $bmp $gx $py $metal.high
    }
    1 {  # wedge
      Set-Px $bmp $gx $py $metal.base
      Fill-Rect $bmp ($gx - 1) ($py + 1) 3 1 $metal.base
      Set-Px $bmp ($gx - 1) ($py + 1) $metal.shadow
      Set-Px $bmp ($gx + 1) ($py + 1) $metal.shadow
    }
    2 {  # star — rare+
      if ($detail -ge 2) {
        $accent = $RARITY_ACCENT[$rarity]
        Fill-Rect $bmp ($gx - 1) $py 3 1 $metal.base
        Set-Px $bmp $gx ($py + 1) $accent
      } else {
        Fill-Rect $bmp ($gx - 1) $py 3 1 $metal.base
      }
    }
    3 {  # disc
      Fill-Rect $bmp ($gx - 1) $py 3 1 $metal.base
      Set-Px $bmp $gx $py $metal.high
    }
  }
}

function Draw-Weapon-Axe {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $gx = 29
  $gripBottomY = 41
  $shaftLen   = 18 + (RngPick 4)         # 18..21
  $headSize   = 4 + (RngPick 2)          # 4..5
  $headFlare  = (RngPick 2)              # 0=normal, 1=flared
  $shaftTop   = $gripBottomY - $shaftLen

  # Shaft — wooden, vertical
  for ($y = $shaftTop; $y -le $gripBottomY; $y++) {
    Set-Px $bmp ($gx - 1) $y $WOOD.shadow
    Set-Px $bmp $gx       $y $WOOD.base
    Set-Px $bmp ($gx + 1) $y $WOOD.high
  }

  # Axe head — sits at the top right of the shaft
  $hx = $gx + 1
  $hy = $shaftTop
  Fill-Rect $bmp $hx $hy $headSize 4 $metal.base
  Stroke-Rect $bmp $hx $hy $headSize 4 $metal.shadow
  # Edge highlight on the cutting edge (right side)
  for ($y = 0; $y -lt 4; $y++) {
    Set-Px $bmp ($hx + $headSize - 1) ($hy + $y) $metal.top
  }
  # Flared blade extension
  if ($headFlare -eq 1) {
    Set-Px $bmp ($hx + $headSize) ($hy + 1) $metal.base
    Set-Px $bmp ($hx + $headSize) ($hy + 2) $metal.base
    Set-Px $bmp ($hx + $headSize) ($hy + 1) $metal.high
  }
  # Spike on top (uncommon+)
  if ($detail -ge 1) {
    Set-Px $bmp $hx ($hy - 1) $metal.base
    Set-Px $bmp ($hx + 1) ($hy - 1) $metal.shadow
  }
  # Rune accent on the blade (rare+)
  if ($detail -ge 2) {
    Set-Px $bmp ($hx + 1) ($hy + 2) $RARITY_ACCENT[$rarity]
  }
  # Halo (epic+)
  if ($detail -ge 3) {
    $glow = [System.Drawing.Color]::FromArgb(120, $RARITY_ACCENT[$rarity].R, $RARITY_ACCENT[$rarity].G, $RARITY_ACCENT[$rarity].B)
    Set-Px $bmp ($hx - 1) $hy $glow
    Set-Px $bmp ($hx + $headSize) ($hy + 4) $glow
  }

  # Pommel knob
  Set-Px $bmp $gx ($gripBottomY + 1) $metal.base
}

function Draw-Weapon-Hammer {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $gx = 29
  $gripBottomY = 41
  $shaftLen   = 18 + (RngPick 3)
  $headW      = 5 + (RngPick 2)          # 5..6
  $headH      = 4 + (RngPick 1)
  $shaftTop   = $gripBottomY - $shaftLen

  # Shaft
  for ($y = $shaftTop; $y -le $gripBottomY; $y++) {
    Set-Px $bmp ($gx - 1) $y $WOOD.shadow
    Set-Px $bmp $gx       $y $WOOD.base
    Set-Px $bmp ($gx + 1) $y $WOOD.high
  }

  # Head — heavy block sitting on top of the shaft
  $hx = $gx - [int]($headW / 2)
  $hy = $shaftTop - $headH + 1
  Fill-Rect $bmp $hx $hy $headW $headH $metal.base
  Stroke-Rect $bmp $hx $hy $headW $headH $metal.shadow
  # Highlight strip across the top
  for ($x = 0; $x -lt $headW; $x++) {
    Set-Px $bmp ($hx + $x) $hy $metal.high
  }
  # Studs on the head (uncommon+)
  if ($detail -ge 1) {
    Set-Px $bmp ($hx + 1) ($hy + 1) $metal.top
    Set-Px $bmp ($hx + $headW - 2) ($hy + 1) $metal.top
  }
  # Rune accent on the side (rare+)
  if ($detail -ge 2) {
    Set-Px $bmp ($hx + [int]($headW / 2)) ($hy + [int]($headH / 2)) $RARITY_ACCENT[$rarity]
  }
  # Halo (epic+)
  if ($detail -ge 3) {
    $glow = [System.Drawing.Color]::FromArgb(110, $RARITY_ACCENT[$rarity].R, $RARITY_ACCENT[$rarity].G, $RARITY_ACCENT[$rarity].B)
    Fill-Rect $bmp ($hx - 1) ($hy + 1) 1 ($headH - 1) $glow
    Fill-Rect $bmp ($hx + $headW) ($hy + 1) 1 ($headH - 1) $glow
  }
}

function Draw-Weapon-Dagger {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $gx = 29
  $gripBottomY = 40
  $bladeLen = 7 + (RngPick 4)            # 7..10 (short)
  $cgY = $gripBottomY - 3
  $bladeBottom = $cgY - 1
  $bladeTop    = $bladeBottom - $bladeLen

  # Single-line blade with thin taper
  for ($y = $bladeTop; $y -le $bladeBottom; $y++) {
    $w = if ($y -le $bladeTop + 1) { 1 } else { 2 }
    Fill-Rect $bmp ($gx - [int]($w / 2)) $y $w 1 $metal.base
    if ($w -ge 2) {
      Set-Px $bmp ($gx - 1) $y $metal.shadow
      Set-Px $bmp $gx $y $metal.high
    }
  }
  Set-Px $bmp $gx $bladeTop $metal.top

  # Crossguard — small horizontal
  Fill-Rect $bmp ($gx - 1) $cgY 3 1 $metal.base
  Set-Px $bmp $gx $cgY $metal.high

  # Grip
  for ($y = ($cgY + 1); $y -le $gripBottomY; $y++) {
    Set-Px $bmp ($gx - 1) $y $LEATHER.shadow
    Set-Px $bmp $gx $y $LEATHER.base
  }

  # Pommel — gem-cap on rare+
  if ($detail -ge 2) {
    Set-Px $bmp $gx ($gripBottomY + 1) $RARITY_ACCENT[$rarity]
  } else {
    Set-Px $bmp $gx ($gripBottomY + 1) $metal.base
  }
  # Halo on epic+
  if ($detail -ge 3) {
    $glow = [System.Drawing.Color]::FromArgb(110, $RARITY_ACCENT[$rarity].R, $RARITY_ACCENT[$rarity].G, $RARITY_ACCENT[$rarity].B)
    Set-Px $bmp ($gx - 1) ($bladeTop + 2) $glow
    Set-Px $bmp ($gx + 1) ($bladeTop + 2) $glow
  }
}

function Draw-Weapon-Bow {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $gx = 29
  $gripY = 38
  $bowH = 18 + (RngPick 4)               # 18..21 — total bow height
  $curve = 2 + (RngPick 2)               # how far the limbs curve out

  $topY = $gripY - [int]($bowH / 2)
  $botY = $gripY + [int]($bowH / 2)

  # Upper limb — gentle outward curve
  for ($i = 0; $i -lt [int]($bowH / 2); $i++) {
    $y = $gripY - $i
    $offset = if ($i -lt 2) { 0 } elseif ($i -lt 5) { 1 } elseif ($i -lt ([int]($bowH / 2) - 2)) { $curve } else { [int]($curve / 2) }
    Set-Px $bmp ($gx - $offset) $y $WOOD.base
    Set-Px $bmp ($gx - $offset - 1) $y $WOOD.shadow
    Set-Px $bmp ($gx - $offset + 1) $y $WOOD.high
  }
  # Lower limb — mirrored
  for ($i = 0; $i -lt [int]($bowH / 2); $i++) {
    $y = $gripY + $i + 1
    $offset = if ($i -lt 2) { 0 } elseif ($i -lt 5) { 1 } elseif ($i -lt ([int]($bowH / 2) - 2)) { $curve } else { [int]($curve / 2) }
    Set-Px $bmp ($gx - $offset) $y $WOOD.base
    Set-Px $bmp ($gx - $offset - 1) $y $WOOD.shadow
    Set-Px $bmp ($gx - $offset + 1) $y $WOOD.high
  }
  # Bowstring — straight vertical line on the inside (right of the limbs)
  $stringCol = if ($detail -ge 3) { $RARITY_ACCENT[$rarity] } else { $metal.high }
  for ($y = $topY + 1; $y -le ($botY - 1); $y++) {
    Set-Px $bmp ($gx + 1) $y $stringCol
  }
  # Tip caps for uncommon+
  if ($detail -ge 1) {
    Set-Px $bmp ($gx - [int]($curve / 2)) $topY $metal.base
    Set-Px $bmp ($gx - [int]($curve / 2)) $botY $metal.base
  }
  # Grip wrap
  Fill-Rect $bmp $gx ($gripY - 1) 1 3 $LEATHER.base
}

function Draw-Weapon-Crossbow {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $gx = 29
  $gripY = 38

  # Stock — vertical wooden block
  Fill-Rect $bmp ($gx - 1) ($gripY - 2) 3 8 $WOOD.base
  Stroke-Rect $bmp ($gx - 1) ($gripY - 2) 3 8 $WOOD.shadow
  Set-Px $bmp $gx ($gripY - 1) $WOOD.high

  # Limbs — horizontal arc at the top
  $limbY = $gripY - 4
  for ($x = -5; $x -le 5; $x++) {
    $y = $limbY + [int](($x * $x) / 12)
    Set-Px $bmp ($gx + $x) $y $WOOD.base
    Set-Px $bmp ($gx + $x) ($y - 1) $WOOD.shadow
  }
  # String stretched across the limbs
  $stringColCB = $(if ($detail -ge 3) { $RARITY_ACCENT[$rarity] } else { $metal.high })
  for ($x = -5; $x -le 5; $x++) {
    Set-Px $bmp ($gx + $x) ($limbY + 2) $stringColCB
  }
  # Bolt
  for ($y = ($limbY - 1); $y -le ($gripY); $y++) {
    Set-Px $bmp $gx $y $metal.base
  }
  Set-Px $bmp $gx ($limbY - 1) $metal.top
  # Rune accent (rare+)
  if ($detail -ge 2) {
    Set-Px $bmp $gx ($gripY + 2) $RARITY_ACCENT[$rarity]
  }
}

function Draw-Weapon-Wand {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $gx = 29
  $gripBottomY = 40
  $wandLen = 10 + (RngPick 4)            # short
  $tipShape = (RngPick 3)                # 0=crystal, 1=ball, 2=star

  $top = $gripBottomY - $wandLen

  # Wand body — slim wooden rod
  for ($y = ($top + 2); $y -le $gripBottomY; $y++) {
    Set-Px $bmp $gx $y $WOOD.base
    Set-Px $bmp ($gx - 1) $y $WOOD.shadow
  }
  # Tip
  $accent = $RARITY_ACCENT[$rarity]
  switch ($tipShape) {
    0 {  # crystal — 4 pixels
      Set-Px $bmp $gx $top $accent
      Set-Px $bmp ($gx - 1) ($top + 1) $accent
      Set-Px $bmp ($gx + 1) ($top + 1) $accent
      Set-Px $bmp $gx ($top + 2) $accent
    }
    1 {  # ball
      Fill-Rect $bmp ($gx - 1) $top 3 2 $accent
      Set-Px $bmp $gx $top $RARITY_METAL[$rarity].top
    }
    2 {  # star
      Set-Px $bmp $gx $top $accent
      Set-Px $bmp ($gx - 1) ($top + 1) $accent
      Set-Px $bmp ($gx + 1) ($top + 1) $accent
      Set-Px $bmp $gx ($top + 2) $accent
      Set-Px $bmp ($gx - 2) ($top + 1) $accent
      Set-Px $bmp ($gx + 2) ($top + 1) $accent
    }
  }
  # Halo (rare+)
  if ($detail -ge 2) {
    $glow = [System.Drawing.Color]::FromArgb(140, $accent.R, $accent.G, $accent.B)
    Set-Px $bmp ($gx - 2) ($top + 2) $glow
    Set-Px $bmp ($gx + 2) ($top + 2) $glow
  }
}

function Draw-Weapon-Staff {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $gx = 29
  $gripBottomY = 42
  $staffLen = 24 + (RngPick 4)           # long — extends into headroom
  $headShape = (RngPick 3)               # 0=orb, 1=ring, 2=horns
  $top = $gripBottomY - $staffLen

  # Shaft
  for ($y = ($top + 3); $y -le $gripBottomY; $y++) {
    Set-Px $bmp ($gx - 1) $y $WOOD.shadow
    Set-Px $bmp $gx $y $WOOD.base
    Set-Px $bmp ($gx + 1) $y $WOOD.high
  }
  $accent = $RARITY_ACCENT[$rarity]
  switch ($headShape) {
    0 {  # orb on top
      Fill-Rect $bmp ($gx - 1) $top 3 3 $accent
      Set-Px $bmp $gx $top $metal.top
      Set-Px $bmp ($gx - 1) ($top + 2) $metal.shadow
    }
    1 {  # ring — empty center
      Stroke-Rect $bmp ($gx - 1) $top 3 3 $accent
      if ($detail -ge 2) {
        Set-Px $bmp $gx ($top + 1) $metal.top
      }
    }
    2 {  # horns
      Set-Px $bmp ($gx - 1) $top $WOOD.base
      Set-Px $bmp ($gx - 2) ($top + 1) $WOOD.base
      Set-Px $bmp ($gx + 1) $top $WOOD.base
      Set-Px $bmp ($gx + 2) ($top + 1) $WOOD.base
      Set-Px $bmp $gx ($top + 2) $accent
    }
  }
  # Glow (epic+)
  if ($detail -ge 3) {
    $glow = [System.Drawing.Color]::FromArgb(120, $accent.R, $accent.G, $accent.B)
    Set-Px $bmp ($gx - 2) ($top + 1) $glow
    Set-Px $bmp ($gx + 2) ($top + 1) $glow
  }
  # Grip wrap
  for ($y = 0; $y -lt 3; $y++) {
    Set-Px $bmp $gx ($gripBottomY - 4 + $y) $LEATHER.base
  }
}

function Draw-Weapon-Orb {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $gx = 30
  $gy = 36
  $r = 3 + (RngPick 2)                   # 3..4 radius
  $accent = $RARITY_ACCENT[$rarity]

  # Sphere — concentric rings
  for ($dy = -$r; $dy -le $r; $dy++) {
    for ($dx = -$r; $dx -le $r; $dx++) {
      $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
      if ($d -gt $r + 0.3) { continue }
      $col = $accent
      if ($d -gt ($r - 0.7)) { $col = $metal.shadow }
      elseif ($d -lt 0.7)    { $col = $metal.top }
      elseif ($dx -lt 0 -and $dy -lt 0) { $col = $RARITY_METAL[$rarity].high }
      Set-Px $bmp ($gx + $dx) ($gy + $dy) $col
    }
  }
  # Glint
  Set-Px $bmp ($gx - 1) ($gy - 1) $metal.top
  # Aura (rare+)
  if ($detail -ge 2) {
    $glow = [System.Drawing.Color]::FromArgb(100, $accent.R, $accent.G, $accent.B)
    Fill-Rect $bmp ($gx - $r - 1) ($gy - $r - 1) 1 (2 * $r + 3) $glow
    Fill-Rect $bmp ($gx + $r + 1) ($gy - $r - 1) 1 (2 * $r + 3) $glow
  }
}

function Draw-Weapon-Tome {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $gx = 28
  $gy = 34
  $w = 6 + (RngPick 2)
  $h = 8 + (RngPick 2)
  $accent = $RARITY_ACCENT[$rarity]

  # Book body
  Fill-Rect $bmp $gx $gy $w $h $metal.base
  Stroke-Rect $bmp $gx $gy $w $h $metal.shadow
  # Spine highlight on the left
  for ($y = 0; $y -lt $h; $y++) {
    Set-Px $bmp $gx ($gy + $y) $metal.high
  }
  # Pages — thin band on the right edge
  for ($y = 1; $y -lt ($h - 1); $y++) {
    Set-Px $bmp ($gx + $w - 1) ($gy + $y) (Color-FromHex '#f4e9d4')
  }
  # Cover ornament — single accent pixel cluster
  $oy = $gy + [int]($h / 2) - 1
  $ox = $gx + [int]($w / 2)
  Set-Px $bmp $ox $oy $accent
  if ($detail -ge 1) {
    Set-Px $bmp ($ox - 1) $oy $metal.top
    Set-Px $bmp ($ox + 1) $oy $metal.top
  }
  if ($detail -ge 2) {
    Set-Px $bmp $ox ($oy - 1) $accent
    Set-Px $bmp $ox ($oy + 1) $accent
  }
  # Glow (epic+)
  if ($detail -ge 3) {
    $glow = [System.Drawing.Color]::FromArgb(110, $accent.R, $accent.G, $accent.B)
    Set-Px $bmp ($gx - 1) ($gy + 2) $glow
    Set-Px $bmp ($gx + $w) ($gy + 2) $glow
  }
}

function Draw-Weapon-Holy {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $gx = 29
  $gy = 34
  $h = 8 + (RngPick 2)                   # cross height
  $arm = 3 + (RngPick 2)                 # crossbar half-width
  $accent = $RARITY_ACCENT[$rarity]

  # Vertical bar
  for ($y = 0; $y -lt $h; $y++) {
    Set-Px $bmp ($gx - 1) ($gy + $y) $metal.shadow
    Set-Px $bmp $gx ($gy + $y) $metal.base
    Set-Px $bmp ($gx + 1) ($gy + $y) $metal.high
  }
  # Crossbar
  $cy = $gy + 2
  for ($x = -$arm; $x -le $arm; $x++) {
    Set-Px $bmp ($gx + $x) $cy $metal.base
    Set-Px $bmp ($gx + $x) ($cy + 1) $metal.shadow
  }
  Set-Px $bmp ($gx - $arm) $cy $metal.top
  Set-Px $bmp ($gx + $arm) $cy $metal.top
  # Centre gem (rare+)
  if ($detail -ge 2) {
    Set-Px $bmp $gx $cy $accent
  }
  # Halo (epic+)
  if ($detail -ge 3) {
    $glow = [System.Drawing.Color]::FromArgb(120, $accent.R, $accent.G, $accent.B)
    Set-Px $bmp ($gx - $arm - 1) $cy $glow
    Set-Px $bmp ($gx + $arm + 1) $cy $glow
    Set-Px $bmp $gx ($gy - 1) $glow
  }
}

function Draw-Weapon-Sling {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  # Slings stay simple — common-only territory.
  $gx = 29; $gy = 36
  # Strap loop hanging
  for ($y = $gy - 4; $y -le $gy + 6; $y++) {
    Set-Px $bmp $gx $y $LEATHER.base
    if ($y -le ($gy + 1)) { Set-Px $bmp ($gx - 1) $y $LEATHER.shadow }
  }
  # Stone pouch at the bottom
  Fill-Rect $bmp ($gx - 1) ($gy + 6) 3 2 $LEATHER.shadow
  Set-Px $bmp $gx ($gy + 6) $LEATHER.high
  # Stone (uncommon+)
  if ((Detail-Level $rarity) -ge 1) {
    Set-Px $bmp $gx ($gy + 7) (Color-FromHex '#a8a8b0')
  }
}

function Draw-Weapon-Polearm {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $gx = 29
  $gripBottomY = 42
  $shaftLen = 28 + (RngPick 3)           # very long
  $headStyle = (RngPick 3)               # 0=halberd, 1=spear, 2=glaive
  $top = $gripBottomY - $shaftLen

  # Shaft
  for ($y = ($top + 4); $y -le $gripBottomY; $y++) {
    Set-Px $bmp ($gx - 1) $y $WOOD.shadow
    Set-Px $bmp $gx $y $WOOD.base
    Set-Px $bmp ($gx + 1) $y $WOOD.high
  }
  switch ($headStyle) {
    0 {  # halberd — axe blade + spike
      Fill-Rect $bmp ($gx + 1) $top 3 3 $metal.base
      Set-Px $bmp ($gx + 3) ($top + 1) $metal.top
      Stroke-Rect $bmp ($gx + 1) $top 3 3 $metal.shadow
      Set-Px $bmp $gx ($top + 1) $metal.base
      Set-Px $bmp $gx $top $metal.high
    }
    1 {  # spear — narrow point
      Set-Px $bmp $gx $top $metal.top
      Set-Px $bmp $gx ($top + 1) $metal.base
      Set-Px $bmp $gx ($top + 2) $metal.base
      Set-Px $bmp $gx ($top + 3) $metal.base
      Set-Px $bmp ($gx - 1) ($top + 2) $metal.shadow
      Set-Px $bmp ($gx + 1) ($top + 2) $metal.shadow
    }
    2 {  # glaive — curved blade
      for ($y = 0; $y -lt 5; $y++) {
        Set-Px $bmp ($gx + 1 + [int]($y / 2)) ($top + $y) $metal.base
        Set-Px $bmp $gx ($top + $y) $metal.shadow
      }
      Set-Px $bmp ($gx + 2) ($top + 1) $metal.top
    }
  }
  # Rune (rare+)
  if ($detail -ge 2) {
    Set-Px $bmp $gx ($top + 5) $RARITY_ACCENT[$rarity]
  }
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

# Helper: derive a spriteId slug from a piece name.
function Slugify {
  param([string]$s)
  return ($s.ToLower() -replace "['’]", '' -replace '[^a-z0-9]+', '-' -replace '^-|-$', '')
}

# ── Catalogue parser ─────────────────────────────────────────────
#
# We don't ship a Node↔Pwsh bridge — instead, the catalogue is
# parsed directly from dungeon.js by grep-style regex over the
# SHOP_POOL array literal. The array format is rigid (single-line
# entries with consistent commas) so this works reliably.

function Read-Catalogue {
  param([string]$repoRoot)
  $dungeonPath = Join-Path $repoRoot 'discord-bot/dungeon.js'
  $clashPath   = Join-Path $repoRoot 'discord-bot/clash-content.js'
  $catalogue = @()

  # SHOP_POOL row shape:
  #   ['slot', 'rarity', 'name', 'glyph', atk, def, gold, 'setName', 'weaponType', 'preferredClass', 'ability']
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
  # Voltaic from clash-content.js — same row shape
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

function Build-Weapons {
  param([string]$repoRoot)
  Write-Host '── Building weapon gear sprites ──' -ForegroundColor Cyan
  $catalogue = Read-Catalogue -repoRoot $repoRoot
  $weapons = $catalogue | Where-Object { $_.slot -eq 'weapon' }
  $count = 0
  foreach ($p in $weapons) {
    $bmp = New-Canvas
    Draw-Weapon $bmp $p.weaponType $p.name $p.rarity
    $slug = Slugify $p.name
    Save-Canvas $bmp (Join-Path $gearDir ("weapon/{0}.png" -f $slug))
    $count++
  }
  Write-Host "  weapons: $count" -ForegroundColor Green
}

# ── Head archetypes ──────────────────────────────────────────────
# Head footprint: rows 16-25, x=14-25 (approx). Helmet/hat extends
# UP into rows 0-15 for plumes and tall crowns. The hair sits at
# z=60 and head at z=70, so the head sprite intentionally COVERS
# the upper part of the head where it should obscure hair.

function Draw-Head-Helmet {
  # Full enclosed helmet: dome + visor + neck guard
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity

  $hx = 14; $hy = 14; $hw = 12; $hh = 12
  $plume = (RngPick 4)        # 0=none, 1=spike, 2=fin, 3=crown
  $visor = (RngPick 3)        # 0=full, 1=t-slit, 2=open
  # Dome
  Fill-Rect $bmp $hx $hy $hw $hh $metal.base
  Stroke-Rect $bmp $hx $hy $hw $hh $metal.shadow
  # Highlights along the top-left
  for ($x = 0; $x -lt 4; $x++) {
    Set-Px $bmp ($hx + 1 + $x) ($hy + 1) $metal.high
  }
  Set-Px $bmp ($hx + 1) ($hy + 2) $metal.top
  # Visor band
  switch ($visor) {
    0 {  # full visor — horizontal slit
      Fill-Rect $bmp $hx ($hy + 5) $hw 2 $metal.shadow
      Fill-Rect $bmp ($hx + 2) ($hy + 6) ($hw - 4) 1 $BRAND.Ink
    }
    1 {  # T-slit
      Fill-Rect $bmp $hx ($hy + 5) $hw 2 $metal.shadow
      Set-Px $bmp ($hx + 5) ($hy + 5) $BRAND.Ink
      Set-Px $bmp ($hx + 6) ($hy + 5) $BRAND.Ink
      Set-Px $bmp ($hx + 5) ($hy + 6) $BRAND.Ink
      Set-Px $bmp ($hx + 6) ($hy + 6) $BRAND.Ink
      Set-Px $bmp ($hx + 5) ($hy + 7) $BRAND.Ink
      Set-Px $bmp ($hx + 6) ($hy + 7) $BRAND.Ink
    }
    2 {  # open-face — show eyes
      Fill-Rect $bmp ($hx + 1) ($hy + 5) 4 2 $BRAND.Ink
      Fill-Rect $bmp ($hx + 7) ($hy + 5) 4 2 $BRAND.Ink
    }
  }
  # Cheek guards extending down
  Fill-Rect $bmp $hx ($hy + $hh - 1) 1 2 $metal.shadow
  Fill-Rect $bmp ($hx + $hw - 1) ($hy + $hh - 1) 1 2 $metal.shadow
  # Plume / crown on top
  $accent = $RARITY_ACCENT[$rarity]
  switch ($plume) {
    1 {  # spike
      for ($y = 0; $y -lt 6; $y++) {
        Set-Px $bmp ($hx + [int]($hw / 2)) ($hy - 1 - $y) $metal.base
      }
      Set-Px $bmp ($hx + [int]($hw / 2)) ($hy - 7) $metal.top
    }
    2 {  # fin (plume swept back)
      for ($y = 0; $y -lt 5; $y++) {
        Fill-Rect $bmp ($hx + [int]($hw / 2) + $y) ($hy - 4 - $y) 1 4 $accent
      }
    }
    3 {  # crown — jagged top
      for ($x = 0; $x -lt $hw; $x += 2) {
        Set-Px $bmp ($hx + $x) ($hy - 1) $metal.high
        Set-Px $bmp ($hx + $x) ($hy - 2) $metal.base
      }
    }
    default { }
  }
  # Rune accent on the forehead (rare+)
  if ($detail -ge 2) {
    Set-Px $bmp ($hx + [int]($hw / 2)) ($hy + 3) $accent
  }
  # Halo (epic+)
  if ($detail -ge 3) {
    $glow = [System.Drawing.Color]::FromArgb(120, $accent.R, $accent.G, $accent.B)
    for ($x = -1; $x -le $hw; $x++) {
      Set-Px $bmp ($hx + $x) ($hy - 1) $glow
    }
  }
}

function Draw-Head-Cap {
  # Soft fabric cap or hat — rounded silhouette
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $detail = Detail-Level $rarity
  $cx = 20; $cy = 14
  $shape = (RngPick 3)             # 0=skullcap, 1=wide-brim, 2=pointy

  $base = (Color-FromHex '#6b4a2b')
  $shadow = (Color-FromHex '#3d2614')
  $high = (Color-FromHex '#9b7547')
  # Rarity recolour for higher tiers
  if ($detail -ge 2) {
    $base   = $RARITY_METAL[$rarity].base
    $shadow = $RARITY_METAL[$rarity].shadow
    $high   = $RARITY_METAL[$rarity].high
  }
  $accent = $RARITY_ACCENT[$rarity]

  switch ($shape) {
    0 {  # skullcap
      Fill-Rect $bmp ($cx - 6) ($cy + 1) 12 3 $base
      Stroke-Rect $bmp ($cx - 6) ($cy + 1) 12 3 $shadow
      Fill-Rect $bmp ($cx - 4) ($cy - 1) 8 2 $base
      Set-Px $bmp ($cx - 3) ($cy) $high
      # Band (rare+)
      if ($detail -ge 2) {
        Fill-Rect $bmp ($cx - 6) ($cy + 4) 12 1 $accent
      }
    }
    1 {  # wide-brim
      # Wide brim
      Fill-Rect $bmp ($cx - 7) ($cy + 4) 14 1 $shadow
      Fill-Rect $bmp ($cx - 6) ($cy + 3) 12 1 $base
      # Crown
      Fill-Rect $bmp ($cx - 3) $cy 6 3 $base
      Stroke-Rect $bmp ($cx - 3) $cy 6 3 $shadow
      Set-Px $bmp ($cx - 2) ($cy + 1) $high
      # Hat band
      if ($detail -ge 1) {
        Fill-Rect $bmp ($cx - 3) ($cy + 2) 6 1 $accent
      }
    }
    2 {  # pointy (wizard hat / hood)
      # Cone
      for ($y = 0; $y -lt 8; $y++) {
        $w = $y + 1
        $x0 = $cx - [int]($w / 2)
        Fill-Rect $bmp $x0 ($cy + 4 - $y) $w 1 $base
        Set-Px $bmp $x0 ($cy + 4 - $y) $shadow
      }
      # Tip
      Set-Px $bmp $cx ($cy - 4) $high
      if ($detail -ge 2) {
        Set-Px $bmp $cx ($cy - 4) $accent
      }
      # Brim
      Fill-Rect $bmp ($cx - 4) ($cy + 5) 8 1 $shadow
    }
  }
}

function Draw-Head {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  # Choose archetype based on name keywords + name hash
  $lower = $name.ToLower()
  if ($lower -match 'helm|coif|sallet|barbute|visor|drak|ironclad') {
    Draw-Head-Helmet $bmp $name $rarity
  } elseif ($lower -match 'cap|hat|hood|wayfarer|circlet|crown|tiara') {
    Draw-Head-Cap $bmp $name $rarity
  } else {
    # Default — pick by hash
    if ((RngPick 2) -eq 0) { Draw-Head-Helmet $bmp $name $rarity }
    else                   { Draw-Head-Cap    $bmp $name $rarity }
  }
}

# ── Chest archetypes ─────────────────────────────────────────────
# Chest covers the torso (rows ~28-42). Width covers both slim and
# stocky body widths because we centre the chest sprite over the
# average mid-point. character.js applies a 1-px squash on slim
# bodies if needed; commits are pixel-exact for stocky.

function Draw-Chest {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity
  $accent = $RARITY_ACCENT[$rarity]

  $cx = 20
  $top = 28
  $bot = 42
  $w = 14
  $variant = (RngPick 3)         # 0=plate, 1=robe, 2=tunic
  $lower = $name.ToLower()
  if ($lower -match 'plate|mail|chain|hauberk|ironclad|cuirass') { $variant = 0 }
  elseif ($lower -match 'robe|vestment|drape|cloth') { $variant = 1 }

  switch ($variant) {
    0 {  # plate
      $hx = $cx - [int]($w / 2)
      Fill-Rect $bmp $hx $top $w ($bot - $top) $metal.base
      Stroke-Rect $bmp $hx $top $w ($bot - $top) $metal.shadow
      # Top highlight
      for ($x = 0; $x -lt 6; $x++) {
        Set-Px $bmp ($hx + 1 + $x) ($top + 1) $metal.high
      }
      # Pectoral seam
      Fill-Rect $bmp ($hx + [int]($w / 2)) $top 1 ($bot - $top) $metal.shadow
      # Rivets / studs
      Set-Px $bmp ($hx + 2) ($top + 3) $metal.top
      Set-Px $bmp ($hx + $w - 3) ($top + 3) $metal.top
      Set-Px $bmp ($hx + 2) ($bot - 3) $metal.top
      Set-Px $bmp ($hx + $w - 3) ($bot - 3) $metal.top
      # Crest accent (rare+)
      if ($detail -ge 2) {
        Set-Px $bmp ($hx + [int]($w / 2)) ($top + 4) $accent
        Set-Px $bmp ($hx + [int]($w / 2)) ($top + 5) $accent
      }
      # Halo (epic+)
      if ($detail -ge 3) {
        $glow = [System.Drawing.Color]::FromArgb(110, $accent.R, $accent.G, $accent.B)
        Fill-Rect $bmp ($hx - 1) $top 1 ($bot - $top) $glow
        Fill-Rect $bmp ($hx + $w) $top 1 ($bot - $top) $glow
      }
    }
    1 {  # robe
      # Flares slightly toward the bottom
      for ($y = $top; $y -lt $bot; $y++) {
        $rowW = $w + [int](($y - $top) / 5)
        $rowX = $cx - [int]($rowW / 2)
        Fill-Rect $bmp $rowX $y $rowW 1 $metal.base
        Set-Px $bmp $rowX $y $metal.shadow
        Set-Px $bmp ($rowX + $rowW - 1) $y $metal.shadow
      }
      # Sash
      Fill-Rect $bmp ($cx - 6) ($top + 6) 12 1 $accent
      # Trim (rare+)
      if ($detail -ge 2) {
        Fill-Rect $bmp ($cx - 7) ($bot - 1) 14 1 $metal.top
      }
      # Glow (epic+)
      if ($detail -ge 3) {
        $glow = [System.Drawing.Color]::FromArgb(100, $accent.R, $accent.G, $accent.B)
        Set-Px $bmp ($cx - 7) ($top + 7) $glow
        Set-Px $bmp ($cx + 7) ($top + 7) $glow
      }
    }
    2 {  # tunic / vest
      $hx = $cx - [int]($w / 2)
      $h = $bot - $top
      Fill-Rect $bmp $hx $top $w $h $metal.base
      # Front opening
      Fill-Rect $bmp ($cx) $top 1 $h $metal.shadow
      # Sleeve seams
      Set-Px $bmp ($hx) ($top + 1) $metal.shadow
      Set-Px $bmp ($hx + $w - 1) ($top + 1) $metal.shadow
      # Collar
      Fill-Rect $bmp ($cx - 1) $top 3 1 $metal.shadow
      # Belt
      Fill-Rect $bmp $hx ($bot - 2) $w 1 $LEATHER.base
      Set-Px $bmp ($cx) ($bot - 2) $accent
    }
  }
}

# ── Legs archetypes ──────────────────────────────────────────────
# Legs cover the lower-torso to upper-thigh (rows 42-50).

function Draw-Legs {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity
  $accent = $RARITY_ACCENT[$rarity]

  $cx = 20
  $top = 42
  $bot = 50
  $w = 10
  $variant = (RngPick 2)        # 0=greaves, 1=pants/cloth
  $lower = $name.ToLower()
  if ($lower -match 'greaves|plate|trousers') { $variant = 0 }
  elseif ($lower -match 'skirt|robe|cloth') { $variant = 1 }

  $hx = $cx - [int]($w / 2)
  if ($variant -eq 0) {
    Fill-Rect $bmp $hx $top $w ($bot - $top) $metal.base
    Stroke-Rect $bmp $hx $top $w ($bot - $top) $metal.shadow
    # Knee plates
    Set-Px $bmp ($hx + 2) ($top + 4) $metal.top
    Set-Px $bmp ($hx + $w - 3) ($top + 4) $metal.top
    # Centre seam
    Fill-Rect $bmp ($cx) $top 1 ($bot - $top) $metal.shadow
    if ($detail -ge 2) {
      Set-Px $bmp $cx ($top + 2) $accent
    }
  } else {
    # Cloth/skirt — slightly flared
    for ($y = $top; $y -lt $bot; $y++) {
      $rowW = $w + [int](($y - $top) / 3)
      $rowX = $cx - [int]($rowW / 2)
      Fill-Rect $bmp $rowX $y $rowW 1 $metal.base
      Set-Px $bmp $rowX $y $metal.shadow
      Set-Px $bmp ($rowX + $rowW - 1) $y $metal.shadow
    }
    if ($detail -ge 1) {
      Fill-Rect $bmp ($cx - 4) ($bot - 1) 8 1 $accent
    }
  }
  # Halo (epic+)
  if ($detail -ge 3) {
    $glow = [System.Drawing.Color]::FromArgb(100, $accent.R, $accent.G, $accent.B)
    Set-Px $bmp ($hx - 1) ($top + 2) $glow
    Set-Px $bmp ($hx + $w) ($top + 2) $glow
  }
}

# ── Boots archetypes ─────────────────────────────────────────────
# Boots cover rows 50-55 (figure foot area).

function Draw-Boots {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity
  $accent = $RARITY_ACCENT[$rarity]
  $lower = $name.ToLower()

  $cx = 20
  $top = 49
  $bot = 55

  $variant = (RngPick 3)        # 0=sabatons, 1=soft boots, 2=sandals
  if ($lower -match 'plate|iron|sabaton') { $variant = 0 }
  elseif ($lower -match 'sandal|sole|slipper') { $variant = 2 }

  # Two boots: left (x≈16-18) and right (x≈21-23)
  $bootW = 3
  $lbx = $cx - 4
  $rbx = $cx + 1

  switch ($variant) {
    0 {  # sabatons — sharp armor
      foreach ($bx in @($lbx, $rbx)) {
        Fill-Rect $bmp $bx $top $bootW ($bot - $top) $metal.base
        Stroke-Rect $bmp $bx $top $bootW ($bot - $top) $metal.shadow
        # Toe spike
        Set-Px $bmp ($bx + $bootW - 1) ($bot - 1) $metal.top
        # Plate seams
        Fill-Rect $bmp $bx ($top + 2) $bootW 1 $metal.shadow
      }
      if ($detail -ge 2) {
        Set-Px $bmp ($lbx + 1) ($top + 1) $accent
        Set-Px $bmp ($rbx + 1) ($top + 1) $accent
      }
    }
    1 {  # soft leather boots
      foreach ($bx in @($lbx, $rbx)) {
        Fill-Rect $bmp $bx $top $bootW ($bot - $top) $LEATHER.base
        Set-Px $bmp $bx $top $LEATHER.shadow
        Set-Px $bmp ($bx + $bootW - 1) $top $LEATHER.shadow
        # Cuff
        Fill-Rect $bmp $bx $top $bootW 1 $LEATHER.high
        # Toe
        Fill-Rect $bmp $bx ($bot - 1) $bootW 1 $LEATHER.shadow
      }
      if ($detail -ge 1) {
        Set-Px $bmp ($lbx + 1) ($top + 3) $accent
        Set-Px $bmp ($rbx + 1) ($top + 3) $accent
      }
    }
    2 {  # sandals — strappy
      foreach ($bx in @($lbx, $rbx)) {
        # Sole only
        Fill-Rect $bmp $bx ($bot - 1) $bootW 1 $LEATHER.shadow
        # Straps
        Set-Px $bmp ($bx + 1) ($top + 1) $LEATHER.base
        Set-Px $bmp ($bx + 1) ($top + 3) $LEATHER.base
      }
    }
  }
  # Halo (epic+)
  if ($detail -ge 3) {
    $glow = [System.Drawing.Color]::FromArgb(100, $accent.R, $accent.G, $accent.B)
    Set-Px $bmp ($lbx - 1) ($bot - 1) $glow
    Set-Px $bmp ($rbx + $bootW) ($bot - 1) $glow
  }
}

# ── Trinket archetypes ───────────────────────────────────────────
# Trinkets are split between back-cape items (z=10, render in canvas
# gutter behind body) and front ornaments (z=45, sit on top of the
# chest sprite). We detect the kind via name keywords.

function Draw-Trinket {
  param($bmp, [string]$name, [string]$rarity)
  RngInit $name
  $metal = $RARITY_METAL[$rarity]
  $detail = Detail-Level $rarity
  $accent = $RARITY_ACCENT[$rarity]
  $lower = $name.ToLower()

  # Cape / cloak / wing — drawn behind body, hanging from neck/back
  if ($lower -match 'cape|cloak|wing|drape|mantle|veil') {
    $cx = 20
    $top = 26
    $bot = 50
    # Hang both sides — left and right of the body in the canvas gutter
    for ($y = $top; $y -le $bot; $y++) {
      $w = 16 + [int](($y - $top) / 4)
      $rowX = $cx - [int]($w / 2)
      Fill-Rect $bmp $rowX $y $w 1 $metal.base
      Set-Px $bmp $rowX $y $metal.shadow
      Set-Px $bmp ($rowX + $w - 1) $y $metal.shadow
    }
    # Collar at the top
    Fill-Rect $bmp ($cx - 5) ($top - 1) 10 1 $metal.shadow
    # Wing-style outline (uncommon+)
    if ($detail -ge 1 -and $lower -match 'wing|feather') {
      for ($y = $top; $y -le $bot; $y += 3) {
        Set-Px $bmp ($cx - 9) $y $accent
        Set-Px $bmp ($cx + 9) $y $accent
      }
    }
    # Halo (epic+)
    if ($detail -ge 3) {
      $glow = [System.Drawing.Color]::FromArgb(100, $accent.R, $accent.G, $accent.B)
      Set-Px $bmp ($cx - 10) ($top + 4) $glow
      Set-Px $bmp ($cx + 10) ($top + 4) $glow
    }
    return
  }

  # Ring — small front ornament on the chest
  if ($lower -match 'ring|band') {
    $rx = 20; $ry = 32
    Stroke-Rect $bmp ($rx - 1) ($ry - 1) 3 3 $metal.base
    Set-Px $bmp $rx $ry $accent
    return
  }

  # Charm / amulet / sigil / brooch — pendant on the chest
  if ($lower -match 'amulet|charm|sigil|brooch|talisman|pendant|locket|crystal|coin|feather|claw|tooth|gem|orb|stone|sapphire|ruby|emerald|diamond|jewel|focus') {
    $rx = 20; $ry = 33
    Fill-Rect $bmp ($rx - 1) ($ry - 1) 3 3 $metal.base
    Set-Px $bmp $rx $ry $accent
    # Chain (uncommon+)
    if ($detail -ge 1) {
      Set-Px $bmp ($rx - 2) ($ry - 2) $metal.shadow
      Set-Px $bmp ($rx + 2) ($ry - 2) $metal.shadow
      Set-Px $bmp ($rx - 3) ($ry - 3) $metal.shadow
      Set-Px $bmp ($rx + 3) ($ry - 3) $metal.shadow
    }
    # Inset gem (rare+)
    if ($detail -ge 2) {
      Set-Px $bmp ($rx - 1) ($ry - 1) $metal.top
      Set-Px $bmp ($rx + 1) ($ry + 1) $metal.top
    }
    # Halo (epic+)
    if ($detail -ge 3) {
      $glow = [System.Drawing.Color]::FromArgb(120, $accent.R, $accent.G, $accent.B)
      Set-Px $bmp ($rx - 2) $ry $glow
      Set-Px $bmp ($rx + 2) $ry $glow
    }
    return
  }

  # Default — small generic ornament
  $rx = 20; $ry = 33
  Fill-Rect $bmp ($rx - 1) ($ry - 1) 3 3 $metal.base
  Set-Px $bmp $rx $ry $accent
}

# ── Slot dispatcher + per-slot builders ──────────────────────────
function Build-GearSlot {
  param([string]$repoRoot, [string]$slot, $drawer)
  $catalogue = Read-Catalogue -repoRoot $repoRoot
  $pieces = $catalogue | Where-Object { $_.slot -eq $slot }
  $count = 0
  foreach ($p in $pieces) {
    $bmp = New-Canvas
    & $drawer $bmp $p.name $p.rarity
    $slug = Slugify $p.name
    Save-Canvas $bmp (Join-Path $gearDir ("{0}/{1}.png" -f $slot, $slug))
    $count++
  }
  Write-Host ("  {0}: {1}" -f $slot, $count) -ForegroundColor Green
}

function Build-Head    { param([string]$repoRoot) Write-Host '── Head gear ──' -ForegroundColor Cyan; Build-GearSlot $repoRoot 'head'    ${function:Draw-Head}    }
function Build-Chest   { param([string]$repoRoot) Write-Host '── Chest gear ──' -ForegroundColor Cyan; Build-GearSlot $repoRoot 'chest'   ${function:Draw-Chest}   }
function Build-Legs    { param([string]$repoRoot) Write-Host '── Legs gear ──' -ForegroundColor Cyan; Build-GearSlot $repoRoot 'legs'    ${function:Draw-Legs}    }
function Build-Boots   { param([string]$repoRoot) Write-Host '── Boots gear ──' -ForegroundColor Cyan; Build-GearSlot $repoRoot 'boots'   ${function:Draw-Boots}   }
function Build-Trinket { param([string]$repoRoot) Write-Host '── Trinket gear ──' -ForegroundColor Cyan; Build-GearSlot $repoRoot 'trinket' ${function:Draw-Trinket} }

# ── Pets ───────────────────────────────────────────────────────────
#
# Pets sit in the lower-right gutter alongside the character. Per
# CHARACTER-SYSTEM-DESIGN.md §4 the pet layer renders at z=15 — behind
# the body — so the silhouette has to stand mostly to the right of the
# figure footprint (figure occupies x=8..32, pet occupies x=27..39).
# The bottom of the pet aligns to y=55 (same baseline as the body's
# feet at y=55 → pet "stands on the floor").
#
# Each species has 4 colour variants matching SPECIES_COLOURS in
# discord-bot/pet.js. Within a species, only the palette swaps; the
# silhouette stays consistent so a player adopting a different colour
# of "cat" gets the same cat shape they recognise.

# Pet origin in canvas — bottom-right gutter, 13 wide × 16 tall
$PET_OX = 26
$PET_OY = 40
$PET_W  = 13
$PET_H  = 16

# Species × colour palettes. Each entry is { shadow; base; high; eye }.
# Eye is the small accent dot.
$PET_PALETTES = @{
  # ── Cat — pointed ears, curling tail
  'cat-black'    = @{ shadow='#15151b'; base='#2a2a32'; high='#444452'; eye='#5bff95' }
  'cat-tabby'    = @{ shadow='#5a4022'; base='#7e5a32'; high='#a07840'; eye='#46d160' }
  'cat-ginger'   = @{ shadow='#a4490c'; base='#d76d20'; high='#f5933e'; eye='#5bff95' }
  'cat-calico'   = @{ shadow='#5a3018'; base='#e8d4b0'; high='#fff5da'; eye='#3a86ff' }

  # ── Dog — floppy ears, chunky body, stubby tail
  'dog-cream'    = @{ shadow='#a47840'; base='#e8c884'; high='#fff0b8'; eye='#3a2010' }
  'dog-spotted'  = @{ shadow='#202028'; base='#f8f8fa'; high='#ffffff'; eye='#3a2010' }
  'dog-amber'    = @{ shadow='#6a3a14'; base='#a86028'; high='#d4843c'; eye='#3a2010' }
  'dog-midnight' = @{ shadow='#0a0a14'; base='#1c1c28'; high='#34344a'; eye='#5bff95' }

  # ── Owl — round body, ear tufts, big circular eyes
  'owl-barn'     = @{ shadow='#8a5a30'; base='#c08858'; high='#e8b888'; eye='#0a0a12' }
  'owl-snowy'    = @{ shadow='#a0a0b0'; base='#e8e8f0'; high='#ffffff'; eye='#0a0a12' }
  'owl-sage'     = @{ shadow='#4a6a4a'; base='#7ca080'; high='#a8c8a8'; eye='#0a0a12' }
  'owl-twilight' = @{ shadow='#3a2858'; base='#6a4ca0'; high='#9a82ff'; eye='#f0b429' }

  # ── Fox — pointed ears, narrow snout, bushy tail
  'fox-rust'     = @{ shadow='#a02810'; base='#d86432'; high='#f59060'; eye='#0a0a12' }
  'fox-arctic'   = @{ shadow='#a8a8b8'; base='#e8e8f4'; high='#ffffff'; eye='#3a86ff' }
  'fox-plum'     = @{ shadow='#4a2050'; base='#7c4a90'; high='#b078c8'; eye='#f0b429' }
  'fox-gold'     = @{ shadow='#8a5a18'; base='#d49a30'; high='#f4c860'; eye='#1c2034' }

  # ── Slime — wide-base blob with a glint
  'slime-mint'   = @{ shadow='#2a8060'; base='#5be098'; high='#a0ffcc'; eye='#0a0a12' }
  'slime-cobalt' = @{ shadow='#163065'; base='#3a72d8'; high='#74a8ff'; eye='#ffffff' }
  'slime-rose'   = @{ shadow='#a02858'; base='#e87aa8'; high='#ffb0d0'; eye='#0a0a12' }
  'slime-aurora' = @{ shadow='#4830a0'; base='#7c5cff'; high='#a890ff'; eye='#5bff95' }

  # ── Dragonling — horns, small wings, tail
  'dragonling-emerald' = @{ shadow='#1a5028'; base='#3a9050'; high='#5fc878'; eye='#f0b429' }
  'dragonling-ember'   = @{ shadow='#6a1010'; base='#c43020'; high='#f06040'; eye='#f0e028' }
  'dragonling-storm'   = @{ shadow='#283848'; base='#506880'; high='#88a0b8'; eye='#5bff95' }
  'dragonling-voltaic' = @{ shadow='#3a1f7a'; base='#7c5cff'; high='#a890ff'; eye='#5bff95' }

  # ── Frog — squat body, bulging dome eyes
  'frog-leaf'     = @{ shadow='#2a5028'; base='#4a8030'; high='#7cb850'; eye='#f0b429' }
  'frog-lily'     = @{ shadow='#1a4060'; base='#3878a0'; high='#70b0d4'; eye='#f0b429' }
  'frog-inkblot'  = @{ shadow='#0a0a14'; base='#252530'; high='#48485c'; eye='#5bff95' }
  'frog-sunburst' = @{ shadow='#a06820'; base='#e8a838'; high='#ffd070'; eye='#1c2034' }

  # ── Bunny — long ears, cotton tail
  'bunny-ash'        = @{ shadow='#6a6e78'; base='#a0a4ac'; high='#d4d8e0'; eye='#1c2034' }
  'bunny-cocoa'      = @{ shadow='#4a2a18'; base='#7c4a2a'; high='#a87048'; eye='#1c2034' }
  'bunny-meadow'     = @{ shadow='#2a6030'; base='#5fa848'; high='#90d870'; eye='#1c2034' }
  'bunny-starlight'  = @{ shadow='#5a4a78'; base='#a890ff'; high='#e0d0ff'; eye='#5bff95' }
}

function Pet-Palette {
  param([string]$key)
  $pal = $PET_PALETTES[$key]
  if (-not $pal) { throw "Unknown pet palette: $key" }
  return @{
    shadow = Color-FromHex $pal.shadow
    base   = Color-FromHex $pal.base
    high   = Color-FromHex $pal.high
    eye    = Color-FromHex $pal.eye
  }
}

# ── Cat ────────────────────────────────────────────────────────────
function Draw-Pet-Cat {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  # Body — sitting cat shape
  Fill-Rect $bmp ($ox + 3) ($oy + 6) 7 8 $pal.base
  # Belly highlight
  Fill-Rect $bmp ($ox + 4) ($oy + 7) 4 4 $pal.high
  # Bottom shadow
  for ($x = 0; $x -lt 7; $x++) {
    Set-Px $bmp ($ox + 3 + $x) ($oy + 13) $pal.shadow
  }
  # Head — sits on top of body
  Fill-Rect $bmp ($ox + 4) ($oy + 2) 5 5 $pal.base
  # Forehead highlight
  Fill-Rect $bmp ($ox + 5) ($oy + 3) 2 2 $pal.high
  # Cheek shadow
  Set-Px $bmp ($ox + 4) ($oy + 6) $pal.shadow
  Set-Px $bmp ($ox + 8) ($oy + 6) $pal.shadow
  # Ears — triangles
  Set-Px $bmp ($ox + 4) ($oy + 1) $pal.base
  Set-Px $bmp ($ox + 3) ($oy + 2) $pal.base
  Set-Px $bmp ($ox + 8) ($oy + 1) $pal.base
  Set-Px $bmp ($ox + 9) ($oy + 2) $pal.base
  # Ear inner — soft pink (slightly muted high)
  Set-Px $bmp ($ox + 4) ($oy + 2) $pal.high
  Set-Px $bmp ($ox + 8) ($oy + 2) $pal.high
  # Eyes — two dots
  Set-Px $bmp ($ox + 5) ($oy + 4) $pal.eye
  Set-Px $bmp ($ox + 7) ($oy + 4) $pal.eye
  # Nose
  Set-Px $bmp ($ox + 6) ($oy + 5) $pal.shadow
  # Tail — curling up the right side
  Set-Px $bmp ($ox + 10) ($oy + 11) $pal.base
  Set-Px $bmp ($ox + 11) ($oy + 10) $pal.base
  Set-Px $bmp ($ox + 11) ($oy + 9)  $pal.base
  Set-Px $bmp ($ox + 12) ($oy + 8)  $pal.base
  Set-Px $bmp ($ox + 12) ($oy + 7)  $pal.shadow
  # Front paws
  Set-Px $bmp ($ox + 4) ($oy + 14) $pal.shadow
  Set-Px $bmp ($ox + 8) ($oy + 14) $pal.shadow
}

# ── Dog ────────────────────────────────────────────────────────────
function Draw-Pet-Dog {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  # Body — chunkier, lower stance
  Fill-Rect $bmp ($ox + 2) ($oy + 8) 9 6 $pal.base
  Fill-Rect $bmp ($ox + 3) ($oy + 9) 6 3 $pal.high
  # Bottom shadow + paws
  for ($x = 0; $x -lt 9; $x++) {
    Set-Px $bmp ($ox + 2 + $x) ($oy + 13) $pal.shadow
  }
  Set-Px $bmp ($ox + 3) ($oy + 14) $pal.shadow
  Set-Px $bmp ($ox + 9) ($oy + 14) $pal.shadow
  # Head — round, ears below jaw line
  Fill-Rect $bmp ($ox + 5) ($oy + 3) 5 5 $pal.base
  Fill-Rect $bmp ($ox + 6) ($oy + 4) 2 2 $pal.high
  # Snout
  Set-Px $bmp ($ox + 5) ($oy + 7) $pal.shadow
  Set-Px $bmp ($ox + 6) ($oy + 7) $pal.shadow
  Set-Px $bmp ($ox + 6) ($oy + 6) $pal.shadow
  # Floppy ears — drop down past head
  Fill-Rect $bmp ($ox + 4) ($oy + 4) 1 4 $pal.shadow
  Fill-Rect $bmp ($ox + 10) ($oy + 4) 1 4 $pal.shadow
  # Eyes
  Set-Px $bmp ($ox + 6) ($oy + 5) $pal.eye
  Set-Px $bmp ($ox + 8) ($oy + 5) $pal.eye
  # Nose
  Set-Px $bmp ($ox + 7) ($oy + 6) $pal.shadow
  # Tail — stubby wag, up-right
  Set-Px $bmp ($ox + 11) ($oy + 8) $pal.base
  Set-Px $bmp ($ox + 12) ($oy + 7) $pal.base
}

# ── Owl ────────────────────────────────────────────────────────────
function Draw-Pet-Owl {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  # Body — wide oval, sits low
  Fill-Rect $bmp ($ox + 3) ($oy + 5) 7 9 $pal.base
  # Soft chest stripe
  Fill-Rect $bmp ($ox + 5) ($oy + 7) 3 5 $pal.high
  # Side shadow
  Set-Px $bmp ($ox + 3) ($oy + 13) $pal.shadow
  Set-Px $bmp ($ox + 9) ($oy + 13) $pal.shadow
  Set-Px $bmp ($ox + 3) ($oy + 5)  $pal.shadow
  Set-Px $bmp ($ox + 9) ($oy + 5)  $pal.shadow
  # Head — fused with body, slightly narrower
  Fill-Rect $bmp ($ox + 4) ($oy + 3) 5 3 $pal.base
  # Ear tufts
  Set-Px $bmp ($ox + 4) ($oy + 2) $pal.base
  Set-Px $bmp ($ox + 8) ($oy + 2) $pal.base
  # Big circle eyes — disc + pupil
  Fill-Rect $bmp ($ox + 4) ($oy + 4) 2 2 $pal.high
  Fill-Rect $bmp ($ox + 7) ($oy + 4) 2 2 $pal.high
  Set-Px $bmp ($ox + 5) ($oy + 5) $pal.eye
  Set-Px $bmp ($ox + 8) ($oy + 5) $pal.eye
  # Beak — small yellow triangle (use base shadow as outline)
  $beak = [System.Drawing.Color]::FromArgb(255, 0xf0, 0xb4, 0x29)
  Set-Px $bmp ($ox + 6) ($oy + 6) $beak
  # Feet
  Set-Px $bmp ($ox + 4) ($oy + 14) $beak
  Set-Px $bmp ($ox + 8) ($oy + 14) $beak
  # Wing edge detail
  Set-Px $bmp ($ox + 3) ($oy + 9)  $pal.shadow
  Set-Px $bmp ($ox + 9) ($oy + 9)  $pal.shadow
  Set-Px $bmp ($ox + 3) ($oy + 11) $pal.shadow
  Set-Px $bmp ($ox + 9) ($oy + 11) $pal.shadow
}

# ── Fox ────────────────────────────────────────────────────────────
function Draw-Pet-Fox {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  # Body — sleek, slightly hunched
  Fill-Rect $bmp ($ox + 3) ($oy + 7) 6 7 $pal.base
  Fill-Rect $bmp ($ox + 4) ($oy + 8) 3 3 $pal.high
  # Bottom shadow + paws
  for ($x = 0; $x -lt 6; $x++) {
    Set-Px $bmp ($ox + 3 + $x) ($oy + 13) $pal.shadow
  }
  Set-Px $bmp ($ox + 3) ($oy + 14) $pal.shadow
  Set-Px $bmp ($ox + 7) ($oy + 14) $pal.shadow
  # Head — triangular snout
  Fill-Rect $bmp ($ox + 4) ($oy + 3) 5 4 $pal.base
  Set-Px $bmp ($ox + 5) ($oy + 7) $pal.base
  Set-Px $bmp ($ox + 4) ($oy + 7) $pal.shadow
  Set-Px $bmp ($ox + 6) ($oy + 7) $pal.shadow
  Fill-Rect $bmp ($ox + 5) ($oy + 4) 2 2 $pal.high
  # Pointed ears
  Set-Px $bmp ($ox + 4) ($oy + 2) $pal.base
  Set-Px $bmp ($ox + 3) ($oy + 3) $pal.base
  Set-Px $bmp ($ox + 8) ($oy + 2) $pal.base
  Set-Px $bmp ($ox + 9) ($oy + 3) $pal.base
  # Inner ear
  Set-Px $bmp ($ox + 4) ($oy + 3) $pal.shadow
  Set-Px $bmp ($ox + 8) ($oy + 3) $pal.shadow
  # Eyes
  Set-Px $bmp ($ox + 5) ($oy + 5) $pal.eye
  Set-Px $bmp ($ox + 7) ($oy + 5) $pal.eye
  # Nose tip
  Set-Px $bmp ($ox + 6) ($oy + 6) $pal.shadow
  # Bushy tail — curls up + back
  Set-Px $bmp ($ox + 9)  ($oy + 11) $pal.base
  Set-Px $bmp ($ox + 10) ($oy + 10) $pal.base
  Set-Px $bmp ($ox + 11) ($oy + 9)  $pal.base
  Set-Px $bmp ($ox + 11) ($oy + 8)  $pal.high
  Set-Px $bmp ($ox + 12) ($oy + 8)  $pal.base
  Set-Px $bmp ($ox + 12) ($oy + 7)  $pal.high
}

# ── Slime ──────────────────────────────────────────────────────────
function Draw-Pet-Slime {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  # Wide-base blob — pyramid silhouette
  # Top dome
  Fill-Rect $bmp ($ox + 4) ($oy + 5) 5 2 $pal.base
  Fill-Rect $bmp ($ox + 3) ($oy + 7) 7 2 $pal.base
  Fill-Rect $bmp ($ox + 2) ($oy + 9) 9 4 $pal.base
  for ($x = 0; $x -lt 9; $x++) {
    Set-Px $bmp ($ox + 2 + $x) ($oy + 13) $pal.shadow
  }
  Set-Px $bmp ($ox + 4) ($oy + 5) $pal.shadow
  Set-Px $bmp ($ox + 8) ($oy + 5) $pal.shadow
  Set-Px $bmp ($ox + 3) ($oy + 7) $pal.shadow
  Set-Px $bmp ($ox + 9) ($oy + 7) $pal.shadow
  # Glint — diagonal sparkle on upper-left
  Fill-Rect $bmp ($ox + 5) ($oy + 6) 2 1 $pal.high
  Set-Px $bmp ($ox + 4) ($oy + 8) $pal.high
  Set-Px $bmp ($ox + 5) ($oy + 9) $pal.high
  # Eyes — small black dots
  Set-Px $bmp ($ox + 5) ($oy + 10) $pal.eye
  Set-Px $bmp ($ox + 8) ($oy + 10) $pal.eye
  # Smile
  Set-Px $bmp ($ox + 6) ($oy + 11) $pal.eye
  Set-Px $bmp ($ox + 7) ($oy + 11) $pal.eye
}

# ── Dragonling ─────────────────────────────────────────────────────
function Draw-Pet-Dragonling {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  # Body — sturdier than a fox, hunched stance
  Fill-Rect $bmp ($ox + 3) ($oy + 7) 6 7 $pal.base
  Fill-Rect $bmp ($ox + 4) ($oy + 8) 3 3 $pal.high
  for ($x = 0; $x -lt 6; $x++) {
    Set-Px $bmp ($ox + 3 + $x) ($oy + 13) $pal.shadow
  }
  Set-Px $bmp ($ox + 3) ($oy + 14) $pal.shadow
  Set-Px $bmp ($ox + 7) ($oy + 14) $pal.shadow
  # Head — boxy
  Fill-Rect $bmp ($ox + 4) ($oy + 3) 5 4 $pal.base
  Fill-Rect $bmp ($ox + 5) ($oy + 4) 2 2 $pal.high
  # Snout extension
  Fill-Rect $bmp ($ox + 4) ($oy + 6) 2 1 $pal.base
  Set-Px $bmp ($ox + 3) ($oy + 6) $pal.shadow
  # Horns (curving back)
  Set-Px $bmp ($ox + 4) ($oy + 2) $pal.high
  Set-Px $bmp ($ox + 5) ($oy + 1) $pal.high
  Set-Px $bmp ($ox + 8) ($oy + 2) $pal.high
  Set-Px $bmp ($ox + 7) ($oy + 1) $pal.high
  # Eyes — glowing
  Set-Px $bmp ($ox + 5) ($oy + 5) $pal.eye
  Set-Px $bmp ($ox + 7) ($oy + 5) $pal.eye
  # Small wings on back (folded)
  Set-Px $bmp ($ox + 8) ($oy + 8)  $pal.shadow
  Set-Px $bmp ($ox + 9) ($oy + 7)  $pal.shadow
  Set-Px $bmp ($ox + 9) ($oy + 8)  $pal.shadow
  Set-Px $bmp ($ox + 10) ($oy + 8) $pal.high
  Set-Px $bmp ($ox + 10) ($oy + 9) $pal.shadow
  # Spiked tail — curls up
  Set-Px $bmp ($ox + 9)  ($oy + 12) $pal.base
  Set-Px $bmp ($ox + 10) ($oy + 11) $pal.base
  Set-Px $bmp ($ox + 11) ($oy + 11) $pal.shadow
  Set-Px $bmp ($ox + 11) ($oy + 10) $pal.base
  Set-Px $bmp ($ox + 12) ($oy + 10) $pal.high
}

# ── Frog ───────────────────────────────────────────────────────────
function Draw-Pet-Frog {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  # Squat body
  Fill-Rect $bmp ($ox + 3) ($oy + 8) 7 6 $pal.base
  Fill-Rect $bmp ($ox + 4) ($oy + 9) 5 3 $pal.high
  # Side shadow
  for ($x = 0; $x -lt 7; $x++) {
    Set-Px $bmp ($ox + 3 + $x) ($oy + 13) $pal.shadow
  }
  # Head — wide, fused with body
  Fill-Rect $bmp ($ox + 4) ($oy + 5) 5 3 $pal.base
  Set-Px $bmp ($ox + 3) ($oy + 6) $pal.base
  Set-Px $bmp ($ox + 9) ($oy + 6) $pal.base
  Set-Px $bmp ($ox + 3) ($oy + 7) $pal.shadow
  Set-Px $bmp ($ox + 9) ($oy + 7) $pal.shadow
  # Bulging dome eyes on top
  Fill-Rect $bmp ($ox + 3) ($oy + 3) 2 2 $pal.base
  Fill-Rect $bmp ($ox + 8) ($oy + 3) 2 2 $pal.base
  Set-Px $bmp ($ox + 4) ($oy + 3) $pal.high
  Set-Px $bmp ($ox + 9) ($oy + 3) $pal.high
  # Pupils
  Set-Px $bmp ($ox + 3) ($oy + 4) $pal.eye
  Set-Px $bmp ($ox + 8) ($oy + 4) $pal.eye
  # Mouth — wide grin
  Fill-Rect $bmp ($ox + 4) ($oy + 7) 5 1 $pal.shadow
  # Front legs (squat)
  Set-Px $bmp ($ox + 3) ($oy + 14) $pal.shadow
  Set-Px $bmp ($ox + 4) ($oy + 14) $pal.base
  Set-Px $bmp ($ox + 8) ($oy + 14) $pal.base
  Set-Px $bmp ($ox + 9) ($oy + 14) $pal.shadow
}

# ── Bunny ──────────────────────────────────────────────────────────
function Draw-Pet-Bunny {
  param($bmp, $pal)
  $ox = $PET_OX; $oy = $PET_OY
  # Body — egg-shape, upright
  Fill-Rect $bmp ($ox + 3) ($oy + 8) 6 6 $pal.base
  Fill-Rect $bmp ($ox + 4) ($oy + 9) 3 3 $pal.high
  for ($x = 0; $x -lt 6; $x++) {
    Set-Px $bmp ($ox + 3 + $x) ($oy + 13) $pal.shadow
  }
  # Head — round, slightly small
  Fill-Rect $bmp ($ox + 4) ($oy + 6) 4 3 $pal.base
  Set-Px $bmp ($ox + 5) ($oy + 7) $pal.high
  # Long ears — tall vertical pair
  Fill-Rect $bmp ($ox + 4) ($oy + 1) 1 5 $pal.base
  Fill-Rect $bmp ($ox + 7) ($oy + 1) 1 5 $pal.base
  # Ear inner (lighter)
  Set-Px $bmp ($ox + 4) ($oy + 2) $pal.high
  Set-Px $bmp ($ox + 4) ($oy + 3) $pal.high
  Set-Px $bmp ($ox + 7) ($oy + 2) $pal.high
  Set-Px $bmp ($ox + 7) ($oy + 3) $pal.high
  # Eyes
  Set-Px $bmp ($ox + 4) ($oy + 7) $pal.eye
  Set-Px $bmp ($ox + 7) ($oy + 7) $pal.eye
  # Nose
  Set-Px $bmp ($ox + 5) ($oy + 8) $pal.shadow
  Set-Px $bmp ($ox + 6) ($oy + 8) $pal.shadow
  # Cotton tail (right side, fluffy)
  Set-Px $bmp ($ox + 9)  ($oy + 10) $pal.high
  Set-Px $bmp ($ox + 10) ($oy + 10) $pal.high
  Set-Px $bmp ($ox + 9)  ($oy + 11) $pal.base
  Set-Px $bmp ($ox + 10) ($oy + 11) $pal.high
  # Front paws
  Set-Px $bmp ($ox + 3) ($oy + 14) $pal.shadow
  Set-Px $bmp ($ox + 8) ($oy + 14) $pal.shadow
}

# Dispatch by species name
function Draw-Pet {
  param($bmp, [string]$species, [string]$colour)
  $key = "$species-$colour"
  $pal = Pet-Palette $key
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

# ── Legendary gear (the lone Excalibur for now) ───────────────────
#
# Catalogue items at rarity='legendary' don't live in dungeon.js
# SHOP_POOL — they're lootbox-only (see ext-lootbox.js). We hardcode
# the full legendary roster here so we can emit:
#   - the base weapon sprite at the legendary rarity palette
#     (drives the higher-detail metal ramp via Draw-Weapon)
#   - 4 fx halo frames stitched downstream into an APNG halo by
#     tools/build-apng.mjs (the PowerShell side can't emit APNG
#     natively — GDI+ has no acTL/fdAT writer).
#
# Add a row to this list when a new legendary lands in the game.

$LEGENDARIES = @(
  @{ slot = 'weapon'; name = 'Excalibur'; weaponType = 'sword' }
)

function Draw-Legendary-FxHalo {
  param($bmp, [string]$name, [int]$frameIndex)
  # Halo: 4 phase-shifted shimmer rings around the weapon hilt.
  # We pin to weapon-grip area (roughly x=18..22, y=24..28).
  $rx = 20; $ry = 26
  # Per-frame phase offset
  $phase = $frameIndex
  # Gold accent for legendary
  $gold = $BRAND.Gold
  $hi   = [System.Drawing.Color]::FromArgb(255, 0xff, 0xf0, 0xa0)
  # Outer halo — 8 radial spokes at varying alpha across frames
  $radius = 4 + ($phase % 2)
  for ($a = 0; $a -lt 8; $a++) {
    $ang = ($a * 45 + $phase * 20) * [Math]::PI / 180
    $sx = $rx + [int]([Math]::Cos($ang) * $radius)
    $sy = $ry + [int]([Math]::Sin($ang) * $radius)
    Set-Px $bmp $sx $sy $gold
  }
  # Inner sparkle — single bright pixel cycling clockwise
  $innerAng = ($phase * 90) * [Math]::PI / 180
  $ix = $rx + [int]([Math]::Cos($innerAng) * 2)
  $iy = $ry + [int]([Math]::Sin($innerAng) * 2)
  Set-Px $bmp $ix $iy $hi
  # Distant motes — drift up
  $motes = @(
    @{ x = $rx + 5; y = $ry - 3 - $phase },
    @{ x = $rx - 5; y = $ry - 1 - $phase },
    @{ x = $rx + 3; y = $ry - 5 - (($phase + 2) % 4) }
  )
  foreach ($m in $motes) { Set-Px $bmp $m.x $m.y $gold }
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
    # Base sprite — same path the compositor expects
    $bmp = New-Canvas
    if ($leg.slot -eq 'weapon') {
      Draw-Weapon $bmp $leg.weaponType $leg.name 'legendary'
    } else {
      throw "TODO: legendary draw for slot $($leg.slot)"
    }
    Save-Canvas $bmp (Join-Path $gearDir ("{0}/{1}.png" -f $leg.slot, $slug))
    $count++

    # 4 fx halo frames
    for ($f = 0; $f -lt 4; $f++) {
      $fxBmp = New-Canvas
      Draw-Legendary-FxHalo $fxBmp $leg.name $f
      Save-Canvas $fxBmp (Join-Path $framesDir ("{0}-fx-{1}.png" -f $slug, $f))
      $frameCount++
    }
  }
  Write-Host ("  legendaries: {0}  ({1} fx frames)" -f $count, $frameCount) -ForegroundColor Green
}

function Build-Pets {
  Write-Host '── Pets ──' -ForegroundColor Cyan
  $count = 0
  foreach ($key in $PET_PALETTES.Keys) {
    $parts = $key -split '-', 2
    $species = $parts[0]
    $colour  = $parts[1]
    $bmp = New-Canvas
    Draw-Pet $bmp $species $colour
    Save-Canvas $bmp (Join-Path $petDir ("{0}-{1}.png" -f $species, $colour))
    $count++
  }
  Write-Host ("  variants: {0}" -f $count) -ForegroundColor Green
}

# ── Mood overlays ──────────────────────────────────────────────────
#
# Tiny status icons that float above the pet when a care stat is low.
# pet.js mood hints are: hungry, dirty, sad. Happy state shows no
# overlay. Each icon is drawn at the top-right of the pet "head" area
# (around x=32..38, y=36..42), small enough not to obscure the pet.

# Centre point above pet head — anchor for floating icons
$MOOD_OX = 32
$MOOD_OY = 36

function Draw-Mood-Hungry {
  param($bmp)
  $bowl   = Color-FromHex '#a86028'
  $bowlHi = Color-FromHex '#d4843c'
  $crumb  = Color-FromHex '#f0b429'
  # Bowl rim
  Fill-Rect $bmp ($MOOD_OX) ($MOOD_OY + 3) 6 1 $bowl
  # Bowl body
  Fill-Rect $bmp ($MOOD_OX + 1) ($MOOD_OY + 4) 4 2 $bowl
  Set-Px $bmp ($MOOD_OX + 2) ($MOOD_OY + 4) $bowlHi
  Set-Px $bmp ($MOOD_OX + 3) ($MOOD_OY + 4) $bowlHi
  # Empty crumbs above
  Set-Px $bmp ($MOOD_OX + 2) ($MOOD_OY + 1) $crumb
  Set-Px $bmp ($MOOD_OX + 4) ($MOOD_OY + 2) $crumb
  Set-Px $bmp ($MOOD_OX + 1) ($MOOD_OY + 2) $crumb
}

function Draw-Mood-Sad {
  param($bmp)
  $drop   = Color-FromHex '#3a86ff'
  $dropHi = Color-FromHex '#9bbef0'
  # Tear-drop shape — point at top, round bottom
  Set-Px $bmp ($MOOD_OX + 2) $MOOD_OY $drop
  Set-Px $bmp ($MOOD_OX + 1) ($MOOD_OY + 1) $drop
  Set-Px $bmp ($MOOD_OX + 2) ($MOOD_OY + 1) $dropHi
  Set-Px $bmp ($MOOD_OX + 3) ($MOOD_OY + 1) $drop
  Fill-Rect $bmp ($MOOD_OX) ($MOOD_OY + 2) 5 2 $drop
  Set-Px $bmp ($MOOD_OX + 1) ($MOOD_OY + 2) $dropHi
  Set-Px $bmp ($MOOD_OX + 2) ($MOOD_OY + 2) $dropHi
  Fill-Rect $bmp ($MOOD_OX + 1) ($MOOD_OY + 4) 3 1 $drop
}

function Draw-Mood-Dirty {
  param($bmp)
  $fly  = Color-FromHex '#222228'
  $wing = Color-FromHex '#9aa1b4'
  # Small fly body
  Fill-Rect $bmp ($MOOD_OX + 2) ($MOOD_OY + 2) 2 1 $fly
  # Wings
  Set-Px $bmp ($MOOD_OX + 1) ($MOOD_OY + 1) $wing
  Set-Px $bmp ($MOOD_OX + 4) ($MOOD_OY + 1) $wing
  # Squiggle / motion trail
  Set-Px $bmp ($MOOD_OX)     ($MOOD_OY + 3) $fly
  Set-Px $bmp ($MOOD_OX + 1) ($MOOD_OY + 4) $fly
  Set-Px $bmp ($MOOD_OX + 3) ($MOOD_OY + 4) $fly
  Set-Px $bmp ($MOOD_OX + 4) ($MOOD_OY + 3) $fly
  # Stink dot
  Set-Px $bmp ($MOOD_OX + 5) ($MOOD_OY) $fly
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
    $bmp = New-Canvas
    & $m.drawer $bmp
    Save-Canvas $bmp (Join-Path $petDir ("mood-{0}.png" -f $m.name))
    $count++
  }
  Write-Host ("  moods: {0}" -f $count) -ForegroundColor Green
}

# ── Top-level driver ───────────────────────────────────────────────
$repoRoot = Split-Path -Parent $PSScriptRoot

Build-Figure
Build-Hair
Build-Eyes
Build-Accents
Build-Weapons -repoRoot $repoRoot
Build-Head    -repoRoot $repoRoot
Build-Chest   -repoRoot $repoRoot
Build-Legs    -repoRoot $repoRoot
Build-Boots   -repoRoot $repoRoot
Build-Trinket -repoRoot $repoRoot
Build-Legendary -repoRoot $repoRoot
Build-Pets
Build-Moods

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "Output: $OutRoot"
