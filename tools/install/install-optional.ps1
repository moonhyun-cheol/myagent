#requires -Version 5.1
# Install selected optional runtimes into an existing MY Agent folder.
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$OptionalRuntimes = '',
  [switch]$AllOptional
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'optional-runtimes.ps1')
. (Join-Path $PSScriptRoot 'install-transaction.ps1')

$target = [IO.Path]::GetFullPath($Root.Trim().Trim('"').TrimEnd('\'))
if (-not (Test-Path -LiteralPath (Join-Path $target 'MYAgent.exe')) -and -not (Test-Path -LiteralPath (Join-Path $target 'core\dist\main.js'))) {
  throw "ERROR: $target is not a MY Agent install folder."
}

$installMutex = Enter-InstallTargetLock $target
try {
$selected = Resolve-OptionalRuntimeSelection -OptionalRuntimes $OptionalRuntimes -AllOptional:$AllOptional
if ($selected.Count -eq 0) {
  Write-Host 'No optional runtimes selected.'
  $existing = Read-OptionalRuntimeSelection $target
  $keep = @()
  if ($existing) { $keep = @($existing.selected) }
  $installed = @()
  $failed = @()
  if ($existing) {
    $installed = @($existing.installed)
    $failed = @($existing.failed)
  }
  Save-OptionalRuntimeSelection -Root $target -Selected $keep -Installed $installed -Failed $failed
  exit 0
}

$merged = New-Object System.Collections.Generic.List[string]
$prev = Read-OptionalRuntimeSelection $target
if ($prev) {
  foreach ($id in @($prev.selected)) {
    if ($id -and -not $merged.Contains([string]$id)) { [void]$merged.Add([string]$id) }
  }
}
foreach ($id in @($selected)) {
  if (-not $merged.Contains($id)) { [void]$merged.Add($id) }
}

$result = Install-SelectedOptionalRuntimes -Root $target -Selected $selected
$installed = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[string]
if ($prev) {
  foreach ($id in @($prev.installed)) {
    if ($id -and @($selected) -notcontains [string]$id -and -not $installed.Contains([string]$id)) { [void]$installed.Add([string]$id) }
  }
  foreach ($id in @($prev.failed)) {
    if ($id -and @($selected) -notcontains [string]$id -and -not $failed.Contains([string]$id)) { [void]$failed.Add([string]$id) }
  }
}
foreach ($id in @($result.Installed)) { if (-not $installed.Contains([string]$id)) { [void]$installed.Add([string]$id) } }
foreach ($id in @($result.Failed)) { if (-not $failed.Contains([string]$id)) { [void]$failed.Add([string]$id) } }
Save-OptionalRuntimeSelection -Root $target -Selected @($merged) -Installed @($installed) -Failed @($failed)
Write-Host "Optional runtimes installed: $(@($result.Installed) -join ', ')"
if (@($result.Failed).Count -gt 0) {
  Write-Error ("OPTIONAL_RUNTIME_INSTALL_FAILED: " + (@($result.Failed) -join ', '))
  exit 1
}
exit 0
} finally {
  Exit-InstallTargetLock $installMutex
}
