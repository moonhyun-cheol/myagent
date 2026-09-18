#requires -Version 5.1
<#
.SYNOPSIS
  Restore bundled production node_modules transactionally without using npm.
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$RetainBackup
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
. (Join-Path $PSScriptRoot 'core-npm-deps.ps1')

$vendored = Join-Path $Root 'nm'
$target = Join-Path $Root 'node_modules'
$staging = Join-Path $Root 'node_modules.installing'
$backup = Join-Path $Root 'node_modules.previous'
$verifyRoot = Join-Path $Root '.core-deps-verify'
$nodeExe = Join-Path $Root 'runtime\node\node.exe'

if (-not (Test-Path -LiteralPath $vendored)) {
  throw "CORE_BUNDLE_MISSING: bundled runtime dependencies were not found at $vendored"
}
if (-not (Test-Path -LiteralPath $nodeExe)) {
  throw 'CORE_NODE_MISSING: portable Node must be prepared before dependency restore'
}

# Recover an interrupted previous swap before starting a new transaction.
if (-not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $backup)) {
  Move-Item -LiteralPath $backup -Destination $target
}
Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $verifyRoot -Recurse -Force -ErrorAction SilentlyContinue
if ((Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $backup)) {
  if (Test-CoreNpmDependencies -Root $Root -NodeExe $nodeExe -Quiet) {
    Remove-Item -LiteralPath $backup -Recurse -Force
  } else {
    Remove-Item -LiteralPath $target -Recurse -Force
    Move-Item -LiteralPath $backup -Destination $target
  }
}

try {
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  Get-ChildItem -LiteralPath $vendored -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse -Force
  }

  # Validate the staged tree before touching the current runtime.
  New-Item -ItemType Directory -Force -Path $verifyRoot | Out-Null
  Move-Item -LiteralPath $staging -Destination (Join-Path $verifyRoot 'node_modules')
  Assert-CoreNpmDependencies -Root $verifyRoot -NodeExe $nodeExe
  Move-Item -LiteralPath (Join-Path $verifyRoot 'node_modules') -Destination $staging
  Remove-Item -LiteralPath $verifyRoot -Recurse -Force
} catch {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $verifyRoot -Recurse -Force -ErrorAction SilentlyContinue
  throw "CORE_BUNDLE_VERIFY_FAILED: $($_.Exception.Message)"
}

$swapped = $false
try {
  if (Test-Path -LiteralPath $target) {
    Move-Item -LiteralPath $target -Destination $backup
  }
  Move-Item -LiteralPath $staging -Destination $target
  $swapped = $true
  Assert-CoreNpmDependencies -Root $Root -NodeExe $nodeExe
  if (-not $RetainBackup) {
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Core runtime dependencies restored and verified offline -> $target"
} catch {
  if (Test-Path -LiteralPath $backup) {
    # A failed directory move may leave a target entry even before `$swapped`
    # becomes true. Always clear that partial target before restoring backup.
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    }
    Move-Item -LiteralPath $backup -Destination $target
  } elseif ($swapped -and (Test-Path -LiteralPath $target)) {
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
  }
  throw "CORE_BUNDLE_RESTORE_FAILED: $($_.Exception.Message)"
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $verifyRoot -Recurse -Force -ErrorAction SilentlyContinue
}
