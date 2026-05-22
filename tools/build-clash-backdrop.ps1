# Clash v2 pixel-art town backdrop — parallax layers per
# CLASH-EXPANSION-DESIGN.md §7 + §9.
#
# Each layer is a separate PNG saved under aquilo-gg/sprites/clash-v2/
# backdrop/. The aquilo-site renderer composites them top-down with
# image-rendering: pixelated so the layers can be 1152px wide
# (half the 24×24 grid render width of 2304px) and the browser
# nearest-neighbor scales to crisp pixel art.
#
# Layers (top → bottom):
#   sky.png       1152×512  Vertical blue gradient + a couple of
#                            stylised clouds + a sun glint
#   mountains.png 1152×256  Distant mountain silhouette (steel blue)
#   hills.png     1152×192  Mid-distance rolling hills (forest teal)
#   forest.png    1152×160  Treetops touching the grass line
#   grass.png     1152×384  Foreground grass + path + small details
#
# Total ~1.3M pixels. Renders in ~30s on Windows PS 5.1 + GDI+.

[CmdletBinding()]
param(
  [string]$OutRoot = ''
)
$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $OutRoot) {
  $OutRoot = Join-Path (Split-Path -Parent $scriptDir) 'aquilo-gg/sprites'
}
. (Join-Path $scriptDir 'lib-pixel.ps1')

$backdropDir = Join-Path (Join-Path $OutRoot 'clash-v2') 'backdrop'
New-Item -ItemType Directory -Force -Path $backdropDir | Out-Null

# ── Sky layer — vertical blue gradient + clouds + sun glint ─────────

function Build-Sky {
  $w = 1152; $h = 512
  $bmp = New-CanvasFx $w $h
  # Vertical gradient: deep blue at top → lighter mid-day at bottom
  $top    = Color-FromHex '#3a5c9a'
  $mid    = Color-FromHex '#7caee0'
  $low    = Color-FromHex '#c0e0f0'
  for ($y = 0; $y -lt $h; $y++) {
    $t = $y / ($h - 1)
    $col = if ($t -lt 0.5) {
      Mix-Color $top $mid ($t * 2.0)
    } else {
      Mix-Color $mid $low (($t - 0.5) * 2.0)
    }
    for ($x = 0; $x -lt $w; $x++) {
      Set-Pixel $bmp $x $y $col
    }
  }
  # Sun glint upper-left
  $sunCx = 220; $sunCy = 120
  for ($r = 0; $r -lt 6; $r++) {
    $col = Mix-Color (Color-FromHex '#ffea96') $low ($r / 6.0)
    Shade-Disc $bmp $sunCx $sunCy (38 + $r * 2) @{
      deep=$col; shadow=$col; base=$col; high=$col; top=$col;
    }
  }
  Shade-Disc $bmp $sunCx $sunCy 28 @{
    deep   = (Color-FromHex '#f0c878');
    shadow = (Color-FromHex '#f8d890');
    base   = (Color-FromHex '#fff0a8');
    high   = (Color-FromHex '#fff8d8');
    top    = (Color-FromHex '#ffffff');
  } -RimLight
  # Bird silhouettes (V shapes)
  Rng-Init 'sky-birds'
  for ($i = 0; $i -lt 6; $i++) {
    $bx = 300 + (Rng-Range 0 800)
    $by = 60 + (Rng-Range 0 140)
    Set-Pixel $bmp ($bx - 2) ($by + 1) (Color-FromHex '#1c2034')
    Set-Pixel $bmp ($bx - 1) $by (Color-FromHex '#1c2034')
    Set-Pixel $bmp $bx ($by + 1) (Color-FromHex '#1c2034')
    Set-Pixel $bmp ($bx + 1) $by (Color-FromHex '#1c2034')
    Set-Pixel $bmp ($bx + 2) ($by + 1) (Color-FromHex '#1c2034')
  }
  # Clouds — soft pixel-art puffs
  Rng-Init 'sky-clouds'
  for ($c = 0; $c -lt 5; $c++) {
    $cx = 80 + $c * 240 + (Rng-Range -20 20)
    $cy = 180 + (Rng-Range 0 140)
    Draw-Cloud $bmp $cx $cy (40 + (Rng-Range 0 30))
  }
  Save-CanvasFx $bmp (Join-Path $backdropDir 'sky.png')
  Write-Host '  sky.png        1152×512' -ForegroundColor DarkGray
}

