#requires -Version 5.1
# Install selected optional runtimes into an existing MY Agent folder.
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$OptionalRuntimes = '',
  [switch]$AllOptional
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'optional-runtimes.ps1')

$target = [IO.Path]::GetFullPath($Root.Trim().Trim('"').TrimEnd('\'))
if (-not (Test-Path -LiteralPath (Join-Path $target 'MYAgent.exe')) -and -not (Test-Path -LiteralPath (Join-Path $target 'core\dist\main.js'))) {
  throw "ERROR: $target is not a MY Agent install folder."
}

$selected = Resolve-OptionalRuntimeSelection -OptionalRuntimes $OptionalRuntimes -AllOptional:$AllOptional
if ($selected.Count -eq 0) {
  Write-Host 'No optional runtimes selected.'
  $existing = Read-OptionalRuntimeSelection $target
  $keep = @()
  if ($existing) { $keep = @($existing.selected) }
  Save-OptionalRuntimeSelection -Root $target -Selected $keep
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

Install-SelectedOptionalRuntimes -Root $target -Selected $selected
Save-OptionalRuntimeSelection -Root $target -Selected @($merged)
Write-Host "Optional runtimes installed: $($selected -join ', ')"
exit 0
