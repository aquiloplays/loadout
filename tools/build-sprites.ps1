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

# ── Top-level driver ───────────────────────────────────────────────
Build-Figure

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "Output: $OutRoot"
