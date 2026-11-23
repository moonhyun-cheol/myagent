#requires -Version 5.1
# Read-only prerequisite checks. Do not download or mutate an existing installation.

function Test-WebView2Registration($Registration) {
  if ($null -eq $Registration) { return $false }
  # The suffix (Runtime) is localized by the Microsoft installer.
  if ([string]$Registration.name -notmatch '^Microsoft Edge WebView2(?:\s|$)') { return $false }
  $version = $null
  return ([Version]::TryParse([string]$Registration.pv, [ref]$version) -and $version -gt [Version]'0.0.0.0')
}

function Test-InstallWebView2Runtime {
  # EdgeUpdate records Evergreen Runtime separately from the Edge browser.
  # Check both user/machine registrations and both registry views (also on ARM64).
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
      $base = $null
      $clients = $null
      try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        $clients = $base.OpenSubKey('SOFTWARE\Microsoft\EdgeUpdate\Clients')
        if ($null -eq $clients) { continue }
        foreach ($id in $clients.GetSubKeyNames()) {
          $client = $null
          try {
            $client = $clients.OpenSubKey($id)
            if ($client -and (Test-WebView2Registration @{ name = $client.GetValue('name'); pv = $client.GetValue('pv') })) { return $true }
          } finally { if ($client) { $client.Dispose() } }
        }
      } catch { Write-Verbose "WebView2 registry view unavailable: $hive/$view" }
      finally {
        if ($clients) { $clients.Dispose() }
        if ($base) { $base.Dispose() }
      }
    }
  }
  return $false
}

function Assert-InstallWebView2Runtime {
  Write-Host 'Checking Microsoft Edge WebView2 Runtime...'
  if (-not (Test-InstallWebView2Runtime)) {
    throw 'WEBVIEW2_RUNTIME_MISSING: Install Microsoft Edge WebView2 Evergreen Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ then run install.bat again. No product files have been replaced.'
  }
}

function Get-InstallAvailableBytes([string]$TargetRoot) {
  # GetDiskFreeSpaceEx honors mount points and the current user's disk quota.
  if (-not ('MyAgent.InstallDiskProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace MyAgent {
  public static class InstallDiskProbe {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool GetDiskFreeSpaceEx(string directory, out ulong available, out ulong total, out ulong free);
  }
}
'@
  }
  [UInt64]$available = 0
  [UInt64]$total = 0
  [UInt64]$free = 0
  if (-not [MyAgent.InstallDiskProbe]::GetDiskFreeSpaceEx($TargetRoot, [ref]$available, [ref]$total, [ref]$free)) {
    throw "INSTALL_DISK_SPACE_UNKNOWN: Cannot inspect available disk space at $TargetRoot (Win32 $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
  }
  return $available
}

function Get-InstallRequiredBytes([string]$SourceRoot) {
  [Int64]$payload = 0
  [Int64]$modules = 0
  Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force -ErrorAction Stop | ForEach-Object {
    $rel = $_.FullName.Substring($SourceRoot.Length).TrimStart('\')
    if (Should-SkipRel $rel) { return }
    $payload += $_.Length
    if ($rel.StartsWith('nm\', [StringComparison]::OrdinalIgnoreCase)) { $modules += $_.Length }
  }
  # Conservative peak: staged payload + replacement headroom + a second nm copy
  # during offline restore, plus 1 GiB reserve. Existing backup files are MOVED
  # on this volume, not copied, so user data is never scanned or counted twice.
  # Optional online feature downloads may need additional space beyond this check.
  return ([Int64](2 * $payload + $modules + 1GB))
}

function Assert-InstallDiskSpace([string]$SourceRoot, [string]$TargetRoot) {
  $required = Get-InstallRequiredBytes $SourceRoot
  $available = Get-InstallAvailableBytes $TargetRoot
  $summary = 'required {0:N2} GiB / available {1:N2} GiB at {2}' -f ($required / 1GB), ($available / 1GB), $TargetRoot
  Write-Host "Checking installation disk space: $summary"
  if ($available -lt $required) {
    throw "INSTALL_DISK_SPACE_LOW: $summary. Free space or choose another local drive, then run install.bat again. No product files have been replaced."
  }
}
