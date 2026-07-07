param(
  [switch]$LogToFile
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  throw "Missing .venv. Run .\scripts\windows_setup.ps1 first."
}

New-Item -ItemType Directory -Force data | Out-Null
$env:PYTHONUNBUFFERED = "1"

$Python = ".\.venv\Scripts\python.exe"
$Arguments = @("-m", "uvicorn", "apps.server.app.main:app", "--host", "127.0.0.1", "--port", "8765")

if ($LogToFile) {
  $LogDir = Join-Path $Root "data\logs"
  New-Item -ItemType Directory -Force $LogDir | Out-Null
  $OutLog = Join-Path $LogDir "windows-startup-app.out.log"
  $ErrLog = Join-Path $LogDir "windows-startup-app.err.log"
  & $Python @Arguments 1>> $OutLog 2>> $ErrLog
}
else {
  & $Python @Arguments
}
exit $LASTEXITCODE
