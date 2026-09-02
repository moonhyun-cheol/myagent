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

function Get-StartMenuFolders {
  $paths = New-Object 'System.Collections.Generic.List[string]'
  foreach ($special in @('Programs', 'CommonPrograms')) {
    $p = [Environment]::GetFolderPath($special)
    if ($p) { [void]$paths.Add($p) }
  }
  if ($env:APPDATA) {
    [void]$paths.Add((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
  }
  $unique = New-Object 'System.Collections.Generic.List[string]'
  foreach ($candidate in $paths) {
    if (-not $candidate) { continue }
    try {
      $full = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
    } catch {
      continue
    }
    if (-not (Test-Path -LiteralPath $full)) {
      try {
        New-Item -ItemType Directory -Force -Path $full | Out-Null
      } catch {
        continue
      }
    }
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
    [string]$Description = 'MY Agent Manager'
  )

  $parent = [IO.Path]::GetDirectoryName($ShortcutPath)
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }

  $tempPath = [IO.Path]::Combine($parent, "myagent-wkl-$PID-$([Guid]::NewGuid().ToString('N').Substring(0,8)).lnk")
  if (Test-Path -LiteralPath $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $tempPath) {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
  }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($tempPath)
  $shortcut.TargetPath = $TargetExe
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.WindowStyle = 1
  $shortcut.Description = $Description

  $saved = $false
  foreach ($icon in @("$TargetExe,0", "$TargetExe", '')) {
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
    throw "WScript shortcut Save() failed for temp file: $tempPath"
  }
  if (-not (Test-Path -LiteralPath $tempPath)) {
    throw "Temp shortcut file was not created: $tempPath"
  }

  if ($ShortcutPath -ne $tempPath) {
    if (Test-Path -LiteralPath $ShortcutPath) {
      Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction Stop
    }
    [IO.File]::Move($tempPath, $ShortcutPath)
  }

  if (-not (Test-Path -LiteralPath $ShortcutPath)) {
    throw "Shortcut file was not created: $ShortcutPath"
  }
}

function Test-ShortcutPointsTo {
  param(
    [string]$ShortcutPath,
    [string]$TargetExe
  )
  if (-not (Test-Path -LiteralPath $ShortcutPath)) { return $false }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $targetPath = $shell.CreateShortcut($ShortcutPath).TargetPath
    return ($targetPath -and ($targetPath -ieq $TargetExe))
  } catch {
    return $false
  }
}

function Find-ExistingLauncherShortcut {
  param(
    [string]$LauncherExe,
    [string[]]$SearchFolders
  )

  foreach ($folder in $SearchFolders) {
    foreach ($item in @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue)) {
      if (Test-ShortcutPointsTo -ShortcutPath $item.FullName -TargetExe $LauncherExe) {
        return $item.FullName
      }
    }
  }
  return $null
}

function New-LauncherShortcutAt {
  param(
    [string]$Folder,
    [string]$ShortcutName,
    [string]$LauncherExe,
    [string]$WorkingDir,
    [string]$Description
  )

  $shortcutPath = [IO.Path]::Combine($Folder, $ShortcutName)
  New-LauncherShortcutFile `
    -ShortcutPath $shortcutPath `
    -TargetExe $LauncherExe `
    -WorkingDirectory $WorkingDir `
    -Description $Description | Out-Null
  return $shortcutPath
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
  $startMenus = Get-StartMenuFolders
  if ($desktops.Count -eq 0 -and $startMenus.Count -eq 0) {
    throw 'No desktop or Start Menu folder found.'
  }

  $preferredName = $label + '.lnk'
  $searchFolders = @($desktops + $startMenus)

  foreach ($folder in $searchFolders) {
    $preferredPath = [IO.Path]::Combine($folder, $preferredName)
    if (Test-ShortcutPointsTo -ShortcutPath $preferredPath -TargetExe $launcherExe) {
      return $preferredPath
    }
  }

  $existing = Find-ExistingLauncherShortcut -LauncherExe $launcherExe -SearchFolders $searchFolders
  if ($existing -and (([IO.Path]::GetFileName($existing)) -ieq $preferredName)) {
    return $existing
  }

  $shortcutNames = Get-ManagerShortcutNames
  $errors = New-Object 'System.Collections.Generic.List[string]'

  foreach ($folder in $desktops) {
    foreach ($shortcutName in $shortcutNames) {
      try {
        return (New-LauncherShortcutAt `
          -Folder $folder `
          -ShortcutName $shortcutName `
          -LauncherExe $launcherExe `
          -WorkingDir $workingDir `
          -Description 'MY Agent Manager')
      } catch {
        [void]$errors.Add("$folder\$shortcutName -> $($_.Exception.Message)")
      }
    }
  }

  foreach ($folder in $startMenus) {
    foreach ($shortcutName in $shortcutNames) {
      try {
        return (New-LauncherShortcutAt `
          -Folder $folder `
          -ShortcutName $shortcutName `
          -LauncherExe $launcherExe `
          -WorkingDir $workingDir `
          -Description 'MY Agent Manager')
      } catch {
        [void]$errors.Add("$folder\$shortcutName -> $($_.Exception.Message)")
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
