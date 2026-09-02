#requires -Version 5.1
# WorkKitLauncher-only install into an existing MY Agent tree.
param(
  [string]$SourceAppDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'app'),
  [string]$TargetRoot = $env:MY_AGENT_ROOT,
  [switch]$Interactive
)

$ErrorActionPreference = 'Stop'

function Get-FullPath([string]$p) {
  if (-not $p) { return $null }
  return [IO.Path]::GetFullPath($p).TrimEnd('\')
}

function Test-MyAgentRoot([string]$root) {
  $r = Get-FullPath $root
  if (-not $r) { return $false }
  return Test-Path -LiteralPath (Join-Path $r 'manifest.json')
}

if (-not (Test-Path -LiteralPath (Join-Path $SourceAppDir 'WorkKitLauncher.exe'))) {
  throw "Source app folder is missing WorkKitLauncher.exe: $SourceAppDir"
}

if (-not (Test-MyAgentRoot $TargetRoot)) {
  if (-not $Interactive) {
    throw "MY Agent install root not found. Set MY_AGENT_ROOT or pass -Interactive."
  }
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'MY Agent가 설치된 폴더를 선택하세요 (manifest.json이 있는 위치)'
  $dialog.ShowNewFolderButton = $false
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    throw 'Install cancelled.'
  }
  $TargetRoot = $dialog.SelectedPath
}

if (-not (Test-MyAgentRoot $TargetRoot)) {
  throw "Selected folder is not a MY Agent install (manifest.json missing): $TargetRoot"
}

$targetApp = Join-Path (Get-FullPath $TargetRoot) 'app'
if (-not (Test-Path -LiteralPath $targetApp)) {
  New-Item -ItemType Directory -Force -Path $targetApp | Out-Null
}

Write-Host "Installing WorkKitLauncher into: $targetApp"
Copy-Item -LiteralPath (Join-Path $SourceAppDir '*') -Destination $targetApp -Recurse -Force
Write-Host 'Done. Run WorkKitLauncher.exe from the app folder or desktop shortcut.'
