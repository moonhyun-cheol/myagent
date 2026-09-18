#requires -Version 5.1
<#
.SYNOPSIS
  Download official Node.js Windows x64 zip into runtime/node (install-time bootstrap).
#>
param(
  [Parameter(Mandatory = $true)][string]$Dest,
  [string]$Version = $env:CQR_NODE_VERSION,
  [string]$ExpectedArchiveSha256 = '',
  [switch]$SkipIfExists,
  [int]$DownloadTimeoutSec = 900
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cqr-native.ps1')

if (-not $Version) { $Version = '22.15.0' }
if (-not $ExpectedArchiveSha256 -and $Version -eq '22.15.0') {
  # nodejs.org v22.15.0 SHASUMS256.txt, node-v22.15.0-win-x64.zip
  $ExpectedArchiveSha256 = '06067d4f0d463f90ed803d5eca5b039a05dec5d70fc7b7cc254803a59bd0e27c'
}
if (-not $ExpectedArchiveSha256) {
  throw "bootstrap-node: no trusted SHA-256 is configured for Node $Version. Supply -ExpectedArchiveSha256 explicitly; unverified downloads are not allowed."
}

$nodeExe = Join-Path $Dest 'node.exe'
function Test-NodeRuntimeVersion([string]$Folder, [string]$ExpectedVersion) {
  $candidate = Join-Path $Folder 'node.exe'
  if (-not (Test-Path -LiteralPath $candidate)) { return $false }
  try {
    $actual = (& $candidate -p 'process.versions.node' 2>$null | Select-Object -First 1).ToString().Trim()
    return $actual -eq $ExpectedVersion
  } catch {
    return $false
  }
}
if ($SkipIfExists -and (Test-NodeRuntimeVersion -Folder $Dest -ExpectedVersion $Version)) {
  Write-Host "bootstrap-node: skipped (verified $Version) -> $nodeExe"
  exit 0
}

$cacheDir = Join-Path $PSScriptRoot 'cache'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

# Permission preflight: fail fast if the destination or cache is blocked
# (antivirus / Controlled Folder Access / inherited ACL) instead of stalling.
$destParent = Split-Path -Parent $Dest
foreach ($needWritable in @($destParent, $cacheDir)) {
  if ($needWritable -and -not (Test-CqrPathWritable $needWritable)) {
    Write-Error "bootstrap-node: no write permission for '$needWritable'. Antivirus, Windows Controlled Folder Access, or inherited folder permissions are blocking create/delete. Allow this folder (or reinstall MY Agent to a per-user folder) and retry."
  }
}

$zipName = "node-v$Version-win-x64.zip"
$zipPath = Join-Path $cacheDir $zipName
$url = "https://nodejs.org/dist/v$Version/$zipName"

if (-not (Test-Path -LiteralPath $zipPath)) {
  Write-Host "bootstrap-node: downloading $url"
  $dlCode = Invoke-CqrDownload -Uri $url -OutFile $zipPath -TimeoutSec $DownloadTimeoutSec
  if ($dlCode -eq 124) {
    Write-Error "bootstrap-node: download timed out after ${DownloadTimeoutSec}s and was aborted. Check internet/proxy/antivirus and retry."
  }
  if ($dlCode -ne 0) {
    Write-Error "bootstrap-node: download failed ($url). Check internet/proxy and retry."
  }
}

if ($ExpectedArchiveSha256) {
  $actualArchiveSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualArchiveSha256 -ne $ExpectedArchiveSha256.ToLowerInvariant()) {
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    throw "bootstrap-node: Node archive SHA-256 mismatch; removed untrusted cache/download (expected $ExpectedArchiveSha256, got $actualArchiveSha256)."
  }
  Write-Host "bootstrap-node: verified official archive SHA-256 ($actualArchiveSha256)"
}

$temp = Join-Path $env:TEMP ("cqr-node-" + [guid]::NewGuid().ToString('n'))
$staging = $Dest + '.installing'
$backup = $Dest + '.previous'
New-Item -ItemType Directory -Force -Path $temp | Out-Null

# Recover a standalone bootstrap interrupted during the final directory swap.
if (-not (Test-Path -LiteralPath $Dest) -and (Test-Path -LiteralPath $backup)) {
  Move-Item -LiteralPath $backup -Destination $Dest
}
if ((Test-Path -LiteralPath $Dest) -and (Test-Path -LiteralPath $backup)) {
  if (Test-NodeRuntimeVersion -Folder $Dest -ExpectedVersion $Version) {
    Remove-Item -LiteralPath $backup -Recurse -Force
  } else {
    Remove-Item -LiteralPath $Dest -Recurse -Force
    Move-Item -LiteralPath $backup -Destination $Dest
  }
}
Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue

try {
  try {
    Expand-Archive -LiteralPath $zipPath -DestinationPath $temp -Force
    $inner = Get-ChildItem -LiteralPath $temp -Directory | Select-Object -First 1
    if (-not $inner -or -not (Test-NodeRuntimeVersion -Folder $inner.FullName -ExpectedVersion $Version)) {
      throw "unexpected or invalid Node archive layout/version in $zipPath"
    }
  } catch {
    # A corrupt cached archive otherwise fails every reinstall forever. Remove it
    # only when archive extraction/runtime validation failed, not on a later
    # destination permission or swap failure.
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    throw "bootstrap-node: cached/downloaded archive is invalid and was removed; retry to download it again. $($_.Exception.Message)"
  }

  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  Get-ChildItem -LiteralPath $inner.FullName -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse -Force
  }
  if (-not (Test-NodeRuntimeVersion -Folder $staging -ExpectedVersion $Version)) {
    throw "bootstrap-node: staged runtime failed version check (expected $Version)"
  }

  if (Test-Path -LiteralPath $Dest) { Move-Item -LiteralPath $Dest -Destination $backup }
  try {
    Move-Item -LiteralPath $staging -Destination $Dest
    if (-not (Test-NodeRuntimeVersion -Folder $Dest -ExpectedVersion $Version)) {
      throw "installed runtime failed version check (expected $Version)"
    }
    $versionOut = & $nodeExe -v 2>&1
    if ($LASTEXITCODE -ne 0) { throw "installed runtime failed final version command (exit $LASTEXITCODE)" }
    Set-Content -LiteralPath (Join-Path $Dest 'node.version.txt') -Value "$versionOut`nwin-x64`n" -Encoding UTF8
  } catch {
    if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $Dest }
    throw
  }

  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "bootstrap-node OK -> $nodeExe ($versionOut)"
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $temp) {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
