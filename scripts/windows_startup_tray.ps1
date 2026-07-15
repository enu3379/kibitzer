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
$LogDir = Join-Path $Root "data\logs"
$PortFile = Join-Path $Root "data\kibitzer.port"
$TrayLog = Join-Path $LogDir "windows-startup-tray.log"
$TrayPidFile = Join-Path $LogDir "windows-startup-tray.pid"
$StartupErrLog = Join-Path $LogDir "windows-startup-app.err.log"
$DefaultTimerInterval = [Math]::Max(1, $PollSeconds) * 1000
$StartingTimerInterval = 1000
$StartupTimeoutSeconds = 30
$Script:StartingUntil = $null
$Script:StartSource = $null
$Script:StartProcess = $null
$Script:StartStartedAt = $null
$Script:StatusMessageOverride = $null
$Script:StartItem = $null
$Script:Timer = $null

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

function Get-KibitzerHealthStatus {
  try {
    $Port = [int](Get-Content -LiteralPath $PortFile -Raw -ErrorAction Stop)
    if ($Port -lt 1 -or $Port -gt 65535) {
      throw "Invalid Kibitzer port file."
    }
    $BaseUrl = "http://127.0.0.1:$Port"
    $Identity = Invoke-RestMethod -Uri "$BaseUrl/identity" -TimeoutSec 2 -ErrorAction Stop
    if (
      $Identity.service -ne "kibitzer" -or
      $Identity.protocol_version -ne 1 -or
      [string]::IsNullOrWhiteSpace([string]$Identity.instance_id)
    ) {
      throw "Port $Port is not a Kibitzer server."
    }
    $Health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 2 -ErrorAction Stop
    $Mode = if ($Health.mode) { [string]$Health.mode } else { "unknown" }
    if ($Mode -eq "active") {
      return @{ Mode = "active"; IconKey = "active"; Text = "Kibitzer: active"; Message = "서버가 작동 중이며 활동을 관찰하고 있습니다." }
    }
    if ($Mode -eq "idle") {
      return @{ Mode = "idle"; IconKey = "idle"; Text = "Kibitzer: idle"; Message = "서버는 실행 중이며 대기 상태입니다. 활동이 감지되면 자동으로 활성화됩니다." }
    }
    return @{ Mode = $Mode; IconKey = "unknown"; Text = "Kibitzer: $Mode"; Message = "서버 상태를 확인할 수 없습니다 (mode=$Mode). 잠시 후 다시 확인해 주세요." }
  }
  catch {
    return @{ Mode = "dead"; IconKey = "dead"; Text = "Kibitzer: not running"; Message = "서버가 실행되지 않았습니다. 메뉴에서 'Start server'를 눌러 실행해 주세요." }
  }
}

function Set-KibitzerStartingTray {
  $NotifyIcon.Icon = $TrayIcons.unknown
  $NotifyIcon.Text = "Kibitzer: starting"
  $StatusHeaderItem.Text = "서버를 시작하고 있습니다..."
  if ($Script:StartItem) {
    $Script:StartItem.Enabled = $false
  }
  if ($Script:Timer) {
    $Script:Timer.Interval = $StartingTimerInterval
  }
}

function Clear-KibitzerStartingState {
  $Script:StartingUntil = $null
  $Script:StartSource = $null
  $Script:StartProcess = $null
  $Script:StartStartedAt = $null
  if ($Script:Timer) {
    $Script:Timer.Interval = $DefaultTimerInterval
  }
}

function Get-KibitzerStartElapsedSeconds {
  if (-not $Script:StartStartedAt) {
    return 0
  }
  return [Math]::Round(((Get-Date) - $Script:StartStartedAt).TotalSeconds, 1)
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
  Update-KibitzerTray
}

function Start-KibitzerServer {
  param([string]$Source = "menu")

  $Status = Get-KibitzerHealthStatus
  if ($Status.Mode -ne "dead") {
    Write-TrayLog "start source=$Source skipped: health=$($Status.Mode)"
    return
  }
  if ($Script:StartingUntil) {
    Write-TrayLog "start source=$Source skipped: already-starting"
    return
  }

  $Script:StatusMessageOverride = $null
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

[System.Windows.Forms.Application]::EnableVisualStyles()

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
$StartItem = $Menu.Items.Add("Start server")
$OpenLogsItem = $Menu.Items.Add("Open logs")
$ExitItem = $Menu.Items.Add("Exit tray")
$Script:StartItem = $StartItem
$NotifyIcon.ContextMenuStrip = $Menu

function Set-KibitzerTrayStatus {
  param($Status)

  $IconKey = if ($TrayIcons.ContainsKey($Status.IconKey)) { $Status.IconKey } else { "unknown" }
  $NotifyIcon.Icon = $TrayIcons[$IconKey]
  $NotifyIcon.Text = $Status.Text
  if ($Status.Mode -ne "dead") {
    $Script:StatusMessageOverride = $null
  }
  if ($Script:StatusMessageOverride -and $Status.Mode -eq "dead") {
    $StatusHeaderItem.Text = $Script:StatusMessageOverride
  }
  else {
    $StatusHeaderItem.Text = $Status.Message
  }
  $StartItem.Enabled = ($Status.Mode -eq "dead" -and -not $Script:StartingUntil)
}

function Resolve-KibitzerStartingState {
  $Status = Get-KibitzerHealthStatus
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

function Update-KibitzerTray {
  if ($Script:StartingUntil) {
    Resolve-KibitzerStartingState
    return
  }

  $Status = Get-KibitzerHealthStatus
  Set-KibitzerTrayStatus $Status
}

$RefreshItem.Add_Click({ Update-KibitzerTray })
$StartItem.Add_Click({
  Start-KibitzerServer -Source "menu"
})
$OpenLogsItem.Add_Click({
  $QuotedLogDir = '"' + $LogDir + '"'
  Start-Process -FilePath explorer.exe -ArgumentList @($QuotedLogDir)
})
$ExitItem.Add_Click({ [System.Windows.Forms.Application]::Exit() })
$NotifyIcon.Add_MouseClick({
  param($EventSender, $EventArgs)
  if ($EventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    Update-KibitzerTray
    $ShowMenu = [System.Windows.Forms.NotifyIcon].GetMethod("ShowContextMenu", [System.Reflection.BindingFlags]"Instance,NonPublic")
    $ShowMenu.Invoke($NotifyIcon, $null)
  }
})

$Timer = New-Object System.Windows.Forms.Timer
$Timer.Interval = $DefaultTimerInterval
$Script:Timer = $Timer
$Timer.Add_Tick({ Update-KibitzerTray })
$Timer.Start()

Start-KibitzerServer -Source "auto"
Update-KibitzerTray

[System.Windows.Forms.Application]::Run()

$Timer.Stop()
$Timer.Dispose()
$NotifyIcon.Visible = $false
$NotifyIcon.Dispose()
foreach ($Icon in $TrayIcons.Values) {
  $Icon.Dispose()
}
Remove-Item -LiteralPath $TrayPidFile -ErrorAction SilentlyContinue
Write-TrayLog "tray exiting pid=$PID"
$Mutex.ReleaseMutex()
$Mutex.Dispose()