# Pixel-art cloud — overlapping discs with subtle shading.
function Draw-Cloud {
  param($bmp, [int]$cx, [int]$cy, [int]$baseR)
  $cloudRamp = @{
    deep   = (Color-FromHex '#9eb9cb');
    shadow = (Color-FromHex '#c0d6e6');
    base   = (Color-FromHex '#e0eaf3');
    high   = (Color-FromHex '#f6f9fc');
    top    = (Color-FromHex '#ffffff');
  }
  Shade-Oval $bmp $cx $cy ($baseR * 1.4) ($baseR * 0.6) $cloudRamp
  Shade-Oval $bmp ($cx - [int]($baseR * 0.6)) ($cy - [int]($baseR * 0.3)) ($baseR * 0.7) ($baseR * 0.5) $cloudRamp
  Shade-Oval $bmp ($cx + [int]($baseR * 0.5)) ($cy - [int]($baseR * 0.2)) ($baseR * 0.7) ($baseR * 0.5) $cloudRamp
  Shade-Oval $bmp ($cx + [int]($baseR * 1.1)) ($cy + [int]($baseR * 0.1)) ($baseR * 0.6) ($baseR * 0.4) $cloudRamp
}

# ── Mountains layer — distant silhouette w/ snowcaps ────────────────

function Build-Mountains {
  $w = 1152; $h = 256
  $bmp = New-CanvasFx $w $h
  $mountRamp = @{
    deep   = (Color-FromHex '#2a3548');
    shadow = (Color-FromHex '#3e526b');
    base   = (Color-FromHex '#54718c');
    high   = (Color-FromHex '#728eaa');
    top    = (Color-FromHex '#9ab2c8');
  }
  $snowRamp = @{
    deep   = (Color-FromHex '#c8d8e8');
    shadow = (Color-FromHex '#e0eaf3');
    base   = (Color-FromHex '#f0f4fa');
    high   = (Color-FromHex '#f8fafc');
    top    = (Color-FromHex '#ffffff');
  }
  Rng-Init 'mountains'
  # Range of peaks across the width
  $peakXs = @()
  for ($i = 0; $i -lt 8; $i++) {
    $peakXs += (60 + $i * 140 + (Rng-Range -30 30))
  }
  # Build height-map silhouette using triangular peaks
  $silY = New-Object 'int[]' $w
  for ($x = 0; $x -lt $w; $x++) {
    $silY[$x] = $h    # below the layer = no mountain
  }
  foreach ($pkX in $peakXs) {
    $peakH = 110 + (Rng-Range -20 40)
    $halfW = 90 + (Rng-Range -20 40)
    $peakY = $h - $peakH
    for ($dx = -$halfW; $dx -le $halfW; $dx++) {
      $x = $pkX + $dx
      if ($x -lt 0 -or $x -ge $w) { continue }
      $rise = $peakH * (1.0 - ([Math]::Abs($dx) / [double]$halfW))
      # Add a little noise on the slope for jagged edges
      $rise -= (Rng-Range 0 6)
      if ($rise -lt 0) { continue }
      $y = $h - [int]$rise
      if ($y -lt $silY[$x]) { $silY[$x] = $y }
    }
  }
  # Fill silhouette
  for ($x = 0; $x -lt $w; $x++) {
    $top_y = $silY[$x]
    if ($top_y -ge $h) { continue }
    for ($y = $top_y; $y -lt $h; $y++) {
      $depth = ($y - $top_y) / [Math]::Max(1.0, $h - $top_y)
      $col = if ($depth -lt 0.20) {
        $mountRamp.top
      } elseif ($depth -lt 0.40) {
        $mountRamp.high
      } elseif ($depth -lt 0.65) {
        $mountRamp.base
      } else {
        $mountRamp.shadow
      }
      Set-Pixel $bmp $x $y $col
    }
    # Snow cap on the peak (top 12 rows of any column that's near the peak)
    if (($h - $top_y) -gt 80) {
      for ($y = $top_y; $y -lt ($top_y + 8); $y++) {
        Set-Pixel $bmp $x $y $snowRamp.base
        if ($y -eq $top_y) { Set-Pixel $bmp $x $y $snowRamp.top }
      }
    }
    # Edge highlight
    if ($x -gt 0 -and $silY[$x - 1] -gt $top_y) {
      Set-Pixel $bmp $x $top_y $mountRamp.top
    }
  }
  Save-CanvasFx $bmp (Join-Path $backdropDir 'mountains.png')
  Write-Host '  mountains.png  1152×256' -ForegroundColor DarkGray
}

