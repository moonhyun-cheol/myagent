#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path

$pwPkg = Join-Path $Root 'node_modules\playwright\package.json'
$chromiumMarker = Join-Path $Root 'runtime\playwright\browsers\.chromium-installed'
if ((Test-Path -LiteralPath $pwPkg) -and (Test-Path -LiteralPath $chromiumMarker)) { exit 0 }

$nodeExe = Join-Path $Root 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  Write-Error 'bootstrap-playwright-if-needed: Node missing — run bootstrap-node-if-needed.ps1 first'
}

Write-Host 'bootstrap-playwright-if-needed: Playwright setup (requires internet)'
& (Join-Path $PSScriptRoot 'bootstrap-playwright.ps1') -Root $Root -SkipIfExists
exit $LASTEXITCODE
