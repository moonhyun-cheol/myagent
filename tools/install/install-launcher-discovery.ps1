#requires -Version 5.1
# Shared discovery helpers for WorkKitLauncher install into an existing MY Agent tree.

function Get-FullPath([string]$p) {
  if (-not $p) { return $null }
  try {
    return [IO.Path]::GetFullPath($p).TrimEnd('\')
  } catch {
    return $null
  }
}

function Test-MyAgentManifestFile([string]$manifestPath) {
  if (-not (Test-Path -LiteralPath $manifestPath)) { return $false }
  try {
    $doc = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
    $name = [string]$doc.name
    if ($name -match 'MY Agent') { return $true }
    if ($null -ne $doc.version -and $null -ne $doc.update_sequence) { return $true }
  } catch {
    return $false
  }
  return $false
}

function Test-MyAgentInstallRoot([string]$root) {
  $r = Get-FullPath $root
  if (-not $r) { return $false }
  if (-not (Test-MyAgentManifestFile (Join-Path $r 'manifest.json'))) { return $false }
  $markers = @(
    (Join-Path $r 'MYAgent.exe'),
    (Join-Path $r 'bin\my-agent\MYAgent.exe'),
    (Join-Path $r 'core\dist\main.js'),
    (Join-Path $r 'data\runtime\api-port.json'),
    (Join-Path $r 'INSTALL-DONE.txt')
  )
  foreach ($marker in $markers) {
    if (Test-Path -LiteralPath $marker) { return $true }
  }
  return $false
}

function Resolve-InstallRootFromExe([string]$exePath) {
  if (-not $exePath) { return $null }
  try {
    if ($exePath -match '\.js$') {
      $current = Get-FullPath (Split-Path $exePath -Parent)
    } else {
      $exePath = (Get-Item -LiteralPath $exePath -ErrorAction Stop).FullName
      $current = Split-Path $exePath -Parent
    }
  } catch {
    return $null
  }
  for ($i = 0; $i -lt 10; $i++) {
    if (Test-MyAgentInstallRoot $current) {
      return (Get-FullPath $current)
    }
    $parent = Split-Path $current -Parent
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
  return $null
}

function Test-RootPathUsable([string]$path) {
  if (-not $path) { return $false }
  try {
    $full = [IO.Path]::GetFullPath($path)
    $root = [IO.Path]::GetPathRoot($full)
    if ($root.Length -ge 2 -and $root[1] -eq ':') {
      $drive = $root.TrimEnd('\')
      if (-not (Test-Path -LiteralPath $drive)) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

function Get-ManifestSearchRoots {
  $roots = New-Object 'System.Collections.Generic.List[string]'
  if ($env:MY_AGENT_ROOT) { [void]$roots.Add($env:MY_AGENT_ROOT) }
  foreach ($candidate in Get-InstallPathCandidates) {
    if ($candidate) { [void]$roots.Add($candidate) }
  }
  foreach ($legacy in @('C:\app', 'D:\MYAgent', 'C:\MY Agent')) {
    [void]$roots.Add($legacy)
  }
  if ($env:USERPROFILE) {
    [void]$roots.Add($env:USERPROFILE)
    [void]$roots.Add((Join-Path $env:USERPROFILE 'MYAgent'))
  }
  try {
    foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {
      if (-not $drive.IsReady -or $drive.DriveType -ne 'Fixed') { continue }
      [void]$roots.Add((Join-Path $drive.Root 'MYAgent'))
    }
  } catch {
    # Ignore drive enumeration failures.
  }
  return $roots.ToArray() | Where-Object { Test-RootPathUsable $_ } | Select-Object -Unique
}

function Get-PersistedApiPort([string]$root) {
  if (-not (Test-RootPathUsable $root)) { return $null }
  $path = Join-Path $root 'data\runtime\api-port.json'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $doc = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $port = [int]$doc.port
    if ($port -ge 1 -and $port -le 65535) { return $port }
  } catch {
    return $null
  }
  return $null
}

function Get-InstallRootFromHealthEndpoint([int]$port) {
  if ($port -lt 1 -or $port -gt 65535) { return $null }
  try {
    $uri = "http://127.0.0.1:$port/health"
    $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
    if ($response.StatusCode -ne 200) { return $null }
    $json = $response.Content | ConvertFrom-Json
    if (-not $json.ok) { return $null }
    $root = [string]$json.cqr_root
    if (Test-MyAgentInstallRoot $root) {
      return (Get-FullPath $root)
    }
  } catch {
    return $null
  }
  return $null
}

function Find-InstallRootFromRunningApi {
  $ports = New-Object 'System.Collections.Generic.List[int]'
  foreach ($root in Get-ManifestSearchRoots) {
    $hint = Get-PersistedApiPort $root
    if ($hint) { [void]$ports.Add($hint) }
    if (-not (Test-RootPathUsable $root)) { continue }
    $manifestPath = Join-Path $root 'manifest.json'
    if (Test-Path -LiteralPath $manifestPath) {
      try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($null -ne $manifest.api_port_default) {
          [void]$ports.Add([int]$manifest.api_port_default)
        }
      } catch {
        continue
      }
    }
  }
  for ($port = 10200; $port -le 10250; $port++) {
    [void]$ports.Add($port)
  }

  foreach ($port in ($ports | Select-Object -Unique)) {
    $found = Get-InstallRootFromHealthEndpoint $port
    if ($found) { return $found }
  }
  return $null
}

function Resolve-ShortcutInstallRoot([string]$shortcutPath) {
  if (-not (Test-Path -LiteralPath $shortcutPath)) { return $null }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $fromExe = Resolve-InstallRootFromExe $shortcut.TargetPath
    if ($fromExe) { return $fromExe }

    $candidates = @()
    if ($shortcut.WorkingDirectory) { $candidates += $shortcut.WorkingDirectory }
    if ($shortcut.TargetPath) {
      $parent = Split-Path -Path $shortcut.TargetPath -Parent -ErrorAction SilentlyContinue
      if ($parent) { $candidates += $parent }
    }
    foreach ($candidate in $candidates) {
      if (Test-MyAgentInstallRoot $candidate) {
        return (Get-FullPath $candidate)
      }
    }
  } catch {
    return $null
  }
  return $null
}

function Get-ShortcutSearchFolders {
  $paths = @()
  foreach ($special in @('Desktop', 'CommonDesktopDirectory', 'Programs', 'CommonPrograms', 'StartMenu', 'CommonStartMenu')) {
    $p = [Environment]::GetFolderPath($special)
    if ($p) { $paths += $p }
  }
  if ($env:OneDrive) {
    $paths += (Join-Path $env:OneDrive 'Desktop')
    $paths += (Join-Path $env:OneDrive '시작 메뉴\Programs')
  }
  if ($env:APPDATA) {
    $paths += (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
  }
  return $paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
}

function Find-InstallRootFromProcesses {
  foreach ($procName in @('MYAgent', 'WorkKitLauncher', 'MYAgent.Updater')) {
    foreach ($proc in @(Get-Process -Name $procName -ErrorAction SilentlyContinue)) {
      try {
        $fromPath = Resolve-InstallRootFromExe $proc.Path
        if ($fromPath) { return $fromPath }
        $fromModule = Resolve-InstallRootFromExe $proc.MainModule.FileName
        if ($fromModule) { return $fromModule }
      } catch {
        continue
      }
    }
  }

  foreach ($node in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)) {
    $cmd = [string]$node.CommandLine
    if ($cmd -notmatch 'main\.js') { continue }
    if ($cmd -match '"([^"]+\\core\\dist\\main\.js)"') {
      $found = Resolve-InstallRootFromExe $matches[1]
      if ($found) { return $found }
    }
    if ($cmd -match '([A-Za-z]:\\[^"\s]+\\core\\dist\\main\.js)') {
      $found = Resolve-InstallRootFromExe $matches[1]
      if ($found) { return $found }
    }
  }
  return $null
}

function Find-InstallRootFromDiskScan {
  foreach ($root in Get-ManifestSearchRoots) {
    if (Test-MyAgentInstallRoot $root) {
      return (Get-FullPath $root)
    }
    if (-not (Test-Path -LiteralPath $root)) { continue }
    try {
      foreach ($child in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
        if (Test-MyAgentInstallRoot $child.FullName) {
          return (Get-FullPath $child.FullName)
        }
      }
    } catch {
      continue
    }
  }
  return $null
}

function Find-InstallRootFromShortcuts {
  foreach ($folder in Get-ShortcutSearchFolders) {
    foreach ($shortcutName in @('MY Agent.lnk', 'MY Agent 관리자.lnk', 'MY Agent Work Kit.lnk', 'MY Agent 작업 환경.lnk', 'WorkKitLauncher.lnk')) {
      $shortcutPath = Join-Path $folder $shortcutName
      if (-not (Test-Path -LiteralPath $shortcutPath)) { continue }
      try {
        $found = Resolve-ShortcutInstallRoot $shortcutPath
        if ($found) { return $found }
      } catch {
        continue
      }
    }
    try {
      foreach ($shortcut in @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue)) {
        try {
          $found = Resolve-ShortcutInstallRoot $shortcut.FullName
          if ($found) { return $found }
        } catch {
          continue
        }
      }
    } catch {
      continue
    }
  }
  return $null
}

function Find-MyAgentInstallRoot {
  $steps = @(
    @{ Name = 'running MY Agent API'; Action = { Find-InstallRootFromRunningApi } },
    @{ Name = 'MY_AGENT_ROOT'; Action = { Get-FullPath $env:MY_AGENT_ROOT } },
    @{ Name = 'standard install folders'; Action = { Find-InstallRootFromDiskScan } },
    @{ Name = 'running processes'; Action = { Find-InstallRootFromProcesses } },
    @{ Name = 'shortcuts'; Action = { Find-InstallRootFromShortcuts } }
  )

  foreach ($step in $steps) {
    try {
      $found = & $step.Action
      if ($found -and (Test-MyAgentInstallRoot $found)) {
        Write-Host "Found install folder via $($step.Name): $found"
        return (Get-FullPath $found)
      }
    } catch {
      continue
    }
  }
  return $null
}

function Normalize-InstallRootInput([string]$raw) {
  $trimmed = [string]$raw
  if (-not $trimmed) { return $null }
  $trimmed = $trimmed.Trim().Trim('"')
  if (-not $trimmed) { return $null }

  $full = Get-FullPath $trimmed
  if (Test-MyAgentInstallRoot $full) { return $full }

  if ((Split-Path $full -Leaf) -ieq 'MYAgent.exe') {
    $parent = Split-Path $full -Parent
    if (Test-MyAgentInstallRoot $parent) { return (Get-FullPath $parent) }
  }

  if ((Split-Path $full -Leaf) -ieq 'manifest.json') {
    $parent = Split-Path $full -Parent
    if (Test-MyAgentInstallRoot $parent) { return (Get-FullPath $parent) }
  }

  return $null
}
