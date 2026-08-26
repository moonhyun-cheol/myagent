#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path

$marker = Join-Path $Root 'runtime\oss-sidecars\.oss-sidecars-installed'
$markitdown = Join-Path $Root 'runtime\oss-sidecars\venv\Scripts\markitdown.exe'
$repomix = Join-Path $Root 'runtime\oss-sidecars\node_modules\repomix\package.json'
$sg = Join-Path $Root 'runtime\oss-sidecars\bin\ast-grep.exe'
$bundleVersion = 0
if (Test-Path -LiteralPath $marker) {
  try {
    $bundleVersion = [int]((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).bundleVersion)
  } catch {
    $bundleVersion = 0
  }
}
if ($bundleVersion -ge 4 -and (Test-Path -LiteralPath $markitdown) -and (Test-Path -LiteralPath $repomix) -and (Test-Path -LiteralPath $sg)) {
  exit 0
}

Write-Host 'bootstrap-oss-sidecars-if-needed: OSS sidecars setup (requires internet · same-experience)'
& (Join-Path $PSScriptRoot 'bootstrap-oss-sidecars.ps1') -Root $Root -SkipIfExists
exit $LASTEXITCODE
