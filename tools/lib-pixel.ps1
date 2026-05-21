# Shared HD pixel-art primitives.
#
# Dot-source from build-sprites.ps1 and build-clash-sprites.ps1. Both
# scripts share the new (Phase-4) quality bar: larger canvases, 5-6
# tone material ramps, single upper-left light source with rim light,
# surface detail (fullers, grain, rivets, facets), legendary glow.
#
# Performance: GDI+ SetPixel is slow but the build runs once per
# regen — ~300 sprites × ~5K pixels = manageable in ~3-5 min on
# Windows PowerShell 5.1.
#
# Light convention (everywhere):
#   • Upper-left key light → high tones on upper-left of each form
#   • Lower-right ambient → shadow tones on lower-right
#   • Rim light along the upper-left silhouette edge
#
# Material palette shape (5 tones, deep to top):
#   deep | shadow | base | high | top
# Sometimes an extra `rim` (super-bright accent) for legendary.

if (-not ([System.Management.Automation.PSTypeName]'System.Drawing.Bitmap').Type) {
  Add-Type -AssemblyName System.Drawing
}

# ── Color helpers ──────────────────────────────────────────────────
function Color-FromHex {
  param([string]$h)
  $h = $h.TrimStart('#')
  if ($h.Length -eq 8) {
    $a = [Convert]::ToInt32($h.Substring(0,2), 16)
    $r = [Convert]::ToInt32($h.Substring(2,2), 16)
    $g = [Convert]::ToInt32($h.Substring(4,2), 16)
    $b = [Convert]::ToInt32($h.Substring(6,2), 16)
    return [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
  }
  $r = [Convert]::ToInt32($h.Substring(0,2), 16)
  $g = [Convert]::ToInt32($h.Substring(2,2), 16)
  $b = [Convert]::ToInt32($h.Substring(4,2), 16)
  return [System.Drawing.Color]::FromArgb(255, $r, $g, $b)
}

function With-Alpha {
  param($color, [int]$alpha)
  return [System.Drawing.Color]::FromArgb($alpha, $color.R, $color.G, $color.B)
}

function Mix-Color {
  param($a, $b, [double]$t)
  $r = [int]([Math]::Round($a.R + ($b.R - $a.R) * $t))
  $g = [int]([Math]::Round($a.G + ($b.G - $a.G) * $t))
  $bb = [int]([Math]::Round($a.B + ($b.B - $a.B) * $t))
  return [System.Drawing.Color]::FromArgb(255, $r, $g, $bb)
}

# Build a 5-tone ramp from hex base by darkening / lightening it.
function Build-Ramp {
  param(
    [string]$baseHex,
    [double]$darken = 0.55,    # deep multiplier
    [double]$shadow = 0.78,    # shadow multiplier
    [double]$light  = 1.18,    # high mult clamped to 255
    [double]$top    = 1.40
  )
  $b = Color-FromHex $baseHex
  $clamp = { param($v) [int]([Math]::Max(0, [Math]::Min(255, $v))) }
  return @{
    deep   = [System.Drawing.Color]::FromArgb(255, (& $clamp ($b.R * $darken)), (& $clamp ($b.G * $darken)), (& $clamp ($b.B * $darken)));
    shadow = [System.Drawing.Color]::FromArgb(255, (& $clamp ($b.R * $shadow)), (& $clamp ($b.G * $shadow)), (& $clamp ($b.B * $shadow)));
    base   = $b;
    high   = [System.Drawing.Color]::FromArgb(255, (& $clamp ($b.R * $light)),  (& $clamp ($b.G * $light)),  (& $clamp ($b.B * $light)));
    top    = [System.Drawing.Color]::FromArgb(255, (& $clamp ($b.R * $top)),    (& $clamp ($b.G * $top)),    (& $clamp ($b.B * $top)));
  }
}

# ── Material palettes (5-tone ramps) ───────────────────────────────
# Authored explicitly so each material reads as "that material" — not
# just a tinted grey. Each ramp = { deep, shadow, base, high, top }.

$MAT_STEEL = @{
  deep   = (Color-FromHex '#1a1f2c');
  shadow = (Color-FromHex '#2f3849');
  base   = (Color-FromHex '#5a6478');
  high   = (Color-FromHex '#8d97ac');
  top    = (Color-FromHex '#cbd2e0');
}
$MAT_IRON = @{
  deep   = (Color-FromHex '#1a1817');
  shadow = (Color-FromHex '#2e2a28');
  base   = (Color-FromHex '#4f4944');
  high   = (Color-FromHex '#7c736c');
  top    = (Color-FromHex '#a89e95');
}
$MAT_BRONZE = @{
  deep   = (Color-FromHex '#3a1e10');
  shadow = (Color-FromHex '#6a3a1e');
  base   = (Color-FromHex '#a8602c');
  high   = (Color-FromHex '#d68e4c');
  top    = (Color-FromHex '#f4c078');
}
$MAT_COPPER = @{
  deep   = (Color-FromHex '#4a200c');
  shadow = (Color-FromHex '#8a3a14');
  base   = (Color-FromHex '#c0581c');
  high   = (Color-FromHex '#e88438');
  top    = (Color-FromHex '#ffb878');
}
$MAT_GOLD = @{
  deep   = (Color-FromHex '#5a3a08');
  shadow = (Color-FromHex '#9a6e14');
  base   = (Color-FromHex '#dca72a');
  high   = (Color-FromHex '#f4c84a');
  top    = (Color-FromHex '#fff0a0');
}
$MAT_SILVER = @{
  deep   = (Color-FromHex '#3a4150');
  shadow = (Color-FromHex '#6a7488');
  base   = (Color-FromHex '#a4afc2');
  high   = (Color-FromHex '#d0d6e2');
  top    = (Color-FromHex '#f4f6fb');
}
$MAT_ELECTRUM = @{
  deep   = (Color-FromHex '#5c4a10');
  shadow = (Color-FromHex '#9a8830');
  base   = (Color-FromHex '#d6c668');
  high   = (Color-FromHex '#f0e69a');
  top    = (Color-FromHex '#fff8d0');
}
$MAT_OBSIDIAN = @{
  deep   = (Color-FromHex '#06070b');
  shadow = (Color-FromHex '#13161f');
  base   = (Color-FromHex '#252a3a');
  high   = (Color-FromHex '#404660');
  top    = (Color-FromHex '#6a7090');
}

$MAT_WOOD_DARK = @{
  deep   = (Color-FromHex '#1c1108');
  shadow = (Color-FromHex '#3a2515');
  base   = (Color-FromHex '#5e3c1e');
  high   = (Color-FromHex '#8a5c30');
  top    = (Color-FromHex '#b58148');
}
$MAT_WOOD_LIGHT = @{
  deep   = (Color-FromHex '#3a2410');
  shadow = (Color-FromHex '#664220');
  base   = (Color-FromHex '#9a6a36');
  high   = (Color-FromHex '#c08e54');
  top    = (Color-FromHex '#e8b878');
}

$MAT_LEATHER = @{
  deep   = (Color-FromHex '#1c0d05');
  shadow = (Color-FromHex '#36200f');
  base   = (Color-FromHex '#5a3a1e');
  high   = (Color-FromHex '#8a5c33');
  top    = (Color-FromHex '#b48050');
}
$MAT_LEATHER_BLACK = @{
  deep   = (Color-FromHex '#050608');
  shadow = (Color-FromHex '#101216');
  base   = (Color-FromHex '#1e2129');
  high   = (Color-FromHex '#33384a');
  top    = (Color-FromHex '#525a72');
}

$MAT_CLOTH_LINEN = @{
  deep   = (Color-FromHex '#3e3424');
  shadow = (Color-FromHex '#6a5b3e');
  base   = (Color-FromHex '#9a8860');
  high   = (Color-FromHex '#c4b384');
  top    = (Color-FromHex '#e6d8ac');
}
$MAT_CLOTH_WOOL = @{
  deep   = (Color-FromHex '#2a2a32');
  shadow = (Color-FromHex '#43434f');
  base   = (Color-FromHex '#6a6b7b');
  high   = (Color-FromHex '#9598a8');
  top    = (Color-FromHex '#c1c4d2');
}

$MAT_STONE = @{
  deep   = (Color-FromHex '#3a3d48');
  shadow = (Color-FromHex '#5a606e');
  base   = (Color-FromHex '#838b9c');
  high   = (Color-FromHex '#aab1c0');
  top    = (Color-FromHex '#d0d6e2');
}
$MAT_THATCH = @{
  deep   = (Color-FromHex '#3a2a10');
  shadow = (Color-FromHex '#6a4a1e');
  base   = (Color-FromHex '#a47028');
  high   = (Color-FromHex '#d4983c');
  top    = (Color-FromHex '#f0c060');
}

# ── Gem palettes — facet-shaded multi-tone ─────────────────────────
$GEM_RUBY      = @{ deep='#3a0a18'; shadow='#7a1428'; core='#c8203c'; high='#f8506a'; top='#ffaabc' }
$GEM_SAPPHIRE  = @{ deep='#0a1a4a'; shadow='#1a3a7a'; core='#2e5ebc'; high='#5a8af0'; top='#a4c0ff' }
$GEM_EMERALD   = @{ deep='#0a3a18'; shadow='#206a30'; core='#2ea848'; high='#5ad078'; top='#a8f0bc' }
$GEM_AMETHYST  = @{ deep='#240a40'; shadow='#4a1a78'; core='#7c3acb'; high='#a878f0'; top='#d8b8ff' }
$GEM_TOPAZ     = @{ deep='#5c2a08'; shadow='#a4581c'; core='#e8932c'; high='#ffbe5c'; top='#ffe4a8' }
$GEM_DIAMOND   = @{ deep='#506880'; shadow='#8aa0c0'; core='#cbd8e8'; high='#f4f8ff'; top='#ffffff' }
$GEM_ONYX      = @{ deep='#040406'; shadow='#0c0d12'; core='#1b1d28'; high='#3c4258'; top='#6c728a' }
$GEM_OPAL      = @{ deep='#3a3a5a'; shadow='#6a7a98'; core='#a8c0d8'; high='#d8e0f0'; top='#fff8ff' }
$GEM_VOLTAIC   = @{ deep='#1a1078'; shadow='#3a2cc4'; core='#7c5cff'; high='#b098ff'; top='#e8dcff' }

# Map a hint keyword to a gem palette. Default — voltaic (brand pop).
function Gem-Palette {
  param([string]$hint)
  $h = $hint.ToLower()
  if     ($h -match 'ruby|crimson|blood|ember|fire') { return $GEM_RUBY }
  elseif ($h -match 'sapph|sea|tidal|deep|azure|cobalt') { return $GEM_SAPPHIRE }
  elseif ($h -match 'emer|moss|forest|jade|leaf|verdant|nature') { return $GEM_EMERALD }
  elseif ($h -match 'amethy|plum|orchid|twilight') { return $GEM_AMETHYST }
  elseif ($h -match 'topaz|sun|amber|gold|honey') { return $GEM_TOPAZ }
  elseif ($h -match 'diamond|frost|ice|crystal|hailstone') { return $GEM_DIAMOND }
  elseif ($h -match 'onyx|shadow|night|void|black|jet') { return $GEM_ONYX }
  elseif ($h -match 'opal|prism|aurora|rainbow|spectrum|iri') { return $GEM_OPAL }
  return $GEM_VOLTAIC
}

# ── Rarity → metal + accent + glow ─────────────────────────────────
function Rarity-Metal {
  param([string]$rarity)
  switch ($rarity) {
    'common'    { return $MAT_IRON }
    'uncommon'  { return $MAT_BRONZE }
    'rare'      { return $MAT_STEEL }
    'epic'      { return $MAT_SILVER }
    'legendary' { return $MAT_GOLD }
    default     { return $MAT_IRON }
  }
}
function Rarity-Accent {
  param([string]$rarity)
  switch ($rarity) {
    'common'    { return (Color-FromHex '#a8a8b0') }
    'uncommon'  { return (Color-FromHex '#5be098') }
    'rare'      { return (Color-FromHex '#6ec0ff') }
    'epic'      { return (Color-FromHex '#cb9aff') }
    'legendary' { return (Color-FromHex '#fff0a0') }
    default     { return (Color-FromHex '#a8a8b0') }
  }
}
function Rarity-Detail {
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

# Brand accent colours (shared with current build script for
# consistency across mini-game vs. character sprites).
$BRAND = @{
  Violet    = (Color-FromHex '#7c5cff');
  VioletHi  = (Color-FromHex '#9a82ff');
  VioletDk  = (Color-FromHex '#5a40b0');
  Green     = (Color-FromHex '#5bff95');
  Teal      = (Color-FromHex '#6ee0c0');
  Gold      = (Color-FromHex '#f0b429');
  GoldHi    = (Color-FromHex '#fff0a0');
  Crimson   = (Color-FromHex '#f8514a');
  Ink       = (Color-FromHex '#0a0b12');
  InkSoft   = (Color-FromHex '#1c2034');
}

# ── Canvas primitives ──────────────────────────────────────────────
function New-CanvasFx {
  param([int]$w, [int]$h)
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $g.Dispose()
  return $bmp
}

function Save-CanvasFx {
  param($bmp, [string]$path)
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Set-Pixel {
  param($bmp, [int]$x, [int]$y, $color)
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $bmp.Width -or $y -ge $bmp.Height) { return }
  $bmp.SetPixel($x, $y, $color)
}

# Alpha-blend a colour onto whatever's already at (x,y). Used for
# halo / glow effects so they layer over silhouettes correctly.
function Blend-Pixel {
  param($bmp, [int]$x, [int]$y, $color)
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $bmp.Width -or $y -ge $bmp.Height) { return }
  $sa = $color.A
  if ($sa -eq 0) { return }
  if ($sa -eq 255) { $bmp.SetPixel($x, $y, $color); return }
  $dst = $bmp.GetPixel($x, $y)
  if ($dst.A -eq 0) {
    $bmp.SetPixel($x, $y, $color)
    return
  }
  $sA = $sa / 255.0
  $dA = $dst.A / 255.0
  $outA = $sA + $dA * (1 - $sA)
  if ($outA -le 0) { return }
  $r = [int]([Math]::Round(($color.R * $sA + $dst.R * $dA * (1 - $sA)) / $outA))
  $g = [int]([Math]::Round(($color.G * $sA + $dst.G * $dA * (1 - $sA)) / $outA))
  $b = [int]([Math]::Round(($color.B * $sA + $dst.B * $dA * (1 - $sA)) / $outA))
  $a = [int]([Math]::Round($outA * 255))
  $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($a, $r, $g, $b))
}

