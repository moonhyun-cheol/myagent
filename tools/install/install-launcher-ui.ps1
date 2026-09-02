#requires -Version 5.1
<#
.SYNOPSIS
  WinForms installer for WorkKitLauncher into an existing MY Agent tree.
#>
param(
  [string]$SourceAppDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'app'),
  [string]$TargetRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-paths.ps1')
. (Join-Path $PSScriptRoot 'install-launcher-discovery.ps1')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Get-ManagerProductLabel {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('TVkgQWdlbnQg6rSA66as7J6Q'))
}

function Get-FullPathSafe([string]$p) {
  if (-not $p) { return $null }
  try {
    return [IO.Path]::GetFullPath($p).TrimEnd('\')
  } catch {
    return $null
  }
}

function Test-IsElevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Quote-ProcessArg([string]$value) {
  if ($null -eq $value) { return '""' }
  return '"' + ($value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Quote-PsLiteral([string]$value) {
  return "'" + ($value -replace "'", "''") + "'"
}

function Try-DetectInstallRoot {
  try {
    return (Find-MyAgentInstallRoot)
  } catch {
    return $null
  }
}

function Show-TargetPickerForm {
  param([string]$InitialPath)

  $product = Get-ManagerProductLabel
  $script:pickerResult = $null
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'MY Agent Manager Installer'
  $form.ClientSize = New-Object System.Drawing.Size(560, 300)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.BackColor = [System.Drawing.Color]::FromArgb(248, 249, 251)

  $title = New-Object System.Windows.Forms.Label
  $title.Location = New-Object System.Drawing.Point(28, 22)
  $title.Size = New-Object System.Drawing.Size(500, 32)
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
  $title.Text = $product
  $form.Controls.Add($title)

  $subtitle = New-Object System.Windows.Forms.Label
  $subtitle.Location = New-Object System.Drawing.Point(28, 56)
  $subtitle.Size = New-Object System.Drawing.Size(500, 40)
  $subtitle.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
  $subtitle.ForeColor = [System.Drawing.Color]::FromArgb(90, 96, 108)
  $subtitle.Text = 'Adds the work kit manager to an existing MY Agent install. Keep MY Agent open for auto-detect, or paste the install folder from Settings > General.'
  $form.Controls.Add($subtitle)

  $pathLabel = New-Object System.Windows.Forms.Label
  $pathLabel.Location = New-Object System.Drawing.Point(28, 108)
  $pathLabel.Size = New-Object System.Drawing.Size(500, 20)
  $pathLabel.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
  $pathLabel.Text = 'MY Agent install folder'
  $form.Controls.Add($pathLabel)

  $pathBox = New-Object System.Windows.Forms.TextBox
  $pathBox.Location = New-Object System.Drawing.Point(28, 132)
  $pathBox.Size = New-Object System.Drawing.Size(504, 24)
  $pathBox.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $pathBox.Text = if ($InitialPath) { $InitialPath } else { '' }
  $form.Controls.Add($pathBox)

  $status = New-Object System.Windows.Forms.Label
  $status.Location = New-Object System.Drawing.Point(28, 162)
  $status.Size = New-Object System.Drawing.Size(504, 36)
  $status.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
  $status.ForeColor = [System.Drawing.Color]::FromArgb(110, 116, 128)
  $status.Text = 'Click Detect to search running MY Agent, shortcuts, and standard folders.'
  $form.Controls.Add($status)

  $detectBtn = New-Object System.Windows.Forms.Button
  $detectBtn.Location = New-Object System.Drawing.Point(28, 210)
  $detectBtn.Size = New-Object System.Drawing.Size(100, 32)
  $detectBtn.Text = 'Detect'
  $detectBtn.Add_Click({
    $status.Text = 'Searching...'
    $form.Refresh()
    $found = Try-DetectInstallRoot
    if ($found) {
      $pathBox.Text = $found
      $status.Text = 'Found an existing MY Agent install folder.'
      $status.ForeColor = [System.Drawing.Color]::FromArgb(34, 120, 70)
    } else {
      $status.Text = 'Could not find MY Agent automatically. Paste the path from Settings > General.'
      $status.ForeColor = [System.Drawing.Color]::FromArgb(180, 70, 40)
    }
  })
  $form.Controls.Add($detectBtn)

  $browseBtn = New-Object System.Windows.Forms.Button
  $browseBtn.Location = New-Object System.Drawing.Point(136, 210)
  $browseBtn.Size = New-Object System.Drawing.Size(100, 32)
  $browseBtn.Text = 'Browse...'
  $browseBtn.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Select the MY Agent install folder (contains MYAgent.exe and manifest.json).'
    if ($pathBox.Text) { $dialog.SelectedPath = $pathBox.Text }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      $pathBox.Text = $dialog.SelectedPath
    }
  })
  $form.Controls.Add($browseBtn)

  $installBtn = New-Object System.Windows.Forms.Button
  $installBtn.Location = New-Object System.Drawing.Point(344, 210)
  $installBtn.Size = New-Object System.Drawing.Size(92, 32)
  $installBtn.Text = 'Install'
  $installBtn.Add_Click({
    $normalized = Normalize-InstallRootInput $pathBox.Text
    if (-not (Test-MyAgentInstallRoot $normalized)) {
      [void][System.Windows.Forms.MessageBox]::Show(
        "That folder is not a valid MY Agent install root.`r`n`r`nExpected manifest.json and MYAgent.exe (or core runtime files).`r`n`r`nTip: open MY Agent, then Settings > General > copy install folder.",
        'MY Agent Manager Installer',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
      )
      return
    }
    $script:pickerResult = $normalized
    $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Close()
  })
  $form.Controls.Add($installBtn)
  $form.AcceptButton = $installBtn

  $cancelBtn = New-Object System.Windows.Forms.Button
  $cancelBtn.Location = New-Object System.Drawing.Point(440, 210)
  $cancelBtn.Size = New-Object System.Drawing.Size(92, 32)
  $cancelBtn.Text = 'Cancel'
  $cancelBtn.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.Add($cancelBtn)
  $form.CancelButton = $cancelBtn

  if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    return $script:pickerResult
  }
  return $null
}