# ── Hills layer — rolling mid-distance ──────────────────────────────

function Build-Hills {
  $w = 1152; $h = 192
  $bmp = New-CanvasFx $w $h
  $hillRamp = @{
    deep   = (Color-FromHex '#1c3a24');
    shadow = (Color-FromHex '#2e5a36');
    base   = (Color-FromHex '#4a8a50');
    high   = (Color-FromHex '#6ab070');
    top    = (Color-FromHex '#8cce92');
  }
  Rng-Init 'hills'
  # Two layered sin-waves give the rolling feel
  $silY = New-Object 'int[]' $w
  for ($x = 0; $x -lt $w; $x++) {
    $wave1 = [Math]::Sin($x * 0.012) * 24
    $wave2 = [Math]::Sin($x * 0.027) * 14
    $wave3 = [Math]::Sin($x * 0.060) * 6
    $y = $h - 90 + [int]($wave1 + $wave2 + $wave3)
    $silY[$x] = [Math]::Max(20, [Math]::Min($h - 8, $y))
  }
  for ($x = 0; $x -lt $w; $x++) {
    $top_y = $silY[$x]
    for ($y = $top_y; $y -lt $h; $y++) {
      $depth = ($y - $top_y) / [Math]::Max(1.0, $h - $top_y)
      $col = if ($depth -lt 0.15) {
        $hillRamp.top
      } elseif ($depth -lt 0.35) {
        $hillRamp.high
      } elseif ($depth -lt 0.70) {
        $hillRamp.base
      } else {
        $hillRamp.shadow
      }
      Set-Pixel $bmp $x $y $col
    }
    # Highlight ridge
    Set-Pixel $bmp $x $top_y $hillRamp.top
    if ($x -gt 0 -and $silY[$x - 1] -lt $top_y) {
      Set-Pixel $bmp $x $top_y $hillRamp.high
    }
  }
  # Scatter dots — distant grass/wildflower texture
  for ($i = 0; $i -lt 200; $i++) {
    $x = Rng-Range 0 ($w - 1)
    $y = $silY[$x] + (Rng-Range 4 30)
    if ($y -ge $h) { continue }
    $col = if ((Rng-Pick 5) -eq 0) { Color-FromHex '#f0e6b8' } else { $hillRamp.shadow }
    Set-Pixel $bmp $x $y $col
  }
  Save-CanvasFx $bmp (Join-Path $backdropDir 'hills.png')
  Write-Host '  hills.png      1152×192' -ForegroundColor DarkGray
}

# ── Forest layer — treetops just above the grass line ───────────────

function Build-Forest {
  $w = 1152; $h = 160
  $bmp = New-CanvasFx $w $h
  Rng-Init 'forest'
  $treeRamp = @{
    deep   = (Color-FromHex '#0a2418');
    shadow = (Color-FromHex '#1c4028');
    base   = (Color-FromHex '#2e6038');
    high   = (Color-FromHex '#508050');
    top    = (Color-FromHex '#7ab070');
  }
  $trunkRamp = $MAT_WOOD_DARK

  # Trees densely packed along the lower half, sparser near the top
  for ($i = 0; $i -lt 90; $i++) {
    $tx = Rng-Range 0 ($w - 1)
    $treeH = 60 + (Rng-Range 0 50)
    $treeW = 28 + (Rng-Range 0 20)
    $baseY = $h - 4
    $topY = $baseY - $treeH
    # Trunk
    $trunkH = 12 + (Rng-Range 0 8)
    for ($y = 0; $y -lt $trunkH; $y++) {
      Set-Pixel $bmp $tx ($baseY - $y) $trunkRamp.base
      Set-Pixel $bmp ($tx + 1) ($baseY - $y) $trunkRamp.shadow
      Set-Pixel $bmp ($tx - 1) ($baseY - $y) $trunkRamp.high
    }
    # Foliage clusters (3 overlapping ovals)
    $foliY = $baseY - $trunkH
    Shade-Oval $bmp $tx $foliY ($treeW * 0.45) ($treeH * 0.4) $treeRamp
    Shade-Oval $bmp ($tx - [int]($treeW * 0.3)) ($foliY + 4) ($treeW * 0.35) ($treeH * 0.35) $treeRamp
    Shade-Oval $bmp ($tx + [int]($treeW * 0.3)) ($foliY + 4) ($treeW * 0.35) ($treeH * 0.35) $treeRamp
    Shade-Oval $bmp $tx ($foliY - 6) ($treeW * 0.35) ($treeH * 0.3) $treeRamp
  }
  Save-CanvasFx $bmp (Join-Path $backdropDir 'forest.png')
  Write-Host '  forest.png     1152×160' -ForegroundColor DarkGray
}