function Fill-Box {
  param($bmp, [int]$x, [int]$y, [int]$w, [int]$h, $color)
  for ($yy = $y; $yy -lt ($y + $h); $yy++) {
    for ($xx = $x; $xx -lt ($x + $w); $xx++) {
      Set-Pixel $bmp $xx $yy $color
    }
  }
}

function Stroke-Box {
  param($bmp, [int]$x, [int]$y, [int]$w, [int]$h, $stroke, $fill = $null)
  if ($fill) { Fill-Box $bmp $x $y $w $h $fill }
  for ($i = 0; $i -lt $w; $i++) {
    Set-Pixel $bmp ($x + $i) $y $stroke
    Set-Pixel $bmp ($x + $i) ($y + $h - 1) $stroke
  }
  for ($i = 0; $i -lt $h; $i++) {
    Set-Pixel $bmp $x ($y + $i) $stroke
    Set-Pixel $bmp ($x + $w - 1) ($y + $i) $stroke
  }
}

function Line-Pixel {
  param($bmp, [int]$x0, [int]$y0, [int]$x1, [int]$y1, $color)
  $dx = [Math]::Abs($x1 - $x0); $dy = [Math]::Abs($y1 - $y0)
  $sx = if ($x0 -lt $x1) { 1 } else { -1 }
  $sy = if ($y0 -lt $y1) { 1 } else { -1 }
  $err = $dx - $dy
  while ($true) {
    Set-Pixel $bmp $x0 $y0 $color
    if ($x0 -eq $x1 -and $y0 -eq $y1) { break }
    $e2 = 2 * $err
    if ($e2 -gt -$dy) { $err -= $dy; $x0 += $sx }
    if ($e2 -lt  $dx) { $err += $dx; $y0 += $sy }
  }
}

