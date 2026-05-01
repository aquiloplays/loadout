# Inspect a real SB action top-to-bottom: emit the EXACT field shape SB
# stores on disk (action + every nested subaction). Used to diff against
# what tools/build-sb-import.ps1 produces.
[CmdletBinding()]
param(
    [string]$ActionsPath = "$env:USERPROFILE\Desktop\Streamerbot\data\actions.json",
    [string]$NameLike    = ""    # filter by action name; empty = first action with type-99999 inline C# subaction
)
$ErrorActionPreference = "Stop"
$root = Get-Content $ActionsPath -Raw | ConvertFrom-Json
$actions = if ($root.actions) { $root.actions } else { $root }

function HasInlineCS($action) {
    foreach ($s in $action.subActions) {
        if ($s.type -eq 99999) { return $true }
        if ($s.subActions) { foreach ($n in $s.subActions) { if ($n.type -eq 99999) { return $true } } }
    }
    return $false
}

$picked = $null
if ($NameLike) {
    $picked = $actions | Where-Object { $_.name -like "*$NameLike*" } | Select-Object -First 1
} else {
    $picked = $actions | Where-Object { HasInlineCS $_ } | Select-Object -First 1
}
if (-not $picked) { throw "No matching action found" }

Write-Host ("ACTION: " + $picked.name) -ForegroundColor Cyan
Write-Host "---"
Write-Host "Top-level fields (with types):"
foreach ($p in $picked.PSObject.Properties) {
    $t = if ($null -eq $p.Value) { "null" }
         elseif ($p.Value -is [Array]) { "Array[" + $p.Value.Count + "]" }
         elseif ($p.Value -is [PSCustomObject]) { "Object" }
         else { $p.Value.GetType().Name }
    Write-Host ("  {0,-22}  {1,-10}  {2}" -f $p.Name, $t, ($p.Value | Out-String).Trim().Substring(0, [Math]::Min(60, ($p.Value | Out-String).Trim().Length)))
}

Write-Host ""
Write-Host "Triggers:"
foreach ($t in $picked.triggers) {
    Write-Host ("  type=" + $t.type + "  fields: " + (($t.PSObject.Properties.Name | Sort-Object) -join ", "))
}

Write-Host ""
Write-Host "Top-level subActions:"
function Walk($sa, $depth) {
    $indent = "  " * $depth
    $names = ($sa.PSObject.Properties.Name | Sort-Object) -join ", "
    Write-Host ($indent + "type=" + $sa.type + "  fields: " + $names)
    if ($sa.type -eq 99999) {
        Write-Host ($indent + "  references[" + $sa.references.Count + "]:")
        foreach ($r in $sa.references) { Write-Host ($indent + "    " + $r) }
        $bcType = if ($sa.byteCode -is [string]) { "string len=" + $sa.byteCode.Length } else { "binary" }
        Write-Host ($indent + "  byteCode: " + $bcType)
        Write-Host ($indent + "  saveResultToVariable: '" + $sa.saveResultToVariable + "' (" + ($sa.saveResultToVariable.GetType().Name) + ")")
        Write-Host ($indent + "  saveToVariable:       '" + $sa.saveToVariable + "' (" + ($sa.saveToVariable.GetType().Name) + ")")
        Write-Host ($indent + "  precompile:           " + $sa.precompile + " (" + ($sa.precompile.GetType().Name) + ")")
        Write-Host ($indent + "  delayStart:           " + $sa.delayStart + " (" + ($sa.delayStart.GetType().Name) + ")")
    }
    if ($sa.subActions) { foreach ($n in $sa.subActions) { Walk $n ($depth + 1) } }
}
foreach ($sa in $picked.subActions) { Walk $sa 1 }

# Also dump the raw JSON of the first inline C# subaction so we have the
# canonical reference shape.
function FindFirstInlineCs($sa) {
    if ($sa.type -eq 99999) { return $sa }
    if ($sa.subActions) {
        foreach ($n in $sa.subActions) { $r = FindFirstInlineCs $n; if ($r) { return $r } }
    }
    return $null
}
$inline = $null
foreach ($sa in $picked.subActions) { $inline = FindFirstInlineCs $sa; if ($inline) { break } }
if ($inline) {
    $sample = $inline | ConvertTo-Json -Depth 10
    # Truncate the byteCode for readability.
    $sample = $sample -replace '("byteCode":\s*")([^"]{40})[^"]+(",)', '$1$2…(truncated)$3'
    $samplePath = Join-Path $PSScriptRoot "real-inline-cs-sample.json"
    Set-Content -Path $samplePath -Value $sample -Encoding utf8
    Write-Host ""
    Write-Host ("Reference sample written to: " + $samplePath) -ForegroundColor Green
}
