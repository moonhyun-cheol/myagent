#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$env:PYTHONPATH = ''
$env:PYTHONHOME = ''
$env:PYTHONUTF8 = '1'
. (Join-Path $PSScriptRoot 'cqr-native.ps1')

function Test-EmbedVenvReady([string]$PythonExe) {
  if (-not $PythonExe -or -not (Test-Path -LiteralPath $PythonExe)) { return $false }
  $venvInit = Join-Path (Split-Path -Parent $PythonExe) 'Lib\venv\__init__.py'
  if (-not (Test-Path -LiteralPath $venvInit)) { return $false }
  return ((Invoke-CqrNative -FilePath $PythonExe -ArgumentList @('-c', 'import venv')) -eq 0)
}

$dest = Join-Path $Root 'runtime\python-embed'
$embedPy = Join-Path $dest 'python.exe'
if (Test-EmbedVenvReady $embedPy) { exit 0 }

$seed = Join-Path $Root 'tools\python-embed-seed'
if (-not (Test-Path -LiteralPath (Join-Path $seed 'Lib\venv'))) {
  Write-Error "bootstrap-python-embed-if-needed: missing seed $seed\Lib\venv (slim zip corrupt?)"
}

# Incomplete leftover from a failed install (python.exe without venv) — wipe and rebuild.
if (Test-Path -LiteralPath $dest) {
  Write-Host 'bootstrap-python-embed-if-needed: incomplete python-embed (no venv) — rebuilding'
  Remove-Item -LiteralPath $dest -Recurse -Force
}

Write-Host 'bootstrap-python-embed-if-needed: downloading python embed (internet required)'
& (Join-Path $PSScriptRoot 'embed-python-embed.ps1') `
  -Dest $dest `
  -VenvSeed $seed
exit $LASTEXITCODE