# Pixel is "opaque" if its alpha > 0. Used by silhouette utilities.
function Is-Opaque {
  param($bmp, [int]$x, [int]$y)
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $bmp.Width -or $y -ge $bmp.Height) { return $false }
  return ($bmp.GetPixel($x, $y).A -gt 0)
}

# ── Volume shading — auto-shade a filled rectangle as if it's a
#    block with rounded top-left lit by an upper-left light source.
# Reads the four-corner darkening + top-row highlight + bottom-row
# shadow + left-edge highlight + right-edge shadow. Use this for
# weapon hilts, building blocks, armour plates etc.
function Shade-Box {
  param(
    $bmp, [int]$x, [int]$y, [int]$w, [int]$h, $ramp,
    [switch]$RimLight,            # add a brightest-tone pixel along upper-left silhouette
    [switch]$NoCornerRound        # skip corner-darkening
  )
  Fill-Box $bmp $x $y $w $h $ramp.base
  # Top row highlight
  for ($i = 0; $i -lt $w; $i++) { Set-Pixel $bmp ($x + $i) $y $ramp.high }
  # Bottom row shadow
  for ($i = 0; $i -lt $w; $i++) { Set-Pixel $bmp ($x + $i) ($y + $h - 1) $ramp.shadow }
  # Left edge highlight
  for ($i = 0; $i -lt $h; $i++) { Set-Pixel $bmp $x ($y + $i) $ramp.high }
  # Right edge shadow
  for ($i = 0; $i -lt $h; $i++) { Set-Pixel $bmp ($x + $w - 1) ($y + $i) $ramp.shadow }
  # Corners
  if (-not $NoCornerRound) {
    Set-Pixel $bmp ($x + $w - 1) $y           $ramp.shadow
    Set-Pixel $bmp $x            ($y + $h -1) $ramp.shadow
    Set-Pixel $bmp ($x + $w - 1) ($y + $h -1) $ramp.deep
  }
  # Top-left brightest spot
  Set-Pixel $bmp ($x + 1) ($y + 1) $ramp.top
  if ($w -ge 4) { Set-Pixel $bmp ($x + 2) ($y + 1) $ramp.top }
  if ($h -ge 4) { Set-Pixel $bmp ($x + 1) ($y + 2) $ramp.top }
  if ($RimLight) {
    Set-Pixel $bmp ($x - 1) $y $ramp.top
    Set-Pixel $bmp $x ($y - 1) $ramp.top
  }
}

