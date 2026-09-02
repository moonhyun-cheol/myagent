#requires -Version 5.1
# MY Agent install — ASCII-first default (C:\MYAgent), no administrator required
param(
  [string]$SourceDir = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
  [string]$TargetDir = $env:MY_AGENT_INSTALL_TARGET,
  [switch]$Interactive,
  [string]$OptionalRuntimes = '',
  [switch]$AllOptional
)
. (Join-Path $PSScriptRoot 'optional-runtimes.ps1')
. (Join-Path $PSScriptRoot 'install-paths.ps1')

$ErrorActionPreference = 'Stop'

function Get-FullPath([string]$p) {
  if (-not $p) { return $null }
  return [IO.Path]::GetFullPath($p).TrimEnd('\')
}

function Test-IsSubPath([string]$child, [string]$parent) {
  $c = Get-FullPath $child
  $p = Get-FullPath $parent
  if (-not $c -or -not $p) { return $false }
  if ($c.Length -le $p.Length) { return $false }
  return $c.StartsWith($p + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Test-IsElevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-IsProtectedSystemFolder([string]$target) {
  $t = Get-FullPath $target
  if (-not $t) { return $false }
  $roots = @(
    ${env:ProgramFiles},
    ${env:ProgramFiles(x86)},
    $env:windir,
    $env:ProgramData
  )
  foreach ($r in $roots) {
    if (-not $r) { continue }
    $p = Get-FullPath $r
    if (-not $p) { continue }
    if ($t -eq $p) { return $true }
    if (Test-IsSubPath $t $p) { return $true }
  }
  return $false
}

function Test-IsDriveRoot([string]$target) {
  $t = Get-FullPath $target
  if (-not $t) { return $false }
  $root = Get-FullPath ([IO.Path]::GetPathRoot($t))
  return $t -eq $root
}

function Test-InstallFolderWritable([string]$folder) {
  try {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    Grant-CurrentUserModify $folder
    $writeProbe = Join-Path $folder ".my-agent-install-probe-$PID.tmp"
    [IO.File]::WriteAllText($writeProbe, 'probe')
    Remove-Item -LiteralPath $writeProbe -Force
    return $true
  } catch {
    Remove-Item -LiteralPath (Join-Path $folder ".my-agent-install-probe-$PID.tmp") -Force -ErrorAction SilentlyContinue
    return $false
  }
}

function Test-IsShellDumpFolder([string]$target) {
  $t = Get-FullPath $target
  if (-not $t) { return $false }
  $folders = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('MyDocuments'),
    [Environment]::GetFolderPath('UserProfile')
  )
  $downloads = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'
  $folders += $downloads
  foreach ($f in $folders) {
    if (-not $f) { continue }
    $p = Get-FullPath $f
    if ($t -eq $p) { return $true }
  }
  return $false
}

function Grant-CurrentUserModify([string]$folder) {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = Get-Acl -LiteralPath $folder
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $id,
      'Modify',
      'ContainerInherit,ObjectInherit',
      'None',
      'Allow'
    )
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $folder -AclObject $acl
  } catch {
    Write-Host "WARN: could not grant Modify on $folder"
  }
}

function Repair-CopiedTree([string]$folder) {
  Get-ChildItem -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      if ($_.Attributes -band [IO.FileAttributes]::ReadOnly) {
        $_.Attributes = $_.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
      }
    } catch { }
  }
  Get-ChildItem -LiteralPath $folder -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try { Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue } catch { }
  }
}

if (Test-IsElevated) {
  Write-Host 'ERROR: Do not run install.bat as administrator.'
  Write-Host 'Right-click install.bat and run it as the employee Windows user so data\vault stays writable.'
  exit 1
}

$source = Get-FullPath ((Resolve-Path -LiteralPath $SourceDir).Path)
$defaultPath = Get-DefaultInstallPath -AvoidPath $source

if ($TargetDir) {
  $target = $TargetDir
} else {
  $target = $defaultPath
  Write-Host "Install target: $target"
}
$targetFull = Get-FullPath $target
$resolvedTarget = Resolve-Path -LiteralPath $target -ErrorAction SilentlyContinue
if ($resolvedTarget) {
  $targetFull = Get-FullPath $resolvedTarget.Path
}

