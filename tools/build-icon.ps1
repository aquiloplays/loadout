# Loadout - generate the brand mark at multiple resolutions and pack into a
# Windows .ico. Visual language is intentionally aligned with StreamFusion:
# circular dark badge + cyan/blue gradient mark, so the two products read
# as a family.
#
# Loadout's mark is a bold geometric "L" with a small accent dot at the
# end of the foot - the dot reads as a status/loaded indicator and gives
# the silhouette a deliberate finish. Earlier iterations tried a magazine
# notch on top of the stem, but at icon sizes that read as a bottle/
# syringe rather than a loadout cue, so it was dropped.
#
# Refinements over v1:
#   - Outer halo is a soft, single-blur ring (no muddy radial fade)
#   - Badge is solid (#0E0E10) - cleaner against any wallpaper
#   - L is a single rounded "corner" shape (one path, one fill) with a
#     proper inner-corner radius - no overlapping rectangles
#   - Three-stop gradient (deep blue -> azure -> cyan) reads richer
#   - Subtle gloss highlight on the upper-left of the stem
#   - A small cyan dot just past the right end of the foot - a tiny
#     punctuation mark that reads as "loaded / ready"
#
# Output:
#   assets\Loadout.ico   (16, 24, 32, 48, 64, 128, 256)
#   assets\Loadout.png   (256x256 preview)
[CmdletBinding()]
param(
    [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $repoRoot "assets"
New-Item -ItemType Directory -Force -Path $assets | Out-Null

# Helper: rounded rectangle path. Fills clockwise from top-left.
function Add-RoundedRect {
    param($path, $rect, $r)
    $d = $r * 2
    $x = $rect.X; $y = $rect.Y; $w = $rect.Width; $h = $rect.Height
    if ($d -gt $w) { $d = $w }
    if ($d -gt $h) { $d = $h }
    $path.StartFigure()
    $path.AddArc([single]$x,             [single]$y,             [single]$d, [single]$d, [single]180, [single]90)
    $path.AddArc([single]($x + $w - $d), [single]$y,             [single]$d, [single]$d, [single]270, [single]90)
    $path.AddArc([single]($x + $w - $d), [single]($y + $h - $d), [single]$d, [single]$d, [single]0,   [single]90)
    $path.AddArc([single]$x,             [single]($y + $h - $d), [single]$d, [single]$d, [single]90,  [single]90)
    $path.CloseFigure()
}

function New-LoadoutBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $cx = $size / 2.0
    $cy = $size / 2.0

    # ===== Outer halo ================================================
    # Soft blue glow ring outside the badge. PathGradientBrush lets us
    # fade from transparent center -> tinted edge so the result is a
    # ring, not a disc. Skipped at small sizes where it just blurs.
    if ($size -ge 32) {
        $haloR = $size * 0.495
        $haloPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        $haloPath.AddEllipse(
            [single]($cx - $haloR), [single]($cy - $haloR),
            [single]($haloR * 2),   [single]($haloR * 2))
        $haloBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($haloPath)
        $haloBrush.CenterColor = [System.Drawing.Color]::FromArgb(0, 58, 134, 255)
        $haloBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(150, 58, 134, 255))
        $haloBrush.FocusScales = New-Object System.Drawing.PointF(0.86, 0.86)
        $g.FillPath($haloBrush, $haloPath)
        $haloBrush.Dispose()
        $haloPath.Dispose()
    }

    # ===== Badge =====================================================
    # Inner dark disc. Slightly inset so the halo can breathe.
    $badgeR = if ($size -ge 32) { $size * 0.455 } else { $size * 0.49 }
    $badgeRect = New-Object System.Drawing.RectangleF(
        [single]($cx - $badgeR), [single]($cy - $badgeR),
        [single]($badgeR * 2),   [single]($badgeR * 2))
    $badgeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 14, 14, 16))
    $g.FillEllipse($badgeBrush, $badgeRect)

    # Hairline ring on the badge edge - keeps the silhouette crisp on
    # light wallpapers.
    if ($size -ge 32) {
        $edgePen = New-Object System.Drawing.Pen(
            [System.Drawing.Color]::FromArgb(220, 42, 42, 48),
            [single]([Math]::Max(1.0, $size * 0.008)))
        $g.DrawEllipse($edgePen, $badgeRect)
        $edgePen.Dispose()
    }

    # ===== L mark (single path) ======================================
    # Build the L as one closed polyline so we get a proper inner corner
    # at the junction between stem and foot. All measurements are in
    # normalized "unit" space scaled off the badge radius.
    $unit = $badgeR * 0.92
    $thick = $unit * 0.30           # thickness of the bar
    $stemHeight = $unit * 1.15
    $footWidth  = $unit * 0.95

    # Position the L slightly left+down of center for visual balance
    # (the foot-cap dot extends to the right; without offset the mark
    # would sit too far right).
    $lLeft   = $cx - $unit * 0.42
    $lTop    = $cy - $stemHeight / 2
    $lBot    = $cy + $stemHeight / 2
    $lRight  = $lLeft + $footWidth

    $stemRight = $lLeft + $thick
    $footTop   = $lBot - $thick

    # Round only the outside corners (top-left, top-right of stem;
    # bottom-right of foot). Inner corner is square - more architectural.
    # Round corners as a fraction of thickness.
    $rOut = $thick * 0.30
    $rIn  = $thick * 0.10

    $lPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $lPath.StartFigure()
    # Top-left of stem (rounded out)
    $lPath.AddArc([single]$lLeft,                  [single]$lTop,           [single]($rOut * 2), [single]($rOut * 2), [single]180, [single]90)
    # Top-right of stem (rounded out)
    $lPath.AddArc([single]($stemRight - $rOut * 2),[single]$lTop,           [single]($rOut * 2), [single]($rOut * 2), [single]270, [single]90)
    # Down to inner corner
    $lPath.AddLine([single]$stemRight, [single]($lTop + $rOut), [single]$stemRight, [single]($footTop - $rIn))
    # Inner corner (small radius, concave)
    $lPath.AddArc([single]$stemRight, [single]($footTop - $rIn * 2), [single]($rIn * 2), [single]($rIn * 2), [single]180, [single]-90)
    # Across to right end of foot top
    $lPath.AddLine([single]($stemRight + $rIn), [single]$footTop, [single]($lRight - $rOut), [single]$footTop)
    # Top-right of foot (rounded out)
    $lPath.AddArc([single]($lRight - $rOut * 2), [single]$footTop, [single]($rOut * 2), [single]($rOut * 2), [single]270, [single]90)
    # Down right edge of foot
    $lPath.AddLine([single]$lRight, [single]($footTop + $rOut), [single]$lRight, [single]($lBot - $rOut))
    # Bottom-right of foot (rounded out)
    $lPath.AddArc([single]($lRight - $rOut * 2), [single]($lBot - $rOut * 2), [single]($rOut * 2), [single]($rOut * 2), [single]0, [single]90)
    # Across to bottom-left of stem
    $lPath.AddLine([single]($lRight - $rOut), [single]$lBot, [single]($lLeft + $rOut), [single]$lBot)
    # Bottom-left of stem (rounded out)
    $lPath.AddArc([single]$lLeft, [single]($lBot - $rOut * 2), [single]($rOut * 2), [single]($rOut * 2), [single]90, [single]90)
    # Up the left edge back to start
    $lPath.AddLine([single]$lLeft, [single]($lBot - $rOut), [single]$lLeft, [single]($lTop + $rOut))
    $lPath.CloseFigure()

    # Three-stop gradient spanning the full L bounding box (top-left to
    # bottom-right) so the cyan punch lands on the foot.
    $gradRect = New-Object System.Drawing.RectangleF(
        [single]$lLeft, [single]$lTop,
        [single]($lRight - $lLeft), [single]($lBot - $lTop))
    $gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $gradRect,
        [System.Drawing.Color]::FromArgb(255, 90, 156, 255),
        [System.Drawing.Color]::FromArgb(255, 0, 242, 234),
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
    $blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
    $blend.Colors = @(
        [System.Drawing.Color]::FromArgb(255, 90, 156, 255),
        [System.Drawing.Color]::FromArgb(255, 58, 200, 255),
        [System.Drawing.Color]::FromArgb(255, 0, 242, 234)
    )
    $blend.Positions = @(0.0, 0.55, 1.0)
    $gradBrush.InterpolationColors = $blend

    $g.FillPath($gradBrush, $lPath)

    # ===== Loaded indicator dot ======================================
    # A small cyan dot just past the right end of the foot. Reads as
    # "ready / loaded" and gives the silhouette a deliberate finish.
    # Skipped at <=24px - too small to read.
    if ($size -ge 32) {
        $dotR = $thick * 0.32
        $dotCx = $lRight + $thick * 0.85
        $dotCy = $lBot - $thick / 2
        # Only draw if it fits inside the badge with breathing room
        $maxX = $cx + $badgeR * 0.92
        if (($dotCx + $dotR) -le $maxX) {
            $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0, 242, 234))
            $g.FillEllipse($dotBrush,
                [single]($dotCx - $dotR), [single]($dotCy - $dotR),
                [single]($dotR * 2),      [single]($dotR * 2))
            # Tiny inner highlight on the dot
            if ($size -ge 64) {
                $dotHi = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(120, 255, 255, 255))
                $hiR = $dotR * 0.45
                $g.FillEllipse($dotHi,
                    [single]($dotCx - $dotR * 0.45 - $hiR / 2),
                    [single]($dotCy - $dotR * 0.50 - $hiR / 2),
                    [single]$hiR, [single]$hiR)
                $dotHi.Dispose()
            }
            $dotBrush.Dispose()
        }
    }

    # ===== Gloss highlight ===========================================
    # Very subtle gloss along the top-left of the stem. Adds depth
    # without skeuomorphism. Only at large sizes.
    if ($size -ge 64) {
        $glossPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        $glossRect = New-Object System.Drawing.RectangleF(
            [single]($lLeft + $thick * 0.18),
            [single]($lTop  + $thick * 0.18),
            [single]($thick * 0.32),
            [single]($stemHeight * 0.32))
        Add-RoundedRect $glossPath $glossRect ([Math]::Max(1.0, $thick * 0.10))
        $glossBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 255, 255, 255))
        $g.FillPath($glossBrush, $glossPath)
        $glossBrush.Dispose()
        $glossPath.Dispose()
    }

    $gradBrush.Dispose()
    $lPath.Dispose()
    $badgeBrush.Dispose()
    $g.Dispose()
    return $bmp
}