# Shade a filled disc / sphere centred at (cx,cy) radius r with
# the given ramp. Light from upper-left. Used for orbs, pommels,
# faces, gem centres.
function Shade-Disc {
  param($bmp, [int]$cx, [int]$cy, [double]$r, $ramp, [switch]$RimLight)
  $r2 = $r * $r
  $lx = $cx - $r * 0.4   # light direction (upper-left)
  $ly = $cy - $r * 0.4
  for ($dy = -[int][Math]::Ceiling($r); $dy -le [int][Math]::Ceiling($r); $dy++) {
    for ($dx = -[int][Math]::Ceiling($r); $dx -le [int][Math]::Ceiling($r); $dx++) {
      $d2 = $dx * $dx + $dy * $dy
      if ($d2 -gt $r2 + 0.3) { continue }
      # Distance from light point
      $ld = [Math]::Sqrt(($cx + $dx - $lx) * ($cx + $dx - $lx) + ($cy + $dy - $ly) * ($cy + $dy - $ly))
      $t  = $ld / ($r * 1.5)   # 0 at light, ~1 at far edge
      $col = $ramp.base
      if     ($t -lt 0.18) { $col = $ramp.top }
      elseif ($t -lt 0.36) { $col = $ramp.high }
      elseif ($t -lt 0.62) { $col = $ramp.base }
      elseif ($t -lt 0.85) { $col = $ramp.shadow }
      else                  { $col = $ramp.deep }
      Set-Pixel $bmp ($cx + $dx) ($cy + $dy) $col
    }
  }
  if ($RimLight) {
    # Single bright pixel just outside the upper-left
    $ang = -2.4   # ~upper-left
    $rx = [int]([Math]::Round($cx + [Math]::Cos($ang) * ($r + 0.5)))
    $ry = [int]([Math]::Round($cy + [Math]::Sin($ang) * ($r + 0.5)))
    Blend-Pixel $bmp $rx $ry (With-Alpha $ramp.top 200)
  }
}

