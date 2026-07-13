param(
  [int]$PollSeconds = 10
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$RunScript = Join-Path $Root "scripts\windows_run_server.ps1"
$IconCandidates = @(
  (Join-Path $Root "apps\extension\icons\variants\monitor-v1-mono-128.png"),
  (Join-Path $Root "apps\extension\icons\variants\monitor-v1-mono-48.png"),
  (Join-Path $Root "apps\extension\icons\variants\monitor-v1-mono-32.png"),
  (Join-Path $Root "apps\extension\dist\icons\variants\monitor-v1-mono-128.png"),
  (Join-Path $Root "apps\extension\dist\icons\variants\monitor-v1-mono-48.png"),
  (Join-Path $Root "apps\extension\dist\icons\variants\monitor-v1-mono-32.png")
)
$HealthUrl = "http://127.0.0.1:8765/health"
$LogDir = Join-Path $Root "data\logs"
$TrayLog = Join-Path $LogDir "windows-startup-tray.log"
$TrayPidFile = Join-Path $LogDir "windows-startup-tray.pid"
$StartupErrLog = Join-Path $LogDir "windows-startup-app.err.log"
$ServerControlFile = Join-Path $LogDir "windows-server-control.json"
$ServerStopRequestFile = Join-Path $LogDir "windows-server-stop-request.json"
$ServerHostScript = Join-Path $Root "scripts\windows_server_host.py"
$ServerPython = Join-Path $Root ".venv\Scripts\python.exe"
$ServerProcessPython = $ServerPython
$VenvConfig = Join-Path $Root ".venv\pyvenv.cfg"
if (Test-Path $VenvConfig) {
  try {
    $ExecutableLine = Get-Content -LiteralPath $VenvConfig -Encoding UTF8 | Where-Object { $_ -match '^executable\s*=' } | Select-Object -First 1
    if ($ExecutableLine) {
      $ConfiguredExecutable = ($ExecutableLine -split '=', 2)[1].Trim()
      if (Test-Path $ConfiguredExecutable) {
        $ServerProcessPython = $ConfiguredExecutable
      }
    }
  }
  catch {
    $ServerProcessPython = $ServerPython
  }
}
$DefaultTimerInterval = [Math]::Max(1, $PollSeconds) * 1000
$TransitionTimerInterval = 1000
$HealthRequestCheckInterval = 100
$HealthRequestTimeoutSeconds = 2
$StartupTimeoutSeconds = 30
$GracefulStopTimeoutSeconds = 15
$ForcedStopTimeoutSeconds = 5
$Script:StartingUntil = $null
$Script:StartSource = $null
$Script:StartProcess = $null
$Script:StartStartedAt = $null
$Script:StoppingUntil = $null
$Script:StopSource = $null
$Script:StopStartedAt = $null
$Script:StopControl = $null
$Script:StopForced = $false
$Script:StatusMessageOverride = $null
$Script:RunningStatusMessageOverride = $null
$Script:ServerToggleItem = $null
$Script:Timer = $null
$Script:HealthRequest = $null
$Script:NextHealthPollAt = [DateTime]::MinValue
$Script:LastHealthStatus = $null
$Script:AutoStartPending = $true
$Script:KeepMenuOpenAfterRefresh = $false

New-Item -ItemType Directory -Force $LogDir | Out-Null

function Write-TrayLog {
  param([string]$Message)
  $Timestamp = (Get-Date).ToString("s")
  Add-Content -LiteralPath $TrayLog -Value "$Timestamp $Message"
}

trap {
  Write-TrayLog "error: $($_.Exception.Message)"
  break
}

$CreatedMutex = $false
$Mutex = [System.Threading.Mutex]::new($true, "Local\KibitzerStartupTray", [ref]$CreatedMutex)
if (-not $CreatedMutex) {
  Write-TrayLog "already running; exiting duplicate tray process"
  exit 0
}

Set-Content -LiteralPath $TrayPidFile -Value $PID
Write-TrayLog "tray starting pid=$PID"

function Get-WindowsPowerShell {
  $PowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (Test-Path $PowerShell) {
    return $PowerShell
  }
  return (Get-Command powershell.exe -ErrorAction Stop).Source
}

function New-KibitzerDeadHealthStatus {
  return @{ Mode = "dead"; IconKey = "dead"; Text = "Kibitzer: not running"; Message = "서버가 실행되지 않았습니다. 메뉴에서 'Start server'를 눌러 실행해 주세요." }
}

function ConvertTo-KibitzerHealthStatus {
  param($Health)

  $Mode = if ($Health.mode) { [string]$Health.mode } else { "unknown" }
  if ($Mode -eq "active") {
    return @{ Mode = "active"; IconKey = "active"; Text = "Kibitzer: active"; Message = "서버가 작동 중이며 활동을 관찰하고 있습니다." }
  }
  if ($Mode -eq "idle") {
    return @{ Mode = "idle"; IconKey = "idle"; Text = "Kibitzer: idle"; Message = "서버는 실행 중이며 대기 상태입니다. 활동이 감지되면 자동으로 활성화됩니다." }
  }
  return @{ Mode = $Mode; IconKey = "unknown"; Text = "Kibitzer: $Mode"; Message = "서버 상태를 확인할 수 없습니다 (mode=$Mode). 잠시 후 다시 확인해 주세요." }
}

function Start-KibitzerHealthRequest {
  if ($Script:HealthRequest) {
    return
  }

  try {
    $Script:HealthRequest = $HttpClient.GetStringAsync($HealthUrl)
    if ($Script:Timer) {
      $Script:Timer.Interval = $HealthRequestCheckInterval
    }
    return $null
  }
  catch {
    $Script:HealthRequest = $null
    return New-KibitzerDeadHealthStatus
  }
}

function Receive-KibitzerHealthStatus {
  if (-not $Script:HealthRequest -or -not $Script:HealthRequest.IsCompleted) {
    return $null
  }

  $Request = $Script:HealthRequest
  $Script:HealthRequest = $null
  try {
    $Payload = $Request.GetAwaiter().GetResult()
    $Health = $Payload | ConvertFrom-Json -ErrorAction Stop
    return ConvertTo-KibitzerHealthStatus $Health
  }
  catch {
    return New-KibitzerDeadHealthStatus
  }
}

function Set-KibitzerNextHealthPoll {
  $DelayMilliseconds = if ($Script:StartingUntil -or $Script:StoppingUntil) {
    $TransitionTimerInterval
  }
  else {
    $DefaultTimerInterval
  }
  $Script:NextHealthPollAt = (Get-Date).AddMilliseconds($DelayMilliseconds)
  if ($Script:Timer) {
    $Script:Timer.Interval = $DelayMilliseconds
  }
}

function Queue-KibitzerTrayUpdate {
  $Script:NextHealthPollAt = [DateTime]::MinValue
  if ($Script:Timer) {
    $Script:Timer.Interval = 1
  }
}

function Request-KibitzerTrayUpdate {
  Queue-KibitzerTrayUpdate
  Update-KibitzerTray
}

function Set-KibitzerStartingTray {
  $NotifyIcon.Icon = $TrayIcons.unknown
  $NotifyIcon.Text = "Kibitzer: starting"
  $StatusHeaderItem.Text = "서버를 시작하고 있습니다..."
  if ($Script:ServerToggleItem) {
    $Script:ServerToggleItem.Text = "Start server"
    $Script:ServerToggleItem.Enabled = $false
  }
}

function Clear-KibitzerStartingState {
  $Script:StartingUntil = $null
  $Script:StartSource = $null
  $Script:StartProcess = $null
  $Script:StartStartedAt = $null
}

function Get-KibitzerStartElapsedSeconds {
  if (-not $Script:StartStartedAt) {
    return 0
  }
  return [Math]::Round(((Get-Date) - $Script:StartStartedAt).TotalSeconds, 1)
}

function Set-KibitzerStoppingTray {
  $NotifyIcon.Icon = $TrayIcons.unknown
  $NotifyIcon.Text = "Kibitzer: stopping"
  $StatusHeaderItem.Text = if ($Script:StopForced) { "서버를 강제 종료하고 있습니다..." } else { "서버를 중지하고 있습니다..." }
  if ($Script:ServerToggleItem) {
    $Script:ServerToggleItem.Text = "Stop server"
    $Script:ServerToggleItem.Enabled = $false
  }
}

function Clear-KibitzerStoppingState {
  $Script:StoppingUntil = $null
  $Script:StopSource = $null
  $Script:StopStartedAt = $null
  $Script:StopControl = $null
  $Script:StopForced = $false
}

function Get-KibitzerStopElapsedSeconds {
  if (-not $Script:StopStartedAt) {
    return 0
  }
  return [Math]::Round(((Get-Date) - $Script:StopStartedAt).TotalSeconds, 1)
}

function Write-KibitzerStartupErrTail {
  if (-not (Test-Path $StartupErrLog)) {
    Write-TrayLog "app err tail: missing $StartupErrLog"
    return
  }

  Write-TrayLog "app err tail:"
  try {
    Get-Content -LiteralPath $StartupErrLog -Tail 5 -ErrorAction Stop | ForEach-Object {
      Write-TrayLog "app.err: $_"
    }
  }
  catch {
    Write-TrayLog "app err tail read failed: $($_.Exception.Message)"
  }
}

function Set-KibitzerStartFailure {
  param(
    [string]$Outcome,
    [string]$Message,
    [switch]$IncludeAppLog
  )

  $Source = $Script:StartSource
  $Elapsed = Get-KibitzerStartElapsedSeconds
  $Extra = ""
  if ($Outcome -eq "wrapper-exited" -and $Script:StartProcess) {
    try {
      $Extra = " exit=$($Script:StartProcess.ExitCode)"
    }
    catch {
      $Extra = ""
    }
  }

  Write-TrayLog "start source=$Source outcome=$Outcome$Extra after ${Elapsed}s"
  if ($IncludeAppLog) {
    Write-KibitzerStartupErrTail
  }
  Clear-KibitzerStartingState
  $Script:StatusMessageOverride = $Message
  if ($Script:LastHealthStatus) {
    Set-KibitzerTrayStatus $Script:LastHealthStatus
  }
  Queue-KibitzerTrayUpdate
}

function Test-KibitzerPathEqual {
  param(
    [string]$Left,
    [string]$Right
  )

  try {
    return [System.IO.Path]::GetFullPath($Left) -eq [System.IO.Path]::GetFullPath($Right)
  }
  catch {
    return $false
  }
}

function Test-KibitzerServerControl {
  param($Control)

  try {
    $ServerProcessId = [int]$Control.pid
    $InstanceId = [string]$Control.instance_id
    $ControlPort = [int]$Control.port
  }
  catch {
    return $false
  }

  if ($ServerProcessId -le 0 -or [string]::IsNullOrWhiteSpace($InstanceId) -or $ControlPort -ne 8765) {
    return $false
  }
  if (-not (Test-KibitzerPathEqual ([string]$Control.root) $Root.ToString())) {
    return $false
  }
  if (-not (Test-KibitzerPathEqual ([string]$Control.python_executable) $ServerPython)) {
    return $false
  }
  if (-not (Test-KibitzerPathEqual ([string]$Control.host_script) $ServerHostScript)) {
    return $false
  }

  try {
    $Process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ServerProcessId" -ErrorAction Stop
  }
  catch {
    Write-TrayLog "stop control rejected: process lookup failed: $($_.Exception.Message)"
    return $false
  }
  if (-not $Process) {
    Write-TrayLog "stop control rejected: pid=$ServerProcessId is not running"
    return $false
  }

  $HasProcessExecutable = $Control.PSObject.Properties.Name -contains "process_executable"
  if ($HasProcessExecutable -and -not (Test-KibitzerPathEqual ([string]$Process.ExecutablePath) ([string]$Control.process_executable))) {
    Write-TrayLog "stop control rejected: actual process executable did not match the recorded base executable"
    return $false
  }
  $CommandLine = [string]$Process.CommandLine
  if (
    $CommandLine.IndexOf($ServerPython, [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -or
    $CommandLine.IndexOf($ServerHostScript, [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -or
    $CommandLine.IndexOf("--port 8765", [System.StringComparison]::OrdinalIgnoreCase) -lt 0
  ) {
    Write-TrayLog "stop control rejected: command line did not match the worktree venv, host script, and port"
    return $false
  }

  try {
    $RecordedStart = [DateTimeOffset]::Parse([string]$Control.started_at).UtcDateTime
    $ActualStart = ([DateTime]$Process.CreationDate).ToUniversalTime()
    $StartDeltaSeconds = [Math]::Abs(($RecordedStart - $ActualStart).TotalSeconds)
  }
  catch {
    Write-TrayLog "stop control rejected: process start time could not be verified"
    return $false
  }
  if ($StartDeltaSeconds -gt 30) {
    Write-TrayLog "stop control rejected: pid start time differed from the record by ${StartDeltaSeconds}s"
    return $false
  }
  return $true
}

function Get-KibitzerServerControl {
  if (-not (Test-Path $ServerControlFile)) {
    Write-TrayLog "stop control missing: $ServerControlFile"
    return $null
  }

  try {
    $Control = Get-Content -LiteralPath $ServerControlFile -Encoding UTF8 -Raw | ConvertFrom-Json
  }
  catch {
    Write-TrayLog "stop control read failed: $($_.Exception.Message)"
    return $null
  }
  if (-not (Test-KibitzerServerControl $Control)) {
    Write-TrayLog "stop control rejected: record or process did not match the Kibitzer Windows host"
    return $null
  }
  return $Control
}

function Get-KibitzerLegacyServerProcess {
  try {
    $Candidates = @(
      Get-CimInstance -ClassName Win32_Process -Filter "Name = 'python.exe'" -ErrorAction Stop | Where-Object {
        $CommandLine = [string]$_.CommandLine
        (Test-KibitzerPathEqual ([string]$_.ExecutablePath) $ServerProcessPython) -and
          $CommandLine.IndexOf($ServerPython, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
          $CommandLine.IndexOf("-m uvicorn", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
          $CommandLine.IndexOf("apps.server.app.main:app", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
          $CommandLine.IndexOf("--port 8765", [System.StringComparison]::OrdinalIgnoreCase) -ge 0
      }
    )
  }
  catch {
    Write-TrayLog "legacy server lookup failed: $($_.Exception.Message)"
    return $null
  }

  if ($Candidates.Count -ne 1) {
    Write-TrayLog "legacy server lookup refused: matches=$($Candidates.Count)"
    return $null
  }
  return $Candidates[0]
}

function Write-KibitzerStopRequest {
  param(
    $Control,
    [string]$Source
  )

  $Request = [ordered]@{
    instance_id = [string]$Control.instance_id
    requested_at = [DateTime]::UtcNow.ToString("o")
    source = $Source
  }
  $Json = $Request | ConvertTo-Json -Compress
  $Temporary = "$ServerStopRequestFile.$PID.tmp"
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  try {
    [System.IO.File]::WriteAllText($Temporary, $Json, $Utf8NoBom)
    Move-Item -LiteralPath $Temporary -Destination $ServerStopRequestFile -Force
  }
  finally {
    Remove-Item -LiteralPath $Temporary -ErrorAction SilentlyContinue
  }
}

function Remove-KibitzerControlFiles {
  param([string]$InstanceId)

  foreach ($Path in @($ServerStopRequestFile, $ServerControlFile)) {
    if (-not (Test-Path $Path)) {
      continue
    }
    try {
      $Value = Get-Content -LiteralPath $Path -Encoding UTF8 -Raw | ConvertFrom-Json
      if ([string]$Value.instance_id -eq $InstanceId) {
        Remove-Item -LiteralPath $Path -ErrorAction SilentlyContinue
      }
    }
    catch {
      Write-TrayLog "stop cleanup skipped for $Path`: $($_.Exception.Message)"
    }
  }
}

function Set-KibitzerStopFailure {
  param(
    [string]$Outcome,
    [string]$Message
  )

  $Source = $Script:StopSource
  $Elapsed = Get-KibitzerStopElapsedSeconds
  Write-TrayLog "stop source=$Source outcome=$Outcome after ${Elapsed}s"
  Clear-KibitzerStoppingState
  $Script:RunningStatusMessageOverride = $Message
  if ($Script:LastHealthStatus) {
    Set-KibitzerTrayStatus $Script:LastHealthStatus
  }
  Queue-KibitzerTrayUpdate
}

function Stop-KibitzerServer {
  param([string]$Source = "menu")

  if ($Script:StartingUntil -or $Script:StoppingUntil) {
    Write-TrayLog "stop source=$Source skipped: transition-in-progress"
    return
  }
  if ($Script:LastHealthStatus -and $Script:LastHealthStatus.Mode -eq "dead") {
    Write-TrayLog "stop source=$Source skipped: health=dead"
    Set-KibitzerTrayStatus $Script:LastHealthStatus
    return
  }

  $Script:RunningStatusMessageOverride = $null
  $Script:StopSource = $Source
  $Script:StopStartedAt = Get-Date
  $Control = Get-KibitzerServerControl
  if (-not $Control) {
    $LegacyProcess = Get-KibitzerLegacyServerProcess
    if (-not $LegacyProcess) {
      Set-KibitzerStopFailure `
        -Outcome "precondition-failed: control-unavailable" `
        -Message "서버 프로세스를 안전하게 확인할 수 없어 중지하지 않았습니다. 'Open logs'에서 로그를 확인해 주세요."
      return
    }

    $LegacyInstanceId = "legacy-$($LegacyProcess.ProcessId)"
    $Script:StopControl = [pscustomobject]@{
      instance_id = $LegacyInstanceId
      pid = [int]$LegacyProcess.ProcessId
    }
    $Script:StopForced = $true
    try {
      Stop-Process -Id ([int]$LegacyProcess.ProcessId) -Force -ErrorAction Stop
    }
    catch {
      Write-TrayLog "stop source=$Source legacy force failed: $($_.Exception.Message)"
      Set-KibitzerStopFailure `
        -Outcome "legacy-force-failed" `
        -Message "기존 서버 프로세스를 중지하지 못했습니다. 'Open logs'에서 로그를 확인해 주세요."
      return
    }
    $Script:StoppingUntil = (Get-Date).AddSeconds($ForcedStopTimeoutSeconds)
    Write-TrayLog "stop source=$Source legacy forced pid=$($LegacyProcess.ProcessId)"
    Set-KibitzerStoppingTray
    return
  }

  try {
    Write-KibitzerStopRequest -Control $Control -Source $Source
  }
  catch {
    Write-TrayLog "stop source=$Source request write failed: $($_.Exception.Message)"
    Set-KibitzerStopFailure `
      -Outcome "precondition-failed: request-write-failed" `
      -Message "서버 중지 요청을 기록하지 못했습니다. 'Open logs'에서 로그를 확인해 주세요."
    return
  }

  $Script:StopControl = $Control
  $Script:StoppingUntil = (Get-Date).AddSeconds($GracefulStopTimeoutSeconds)
  Write-TrayLog "stop source=$Source requested pid=$($Control.pid) instance=$($Control.instance_id)"
  Set-KibitzerStoppingTray
  Queue-KibitzerTrayUpdate
}

function Stop-KibitzerServerHostProcess {
  $Current = Get-KibitzerServerControl
  if (-not $Current -or [string]$Current.instance_id -ne [string]$Script:StopControl.instance_id) {
    return $false
  }

  try {
    Stop-Process -Id ([int]$Current.pid) -Force -ErrorAction Stop
    Write-TrayLog "stop source=$($Script:StopSource) forced pid=$($Current.pid) instance=$($Current.instance_id)"
    return $true
  }
  catch {
    Write-TrayLog "stop source=$($Script:StopSource) force failed: $($_.Exception.Message)"
    return $false
  }
}

function Start-KibitzerServer {
  param([string]$Source = "menu")

  if ($Script:StartingUntil -or $Script:StoppingUntil) {
    Write-TrayLog "start source=$Source skipped: transition-in-progress"
    return
  }

  $Script:StatusMessageOverride = $null
  $Script:RunningStatusMessageOverride = $null
  $Script:StartSource = $Source

  $Python = Join-Path $Root ".venv\Scripts\python.exe"
  if (-not (Test-Path $Python)) {
    Set-KibitzerStartFailure `
      -Outcome "precondition-failed: python-venv-missing" `
      -Message "서버를 시작할 수 없습니다. 먼저 windows_setup.ps1을 실행해 주세요."
    return
  }
  if (-not (Test-Path $RunScript)) {
    Set-KibitzerStartFailure `
      -Outcome "precondition-failed: run-script-missing" `
      -Message "서버 실행 스크립트를 찾을 수 없습니다. 'Open logs'에서 로그를 확인해 주세요."
    return
  }

  try {
    $PowerShell = Get-WindowsPowerShell
  }
  catch {
    Write-TrayLog "start source=$Source powershell lookup failed: $($_.Exception.Message)"
    Set-KibitzerStartFailure `
      -Outcome "precondition-failed: powershell-missing" `
      -Message "Windows PowerShell을 찾을 수 없습니다. 'Open logs'에서 로그를 확인해 주세요."
    return
  }

  $Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $RunScript + '" -LogToFile'
  try {
    $Process = Start-Process `
      -FilePath $PowerShell `
      -ArgumentList $Arguments `
      -WorkingDirectory $Root `
      -WindowStyle Hidden `
      -PassThru `
      -ErrorAction Stop
  }
  catch {
    Write-TrayLog "start source=$Source spawn failed: $($_.Exception.Message)"
    Set-KibitzerStartFailure `
      -Outcome "precondition-failed: spawn-failed" `
      -Message "서버 프로세스를 시작하지 못했습니다. 'Open logs'에서 로그를 확인해 주세요."
    return
  }

  $Script:StartingUntil = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $Script:StartProcess = $Process
  $Script:StartStartedAt = Get-Date
  Write-TrayLog "start source=$Source spawned pid=$($Process.Id)"
  Set-KibitzerStartingTray
  Queue-KibitzerTrayUpdate
}

function Get-KibitzerTrayIconPath {
  foreach ($Candidate in $IconCandidates) {
    if (Test-Path $Candidate) {
      return $Candidate
    }
  }
  return $null
}

function Test-WindowsLightSystemTheme {
  try {
    $Theme = Get-ItemProperty `
      -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" `
      -Name "SystemUsesLightTheme" `
      -ErrorAction Stop
    return ([int]$Theme.SystemUsesLightTheme -ne 0)
  }
  catch {
    return $false
  }
}

function Get-KibitzerTrayGlyphColor {
  if (Test-WindowsLightSystemTheme) {
    return [System.Drawing.Color]::FromArgb(31, 41, 55)
  }
  return [System.Drawing.Color]::FromArgb(249, 250, 251)
}

function Get-KibitzerTrayHaloColor {
  if (Test-WindowsLightSystemTheme) {
    return [System.Drawing.Color]::FromArgb(249, 250, 251)
  }
  return [System.Drawing.Color]::FromArgb(31, 41, 55)
}

function New-KibitzerTrayIcon {
  param(
    [System.Drawing.Color]$Color
  )

  $IconPath = Get-KibitzerTrayIconPath
  $GlyphColor = Get-KibitzerTrayGlyphColor
  $HaloColor = Get-KibitzerTrayHaloColor
  $Bitmap = New-Object System.Drawing.Bitmap 32, 32
  $ClearGraphics = [System.Drawing.Graphics]::FromImage($Bitmap)
  $ClearGraphics.Clear([System.Drawing.Color]::Transparent)
  $ClearGraphics.Dispose()

  if ($IconPath) {
    $Source = [System.Drawing.Image]::FromFile($IconPath)
    $Mask = New-Object System.Drawing.Bitmap 26, 26
    $MaskGraphics = [System.Drawing.Graphics]::FromImage($Mask)
    $MaskGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $MaskGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $MaskGraphics.Clear([System.Drawing.Color]::Transparent)
    $MaskGraphics.DrawImage($Source, 0, 0, 26, 26)
    $MaskGraphics.Dispose()

    for ($X = 0; $X -lt 26; $X++) {
      for ($Y = 0; $Y -lt 26; $Y++) {
        $Pixel = $Mask.GetPixel($X, $Y)
        if ($Pixel.A -gt 0) {
          $Tinted = [System.Drawing.Color]::FromArgb($Pixel.A, $GlyphColor.R, $GlyphColor.G, $GlyphColor.B)
          $Bitmap.SetPixel($X + 2, $Y + 2, $Tinted)
        }
      }
    }

    $Mask.Dispose()
    $Source.Dispose()
  }

  $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
  $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $Brush = New-Object System.Drawing.SolidBrush -ArgumentList @($Color)
  $HaloBrush = New-Object System.Drawing.SolidBrush -ArgumentList @($HaloColor)
  $Pen = New-Object System.Drawing.Pen -ArgumentList @($HaloColor, 1)
  $Graphics.FillEllipse($HaloBrush, 21, 21, 10, 10)
  $Graphics.FillEllipse($Brush, 22, 22, 8, 8)
  $Graphics.DrawEllipse($Pen, 22, 22, 8, 8)

  $Icon = [System.Drawing.Icon]::FromHandle($Bitmap.GetHicon()).Clone()

  $Pen.Dispose()
  $HaloBrush.Dispose()
  $Brush.Dispose()
  $Graphics.Dispose()
  $Bitmap.Dispose()

  return $Icon
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

[System.Windows.Forms.Application]::EnableVisualStyles()

$HttpClient = New-Object System.Net.Http.HttpClient
$HttpClient.Timeout = [TimeSpan]::FromSeconds($HealthRequestTimeoutSeconds)

$TrayIcons = @{
  active = New-KibitzerTrayIcon ([System.Drawing.Color]::FromArgb(40, 170, 95))
  idle = New-KibitzerTrayIcon ([System.Drawing.Color]::FromArgb(145, 145, 145))
  dead = New-KibitzerTrayIcon ([System.Drawing.Color]::FromArgb(210, 70, 70))
  unknown = New-KibitzerTrayIcon ([System.Drawing.Color]::FromArgb(240, 190, 60))
}

$NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$NotifyIcon.Text = "Kibitzer: starting"
$NotifyIcon.Icon = $TrayIcons.unknown
$NotifyIcon.Visible = $true

$Menu = New-Object System.Windows.Forms.ContextMenuStrip
$StatusHeaderItem = $Menu.Items.Add("Kibitzer: starting")
$StatusHeaderItem.Enabled = $false
$Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$RefreshItem = $Menu.Items.Add("Refresh status")
$ServerToggleItem = $Menu.Items.Add("Start server")
$ServerToggleItem.Enabled = $false
$OpenLogsItem = $Menu.Items.Add("Open logs")
$ExitItem = $Menu.Items.Add("Exit tray")
$Script:ServerToggleItem = $ServerToggleItem
$NotifyIcon.ContextMenuStrip = $Menu

function Set-KibitzerTrayStatus {
  param($Status)

  $IconKey = if ($TrayIcons.ContainsKey($Status.IconKey)) { $Status.IconKey } else { "unknown" }
  $NotifyIcon.Icon = $TrayIcons[$IconKey]
  $NotifyIcon.Text = $Status.Text
  if ($Status.Mode -eq "dead") {
    $Script:RunningStatusMessageOverride = $null
  }
  else {
    $Script:StatusMessageOverride = $null
  }
  if ($Script:StatusMessageOverride -and $Status.Mode -eq "dead") {
    $StatusHeaderItem.Text = $Script:StatusMessageOverride
  }
  elseif ($Script:RunningStatusMessageOverride -and $Status.Mode -ne "dead") {
    $StatusHeaderItem.Text = $Script:RunningStatusMessageOverride
  }
  else {
    $StatusHeaderItem.Text = $Status.Message
  }
  $Transitioning = [bool]($Script:AutoStartPending -or $Script:StartingUntil -or $Script:StoppingUntil)
  $ServerToggleItem.Text = if ($Status.Mode -eq "dead") { "Start server" } else { "Stop server" }
  $ServerToggleItem.Enabled = -not $Transitioning
}

function Resolve-KibitzerStartingState {
  param($Status)

  if ($Status.Mode -ne "dead") {
    $Source = $Script:StartSource
    $Elapsed = Get-KibitzerStartElapsedSeconds
    Write-TrayLog "start source=$Source outcome=health-ok after ${Elapsed}s"
    Clear-KibitzerStartingState
    Set-KibitzerTrayStatus $Status
    return
  }

  if ($Script:StartProcess -and $Script:StartProcess.HasExited) {
    Set-KibitzerStartFailure `
      -Outcome "wrapper-exited" `
      -Message "서버 시작에 실패했습니다. 'Open logs'에서 로그를 확인해 주세요." `
      -IncludeAppLog
    return
  }

  if ((Get-Date) -gt $Script:StartingUntil) {
    Set-KibitzerStartFailure `
      -Outcome "timeout" `
      -Message "서버 시작 시간이 초과되었습니다. 'Open logs'에서 로그를 확인해 주세요." `
      -IncludeAppLog
    return
  }

  Set-KibitzerStartingTray
}

function Resolve-KibitzerStoppingState {
  param($Status)

  if ($Status.Mode -eq "dead") {
    $Source = $Script:StopSource
    $Elapsed = Get-KibitzerStopElapsedSeconds
    $Forced = $Script:StopForced
    $InstanceId = [string]$Script:StopControl.instance_id
    Write-TrayLog "stop source=$Source outcome=health-dead forced=$Forced after ${Elapsed}s"
    Remove-KibitzerControlFiles -InstanceId $InstanceId
    Clear-KibitzerStoppingState
    $Script:StatusMessageOverride = "서버가 중지되었습니다. 메뉴에서 'Start server'를 눌러 다시 실행할 수 있습니다."
    Set-KibitzerTrayStatus $Status
    return
  }

  if ((Get-Date) -gt $Script:StoppingUntil) {
    if (-not $Script:StopForced -and (Stop-KibitzerServerHostProcess)) {
      $Script:StopForced = $true
      $Script:StoppingUntil = (Get-Date).AddSeconds($ForcedStopTimeoutSeconds)
      Set-KibitzerStoppingTray
      return
    }

    Set-KibitzerStopFailure `
      -Outcome $(if ($Script:StopForced) { "force-timeout" } else { "graceful-timeout: force-refused" }) `
      -Message "서버 중지 시간이 초과되었습니다. 안전을 위해 확인되지 않은 프로세스는 종료하지 않았습니다. 'Open logs'에서 로그를 확인해 주세요."
    return
  }

  Set-KibitzerStoppingTray
}

function Apply-KibitzerHealthStatus {
  param($Status)

  $Script:LastHealthStatus = $Status
  if ($Script:AutoStartPending) {
    $Script:AutoStartPending = $false
    if ($Status.Mode -eq "dead") {
      Start-KibitzerServer -Source "auto"
      return
    }
    Write-TrayLog "start source=auto skipped: health=$($Status.Mode)"
    Set-KibitzerTrayStatus $Status
    return
  }

  if ($Script:StartingUntil) {
    Resolve-KibitzerStartingState $Status
    return
  }
  if ($Script:StoppingUntil) {
    Resolve-KibitzerStoppingState $Status
    return
  }

  Set-KibitzerTrayStatus $Status
}

function Update-KibitzerTray {
  if ($Script:HealthRequest) {
    $Status = Receive-KibitzerHealthStatus
    if (-not $Status) {
      return
    }
    Apply-KibitzerHealthStatus $Status
    if (-not $Script:HealthRequest) {
      Set-KibitzerNextHealthPoll
    }
    return
  }

  if ((Get-Date) -lt $Script:NextHealthPollAt) {
    return
  }
  $Status = Start-KibitzerHealthRequest
  if ($Status) {
    Apply-KibitzerHealthStatus $Status
    Set-KibitzerNextHealthPoll
  }
}

$RefreshItem.Add_Click({ Request-KibitzerTrayUpdate })
$Menu.Add_ItemClicked({
  param($EventSender, $EventArgs)
  $Script:KeepMenuOpenAfterRefresh = [object]::ReferenceEquals($EventArgs.ClickedItem, $RefreshItem)
})
$Menu.Add_Closing({
  param($EventSender, $EventArgs)
  if (
    $Script:KeepMenuOpenAfterRefresh -and
    $EventArgs.CloseReason -eq [System.Windows.Forms.ToolStripDropDownCloseReason]::ItemClicked
  ) {
    $EventArgs.Cancel = $true
  }
  $Script:KeepMenuOpenAfterRefresh = $false
})
$ServerToggleItem.Add_Click({
  if ($Script:AutoStartPending -or $Script:StartingUntil -or $Script:StoppingUntil) {
    return
  }
  $Status = $Script:LastHealthStatus
  if (-not $Status) {
    Request-KibitzerTrayUpdate
    return
  }
  if ($Status.Mode -eq "dead") {
    Start-KibitzerServer -Source "menu"
  }
  else {
    Stop-KibitzerServer -Source "menu"
  }
})
$OpenLogsItem.Add_Click({
  $QuotedLogDir = '"' + $LogDir + '"'
  Start-Process -FilePath explorer.exe -ArgumentList @($QuotedLogDir)
})
$ExitItem.Add_Click({ [System.Windows.Forms.Application]::Exit() })
$NotifyIcon.Add_MouseClick({
  param($EventSender, $EventArgs)
  if ($EventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    Request-KibitzerTrayUpdate
    $ShowMenu = [System.Windows.Forms.NotifyIcon].GetMethod("ShowContextMenu", [System.Reflection.BindingFlags]"Instance,NonPublic")
    $ShowMenu.Invoke($NotifyIcon, $null)
  }
})

$Timer = New-Object System.Windows.Forms.Timer
$Timer.Interval = $HealthRequestCheckInterval
$Script:Timer = $Timer
$Timer.Add_Tick({ Update-KibitzerTray })
$Timer.Start()
Request-KibitzerTrayUpdate

[System.Windows.Forms.Application]::Run()

$Timer.Stop()
$Timer.Dispose()
$HttpClient.Dispose()
$NotifyIcon.Visible = $false
$NotifyIcon.Dispose()
foreach ($Icon in $TrayIcons.Values) {
  $Icon.Dispose()
}
Remove-Item -LiteralPath $TrayPidFile -ErrorAction SilentlyContinue
Write-TrayLog "tray exiting pid=$PID"
$Mutex.ReleaseMutex()
$Mutex.Dispose()
