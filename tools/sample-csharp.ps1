# Pull one inline C# subaction (type 99999) so we can see exactly how SB
# stores the source code and references.
[CmdletBinding()]
param(
    [string]$ActionsPath = "$env:USERPROFILE\Desktop\Streamerbot\data\actions.json",
    [int]$Skip = 0
)
$ErrorActionPreference = "Stop"
$json = Get-Content $ActionsPath -Raw | ConvertFrom-Json
$actions = if ($json.actions) { $json.actions } else { $json }

function Walk($sub, $action) {
    if ($null -eq $sub) { return @() }
    $hits = @()
    if ($sub.type -eq 99999) {
        $hits += [pscustomobject]@{ Action = $action.name; Sub = $sub }
    }
    if ($sub.subActions) {
        foreach ($s in $sub.subActions) { $hits += Walk $s $action }
    }
    return $hits
}

$found = @()
foreach ($a in $actions) {
    if ($a.subActions) {
        foreach ($s in $a.subActions) { $found += Walk $s $a }
    }
}

Write-Host "Found $($found.Count) inline-C# subactions; showing #$Skip"
$pick = $found[$Skip]
if (-not $pick) { Write-Host "Out of range"; exit }

Write-Host "Action: $($pick.Action)"
Write-Host "All field names: $($pick.Sub.PSObject.Properties.Name -join ', ')"
Write-Host ""
Write-Host "name: $($pick.Sub.name)"
Write-Host "description: $($pick.Sub.description)"
Write-Host "precompile: $($pick.Sub.precompile)"
Write-Host "references type: $($pick.Sub.references.GetType().Name); count: $($pick.Sub.references.Count)"
foreach ($r in $pick.Sub.references) { Write-Host "  ref: $r" }
Write-Host ""
$bc = $pick.Sub.byteCode
Write-Host "byteCode type: $($bc.GetType().Name)"
if ($bc -is [string]) {
    Write-Host "byteCode length: $($bc.Length)"
    $sample = if ($bc.Length -gt 400) { $bc.Substring(0, 400) } else { $bc }
    Write-Host "byteCode preview:"
    Write-Host $sample
} else {
    Write-Host "byteCode is binary; first 32 bytes:"
    $b = [byte[]]$bc
    Write-Host (($b[0..[Math]::Min(31, $b.Length-1)] | ForEach-Object { "{0:x2}" -f $_ }) -join ' ')
}