# Shade an axis-aligned ellipse — used for soft volumes, animal
# bellies, helmet domes.
function Shade-Oval {
  param($bmp, [int]$cx, [int]$cy, [double]$rx, [double]$ry, $ramp)
  for ($dy = -[int][Math]::Ceiling($ry); $dy -le [int][Math]::Ceiling($ry); $dy++) {
    for ($dx = -[int][Math]::Ceiling($rx); $dx -le [int][Math]::Ceiling($rx); $dx++) {
      $nx = $dx / $rx; $ny = $dy / $ry
      $d2 = $nx * $nx + $ny * $ny
      if ($d2 -gt 1.05) { continue }
      # Light vector: upper-left in normalised space
      $ldx = $nx + 0.55; $ldy = $ny + 0.55
      $t = ($ldx * $ldx + $ldy * $ldy) / 2.6
      $col = $ramp.base
      if     ($t -lt 0.10) { $col = $ramp.top }
      elseif ($t -lt 0.25) { $col = $ramp.high }
      elseif ($t -lt 0.55) { $col = $ramp.base }
      elseif ($t -lt 0.85) { $col = $ramp.shadow }
      else                 { $col = $ramp.deep }
      Set-Pixel $bmp ($cx + $dx) ($cy + $dy) $col
    }
  }
}

