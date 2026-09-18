#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$repomix = Join-Path $Root 'runtime\oss-sidecars\node_modules\repomix\package.json'
$repomixCmd = Join-Path $Root 'runtime\oss-sidecars\node_modules\.bin\repomix.cmd'
if ((Test-Path -LiteralPath $repomix) -and (Test-Path -LiteralPath $repomixCmd)) { exit 0 }

Write-Host 'bootstrap-repomix-if-needed: repo pack helper (internet)'
& (Join-Path $PSScriptRoot 'bootstrap-oss-sidecars.ps1') -Root $Root -SkipIfExists -OnlyRepomix
exit $LASTEXITCODE
