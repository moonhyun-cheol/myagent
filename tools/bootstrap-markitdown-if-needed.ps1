#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$markitdown = Join-Path $Root 'runtime\oss-sidecars\venv\Scripts\markitdown.exe'
if (Test-Path -LiteralPath $markitdown) { exit 0 }

Write-Host 'bootstrap-markitdown-if-needed: Excel/PPT/email to markdown (internet)'
& (Join-Path $PSScriptRoot 'bootstrap-oss-sidecars.ps1') -Root $Root -SkipIfExists -OnlyMarkitdown
exit $LASTEXITCODE