# Draw a blade as a tapered prism with central fuller groove. Returns
# the (top,bot) tip rows so callers can place crossguards / accents.
# `width` is the wide-end thickness; tip narrows to ~2 px.
function Draw-Blade {
  param(
    $bmp, [int]$cx, [int]$topY, [int]$botY, [int]$width, $ramp,
    [switch]$Fuller, [switch]$DoubleEdge, $accent = $null
  )
  $len = $botY - $topY + 1
  for ($y = $topY; $y -le $botY; $y++) {
    $tipness = ($y - $topY) / [Math]::Max(1.0, $len * 0.18)   # 0 at top, 1+ once past tip-taper zone
    $w = if ($tipness -lt 1.0) {
      [int]([Math]::Max(1, [Math]::Round($width * (0.35 + 0.65 * $tipness))))
    } else { $width }
    $halfL = [int]([Math]::Floor($w / 2))
    $halfR = $w - $halfL - 1
    $left  = $cx - $halfL
    $right = $cx + $halfR
    # Base fill
    for ($x = $left; $x -le $right; $x++) {
      Set-Pixel $bmp $x $y $ramp.base
    }
    # Edges
    Set-Pixel $bmp $left  $y $ramp.high
    Set-Pixel $bmp $right $y $ramp.shadow
    if ($DoubleEdge) {
      Set-Pixel $bmp $left  $y $ramp.top
      Set-Pixel $bmp $right $y $ramp.shadow
    }
    # Fuller groove — 1 px shadow line down the centre, with a high
    # line beside it on the upper-left for a fake-3D specular.
    if ($Fuller -and $w -ge 3 -and $y -gt ($topY + 1) -and $y -lt ($botY - 1)) {
      Set-Pixel $bmp $cx $y $ramp.deep
      if ($w -ge 4) {
        Set-Pixel $bmp ($cx - 1) $y $ramp.high
      }
    }
  }
  # Tip — brightest single pixel
  Set-Pixel $bmp $cx $topY $ramp.top
  # Accent etch at mid-blade if requested
  if ($accent -ne $null) {
    $mid = [int](($topY + $botY) / 2)
    Set-Pixel $bmp $cx $mid $accent
    if ($len -ge 14) {
      Set-Pixel $bmp $cx ($mid - 3) $accent
      Set-Pixel $bmp $cx ($mid + 3) $accent
    }
  }
}

