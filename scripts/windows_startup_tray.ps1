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

function Start-KibitzerServer {
  $Status = Get-KibitzerHealthStatus
  if ($Status.Mode -ne "dead") {
    return
  }
  if (-not (Test-Path (Join-Path $Root ".venv\Scripts\python.exe"))) {
    return
  }

  $PowerShell = Get-WindowsPowerShell
  $Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $RunScript + '" -LogToFile'
  Start-Process -FilePath $PowerShell -ArgumentList $Arguments -WorkingDirectory $Root -WindowStyle Hidden
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

Start-KibitzerServer

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
$OpenHealthItem = $Menu.Items.Add("Open health")
$ExitItem = $Menu.Items.Add("Exit tray")
$NotifyIcon.ContextMenuStrip = $Menu

function Update-KibitzerTray {
  $Status = Get-KibitzerHealthStatus
  $IconKey = if ($TrayIcons.ContainsKey($Status.IconKey)) { $Status.IconKey } else { "unknown" }
  $NotifyIcon.Icon = $TrayIcons[$IconKey]
  $NotifyIcon.Text = $Status.Text
  $StatusHeaderItem.Text = $Status.Message
}

$RefreshItem.Add_Click({ Update-KibitzerTray })
$StartItem.Add_Click({
  Start-KibitzerServer
  Start-Sleep -Milliseconds 500
  Update-KibitzerTray
})
$OpenHealthItem.Add_Click({ Start-Process $HealthUrl })
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
$Timer.Interval = [Math]::Max(1, $PollSeconds) * 1000
$Timer.Add_Tick({ Update-KibitzerTray })
$Timer.Start()

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
