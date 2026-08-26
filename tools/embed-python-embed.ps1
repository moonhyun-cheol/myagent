#requires -Version 5.1
<#
.SYNOPSIS
  Download and prepare python.org embeddable Python for portable pipeline venv bootstrap.
#>
param(
  [Parameter(Mandatory = $true)][string]$Dest,
  [string]$Version = $env:CQR_PYTHON_EMBED_VERSION,
  [string]$VenvSeed = '',
  [switch]$SkipIfExists
)

$ErrorActionPreference = 'Stop'

# Host PYTHONHOME/PYTHONPATH (other projects) break embeddable Python hard.
$env:PYTHONPATH = ''
$env:PYTHONHOME = ''
$env:PYTHONUTF8 = '1'
. (Join-Path $PSScriptRoot 'cqr-native.ps1')

if (-not $Version) { $Version = '3.12.7' }

function Test-EmbedVenvReady([string]$PythonExe) {
  if (-not $PythonExe -or -not (Test-Path -LiteralPath $PythonExe)) { return $false }
  $venvInit = Join-Path (Split-Path -Parent $PythonExe) 'Lib\venv\__init__.py'
  if (-not (Test-Path -LiteralPath $venvInit)) { return $false }
  return ((Invoke-CqrNative -FilePath $PythonExe -ArgumentList @('-c', 'import venv')) -eq 0)
}

$pythonExe = Join-Path $Dest 'python.exe'
if ($SkipIfExists -and (Test-EmbedVenvReady $pythonExe)) {
  Write-Host "embed-python-embed: skipped (ready) -> $pythonExe"
  exit 0
}

$cacheDir = Join-Path $PSScriptRoot 'cache'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

$zipName = "python-$Version-embed-amd64.zip"
$zipPath = Join-Path $cacheDir $zipName
$url = "https://www.python.org/ftp/python/$Version/$zipName"

if (-not (Test-Path -LiteralPath $zipPath)) {
  Write-Host "embed-python-embed: downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
}

