#requires -Version 5.1
<#
.SYNOPSIS
  WinForms installer for WorkKitLauncher into an existing MY Agent tree.
  Korean UI strings are UTF-8 base64 to avoid PS 5.1 source encoding issues.
#>
param(
  [string]$SourceAppDir = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'app'),
  [string]$TargetRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-paths.ps1')
. (Join-Path $PSScriptRoot 'install-launcher-discovery.ps1')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Get-UiUtf8([string]$b64) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}

function Get-LauncherUiText([string]$key) {
  $table = @{
    WindowTitle          = 'TVkgQWdlbnQg6rSA66as7J6QIOyEpOy5mA=='
    Subtitle             = '6riw7KG0IE1ZIEFnZW50IOyEpOy5mOyXkCDsnpHsl4Ug7YKk7Yq4IOq0gOumrOyekOulvCDstpTqsIDtlanri4jri6QuIE1ZIEFnZW5066W8IOy8nCDrkZgg7LGE66GcIOywvuq4sOulvCDsgqzsmqntlZjqsbDrgpgsIOyEpOyglSA+IOydvOuwmOyXkOyEnCDshKTsuZgg7Y+0642UIOqyveuhnOulvCDrtpnsl6zrhKPsnLzshLjsmpQu'
    PathLabel            = 'TVkgQWdlbnQg7ISk7LmYIO2PtOuNlA=='
    StatusInitial        = '7LC+6riw66W8IOuIjOufrCDsi6Ttlokg7KSR7J24IE1ZIEFnZW50LCDrsJTroZzqsIDquLAsIOydvOuwmCDtj7TrjZTrpbwg6rKA7IOJ7ZWp64uI64ukLg=='
    Detect               = '7LC+6riw'
    Searching            = '6rKA7IOJIOykkS4uLg=='
    Found                = 'TVkgQWdlbnQg7ISk7LmYIO2PtOuNlOulvCDssL7slZjsirXri4jri6Qu'
    NotFound             = 'TVkgQWdlbnTrpbwg7J6Q64+Z7Jy866GcIOywvuyngCDrqrvtlojsirXri4jri6QuIOyEpOyglSA+IOydvOuwmOyXkOyEnCDqsr3roZzrpbwg67aZ7Jes64Sj7Jy87IS47JqULg=='
    Browse               = '7LC+7JWE67O06riwLi4u'
    BrowseDesc           = 'TVkgQWdlbnQg7ISk7LmYIO2PtOuNlOulvCDshKDtg53tlZjshLjsmpQgKE1ZQWdlbnQuZXhl7JmAIG1hbmlmZXN0Lmpzb24g7Y+s7ZWpKS4='
    Install              = '7ISk7LmY'
    Cancel               = '7Leo7IaM'
    InvalidFolderMsg     = '7ISg7YOd7ZWcIO2PtOuNlOqwgCDsnKDtmqjtlZwgTVkgQWdlbnQg7ISk7LmYIOqyveuhnOqwgCDslYTri5nri4jri6QuDQoNCm1hbmlmZXN0Lmpzb27qs7wgTVlBZ2VudC5leGUo65iQ64qUIOy9lOyWtCDrn7Dtg4DsnoQp6rCAIO2VhOyalO2VqeuLiOuLpC4NCg0K7YyBOiBNWSBBZ2VudOulvCDsl7Ag65KkIOyEpOyglSA+IOydvOuwmOyXkOyEnCDshKTsuZgg7Y+0642U66W8IOuzteyCrO2VmOyEuOyalC4='
    ElevatedWarning      = '6rSA66as7J6QIOq2jO2VnOycvOuhnCDsi6TtlontlZjsp4Ag66eI7IS47JqULiBNWSBBZ2VudOulvCDsgqzsmqntlZjripQg6rCZ7J2AIFdpbmRvd3Mg7IKs7Jqp7J6Q66GcIOyLpO2Wie2VmOyEuOyalC4='
    MissingPackage       = '7J20IO2PtOuNlOuKlCDqtIDrpqzsnpAg7ISk7LmYIO2MqO2CpOyngOqwgCDslYTri5nri4jri6QgKFdvcmtLaXRMYXVuY2hlci5leGUg7JeG7J2MKS4='
    InstallingTitle      = '7ISk7LmYIOykkQ=='
    CopyingStatus        = '6rSA66as7J6QIO2MjOydvOydhCDrs7XsgqztlZjripQg7KSRLi4u'
    InstallLocationPrefix = '7ISk7LmYIOychOy5mDo='
    PleaseWaitPrefix     = '7J6g7Iuc66eMIOq4sOuLpOugpCDso7zshLjsmpQgLSDqsr3qs7w='
    Stage1               = 'MS8zIC0gTVkgQWdlbnQg7ISk7LmYIO2PtOuNlCDtmZXsnbg='
    Stage2               = 'Mi8zIC0g6rSA66as7J6QIO2MjOydvCDrs7Xsgqw='
    Stage3               = 'My8zIC0g67CU7YOB7ZmU66m0IOuwlOuhnOqwgOq4sCDrp4zrk6TquLA='
    StageFinish          = '7ISk7LmYIOuniOustOumrCDspJE='
    CompleteTitle        = '7ISk7LmYIOyZhOujjA=='
    CompleteStatus       = '67CU7YOB7ZmU66m0IOuwlOuhnOqwgOq4sCDrmJDripQgV29ya0tpdExhdW5jaGVyLmV4ZeuhnCDsi6TtlontlZjshLjsmpQu'
    CloseSoon            = '7J6g7IucIO2bhCDsnbQg7LC97J20IOuLq+2emeuLiOuLpC4='
    FailedTitle          = '7ISk7LmY6rCAIOyZhOujjOuQmOyngCDslYrslZjsirXri4jri6Q='
    FailedStatus         = '7JWE656YIOuCtOyaqeydhCDtmZXsnbjtlZjshLjsmpQuIOuhnOq3uDogJVRFTVAlXG15YWdlbnQtbGF1bmNoZXItaW5zdGFsbC11aS0qLmxvZw=='
    ReviewClose          = '7JyEIOuplOyLnOyngOulvCDtmZXsnbjtlZwg65KkIOydtCDssL3snYQg64ur7Jy87IS47JqULg=='
    UiErrorTitle         = '7ISk7LmYIFVJIOyYpOulmA=='
    UiErrorStatus        = 'aW5zdGFsbC1sYXVuY2hlci5iYXTsnYQg64uk7IucIOyLpO2Wie2VmOyEuOyalC4='
    StartFailedTitle     = '7ISk7LmY66W8IOyLnOyeke2VoCDsiJgg7JeG7Iq164uI64uk'
    CancelPrompt         = '7ISk7LmY6rCAIOynhO2WiSDspJHsnoXri4jri6QuIOy3qOyGjO2VmOyLnOqyoOyKteuLiOq5jD8='
    CancelTitle          = 'TVkgQWdlbnQg6rSA66as7J6QIOyEpOy5mCDst6jshow='
    ExitCodePrefix       = '7KKF66OMIOy9lOuTnDo='
    LogLooking           = 'TVkgQWdlbnQg7ISk7LmYIO2PtOuNlOulvCDssL7ripQg7KSRLi4u'
    LogFoundApi          = 'TVkgQWdlbnQgQVBJ66GcIOyEpOy5mCDtj7TrjZTrpbwg7LC+7JWY7Iq164uI64uk'
    LogInstalling        = '7ISk7LmYIOychOy5mA=='
    LogMissingExe        = '7ISk7LmYIO2bhCBXb3JrS2l0TGF1bmNoZXIuZXhl66W8IOywvuydhCDsiJgg7JeG7Iq164uI64uk'
    LogShortcut          = '67CU7YOB7ZmU66m0IOuwlOuhnOqwgOq4sA=='
    LogComplete          = '7ISk7LmYIOyZhOujjA=='
    LogSourceMissing     = '7ISk7LmYIO2MqO2CpOyngOyXkCBXb3JrS2l0TGF1bmNoZXIuZXhl6rCAIOyXhuyKteuLiOuLpA=='
    LogShortcutFailed    = '67CU66Gc6rCA6riwIOyDneyEsSDsi6TtjKg='
    LogNotFound          = 'TVkgQWdlbnQg7ISk7LmY66W8IOywvuyngCDrqrvtlojsirXri4jri6Q='
  }
  if (-not $table.ContainsKey($key)) { return $key }
  return Get-UiUtf8 $table[$key]
}

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

