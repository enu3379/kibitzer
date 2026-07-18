$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$NotificationAppId = "Kibitzer.Tray"
$StartupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
if (-not $StartupDir) {
  $StartupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
}

foreach ($Name in @("Kibitzer.lnk", "Kibitzer Server.lnk")) {
  $ShortcutPath = Join-Path $StartupDir $Name
  if (Test-Path $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath
    Write-Host "Removed Startup shortcut: $ShortcutPath"
  }
}

$NotificationKey = "HKCU:\Software\Classes\AppUserModelId\$NotificationAppId"
if (Test-Path $NotificationKey) {
  Remove-Item -LiteralPath $NotificationKey -Recurse
  Write-Host "Removed notification app registration: $NotificationAppId"
}

$DataDirs = @()
if ($env:KIBITZER_HOME) {
  $DataDirs += $env:KIBITZER_HOME
}
if ($env:LOCALAPPDATA) {
  $DataDirs += (Join-Path $env:LOCALAPPDATA "Kibitzer")
}
$DataDirs += (Join-Path $Root "data")

$ControlDirs = @()
foreach ($DataDir in ($DataDirs | Select-Object -Unique)) {
  $ControlDirs += (Join-Path $DataDir "runtime")
  # Also recognize control files written by early development builds.
  $ControlDirs += $DataDir
}

foreach ($ControlDir in ($ControlDirs | Select-Object -Unique)) {
  $ControlPath = Join-Path $ControlDir "tray-control.json"
  $RequestPath = Join-Path $ControlDir "tray-exit-request.json"
  $AttentionPath = Join-Path $ControlDir "tray-attention-request.json"
  Remove-Item -LiteralPath $AttentionPath -ErrorAction SilentlyContinue
  if (-not (Test-Path $ControlPath)) {
    continue
  }
  try {
    $Control = Get-Content -LiteralPath $ControlPath -Raw | ConvertFrom-Json
    if (
      $Control.service -ne "kibitzer-tray" -or
      $Control.protocol_version -ne 1 -or
      [string]::IsNullOrWhiteSpace([string]$Control.instance_id)
    ) {
      throw "Invalid Kibitzer tray control record."
    }
    $PendingPath = "$RequestPath.tmp"
    @{
      service = "kibitzer-tray"
      protocol_version = 1
      instance_id = [string]$Control.instance_id
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $PendingPath -Encoding UTF8
    Move-Item -LiteralPath $PendingPath -Destination $RequestPath -Force
    Write-Host "Requested graceful tray/server exit."

    $Deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $Deadline -and (Test-Path $ControlPath)) {
      Start-Sleep -Milliseconds 250
    }
    if (Test-Path $ControlPath) {
      Write-Warning "Kibitzer tray did not exit within 15 seconds; no PID-based force kill was attempted."
    }
  }
  catch {
    Write-Warning "Could not request tray exit from ${ControlPath}: $($_.Exception.Message)"
  }
}

# This file belonged to the retired PowerShell tray. Never trust its PID: it
# may have been reused by an unrelated process.
$LegacyPidFile = Join-Path $Root "data\logs\windows-startup-tray.pid"
Remove-Item -LiteralPath $LegacyPidFile -ErrorAction SilentlyContinue