Write-Host "Source: $source"
Write-Host "Target: $targetFull"

$sourceUnc = $source.StartsWith('\\') -or $source.ToLowerInvariant().Contains('\tsclient\')
if (-not $sourceUnc) {
  try {
    $driveName = ([IO.Path]::GetPathRoot($source) + '').TrimEnd('\').TrimEnd(':')
    $psDrive = Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue
    if ($psDrive -and $psDrive.DisplayRoot) { $sourceUnc = $true }
  } catch { }
}
if ($sourceUnc) {
  Write-Host 'ERROR: Install source is on a UNC/shared/mapped path.'
  Write-Host 'On the employee PC: copy the zip to C:\Temp, extract, run install.bat from that local folder.'
  Write-Host "Source was: $source"
  exit 1
}

if ($targetFull -eq $source) {
  Write-Host 'ERROR: Install target cannot be the same folder as the source (app).'
  Write-Host "Pick a different folder, e.g. $defaultPath"
  exit 1
}
if (Test-IsSubPath $targetFull $source) {
  Write-Host 'ERROR: Install target cannot be inside the unzipped app folder.'
  Write-Host "Pick a folder outside the zip extract, e.g. $defaultPath"
  exit 1
}
if (Test-IsShellDumpFolder $targetFull) {
  Write-Host 'ERROR: Do not install onto Desktop, Documents, Downloads, or the user profile root.'
  Write-Host "The zip can sit on the Desktop; the install folder must be a new folder, e.g. $defaultPath"
  exit 1
}
if (Test-IsDriveRoot $targetFull) {
  Write-Host "ERROR: Do not install to a drive root ($targetFull)."
  Write-Host "Use a folder such as $defaultPath, not $targetFull itself."
  exit 1
}
if (Test-IsProtectedSystemFolder $targetFull) {
  Write-Host "ERROR: Do not install under Program Files, Windows, or ProgramData ($targetFull)."
  Write-Host "Use a folder such as $defaultPath"
  exit 1
}

$excludeDirs = @('.git', 'node_modules', 'logs', 'deploy\output')
$excludeFiles = @('data\vault\license.ocx', 'data\vault\provider-keys.json', 'data\vault\activation.json')

function Should-SkipRel([string]$rel) {
  foreach ($d in $excludeDirs) {
    if ($rel -eq $d -or $rel.StartsWith("$d\")) { return $true }
  }
  foreach ($f in $excludeFiles) {
    if ($rel -eq $f) { return $true }
  }
  return $false
}

if (-not (Test-InstallFolderWritable $targetFull)) {
  throw "ERROR: Install folder is not writable: $targetFull. Example: $defaultPath. Do not run as administrator."
}

$cacheRoot = Join-Path $targetFull 'tools\cache'
$cacheTmp = Join-Path $cacheRoot 'tmp'
$cacheNpm = Join-Path $cacheRoot 'npm'
New-Item -ItemType Directory -Force -Path $cacheTmp | Out-Null
New-Item -ItemType Directory -Force -Path $cacheNpm | Out-Null
$env:TEMP = $cacheTmp
$env:TMP = $cacheTmp
$env:npm_config_cache = $cacheNpm

try {
  Get-ChildItem -LiteralPath $source -Recurse -Force | ForEach-Object {
    $rel = $_.FullName.Substring($source.Length).TrimStart('\')
    if (-not $rel -or (Should-SkipRel $rel)) { return }
    $dest = Join-Path $targetFull $rel
    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
    } else {
      $destDir = Split-Path $dest -Parent
      if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
      Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    }
  }
} catch {
  throw "ERROR: Could not copy files into $targetFull. Folder may not be writable."
}

@(
  'data\vault',
  'data\config',
  'data\sessions',
  'data\attachments',
  'data\models\llm',
  'data\outputs\images',
  'data\outputs\research',
  'data\outputs\browser'
) | ForEach-Object {
  New-Item -ItemType Directory -Force -Path (Join-Path $targetFull $_) | Out-Null
}
Repair-CopiedTree $targetFull
Grant-CurrentUserModify $targetFull

$bootstrapNode = Join-Path $targetFull 'tools\bootstrap-node-if-needed.ps1'
if (Test-Path -LiteralPath $bootstrapNode) {
  Write-Host ''
  Write-Host 'Checking portable Node...'
  & $bootstrapNode -Root $targetFull
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$selectedOptionals = Resolve-OptionalRuntimeSelection -Root $targetFull -OptionalRuntimes $OptionalRuntimes -AllOptional:$AllOptional -ApplyCatalogDefaults:(-not $PSBoundParameters.ContainsKey('OptionalRuntimes'))
Save-OptionalRuntimeSelection -Root $targetFull -Selected $selectedOptionals
Install-SelectedOptionalRuntimes -Root $targetFull -Selected $selectedOptionals

$bootstrapNpmDeps = Join-Path $targetFull 'tools\bootstrap-npm-deps-if-needed.ps1'
if (Test-Path -LiteralPath $bootstrapNpmDeps) {
  Write-Host ''
  Write-Host 'Checking runtime npm dependencies...'
  & $bootstrapNpmDeps -Root $targetFull
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$readme = @"
MY Agent install complete
=======================
Path: $targetFull

Desktop shortcut: MY Agent.lnk
Work kit launcher shortcut: MY Agent 작업 환경.lnk (if WorkKitLauncher.exe is present)

1. Launch MY Agent 작업 환경 (WorkKitLauncher) to pick a work kit, then MY Agent
2. Or launch MY Agent.exe directly for chat

First run: optional activation and provider setup.
Organization skills are installed separately through their signed module stream.
Work kits are chosen in WorkKitLauncher, not in MY Agent Settings → Skills.
Slim zip: first install may need internet for Node. Optional extras (ffmpeg, Playwright, OSS sidecars) download only if checked. Token-gated MCP is not auto-installed.
"@
Set-Content -Path (Join-Path $targetFull 'INSTALL-DONE.txt') -Value $readme -Encoding UTF8

$productExe = Join-Path $targetFull 'MYAgent.exe'
if (-not (Test-Path -LiteralPath $productExe)) {
  Write-Warning 'MYAgent.exe not found — desktop shortcut was not created.'
} else {
  try {
    $shortcutScript = Join-Path $targetFull 'tools\desktop-shortcut.ps1'
    if (Test-Path -LiteralPath $shortcutScript) {
      & $shortcutScript -Root $targetFull
    } else {
      $desktop = [Environment]::GetFolderPath('Desktop')
      $shortcutPath = Join-Path $desktop 'MY Agent.lnk'
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut($shortcutPath)
      $shortcut.TargetPath = $productExe
      $shortcut.Arguments = ''
      $shortcut.WorkingDirectory = $targetFull
      $shortcut.Description = 'MY Agent'
      $shortcut.WindowStyle = 7
      $shortcut.Save()
      Write-Host "Desktop shortcut: $shortcutPath"
      $launcherExe = Join-Path $targetFull 'WorkKitLauncher.exe'
      if (Test-Path -LiteralPath $launcherExe) {
        $launcherShortcutPath = Join-Path $desktop 'MY Agent 작업 환경.lnk'
        $launcherShortcut = $shell.CreateShortcut($launcherShortcutPath)
        $launcherShortcut.TargetPath = $launcherExe
        $launcherShortcut.Arguments = ''
        $launcherShortcut.WorkingDirectory = $targetFull
        $launcherShortcut.Description = 'MY Agent 작업 환경'
        $launcherShortcut.WindowStyle = 7
        $launcherShortcut.Save()
        Write-Host "Desktop shortcut: $launcherShortcutPath"
      }
    }
  } catch {
    Write-Warning "Desktop shortcut was skipped (folder access / OneDrive). Launch MYAgent.exe from $targetFull"
  }
}

Write-Host ''
Write-Host "Install complete: $targetFull"
Write-Host 'Next: run WorkKitLauncher (MY Agent 작업 환경) to apply a kit, then MY Agent'
