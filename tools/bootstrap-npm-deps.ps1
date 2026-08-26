#requires -Version 5.1
<#
.SYNOPSIS
  Install runtime npm dependencies required by core/dist (e.g. @modelcontextprotocol/sdk).
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$SkipIfExists
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
. (Join-Path $PSScriptRoot 'cqr-native.ps1')

$mcpPkg = Join-Path $Root 'node_modules\@modelcontextprotocol\sdk\package.json'
if ($SkipIfExists -and (Test-Path -LiteralPath $mcpPkg)) {
  Write-Host "bootstrap-npm-deps: skipped (exists) -> $mcpPkg"
  exit 0
}

$pkgJson = Join-Path $Root 'package.json'
if (-not (Test-Path -LiteralPath $pkgJson)) {
  Write-Error "bootstrap-npm-deps: package.json missing -> $pkgJson"
}

# Prefer portable Node from install bootstrap — target PCs often have no system npm.
$nodeExe = Join-Path $Root 'runtime\node\node.exe'
$npmCli = Join-Path $Root 'runtime\node\node_modules\npm\bin\npm-cli.js'
$npmCmd = $null
$npmViaNode = $false

if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $npmCli)) {
  $npmViaNode = $true
} else {
  foreach ($candidate in @(
    (Join-Path $Root 'runtime\node\npm.cmd'),
    (Join-Path $env:ProgramFiles 'nodejs\npm.cmd')
  )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      $npmCmd = $candidate
      break
    }
  }
  if (-not $npmCmd) {
    $sys = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $sys) { $sys = Get-Command npm -ErrorAction SilentlyContinue }
    if ($sys -and $sys.Source) { $npmCmd = $sys.Source }
  }
}

if (-not $npmViaNode -and -not $npmCmd) {
  Write-Error 'bootstrap-npm-deps: npm not found. Run tools\bootstrap-node-if-needed.ps1 first, or install Node.js 22+.'
}

Push-Location $Root
try {
  if ($npmViaNode) {
    Write-Host "bootstrap-npm-deps: installing production dependencies (node=$nodeExe npm-cli)"
    $code = Invoke-CqrNative -FilePath $nodeExe -ArgumentList @($npmCli, 'install', '--omit=dev', '--no-fund', '--no-audit')
  } else {
    Write-Host "bootstrap-npm-deps: installing production dependencies (npm=$npmCmd)"
    $code = Invoke-CqrNative -FilePath $npmCmd -ArgumentList @('install', '--omit=dev', '--no-fund', '--no-audit')
  }
  if ($code -ne 0) { exit $code }

  if (-not (Test-Path -LiteralPath $mcpPkg)) {
    Write-Error "bootstrap-npm-deps: @modelcontextprotocol/sdk still missing after npm install"
  }

  Write-Host "bootstrap-npm-deps OK -> $mcpPkg"
  exit 0
}
finally {
  Pop-Location
}