# Render preview PNG at 256
$preview = New-LoadoutBitmap 256
$pngPath = Join-Path $assets "Loadout.png"
$preview.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Preview: $pngPath"
$preview.Dispose()

# Build .ico - manual write so we can pack PNG-encoded entries (modern
# Windows accepts PNG inside .ico for sizes >= 256). The directory
# header lists each entry's byte offset in the file.
$bitmaps = @{}
foreach ($s in $Sizes) { $bitmaps[$s] = New-LoadoutBitmap $s }

$icoPath = Join-Path $assets "Loadout.ico"
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)

$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$Sizes.Length)

$pngBlobs = @{}
foreach ($s in $Sizes) {
    $tmp = New-Object System.IO.MemoryStream
    $bitmaps[$s].Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBlobs[$s] = $tmp.ToArray()
    $tmp.Dispose()
}

$dirEntrySize = 16
$offset = 6 + $dirEntrySize * $Sizes.Length

foreach ($s in $Sizes) {
    $blob = $pngBlobs[$s]
    $width  = if ($s -ge 256) { 0 } else { $s }
    $height = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$width)
    $bw.Write([byte]$height)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$blob.Length)
    $bw.Write([uint32]$offset)
    $offset += $blob.Length
}

foreach ($s in $Sizes) { $bw.Write($pngBlobs[$s]) }

[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Close()

foreach ($b in $bitmaps.Values) { $b.Dispose() }
Write-Host "Icon: $icoPath ($((Get-Item $icoPath).Length) bytes)"
