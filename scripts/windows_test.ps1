$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  throw "Missing .venv. Run .\scripts\windows_setup.ps1 first."
}

& ".\.venv\Scripts\python.exe" -m pytest apps/server/tests -q
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Push-Location "apps\extension"
try {
  & npm run test
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
