$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  throw "Missing .venv. Run .\scripts\windows_setup.ps1 first."
}

New-Item -ItemType Directory -Force data | Out-Null

& ".\.venv\Scripts\python.exe" -m uvicorn apps.server.app.main:app --host 127.0.0.1 --port 8765
exit $LASTEXITCODE
