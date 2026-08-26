# MY Agent admin diagnostics
param(
  [string]$Root = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
)

$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path -LiteralPath $Root).Path
$port = 10200

Write-Host '========== MY Agent ADMIN ==========' -ForegroundColor Cyan
Write-Host "Root   : $Root"
Write-Host "Time   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

if (Test-Path (Join-Path $Root 'manifest.json')) {
  try {
    $m = Get-Content (Join-Path $Root 'manifest.json') -Raw | ConvertFrom-Json
    Write-Host "Version: $($m.version)"
  } catch { Write-Host 'Version: (manifest parse error)' }
}

$nodeEmb = Join-Path $Root 'runtime\node\node.exe'
Write-Host "Node   : $(if (Test-Path $nodeEmb) { 'embedded ' + $nodeEmb } else { 'system PATH' })"

Write-Host ''
Write-Host '--- API health ---' -ForegroundColor Yellow
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:${port}/health" -TimeoutSec 3
  $health | ConvertTo-Json -Compress | Write-Host
} catch {
  Write-Host 'API not running on port' $port
}

Write-Host ''
Write-Host '--- Diagnostics API ---' -ForegroundColor Yellow
try {
  $diag = Invoke-RestMethod -Uri "http://127.0.0.1:${port}/admin/diagnostics" -TimeoutSec 5
  $diag | ConvertTo-Json -Depth 5 | Write-Host
} catch {
  Write-Host '(start API with MYAgent.exe for full diagnostics)'
  if (Test-Path (Join-Path $Root 'core\dist\main.js')) {
    $env:MY_AGENT_ROOT = $Root
    $node = if (Test-Path $nodeEmb) { $nodeEmb } else { 'node' }
    & $node (Join-Path $Root 'tools\cqr-admin.mjs') machine-id 2>$null
  }
}

Write-Host ''
Write-Host '--- Logs ---' -ForegroundColor Yellow
$logsDir = Join-Path $Root 'logs'
if (Test-Path $logsDir) {
  Get-ChildItem $logsDir -File | Sort-Object LastWriteTime -Descending | Select-Object -First 10 | Format-Table Name, Length, LastWriteTime -AutoSize
  Write-Host "Folder: $logsDir"
} else {
  Write-Host '(no logs folder yet)'
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