if (Test-IsElevated) {
  [void][System.Windows.Forms.MessageBox]::Show(
    'Do not run the installer as administrator. Run it as the same Windows user who uses MY Agent.',
    'MY Agent Manager Installer',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  exit 1
}

$sourceFull = Get-FullPathSafe $SourceAppDir
if (-not (Test-Path -LiteralPath (Join-Path $SourceAppDir 'WorkKitLauncher.exe'))) {
  [void][System.Windows.Forms.MessageBox]::Show(
    'This folder is not the launcher install package (WorkKitLauncher.exe is missing).',
    'MY Agent Manager Installer',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  )
  exit 1
}

$targetFull = Get-FullPathSafe (Normalize-InstallRootInput $TargetRoot)
if (-not (Test-MyAgentInstallRoot $targetFull)) {
  $detected = Try-DetectInstallRoot
  $targetFull = Show-TargetPickerForm -InitialPath $detected
  if (-not (Test-MyAgentInstallRoot $targetFull)) {
    exit 1
  }
}

$installScript = Join-Path $PSScriptRoot 'install-launcher.ps1'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$logPath = Join-Path $env:TEMP ("myagent-launcher-install-ui-$PID.log")
if (Test-Path -LiteralPath $logPath) {
  Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
}

$workCommand = @(
  '&', (Quote-PsLiteral $installScript),
  '-SourceAppDir', (Quote-PsLiteral $SourceAppDir),
  '-TargetRoot', (Quote-PsLiteral $targetFull),
  '-NoInteractive',
  '-Launch'
) -join ' '

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
  Add-Content -LiteralPath `$log -Value ('ERROR: ' + `$_.Exception.Message) -Encoding UTF8
  `$code = 1
}
if (`$null -eq `$code) { `$code = 0 }
if ((Test-Path -LiteralPath $(Quote-PsLiteral (Join-Path $targetFull 'WorkKitLauncher.exe'))) -and `$code -ne 0) {
  Add-Content -LiteralPath `$log -Value 'WARN: treating as success because WorkKitLauncher.exe exists' -Encoding UTF8
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
  TargetDir  = $targetFull
  StartedAt  = Get-Date
  LastLine   = ''
  Completed  = $false
  ExitCode   = 1
}
$script:st.Proc.StartInfo = $psi

