$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function New-KibitzerVenv {
  if (Test-Path ".venv\Scripts\python.exe") {
    return
  }

  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3.11 -m venv .venv
    if ($LASTEXITCODE -eq 0) {
      return
    }

    & py -3 -m venv .venv
    if ($LASTEXITCODE -eq 0) {
      return
    }
  }

  if (Get-Command python -ErrorAction SilentlyContinue) {
    & python -m venv .venv
    if ($LASTEXITCODE -eq 0) {
      return
    }
  }

  throw "Python 3.11+ is required. Install Python, then rerun this script."
}

function Add-NodeToProcessPath {
  $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($NodeCommand) {
    $NodeDir = Split-Path -Parent $NodeCommand.Source
  }
  else {
    $NpmCommand = Get-Command npm -ErrorAction SilentlyContinue
    $NpmDir = if ($NpmCommand) { Split-Path -Parent $NpmCommand.Source } else { $null }
    $NodeDir = if ($NpmDir -and (Test-Path (Join-Path $NpmDir "node.exe"))) { $NpmDir } else { $null }
  }

  if (-not $NodeDir) {
    return
  }

  if (-not $env:Path.StartsWith("$NodeDir;")) {
    $env:Path = "$NodeDir;$env:Path"
  }
}

New-Item -ItemType Directory -Force data | Out-Null
New-KibitzerVenv
Add-NodeToProcessPath

Invoke-Native ".\.venv\Scripts\python.exe" @("-m", "pip", "install", "--upgrade", "pip")
Invoke-Native ".\.venv\Scripts\python.exe" @("-m", "pip", "install", "-e", ".[test]")
Invoke-Native ".\.venv\Scripts\python.exe" @("scripts\download_embedding_model.py")

Push-Location "apps\extension"
try {
  Invoke-Native "npm" @("ci")
  Invoke-Native "npm" @("run", "build")
}
finally {
  Pop-Location
}

Write-Host "Setup complete. Start the server with .\scripts\windows_run_server.ps1"
