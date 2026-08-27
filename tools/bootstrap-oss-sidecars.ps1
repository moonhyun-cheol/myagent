#requires -Version 5.1
<#
.SYNOPSIS
  Install portable OSS sidecars under runtime/oss-sidecars (markitdown, repomix, ast-grep).
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$SkipIfExists,
  [switch]$SkipAstGrep,
  [switch]$OnlyMarkitdown,
  [switch]$OnlyRepomix,
  [switch]$OnlyAstGrep,
  [string]$AstGrepVersion = '0.45.0'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$ossRoot = Join-Path $Root 'runtime\oss-sidecars'
$venvDir = Join-Path $ossRoot 'venv'
$venvPy = Join-Path $venvDir 'Scripts\python.exe'
$markitdownExe = Join-Path $venvDir 'Scripts\markitdown.exe'
$marker = Join-Path $ossRoot '.oss-sidecars-installed'
$req = Join-Path $Root 'tools\requirements-oss-sidecars.txt'
$pkgTemplate = Join-Path $Root 'tools\oss-sidecars-package.json'
$repomixPkg = Join-Path $ossRoot 'node_modules\repomix\package.json'
$binDir = Join-Path $ossRoot 'bin'
$sgExe = Join-Path $ossRoot 'bin\ast-grep.exe'

$bundleVersion = 4
$installedBundleVersion = 0
if (Test-Path -LiteralPath $marker) {
  try {
    $installedBundleVersion = [int]((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).bundleVersion)
  } catch {
    $installedBundleVersion = 0
  }
}
if ($installedBundleVersion -lt 2 -and (Test-Path -LiteralPath $venvDir)) {
  Write-Host 'bootstrap-oss-sidecars: refreshing Python sidecar environment'
  Remove-Item -LiteralPath $venvDir -Recurse -Force
}
if ($installedBundleVersion -lt 3) {
  foreach ($legacyName in @('goose.exe', 'goose')) {
    $legacyPath = Join-Path $binDir $legacyName
    if (Test-Path -LiteralPath $legacyPath) {
      Write-Host "bootstrap-oss-sidecars: removing retired coding sidecar ($legacyName)"
      Remove-Item -LiteralPath $legacyPath -Force
    }
  }
}

$onlyAny = $OnlyMarkitdown -or $OnlyRepomix -or $OnlyAstGrep
$wantMarkitdown = if ($onlyAny) { [bool]$OnlyMarkitdown } else { $true }
$wantRepomix = if ($onlyAny) { [bool]$OnlyRepomix } else { $true }
$wantAstGrep = if ($onlyAny) { [bool]$OnlyAstGrep -and -not $SkipAstGrep } else { -not $SkipAstGrep }

$complete = (Test-Path -LiteralPath $markitdownExe) -and (Test-Path -LiteralPath $repomixPkg) -and (Test-Path -LiteralPath $sgExe)
$needMarkitdown = $wantMarkitdown -and -not (Test-Path -LiteralPath $markitdownExe)
$needRepomix = $wantRepomix -and -not (Test-Path -LiteralPath $repomixPkg)
$needAstGrep = $wantAstGrep -and -not (Test-Path -LiteralPath $sgExe)
if ($SkipIfExists -and -not $needMarkitdown -and -not $needRepomix -and -not $needAstGrep) {
  Write-Host 'bootstrap-oss-sidecars: skipped (selected components exist)'
  exit 0
}
if ($SkipIfExists -and -not $onlyAny -and $installedBundleVersion -ge $bundleVersion -and (Test-Path -LiteralPath $marker) -and $complete) {
  Write-Host 'bootstrap-oss-sidecars: skipped (exists)'
  exit 0
}

New-Item -ItemType Directory -Force -Path $ossRoot | Out-Null
$warnings = New-Object System.Collections.Generic.List[string]