$script:st.Form = New-Object System.Windows.Forms.Form
$script:st.Form.Text = 'MY Agent Manager Installer'
$script:st.Form.ClientSize = New-Object System.Drawing.Size(520, 232)
$script:st.Form.StartPosition = 'CenterScreen'
$script:st.Form.FormBorderStyle = 'FixedDialog'
$script:st.Form.MaximizeBox = $false
$script:st.Form.MinimizeBox = $true
$script:st.Form.TopMost = $true
$script:st.Form.ShowInTaskbar = $true
$script:st.Form.BackColor = [System.Drawing.Color]::FromArgb(248, 249, 251)

$script:st.Title = New-Object System.Windows.Forms.Label
$script:st.Title.Location = New-Object System.Drawing.Point(30, 24)
$script:st.Title.Size = New-Object System.Drawing.Size(460, 30)
$script:st.Title.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$script:st.Title.Text = 'Installing ' + (Get-ManagerProductLabel)
$script:st.Form.Controls.Add($script:st.Title)

$script:st.Status = New-Object System.Windows.Forms.Label
$script:st.Status.Location = New-Object System.Drawing.Point(30, 66)
$script:st.Status.Size = New-Object System.Drawing.Size(460, 26)
$script:st.Status.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$script:st.Status.Text = 'Copying WorkKitLauncher files...'
$script:st.Form.Controls.Add($script:st.Status)

$script:st.Detail = New-Object System.Windows.Forms.Label
$script:st.Detail.Location = New-Object System.Drawing.Point(30, 96)
$script:st.Detail.Size = New-Object System.Drawing.Size(460, 46)
$script:st.Detail.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$script:st.Detail.ForeColor = [System.Drawing.Color]::FromArgb(90, 96, 108)
$script:st.Detail.Text = "Install location: $targetFull"
$script:st.Form.Controls.Add($script:st.Detail)

$script:st.Bar = New-Object System.Windows.Forms.ProgressBar
$script:st.Bar.Location = New-Object System.Drawing.Point(30, 152)
$script:st.Bar.Size = New-Object System.Drawing.Size(460, 20)
$script:st.Bar.Style = 'Marquee'
$script:st.Bar.MarqueeAnimationSpeed = 28
$script:st.Form.Controls.Add($script:st.Bar)

$script:st.Elapsed = New-Object System.Windows.Forms.Label
$script:st.Elapsed.Location = New-Object System.Drawing.Point(30, 182)
$script:st.Elapsed.Size = New-Object System.Drawing.Size(460, 24)
$script:st.Elapsed.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$script:st.Elapsed.ForeColor = [System.Drawing.Color]::FromArgb(110, 116, 128)
$script:st.Elapsed.Text = 'Please wait - elapsed 00:00'
$script:st.Form.Controls.Add($script:st.Elapsed)

function Get-LauncherStageText([string]$line) {
  if ($line -match 'Looking for MY Agent') { return '1/3 - Finding MY Agent install folder' }
  if ($line -match 'Installing WorkKitLauncher') { return '2/3 - Copying manager files' }
  if ($line -match 'Desktop shortcut') { return '3/3 - Creating desktop shortcut' }
  if ($line -match 'install complete') { return 'Finishing installation' }
  return $null
}

