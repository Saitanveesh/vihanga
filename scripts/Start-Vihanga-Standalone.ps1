# Vihanga local GCS launcher; independent of Mission Planner.
[CmdletBinding()]
param(
    [switch]$ApiOnly,
    [switch]$SkipInstall,
    [switch]$BenchRead,
    [switch]$PropellersRemoved
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$python = Join-Path $root ".venv\Scripts\python.exe"
$backend = Join-Path $root "backend"
$console = Join-Path $root "console"
$logs = Join-Path $root "data\launcher-logs"
$apiUrl = "http://127.0.0.1:8010/api/v1/health"
$uiUrl = "http://127.0.0.1:5173/"

if ($BenchRead) {
    if (-not $PropellersRemoved) {
        throw "Bench requests require propeller removal. Use -BenchRead -PropellersRemoved only after physically removing every propeller."
    }
    $env:VIHANGA_BENCH_READ_REQUESTS = "1"
}

function Get-VihangaHealth {
    try {
        $reply = Invoke-RestMethod -Uri $apiUrl -TimeoutSec 2 -ErrorAction Stop
    } catch {
        return $null
    }
    if ($reply.service -ne "vihanga-standalone" -or $reply.status -ne "ok") {
        throw "Port 8010 responded, but it is not the Vihanga operations API."
    }
    return $reply
}

function Test-VihangaConsole {
    try {
        $reply = Invoke-WebRequest -Uri $uiUrl -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    } catch {
        return $false
    }
    if ($reply.StatusCode -ne 200 -or $reply.Content -notmatch "Vihanga \| Operations Console") {
        throw "Port 5173 responded, but the website is not the Vihanga console."
    }
    return $true
}

function Wait-VihangaApi {
    param([System.Diagnostics.Process]$Process, [string]$ErrorLog)
    for ($i = 0; $i -lt 60; $i++) {
        $health = Get-VihangaHealth
        if ($health) { return $health }
        if ($Process.HasExited) { break }
        Start-Sleep -Milliseconds 500
    }
    $diagnostic = if (Test-Path $ErrorLog) {
        (Get-Content -LiteralPath $ErrorLog -Tail 16 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
    } else { "No stderr log recorded." }
    try { if (-not $Process.HasExited) { Stop-Process -Id $Process.Id -Force } } catch {}
    throw "Vihanga API failed startup on 127.0.0.1:8010. Log: $ErrorLog $diagnostic"
}

function Wait-VihangaConsole {
    param([System.Diagnostics.Process]$Process, [string]$ErrorLog)
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-VihangaConsole) { return }
        if ($Process.HasExited) { break }
        Start-Sleep -Milliseconds 500
    }
    $diagnostic = if (Test-Path $ErrorLog) {
        (Get-Content -LiteralPath $ErrorLog -Tail 16 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
    } else { "No stderr log recorded." }
    try { if (-not $Process.HasExited) { Stop-Process -Id $Process.Id -Force } } catch {}
    throw "Vihanga console failed startup on 127.0.0.1:5173. Log: $ErrorLog $diagnostic"
}

$health = Get-VihangaHealth
if (-not $health) {
    if (-not (Test-Path $python)) {
        if ($SkipInstall) {
            throw "Python environment missing at $python. Start again without -SkipInstall."
        }
        if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
            throw "Python launcher missing. Install Python 3.12 or newer."
        }
        & py -3 -m venv (Join-Path $root ".venv")
        if ($LASTEXITCODE -ne 0) { throw "Python environment creation failed." }
    }
    if (-not $SkipInstall) {
        & $python -m pip install -e $backend
        if ($LASTEXITCODE -ne 0) { throw "Backend dependency installation failed." }
    }
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $apiStdout = Join-Path $logs "api.stdout.log"
    $apiStderr = Join-Path $logs "api.stderr.log"
    $apiArgs = @("-m", "uvicorn", "vihanga.app:app", "--host", "127.0.0.1", "--port", "8010", "--no-access-log")
    $apiProcess = Start-Process -FilePath $python -ArgumentList $apiArgs -WorkingDirectory $root -PassThru -RedirectStandardOutput $apiStdout -RedirectStandardError $apiStderr
    $health = Wait-VihangaApi -Process $apiProcess -ErrorLog $apiStderr
    Write-Host "Vihanga API started (PID $($apiProcess.Id))." -ForegroundColor Green
} else {
    Write-Host "Using existing Vihanga API at $apiUrl." -ForegroundColor Cyan
}

if ($BenchRead) {
    $caps = Invoke-RestMethod -Uri "http://127.0.0.1:8010/api/v1/capabilities" -TimeoutSec 4
    if ($caps.bench_nonactuating_requests -ne $true) {
        throw "Existing API was started without bench-read mode. Stop that API and relaunch with -BenchRead -PropellersRemoved. No request was sent."
    }
}
Write-Host "Local API confirmed: $apiUrl" -ForegroundColor Green
if ($ApiOnly) { return }

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "npm unavailable. Install Node.js 20+ for the operator console."
}
if (-not $SkipInstall) {
    Push-Location $console
    try {
        & npm.cmd install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm installation failed." }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "Console build failed." }
    } finally {
        Pop-Location
    }
}
if (-not (Test-VihangaConsole)) {
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $uiStdout = Join-Path $logs "console.stdout.log"
    $uiStderr = Join-Path $logs "console.stderr.log"
    $uiProcess = Start-Process -FilePath "cmd.exe" -ArgumentList "/d", "/c", "npm.cmd run dev -- --strictPort" -WorkingDirectory $console -PassThru -RedirectStandardOutput $uiStdout -RedirectStandardError $uiStderr
    Wait-VihangaConsole -Process $uiProcess -ErrorLog $uiStderr
    Write-Host "Vihanga console started (PID $($uiProcess.Id))." -ForegroundColor Green
} else {
    Write-Host "Using existing Vihanga console." -ForegroundColor Cyan
}
Write-Host "OPEN: $uiUrl" -ForegroundColor Green
Write-Host "LOGS: $logs" -ForegroundColor DarkGray
Write-Host "Flight-control authority is governed separately; launch options cannot bypass it."
