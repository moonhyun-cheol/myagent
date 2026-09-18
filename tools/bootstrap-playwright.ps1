#requires -Version 5.1
<#
.SYNOPSIS
  Install playwright npm package and Chromium into runtime/playwright/browsers.
.DESCRIPTION
  Hardened against the two ways this step used to stall a fresh install:
    1. Permission preflight  - fail fast with a clear message when node_modules
       or the browsers dir is not writable (antivirus / Controlled Folder Access
       / inherited ACL), instead of hanging mid-download.
    2. Download timeout      - npm install and the Chromium download are bounded;
       a hung network no longer blocks the whole installer forever.
    3. Partial cleanup       - an interrupted previous attempt (marker missing but
       browsers dir present) is removed before retry so a corrupt/partial tree is
       never inherited, including when reinstalling to a different path.
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$SkipIfExists,
  [int]$DownloadTimeoutSec = 900,
  [int]$NpmTimeoutSec = 600
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
. (Join-Path $PSScriptRoot 'cqr-native.ps1')
. (Join-Path $PSScriptRoot 'playwright-runtime.ps1')

$browsersDir = Join-Path $Root 'runtime\playwright\browsers'
$packageRoot = Join-Path $Root 'runtime\playwright\package'
$pwPkg = Join-Path $packageRoot 'node_modules\playwright\package.json'
$chromiumMarker = Join-Path $browsersDir '.chromium-installed'

if ($SkipIfExists -and (Test-PlaywrightRuntime -Root $Root)) {
  Enable-PlaywrightLocalhostPolicy -Root $Root
  Write-Host "bootstrap-playwright: skipped (exists) -> $browsersDir"
  exit 0
}

# --- Permission preflight -----------------------------------------------------
# Verify create+delete before starting the ~300MB download so a blocked folder
# surfaces immediately with actionable text rather than a silent stall.
function Test-PlaywrightPathWritable([string]$folder) {
  try {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $probe = Join-Path $folder ('.pw-probe-{0}-{1}' -f $PID, [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($probe, 'probe')
    Remove-Item -LiteralPath $probe -Force
    return $true
  } catch {
    return $false
  }
}
foreach ($needWritable in @($packageRoot, $browsersDir)) {
  if (-not (Test-PlaywrightPathWritable $needWritable)) {
    Write-Error "bootstrap-playwright: no write permission for '$needWritable'. Antivirus, Windows Controlled Folder Access, or inherited folder permissions are blocking create/delete. Allow this folder (or reinstall MY Agent to a per-user folder) and retry."
  }
}

# --- Node resolution ----------------------------------------------------------
$nodeExe = Join-Path $Root 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $sysNode = Get-Command node -ErrorAction SilentlyContinue
  if ($sysNode -and $sysNode.Source -and (Test-Path -LiteralPath $sysNode.Source)) {
    $nodeExe = $sysNode.Source
  } else {
    $nodeExe = $null
  }
}
if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
  Write-Error 'bootstrap-playwright: Node not found. Run tools\bootstrap-node.ps1 first or install Node 22+.'
}

# Hangul profile / no system Node: npx.cmd falls back to PATH "node" and cmd fails.
# Keep portable node first on PATH for any child that still spawns `node`.
$nodeDir = Split-Path -Parent $nodeExe
if ($nodeDir) {
  $env:PATH = $nodeDir + [IO.Path]::PathSeparator + $env:PATH
}

# --- Timeout-bounded native runner --------------------------------------------
# Bounds a child process so a stalled network cannot hang the installer forever.
# Returns the exit code, or 124 (timed out) after killing the process tree.
function Invoke-CqrNativeTimed {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [int]$TimeoutSec = 600
  )
  if (-not (Test-Path -LiteralPath $FilePath)) {
    Write-Host "Invoke-CqrNativeTimed: not found: $FilePath"
    return 1
  }
  $nativeArguments = @($ArgumentList | ForEach-Object { ConvertTo-CqrNativeArgument ([string]$_) }) -join ' '
  $proc = Start-Process -FilePath $FilePath -ArgumentList $nativeArguments -NoNewWindow -PassThru
  if (-not $proc.WaitForExit([int]([Math]::Max(1, $TimeoutSec) * 1000))) {
    Write-Host "bootstrap-playwright: step exceeded ${TimeoutSec}s -> aborting hung process (pid=$($proc.Id))"
    try { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null } catch { }
    return 124
  }
  # Ensure ExitCode is materialized after a bounded wait.
  try { $proc.WaitForExit() } catch { }
  return [int]$proc.ExitCode
}