# Wrap a grip with leather wrap — diagonal stitching pattern.
function Draw-Grip {
  param($bmp, [int]$cx, [int]$topY, [int]$botY, [int]$width, $ramp = $null)
  if (-not $ramp) { $ramp = $MAT_LEATHER }
  $halfL = [int]([Math]::Floor($width / 2))
  $halfR = $width - $halfL - 1
  for ($y = $topY; $y -le $botY; $y++) {
    for ($x = ($cx - $halfL); $x -le ($cx + $halfR); $x++) {
      Set-Pixel $bmp $x $y $ramp.base
    }
    # Stitch pattern — alternate high/shadow diagonal
    if ((($y - $topY) % 2) -eq 0) {
      Set-Pixel $bmp ($cx - $halfL) $y $ramp.shadow
      Set-Pixel $bmp ($cx + $halfR) $y $ramp.high
    } else {
      Set-Pixel $bmp ($cx - $halfL) $y $ramp.high
      Set-Pixel $bmp ($cx + $halfR) $y $ramp.shadow
    }
  }
  # Top + bottom caps
  for ($x = ($cx - $halfL); $x -le ($cx + $halfR); $x++) {
    Set-Pixel $bmp $x $topY $ramp.shadow
    Set-Pixel $bmp $x $botY $ramp.deep
  }
}

# Draw a wooden shaft / pole with subtle vertical grain.
function Draw-Shaft {
  param($bmp, [int]$cx, [int]$topY, [int]$botY, [int]$width = 2, $ramp = $null)
  if (-not $ramp) { $ramp = $MAT_WOOD_DARK }
  $halfL = [int]([Math]::Floor($width / 2))
  $halfR = $width - $halfL - 1
  for ($y = $topY; $y -le $botY; $y++) {
    for ($x = ($cx - $halfL); $x -le ($cx + $halfR); $x++) {
      Set-Pixel $bmp $x $y $ramp.base
    }
    Set-Pixel $bmp ($cx - $halfL) $y $ramp.high
    Set-Pixel $bmp ($cx + $halfR) $y $ramp.shadow
    # Grain knots — occasional dark spot
    if ((($y * 7) % 11) -eq 3 -and $width -ge 3) {
      Set-Pixel $bmp $cx $y $ramp.deep
    }
  }
  # End caps
  for ($x = ($cx - $halfL); $x -le ($cx + $halfR); $x++) {
    Set-Pixel $bmp $x $topY $ramp.top
    Set-Pixel $bmp $x $botY $ramp.deep
  }
}

# Place a rivet — bright top with shadow ring around.
function Draw-Rivet {
  param($bmp, [int]$cx, [int]$cy, $ramp)
  Set-Pixel $bmp $cx $cy $ramp.top
  Set-Pixel $bmp ($cx - 1) $cy $ramp.shadow
  Set-Pixel $bmp ($cx + 1) $cy $ramp.shadow
  Set-Pixel $bmp $cx ($cy - 1) $ramp.high
  Set-Pixel $bmp $cx ($cy + 1) $ramp.deep
}

