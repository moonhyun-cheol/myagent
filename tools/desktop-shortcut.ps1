#requires -Version 5.1
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
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
  param([string]$AppRoot)

  $productExe = Join-Path $AppRoot 'MYAgent.exe'
  if (-not (Test-Path -LiteralPath $productExe)) {
    throw "MYAgent.exe not found: $productExe"
  }

  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcutPath = Join-Path $desktop 'MY Agent.lnk'
  $shell = New-Object -ComObject WScript.Shell
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
  $lnk = New-CqrDesktopShortcut -AppRoot $Root
  Write-Host "Desktop shortcut: $lnk"
  if ($iconPath) {
    Write-Host "Icon: $iconPath"
  }
} catch {
  Write-Warning "Desktop shortcut was skipped (folder access / OneDrive). Launch MYAgent.exe from $Root"
}
