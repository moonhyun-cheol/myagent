#requires -Version 5.1
# WorkKitLauncher-only install into an existing MY Agent tree (no folder picker).
param(
  [string]$SourceAppDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'app'),
  [string]$TargetRoot = '',
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-paths.ps1')

function Get-FullPath([string]$p) {
  if (-not $p) { return $null }
  return [IO.Path]::GetFullPath($p).TrimEnd('\')
}

function Test-MyAgentInstallRoot([string]$root) {
  $r = Get-FullPath $root
  if (-not $r) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $r 'manifest.json'))) { return $false }
  if (Test-Path -LiteralPath (Join-Path $r 'MYAgent.exe')) { return $true }
  if (Test-Path -LiteralPath (Join-Path $r 'bin\my-agent\MYAgent.exe')) { return $true }
  return $false
}

function Resolve-ShortcutInstallRoot([string]$shortcutPath) {
  if (-not (Test-Path -LiteralPath $shortcutPath)) { return $null }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  foreach ($candidate in @($shortcut.WorkingDirectory, (Split-Path $shortcut.TargetPath -Parent))) {
    if (Test-MyAgentInstallRoot $candidate) {
      return (Get-FullPath $candidate)
    }
  }
  return $null
}

function Get-DesktopFolders {
  $paths = @([Environment]::GetFolderPath('Desktop'))
  if ($env:OneDrive) {
    $paths += (Join-Path $env:OneDrive 'Desktop')
  }
  return $paths | Where-Object { $_ } | Select-Object -Unique
}

function Find-MyAgentInstallRoot {
  $checked = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $found = $null

  function Try-Root([string]$path) {
    if ($script:found) { return }
    if (-not $path) { return }
    $full = Get-FullPath $path
    if (-not $full -or $checked.Contains($full)) { return }
    [void]$checked.Add($full)
    if (Test-MyAgentInstallRoot $full) { $script:found = $full }
  }

  Try-Root $env:MY_AGENT_ROOT
  foreach ($candidate in Get-InstallPathCandidates) { Try-Root $candidate }
  foreach ($legacy in @('C:\app', 'D:\MYAgent', 'C:\MY Agent')) { Try-Root $legacy }

  foreach ($desktop in Get-DesktopFolders) {
    if (-not (Test-Path -LiteralPath $desktop)) { continue }
    Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
      Try-Root (Resolve-ShortcutInstallRoot $_.FullName)
    }
  }

  return $found
}

function New-WorkKitLauncherDesktopShortcut {
  param([string]$AppRoot)

  $launcherExe = Join-Path $AppRoot 'WorkKitLauncher.exe'
  if (-not (Test-Path -LiteralPath $launcherExe)) { return $null }

  foreach ($desktop in Get-DesktopFolders) {
    if (-not (Test-Path -LiteralPath $desktop)) { continue }
    foreach ($shortcutName in @('MY Agent Work Kit.lnk', 'WorkKitLauncher.lnk')) {
      try {
        $candidate = Join-Path $desktop $shortcutName
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($candidate)
        $shortcut.TargetPath = $launcherExe
        $shortcut.Arguments = ''
        $shortcut.WorkingDirectory = $AppRoot
        $shortcut.Description = 'MY Agent Work Kit Launcher'
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

if (-not $TargetRoot) {
  $TargetRoot = Find-MyAgentInstallRoot
}

$targetRoot = Get-FullPath $TargetRoot
if (-not (Test-MyAgentInstallRoot $targetRoot)) {
  Write-Host ''
  Write-Host 'ERROR: Could not find an existing MY Agent installation automatically.'
  Write-Host '1) Open MY Agent -> Settings -> General and copy the install folder path.'
  Write-Host '2) Run: install-launcher.bat "PASTE_PATH_HERE"'
  Write-Host '   or set MY_AGENT_ROOT to that folder, then run install-launcher.bat again.'
  Write-Host ''
  exit 1
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
