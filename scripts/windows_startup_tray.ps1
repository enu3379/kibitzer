param(
  [int]$PollSeconds = 10
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$RunScript = Join-Path $Root "scripts\windows_run_server.ps1"
$IconCandidates = @(
  (Join-Path $Root "apps\extension\icons\variants\monitor-template-128.png"),
  (Join-Path $Root "apps\extension\icons\variants\monitor-template-48.png"),
  (Join-Path $Root "apps\extension\icons\variants\monitor-template-32.png"),
  (Join-Path $Root "apps\extension\dist\icons\variants\monitor-template-128.png"),
  (Join-Path $Root "apps\extension\dist\icons\variants\monitor-template-48.png"),
  (Join-Path $Root "apps\extension\dist\icons\variants\monitor-template-32.png")
)
$HealthUrl = "http://127.0.0.1:8765/health"
$LogDir = Join-Path $Root "data\logs"
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
$Script:NotifyIcon = $null
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
    $Health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2 -ErrorAction Stop
    $Mode = if ($Health.mode) { [string]$Health.mode } else { "unknown" }
    if ($Mode -eq "active") {
      return @{ Mode = "active"; IconKey = "active"; Text = "Kibitzer: active" }
    }
    if ($Mode -eq "idle") {
      return @{ Mode = "idle"; IconKey = "idle"; Text = "Kibitzer: idle" }
    }
    return @{ Mode = $Mode; IconKey = "unknown"; Text = "Kibitzer: $Mode" }
  }
  catch {
    return @{ Mode = "dead"; IconKey = "dead"; Text = "Kibitzer: not running" }
  }
}

function Show-KibitzerBalloon {
  param(
    [string]$Text,
    [string]$Kind = "Info"
  )

  if (-not $Script:NotifyIcon) {
    return
  }

  $Icon = [System.Windows.Forms.ToolTipIcon]::Info
  if ($Kind -eq "Warning") {
    $Icon = [System.Windows.Forms.ToolTipIcon]::Warning
  }
  $Script:NotifyIcon.ShowBalloonTip(5000, "Kibitzer", $Text, $Icon)
}

function Set-KibitzerTrayText {
  param([string]$Text)

  if (-not $Script:NotifyIcon) {
    return
  }
  if ($Text.Length -gt 63) {
    $Text = $Text.Substring(0, 63)
  }
  $Script:NotifyIcon.Text = $Text
}

function Set-KibitzerStartingTray {
  if ($Script:NotifyIcon) {
    $Script:NotifyIcon.Icon = $TrayIcons.unknown
    Set-KibitzerTrayText "Kibitzer: starting..."
  }
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
  if ($Script:StartItem) {
    $Script:StartItem.Enabled = $true
  }
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

function Fail-KibitzerStartingState {
  param([string]$Outcome)

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
  Write-KibitzerStartupErrTail
  Clear-KibitzerStartingState
  Show-KibitzerBalloon "Server failed to start. See data\logs\windows-startup-app.err.log (menu > Open logs)." "Warning"
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

  $Python = Join-Path $Root ".venv\Scripts\python.exe"
  if (-not (Test-Path $Python)) {
    Write-TrayLog "start source=$Source outcome=precondition-failed: python-venv-missing"
    Show-KibitzerBalloon "Python venv not found. Run scripts\windows_setup.ps1 first." "Warning"
    return
  }
  if (-not (Test-Path $RunScript)) {
    Write-TrayLog "start source=$Source outcome=precondition-failed: run-script-missing"
    Show-KibitzerBalloon "Run script not found. Check scripts\windows_run_server.ps1." "Warning"
    return
  }

  try {
    $PowerShell = Get-WindowsPowerShell
  }
  catch {
    Write-TrayLog "start source=$Source outcome=precondition-failed: powershell-missing $($_.Exception.Message)"
    Show-KibitzerBalloon "Windows PowerShell not found. See data\logs (menu > Open logs)." "Warning"
    return
  }

  $Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $RunScript + '" -LogToFile'
  try {
    $Process = Start-Process -FilePath $PowerShell -ArgumentList $Arguments -WorkingDirectory $Root -WindowStyle Hidden -PassThru -ErrorAction Stop
  }
  catch {
    Write-TrayLog "start source=$Source outcome=precondition-failed: spawn-failed $($_.Exception.Message)"
    Show-KibitzerBalloon "Server failed to start. See data\logs (menu > Open logs)." "Warning"
    return
  }

  $Script:StartingUntil = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $Script:StartSource = $Source
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
$Script:NotifyIcon = $NotifyIcon

$Menu = New-Object System.Windows.Forms.ContextMenuStrip
$RefreshItem = $Menu.Items.Add("Refresh status")
$StartItem = $Menu.Items.Add("Start server")
$OpenHealthItem = $Menu.Items.Add("Open health")
$OpenLogsItem = $Menu.Items.Add("Open logs")
$ExitItem = $Menu.Items.Add("Exit tray")
$Script:StartItem = $StartItem
$NotifyIcon.ContextMenuStrip = $Menu

function Set-KibitzerTrayStatus {
  param($Status)

  $IconKey = if ($TrayIcons.ContainsKey($Status.IconKey)) { $Status.IconKey } else { "unknown" }
  $NotifyIcon.Icon = $TrayIcons[$IconKey]
  Set-KibitzerTrayText $Status.Text
}

function Resolve-KibitzerStartingState {
  $Status = Get-KibitzerHealthStatus
  if ($Status.Mode -ne "dead") {
    $Source = $Script:StartSource
    $Elapsed = Get-KibitzerStartElapsedSeconds
    Write-TrayLog "start source=$Source outcome=health-ok after ${Elapsed}s"
    Clear-KibitzerStartingState
    Set-KibitzerTrayStatus $Status
    if ($Source -eq "menu") {
      Show-KibitzerBalloon "Kibitzer server is running." "Info"
    }
    return
  }

  if ($Script:StartProcess -and $Script:StartProcess.HasExited) {
    Fail-KibitzerStartingState "wrapper-exited"
    return
  }

  if ((Get-Date) -gt $Script:StartingUntil) {
    Fail-KibitzerStartingState "timeout"
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
$OpenHealthItem.Add_Click({ Start-Process $HealthUrl })
$OpenLogsItem.Add_Click({ Start-Process -FilePath explorer.exe -ArgumentList @($LogDir) })
$ExitItem.Add_Click({ [System.Windows.Forms.Application]::Exit() })
$NotifyIcon.Add_DoubleClick({ Start-Process $HealthUrl })

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
