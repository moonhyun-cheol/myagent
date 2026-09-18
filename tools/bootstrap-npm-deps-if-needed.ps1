#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$AllowOnlineInstall
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
. (Join-Path $PSScriptRoot 'core-npm-deps.ps1')

$nodeExe = Join-Path $Root 'runtime\node\node.exe'
if (Test-CoreNpmDependencies -Root $Root -NodeExe $nodeExe -Quiet) { exit 0 }

if (-not $AllowOnlineInstall) {
  Write-Error 'CORE_DEPENDENCIES_INVALID: bundled dependencies are missing or cannot be loaded; release installers do not fall back to online npm.'
}

$script = Join-Path $PSScriptRoot 'bootstrap-npm-deps.ps1'
& $script -Root $Root -AllowOnlineInstall
exit $LASTEXITCODE
