<#
.SYNOPSIS
  Generic, focus-preserving multi-service orchestrator (portable skeleton).

.DESCRIPTION
  Portable kernel derived from an upstream service-terminal-orchestration spec.
  The upstream original hardcoded machine-specific service names, ports, absolute
  worktree paths, and a fixed automation task id. Those are NOT portable to the
  MY Agent product tree, so this skeleton keeps only the reusable orchestration
  contract and reads every concrete service from a JSON schema
  (see start-services.schema.json / services.example.json).

  Behaviour contract preserved from the spec:
    - Collect all service tabs into ONE dedicated Windows Terminal window.
    - Health-check each service first; already-healthy services are NOT
      re-launched / restarted / killed.
    - Restore the previously-foreground window right after each tab launch so the
      user's current focus is not stolen.
    - Activate the services terminal exactly once, only after all tabs are placed
      (suppressible with -NoFinalActivate).
    - pwsh.exe (PowerShell 7) preferred, powershell.exe fallback.
    - Windows Terminal (wt.exe) absent => explicit orchestration failure (distinct
      from a service launcher's own shell fallback).

.PARAMETER ConfigPath
  Path to a services schema JSON file.

.PARAMETER TerminalWindowName
  Dedicated Windows Terminal window name. Overrides schema.terminalWindowName.

.PARAMETER WhatIf
  Print the resolved plan (health results + tabs that would be created) and exit
  without launching anything.

.PARAMETER NoFinalActivate
  Do everything except the single final activate of the services terminal.

.EXAMPLE
  pwsh -File tools/commands/start-services.ps1 -ConfigPath tools/commands/services.example.json -WhatIf -NoFinalActivate
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $ConfigPath,

  [string] $TerminalWindowName,

  [switch] $WhatIf,

  [switch] $NoFinalActivate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- native foreground-window helpers (focus preservation) ------------------
$script:User32Loaded = $false
function Initialize-User32 {
  if ($script:User32Loaded) { return }
  Add-Type -Namespace MyAgentSvc -Name Win -MemberDefinition @'
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern System.IntPtr GetForegroundWindow();
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(System.IntPtr hWnd);
'@ | Out-Null
  $script:User32Loaded = $true
}

function Get-ForegroundWindow {
  if ($WhatIf) { return [System.IntPtr]::Zero }
  Initialize-User32
  return [MyAgentSvc.Win]::GetForegroundWindow()
}

function Restore-ForegroundWindow {
  param([System.IntPtr] $Handle)
  if ($WhatIf) { return }
  if ($Handle -eq [System.IntPtr]::Zero) { return }
  Initialize-User32
  [void][MyAgentSvc.Win]::SetForegroundWindow($Handle)
}

# --- shell resolution: pwsh preferred, powershell fallback ------------------
function Resolve-ShellExe {
  $pwsh = Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue
  if ($pwsh) { return $pwsh.Source }
  $ps = Get-Command 'powershell.exe' -ErrorAction SilentlyContinue
  if ($ps) { return $ps.Source }
  throw 'Neither pwsh.exe nor powershell.exe was found on PATH.'
}

function Resolve-WindowsTerminalExe {
  $wt = Get-Command 'wt.exe' -ErrorAction SilentlyContinue
  if ($wt) { return $wt.Source }
  throw 'Windows Terminal (wt.exe) is required for the dedicated services window but was not found. This is an orchestration failure and is distinct from any per-service shell fallback.'
}

# --- health check -----------------------------------------------------------
function Test-ServiceHealthy {
  param([string] $HealthUrl, [int] $TimeoutSec = 3)
  if ([string]::IsNullOrWhiteSpace($HealthUrl)) { return $false }
  try {
    $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec $TimeoutSec
    return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500)
  } catch {
    return $false
  }
}

