#requires -Version 5.1
<#
.SYNOPSIS
  Install playwright npm package and Chromium into runtime/playwright/browsers.
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$SkipIfExists
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
. (Join-Path $PSScriptRoot 'cqr-native.ps1')

$browsersDir = Join-Path $Root 'runtime\playwright\browsers'
$pwPkg = Join-Path $Root 'node_modules\playwright\package.json'
$chromiumMarker = Join-Path $browsersDir '.chromium-installed'

if ($SkipIfExists -and (Test-Path -LiteralPath $pwPkg) -and (Test-Path -LiteralPath $chromiumMarker)) {
  Write-Host "bootstrap-playwright: skipped (exists) -> $browsersDir"
  exit 0
}

$nodeExe = Join-Path $Root 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $sysNode = Get-Command node -ErrorAction SilentlyContinue
  if ($sysNode -and $sysNode.Source -and (Test-Path -LiteralPath $sysNode.Source)) {
    $nodeExe = $sysNode.Source
  } else {
    $nodeExe = $null
  }
}
if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
  Write-Error 'bootstrap-playwright: Node not found. Run tools\bootstrap-node.ps1 first or install Node 22+.'
}

# Hangul profile / no system Node: npx.cmd falls back to PATH "node" and cmd fails.
# Keep portable node first on PATH for any child that still spawns `node`.
$nodeDir = Split-Path -Parent $nodeExe
if ($nodeDir) {
  $env:PATH = $nodeDir + [IO.Path]::PathSeparator + $env:PATH
}

New-Item -ItemType Directory -Force -Path $browsersDir | Out-Null
$env:PLAYWRIGHT_BROWSERS_PATH = $browsersDir
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '0'

Push-Location $Root
try {
  Write-Host "bootstrap-playwright: installing playwright package (node=$nodeExe)"
  $npmCli = Join-Path $Root 'runtime\node\node_modules\npm\bin\npm-cli.js'
  $code = 1
  if (Test-Path -LiteralPath $npmCli) {
    $code = Invoke-CqrNative -FilePath $nodeExe -ArgumentList @($npmCli, 'install', 'playwright@^1.52.0', '--save-optional', '--no-fund', '--no-audit')
  }
  if ($code -ne 0) {
    $sysNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $sysNpm) { $sysNpm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $sysNpm -or -not $sysNpm.Source) {
      Write-Error 'bootstrap-playwright: npm not found (portable npm-cli missing and no system npm). Run tools\bootstrap-node-if-needed.ps1 first.'
    }
    $code = Invoke-CqrNative -FilePath $sysNpm.Source -ArgumentList @('install', 'playwright@^1.52.0', '--save-optional', '--no-fund', '--no-audit')
    if ($code -ne 0) { exit $code }
  }

  if (-not (Test-Path -LiteralPath $pwPkg)) {
    Write-Error "bootstrap-playwright: playwright package missing after npm install"
  }

  Write-Host "bootstrap-playwright: downloading Chromium -> $browsersDir"
  # Call node.exe + cli.js (same as npm-cli). Do not use npx.cmd: %~dp0 / PATH
  # fallback breaks on non-ASCII user profiles when Node is not on PATH.
  $cliJs = Join-Path $Root 'node_modules\playwright\cli.js'
  if (-not (Test-Path -LiteralPath $cliJs)) {
    Write-Error 'bootstrap-playwright: playwright CLI not found after package install'
  }
  $code = Invoke-CqrNative -FilePath $nodeExe -ArgumentList @($cliJs, 'install', 'chromium')
  if ($code -ne 0) { exit $code }

  Set-Content -LiteralPath $chromiumMarker -Value (Get-Date -Format o) -Encoding UTF8
  Write-Host "bootstrap-playwright OK -> $browsersDir"

  $configPath = Join-Path $Root 'data\config\user-overrides.json'
  $configDir = Split-Path -Parent $configPath
  if (-not (Test-Path -LiteralPath $configDir)) {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  }
  $overridesObj = $null
  if (Test-Path -LiteralPath $configPath) {
    try {
      $overridesObj = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      $overridesObj = $null
    }
  }
  if (-not $overridesObj) {
    $overridesObj = New-Object PSObject
  }
  if ($overridesObj.playwright_allow_localhost -ne $true) {
    $overridesObj | Add-Member -NotePropertyName playwright_allow_localhost -NotePropertyValue $true -Force
    ($overridesObj | ConvertTo-Json -Depth 8) + "`n" | Set-Content -LiteralPath $configPath -Encoding UTF8
    Write-Host 'bootstrap-playwright: enabled playwright_allow_localhost in data\config\user-overrides.json'
  }
} finally {
  Pop-Location
}
