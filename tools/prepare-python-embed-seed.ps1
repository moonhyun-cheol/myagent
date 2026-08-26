#requires -Version 5.1
<#
.SYNOPSIS
  Copy CPython Lib/venv into a tiny seed folder for install-time python-embed bootstrap.
  Keeps the slim install zip free of the ~32MB embeddable runtime.
#>
param(
  [Parameter(Mandatory = $true)][string]$Dest
)

$ErrorActionPreference = 'Stop'

if (Test-Path -LiteralPath $Dest) {
  Remove-Item -LiteralPath $Dest -Recurse -Force
}
$libDir = Join-Path $Dest 'Lib'
New-Item -ItemType Directory -Force -Path $libDir | Out-Null

$copied = $false
foreach ($cmd in @(@('py', '-3.12'), @('py', '-3.11'), @('python'))) {
  try {
    $exe = $cmd[0]
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    $venvDir = & $exe @($cmd | Select-Object -Skip 1) -c "import venv, os; print(os.path.dirname(venv.__file__))" 2>$null
    if ($LASTEXITCODE -eq 0 -and $venvDir -and (Test-Path -LiteralPath $venvDir)) {
      # Destination must not exist yet — otherwise Copy-Item nests as Lib\venv\venv.
      $venvDest = Join-Path $libDir 'venv'
      Copy-Item -LiteralPath $venvDir -Destination $venvDest -Recurse -Force
      if (-not (Test-Path -LiteralPath (Join-Path $venvDest '__init__.py'))) {
        Write-Error "prepare-python-embed-seed: expected $venvDest\__init__.py after copy"
      }
      $copied = $true
      Write-Host "prepare-python-embed-seed: copied venv from $venvDir"
      break
    }
  } catch {
    continue
  }
}

if (-not $copied) {
  Write-Error 'prepare-python-embed-seed: publish PC needs Python 3.11+ (stdlib venv module)'
}

Write-Host "prepare-python-embed-seed OK -> $Dest"
