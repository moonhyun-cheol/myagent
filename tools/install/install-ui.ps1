#requires -Version 5.1
<#
.SYNOPSIS
  Progress window for MY Agent install (slim zip downloads Node/ffmpeg/Playwright).
.DESCRIPTION
  Runs tools/install/install.ps1 as a child process and reports each stage.
  All WinForms handlers are wrapped: an unhandled error inside a Timer tick
  surfaces as a .NET "JIT debugging" crash dialog instead of an install message,
  so every handler catches its own failures and reports them in the window.
#>
param(
  [string]$SourceDir = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
  [string]$TargetDir = '',
  [switch]$SmokeTest,
  [int]$SmokeExitCode = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$defaultPath = if ($env:MY_AGENT_INSTALL_DEFAULT) {
  $env:MY_AGENT_INSTALL_DEFAULT
} else {
  Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\MY Agent'
}

function Get-FullPathSafe([string]$p) {
  if (-not $p) { return $null }
  return [IO.Path]::GetFullPath($p).TrimEnd('\')
}

function Test-IsDriveRoot([string]$target) {
  $t = Get-FullPathSafe $target
  if (-not $t) { return $false }
  $root = Get-FullPathSafe ([IO.Path]::GetPathRoot($t))
  return $t -eq $root
}

function Test-IsNewFolderOnDriveRoot([string]$target) {
  $t = Get-FullPathSafe $target
  if (-not $t) { return $false }
  $parent = Get-FullPathSafe ([IO.Path]::GetDirectoryName($t))
  $root = Get-FullPathSafe ([IO.Path]::GetPathRoot($t))
  if (-not $parent -or $parent -ne $root) { return $false }
  return -not (Test-Path -LiteralPath $t)
}

function Test-InstallFolderWritable([string]$folder) {
  try {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $probe = Join-Path $folder ".my-agent-ui-probe-$PID.tmp"
    [IO.File]::WriteAllText($probe, 'probe')
    Remove-Item -LiteralPath $probe -Force
    return $true
  } catch {
    Remove-Item -LiteralPath (Join-Path $folder ".my-agent-ui-probe-$PID.tmp") -Force -ErrorAction SilentlyContinue
    return $false
  }
}

function Test-IsProtectedSystemFolder([string]$target) {
  $t = Get-FullPathSafe $target
  if (-not $t) { return $false }
  $roots = @(
    ${env:ProgramFiles},
    ${env:ProgramFiles(x86)},
    $env:windir,
    $env:ProgramData
  )
  foreach ($r in $roots) {
    if (-not $r) { continue }
    $p = Get-FullPathSafe $r
    if (-not $p) { continue }
    if ($t -eq $p) { return $true }
    if ($t.Length -gt $p.Length -and $t.StartsWith($p + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Test-IsElevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-IsShellDumpFolder([string]$target) {
  $t = Get-FullPathSafe $target
  if (-not $t) { return $false }
  $folders = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('MyDocuments'),
    [Environment]::GetFolderPath('UserProfile')
  )
  $folders += (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads')
  foreach ($f in $folders) {
    if (-not $f) { continue }
    if ($t -eq (Get-FullPathSafe $f)) { return $true }
  }
  return $false
}

$sourceFull = Get-FullPathSafe $SourceDir
if ($sourceFull -and $defaultPath) {
  $defFull = Get-FullPathSafe $defaultPath
  if ($defFull -eq $sourceFull -or ($defFull.Length -gt $sourceFull.Length -and $defFull.StartsWith($sourceFull + '\', [StringComparison]::OrdinalIgnoreCase))) {
    $defaultPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\MY Agent'
  }
}
try {
  New-Item -ItemType Directory -Force -Path $defaultPath | Out-Null
} catch {
  $defaultPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MY Agent'
  try { New-Item -ItemType Directory -Force -Path $defaultPath | Out-Null } catch { }
}

if (Test-IsElevated) {
  [void][System.Windows.Forms.MessageBox]::Show(
    'Do not run install.bat as administrator. Run it as the employee Windows user.',
    'MY Agent Installer',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  exit 1
}

if (-not $TargetDir) {
  $defaultOk = Test-InstallFolderWritable $defaultPath
  if (-not $defaultOk) {
    [void][System.Windows.Forms.MessageBox]::Show(
      "Cannot write to the default user folder:`r`n$defaultPath`r`nCheck disk / antivirus, then run install.bat again.",
      'MY Agent Installer',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit 1
  }

  $choice = [System.Windows.Forms.MessageBox]::Show(
    "MY Agent will install to a user folder (no administrator):`r`n$defaultPath`r`n`r`nYes = install here (recommended)`r`nNo = choose a different folder`r`nCancel = quit",
    'MY Agent Installer',
    [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
  if ($choice -eq [System.Windows.Forms.DialogResult]::Cancel) {
    exit 1
  }
  if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
    $TargetDir = $defaultPath
  }
}

if (-not $TargetDir) {
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Select a user folder. Do not pick C:\, Desktop, or the unzipped app folder.'
  $dialog.SelectedPath = $defaultPath
  $dialog.ShowNewFolderButton = $true
  while ($true) {
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
      exit 1
    }
    $picked = Get-FullPathSafe $dialog.SelectedPath
    $badSame = $sourceFull -and ($picked -eq $sourceFull)
    $badInside = $sourceFull -and $picked.Length -gt $sourceFull.Length -and $picked.StartsWith($sourceFull + '\', [StringComparison]::OrdinalIgnoreCase)
    $badDump = Test-IsShellDumpFolder $picked
    $badRoot = Test-IsDriveRoot $picked
    $badSystem = Test-IsProtectedSystemFolder $picked
    $badNewRoot = Test-IsNewFolderOnDriveRoot $picked
    if (-not $badSame -and -not $badInside -and -not $badDump -and -not $badRoot -and -not $badSystem -and -not $badNewRoot) {
      if (-not (Test-InstallFolderWritable $picked)) {
        [void][System.Windows.Forms.MessageBox]::Show(
          "That folder is not writable:`r`n$picked`r`nUse $defaultPath",
          'MY Agent Installer',
          [System.Windows.Forms.MessageBoxButtons]::OK,
          [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        continue
      }
      $TargetDir = $dialog.SelectedPath
      break
    }
    $hint = if ($badRoot -or $badSystem -or $badNewRoot) {
      "Do not install to C:\ or Program Files.`r`nUse the user folder:`r`n$defaultPath"
    } elseif ($badDump) {
      "Do not install onto Desktop / Documents / Downloads.`r`nThe zip may stay on the Desktop. Example:`r`n$defaultPath"
    } else {
      "That folder is the unzipped package (or inside it). Example:`r`n$defaultPath"
    }
    [void][System.Windows.Forms.MessageBox]::Show(
      $hint,
      'MY Agent Installer',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    )
  }
}

function Quote-ProcessArg([string]$value) {
  if ($null -eq $value) { return '""' }
  return '"' + ($value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Quote-PsLiteral([string]$value) {
  return "'" + ($value -replace "'", "''") + "'"
}

$installScript = Join-Path $PSScriptRoot 'install.ps1'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$logPath = Join-Path $env:TEMP ("cqr-install-ui-$PID.log")
if (Test-Path -LiteralPath $logPath) {
  Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
}

if ($SmokeTest) {
  $smokeCommand = @(
    "'Checking portable Node...'",
    'Start-Sleep -Milliseconds 250',
    "'Checking market-research Python venv...'",
    'Start-Sleep -Milliseconds 250',
    "'Installing Playwright Chromium...'",
    'Start-Sleep -Milliseconds 250',
    "'Installing ffmpeg...'",
    'Start-Sleep -Milliseconds 250',
    "'Checking runtime npm dependencies...'",
    'Start-Sleep -Milliseconds 250',
    "'Install complete'",
    "exit $SmokeExitCode"
  ) -join ';'
  $workCommand = "& { $smokeCommand }"
} else {
  $workCommand = @(
    '&', (Quote-PsLiteral $installScript),
    '-SourceDir', (Quote-PsLiteral $SourceDir),
    '-TargetDir', (Quote-PsLiteral $TargetDir)
  ) -join ' '
}

# Capture all streams as text. Child scripts use Stop; npm/pip stderr must not
# become a terminating "ERROR: npm notice" via *>&1.
$innerCommand = @"
`$ErrorActionPreference = 'Continue'
`$log = $(Quote-PsLiteral $logPath)
`$code = 0
try {
  $workCommand *>&1 | ForEach-Object {
    `$s = if (`$_ -is [System.Management.Automation.ErrorRecord]) { `$_.ToString() } else { (`$_ | Out-String).TrimEnd() }
    if (`$s) { Add-Content -LiteralPath `$log -Value `$s -Encoding UTF8 }
  }
  `$code = `$LASTEXITCODE
} catch {
  `$msg = `$_.Exception.Message
  # npm/pip write notices to stderr; under Stop that surfaces here even on success.
  if (`$msg -match '^(npm (notice|warn)|WARNING:)') {
    Add-Content -LiteralPath `$log -Value ('WARN: ' + `$msg) -Encoding UTF8
    if (`$null -eq `$code -or `$code -eq 0) { `$code = 0 }
  } else {
    Add-Content -LiteralPath `$log -Value ('ERROR: ' + `$msg) -Encoding UTF8
    `$code = 1
  }
}
if (`$null -eq `$code) { `$code = 0 }
# Success marker from install.ps1 — prefer disk evidence over noisy stderr.
if ((Test-Path -LiteralPath $(Quote-PsLiteral (Join-Path $TargetDir 'INSTALL-DONE.txt'))) -and `$code -ne 0) {
  Add-Content -LiteralPath `$log -Value 'WARN: stderr noise after INSTALL-DONE — treating as success' -Encoding UTF8
  `$code = 0
}
exit `$code
"@

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $powershellExe
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.Arguments = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-Command', (Quote-ProcessArg $innerCommand)
) -join ' '

# Single script-scoped bag: WinForms handlers run in a child scope, and relying on
# implicit lookup of plain locals is what produced null method calls on tick.
$script:st = @{
  Form       = $null
  Title      = $null
  Status     = $null
  Detail     = $null
  Bar        = $null
  Elapsed    = $null
  Timer      = $null
  CloseTimer = $null
  Proc       = New-Object System.Diagnostics.Process
  LogPath    = $logPath
  TargetDir  = $TargetDir
  StartedAt  = Get-Date
  LastLine   = ''
  Completed  = $false
  ExitCode   = 1
}
$script:st.Proc.StartInfo = $psi

$script:st.Form = New-Object System.Windows.Forms.Form
$script:st.Form.Text = 'MY Agent Installer'
$script:st.Form.ClientSize = New-Object System.Drawing.Size(520, 232)
$script:st.Form.StartPosition = 'CenterScreen'
$script:st.Form.FormBorderStyle = 'FixedDialog'
$script:st.Form.MaximizeBox = $false
$script:st.Form.MinimizeBox = $true
$script:st.Form.TopMost = $true
$script:st.Form.ShowInTaskbar = $true
$script:st.Form.BackColor = [System.Drawing.Color]::FromArgb(248, 249, 251)

$script:st.Title = New-Object System.Windows.Forms.Label
$script:st.Title.AutoSize = $false
$script:st.Title.Location = New-Object System.Drawing.Point(30, 24)
$script:st.Title.Size = New-Object System.Drawing.Size(460, 30)
$script:st.Title.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$script:st.Title.Text = 'Installing MY Agent'
$script:st.Form.Controls.Add($script:st.Title)

$script:st.Status = New-Object System.Windows.Forms.Label
$script:st.Status.AutoSize = $false
$script:st.Status.Location = New-Object System.Drawing.Point(30, 66)
$script:st.Status.Size = New-Object System.Drawing.Size(460, 26)
$script:st.Status.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$script:st.Status.Text = 'Preparing installation files...'
$script:st.Form.Controls.Add($script:st.Status)

$script:st.Detail = New-Object System.Windows.Forms.Label
$script:st.Detail.AutoSize = $false
$script:st.Detail.Location = New-Object System.Drawing.Point(30, 96)
$script:st.Detail.Size = New-Object System.Drawing.Size(460, 46)
$script:st.Detail.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$script:st.Detail.ForeColor = [System.Drawing.Color]::FromArgb(90, 96, 108)
$script:st.Detail.Text = "Install location: $TargetDir"
$script:st.Form.Controls.Add($script:st.Detail)

$script:st.Bar = New-Object System.Windows.Forms.ProgressBar
$script:st.Bar.Location = New-Object System.Drawing.Point(30, 152)
$script:st.Bar.Size = New-Object System.Drawing.Size(460, 20)
$script:st.Bar.Style = 'Marquee'
$script:st.Bar.MarqueeAnimationSpeed = 28
$script:st.Form.Controls.Add($script:st.Bar)

$script:st.Elapsed = New-Object System.Windows.Forms.Label
$script:st.Elapsed.AutoSize = $false
$script:st.Elapsed.Location = New-Object System.Drawing.Point(30, 182)
$script:st.Elapsed.Size = New-Object System.Drawing.Size(460, 24)
$script:st.Elapsed.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$script:st.Elapsed.ForeColor = [System.Drawing.Color]::FromArgb(110, 116, 128)
$script:st.Elapsed.Text = 'Please wait - elapsed 00:00'
$script:st.Form.Controls.Add($script:st.Elapsed)

function Get-StageText([string]$line) {
  if ($line -match 'portable Node|bootstrap-node') { return '1/5 - Downloading Node.js runtime' }
  if ($line -match 'python-embed|pipeline venv|Python') { return '2/5 - Preparing market-research Python' }
  if ($line -match 'Playwright|Chromium') { return '3/5 - Downloading browser engine (~300MB)' }
  if ($line -match 'ffmpeg') { return '4/5 - Downloading video tools' }
  if ($line -match 'npm dependencies|runtime npm') { return '5/5 - Finishing runtime dependencies' }
  if ($line -match 'Install complete|Desktop shortcut') { return 'Finishing installation' }
  return $null
}

function Complete-Install {
  $st = $script:st
  if ($null -ne $st.Timer) { $st.Timer.Stop() }
  $st.Completed = $true
  $st.ExitCode = if ($null -ne $st.Proc) { $st.Proc.ExitCode } else { 1 }

  if ($null -ne $st.Bar) {
    $st.Bar.Style = 'Continuous'
    $st.Bar.Value = 100
  }

  if ($st.ExitCode -eq 0) {
    $st.Title.Text = 'Installation complete'
    $st.Status.Text = 'Launch MY Agent from the desktop shortcut.'
    $st.Detail.Text = "Install location: $($st.TargetDir)"
    $st.Elapsed.Text = 'This window will close shortly.'

    $st.CloseTimer = New-Object System.Windows.Forms.Timer
    $st.CloseTimer.Interval = 1500
    $st.CloseTimer.Add_Tick({
      try {
        if ($null -ne $script:st.CloseTimer) { $script:st.CloseTimer.Stop() }
        if ($null -ne $script:st.Form) { $script:st.Form.Close() }
      } catch {
        # Nothing actionable: the install already succeeded.
      }
    })
    $st.CloseTimer.Start()
    return
  }

  $st.Title.Text = 'Installation did not complete'
  $detail = if ($st.LastLine) { $st.LastLine } else { "Installer exit code: $($st.ExitCode)" }
  $logTail = ''
  if (Test-Path -LiteralPath $st.LogPath) {
    try {
      $lines = @(Get-Content -LiteralPath $st.LogPath -Encoding UTF8 -ErrorAction SilentlyContinue)
      $errHits = @($lines | Where-Object { $_ -like 'ERROR:*' })
      if ($errHits.Count -gt 0) {
        $logTail = [string]$errHits[-1]
      } else {
        $logTail = @($lines | Select-Object -Last 5) -join ' | '
      }
    } catch { }
  }
  $failBlob = "$detail $logTail"
  if ($failBlob -like '*cannot be the same folder*' -or $failBlob -like '*cannot be inside the unzipped*' -or $failBlob -like '*cannot be inside the source*') {
    $st.Status.Text = 'Pick a folder outside the unzipped package. Example: LocalAppData\Programs\MY Agent'
  } elseif ($failBlob -like '*Do not install onto Desktop*' -or $failBlob -like '*Documents, Downloads*') {
    $st.Status.Text = 'Zip may stay on the Desktop. Install into a new folder, not Desktop itself.'
  } elseif ($failBlob -like '*Do not run install*' -or $failBlob -like '*as administrator*') {
    $st.Status.Text = 'Do not run as administrator. Run install.bat as the employee Windows user.'
  } elseif ($failBlob -like '*Program Files*' -or $failBlob -like '*ProgramData*') {
    $st.Status.Text = 'Do not install under Program Files. Use LocalAppData\Programs\MY Agent.'
  } elseif ($failBlob -like '*directly under*' -or $failBlob -like '*drive root*' -or $failBlob -like '*not C:\*' -or $failBlob -like '*not writable*') {
    $st.Status.Text = 'Do not install to C:\. Use LocalAppData\Programs\MY Agent (Yes on the first prompt).'
  } elseif ($failBlob -like '*is not a batch file*' -or $failBlob -like '*tsclient*' -or $failBlob -like '*UNC*') {
    $st.Status.Text = 'Shared folder path broke the installer. Copy zip to C:\Temp, extract, run install.bat.'
  } elseif ($failBlob -match 'internet|download|WebRequest|nodejs\.org|pypi|ENOTFOUND|timed out') {
    $st.Status.Text = 'Network download failed. Check the connection, then run install.bat again.'
  } else {
    $st.Status.Text = 'See detail below. Log: %TEMP%\cqr-install-ui-*.log'
  }
  $shown = if ($logTail) { $logTail } else { $detail }
  $st.Detail.Text = if ($shown.Length -gt 220) { $shown.Substring(0, 217) + '...' } else { $shown }
  $st.Elapsed.Text = 'Review the message above, then close this window.'
  if ($null -ne $st.Bar) { $st.Bar.Value = 0 }
}

$script:st.Timer = New-Object System.Windows.Forms.Timer
$script:st.Timer.Interval = 200
$script:st.Timer.Add_Tick({
  # A terminating error here would escape as an unhandled WinForms exception.
  $ErrorActionPreference = 'Continue'
  try {
    $st = $script:st
    if ($null -eq $st) { return }

    if (Test-Path -LiteralPath $st.LogPath) {
      $tail = @(Get-Content -LiteralPath $st.LogPath -Tail 1 -Encoding UTF8 -ErrorAction SilentlyContinue)
      $line = if ($tail.Count -gt 0) { [string]$tail[-1] } else { '' }
      if ($line -and $line -ne $st.LastLine) {
        $st.LastLine = $line
        $stage = Get-StageText $line
        if ($stage) { $st.Status.Text = $stage }
        $st.Detail.Text = if ($line.Length -gt 110) { $line.Substring(0, 107) + '...' } else { $line }
      }
    }

    $span = (Get-Date) - $st.StartedAt
    $st.Elapsed.Text = 'Downloads may take several minutes - elapsed {0:mm\:ss}' -f $span

    if ($null -ne $st.Proc -and $st.Proc.HasExited) {
      Complete-Install
    }
  } catch {
    try {
      if ($null -ne $script:st.Timer) { $script:st.Timer.Stop() }
      $script:st.Completed = $true
      $script:st.ExitCode = 1
      $script:st.Title.Text = 'Installer UI error'
      $script:st.Status.Text = 'Run install.bat again, or use tools\install\install.ps1 directly.'
      $script:st.Detail.Text = $_.Exception.Message
      $script:st.Bar.Style = 'Continuous'
      $script:st.Bar.Value = 0
    } catch {
      # Never rethrow from a handler.
    }
  }
})

$script:st.Form.Add_Shown({
  $ErrorActionPreference = 'Continue'
  try {
    if (-not $script:st.Proc.Start()) { throw 'Could not start the installer process.' }
    $script:st.Timer.Start()
  } catch {
    $script:st.Completed = $true
    $script:st.ExitCode = 1
    $script:st.Title.Text = 'Could not start installation'
    $script:st.Status.Text = $_.Exception.Message
    $script:st.Bar.Style = 'Continuous'
    $script:st.Bar.Value = 0
  }
})

$script:st.Form.Add_FormClosing({
  param($eventSender, $formClosingArgs)
  $ErrorActionPreference = 'Continue'
  try {
    $st = $script:st
    if ($st.Completed -or $null -eq $st.Proc -or $st.Proc.HasExited) { return }

    $answer = [System.Windows.Forms.MessageBox]::Show(
      'Installation is still running. Cancel it?',
      'Cancel MY Agent installation',
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
      if ($null -ne $formClosingArgs) { $formClosingArgs.Cancel = $true }
      return
    }
    # Kill the tree: powershell -> bootstrap scripts -> curl/npm children.
    & taskkill /PID $st.Proc.Id /T /F 2>$null | Out-Null
    $st.ExitCode = 1
  } catch {
    # Closing anyway.
  }
})

[void]$script:st.Form.ShowDialog()

if ($null -ne $script:st.Timer) { $script:st.Timer.Dispose() }
if ($null -ne $script:st.CloseTimer) { $script:st.CloseTimer.Dispose() }
if ($null -ne $script:st.Proc) { $script:st.Proc.Dispose() }
# Keep failure logs for diagnosis; only delete on success.
if ($script:st.ExitCode -eq 0 -and (Test-Path -LiteralPath $script:st.LogPath)) {
  Remove-Item -LiteralPath $script:st.LogPath -Force -ErrorAction SilentlyContinue
} elseif ($script:st.ExitCode -ne 0 -and (Test-Path -LiteralPath $script:st.LogPath)) {
  $keep = Join-Path $env:TEMP 'cqr-install-last-failure.log'
  Copy-Item -LiteralPath $script:st.LogPath -Destination $keep -Force -ErrorAction SilentlyContinue
}
exit $script:st.ExitCode
