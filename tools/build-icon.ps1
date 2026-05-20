# Loadout — generate the aquilo.gg brand mark at multiple resolutions
# and pack into a Windows .ico. Source of truth is `assets\Loadout.svg`;
# this script faithfully reproduces that SVG via GDI+ so we don't need
# an external rasteriser on the build box.
#
# Visual language (aquilo.gg palette):
#   • Dark rounded square tile with a radial gradient (warm-dark ->
#     deep-near-black) so it lifts from any background
#   • Soft violet glow disc behind the mark
#   • Lightning bolt: multi-stop linear gradient violet -> teal-green
#     (#a98fff -> #7c5cff -> #6ee0c0 -> #5bff95) — the signature
#     aquilo "purple lights up green when it hits"
#   • White highlight wedge on the upper half of the bolt for depth
#   • Subtle violet->green gradient hairline ring on the tile edge
#
# Output:
#   assets\Loadout.ico   (16, 24, 32, 48, 64, 128, 256)
#   assets\Loadout.png   (1024x1024 master + the .ico is generated
#                         from per-size renders so sub-icon sizes
#                         look proper instead of being a downsample)
[CmdletBinding()]
param(
    [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $repoRoot "assets"
New-Item -ItemType Directory -Force -Path $assets | Out-Null

# Helper: rounded rectangle path
function Add-RoundedRect {
    param($path, [single]$x, [single]$y, [single]$w, [single]$h, [single]$r)
    $d = $r * 2
    if ($d -gt $w) { $d = $w }
    if ($d -gt $h) { $d = $h }
    $path.StartFigure()
    $path.AddArc($x,             $y,             $d, $d, [single]180, [single]90)
    $path.AddArc(($x + $w - $d), $y,             $d, $d, [single]270, [single]90)
    $path.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, [single]0,   [single]90)
    $path.AddArc($x,             ($y + $h - $d), $d, $d, [single]90,  [single]90)
    $path.CloseFigure()
}

# All coordinates inside this function are expressed in the SVG's
# 1024x1024 viewBox, then scaled into the target bitmap. That keeps
# the geometry identical to assets/Loadout.svg so a future SVG tweak
# only needs to land here once.
function New-LoadoutBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = [single]($size / 1024.0)   # scale factor SVG-space -> bitmap

    # ===== Tile geometry =============================================
    # Rounded square inset by 6 on each side in SVG-space.
    $tileX = 6.0 * $s; $tileY = 6.0 * $s
    $tileW = 1012.0 * $s; $tileH = 1012.0 * $s
    # Radius scales with the tile so the silhouette stays a "rounded
    # square" at every size. At very small sizes we clamp so it
    # doesn't read as a circle.
    $tileR = [Math]::Min(238.0 * $s, ($tileW * 0.235))

    $tilePath = New-Object System.Drawing.Drawing2D.GraphicsPath
    Add-RoundedRect $tilePath ([single]$tileX) ([single]$tileY) ([single]$tileW) ([single]$tileH) ([single]$tileR)

    # ===== Background radial fill ====================================
    # SVG: radial cx=0.5 cy=0.38 r=0.9, stops #1e2236 -> #11131c -> #080910
    # PathGradientBrush gives center-color + surround. Use an ellipse
    # path centered at (512, 389) with rx=ry= 0.9*max(w,h)/2 ~ 461.
    $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bgRx = 922.0 * $s; $bgRy = 922.0 * $s
    $bgCx = 512.0 * $s; $bgCy = 389.0 * $s
    $bgPath.AddEllipse(($bgCx - $bgRx), ($bgCy - $bgRy), ($bgRx * 2), ($bgRy * 2))
    $bgBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($bgPath)
    $bgBrush.CenterPoint = New-Object System.Drawing.PointF($bgCx, $bgCy)
    $bgBrush.CenterColor = [System.Drawing.Color]::FromArgb(255, 0x1E, 0x22, 0x36)
    $bgBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 0x08, 0x09, 0x10))
    $bgBlend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
    $bgBlend.Colors = @(
        [System.Drawing.Color]::FromArgb(255, 0x08, 0x09, 0x10),
        [System.Drawing.Color]::FromArgb(255, 0x11, 0x13, 0x1C),
        [System.Drawing.Color]::FromArgb(255, 0x1E, 0x22, 0x36)
    )
    # InterpolationColors are indexed from edge -> center
    $bgBlend.Positions = @(0.0, 0.5, 1.0)
    $bgBrush.InterpolationColors = $bgBlend

    # Clip to the rounded tile so the radial fill respects the corners.
    $g.SetClip($tilePath)
    $g.FillPath($bgBrush, $bgPath)

    # ===== White sheen overlay =======================================
    # SVG: linear y=0..1024, white@0.10 -> white@0 at 40%. Fill the
    # whole tile; clip already in place.
    $sheenRect = New-Object System.Drawing.RectangleF([single]$tileX, [single]$tileY, [single]$tileW, [single]$tileH)
    $sheenBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $sheenRect,
        [System.Drawing.Color]::FromArgb(26, 255, 255, 255),
        [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
        [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
    # Three-stop: 0 -> 0.4 fades, then transparent for the rest
    $sheenBlend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
    $sheenBlend.Colors = @(
        [System.Drawing.Color]::FromArgb(26, 255, 255, 255),
        [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
        [System.Drawing.Color]::FromArgb(0, 255, 255, 255)
    )
    $sheenBlend.Positions = @(0.0, 0.4, 1.0)
    $sheenBrush.InterpolationColors = $sheenBlend
    $g.FillRectangle($sheenBrush, $sheenRect)
    $sheenBrush.Dispose()

    # ===== Violet glow disc ==========================================
    # SVG: circle cx=512 cy=516 r=338, radial #7c5cff @ alphas
    # 0.62 -> 0.16 -> 0 at edge.
    $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $glowR = 338.0 * $s
    $glowPath.AddEllipse((512.0 * $s - $glowR), (516.0 * $s - $glowR), ($glowR * 2), ($glowR * 2))
    $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
    $glowBrush.CenterPoint = New-Object System.Drawing.PointF((512.0 * $s), (516.0 * $s))
    $glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(158, 0x7C, 0x5C, 0xFF)
    $glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0x7C, 0x5C, 0xFF))
    $glowBlend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
    $glowBlend.Colors = @(
        [System.Drawing.Color]::FromArgb(0,   0x7C, 0x5C, 0xFF),
        [System.Drawing.Color]::FromArgb(41,  0x7C, 0x5C, 0xFF),
        [System.Drawing.Color]::FromArgb(158, 0x7C, 0x5C, 0xFF)
    )
    $glowBlend.Positions = @(0.0, 0.38, 1.0)
    $glowBrush.InterpolationColors = $glowBlend
    $g.FillPath($glowBrush, $glowPath)
    $glowBrush.Dispose()
    $glowPath.Dispose()

    # ===== Lightning bolt path =======================================
    # SVG: M624 150 L360 562 L516 562 L404 876 L664 462 L508 462 Z
    $boltPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bp = @(
        (New-Object System.Drawing.PointF((624.0 * $s), (150.0 * $s))),
        (New-Object System.Drawing.PointF((360.0 * $s), (562.0 * $s))),
        (New-Object System.Drawing.PointF((516.0 * $s), (562.0 * $s))),
        (New-Object System.Drawing.PointF((404.0 * $s), (876.0 * $s))),
        (New-Object System.Drawing.PointF((664.0 * $s), (462.0 * $s))),
        (New-Object System.Drawing.PointF((508.0 * $s), (462.0 * $s)))
    )
    $boltPath.AddPolygon($bp)

    # ----- Soft violet halo behind the bolt (the SVG `filter=blur` copy)
    # Only at sizes where the blur would actually read (>=64).
    if ($size -ge 64) {
        $haloBmp = New-Object System.Drawing.Bitmap($size, $size)
        $hg = [System.Drawing.Graphics]::FromImage($haloBmp)
        $hg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $hg.Clear([System.Drawing.Color]::Transparent)
        $haloBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 0x8A, 0x72, 0xFF))
        $hg.FillPath($haloBrush, $boltPath)
        $haloBrush.Dispose()
        $hg.Dispose()
        # A cheap one-pass blur: draw the halo bitmap a few times with
        # slight offsets at low opacity. Not a true Gaussian, but at the
        # icon sizes the eye can't tell the difference and we avoid
        # pulling in System.Windows.Media.Effects from a script.
        $radius = [int][Math]::Max(1, $size * 0.018)
        $passAlpha = 0.18
        $img = [System.Drawing.Imaging.ImageAttributes]::new()
        $cm = [System.Drawing.Imaging.ColorMatrix]::new()
        $cm.Matrix33 = $passAlpha
        $img.SetColorMatrix($cm)
        for ($dx = -$radius; $dx -le $radius; $dx += [int][Math]::Max(1, $radius / 2)) {
            for ($dy = -$radius; $dy -le $radius; $dy += [int][Math]::Max(1, $radius / 2)) {
                $destRect = New-Object System.Drawing.Rectangle($dx, $dy, $size, $size)
                $g.DrawImage($haloBmp, $destRect, 0, 0, $size, $size,
                    [System.Drawing.GraphicsUnit]::Pixel, $img)
            }
        }
        $img.Dispose()
        $haloBmp.Dispose()
    }

    # ----- Bolt fill with the signature gradient -----------------
    # SVG: linear from (300,150) -> (700,880), stops:
    #   0    #a98fff
    #   0.42 #7c5cff
    #   0.78 #6ee0c0
    #   1    #5bff95
    $gradRect = New-Object System.Drawing.RectangleF(
        (300.0 * $s), (150.0 * $s),
        (400.0 * $s), (730.0 * $s))
    $boltBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $gradRect,
        [System.Drawing.Color]::FromArgb(255, 0xA9, 0x8F, 0xFF),
        [System.Drawing.Color]::FromArgb(255, 0x5B, 0xFF, 0x95),
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
    $boltBlend = New-Object System.Drawing.Drawing2D.ColorBlend(4)
    $boltBlend.Colors = @(
        [System.Drawing.Color]::FromArgb(255, 0xA9, 0x8F, 0xFF),
        [System.Drawing.Color]::FromArgb(255, 0x7C, 0x5C, 0xFF),
        [System.Drawing.Color]::FromArgb(255, 0x6E, 0xE0, 0xC0),
        [System.Drawing.Color]::FromArgb(255, 0x5B, 0xFF, 0x95)
    )
    $boltBlend.Positions = @(0.0, 0.42, 0.78, 1.0)
    $boltBrush.InterpolationColors = $boltBlend
    $g.FillPath($boltBrush, $boltPath)
    $boltBrush.Dispose()

    # ----- White highlight wedge on the upper part of the bolt -----
    # SVG: M624 150 L360 562 L516 562 L508 462 Z, white @ 0.16
    if ($size -ge 32) {
        $hiPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        $hp = @(
            (New-Object System.Drawing.PointF((624.0 * $s), (150.0 * $s))),
            (New-Object System.Drawing.PointF((360.0 * $s), (562.0 * $s))),
            (New-Object System.Drawing.PointF((516.0 * $s), (562.0 * $s))),
            (New-Object System.Drawing.PointF((508.0 * $s), (462.0 * $s)))
        )
        $hiPath.AddPolygon($hp)
        $hiBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(41, 255, 255, 255))
        $g.FillPath($hiBrush, $hiPath)
        $hiBrush.Dispose()
        $hiPath.Dispose()
    }

    # ===== Ring border (violet -> green hairline) ====================
    # SVG: stroke-width=5, opacity=0.55, linear (0,0)->(1024,1024)
    # Reset clip first so the stroke renders on the tile edge cleanly.
    $g.ResetClip()
    if ($size -ge 24) {
        $ringRect = New-Object System.Drawing.RectangleF([single]$tileX, [single]$tileY, [single]$tileW, [single]$tileH)
        $ringBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.RectangleF(0, 0, ($size + 1), ($size + 1))),
            [System.Drawing.Color]::FromArgb(140, 0x9A, 0x82, 0xFF),
            [System.Drawing.Color]::FromArgb(140, 0x5B, 0xFF, 0x95),
            [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
        $penW = [single][Math]::Max(1.0, 5.0 * $s)
        $ringPen = New-Object System.Drawing.Pen($ringBrush, $penW)
        $g.DrawPath($ringPen, $tilePath)
        $ringPen.Dispose()
        $ringBrush.Dispose()
    }

    $tilePath.Dispose()
    $bgBrush.Dispose()
    $g.Dispose()
    return $bmp
}

# Render preview PNG at 1024x1024 (master) for README / external use.
$preview = New-LoadoutBitmap 1024
$pngPath = Join-Path $assets "Loadout.png"
$preview.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Preview: $pngPath ($((Get-Item $pngPath).Length) bytes)"
$preview.Dispose()

# Build .ico — manual write so we can pack PNG-encoded entries (modern
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