# --- config load / validate -------------------------------------------------
function Import-ServiceConfig {
  param([string] $Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Config not found: $Path"
  }
  $raw = Get-Content -LiteralPath $Path -Raw
  $cfg = $raw | ConvertFrom-Json
  if (-not $cfg.services) {
    throw "Config '$Path' has no 'services' array."
  }
  foreach ($svc in $cfg.services) {
    if ([string]::IsNullOrWhiteSpace($svc.name)) { throw "A service entry is missing 'name'." }
    if ([string]::IsNullOrWhiteSpace($svc.command)) { throw "Service '$($svc.name)' is missing 'command'." }
  }
  return $cfg
}

# --- tab launch -------------------------------------------------------------
function Add-ServiceTab {
  param(
    [string] $WtExe,
    [string] $ShellExe,
    [string] $WindowName,
    [object] $Service
  )
  $hasTabTitle = $Service.PSObject.Properties['tabTitle'] -and -not [string]::IsNullOrWhiteSpace($Service.tabTitle)
  $tabTitle = if ($hasTabTitle) { $Service.tabTitle } else { $Service.name }
  $wtArgs = @('-w', $WindowName, 'new-tab', '--title', $tabTitle)
  if ($Service.PSObject.Properties['workingDirectory'] -and -not [string]::IsNullOrWhiteSpace($Service.workingDirectory)) {
    $wtArgs += @('--startingDirectory', $Service.workingDirectory)
  }
  $wtArgs += @($ShellExe, '-NoExit', '-Command', $Service.command)

  if ($WhatIf) {
    Write-Host ("  [plan] tab '{0}' -> {1}" -f $tabTitle, $Service.command)
    return
  }
  & $WtExe @wtArgs
}

# --- main -------------------------------------------------------------------
$cfg = Import-ServiceConfig -Path $ConfigPath

$windowName = if (-not [string]::IsNullOrWhiteSpace($TerminalWindowName)) {
  $TerminalWindowName
} elseif ($cfg.PSObject.Properties['terminalWindowName'] -and -not [string]::IsNullOrWhiteSpace($cfg.terminalWindowName)) {
  $cfg.terminalWindowName
} else {
  'MY_AGENT_SERVICES'
}

$wtExe = if ($WhatIf) { 'wt.exe' } else { Resolve-WindowsTerminalExe }
$shellExe = if ($WhatIf) { 'pwsh.exe' } else { Resolve-ShellExe }

Write-Host ("Services orchestrator: window='{0}', shell='{1}', whatIf={2}" -f $windowName, $shellExe, [bool]$WhatIf)

$launched = @()
$skipped = @()

foreach ($svc in $cfg.services) {
  $healthy = $false
  $hasHealthUrl = $svc.PSObject.Properties['healthUrl'] -and -not [string]::IsNullOrWhiteSpace($svc.healthUrl)
  $skipIfHealthy = -not ($svc.PSObject.Properties['skipIfHealthy'] -and $svc.skipIfHealthy -eq $false)
  if ($hasHealthUrl -and $skipIfHealthy) {
    $healthy = Test-ServiceHealthy -HealthUrl $svc.healthUrl
  }
  if ($healthy) {
    Write-Host ("  already running: {0} ({1})" -f $svc.name, $svc.healthUrl)
    $skipped += $svc.name
    continue
  }

  $prevForeground = Get-ForegroundWindow
  Add-ServiceTab -WtExe $wtExe -ShellExe $shellExe -WindowName $windowName -Service $svc
  Restore-ForegroundWindow -Handle $prevForeground
  $launched += $svc.name
}

Write-Host ("Launched: {0}" -f (($launched -join ', ')))
Write-Host ("Skipped (already running): {0}" -f (($skipped -join ', ')))

if ($NoFinalActivate) {
  Write-Host 'terminal: final activate suppressed (-NoFinalActivate)'
} elseif ($WhatIf) {
  Write-Host 'terminal: would activate after completion (WhatIf)'
} else {
  # Single, final activation of the dedicated services window.
  & $wtExe @('-w', $windowName, 'focus-tab', '--target', '0') 2>$null
  Write-Host 'terminal: shown after completion'
}
