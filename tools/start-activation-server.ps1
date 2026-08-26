#requires -Version 5.1
<#
.SYNOPSIS
  MY Agent activation server 기동 (수동 실행 또는 로그인 자동 실행용).
#>
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [int]$Port = 10201,
  [switch]$Hidden
)

$ErrorActionPreference = 'Stop'

$logDir = Join-Path $Root 'activation-server'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'autostart.log'

function Write-StartupLog {
  param([string]$Message)
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

try {
  $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($existing) {
    Write-StartupLog "skip: port $Port already listening (pid=$($existing.OwningProcess))"
    exit 0
  }

  Set-Location -LiteralPath $Root
  Write-StartupLog "start: npm run server:activation (root=$Root)"

  $nodeExe = Join-Path $Root 'runtime\node\node.exe'
  $npmCli = Join-Path $Root 'runtime\node\node_modules\npm\bin\npm-cli.js'
  $npm = Join-Path $Root 'runtime\node\npm.cmd'
  $useNodeNpm = $false
  if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $npmCli)) {
    $useNodeNpm = $true
  } elseif (-not (Test-Path -LiteralPath $npm)) {
    $npm = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
  }
  if (-not $useNodeNpm -and -not (Test-Path -LiteralPath $npm)) {
    $sys = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $sys) { $sys = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $sys -or -not $sys.Source) {
      throw 'npm not found. Run tools\bootstrap-node-if-needed.ps1 or install Node.js.'
    }
    $npm = $sys.Source
  }

  if ($Hidden) {
    if ($useNodeNpm) {
      Start-Process -FilePath $nodeExe `
        -ArgumentList @($npmCli, 'run', 'server:activation') `
        -WorkingDirectory $Root `
        -WindowStyle Hidden
    } else {
      Start-Process -FilePath $npm `
        -ArgumentList @('run', 'server:activation') `
        -WorkingDirectory $Root `
        -WindowStyle Hidden
    }
    Write-StartupLog 'started hidden npm process'
    exit 0
  }

  if ($useNodeNpm) {
    & $nodeExe $npmCli run server:activation
  } else {
    & $npm run server:activation
  }
  $code = $LASTEXITCODE
  Write-StartupLog "exit: code=$code"
  exit $code
} catch {
  Write-StartupLog "error: $($_.Exception.Message)"
  exit 1
}
