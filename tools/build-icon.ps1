# Loadout — generate the brand icon at multiple resolutions and pack into a
# Windows .ico file. Visual language pairs with StreamFusion: circular dark
# badge + cyan/blue gradient mark. Loadout's mark is a chunky "L" cut from
# the badge, with a small tab at the foot suggesting an ammo-clip / loadout
# silhouette.
#
# Output:
#   assets\Loadout.ico   (16, 32, 48, 64, 128, 256)
#   assets\Loadout.png   (256x256 preview)
[CmdletBinding()]
param(
    [int[]]$Sizes = @(16, 32, 48, 64, 128, 256)
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $repoRoot "assets"
New-Item -ItemType Directory -Force -Path $assets | Out-Null

function New-LoadoutBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Outer glow ring — fade from accent cyan/blue
    $center = $size / 2.0
    $outerR = $size * 0.49
    $innerR = $size * 0.42
    $glowRect = New-Object System.Drawing.RectangleF(($center - $outerR), ($center - $outerR), ($outerR * 2), ($outerR * 2))
    $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $glowPath.AddEllipse($glowRect)

    $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
    $glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(255, 58, 134, 255)   # #3A86FF
    $glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0, 242, 234)) # transparent cyan edge
    $g.FillEllipse($glowBrush, $glowRect)

    # Inner dark badge
    $badgeRect = New-Object System.Drawing.RectangleF(($center - $innerR), ($center - $innerR), ($innerR * 2), ($innerR * 2))
    $badgeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 14, 14, 16))  # #0E0E10
    $g.FillEllipse($badgeBrush, $badgeRect)

    # Thin accent ring on the inner edge of the badge
    $ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 58, 134, 255), [Math]::Max(1, $size * 0.012))
    $g.DrawEllipse($ringPen, $badgeRect)

    # The "L" mark — thick stroke, blue→cyan gradient, top-of-stem to bottom-of-foot
    $strokeWidth = [Math]::Max(2.0, $size * 0.13)
    $left  = $center - ($innerR * 0.40)
    $top   = $center - ($innerR * 0.55)
    $bot   = $center + ($innerR * 0.55)
    $right = $center + ($innerR * 0.40)

    $gradRect = New-Object System.Drawing.RectangleF(($left - $strokeWidth), ($top - $strokeWidth), (($right - $left) + $strokeWidth * 2), (($bot - $top) + $strokeWidth * 2))
    $gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $gradRect,
        [System.Drawing.Color]::FromArgb(255, 90, 156, 255),    # lighter blue at top
        [System.Drawing.Color]::FromArgb(255, 0, 242, 234),     # cyan at bottom
        [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)

    $pen = New-Object System.Drawing.Pen($gradBrush, $strokeWidth)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    # Vertical stem
    $g.DrawLine($pen, [single]$left, [single]$top, [single]$left, [single]$bot)
    # Horizontal foot
    $g.DrawLine($pen, [single]$left, [single]$bot, [single]$right, [single]$bot)

    # Small tab at the foot end — the "loadout ammo-clip" cue. Skipped at <=32px
    # where it just becomes noise.
    if ($size -gt 32) {
        $tabH = $strokeWidth * 0.85
        $tabW = $strokeWidth * 0.55
        $tabRect = New-Object System.Drawing.RectangleF(
            [single]($right - $tabW * 0.15),
            [single]($bot - $tabH * 0.5 - $strokeWidth * 0.5),
            [single]$tabW,
            [single]$tabH)
        $tabBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0, 242, 234))
        $g.FillRectangle($tabBrush, $tabRect)
    }

    $g.Dispose()
    return $bmp
}

# Render preview PNG at 256
$preview = New-LoadoutBitmap 256
$pngPath = Join-Path $assets "Loadout.png"
$preview.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Preview: $pngPath"
$preview.Dispose()

# Build .ico file — manually, since System.Drawing.Icon doesn't expose multi-resolution.
$bitmaps = @{}
foreach ($s in $Sizes) { $bitmaps[$s] = New-LoadoutBitmap $s }

$icoPath = Join-Path $assets "Loadout.ico"
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)

# ICONDIR (6 bytes)
$bw.Write([uint16]0)            # reserved
$bw.Write([uint16]1)            # type = icon
$bw.Write([uint16]$Sizes.Length)

# Encode each PNG — modern Windows accepts PNG in .ico for 256x256 etc.
$pngBlobs = @{}
foreach ($s in $Sizes) {
    $tmp = New-Object System.IO.MemoryStream
    $bitmaps[$s].Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBlobs[$s] = $tmp.ToArray()
    $tmp.Dispose()
}

# Compute offsets — directory entries follow the ICONDIR.
$dirEntrySize = 16
$offset = 6 + $dirEntrySize * $Sizes.Length

# Write directory entries
foreach ($s in $Sizes) {
    $blob = $pngBlobs[$s]
    $width  = if ($s -ge 256) { 0 } else { $s }   # 0 = 256 in ICO header
    $height = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$width)
    $bw.Write([byte]$height)
    $bw.Write([byte]0)            # palette
    $bw.Write([byte]0)            # reserved
    $bw.Write([uint16]1)          # color planes
    $bw.Write([uint16]32)         # bits per pixel
    $bw.Write([uint32]$blob.Length)
    $bw.Write([uint32]$offset)
    $offset += $blob.Length
}

# Write image data
foreach ($s in $Sizes) { $bw.Write($pngBlobs[$s]) }

[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Close()

foreach ($b in $bitmaps.Values) { $b.Dispose() }
Write-Host "Icon: $icoPath ($((Get-Item $icoPath).Length) bytes)"