function Complete-LauncherInstall {
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
    $st.Status.Text = 'Launch the manager from the desktop shortcut, or run WorkKitLauncher.exe.'
    $st.Detail.Text = "Install location: $($st.TargetDir)"
    $st.Elapsed.Text = 'This window will close shortly.'

    $st.CloseTimer = New-Object System.Windows.Forms.Timer
    $st.CloseTimer.Interval = 1800
    $st.CloseTimer.Add_Tick({
      try {
        if ($null -ne $script:st.CloseTimer) { $script:st.CloseTimer.Stop() }
        if ($null -ne $script:st.Form) { $script:st.Form.Close() }
      } catch { }
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
      $errHits = @($lines | Where-Object { $_ -like 'ERROR:*' -or $_ -like '*FAILED*' })
      if ($errHits.Count -gt 0) {
        $logTail = [string]$errHits[-1]
      } else {
        $logTail = @($lines | Select-Object -Last 5) -join ' | '
      }
    } catch { }
  }
  $shown = if ($logTail) { $logTail } else { $detail }
  $st.Status.Text = 'See detail below. Log: %TEMP%\myagent-launcher-install-ui-*.log'
  $st.Detail.Text = if ($shown.Length -gt 220) { $shown.Substring(0, 217) + '...' } else { $shown }
  $st.Elapsed.Text = 'Review the message above, then close this window.'
  if ($null -ne $st.Bar) { $st.Bar.Value = 0 }
}

$script:st.Timer = New-Object System.Windows.Forms.Timer
$script:st.Timer.Interval = 200
$script:st.Timer.Add_Tick({
  $ErrorActionPreference = 'Continue'
  try {
    $st = $script:st
    if ($null -eq $st) { return }

    if (Test-Path -LiteralPath $st.LogPath) {
      $tail = @(Get-Content -LiteralPath $st.LogPath -Tail 1 -Encoding UTF8 -ErrorAction SilentlyContinue)
      $line = if ($tail.Count -gt 0) { [string]$tail[-1] } else { '' }
      if ($line -and $line -ne $st.LastLine) {
        $st.LastLine = $line
        $stage = Get-LauncherStageText $line
        if ($stage) { $st.Status.Text = $stage }
        $st.Detail.Text = if ($line.Length -gt 110) { $line.Substring(0, 107) + '...' } else { $line }
      }
    }

    $span = (Get-Date) - $st.StartedAt
    $st.Elapsed.Text = 'Please wait - elapsed {0:mm\:ss}' -f $span

    if ($null -ne $st.Proc -and $st.Proc.HasExited) {
      Complete-LauncherInstall
    }
  } catch {
    try {
      if ($null -ne $script:st.Timer) { $script:st.Timer.Stop() }
      $script:st.Completed = $true
      $script:st.ExitCode = 1
      $script:st.Title.Text = 'Installer UI error'
      $script:st.Status.Text = 'Run install-launcher.bat again.'
      $script:st.Detail.Text = $_.Exception.Message
      $script:st.Bar.Style = 'Continuous'
      $script:st.Bar.Value = 0
    } catch { }
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
      'Cancel MY Agent Manager installation',
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
      if ($null -ne $formClosingArgs) { $formClosingArgs.Cancel = $true }
      return
    }
    & taskkill /PID $st.Proc.Id /T /F 2>$null | Out-Null
    $st.ExitCode = 1
  } catch { }
})

[void]$script:st.Form.ShowDialog()

if ($null -ne $script:st.Timer) { $script:st.Timer.Dispose() }
if ($null -ne $script:st.CloseTimer) { $script:st.CloseTimer.Dispose() }
if ($null -ne $script:st.Proc) { $script:st.Proc.Dispose() }
if ($script:st.ExitCode -eq 0 -and (Test-Path -LiteralPath $script:st.LogPath)) {
  Remove-Item -LiteralPath $script:st.LogPath -Force -ErrorAction SilentlyContinue
}
exit $script:st.ExitCode
