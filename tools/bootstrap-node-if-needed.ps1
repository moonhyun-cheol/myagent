#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path

$nodeExe = Join-Path $Root 'runtime\node\node.exe'
if (Test-Path -LiteralPath $nodeExe) { exit 0 }

Write-Host 'bootstrap-node-if-needed: first-run Node setup (internet required)'
$dest = Join-Path $Root 'runtime\node'
& (Join-Path $PSScriptRoot 'bootstrap-node.ps1') -Dest $dest -SkipIfExists
exit $LASTEXITCODE
