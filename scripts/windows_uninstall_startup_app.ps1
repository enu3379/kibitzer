$ErrorActionPreference = "Stop"

$ShortcutName = "Kibitzer Server.lnk"
$StartupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$TrayPidFile = Join-Path $Root "data\logs\windows-startup-tray.pid"

if (-not $StartupDir) {
  $StartupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
}

$ShortcutPath = Join-Path $StartupDir $ShortcutName

if (-not (Test-Path $ShortcutPath)) {
  Write-Host "No Startup shortcut found at $ShortcutPath."
  exit 0
}

Remove-Item -LiteralPath $ShortcutPath

Write-Host "Removed Startup shortcut: $ShortcutPath"

if (Test-Path $TrayPidFile) {
  try {
    $TrayPid = [int](Get-Content -LiteralPath $TrayPidFile -Raw)
    Stop-Process -Id $TrayPid -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $TrayPidFile -ErrorAction SilentlyContinue
    Write-Host "Stopped Kibitzer tray process: $TrayPid"
  }
  catch {
    Write-Warning "Could not stop Kibitzer tray process from $TrayPidFile."
  }
}