function Resolve-BootstrapPython([string]$AppRoot) {
  $candidates = @(
    (Join-Path $AppRoot 'runtime\python-embed\python.exe'),
    (Join-Path $AppRoot 'runtime\pipeline-venv\Scripts\python.exe')
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  $sys = Get-Command python -ErrorAction SilentlyContinue
  if ($sys) { return $sys.Source }
  return $null
}

function Resolve-BootstrapNpm([string]$AppRoot) {
  $npmCmd = Join-Path $AppRoot 'runtime\node\npm.cmd'
  if (Test-Path -LiteralPath $npmCmd) { return $npmCmd }
  $sys = Get-Command npm -ErrorAction SilentlyContinue
  if ($sys) { return $sys.Source }
  return $null
}

# --- Python venv: markitdown ---
if ($wantMarkitdown) {
$py = Resolve-BootstrapPython $Root
if (-not $py) {
  $warnings.Add('No Python for oss-sidecars venv (python-embed / pipeline-venv / PATH)')
} else {
  try {
    if (-not (Test-Path -LiteralPath $venvPy)) {
      Write-Host "bootstrap-oss-sidecars: creating venv ($py)"
      & $py -m venv $venvDir
      if ($LASTEXITCODE -ne 0) { throw "venv exit $LASTEXITCODE" }
    }
    Write-Host 'bootstrap-oss-sidecars: pip install markitdown (internet)'
    & $venvPy -m pip install --upgrade pip | Out-Host
    if (Test-Path -LiteralPath $req) {
      & $venvPy -m pip install -r $req | Out-Host
    } else {
      & $venvPy -m pip install 'markitdown[pptx,xlsx,xls,outlook]>=0.1.0' | Out-Host
    }
    if ($LASTEXITCODE -ne 0) { throw "pip exit $LASTEXITCODE" }
  } catch {
    $warnings.Add("Python sidecars: $($_.Exception.Message)")
  }
}
}

# --- Node: repomix under runtime/oss-sidecars ---
if ($wantRepomix) {
$npm = Resolve-BootstrapNpm $Root
if (-not $npm) {
  $warnings.Add('npm missing — skip repomix')
} elseif (-not (Test-Path -LiteralPath $pkgTemplate)) {
  $warnings.Add('tools/oss-sidecars-package.json missing — skip repomix')
} else {
  try {
    Copy-Item -LiteralPath $pkgTemplate -Destination (Join-Path $ossRoot 'package.json') -Force
    Write-Host 'bootstrap-oss-sidecars: npm install repomix (internet)'
    Push-Location $ossRoot
    try {
      & $npm install --no-fund --no-audit | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "npm exit $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
  } catch {
    $warnings.Add("repomix: $($_.Exception.Message)")
  }
}
}

# --- ast-grep portable binary ---
if ($wantAstGrep) {
  $sgExe = Join-Path $binDir 'ast-grep.exe'
  if (-not (Test-Path -LiteralPath $sgExe)) {
    try {
      New-Item -ItemType Directory -Force -Path $binDir | Out-Null
      $url = "https://github.com/ast-grep/ast-grep/releases/download/$AstGrepVersion/app-x86_64-pc-windows-msvc.zip"
      $zip = Join-Path $env:TEMP "ast-grep-$AstGrepVersion.zip"
      Write-Host "bootstrap-oss-sidecars: downloading ast-grep $AstGrepVersion"
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
      Expand-Archive -LiteralPath $zip -DestinationPath $binDir -Force
      Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $sgExe)) {
        $found = Get-ChildItem -Path $binDir -Filter 'ast-grep.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { Copy-Item -LiteralPath $found.FullName -Destination $sgExe -Force }
      }
      if (-not (Test-Path -LiteralPath $sgExe)) { throw 'ast-grep.exe not found after extract' }
    } catch {
      $warnings.Add("ast-grep: $($_.Exception.Message)")
    }
  }
}

$stamp = @{
  bundleVersion = $bundleVersion
  at = (Get-Date -Format o)
  markitdown = [bool](Test-Path -LiteralPath $markitdownExe)
  repomix = [bool](Test-Path -LiteralPath (Join-Path $ossRoot 'node_modules\repomix\package.json'))
  astGrep = [bool](Test-Path -LiteralPath (Join-Path $ossRoot 'bin\ast-grep.exe'))
  warnings = @($warnings)
}
Set-Content -LiteralPath $marker -Value ($stamp | ConvertTo-Json -Depth 4) -Encoding utf8

foreach ($w in $warnings) {
  Write-Warning "bootstrap-oss-sidecars: $w"
}

$wantedMissing = ($wantMarkitdown -and -not $stamp.markitdown) -or ($wantRepomix -and -not $stamp.repomix) -or ($wantAstGrep -and -not $stamp.astGrep)
if ($wantedMissing -and -not $stamp.markitdown -and -not $stamp.repomix -and -not $stamp.astGrep) {
  Write-Warning 'bootstrap-oss-sidecars: nothing installed (offline or missing runtimes)'
  exit 0
}

Write-Host "bootstrap-oss-sidecars: done (markitdown=$($stamp.markitdown) repomix=$($stamp.repomix) ast-grep=$($stamp.astGrep))"
exit 0
