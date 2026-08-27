#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$sg = Join-Path $Root 'runtime\oss-sidecars\bin\ast-grep.exe'
if (Test-Path -LiteralPath $sg) { exit 0 }

Write-Host 'bootstrap-ast-grep-if-needed: structural code search (internet)'
& (Join-Path $PSScriptRoot 'bootstrap-oss-sidecars.ps1') -Root $Root -SkipIfExists -OnlyAstGrep
exit $LASTEXITCODE