# --- Partial cleanup before retry --------------------------------------------
# A marker without a real browser binary is stale. Remove that browser tree so
# the retry cannot inherit a false-complete or antivirus-truncated download.
if ((Test-Path -LiteralPath $browsersDir) -and -not (Test-PlaywrightChromiumBundle -BrowsersDir $browsersDir)) {
  Write-Host "bootstrap-playwright: removing incomplete browsers dir before retry -> $browsersDir"
  Remove-Item -LiteralPath $browsersDir -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $browsersDir | Out-Null
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
$env:PLAYWRIGHT_BROWSERS_PATH = $browsersDir
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '0'

Push-Location $packageRoot
try {
  $packageJson = '{"name":"my-agent-playwright-runtime","private":true,"version":"1.0.0","dependencies":{"playwright":"' + $script:MyAgentPlaywrightVersion + '"}}'
  [IO.File]::WriteAllText((Join-Path $packageRoot 'package.json'), $packageJson + "`n", [Text.UTF8Encoding]::new($false))
  Write-Host "bootstrap-playwright: installing isolated playwright package $script:MyAgentPlaywrightVersion (node=$nodeExe)"
  $npmCli = Join-Path $Root 'runtime\node\node_modules\npm\bin\npm-cli.js'
  $code = 1
  $playwrightInstallArgs = @('install', '--omit=dev', '--package-lock=false', '--no-fund', '--no-audit')
  if (Test-Path -LiteralPath $npmCli) {
    $code = Invoke-CqrNativeTimed -FilePath $nodeExe -ArgumentList (@($npmCli) + $playwrightInstallArgs) -TimeoutSec $NpmTimeoutSec
    if ($code -eq 124) {
      Write-Error "bootstrap-playwright: npm install timed out after ${NpmTimeoutSec}s. Check internet/proxy and retry."
    }
    if ($code -ne 0) { exit $code }
  } else {
    $sysNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $sysNpm) { $sysNpm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $sysNpm -or -not $sysNpm.Source) {
      Write-Error 'bootstrap-playwright: npm not found (portable npm-cli missing and no system npm). Run tools\bootstrap-node-if-needed.ps1 first.'
    }
    $code = Invoke-CqrNativeTimed -FilePath $sysNpm.Source -ArgumentList $playwrightInstallArgs -TimeoutSec $NpmTimeoutSec
    if ($code -eq 124) {
      Write-Error "bootstrap-playwright: npm install timed out after ${NpmTimeoutSec}s. Check internet/proxy and retry."
    }
    if ($code -ne 0) { exit $code }
  }

  if (-not (Test-Path -LiteralPath $pwPkg)) {
    Write-Error "bootstrap-playwright: playwright package missing after npm install"
  }

  Write-Host "bootstrap-playwright: downloading Chromium -> $browsersDir"
  # Call node.exe + cli.js (same as npm-cli). Do not use npx.cmd: %~dp0 / PATH
  # fallback breaks on non-ASCII user profiles when Node is not on PATH.
  $cliJs = Join-Path $packageRoot 'node_modules\playwright\cli.js'
  if (-not (Test-Path -LiteralPath $cliJs)) {
    Write-Error 'bootstrap-playwright: playwright CLI not found after package install'
  }
  $code = Invoke-CqrNativeTimed -FilePath $nodeExe -ArgumentList @($cliJs, 'install', 'chromium') -TimeoutSec $DownloadTimeoutSec
  if ($code -eq 124) {
    # Drop the partial download so the next attempt starts clean.
    Remove-Item -LiteralPath $browsersDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Error "bootstrap-playwright: Chromium download timed out after ${DownloadTimeoutSec}s and was aborted. Removed the partial download; check internet/proxy/antivirus and retry."
  }
  if ($code -ne 0) {
    Remove-Item -LiteralPath $browsersDir -Recurse -Force -ErrorAction SilentlyContinue
    exit $code
  }

  $chromiumExe = Get-ChildItem -LiteralPath $browsersDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'chrome.exe' -or $_.Name -eq 'headless_shell.exe' } |
    Select-Object -First 1
  if (-not $chromiumExe) {
    Remove-Item -LiteralPath $browsersDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Error 'bootstrap-playwright: Chromium command succeeded but no browser executable was found'
  }

  # Marker is written only after the exact package and a real browser binary are verified.
  $installedVersion = [string]((Get-Content -LiteralPath $pwPkg -Raw -Encoding UTF8 | ConvertFrom-Json).version)
  if ($installedVersion -ne $script:MyAgentPlaywrightVersion) {
    Write-Error "bootstrap-playwright: expected playwright $script:MyAgentPlaywrightVersion but found $installedVersion"
  }

  # A file can exist yet still be blocked, corrupt, or paired with the wrong
  # Chromium revision. Launch the installed browser once before writing the
  # completion marker.
  $smokeScript = Join-Path $packageRoot '.playwright-install-smoke.cjs'
  $playwrightModule = Join-Path $packageRoot 'node_modules\playwright'
  $moduleLiteral = $playwrightModule | ConvertTo-Json -Compress
  $smokeSource = @"
const { chromium } = require($moduleLiteral);
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('about:blank');
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
"@
  [IO.File]::WriteAllText($smokeScript, $smokeSource, [Text.UTF8Encoding]::new($false))
  try {
    $smokeCode = Invoke-CqrNativeTimed -FilePath $nodeExe -ArgumentList @($smokeScript) -TimeoutSec 60
    if ($smokeCode -ne 0) {
      Remove-Item -LiteralPath $browsersDir -Recurse -Force -ErrorAction SilentlyContinue
      Write-Error "bootstrap-playwright: Chromium launch smoke failed (exit $smokeCode)"
    }
  } finally {
    Remove-Item -LiteralPath $smokeScript -Force -ErrorAction SilentlyContinue
  }

  Set-Content -LiteralPath $chromiumMarker -Value (Get-Date -Format o) -Encoding UTF8
  if (-not (Test-PlaywrightRuntime -Root $Root)) {
    Remove-Item -LiteralPath $chromiumMarker -Force -ErrorAction SilentlyContinue
    Write-Error 'bootstrap-playwright: completion verification failed after package and Chromium installation'
  }
  Write-Host "bootstrap-playwright OK -> $browsersDir"

  # Keep the runtime marker when policy persistence fails. The next retry can
  # repair only the policy through bootstrap-playwright-if-needed without a
  # second npm install or Chromium download.
  Enable-PlaywrightLocalhostPolicy -Root $Root
} finally {
  Pop-Location
}
