$ErrorActionPreference = "Stop"

$ShortcutName = "Kibitzer Server.lnk"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$TrayScript = Join-Path $Root "scripts\windows_startup_tray.ps1"
$Python = Join-Path $Root ".venv\Scripts\python.exe"
$LogDir = Join-Path $Root "data\logs"
$PortFile = Join-Path $Root "data\kibitzer.port"
$TrayPidFile = Join-Path $LogDir "windows-startup-tray.pid"
$StartupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)

if (-not $StartupDir) {
  $StartupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
}

$ShortcutPath = Join-Path $StartupDir $ShortcutName

if (-not (Test-Path $Python)) {
  throw "Missing .venv. Run .\scripts\windows_setup.ps1 first."
}

if (-not (Test-Path $TrayScript)) {
  throw "Missing $TrayScript."
}

New-Item -ItemType Directory -Force (Join-Path $Root "data") | Out-Null
New-Item -ItemType Directory -Force $LogDir | Out-Null
New-Item -ItemType Directory -Force $StartupDir | Out-Null

function Wait-KibitzerHealth {
  param(
    [int]$TimeoutSeconds = 20
  )

  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $Deadline) {
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
      return Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 2 -ErrorAction Stop
    }
    catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $null
}

$PowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path $PowerShell)) {
  $PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
}

function Test-KibitzerTrayRunning {
  if (-not (Test-Path $TrayPidFile)) {
    return $false
  }

  try {
    $TrayPid = [int](Get-Content -LiteralPath $TrayPidFile -Raw)
  }
  catch {
    return $false
  }

  $Process = Get-Process -Id $TrayPid -ErrorAction SilentlyContinue
  return [bool]($Process -and $Process.ProcessName -in @("powershell", "pwsh"))
}

$ShortcutArguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $TrayScript + '"'
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $PowerShell
$Shortcut.Arguments = $ShortcutArguments
$Shortcut.WorkingDirectory = $Root.ToString()
$Shortcut.WindowStyle = 7
$Shortcut.Description = "Starts the Kibitzer local server at Windows logon in idle mode."
$Shortcut.Save()

Write-Host "Installed Startup shortcut: $ShortcutPath"
Write-Host "Effective port: $PortFile"
Write-Host "Logs: $(Join-Path $LogDir 'windows-startup-app.out.log') and .err.log"

if (-not (Test-KibitzerTrayRunning)) {
  Start-Process -FilePath $PowerShell -ArgumentList $ShortcutArguments -WorkingDirectory $Root -WindowStyle Hidden
  Start-Sleep -Milliseconds 500
}

$Health = Wait-KibitzerHealth
if ($Health) {
  Write-Host "Health check ok. mode=$($Health.mode)"
}
else {
  Write-Warning "Startup shortcut was installed, but Kibitzer did not respond within 20 seconds. Check the logs above."
}
