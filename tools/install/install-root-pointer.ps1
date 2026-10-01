#requires -Version 5.1
<#
.SYNOPSIS
  Producer side of the WorkKitLauncher install-root pointer contract
  (company repo manager/INSTALL-ROOT-POINTER.md).
  Writes %LOCALAPPDATA%\MYAgent\install-root.json atomically (temp + rename).
  Never throws: a pointer failure must not block install. Last write wins.
  The core rewrites the same file on every boot (core/src/setup/install-root-pointer.ts).
#>

function Write-InstallRootPointer {
  param([Parameter(Mandatory = $true)][string]$Root)
  $temp = $null
  try {
    $local = $env:LOCALAPPDATA
    if (-not $local) { $local = [Environment]::GetFolderPath('LocalApplicationData') }
    if (-not $local) { throw 'LOCALAPPDATA_UNSET' }
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($rootFull -match '^[A-Za-z]:$') { $rootFull += '\' }
    $dir = Join-Path $local 'MYAgent'
    $target = Join-Path $dir 'install-root.json'
    [void][System.IO.Directory]::CreateDirectory($dir)

    $doc = [ordered]@{
      install_root = $rootFull
      cqr_root     = $rootFull
      updated_at   = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
    }
    try {
      $manifest = Get-Content -LiteralPath (Join-Path $rootFull 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($manifest.version) { $doc.manifest_version = [string]$manifest.version }
    } catch { }

    $json = ($doc | ConvertTo-Json -Depth 3) + "`n"
    $temp = $target + '.' + $PID + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temp -Destination $target -Force
    $temp = $null
    Write-Host "Install-root pointer: $target"
    return $true
  } catch {
    if ($temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    Write-Warning "INSTALL_ROOT_POINTER_WRITE_FAILED: $($_.Exception.Message)"
    return $false
  }
}
