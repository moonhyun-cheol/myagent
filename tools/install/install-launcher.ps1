#requires -Version 5.1
# WorkKitLauncher-only install into an existing MY Agent tree (no folder picker).
param(
  [string]$SourceAppDir = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'app'),
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

function Test-InstallFolderWritable([string]$folder) {
  try {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $writeProbe = Join-Path $folder ".my-agent-launcher-install-probe-$PID.tmp"
    [IO.File]::WriteAllText($writeProbe, 'probe')
    Remove-Item -LiteralPath $writeProbe -Force
    return $true
  } catch {
    Remove-Item -LiteralPath (Join-Path $folder ".my-agent-launcher-install-probe-$PID.tmp") -Force -ErrorAction SilentlyContinue
    return $false
  }
}

function Stop-RunningWorkKitLauncher {
  $procs = @(Get-Process -Name 'WorkKitLauncher' -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { return }
  Write-Host "Stopping $($procs.Count) running WorkKitLauncher process(es) before install..."
  foreach ($proc in $procs) {
    try {
      if (-not $proc.HasExited -and $proc.MainWindowHandle -ne 0) {
        [void]$proc.CloseMainWindow()
      }
    } catch { }
  }
  Start-Sleep -Milliseconds 500
  Get-Process -Name 'WorkKitLauncher' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 200
}

function Copy-LauncherPayload {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$TargetDir
  )

  $sourceFull = (Resolve-Path -LiteralPath $SourceDir).Path.TrimEnd('\')
  if (-not (Test-Path -LiteralPath (Join-Path $sourceFull 'WorkKitLauncher.exe'))) {
    throw "Source app folder is missing WorkKitLauncher.exe: $sourceFull"
  }

  $copiedFiles = 0
  Get-ChildItem -LiteralPath $sourceFull -Recurse -Force | ForEach-Object {
    $rel = $_.FullName.Substring($sourceFull.Length).TrimStart('\')
    if (-not $rel) { return }
    $dest = Join-Path $TargetDir $rel
    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
      return
    }
    $destParent = Split-Path $dest -Parent
    if ($destParent -and -not (Test-Path -LiteralPath $destParent)) {
      New-Item -ItemType Directory -Force -Path $destParent | Out-Null
    }
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    $copiedFiles++
  }
  return $copiedFiles
}

function Sync-LauncherWebUi {
  param([string]$AppRoot)

  $uiDist = Join-Path $AppRoot 'ui\work-kit-launcher\dist'
  $webDir = Join-Path $AppRoot 'bin\work-kit-launcher\web'
  if (-not (Test-Path -LiteralPath (Join-Path $uiDist 'index.html'))) {
    return
  }
  if (Test-Path -LiteralPath $webDir) {
    Remove-Item -LiteralPath $webDir -Recurse -Force
  }
  $parent = Split-Path $webDir -Parent
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -Path $uiDist -Destination $webDir -Recurse -Force
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

if (-not (Test-InstallFolderWritable $targetRoot)) {
  throw "Install folder is not writable: $targetRoot. Run as the same Windows user who uses MY Agent (not administrator)."
}

Write-Host "Installing WorkKitLauncher into: $targetRoot"
Write-Host "Copying from: $SourceAppDir"
Stop-RunningWorkKitLauncher
$copiedCount = Copy-LauncherPayload -SourceDir $SourceAppDir -TargetDir $targetRoot
Write-Host "Copied $copiedCount file(s)."
Sync-LauncherWebUi -AppRoot $targetRoot

$launcherExe = Join-Path $targetRoot 'WorkKitLauncher.exe'
if (-not (Test-Path -LiteralPath $launcherExe)) {
  throw "Install finished but WorkKitLauncher.exe is missing: $launcherExe (source: $SourceAppDir, copied files: $copiedCount). Re-download the install zip and run install-launcher.bat again."
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