# ── Grass layer — foreground ground + path + small details ──────────

function Build-Grass {
  $w = 1152; $h = 384
  $bmp = New-CanvasFx $w $h
  $grassRamp = @{
    deep   = (Color-FromHex '#1c3a18');
    shadow = (Color-FromHex '#2e5a28');
    base   = (Color-FromHex '#4a8a3e');
    high   = (Color-FromHex '#6ab058');
    top    = (Color-FromHex '#8cce72');
  }
  $dirtRamp = @{
    deep   = (Color-FromHex '#2e1a08');
    shadow = (Color-FromHex '#4a2a14');
    base   = (Color-FromHex '#7a4a24');
    high   = (Color-FromHex '#a86a34');
    top    = (Color-FromHex '#cc8c52');
  }

  # Base grass fill — vertical gradient (lighter at top, darker at bottom)
  for ($y = 0; $y -lt $h; $y++) {
    $t = $y / ($h - 1)
    $col = if ($t -lt 0.10) {
      $grassRamp.top
    } elseif ($t -lt 0.30) {
      $grassRamp.high
    } elseif ($t -lt 0.65) {
      $grassRamp.base
    } else {
      $grassRamp.shadow
    }
    for ($x = 0; $x -lt $w; $x++) {
      Set-Pixel $bmp $x $y $col
    }
  }

  # Grass tuft noise
  Rng-Init 'grass-tufts'
  for ($i = 0; $i -lt 3000; $i++) {
    $x = Rng-Range 0 ($w - 1)
    $y = Rng-Range 0 ($h - 1)
    $r = Rng-Pick 8
    if ($r -lt 2) {
      Set-Pixel $bmp $x $y $grassRamp.top
    } elseif ($r -lt 5) {
      Set-Pixel $bmp $x $y $grassRamp.shadow
    } else {
      Set-Pixel $bmp $x $y $grassRamp.high
    }
  }

  # Dirt path running diagonally across the grass — gentle curve
  for ($x = 0; $x -lt $w; $x++) {
    $pathY = 140 + [int]([Math]::Sin($x * 0.008) * 30)
    $halfW = 22 + [int]([Math]::Sin($x * 0.003) * 4)
    for ($dy = -$halfW; $dy -le $halfW; $dy++) {
      $depth = [Math]::Abs($dy) / [double]$halfW
      $col = if ($depth -lt 0.3) {
        $dirtRamp.high
      } elseif ($depth -lt 0.65) {
        $dirtRamp.base
      } else {
        $dirtRamp.shadow
      }
      Set-Pixel $bmp $x ($pathY + $dy) $col
    }
    # Path top edge highlight
    Set-Pixel $bmp $x ($pathY - $halfW) $dirtRamp.top
    Set-Pixel $bmp $x ($pathY + $halfW) $dirtRamp.deep
  }

  # Pebbles + tufts on the path
  Rng-Init 'grass-pebbles'
  for ($i = 0; $i -lt 60; $i++) {
    $x = Rng-Range 0 ($w - 1)
    $pathY = 140 + [int]([Math]::Sin($x * 0.008) * 30)
    $dy = Rng-Range -18 18
    Set-Pixel $bmp $x ($pathY + $dy) $MAT_STONE.high
    Set-Pixel $bmp ($x + 1) ($pathY + $dy) $MAT_STONE.shadow
  }

  # Wildflowers scattered on the grass
  Rng-Init 'grass-flowers'
  for ($i = 0; $i -lt 80; $i++) {
    $x = Rng-Range 30 ($w - 30)
    $y = Rng-Range 8 ($h - 8)
    # Skip if on the path zone
    $pathY = 140 + [int]([Math]::Sin($x * 0.008) * 30)
    if ([Math]::Abs($y - $pathY) -lt 30) { continue }
    $color = switch ((Rng-Pick 5)) {
      0 { $BRAND.GoldHi }
      1 { Color-FromHex '#f8b0c8' }
      2 { Color-FromHex '#c0a0ff' }
      3 { $BRAND.Crimson }
      default { Color-FromHex '#f0e6c8' }
    }
    Set-Pixel $bmp $x $y $color
    Set-Pixel $bmp ($x - 1) $y $color
    Set-Pixel $bmp ($x + 1) $y $color
    Set-Pixel $bmp $x ($y - 1) $color
    Set-Pixel $bmp $x ($y + 1) (Mix-Color $color (Color-FromHex '#000000') 0.4)
    # Tiny stem
    Set-Pixel $bmp $x ($y + 2) $grassRamp.shadow
  }

  # Mushrooms on the shaded patches
  Rng-Init 'grass-mushrooms'
  for ($i = 0; $i -lt 12; $i++) {
    $x = Rng-Range 60 ($w - 60)
    $y = Rng-Range 30 ($h - 40)
    $pathY = 140 + [int]([Math]::Sin($x * 0.008) * 30)
    if ([Math]::Abs($y - $pathY) -lt 30) { continue }
    # Stem
    Fill-Box $bmp $x $y 2 4 (Color-FromHex '#f8e8c8')
    # Cap
    Fill-Box $bmp ($x - 1) ($y - 2) 4 2 $BRAND.Crimson
    Set-Pixel $bmp $x ($y - 2) (Color-FromHex '#ff7080')
    Set-Pixel $bmp ($x + 1) ($y - 1) (Color-FromHex '#ffd0d8')
  }

  Save-CanvasFx $bmp (Join-Path $backdropDir 'grass.png')
  Write-Host '  grass.png      1152×384' -ForegroundColor DarkGray
}

