#requires -Version 5.1
# WorkKitLauncher-only install into an existing MY Agent tree (no folder picker).
param(
  [string]$SourceAppDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'app'),
  [string]$TargetRoot = '',
  [switch]$Launch,
  [switch]$NoInteractive
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-paths.ps1')
. (Join-Path $PSScriptRoot 'install-launcher-discovery.ps1')
. (Join-Path $PSScriptRoot 'install-launcher-shortcut.ps1')

function Read-InstallRootFromUser {
  Write-Host ''
  Write-Host 'Could not find MY Agent install folder automatically.'
  Write-Host 'Tip: keep MY Agent open, or copy the path from Settings -> General -> Install folder.'
  Write-Host 'Paste the folder path below and press Enter. (Empty + Enter = quit)'
  Write-Host ''
  $raw = Read-Host 'Install folder'
  return (Normalize-InstallRootInput $raw)
}

function Wait-BeforeExit([int]$exitCode) {
  Write-Host ''
  if ($exitCode -ne 0) {
    Write-Host 'Re-run install-launcher.bat if this window closes too quickly.'
  }
  Read-Host 'Press Enter to close'
  exit $exitCode
}

trap {
  Write-Host ''
  Write-Host $_.Exception.Message
  if ($NoInteractive) {
    exit 1
  }
  Wait-BeforeExit 1
}

function Get-DesktopFolders {
  return Get-AllDesktopFolders
}

if (-not (Test-Path -LiteralPath (Join-Path $SourceAppDir 'WorkKitLauncher.exe'))) {
  throw "Source app folder is missing WorkKitLauncher.exe: $SourceAppDir"
}

$targetRoot = $null
if ($TargetRoot) {
  $targetRoot = Normalize-InstallRootInput $TargetRoot
}

if (-not $targetRoot) {
  Write-Host 'Looking for MY Agent install folder...'
  try {
    $targetRoot = Find-MyAgentInstallRoot
  } catch {
    $targetRoot = $null
  }
}

while (-not (Test-MyAgentInstallRoot $targetRoot)) {
  if ($NoInteractive) { break }
  $targetRoot = Read-InstallRootFromUser
  if (-not $targetRoot) { break }
}

if (-not (Test-MyAgentInstallRoot $targetRoot)) {
  $message = 'Could not find an existing MY Agent installation.'
  if ($NoInteractive) {
    throw $message
  }
  Write-Host ''
  Write-Host "ERROR: $message"
  Write-Host '1) Open MY Agent, then run install-launcher.bat again (auto-detect uses the running app).'
  Write-Host '2) Settings -> General -> copy install folder, then:'
  Write-Host '   install-launcher.bat "PASTE_PATH_HERE"'
  Write-Host '3) Or set MY_AGENT_ROOT to that folder and run install-launcher.bat again.'
  Wait-BeforeExit 1
}

Write-Host "Installing WorkKitLauncher into: $targetRoot"
Copy-Item -LiteralPath (Join-Path $SourceAppDir '*') -Destination $targetRoot -Recurse -Force

$launcherExe = Join-Path $targetRoot 'WorkKitLauncher.exe'
if (-not (Test-Path -LiteralPath $launcherExe)) {
  throw "Install finished but WorkKitLauncher.exe is missing: $launcherExe"
}

$shortcutPath = $null
try {
  $shortcutPath = Install-WorkKitLauncherDesktopShortcut -AppRoot $targetRoot
} catch {
  Write-Host ''
  Write-Host "Desktop shortcut FAILED: $($_.Exception.Message)"
  Write-Host "You can run WorkKitLauncher.exe directly: $launcherExe"
}

Write-Host ''
Write-Host 'WorkKitLauncher install complete.'
Write-Host "Install folder: $targetRoot"
Write-Host "Run: $launcherExe"
if ($shortcutPath) {
  Write-Host "Desktop shortcut: $shortcutPath"
} else {
  Write-Host 'Desktop shortcut was skipped (check Desktop / OneDrive folder permissions).'
}

if ($Launch -and (Test-Path -LiteralPath $launcherExe)) {
  Start-Process -FilePath $launcherExe -WorkingDirectory $targetRoot
}
