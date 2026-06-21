$ErrorActionPreference = 'Stop'
$src = 'C:\Users\bishe\Desktop\Aquilo\Loadout\src\Loadout.Core\bin\Release\net48'
$dst = 'C:\Users\bishe\Desktop\Streamerbot\data\Loadout'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item (Join-Path $src 'Loadout.dll')         (Join-Path $dst 'Loadout.dll')         -Force
Copy-Item (Join-Path $src 'Newtonsoft.Json.dll') (Join-Path $dst 'Newtonsoft.Json.dll') -Force
$v = [System.Reflection.AssemblyName]::GetAssemblyName((Join-Path $dst 'Loadout.dll')).Version
Write-Host ('Installed Loadout.dll v{0}.{1}.{2}' -f $v.Major, $v.Minor, $v.Build)
