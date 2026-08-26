#requires -Version 5.1
<#
.SYNOPSIS
  Download official Node.js Windows x64 zip into runtime/node (install-time bootstrap).
#>
param(
  [Parameter(Mandatory = $true)][string]$Dest,
  [string]$Version = $env:CQR_NODE_VERSION,
  [switch]$SkipIfExists
)

$ErrorActionPreference = 'Stop'

if (-not $Version) { $Version = '22.15.0' }

$nodeExe = Join-Path $Dest 'node.exe'
if ($SkipIfExists -and (Test-Path -LiteralPath $nodeExe)) {
  Write-Host "bootstrap-node: skipped (exists) -> $nodeExe"
  exit 0
}

$cacheDir = Join-Path $PSScriptRoot 'cache'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

$zipName = "node-v$Version-win-x64.zip"
$zipPath = Join-Path $cacheDir $zipName
$url = "https://nodejs.org/dist/v$Version/$zipName"

if (-not (Test-Path -LiteralPath $zipPath)) {
  Write-Host "bootstrap-node: downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
}

$temp = Join-Path $env:TEMP ("cqr-node-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $temp -Force
  $inner = Get-ChildItem -LiteralPath $temp -Directory | Select-Object -First 1
  if (-not $inner) {
    Write-Error "bootstrap-node: unexpected zip layout in $zipPath"
  }

  if (Test-Path -LiteralPath $Dest) {
    Remove-Item -LiteralPath $Dest -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Get-ChildItem -LiteralPath $inner.FullName -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Dest -Recurse -Force
  }

  if (-not (Test-Path -LiteralPath $nodeExe)) {
    Write-Error "bootstrap-node: node.exe not found after extract -> $Dest"
  }

  $versionOut = & $nodeExe -v 2>&1
  Set-Content -LiteralPath (Join-Path $Dest 'node.version.txt') -Value "$versionOut`nwin-x64`n" -Encoding UTF8
  Write-Host "bootstrap-node OK -> $nodeExe ($versionOut)"
} finally {
  if (Test-Path -LiteralPath $temp) {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
