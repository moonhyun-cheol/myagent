#requires -Version 5.1
<#
.SYNOPSIS
  Permission-safe per-user install locations. Reuse C:\MYAgent only when the
  current Windows account can fully mutate it; otherwise prefer LocalAppData.
  Never select a shared Public profile because the install tree contains the
  user's vault, sessions, attachments, and configuration.
#>

function Get-ProductInstallFolderName {
  return 'MYAgent'
}

function Get-CurrentUserInstallPath {
  $local = [Environment]::GetFolderPath('LocalApplicationData')
  if (-not $local) { return $null }
  return (Join-Path (Join-Path $local 'Programs') (Get-ProductInstallFolderName))
}

function Get-InstallPathCandidates {
  if ($env:MY_AGENT_INSTALL_DEFAULT) {
    return @($env:MY_AGENT_INSTALL_DEFAULT)
  }
  $name = Get-ProductInstallFolderName
  $sys = $env:SystemDrive
  if (-not $sys) { $sys = 'C:' }
  $out = @((Join-Path $sys $name))
  $perUser = Get-CurrentUserInstallPath
  if ($perUser) { $out += $perUser }
  return $out
}

function Test-InstallPathCandidateWritable([string]$folder) {
  if (-not $folder) { return $false }
  $probeDir = $null
  try {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $probeDir = Join-Path $folder ('.my-agent-install-probe-{0}-{1}' -f $PID, [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $probeDir | Out-Null
    $source = Join-Path $probeDir 'create.tmp'
    $moved = Join-Path $probeDir 'moved.tmp'
    [IO.File]::WriteAllText($source, 'probe')
    Move-Item -LiteralPath $source -Destination $moved
    Remove-Item -LiteralPath $moved -Force
    Remove-Item -LiteralPath $probeDir -Force
    return $true
  } catch {
    if ($probeDir) { Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue }
    return $false
  }
}

function Get-DefaultInstallPath {
  param([string]$AvoidPath = '')
  $avoid = ''
  if ($AvoidPath) {
    try { $avoid = [IO.Path]::GetFullPath($AvoidPath).TrimEnd('\') } catch { $avoid = '' }
  }
  $candidates = @(Get-InstallPathCandidates)
  $fallback = $null
  foreach ($c in $candidates) {
    if (-not $c) { continue }
    $full = $null
    try { $full = [IO.Path]::GetFullPath($c).TrimEnd('\') } catch { continue }
    if ($avoid) {
      if ($full -eq $avoid) { continue }
      if ($full.Length -gt $avoid.Length -and $full.StartsWith($avoid + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
    }
    if (-not $fallback) { $fallback = $full }
    if (Test-InstallPathCandidateWritable $full) { return $full }
  }
  if ($fallback) { return $fallback }
  $perUser = Get-CurrentUserInstallPath
  if ($perUser) { return $perUser }
  $sys = $env:SystemDrive
  if (-not $sys) { $sys = 'C:' }
  return (Join-Path $sys (Get-ProductInstallFolderName))
}
