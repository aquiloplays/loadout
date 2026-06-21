# Loadout — generate the aquilo.gg brand mark at multiple resolutions
# and pack into a Windows .ico. Source of truth is `assets\Loadout.svg`;
# this script faithfully reproduces that SVG via GDI+ so we don't need
# an external rasteriser on the build box.
#
# Visual language (aquilo.gg palette):
#   • Dark rounded square tile with a radial gradient (warm-dark ->
#     deep-near-black) so it lifts from any background
#   • Soft violet glow disc behind the mark
#   • Loadout slot grid: 3 columns x 2 rows of equipment slots, with
#     the top-center slot "equipped" (violet -> green aurora gradient
#     fill + white selection dot). Top-row slots stroke in violet,
#     bottom-row in teal-green — the signature aquilo aurora colour
#     pair, but as discrete slots rather than a bolt so the icon
#     reads as "your loadout panel" and doesn't collide with
#     StreamFusion's bolt-on-disc design.
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
    # SVG: circle cx=512 cy=512 r=338, radial #7c5cff @ alphas
    # 0.62 -> 0.16 -> 0 at edge. Centered on canvas to match the
    # centered slot grid below.
    $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $glowR = 338.0 * $s
    $glowPath.AddEllipse((512.0 * $s - $glowR), (512.0 * $s - $glowR), ($glowR * 2), ($glowR * 2))
    $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
    $glowBrush.CenterPoint = New-Object System.Drawing.PointF((512.0 * $s), (512.0 * $s))
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

    # ===== Loadout slot grid =========================================
    # SVG: 3x2 grid of equipment slots, centered on the canvas (512,512).
    # Top-center is "equipped" with an aurora gradient fill + glow +
    # white selection dot. Other slots are hollow strokes (top row
    # violet, bottom row teal-green).
    #
    # SVG coords (matches assets/Loadout.svg):
    #   Empty slots: 200x200 rect, r=42, stroke-width=14
    #     TL (150,302)  TR (674,302)
    #     BL (150,542)  BM (412,542)  BR (674,542)
    #   Equipped slot: 240x240 rect at (392,282), r=50
    #     Selection dot at (512,402) r=32
    #
    # At very small sizes (16/24) we collapse the grid to 3 horizontal
    # bars with one accented so the icon stays readable.
    if ($size -le 24) {
        # Tiny-size variant: 3 stacked bars across the middle, middle
        # one fully aurora-coloured to act as the focal indicator.
        $barW = $size * 0.65
        $barH = $size * 0.10
        $barX = ($size - $barW) / 2.0
        $barGap = $size * 0.07
        $barY0 = ($size - ($barH * 3 + $barGap * 2)) / 2.0

        $barRect = New-Object System.Drawing.RectangleF([single]$barX, [single]$barY0, [single]$barW, [single]$barH)
        $barBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            $barRect,
            [System.Drawing.Color]::FromArgb(255, 0xA9, 0x8F, 0xFF),
            [System.Drawing.Color]::FromArgb(255, 0x5B, 0xFF, 0x95),
            [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)

        # Top bar (violet outline)
        $topBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 0x9A, 0x82, 0xFF))
        $g.FillRectangle($topBrush, [single]$barX, [single]$barY0, [single]$barW, [single]$barH)
        $topBrush.Dispose()
        # Middle bar (active - aurora gradient)
        $midY = $barY0 + ($barH + $barGap)
        $midRect = New-Object System.Drawing.RectangleF([single]$barX, [single]$midY, [single]$barW, [single]$barH)
        $midBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            $midRect,
            [System.Drawing.Color]::FromArgb(255, 0xA9, 0x8F, 0xFF),
            [System.Drawing.Color]::FromArgb(255, 0x5B, 0xFF, 0x95),
            [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
        $g.FillRectangle($midBrush, $midRect)
        $midBrush.Dispose()
        # Bottom bar (teal-green outline)
        $botY = $barY0 + 2 * ($barH + $barGap)
        $botBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 0x5B, 0xFF, 0x95))
        $g.FillRectangle($botBrush, [single]$barX, [single]$botY, [single]$barW, [single]$barH)
        $botBrush.Dispose()
        $barBrush.Dispose()
    }
    else {
        # Full grid render.
        $slotW = 200.0 * $s
        $slotH = 200.0 * $s
        $slotR = 42.0 * $s
        $stroke = [single][Math]::Max(2.0, 14.0 * $s)

        # ---- Equipped slot (top middle) ----------------------------
        $eqX = 392.0 * $s; $eqY = 282.0 * $s; $eqW = 240.0 * $s; $eqH = 240.0 * $s; $eqR = 50.0 * $s
        $eqPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        Add-RoundedRect $eqPath ([single]$eqX) ([single]$eqY) ([single]$eqW) ([single]$eqH) ([single]$eqR)

        # Glow halo behind the equipped slot (sizes >=64 only).
        if ($size -ge 64) {
            $haloBmp = New-Object System.Drawing.Bitmap($size, $size)
            $hg = [System.Drawing.Graphics]::FromImage($haloBmp)
            $hg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $hg.Clear([System.Drawing.Color]::Transparent)
            $haloBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 0x7C, 0x5C, 0xFF))
            $hg.FillPath($haloBrush, $eqPath)
            $haloBrush.Dispose()
            $hg.Dispose()
            $radius = [int][Math]::Max(1, $size * 0.025)
            $img = [System.Drawing.Imaging.ImageAttributes]::new()
            $cm = [System.Drawing.Imaging.ColorMatrix]::new()
            $cm.Matrix33 = 0.14
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

        # Equipped fill - aurora gradient.
        $eqRect = New-Object System.Drawing.RectangleF([single]$eqX, [single]$eqY, [single]$eqW, [single]$eqH)
        $eqBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            $eqRect,
            [System.Drawing.Color]::FromArgb(255, 0xA9, 0x8F, 0xFF),
            [System.Drawing.Color]::FromArgb(255, 0x5B, 0xFF, 0x95),
            [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
        $g.FillPath($eqBrush, $eqPath)
        $eqBrush.Dispose()
        # Equipped white border ring for emphasis.
        $eqPen = New-Object System.Drawing.Pen(
            [System.Drawing.Color]::FromArgb(220, 255, 255, 255),
            [single][Math]::Max(2.0, 10.0 * $s))
        $g.DrawPath($eqPen, $eqPath)
        $eqPen.Dispose()
        $eqPath.Dispose()

        # ---- Empty slots (5 of them) -------------------------------
        function Add-EmptySlot([single]$x, [single]$y, [int]$colorRgb) {
            $p = New-Object System.Drawing.Drawing2D.GraphicsPath
            Add-RoundedRect $p $x $y $slotW $slotH $slotR
            $col = [System.Drawing.Color]::FromArgb(
                220,
                (($colorRgb -shr 16) -band 0xFF),
                (($colorRgb -shr 8) -band 0xFF),
                ($colorRgb -band 0xFF))
            $pen = New-Object System.Drawing.Pen($col, $stroke)
            $g.DrawPath($pen, $p)
            $pen.Dispose()
            $p.Dispose()
        }

        # Top row left + right (violet) — y=302
        Add-EmptySlot ([single](150.0 * $s)) ([single](302.0 * $s)) 0x9A82FF
        Add-EmptySlot ([single](674.0 * $s)) ([single](302.0 * $s)) 0x9A82FF
        # Bottom row (teal-green) — y=542
        Add-EmptySlot ([single](150.0 * $s)) ([single](542.0 * $s)) 0x5BFF95
        Add-EmptySlot ([single](412.0 * $s)) ([single](542.0 * $s)) 0x5BFF95
        Add-EmptySlot ([single](674.0 * $s)) ([single](542.0 * $s)) 0x5BFF95

        # ---- Selection dot inside the equipped slot ----------------
        # Equipped slot center: x = 392 + 240/2 = 512; y = 282 + 240/2 = 402.
        $dotR = 32.0 * $s
        $dotX = (512.0 * $s) - $dotR
        $dotY = (402.0 * $s) - $dotR
        $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
        $g.FillEllipse($dotBrush, [single]$dotX, [single]$dotY, [single]($dotR * 2), [single]($dotR * 2))
        $dotBrush.Dispose()
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
