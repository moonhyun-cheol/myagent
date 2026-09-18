#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
. (Join-Path $PSScriptRoot 'playwright-runtime.ps1')

if (Test-PlaywrightRuntime -Root $Root) {
  # Runtime files can be complete while a previous user-overrides write failed.
  # Always retry the required policy without redownloading Playwright/Chromium.
  Enable-PlaywrightLocalhostPolicy -Root $Root
  exit 0
}

$nodeExe = Join-Path $Root 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  Write-Error 'bootstrap-playwright-if-needed: Node missing — run bootstrap-node-if-needed.ps1 first'
}

Write-Host 'bootstrap-playwright-if-needed: Playwright setup (requires internet)'
& (Join-Path $PSScriptRoot 'bootstrap-playwright.ps1') -Root $Root -SkipIfExists
exit $LASTEXITCODE
