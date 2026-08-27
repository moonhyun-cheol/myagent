#requires -Version 5.1
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$Dev
)

$ErrorActionPreference = 'Stop'

function Ensure-CqrAppIcon {
  param([string]$AppRoot)

  $png = Join-Path $AppRoot 'ui\assets\my-agent-icon.png'
  $ico = Join-Path $AppRoot 'ui\assets\my-agent-app.ico'
  if (-not (Test-Path -LiteralPath $png)) {
    return $null
  }

  # The repository carries a curated multi-resolution ICO. Do not overwrite it from
  # the PNG just because checkout/copy timestamps differ.
  if (Test-Path -LiteralPath $ico) {
    return $ico
  }

  Add-Type -AssemblyName System.Drawing
  $bitmap = $null
  $icon = $null
  $stream = $null
  try {
    $bitmap = New-Object System.Drawing.Bitmap $png
    $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
    $dir = Split-Path $ico -Parent
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $stream = New-Object System.IO.FileStream($ico, [System.IO.FileMode]::Create)
    $icon.Save($stream)
    return $ico
  } finally {
    if ($stream) { $stream.Close() }
    if ($icon) { $icon.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
  }
}

function New-CqrDesktopShortcut {
  param(
    [string]$AppRoot,
    [switch]$Dev
  )

  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell

  if ($Dev) {
    $launcher = Join-Path $AppRoot 'tools\commands\dev-run.bat'
    if (-not (Test-Path -LiteralPath $launcher)) {
      throw "dev-run.bat not found: $launcher"
    }
    $shortcutPath = Join-Path $desktop 'MY Agent Dev.lnk'
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $launcher
    $shortcut.Arguments = ''
    $shortcut.WorkingDirectory = $AppRoot
    $shortcut.Description = 'MY Agent developer launch (npm start)'
    $shortcut.WindowStyle = 1
    $ico = Join-Path $AppRoot 'ui\assets\my-agent-app.ico'
    if (Test-Path -LiteralPath $ico) {
      $shortcut.IconLocation = "$ico,0"
    }
    $shortcut.Save()
    return $shortcutPath
  }

  $productExe = Join-Path $AppRoot 'MYAgent.exe'
  if (-not (Test-Path -LiteralPath $productExe)) {
    throw "MYAgent.exe not found: $productExe"
  }

  $shortcutPath = Join-Path $desktop 'MY Agent.lnk'
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $productExe
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = $AppRoot
  $shortcut.Description = 'MY Agent'
  $shortcut.WindowStyle = 7
  $shortcut.IconLocation = "$productExe,0"
  $shortcut.Save()
  return $shortcutPath
}

try {
  $iconPath = Ensure-CqrAppIcon -AppRoot $Root
  $lnk = if ($Dev) {
    New-CqrDesktopShortcut -AppRoot $Root -Dev
  } else {
    New-CqrDesktopShortcut -AppRoot $Root
  }
  Write-Host "Desktop shortcut: $lnk"
  if ($iconPath) {
    Write-Host "Icon: $iconPath"
  }
} catch {
  if ($Dev) {
    Write-Warning "Desktop shortcut was skipped (folder access / OneDrive). Run tools\commands\dev-run.bat from $Root"
  } else {
    Write-Warning "Desktop shortcut was skipped (folder access / OneDrive). Launch MYAgent.exe from $Root"
  }
}
