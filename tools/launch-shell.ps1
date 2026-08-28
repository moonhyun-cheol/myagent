#requires -Version 5.1
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$Hidden
)

$ErrorActionPreference = 'Stop'
$env:MY_AGENT_ROOT = $Root
Set-Location -LiteralPath $Root

function Resolve-ShellExe {
  $candidates = @(
    (Join-Path $Root 'bin\my-agent\MYAgent.exe'),
    (Join-Path $Root 'shell\CqrPa.Shell\bin\Release\net8.0-windows\win-x64\MYAgent.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  $outDir = Join-Path $Root 'bin\my-agent'
  dotnet publish (Join-Path $Root 'shell\CqrPa.Shell\CqrPa.Shell.csproj') -c Release -o $outDir -v q | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'WebView2 shell publish failed. Install .NET 8 SDK and run: dotnet publish shell/CqrPa.Shell/CqrPa.Shell.csproj -c Release -o bin/my-agent'
  }

  $published = Join-Path $outDir 'MYAgent.exe'
  if (-not (Test-Path -LiteralPath $published)) {
    throw "Missing shell after publish: $published"
  }
  return $published
}

function Ensure-ApiBuilt {
  $mainJs = Join-Path $Root 'core\dist\main.js'
  if (Test-Path -LiteralPath $mainJs) { return }

  if (-not (Test-Path -LiteralPath (Join-Path $Root 'package.json'))) {
    throw 'Missing core\dist\main.js. Run npm run build.'
  }

  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($Hidden) {
  $launcher = Join-Path $Root 'tools\launch-cqr.ps1'
  if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Missing launcher: $launcher"
  }
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Start-Process -FilePath $powershell -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
    '-File', $launcher, '-Root', $Root
  ) -WorkingDirectory $Root
  exit 0
}

Ensure-ApiBuilt
$shellExe = Resolve-ShellExe

Start-Process -FilePath $shellExe -WorkingDirectory $Root
exit 0
