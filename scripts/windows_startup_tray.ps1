$ErrorActionPreference = "Stop"

# Compatibility launcher for existing shortcuts. New installations point
# directly at pythonw.exe (or the packaged Kibitzer.exe) and do not keep a
# PowerShell process alive.
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Pythonw = Join-Path $Root ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $Pythonw)) {
  throw "Missing .venv. Run .\scripts\windows_setup.ps1 first."
}
Start-Process `
  -FilePath $Pythonw `
  -ArgumentList "-m apps.server.app.windows_tray --autostart" `
  -WorkingDirectory $Root `
  -WindowStyle Hidden
