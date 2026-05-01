# Crack open SB's Common.dll, find enum types, and dump every name->int mapping.
# That's how we learn what trigger / subaction type numbers mean without guessing.
[CmdletBinding()]
param(
    [string]$SbPath = "$env:USERPROFILE\Desktop\Streamerbot",
    [string]$OutPath = (Join-Path $PSScriptRoot "sb-enums.txt")
)
$ErrorActionPreference = "Stop"

# Load all SB DLLs; many enums live across multiple assemblies.
$dlls = Get-ChildItem -Path $SbPath -Filter "*.dll" -File
$loaded = @()
foreach ($dll in $dlls) {
    try {
        [void][Reflection.Assembly]::LoadFile($dll.FullName)
        $loaded += $dll.Name
    } catch { }
}
Write-Host "Loaded $($loaded.Count) DLLs"

$sb = New-Object Text.StringBuilder
[void]$sb.AppendLine("# Streamer.bot enum dump")
[void]$sb.AppendLine("# Generated $(Get-Date -Format o)")
[void]$sb.AppendLine("")

# Look for enums whose backing type is int and whose name suggests trigger/subaction kinds.
$enumKeywords = @('Trigger','SubAction','Event','Action')
$found = 0
foreach ($asm in [AppDomain]::CurrentDomain.GetAssemblies()) {
    $types = $null
    try { $types = $asm.GetTypes() } catch { continue }
    foreach ($t in $types) {
        if (-not $t.IsEnum) { continue }
        $matchKeyword = $false
        foreach ($k in $enumKeywords) { if ($t.FullName -like "*$k*") { $matchKeyword = $true; break } }
        if (-not $matchKeyword) { continue }

        $vals = [Enum]::GetValues($t)
        if ($vals.Count -lt 5) { continue }     # skip tiny enums; we want the big numeric registries

        [void]$sb.AppendLine("=== $($t.FullName)  [in $($asm.GetName().Name)]")
        foreach ($v in $vals) {
            $name = [Enum]::GetName($t, $v)
            try {
                $num = [int64]$v
                [void]$sb.AppendLine(("    {0,6}  {1}" -f $num, $name))
            } catch {
                [void]$sb.AppendLine(("        ?  {0}" -f $name))
            }
        }
        [void]$sb.AppendLine("")
        $found++
    }
}

Set-Content $OutPath -Value $sb.ToString() -Encoding utf8
Write-Host "Wrote $found enum types to $OutPath"
