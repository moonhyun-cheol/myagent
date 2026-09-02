#requires -Version 5.1
# WorkKitLauncher-only install into an existing MY Agent tree (no folder picker).
param(
  [string]$SourceAppDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'app'),
  [string]$TargetRoot = '',
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-paths.ps1')
. (Join-Path $PSScriptRoot 'install-launcher-discovery.ps1')

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
  Wait-BeforeExit 1
}

function Get-DesktopFolders {
  $paths = @([Environment]::GetFolderPath('Desktop'))
  if ($env:OneDrive) {
    $paths += (Join-Path $env:OneDrive 'Desktop')
  }
  return $paths | Where-Object { $_ } | Select-Object -Unique
}

function New-WorkKitLauncherDesktopShortcut {
  param([string]$AppRoot)

  $launcherExe = Join-Path $AppRoot 'WorkKitLauncher.exe'
  if (-not (Test-Path -LiteralPath $launcherExe)) { return $null }

  foreach ($desktop in Get-DesktopFolders) {
    if (-not (Test-Path -LiteralPath $desktop)) { continue }
    foreach ($shortcutName in @('MY Agent 관리자.lnk', 'MY Agent Work Kit.lnk', 'MY Agent 작업 환경.lnk', 'WorkKitLauncher.lnk')) {
      try {
        $candidate = Join-Path $desktop $shortcutName
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($candidate)
        $shortcut.TargetPath = $launcherExe
        $shortcut.Arguments = ''
        $shortcut.WorkingDirectory = $AppRoot
        $shortcut.Description = 'MY Agent 관리자'
        $shortcut.WindowStyle = 7
        $shortcut.IconLocation = "$launcherExe,0"
        $shortcut.Save()
        return $candidate
      } catch {
        continue
      }
    }
  }
  return $null
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
  $targetRoot = Read-InstallRootFromUser
  if (-not $targetRoot) { break }
}

if (-not (Test-MyAgentInstallRoot $targetRoot)) {
  Write-Host ''
  Write-Host 'ERROR: Could not find an existing MY Agent installation.'
  Write-Host '1) Open MY Agent, then run install-launcher.bat again (auto-detect uses the running app).'
  Write-Host '2) Settings -> General -> copy install folder, then:'
  Write-Host '   install-launcher.bat "PASTE_PATH_HERE"'
  Write-Host '3) Or set MY_AGENT_ROOT to that folder and run install-launcher.bat again.'
  Wait-BeforeExit 1
}

Write-Host "Installing WorkKitLauncher into: $targetRoot"
Copy-Item -LiteralPath (Join-Path $SourceAppDir '*') -Destination $targetRoot -Recurse -Force

$launcherExe = Join-Path $targetRoot 'WorkKitLauncher.exe'
$shortcutScript = Join-Path $targetRoot 'tools\desktop-shortcut.ps1'
$shortcutPath = $null
if (Test-Path -LiteralPath $shortcutScript) {
  try {
    & $shortcutScript -Root $targetRoot | Out-Null
  } catch {
    # desktop-shortcut may fail on locked Desktop paths; fallback below.
  }
}
foreach ($desktop in Get-DesktopFolders) {
  if (-not (Test-Path -LiteralPath $desktop)) { continue }
  Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($shortcutPath) { return }
    $shell = New-Object -ComObject WScript.Shell
    $targetPath = $shell.CreateShortcut($_.FullName).TargetPath
    if ($targetPath -and ($targetPath -ieq $launcherExe)) {
      $shortcutPath = $_.FullName
    }
  }
  if ($shortcutPath) { break }
}
if (-not $shortcutPath) {
  $shortcutPath = New-WorkKitLauncherDesktopShortcut -AppRoot $targetRoot
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
