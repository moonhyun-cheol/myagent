#requires -Version 5.1
<#
.SYNOPSIS
  PC 로그인 시 MY Agent activation server 자동 실행 등록/해제.

.EXAMPLE
  .\tools\install-activation-autostart.ps1
.EXAMPLE
  .\tools\install-activation-autostart.ps1 -Remove
#>
param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$StartScript = Join-Path $Root 'tools\start-activation-server.ps1'
$TaskName = 'MY_AGENT_ActivationServer'

if (-not (Test-Path -LiteralPath $StartScript)) {
  throw "Missing startup script: $StartScript"
}

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "[ok] Removed scheduled task: $TaskName" -ForegroundColor Green
  exit 0
}

$Action = New-ScheduledTaskAction `
  -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`" -Hidden" `
  -WorkingDirectory $Root

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Trigger.Delay = 'PT45S'

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description 'Auto-start MY Agent activation server (npm run server:activation) at user logon.' `
  -Force | Out-Null

Write-Host "[ok] Registered scheduled task: $TaskName" -ForegroundColor Green
Write-Host "     Trigger : At logon ($($env:USERNAME)), delay 45s" -ForegroundColor DarkGray
Write-Host "     Script  : $StartScript" -ForegroundColor DarkGray
Write-Host "     Log     : $Root\activation-server\autostart.log" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Test now:" -ForegroundColor Yellow
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$StartScript`" -Hidden" -ForegroundColor DarkGray
Write-Host "Remove:" -ForegroundColor Yellow
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Remove" -ForegroundColor DarkGray
