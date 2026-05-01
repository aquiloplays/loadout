# Read one specific action's triggers from actions.json so we can correlate
# numeric type -> event name. Discord Stream Logger uses many event types and
# typically follows the SB UI labels in its action group names.
[CmdletBinding()]
param(
    [string]$ActionsPath = "$env:USERPROFILE\Desktop\Streamerbot\data\actions.json",
    [string]$NameLike = "Discord Stream Logger"
)
$ErrorActionPreference = "Stop"
$json = Get-Content $ActionsPath -Raw | ConvertFrom-Json
$actions = if ($json.actions) { $json.actions } else { $json }

$matches = $actions | Where-Object { $_.name -like "*$NameLike*" }
foreach ($a in $matches) {
    Write-Host ""
    Write-Host ("ACTION: {0}" -f $a.name) -ForegroundColor Cyan
    Write-Host ("  group: {0}" -f $a.group)
    if ($a.triggers) {
        foreach ($tr in $a.triggers) {
            $extras = @()
            foreach ($p in $tr.PSObject.Properties) {
                if ($p.Name -in @('id','enabled','exclusions','type')) { continue }
                $val = $p.Value
                if ($val -is [System.Array]) { $val = "[$($val.Count)]" }
                $extras += "$($p.Name)=$val"
            }
            $extra = if ($extras) { "  ($($extras -join ', '))" } else { "" }
            Write-Host ("    trigger type {0}{1}" -f $tr.type, $extra)
        }
    }
}
