$ErrorActionPreference = "Stop"

$ShortcutName = "Kibitzer.lnk"
$NotificationAppId = "Kibitzer.Tray"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PackagedTray = Join-Path $Root "dist\kibitzer\Kibitzer.exe"
$Pythonw = Join-Path $Root ".venv\Scripts\pythonw.exe"
$StartupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)

if (-not $StartupDir) {
  $StartupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
}

$LegacyShortcutPath = Join-Path $StartupDir "Kibitzer Server.lnk"
if (Test-Path $LegacyShortcutPath) {
  Remove-Item -LiteralPath $LegacyShortcutPath
  Write-Host "Removed legacy Startup shortcut: $LegacyShortcutPath"
}

if (Test-Path $PackagedTray) {
  $Target = $PackagedTray
  $Arguments = "--autostart"
  $WorkingDirectory = Split-Path -Parent $PackagedTray
  $DataDir = if ($env:KIBITZER_HOME) { $env:KIBITZER_HOME } else { Join-Path $env:LOCALAPPDATA "Kibitzer" }
  $NotificationIcon = Join-Path (Split-Path -Parent $PackagedTray) "_internal\icons\monitor-v1-mono-128.png"
}
else {
  if (-not (Test-Path $Pythonw)) {
    throw "Missing .venv. Run .\scripts\windows_setup.ps1 first."
  }
  $Target = $Pythonw
  $Arguments = "-m apps.server.app.windows_tray --autostart"
  $WorkingDirectory = $Root.ToString()
  $DataDir = if ($env:KIBITZER_HOME) { $env:KIBITZER_HOME } else { Join-Path $Root "data" }
  $NotificationIcon = Join-Path $Root "apps\extension\icons\variants\monitor-v1-mono-128.png"
}

$ShortcutPath = Join-Path $StartupDir $ShortcutName
New-Item -ItemType Directory -Force $StartupDir | Out-Null
New-Item -ItemType Directory -Force $DataDir | Out-Null

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Target
$Shortcut.Arguments = $Arguments
$Shortcut.WorkingDirectory = $WorkingDirectory
$Shortcut.WindowStyle = 7
$Shortcut.Description = "Starts Kibitzer and its local server at Windows logon."
$Shortcut.Save()

# Register a stable current-user identity for modern Windows toast
# notifications. The tray also refreshes these values at runtime so a copied
# development build remains usable before this installer is run.
$NotificationKey = "HKCU:\Software\Classes\AppUserModelId\$NotificationAppId"
New-Item -Path $NotificationKey -Force | Out-Null
New-ItemProperty -Path $NotificationKey -Name "DisplayName" -Value "Kibitzer" -PropertyType String -Force | Out-Null
New-ItemProperty -Path $NotificationKey -Name "IconUri" -Value $NotificationIcon -PropertyType String -Force | Out-Null
New-ItemProperty -Path $NotificationKey -Name "IconBackgroundColor" -Value "FF111827" -PropertyType String -Force | Out-Null

Write-Host "Installed Startup shortcut: $ShortcutPath"
Write-Host "Registered notification app: $NotificationAppId"
Write-Host "Runtime data: $DataDir"
Write-Host "Logs: $(Join-Path $DataDir 'logs')"

# Starting an already-running tray is safe: its named mutex makes the duplicate
# autostart process exit quietly without creating a second icon.
if ($Arguments) {
  Start-Process -FilePath $Target -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden
}
else {
  Start-Process -FilePath $Target -WorkingDirectory $WorkingDirectory -WindowStyle Hidden
}

$Ports = @(49187, 51387, 53587, 55787, 57987)
$Deadline = (Get-Date).AddSeconds(30)
$Health = $null
while ((Get-Date) -lt $Deadline) {
  foreach ($Port in $Ports) {
    try {
      $Identity = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/identity" -TimeoutSec 1 -ErrorAction Stop
      if (
        $Identity.service -eq "kibitzer" -and
        $Identity.protocol_version -eq 1 -and
        -not [string]::IsNullOrWhiteSpace([string]$Identity.instance_id)
      ) {
        $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1 -ErrorAction Stop
        break
      }
    }
    catch {
      continue
    }
  }
  if ($Health) {
    break
  }
  Start-Sleep -Milliseconds 250
}

if ($Health) {
  Write-Host "Health check ok. mode=$($Health.mode)"
}
else {
  Write-Warning "Startup shortcut was installed, but Kibitzer did not respond within 30 seconds. Check the logs above."
}