# ── Composite preview — single image showing all layers stacked ─────

function Build-CompositePreview {
  # Stacks the layers vertically so the design doc / aquilo-site
  # team can sanity-check the parallax look without writing a
  # tiling shader. Output is 1152 × 1024.
  $skyPath       = Join-Path $backdropDir 'sky.png'
  $mountainsPath = Join-Path $backdropDir 'mountains.png'
  $hillsPath     = Join-Path $backdropDir 'hills.png'
  $forestPath    = Join-Path $backdropDir 'forest.png'
  $grassPath     = Join-Path $backdropDir 'grass.png'
  $w = 1152; $h = 1024
  $bmp = New-CanvasFx $w $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  # Sky fills the top half
  $sky = [System.Drawing.Image]::FromFile($skyPath)
  $g.DrawImage($sky, 0, 0, 1152, 512)
  $sky.Dispose()
  # Mountains overlay starting at y=320
  $mountains = [System.Drawing.Image]::FromFile($mountainsPath)
  $g.DrawImage($mountains, 0, 320, 1152, 256)
  $mountains.Dispose()
  # Hills at y=512
  $hills = [System.Drawing.Image]::FromFile($hillsPath)
  $g.DrawImage($hills, 0, 512, 1152, 192)
  $hills.Dispose()
  # Forest at y=608
  $forest = [System.Drawing.Image]::FromFile($forestPath)
  $g.DrawImage($forest, 0, 608, 1152, 160)
  $forest.Dispose()
  # Grass at y=640
  $grass = [System.Drawing.Image]::FromFile($grassPath)
  $g.DrawImage($grass, 0, 640, 1152, 384)
  $grass.Dispose()
  $g.Dispose()
  Save-CanvasFx $bmp (Join-Path $backdropDir 'composite-preview.png')
  Write-Host '  composite-preview.png' -ForegroundColor DarkGray
}

Write-Host '── v2 backdrop layers ──' -ForegroundColor Cyan
Build-Sky
Build-Mountains
Build-Hills
Build-Forest
Build-Grass
Build-CompositePreview
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "Output: $backdropDir"