function Format-LauncherLogLineForUi([string]$line) {
  if (-not $line) { return '' }
  if ($line -match 'Looking for MY Agent') { return (Get-LauncherUiText 'LogLooking') }
  if ($line -match 'Found install folder via running MY Agent API:\s*(.+)') {
    return (Get-LauncherUiText 'LogFoundApi') + ': ' + $Matches[1]
  }
  if ($line -match 'Installing WorkKitLauncher into:\s*(.+)') {
    return (Get-LauncherUiText 'LogInstalling') + ': ' + $Matches[1]
  }
  if ($line -match 'Install finished but WorkKitLauncher\.exe is missing:\s*(.+)') {
    return (Get-LauncherUiText 'LogMissingExe') + ': ' + $Matches[1]
  }
  if ($line -match 'Source app folder is missing WorkKitLauncher\.exe') {
    return (Get-LauncherUiText 'LogSourceMissing')
  }
  if ($line -match 'Desktop shortcut FAILED') {
    return (Get-LauncherUiText 'LogShortcutFailed') + ': ' + $line
  }
  if ($line -match 'Desktop shortcut') { return (Get-LauncherUiText 'LogShortcut') + ': ' + $line }
  if ($line -match 'install complete') { return (Get-LauncherUiText 'LogComplete') }
  if ($line -match 'Could not find an existing MY Agent') { return (Get-LauncherUiText 'LogNotFound') }
  return $line
}

