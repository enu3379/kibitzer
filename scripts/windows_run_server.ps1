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

$Python = Join-Path $Root ".venv\Scripts\python.exe"
$HostScript = Join-Path $Root "scripts\windows_server_host.py"
$LogDir = Join-Path $Root "data\logs"
if (-not (Test-Path $HostScript)) {
  throw "Missing $HostScript."
}
$Arguments = @(
  ('"' + $HostScript + '"'),
  "--host",
  "127.0.0.1",
  "--port",
  "8765",
  "--runtime-dir",
  ('"' + $LogDir + '"')
)

$StartInfo = New-Object System.Diagnostics.ProcessStartInfo
$StartInfo.FileName = $Python
$StartInfo.Arguments = $Arguments -join " "
$StartInfo.WorkingDirectory = $Root.ToString()
$StartInfo.UseShellExecute = $false
$StartInfo.CreateNoWindow = [bool]$LogToFile

$OutStream = $null
$ErrStream = $null
$OutCopyTask = $null
$ErrCopyTask = $null

if ($LogToFile) {
  New-Item -ItemType Directory -Force $LogDir | Out-Null
  $OutLog = Join-Path $LogDir "windows-startup-app.out.log"
  $ErrLog = Join-Path $LogDir "windows-startup-app.err.log"
  $StartInfo.RedirectStandardOutput = $true
  $StartInfo.RedirectStandardError = $true
  $OutStream = [System.IO.File]::Open($OutLog, "Append", "Write", "ReadWrite")
  $ErrStream = [System.IO.File]::Open($ErrLog, "Append", "Write", "ReadWrite")
}

$ServerExitCode = 1
$ServerProcess = New-Object System.Diagnostics.Process
$ServerProcess.StartInfo = $StartInfo
try {
  # Windows PowerShell 5.1 promotes native stderr to PowerShell error records.
  # Uvicorn writes normal INFO startup messages to stderr, so invoking it with
  # the call operator under ErrorActionPreference=Stop aborts a healthy start.
  # Use the .NET process API so native streams stay native and the actual exit
  # code remains authoritative.
  if (-not $ServerProcess.Start()) {
    throw "Could not start the Kibitzer server process."
  }

  if ($LogToFile) {
    $OutCopyTask = $ServerProcess.StandardOutput.BaseStream.CopyToAsync($OutStream)
    $ErrCopyTask = $ServerProcess.StandardError.BaseStream.CopyToAsync($ErrStream)
    while (-not $ServerProcess.WaitForExit(1000)) {
      $OutStream.Flush()
      $ErrStream.Flush()
    }
    [System.Threading.Tasks.Task]::WaitAll(
      [System.Threading.Tasks.Task[]]@($OutCopyTask, $ErrCopyTask)
    )
    $OutStream.Flush()
    $ErrStream.Flush()
  }
  else {
    $ServerProcess.WaitForExit()
  }

  $ServerExitCode = $ServerProcess.ExitCode
}
finally {
  if ($OutStream) {
    $OutStream.Dispose()
  }
  if ($ErrStream) {
    $ErrStream.Dispose()
  }
  $ServerProcess.Dispose()
}

exit $ServerExitCode