if (Test-Path -LiteralPath $Dest) {
  # Prefer rename-away so locked files (AV / leftover pythonw) do not block Expand-Archive.
  $bak = "$Dest.__old_$([guid]::NewGuid().ToString('n').Substring(0, 8))"
  try {
    Move-Item -LiteralPath $Dest -Destination $bak -Force
  } catch {
    Remove-Item -LiteralPath $Dest -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $bak) {
    Start-Job -ScriptBlock {
      param($p)
      Start-Sleep -Seconds 2
      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    } -ArgumentList $bak | Out-Null
  }
}
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$tmpExpand = Join-Path $env:TEMP ("cqr-pyembed-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Force -Path $tmpExpand | Out-Null
try {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $tmpExpand -Force
  Get-ChildItem -LiteralPath $tmpExpand -Force | ForEach-Object {
    Move-Item -LiteralPath $_.FullName -Destination (Join-Path $Dest $_.Name) -Force
  }
} finally {
  if (Test-Path -LiteralPath $tmpExpand) {
    Remove-Item -LiteralPath $tmpExpand -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-EmbedVenvStdlib {
  param([string]$TargetDest, [string]$SeedRoot = '')
  # Install-time path first: slim zip ships only Lib/venv as a seed (no full embed).
  # Must not call `py`/`python` before this — target PCs often lack the launcher.
  if ($SeedRoot) {
    $seedVenv = Join-Path $SeedRoot 'Lib\venv'
    if (Test-Path -LiteralPath $seedVenv) {
      $lib = Join-Path $TargetDest 'Lib'
      New-Item -ItemType Directory -Force -Path $lib | Out-Null
      Copy-Item -LiteralPath $seedVenv -Destination (Join-Path $lib 'venv') -Recurse -Force
      Write-Host "embed-python-embed: bundled stdlib venv from seed $seedVenv"
      return
    }
  }
  foreach ($cmd in @(@('py', '-3.12'), @('py', '-3.11'), @('python'))) {
    try {
      $exe = $cmd[0]
      if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
      $venvDir = & $exe @($cmd | Select-Object -Skip 1) -c "import venv, os; print(os.path.dirname(venv.__file__))" 2>$null
      if ($LASTEXITCODE -eq 0 -and $venvDir) {
        $lib = Join-Path $TargetDest 'Lib'
        New-Item -ItemType Directory -Force -Path $lib | Out-Null
        Copy-Item -LiteralPath $venvDir -Destination (Join-Path $lib 'venv') -Recurse -Force
        Write-Host "embed-python-embed: bundled stdlib venv from $venvDir"
        return
      }
    } catch {
      continue
    }
  }
  Write-Error 'embed-python-embed: need Python 3.11+ on the publish PC, or -VenvSeed with Lib\venv for install-time bootstrap'
}

Install-EmbedVenvStdlib -TargetDest $Dest -SeedRoot $VenvSeed

$pthFiles = Get-ChildItem -LiteralPath $Dest -Filter 'python*._pth' -File
if ($pthFiles.Count -eq 0) {
  Write-Error "embed-python-embed: python*._pth not found in $Dest"
}
$pthPath = $pthFiles[0].FullName
$pthLines = Get-Content -LiteralPath $pthPath -Encoding UTF8
$fixed = @()
$hasImportSite = $false
$hasLib = $false
foreach ($line in $pthLines) {
  $line = $line.TrimStart([char]0xFEFF).Trim()
  if ($line -match '^\s*#\s*import\s+site\s*$') {
    $fixed += 'import site'
    $hasImportSite = $true
  } elseif ($line -match '^\s*import\s+site\s*$') {
    $fixed += 'import site'
    $hasImportSite = $true
  } elseif ($line -eq 'Lib') {
    $hasLib = $true
    $fixed += $line
  } elseif ($line) {
    $fixed += $line
  }
}
if (-not $hasLib) {
  $dotIdx = [array]::IndexOf($fixed, '.')
  if ($dotIdx -ge 0) {
    $fixed = @($fixed[0..$dotIdx]) + @('Lib') + @($fixed[($dotIdx + 1)..($fixed.Length - 1)])
  } else {
    $fixed = @('Lib') + $fixed
  }
}
if (-not $hasImportSite) { $fixed += 'import site' }
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines($pthPath, $fixed, $utf8NoBom)

$pythonExe = Join-Path $Dest 'python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) {
  Write-Error "embed-python-embed: python.exe not found in $Dest"
}

try {
  $pipExe = Join-Path $Dest 'Scripts\pip.exe'
  if (-not (Test-Path -LiteralPath $pipExe)) {
    $getPip = Join-Path $cacheDir 'get-pip.py'
    if (-not (Test-Path -LiteralPath $getPip)) {
      Write-Host 'embed-python-embed: downloading get-pip.py'
      Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip -UseBasicParsing
    }
    Write-Host 'embed-python-embed: bootstrapping pip'
    $code = Invoke-CqrNative -FilePath $pythonExe -ArgumentList @($getPip, '--no-warn-script-location')
    if ($code -ne 0) { exit $code }
  }

  $versionOut = ''
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $verLines = & $pythonExe -c "import sys; print(sys.version.split()[0])" 2>&1
  $verCode = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($verCode -ne 0) {
    Write-Error "embed-python-embed: python smoke test failed: $verLines"
  }
  $versionOut = (@($verLines | ForEach-Object { "$_" }) | Where-Object { $_ -match '^\d' } | Select-Object -First 1)
  if (-not $versionOut) { $versionOut = 'ok' }
  if ((Invoke-CqrNative -FilePath $pythonExe -ArgumentList @('-c', 'import venv')) -ne 0) {
    Write-Error 'embed-python-embed: import venv failed after seed — Lib\venv missing or python*._pth incomplete'
  }
  Write-Host "embed-python-embed OK -> $pythonExe ($versionOut, venv ready)"
} finally {
  $env:PYTHONPATH = ''
  $env:PYTHONHOME = ''
}
