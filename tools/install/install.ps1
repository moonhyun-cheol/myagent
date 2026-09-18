#requires -Version 5.1
# MY Agent install — ASCII-first default (C:\MYAgent), no administrator required
param(
  [string]$SourceDir = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
  [string]$TargetDir = $env:MY_AGENT_INSTALL_TARGET,
  [switch]$Interactive,
  [string]$OptionalRuntimes = '',
  [switch]$AllOptional,
  [string]$InstallRunId = ''
)
. (Join-Path $PSScriptRoot 'optional-runtimes.ps1')
. (Join-Path $PSScriptRoot 'install-paths.ps1')
. (Join-Path $PSScriptRoot 'install-transaction.ps1')

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
    return (Test-InstallPathCandidateWritable $folder)
  } catch {
    return $false
  }
}

function Assert-NoRunningInstalledProcess([string]$folder) {
  if (-not (Test-Path -LiteralPath $folder)) { return }
  $prefix = (Get-FullPath $folder) + '\'
  try {
    $running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $exe = [string]$_.ExecutablePath
      $_.ProcessId -ne $PID -and $exe -and $exe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($running.Count -gt 0) {
      $names = @($running | ForEach-Object { [string]$_.Name } | Sort-Object -Unique) -join ', '
      throw "INSTALL_TARGET_IN_USE: close MY Agent and its helper processes before reinstalling ($names)."
    }
  } catch {
    if ($_.Exception.Message -like 'INSTALL_TARGET_IN_USE:*') { throw }
    Write-Host 'WARN: could not enumerate installed processes; locked-file protection remains active during transactional copy.'
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

function Repair-CopiedProductFiles([string]$folder, [string[]]$relativeFiles) {
  foreach ($rel in @($relativeFiles)) {
    if (-not $rel) { continue }
    $item = Join-Path $folder $rel
    if (-not (Test-Path -LiteralPath $item -PathType Leaf)) { continue }
    try {
      $file = Get-Item -LiteralPath $item -Force
      if ($file.Attributes -band [IO.FileAttributes]::ReadOnly) {
        $file.Attributes = $file.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
      }
    } catch { }
    try { Unblock-File -LiteralPath $item -ErrorAction SilentlyContinue } catch { }
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
if (Test-IsSubPath $source $targetFull) {
  Write-Host 'ERROR: Install source cannot be inside the target install folder.'
  Write-Host 'Move the extracted installer to a separate local folder and run it again.'
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

if (-not $InstallRunId) { $InstallRunId = [Guid]::NewGuid().ToString('N') }
if ($InstallRunId -notmatch '^[A-Za-z0-9_-]{8,80}$') { throw 'INVALID_INSTALL_RUN_ID' }
$completionMarker = Join-Path $targetFull 'INSTALL-DONE.txt'

$sourceIsDevTree = Test-Path -LiteralPath (Join-Path $source '.git')
$excludeDirs = @(
  '.git', 'node_modules', 'logs', 'deploy', 'tools\cache', '.install-payload-', '.install-backup-',
  '.tmp', '.cqr-pa', '.cursor', '.my_agent_remote', 'rulebook', 'test-results'
)
$excludeFiles = @(
  'data\vault\license.ocx',
  'data\vault\provider-keys.json',
  'data\vault\activation.json',
  'data\config\optional-runtimes.json',
  'data\config\user-overrides.json',
  'INSTALL-DONE.txt',
  '.install-product-files.json',
  '.install-transaction.json'
)

function Should-SkipRel([string]$rel) {
  foreach ($d in $excludeDirs) {
    if ($d.EndsWith('-')) {
      if ($rel.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    } elseif ($rel -eq $d -or $rel.StartsWith("$d\")) { return $true }
  }
  foreach ($f in $excludeFiles) {
    if ($rel -eq $f) { return $true }
  }
  # The full installer owns product files, never live user/runtime state. Apply
  # the same data boundary even for a developer invoking install.ps1 directly
  # from a checkout instead of from publish's already-filtered stage/app tree.
  if ($rel -eq 'data' -or $rel.StartsWith('data\', [StringComparison]::OrdinalIgnoreCase)) {
    $allowedData = @(
      'data\_model_bakeoff\summary.json',
      'data\owui-models-snapshot.json',
      'data\vault\.gitkeep',
      'data\vault\license.ocx.example',
      'data\config\user-mcp-servers.example.json'
    )
    if (@($allowedData) -notcontains $rel) { return $true }
  }
  if ($sourceIsDevTree) {
    foreach ($prefix in @(
      'runtime\playwright', 'runtime\ffmpeg', 'runtime\oss-sidecars', 'runtime\pipeline-venv',
      'runtime\python-embed', 'activation-server', '.github', 'bin\my-agent',
      'bin\work-kit-launcher', 'ui\work-kit-launcher', 'shell\WorkKitLauncher'
    )) {
      if ($rel -eq $prefix -or $rel.StartsWith($prefix + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
  }
  return $false
}

if (-not (Test-InstallFolderWritable $targetFull)) {
  $perUserPath = Get-CurrentUserInstallPath
  throw "ERROR: Install folder does not allow create, rename, and delete for this Windows account: $targetFull. Use the recommended per-user folder: $perUserPath. Do not run as administrator."
}

$installMutex = Enter-InstallTargetLock $targetFull
$installTransaction = $null
try {
  Assert-NoRunningInstalledProcess $targetFull
  Recover-PendingInstallTransaction $targetFull
  Remove-OrphanedInstallArtifacts $targetFull
  # Read the prior choice before the product transaction moves this state file
  # into its rollback backup. CLI/silent reinstalls do not have the UI checklist
  # to pass the previous selection back explicitly.
  $existingOptionalSelection = Read-OptionalRuntimeSelection $targetFull

$cacheRoot = Join-Path $targetFull 'tools\cache'
$cacheTmp = Join-Path $cacheRoot 'tmp'
$cacheNpm = Join-Path $cacheRoot 'npm'
New-Item -ItemType Directory -Force -Path $cacheTmp | Out-Null
New-Item -ItemType Directory -Force -Path $cacheNpm | Out-Null
$env:TEMP = $cacheTmp
$env:TMP = $cacheTmp
$env:npm_config_cache = $cacheNpm

Write-Host 'Staging and applying product files transactionally...'
$installTransaction = Start-InstallProductTransaction -SourceRoot $source -TargetRoot $targetFull -RunId $InstallRunId
# Resolve defaults only after the new product catalog is in place. Existing
# selection state was captured before the transaction moved its document into
# the rollback backup; it wins only when no explicit/env policy was supplied.
$useExistingOptionalSelection = (
  -not $PSBoundParameters.ContainsKey('OptionalRuntimes') -and
  -not $AllOptional -and
  $env:MY_AGENT_INSTALL_SKIP_OPTIONAL -ne '1' -and
  -not $env:MY_AGENT_INSTALL_OPTIONAL -and
  $null -ne $existingOptionalSelection
)
if ($useExistingOptionalSelection) {
  $selectedOptionals = ConvertTo-OptionalRuntimeIdList (@($existingOptionalSelection.selected) -join ',')
} else {
  $selectedOptionals = Resolve-OptionalRuntimeSelection -Root $targetFull -OptionalRuntimes $OptionalRuntimes -AllOptional:$AllOptional -ApplyCatalogDefaults:(-not $PSBoundParameters.ContainsKey('OptionalRuntimes'))
}

try {
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
Repair-CopiedProductFiles $targetFull @($installTransaction.ProductFiles)
Grant-CurrentUserModify $targetFull
foreach ($requiredWritable in @($targetFull, (Join-Path $targetFull 'data\vault'), (Join-Path $targetFull 'data\config'), (Join-Path $targetFull 'data\sessions'))) {
  if (-not (Test-InstallPathCandidateWritable $requiredWritable)) {
    throw "ERROR: Installed folder is not fully writable by this Windows account: $requiredWritable. Antivirus or inherited folder permissions may be blocking create, rename, or delete."
  }
}

$bootstrapNode = Join-Path $targetFull 'tools\bootstrap-node-if-needed.ps1'
if (Test-Path -LiteralPath $bootstrapNode) {
  Write-Host ''
  Write-Host 'Checking portable Node...'
  & $bootstrapNode -Root $targetFull
  if ($LASTEXITCODE -ne 0) { throw "PORTABLE_NODE_INSTALL_FAILED: exit $LASTEXITCODE" }
}

# Restore and verify the core runtime before any optional feature can invoke npm.
# Published installers always contain `nm`; only a source-tree/developer package
# with an explicit marker may use the online fallback.
$vendoredModules = Join-Path $targetFull 'nm'
$restoreCoreDeps = Join-Path $targetFull 'tools\restore-core-npm-deps.ps1'
$onlineCoreMarker = Join-Path $targetFull 'tools\install\ALLOW-ONLINE-CORE-DEPS'
$allowOnlineCoreDeps = (Test-Path -LiteralPath (Join-Path $source '.git')) -or (Test-Path -LiteralPath $onlineCoreMarker)
if (Test-Path -LiteralPath $vendoredModules) {
  Write-Host ''
  Write-Host 'Restoring bundled runtime npm dependencies (offline)...'
  if (-not (Test-Path -LiteralPath $restoreCoreDeps)) {
    throw "CORE_RESTORE_SCRIPT_MISSING: $restoreCoreDeps"
  }
  & $restoreCoreDeps -Root $targetFull -RetainBackup
  if ($LASTEXITCODE -ne 0) { throw "CORE_BUNDLE_RESTORE_FAILED: exit $LASTEXITCODE" }
  Remove-Item -LiteralPath $vendoredModules -Recurse -Force -ErrorAction SilentlyContinue
} elseif (-not $allowOnlineCoreDeps) {
  throw 'CORE_BUNDLE_MISSING: this installer does not contain nm. Download the complete install ZIP again; online npm fallback is disabled for release installers.'
}

$bootstrapNpmDeps = Join-Path $targetFull 'tools\bootstrap-npm-deps-if-needed.ps1'
if (Test-Path -LiteralPath $bootstrapNpmDeps) {
  Write-Host ''
  Write-Host 'Checking runtime npm dependencies...'
  & $bootstrapNpmDeps -Root $targetFull -AllowOnlineInstall:$allowOnlineCoreDeps
  if ($LASTEXITCODE -ne 0) { throw "CORE_DEPENDENCIES_INVALID: exit $LASTEXITCODE" }
}

$readme = @"
MY Agent install complete
=======================
Path: $targetFull
Run id: $InstallRunId

Desktop shortcut: MY Agent.lnk

1. Launch MY Agent.exe
2. Use the composer + menu to turn a conversation skill on or off

First run: optional activation and provider setup.
Organization skills are installed separately through their signed module stream.
Conversation skills are selected only from the composer + menu.
Slim zip: first install may need internet for Node. Optional extras (ffmpeg, Playwright, OSS sidecars) download only if checked. Token-gated MCP is not auto-installed.
"@
$completionTemp = Join-Path $targetFull ('INSTALL-DONE.' + $InstallRunId + '.tmp')
Set-Content -LiteralPath $completionTemp -Value $readme -Encoding UTF8
Move-Item -LiteralPath $completionTemp -Destination $completionMarker -Force
Complete-InstallProductTransaction $installTransaction
$installTransaction = $null
Write-Host 'Core installation committed. Preparing selected optional features...'
} catch {
  $installFailure = $_.Exception.Message
  Remove-Item -LiteralPath (Join-Path $targetFull ('INSTALL-DONE.' + $InstallRunId + '.tmp')) -Force -ErrorAction SilentlyContinue
  if ($null -ne $installTransaction) {
    try { Undo-InstallTransaction $installTransaction } catch { throw "$installFailure. $($_.Exception.Message)" }
  }
  throw $installFailure
}

# Optional downloads are deliberately outside the required product transaction.
# They cannot roll a verified core install back, and their state is recorded as
# a partial-success result for the installer UI and later retries.
$optionalResult = [pscustomobject]@{ Installed = @(); Failed = @() }
$optionalStateWriteFailed = $false
try {
  $optionalResult = Install-SelectedOptionalRuntimes -Root $targetFull -Selected $selectedOptionals
} catch {
  Write-Warning "OPTIONAL_RUNTIME_PHASE_FAILED: $($_.Exception.Message)"
  $optionalResult = [pscustomobject]@{ Installed = @(); Failed = @($selectedOptionals) }
}
try {
  Save-OptionalRuntimeSelection -Root $targetFull -Selected $selectedOptionals -Installed @($optionalResult.Installed) -Failed @($optionalResult.Failed)
} catch {
  $optionalStateWriteFailed = $true
  Write-Warning "OPTIONAL_RUNTIME_STATE_WRITE_FAILED: $($_.Exception.Message)"
}
$optionalSummary = if (@($optionalResult.Failed).Count -gt 0) {
  'Optional features incomplete: ' + (@($optionalResult.Failed) -join ', ')
} elseif ($optionalStateWriteFailed) {
  'Optional feature status could not be saved; review the installer log and retry optional features if needed.'
} else {
  'Optional features complete.'
}
try { Add-Content -LiteralPath $completionMarker -Value ("`n" + $optionalSummary) -Encoding UTF8 } catch {
  Write-Warning "OPTIONAL_RUNTIME_SUMMARY_WRITE_FAILED: $($_.Exception.Message)"
}
Write-Host $optionalSummary
} finally {
  Exit-InstallTargetLock $installMutex
}

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

    }
  } catch {
    Write-Warning "Desktop shortcut was skipped (folder access / OneDrive). Launch MYAgent.exe from $targetFull"
  }
}

Write-Host ''
Write-Host "Install complete: $targetFull"
Write-Host 'Next: run MY Agent, then use the composer + menu to select a skill as needed'
exit 0
