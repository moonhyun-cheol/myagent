#requires -Version 5.1
# Korean shortcut labels are loaded from UTF-8 base64 so PowerShell 5.1 (no-BOM) does not mangle them.

function Get-ManagerShortcutLabel {
  # "MY Agent 관리자"
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('TVkgQWdlbnQg6rSA66as7J6Q'))
}

function Get-ManagerShortcutNames {
  $primary = (Get-ManagerShortcutLabel) + '.lnk'
  return @(
    $primary,
    'MY Agent Work Kit.lnk',
    'WorkKitLauncher.lnk'
  )
}

function Get-AllDesktopFolders {
  $paths = New-Object 'System.Collections.Generic.List[string]'

  foreach ($special in @('Desktop', 'CommonDesktopDirectory')) {
    $p = [Environment]::GetFolderPath($special)
    if ($p) { [void]$paths.Add($p) }
  }

  try {
    $userShell = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop
    if ($userShell.Desktop) {
      $expanded = [Environment]::ExpandEnvironmentVariables([string]$userShell.Desktop)
      if ($expanded) { [void]$paths.Add($expanded) }
    }
  } catch {
    # Registry hint is optional.
  }

  if ($env:OneDrive) {
    [void]$paths.Add((Join-Path $env:OneDrive 'Desktop'))
  }
  if ($env:USERPROFILE) {
    [void]$paths.Add((Join-Path $env:USERPROFILE 'Desktop'))
    [void]$paths.Add((Join-Path $env:USERPROFILE 'OneDrive\Desktop'))
  }

  $unique = New-Object 'System.Collections.Generic.List[string]'
  foreach ($candidate in $paths) {
    if (-not $candidate) { continue }
    try {
      $full = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
    } catch {
      continue
    }
    if (-not (Test-Path -LiteralPath $full)) { continue }
    if (-not $unique.Contains($full)) {
      [void]$unique.Add($full)
    }
  }
  return $unique.ToArray()
}

function New-LauncherShortcutFile {
  param(
    [string]$ShortcutPath,
    [string]$TargetExe,
    [string]$WorkingDirectory,
    [string]$Description
  )

  $parent = Split-Path $ShortcutPath -Parent
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }

  if (Test-Path -LiteralPath $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
  }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $TargetExe
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.WindowStyle = 1
  if ($Description) { $shortcut.Description = $Description }

  $saved = $false
  foreach ($icon in @("$TargetExe,0", "$TargetExe")) {
    try {
      $shortcut.IconLocation = $icon
      $shortcut.Save()
      $saved = $true
      break
    } catch {
      continue
    }
  }
  if (-not $saved) {
    $shortcut.IconLocation = ''
    $shortcut.Save()
  }

  if (-not (Test-Path -LiteralPath $ShortcutPath)) {
    throw "Shortcut file was not created: $ShortcutPath"
  }
}

function Find-ExistingLauncherShortcut {
  param(
    [string]$LauncherExe,
    [string[]]$DesktopFolders
  )

  foreach ($desktop in $DesktopFolders) {
    foreach ($item in @(Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' -ErrorAction SilentlyContinue)) {
      try {
        $shell = New-Object -ComObject WScript.Shell
        $targetPath = $shell.CreateShortcut($item.FullName).TargetPath
        if ($targetPath -and ($targetPath -ieq $LauncherExe)) {
          return $item.FullName
        }
      } catch {
        continue
      }
    }
  }
  return $null
}

function Install-WorkKitLauncherDesktopShortcut {
  param([string]$AppRoot)

  $launcherExe = Join-Path $AppRoot 'WorkKitLauncher.exe'
  if (-not (Test-Path -LiteralPath $launcherExe)) {
    throw "WorkKitLauncher.exe not found: $launcherExe"
  }
  $launcherExe = (Get-Item -LiteralPath $launcherExe).FullName
  $workingDir = (Get-Item -LiteralPath $AppRoot).FullName
  $label = Get-ManagerShortcutLabel
  $desktops = Get-AllDesktopFolders
  if ($desktops.Count -eq 0) {
    throw 'No desktop folder found.'
  }

  $preferredName = $label + '.lnk'
  foreach ($desktop in $desktops) {
    $preferredPath = Join-Path $desktop $preferredName
    if (Test-Path -LiteralPath $preferredPath) {
      try {
        $shell = New-Object -ComObject WScript.Shell
        $targetPath = $shell.CreateShortcut($preferredPath).TargetPath
        if ($targetPath -and ($targetPath -ieq $launcherExe)) {
          return $preferredPath
        }
      } catch {
        continue
      }
    }
  }

  $existing = Find-ExistingLauncherShortcut -LauncherExe $launcherExe -DesktopFolders $desktops
  if ($existing -and ((Split-Path $existing -Leaf) -ieq $preferredName)) {
    return $existing
  }

  $shortcutNames = Get-ManagerShortcutNames

  $errors = New-Object 'System.Collections.Generic.List[string]'
  foreach ($desktop in $desktops) {
    foreach ($shortcutName in $shortcutNames) {
      $shortcutPath = Join-Path $desktop $shortcutName
      try {
        New-LauncherShortcutFile `
          -ShortcutPath $shortcutPath `
          -TargetExe $launcherExe `
          -WorkingDirectory $workingDir `
          -Description $label
        return $shortcutPath
      } catch {
        [void]$errors.Add("$shortcutPath -> $($_.Exception.Message)")
      }
    }
  }

  if ($existing) { return $existing }

  $detail = ($errors.ToArray() -join '; ')
  if ($detail) {
    throw "Could not create a desktop shortcut. $detail"
  }
  throw 'Could not create a desktop shortcut.'
}