function Show-TargetPickerForm {
  param([string]$InitialPath)

  $product = Get-ManagerProductLabel
  $script:pickerResult = $null
  $form = New-Object System.Windows.Forms.Form
  $form.Text = (Get-LauncherUiText 'WindowTitle')
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
  $subtitle.Text = (Get-LauncherUiText 'Subtitle')
  $form.Controls.Add($subtitle)

  $pathLabel = New-Object System.Windows.Forms.Label
  $pathLabel.Location = New-Object System.Drawing.Point(28, 108)
  $pathLabel.Size = New-Object System.Drawing.Size(500, 20)
  $pathLabel.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
  $pathLabel.Text = (Get-LauncherUiText 'PathLabel')
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
  $status.Text = (Get-LauncherUiText 'StatusInitial')
  $form.Controls.Add($status)

  $detectBtn = New-Object System.Windows.Forms.Button
  $detectBtn.Location = New-Object System.Drawing.Point(28, 210)
  $detectBtn.Size = New-Object System.Drawing.Size(100, 32)
  $detectBtn.Text = (Get-LauncherUiText 'Detect')
  $detectBtn.Add_Click({
    $status.Text = (Get-LauncherUiText 'Searching')
    $form.Refresh()
    $found = Try-DetectInstallRoot
    if ($found) {
      $pathBox.Text = $found
      $status.Text = (Get-LauncherUiText 'Found')
      $status.ForeColor = [System.Drawing.Color]::FromArgb(34, 120, 70)
    } else {
      $status.Text = (Get-LauncherUiText 'NotFound')
      $status.ForeColor = [System.Drawing.Color]::FromArgb(180, 70, 40)
    }
  })
  $form.Controls.Add($detectBtn)

  $browseBtn = New-Object System.Windows.Forms.Button
  $browseBtn.Location = New-Object System.Drawing.Point(136, 210)
  $browseBtn.Size = New-Object System.Drawing.Size(100, 32)
  $browseBtn.Text = (Get-LauncherUiText 'Browse')
  $browseBtn.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = (Get-LauncherUiText 'BrowseDesc')
    if ($pathBox.Text) { $dialog.SelectedPath = $pathBox.Text }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      $pathBox.Text = $dialog.SelectedPath
    }
  })
  $form.Controls.Add($browseBtn)

  $installBtn = New-Object System.Windows.Forms.Button
  $installBtn.Location = New-Object System.Drawing.Point(344, 210)
  $installBtn.Size = New-Object System.Drawing.Size(92, 32)
  $installBtn.Text = (Get-LauncherUiText 'Install')
  $installBtn.Add_Click({
    $normalized = Normalize-InstallRootInput $pathBox.Text
    if (-not (Test-MyAgentInstallRoot $normalized)) {
      [void][System.Windows.Forms.MessageBox]::Show(
        (Get-LauncherUiText 'InvalidFolderMsg'),
        (Get-LauncherUiText 'WindowTitle'),
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
  $cancelBtn.Text = (Get-LauncherUiText 'Cancel')
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
    (Get-LauncherUiText 'ElevatedWarning'),
    (Get-LauncherUiText 'WindowTitle'),
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  exit 1
}

$sourceFull = Get-FullPathSafe $SourceAppDir
if (-not (Test-Path -LiteralPath (Join-Path $SourceAppDir 'WorkKitLauncher.exe'))) {
  [void][System.Windows.Forms.MessageBox]::Show(
    (Get-LauncherUiText 'MissingPackage'),
    (Get-LauncherUiText 'WindowTitle'),
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
$script:st.Form.Text = (Get-LauncherUiText 'WindowTitle')
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
$script:st.Title.Text = (Get-LauncherUiText 'InstallingTitle') + ' - ' + (Get-ManagerProductLabel)
$script:st.Form.Controls.Add($script:st.Title)

$script:st.Status = New-Object System.Windows.Forms.Label
$script:st.Status.Location = New-Object System.Drawing.Point(30, 66)
$script:st.Status.Size = New-Object System.Drawing.Size(460, 26)
$script:st.Status.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$script:st.Status.Text = (Get-LauncherUiText 'CopyingStatus')
$script:st.Form.Controls.Add($script:st.Status)

$script:st.Detail = New-Object System.Windows.Forms.Label
$script:st.Detail.Location = New-Object System.Drawing.Point(30, 96)
$script:st.Detail.Size = New-Object System.Drawing.Size(460, 46)
$script:st.Detail.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$script:st.Detail.ForeColor = [System.Drawing.Color]::FromArgb(90, 96, 108)
$script:st.Detail.Text = (Get-LauncherUiText 'InstallLocationPrefix') + " $targetFull"
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
$script:st.Elapsed.Text = (Get-LauncherUiText 'PleaseWaitPrefix') + ' 00:00'
$script:st.Form.Controls.Add($script:st.Elapsed)

function Get-LauncherStageText([string]$line) {
  if ($line -match 'Looking for MY Agent') { return (Get-LauncherUiText 'Stage1') }
  if ($line -match 'Installing WorkKitLauncher') { return (Get-LauncherUiText 'Stage2') }
  if ($line -match 'Desktop shortcut') { return (Get-LauncherUiText 'Stage3') }
  if ($line -match 'install complete') { return (Get-LauncherUiText 'StageFinish') }
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
    $st.Title.Text = (Get-LauncherUiText 'CompleteTitle')
    $st.Status.Text = (Get-LauncherUiText 'CompleteStatus')
    $st.Detail.Text = (Get-LauncherUiText 'InstallLocationPrefix') + " $($st.TargetDir)"
    $st.Elapsed.Text = (Get-LauncherUiText 'CloseSoon')

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

  $st.Title.Text = (Get-LauncherUiText 'FailedTitle')
  $detail = if ($st.LastLine) { Format-LauncherLogLineForUi $st.LastLine } else {
    (Get-LauncherUiText 'ExitCodePrefix') + " $($st.ExitCode)"
  }
  $logTail = ''
  if (Test-Path -LiteralPath $st.LogPath) {
    try {
      $lines = @(Get-Content -LiteralPath $st.LogPath -Encoding UTF8 -ErrorAction SilentlyContinue)
      $errHits = @($lines | Where-Object { $_ -like 'ERROR:*' -or $_ -like '*FAILED*' -or $_ -like '*missing*' })
      if ($errHits.Count -gt 0) {
        $logTail = Format-LauncherLogLineForUi ([string]$errHits[-1])
      } else {
        $logTail = @($lines | ForEach-Object { Format-LauncherLogLineForUi $_ } | Select-Object -Last 3) -join ' | '
      }
    } catch { }
  }
  $shown = if ($logTail) { $logTail } else { $detail }
  $st.Status.Text = (Get-LauncherUiText 'FailedStatus')
  $st.Detail.Text = if ($shown.Length -gt 220) { $shown.Substring(0, 217) + '...' } else { $shown }
  $st.Elapsed.Text = (Get-LauncherUiText 'ReviewClose')
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
        $friendly = Format-LauncherLogLineForUi $line
        $st.Detail.Text = if ($friendly.Length -gt 110) { $friendly.Substring(0, 107) + '...' } else { $friendly }
      }
    }

    $span = (Get-Date) - $st.StartedAt
    $st.Elapsed.Text = (Get-LauncherUiText 'PleaseWaitPrefix') + (' {0:mm\:ss}' -f $span)

    if ($null -ne $st.Proc -and $st.Proc.HasExited) {
      Complete-LauncherInstall
    }
  } catch {
    try {
      if ($null -ne $script:st.Timer) { $script:st.Timer.Stop() }
      $script:st.Completed = $true
      $script:st.ExitCode = 1
      $script:st.Title.Text = (Get-LauncherUiText 'UiErrorTitle')
      $script:st.Status.Text = (Get-LauncherUiText 'UiErrorStatus')
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
    $script:st.Title.Text = (Get-LauncherUiText 'StartFailedTitle')
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
      (Get-LauncherUiText 'CancelPrompt'),
      (Get-LauncherUiText 'CancelTitle'),
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
