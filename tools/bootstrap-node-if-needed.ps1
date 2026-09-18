#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path

$nodeExe = Join-Path $Root 'runtime\node\node.exe'
$releaseVersion = '22.15.0'
$allowVersionOverride = (Test-Path -LiteralPath (Join-Path $Root '.git')) -or
  (Test-Path -LiteralPath (Join-Path $Root 'tools\install\ALLOW-NODE-VERSION-OVERRIDE'))
$expectedVersion = if ($allowVersionOverride -and $env:CQR_NODE_VERSION) {
  [string]$env:CQR_NODE_VERSION
} else {
  $releaseVersion
}
if (-not $allowVersionOverride -and $env:CQR_NODE_VERSION -and $env:CQR_NODE_VERSION -ne $releaseVersion) {
  Write-Host "bootstrap-node-if-needed: ignoring CQR_NODE_VERSION in a release install (fixed=$releaseVersion)"
}
$installedVersion = $null
if (Test-Path -LiteralPath $nodeExe) {
  try {
    $installedVersion = (& $nodeExe -p 'process.versions.node' 2>$null | Select-Object -First 1).ToString().Trim()
  } catch {
    $installedVersion = $null
  }
}
if ($installedVersion -eq $expectedVersion) { exit 0 }
if (Test-Path -LiteralPath $nodeExe) {
  Write-Host "bootstrap-node-if-needed: repairing invalid or unexpected Node runtime (found=$installedVersion expected=$expectedVersion)"
} else {
  Write-Host 'bootstrap-node-if-needed: first-run Node setup (internet required)'
}
$dest = Join-Path $Root 'runtime\node'
& (Join-Path $PSScriptRoot 'bootstrap-node.ps1') -Dest $dest -Version $expectedVersion
exit $LASTEXITCODE
