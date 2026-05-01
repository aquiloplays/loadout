# Mine the user's actions.json for the real numeric trigger / subaction types.
# Output: tools/sb-types.txt - a reference table the SBAE generator uses.
[CmdletBinding()]
param(
    [string]$ActionsPath = "$env:USERPROFILE\Desktop\Streamerbot\data\actions.json",
    [string]$OutPath     = (Join-Path $PSScriptRoot "sb-types.txt")
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $ActionsPath)) { throw "actions.json not found: $ActionsPath" }

$json = Get-Content $ActionsPath -Raw | ConvertFrom-Json
$actions = if ($json.actions) { $json.actions } else { $json }

$triggerCounts  = @{}
$triggerSamples = @{}
$subCounts      = @{}
$subSampleKeys  = @{}

function Walk-Sub($sub) {
    if ($null -eq $sub) { return }
    $t = $sub.type
    if ($null -ne $t) {
        $key = [int]$t
        if (-not $subCounts.ContainsKey($key)) {
            $subCounts[$key] = 0
            $subSampleKeys[$key] = @{}
        }
        $subCounts[$key]++
        foreach ($p in $sub.PSObject.Properties) {
            $subSampleKeys[$key][$p.Name] = $true
        }
    }
    if ($sub.subActions) {
        foreach ($s in $sub.subActions) { Walk-Sub $s }
    }
}

foreach ($a in $actions) {
    if ($a.triggers) {
        foreach ($tr in $a.triggers) {
            $tt = [int]$tr.type
            if (-not $triggerCounts.ContainsKey($tt)) {
                $triggerCounts[$tt]  = 0
                $triggerSamples[$tt] = @{ keys = @{}; actionName = $a.name }
            }
            $triggerCounts[$tt]++
            foreach ($p in $tr.PSObject.Properties) {
                $triggerSamples[$tt].keys[$p.Name] = $true
            }
        }
    }
    if ($a.subActions) {
        foreach ($s in $a.subActions) { Walk-Sub $s }
    }
}

$sb = New-Object Text.StringBuilder
[void]$sb.AppendLine("# Streamer.bot type-number reference, mined from actions.json")
[void]$sb.AppendLine("# Generated $(Get-Date -Format o)")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## Trigger types")
[void]$sb.AppendLine("type | count | sample fields | first-seen action")
[void]$sb.AppendLine("---- | ----- | ------------- | -----------------")
foreach ($k in ($triggerCounts.Keys | Sort-Object)) {
    $keys = ($triggerSamples[$k].keys.Keys | Sort-Object) -join ", "
    $name = $triggerSamples[$k].actionName
    [void]$sb.AppendLine("$k | $($triggerCounts[$k]) | $keys | $name")
}
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## SubAction types")
[void]$sb.AppendLine("type | count | sample fields")
[void]$sb.AppendLine("---- | ----- | -------------")
foreach ($k in ($subCounts.Keys | Sort-Object)) {
    $keys = ($subSampleKeys[$k].Keys | Sort-Object) -join ", "
    [void]$sb.AppendLine("$k | $($subCounts[$k]) | $keys")
}

Set-Content $OutPath -Value $sb.ToString() -Encoding utf8
Write-Host "Wrote $OutPath"
Write-Host ""
Write-Host "Triggers found: $($triggerCounts.Count)"
Write-Host "SubActions found: $($subCounts.Count)"
