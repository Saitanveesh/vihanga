# Independent Vihanga developer launcher. No Mission Planner or aircraft IO.
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$venv = Join-Path $root ".venv"
$python = Join-Path $venv "Scripts\python.exe"
$backend = Join-Path $root "backend"
$console = Join-Path $root "console"

if (-not (Test-Path $python)) {
    if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
        throw "Python launcher 'py' not found. Install Python 3.12 or newer."
    }
    & py -3 -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "Python virtual environment creation failed." }
}
& $python -m pip install -e $backend
if ($LASTEXITCODE -ne 0) { throw "Backend package installation failed." }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "Node.js / npm missing. Install Node 20 or newer."
}
Push-Location $console
try {
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw "Console dependency installation failed." }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Console TypeScript build failed." }
} finally { Pop-Location }

Write-Host "Starting standalone Vihanga, no Mission Planner and no aircraft control."
Write-Host "API: http://127.0.0.1:8010/api/v1/health"
Write-Host "Console: http://127.0.0.1:5173"
$apiCmd = "& '$python' -m uvicorn vihanga.app:app --host 127.0.0.1 --port 8010"
$uiCmd = "Set-Location -LiteralPath '$console'; npm.cmd run dev"
Start-Process powershell.exe -ArgumentList @("-NoExit", "-NoProfile", "-Command", $apiCmd) -WorkingDirectory $root
Start-Process powershell.exe -ArgumentList @("-NoExit", "-NoProfile", "-Command", $uiCmd) -WorkingDirectory $console
