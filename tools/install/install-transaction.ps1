#requires -Version 5.1
# Product-file transaction helpers shared by the full installer.

function Test-SafeInstallRelativePath([string]$Rel) {
  if (-not $Rel -or [IO.Path]::IsPathRooted($Rel)) { return $false }
  $normalized = $Rel.Replace('/', '\')
  if ($normalized -eq '..' -or $normalized.StartsWith('..\') -or $normalized.Contains('\..\')) { return $false }
  return $true
}

function Assert-InstallTransactionPaths($Transaction) {
  $target = [IO.Path]::GetFullPath($Transaction.TargetRoot).TrimEnd('\')
  $runId = [string]$Transaction.RunId
  if ($runId -notmatch '^[A-Za-z0-9_-]{8,80}$') {
    throw "INSTALL_RECOVERY_RUN_ID_INVALID: $runId"
  }
  $expectedStage = [IO.Path]::GetFullPath((Join-Path $target ('.install-payload-' + $runId))).TrimEnd('\')
  $expectedBackup = [IO.Path]::GetFullPath((Join-Path $target ('.install-backup-' + $runId))).TrimEnd('\')
  $actualStage = [IO.Path]::GetFullPath([string]$Transaction.StageRoot).TrimEnd('\')
  $actualBackup = [IO.Path]::GetFullPath([string]$Transaction.BackupRoot).TrimEnd('\')
  if (-not $actualStage.Equals($expectedStage, [StringComparison]::OrdinalIgnoreCase)) {
    throw "INSTALL_RECOVERY_STAGE_PATH_INVALID: $actualStage"
  }
  if (-not $actualBackup.Equals($expectedBackup, [StringComparison]::OrdinalIgnoreCase)) {
    throw "INSTALL_RECOVERY_BACKUP_PATH_INVALID: $actualBackup"
  }
  foreach ($rel in @($Transaction.Affected)) {
    if (-not (Test-SafeInstallRelativePath ([string]$rel))) { throw "INSTALL_RECOVERY_RELATIVE_PATH_INVALID: $rel" }
  }
}

function Get-InstallTransactionStatePath([string]$TargetRoot) {
  return Join-Path $TargetRoot '.install-transaction.json'
}

function Get-InstallProductManifestPath([string]$TargetRoot) {
  return Join-Path $TargetRoot '.install-product-files.json'
}

function Enter-InstallTargetLock([string]$TargetRoot) {
  $normalized = [IO.Path]::GetFullPath($TargetRoot).TrimEnd('\').ToLowerInvariant()
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))).Replace('-', '')
  } finally {
    $sha.Dispose()
  }
  $mutex = New-Object Threading.Mutex($false, ('Local\MYAgentInstall_' + $hash.Substring(0, 24)))
  $acquired = $false
  try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) {
    $mutex.Dispose()
    throw 'INSTALL_ALREADY_RUNNING: another installer is already modifying this target folder.'
  }
  return $mutex
}

function Exit-InstallTargetLock($Mutex) {
  if ($null -eq $Mutex) { return }
  try { $Mutex.ReleaseMutex() } catch { }
  try { $Mutex.Dispose() } catch { }
}

function Write-InstallTransactionState($Transaction) {
  $statePath = Get-InstallTransactionStatePath $Transaction.TargetRoot
  $temp = $statePath + '.tmp'
  $doc = [ordered]@{
    version = 2
    run_id = $Transaction.RunId
    target_root = $Transaction.TargetRoot
    stage_root = $Transaction.StageRoot
    backup_root = $Transaction.BackupRoot
    affected = @($Transaction.Affected)
    previously_existing = @($Transaction.PreviouslyExisting)
    core_had_previous = [bool]$Transaction.CoreHadPrevious
    started_at = $Transaction.StartedAt
  }
  [IO.File]::WriteAllText($temp, (($doc | ConvertTo-Json -Depth 5) + "`n"), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $statePath -Force
}

function Read-InstallTransactionState([string]$TargetRoot) {
  $statePath = Get-InstallTransactionStatePath $TargetRoot
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  try {
    $doc = [IO.File]::ReadAllText($statePath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    if ([int]$doc.version -ne 2 -or -not $doc.backup_root -or -not $doc.run_id) { throw 'unsupported state' }
    $transaction = [pscustomobject]@{
      RunId = [string]$doc.run_id
      TargetRoot = $TargetRoot
      StageRoot = [string]$doc.stage_root
      BackupRoot = [string]$doc.backup_root
      Affected = @($doc.affected | ForEach-Object { [string]$_ })
      PreviouslyExisting = @($doc.previously_existing | ForEach-Object { [string]$_ })
      CoreHadPrevious = [bool]$doc.core_had_previous
      StartedAt = [string]$doc.started_at
    }
    Assert-InstallTransactionPaths $transaction
    return $transaction
  } catch {
    throw "INSTALL_RECOVERY_STATE_INVALID: $statePath ($($_.Exception.Message))"
  }
}

function Undo-InstallTransaction($Transaction) {
  if ($null -eq $Transaction) { return }
  Assert-InstallTransactionPaths $Transaction
  $failures = New-Object System.Collections.Generic.List[string]
  foreach ($rel in @($Transaction.Affected | Select-Object -Unique)) {
    if (-not $rel) { continue }
    $dest = Join-Path $Transaction.TargetRoot $rel
    $backup = Join-Path $Transaction.BackupRoot $rel
    try {
      if (Test-Path -LiteralPath $backup) {
        Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
        $parent = Split-Path $dest -Parent
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Move-Item -LiteralPath $backup -Destination $dest -Force
      } elseif (@($Transaction.PreviouslyExisting) -notcontains $rel) {
        # The path did not exist before this run, so any current entry is new.
        Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
      }
      # If the path existed previously but has no backup, this entry had not yet
      # been moved when the process stopped. Preserve the untouched destination.
    } catch {
      [void]$failures.Add("$rel`: $($_.Exception.Message)")
    }
  }

  $core = Join-Path $Transaction.TargetRoot 'node_modules'
  $coreBackup = Join-Path $Transaction.TargetRoot 'node_modules.previous'
  try {
    if (Test-Path -LiteralPath $coreBackup) {
      Remove-Item -LiteralPath $core -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $coreBackup -Destination $core -Force
    } elseif (-not $Transaction.CoreHadPrevious) {
      Remove-Item -LiteralPath $core -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch {
    [void]$failures.Add("node_modules: $($_.Exception.Message)")
  }

  Remove-Item -LiteralPath $Transaction.StageRoot -Recurse -Force -ErrorAction SilentlyContinue
  if ($failures.Count -eq 0) {
    Remove-Item -LiteralPath $Transaction.BackupRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Get-InstallTransactionStatePath $Transaction.TargetRoot) -Force -ErrorAction SilentlyContinue
    return
  }
  throw "INSTALL_ROLLBACK_FAILED: $($failures -join ' | '). Recovery files remain at $($Transaction.BackupRoot)"
}

function Recover-PendingInstallTransaction([string]$TargetRoot) {
  $pending = Read-InstallTransactionState $TargetRoot
  if ($null -eq $pending) { return }
  Write-Host "Recovering interrupted install $($pending.RunId)..."
  Undo-InstallTransaction $pending
  Write-Host 'Interrupted install rolled back.'
}

function Remove-OrphanedInstallArtifacts([string]$TargetRoot) {
  if (-not (Test-Path -LiteralPath $TargetRoot)) { return }
  Get-ChildItem -LiteralPath $TargetRoot -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '.install-payload-*' -or $_.Name -like '.install-backup-*' } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  # These roots never contain committed product state. They can remain after a
  # hard stop during staged core verification and should not consume disk or be
  # mistaken for a usable runtime on the next attempt. Keep node_modules.previous
  # intact because restore-core-npm-deps owns that recovery backup.
  foreach ($transient in @('node_modules.installing', '.core-deps-verify')) {
    Remove-Item -LiteralPath (Join-Path $TargetRoot $transient) -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath ((Get-InstallTransactionStatePath $TargetRoot) + '.tmp') -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $TargetRoot -File -Force -Filter 'INSTALL-DONE.*.tmp' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}

function Start-InstallProductTransaction([string]$SourceRoot, [string]$TargetRoot, [string]$RunId) {
  $stageRoot = Join-Path $TargetRoot ('.install-payload-' + $RunId)
  $backupRoot = Join-Path $TargetRoot ('.install-backup-' + $RunId)
  Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $stageRoot,$backupRoot | Out-Null

  $sourceFiles = New-Object System.Collections.Generic.List[string]
  Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($SourceRoot.Length).TrimStart('\')
    if (-not $rel -or (Should-SkipRel $rel)) { return }
    [void]$sourceFiles.Add($rel)
    $staged = Join-Path $stageRoot $rel
    $parent = Split-Path $staged -Parent
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -LiteralPath $_.FullName -Destination $staged -Force
  }

  $previousFiles = @()
  $manifestPath = Get-InstallProductManifestPath $TargetRoot
  if (Test-Path -LiteralPath $manifestPath) {
    try {
      $loaded = [IO.File]::ReadAllText($manifestPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
      foreach ($raw in @($loaded.files)) {
        $rel = [string]$raw
        if (-not (Test-SafeInstallRelativePath $rel)) { throw "unsafe path: $rel" }
        if (-not (Should-SkipRel $rel)) { $previousFiles += $rel }
      }
    }
    catch { throw "INSTALL_PRODUCT_MANIFEST_INVALID: $manifestPath ($($_.Exception.Message))" }
  } else {
    # Installs created before manifests existed still need stale product cleanup.
    # Limit discovery to product-owned roots; never infer ownership under data,
    # runtime, modules, or other extension/user-content roots.
    foreach ($managedRoot in @('core', 'ui', 'shell', 'tools')) {
      $managedPath = Join-Path $TargetRoot $managedRoot
      if (-not (Test-Path -LiteralPath $managedPath)) { continue }
      Get-ChildItem -LiteralPath $managedPath -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $rel = $_.FullName.Substring($TargetRoot.Length).TrimStart('\')
        if ((Test-SafeInstallRelativePath $rel) -and -not (Should-SkipRel $rel) -and @($sourceFiles) -notcontains $rel) {
          $previousFiles += $rel
        }
      }
    }
    # Known product-owned root files retired before product manifests existed.
    # Keep this list explicit so arbitrary user files at the install root are
    # never inferred as stale product content.
    foreach ($legacyRel in @('WorkKitLauncher.exe', 'launcher-manifest.json', 'channels\launcher-stable.json')) {
      if ((Test-Path -LiteralPath (Join-Path $TargetRoot $legacyRel)) -and @($sourceFiles) -notcontains $legacyRel) {
        $previousFiles += $legacyRel
      }
    }
  }

  $affected = New-Object System.Collections.Generic.List[string]
  foreach ($rel in @($sourceFiles) + @($previousFiles) + @('INSTALL-DONE.txt', '.install-product-files.json')) {
    if ($rel -and -not $affected.Contains([string]$rel)) { [void]$affected.Add([string]$rel) }
  }
  $previouslyExisting = New-Object System.Collections.Generic.List[string]
  foreach ($rel in @($affected)) {
    if (Test-Path -LiteralPath (Join-Path $TargetRoot $rel)) { [void]$previouslyExisting.Add([string]$rel) }
  }
  $tx = [pscustomobject]@{
    RunId = $RunId
    TargetRoot = $TargetRoot
    StageRoot = $stageRoot
    BackupRoot = $backupRoot
    Affected = @($affected)
    PreviouslyExisting = @($previouslyExisting)
    ProductFiles = @($sourceFiles)
    CoreHadPrevious = Test-Path -LiteralPath (Join-Path $TargetRoot 'node_modules')
    StartedAt = Get-Date -Format o
  }
  Assert-InstallTransactionPaths $tx
  Write-InstallTransactionState $tx

  try {
    # Back up every existing affected entry before placing any staged file.
    # Interleaving backup and placement breaks a valid file -> directory
    # migration (old `a` blocks new `a\b`) and can leave a partial payload.
    foreach ($rel in @($affected)) {
      $dest = Join-Path $TargetRoot $rel
      $backup = Join-Path $backupRoot $rel
      if (Test-Path -LiteralPath $dest) {
        $parent = Split-Path $backup -Parent
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Move-Item -LiteralPath $dest -Destination $backup -Force
      }
    }
    foreach ($rel in @($sourceFiles)) {
      $dest = Join-Path $TargetRoot $rel
      $staged = Join-Path $stageRoot $rel
      if (Test-Path -LiteralPath $staged) {
        $parent = Split-Path $dest -Parent
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        # The old product may have owned a directory where the new payload owns
        # a file. Its contents were backed up above; never let Move-Item place
        # the new file *inside* a leftover directory with the same name.
        if (Test-Path -LiteralPath $dest) {
          Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction Stop
        }
        Move-Item -LiteralPath $staged -Destination $dest -Force
      }
    }
    foreach ($rel in @($sourceFiles)) {
      if (-not (Test-Path -LiteralPath (Join-Path $TargetRoot $rel) -PathType Leaf)) {
        throw "INSTALL_PAYLOAD_FILE_MISSING_AFTER_APPLY: $rel"
      }
    }
    return $tx
  } catch {
    $failure = $_.Exception.Message
    try { Undo-InstallTransaction $tx } catch { throw "INSTALL_PAYLOAD_ROLLBACK_FAILED: $failure. $($_.Exception.Message)" }
    throw "INSTALL_PAYLOAD_TRANSACTION_FAILED: $failure"
  }
}

function Complete-InstallProductTransaction($Transaction) {
  $manifestPath = Get-InstallProductManifestPath $Transaction.TargetRoot
  $temp = $manifestPath + '.tmp'
  # Transient payloads such as `nm` are consumed during installation. Record
  # only files that remain in the committed installation.
  $committedFiles = @($Transaction.ProductFiles | Sort-Object -Unique | Where-Object {
    Test-Path -LiteralPath (Join-Path $Transaction.TargetRoot $_) -PathType Leaf
  })
  $doc = [ordered]@{ version = 1; files = $committedFiles; installed_at = (Get-Date -Format o) }
  [IO.File]::WriteAllText($temp, (($doc | ConvertTo-Json -Depth 4) + "`n"), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $manifestPath -Force
  # The state file is the commit point. Keep both product and core backups until
  # it is removed successfully so a commit failure can still roll everything
  # back to one coherent version.
  Remove-Item -LiteralPath (Get-InstallTransactionStatePath $Transaction.TargetRoot) -Force -ErrorAction Stop
  Remove-Item -LiteralPath (Join-Path $Transaction.TargetRoot 'node_modules.previous') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Transaction.BackupRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Transaction.StageRoot -Recurse -Force -ErrorAction SilentlyContinue
}