# Faceted gem — diamond outline with two-tone inner facets.
function Draw-Gem {
  param(
    $bmp, [int]$cx, [int]$cy, [int]$size, [hashtable]$pal,
    [switch]$Round
  )
  $deep   = Color-FromHex $pal.deep
  $shadow = Color-FromHex $pal.shadow
  $core   = Color-FromHex $pal.core
  $high   = Color-FromHex $pal.high
  $top    = Color-FromHex $pal.top
  if ($Round) {
    # Filled disc with single bright spot
    Shade-Disc $bmp $cx $cy ($size * 0.5) @{ deep=$deep; shadow=$shadow; base=$core; high=$high; top=$top }
    return
  }
  # Diamond facet — odd `size` works best (3,5,7)
  $r = [int]([Math]::Floor($size / 2))
  for ($dy = -$r; $dy -le $r; $dy++) {
    $w = $r - [Math]::Abs($dy)
    for ($dx = -$w; $dx -le $w; $dx++) {
      $col = $core
      # Upper-left facet — high
      if ($dy -lt 0 -and $dx -le 0) { $col = $high }
      # Lower-right facet — shadow
      elseif ($dy -gt 0 -and $dx -ge 0) { $col = $shadow }
      # Center bright
      if ($dx -eq 0 -and $dy -eq 0) { $col = $core }
      Set-Pixel $bmp ($cx + $dx) ($cy + $dy) $col
    }
  }
  # Specular highlight + dark facet edges
  Set-Pixel $bmp $cx ($cy - $r) $top
  Set-Pixel $bmp ($cx - 1) ($cy - $r + 1) $top
  Set-Pixel $bmp $cx ($cy + $r) $deep
  # Outer outline gives the gem its faceted silhouette
  if ($size -ge 5) {
    Set-Pixel $bmp ($cx - $r) $cy $shadow
    Set-Pixel $bmp ($cx + $r) $cy $deep
  }
}

# Glow halo — sample opaque pixels and paint a soft-alpha aura
# outside them. `radius` is the halo thickness in pixels.
function Add-GlowHalo {
  param($bmp, $color, [int]$radius = 2, [int]$alpha = 110)
  $w = $bmp.Width; $h = $bmp.Height
  # First pass: find silhouette
  $sil = New-Object 'bool[,]' $w, $h
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $sil[$x, $y] = ($bmp.GetPixel($x, $y).A -gt 0)
    }
  }
  # Second pass: paint halo on transparent pixels adjacent within radius
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      if ($sil[$x, $y]) { continue }
      $closest = 999
      for ($dy = -$radius; $dy -le $radius; $dy++) {
        for ($dx = -$radius; $dx -le $radius; $dx++) {
          $nx = $x + $dx; $ny = $y + $dy
          if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $w -or $ny -ge $h) { continue }
          if ($sil[$nx, $ny]) {
            $d = [int]([Math]::Sqrt($dx * $dx + $dy * $dy))
            if ($d -lt $closest) { $closest = $d }
          }
        }
      }
      if ($closest -le $radius -and $closest -gt 0) {
        $a = [int]($alpha * (1 - ($closest - 1) / [double]$radius))
        if ($a -gt 12) {
          Blend-Pixel $bmp $x $y (With-Alpha $color $a)
        }
      }
    }
  }
}

# Deterministic per-name RNG — same hash function as the old script
# so existing slugs map to compatible variations (helps keep visual
# continuity for players seeing the upgraded art).
$script:RNG_STATE = 1
function NameSeed {
  param([string]$name)
  $h = 0
  foreach ($c in $name.ToCharArray()) {
    $h = (($h * 31) -bxor [int][char]$c) -band 0x7fffffff
  }
  return $h
}
function Rng-Init { param([string]$name) $script:RNG_STATE = (NameSeed $name) -bor 1 }
function Rng-Pick {
  param([int]$mod)
  $script:RNG_STATE = (($script:RNG_STATE * 1103515245) + 12345) -band 0x7fffffff
  if ($mod -le 1) { return 0 }
  return $script:RNG_STATE % $mod
}
function Rng-Choice { param([array]$arr) return $arr[(Rng-Pick $arr.Count)] }
function Rng-Range {
  param([int]$lo, [int]$hi)   # inclusive
  return $lo + (Rng-Pick ($hi - $lo + 1))
}

# Slugify — matches the JS nameSlug() in discord-bot/character.js.
function Slugify {
  param([string]$s)
  return ($s.ToLower() -replace "['’]", '' -replace '[^a-z0-9]+', '-' -replace '^-|-$', '')
}
