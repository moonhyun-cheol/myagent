#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path

$mcpPkg = Join-Path $Root 'node_modules\@modelcontextprotocol\sdk\package.json'
if (Test-Path -LiteralPath $mcpPkg) { exit 0 }

$script = Join-Path $PSScriptRoot 'bootstrap-npm-deps.ps1'
& $script -Root $Root
exit $LASTEXITCODE
