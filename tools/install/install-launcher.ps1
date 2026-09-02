#requires -Version 5.1
# WorkKitLauncher-only install into an existing MY Agent tree (no folder picker).
param(
  [string]$SourceAppDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'app'),
  [string]$TargetRoot = '',
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-paths.ps1')

trap {
  Write-Host ''
  Write-Host $_.Exception.Message
  Wait-BeforeExit 1
}

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
  if (Test-Path -LiteralPath (Join-Path $r 'core\dist\main.js')) { return $true }
  return $false
}

function Resolve-InstallRootFromExe([string]$exePath) {
  if (-not $exePath) { return $null }
  try {
    $exePath = (Get-Item -LiteralPath $exePath -ErrorAction Stop).FullName
  } catch {
    return $null
  }
  $current = Split-Path $exePath -Parent
  for ($i = 0; $i -lt 8; $i++) {
    if (Test-MyAgentInstallRoot $current) {
      return (Get-FullPath $current)
    }
    $parent = Split-Path $current -Parent
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
  return $null
}

function Resolve-ShortcutInstallRoot([string]$shortcutPath) {
  if (-not (Test-Path -LiteralPath $shortcutPath)) { return $null }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  foreach ($candidate in @($shortcut.WorkingDirectory, (Split-Path $shortcut.TargetPath -Parent)) {
    $fromExe = Resolve-InstallRootFromExe $shortcut.TargetPath
    if ($fromExe) { return $fromExe }
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

function Get-ShortcutSearchFolders {
  $paths = @()
  foreach ($special in @('Desktop', 'CommonDesktopDirectory', 'Programs', 'CommonPrograms')) {
    $p = [Environment]::GetFolderPath($special)
    if ($p) { $paths += $p }
  }
  if ($env:OneDrive) {
    $paths += (Join-Path $env:OneDrive 'Desktop')
  }
  return $paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
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

  foreach ($procName in @('MYAgent', 'WorkKitLauncher')) {
    Get-Process -Name $procName -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        Try-Root (Resolve-InstallRootFromExe $_.MainModule.FileName)
      } catch {
        # Access denied for some processes; ignore.
      }
    }
  }

  foreach ($folder in Get-ShortcutSearchFolders) {
    foreach ($shortcutName in @('MY Agent.lnk', 'MY Agent 관리자.lnk', 'MY Agent Work Kit.lnk', 'MY Agent 작업 환경.lnk', 'WorkKitLauncher.lnk')) {
      $shortcutPath = Join-Path $folder $shortcutName
      if (Test-Path -LiteralPath $shortcutPath) {
        Try-Root (Resolve-ShortcutInstallRoot $shortcutPath)
      }
    }
    Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
      Try-Root (Resolve-ShortcutInstallRoot $_.FullName)
    }
  }

  return $found
}

function Read-InstallRootFromUser {
  Write-Host ''
  Write-Host '자동으로 MY Agent 설치 폴더를 찾지 못했습니다.'
  Write-Host 'MY Agent -> 설정 -> 일반 -> 설치 폴더 경로를 복사해 아래에 붙여넣고 Enter 하세요.'
  Write-Host '(빈 칸 + Enter = 종료)'
  Write-Host ''
  $raw = Read-Host '설치 폴더'
  $trimmed = $raw.Trim().Trim('"')
  if (-not $trimmed) { return $null }
  $full = Get-FullPath $trimmed
  if (Test-MyAgentInstallRoot $full) { return $full }
  Write-Host "유효하지 않은 설치 폴더입니다: $full"
  Write-Host 'manifest.json 과 MYAgent.exe 가 있는 폴더여야 합니다.'
  return $null
}

function Wait-BeforeExit([int]$exitCode) {
  Write-Host ''
  if ($exitCode -ne 0) {
    Write-Host '창이 바로 닫히면 install-launcher.bat 를 다시 실행하세요.'
  }
  Read-Host '종료하려면 Enter'
  exit $exitCode
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

if (-not $TargetRoot) {
  $TargetRoot = Find-MyAgentInstallRoot
}

$targetRoot = Get-FullPath $TargetRoot
if (-not (Test-MyAgentInstallRoot $targetRoot)) {
  $targetRoot = Read-InstallRootFromUser
}
if (-not (Test-MyAgentInstallRoot $targetRoot)) {
  Write-Host ''
  Write-Host 'ERROR: Could not find an existing MY Agent installation.'
  Write-Host '1) MY Agent -> Settings -> General -> copy install folder path'
  Write-Host '2) Run: install-launcher.bat "PASTE_PATH_HERE"'
  Write-Host '   or set MY_AGENT_ROOT to that folder, then run install-launcher.bat again.'
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
