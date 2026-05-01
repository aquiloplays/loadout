[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$Base64,
    [string]$OutPath = (Join-Path $PSScriptRoot "decoded-sb-export.json")
)
$ErrorActionPreference = "Stop"
$bytes = [Convert]::FromBase64String($Base64)
Write-Host ("Total bytes: {0}" -f $bytes.Length)

# Skip "SBAE" header.
$idx = 4
# Walk gzip header: 2 magic + 1 method + 1 flags + 4 mtime + 1 xfl + 1 os = 10 bytes minimum
$flags = $bytes[$idx + 3]
$idx += 10
# Optional FEXTRA, FNAME, FCOMMENT, FHCRC follow.
if ($flags -band 0x04) { $xlen = $bytes[$idx] -bor ($bytes[$idx+1] -shl 8); $idx += 2 + $xlen }  # FEXTRA
if ($flags -band 0x08) { while ($bytes[$idx] -ne 0) { $idx++ }; $idx++ }  # FNAME
if ($flags -band 0x10) { while ($bytes[$idx] -ne 0) { $idx++ }; $idx++ }  # FCOMMENT
if ($flags -band 0x02) { $idx += 2 }  # FHCRC

# Last 8 bytes of gzip = CRC32 + ISIZE — strip them.
$deflateLen = $bytes.Length - $idx - 8
$deflateBytes = New-Object byte[] $deflateLen
[Array]::Copy($bytes, $idx, $deflateBytes, 0, $deflateLen)

$ms = New-Object IO.MemoryStream(,$deflateBytes)
$ds = New-Object IO.Compression.DeflateStream($ms, [IO.Compression.CompressionMode]::Decompress)
$captured = New-Object IO.MemoryStream
$buf = New-Object byte[] 8192
while ($true) {
    $n = $ds.Read($buf, 0, $buf.Length)
    if ($n -le 0) { break }
    $captured.Write($buf, 0, $n)
}
$ds.Close()

$json = [Text.Encoding]::UTF8.GetString($captured.ToArray())
Set-Content -Path $OutPath -Value $json -Encoding utf8 -NoNewline
Write-Host ("Wrote {0} chars to {1}" -f $json.Length, $OutPath)
Write-Host ("Last 80 chars: {0}" -f $json.Substring([Math]::Max(0, $json.Length - 80)))
