# Vihanga local GCS launcher; independent of Mission Planner.
[CmdletBinding()]
param(
    [switch]$ApiOnly,
    [switch]$SkipInstall,
    [switch]$Dev,
    [switch]$Rebuild,
    [switch]$NoOpen,
    [switch]$BenchRead,
    [switch]$PropellersRemoved
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$python = Join-Path $root ".venv\Scripts\python.exe"
$backend = Join-Path $root "backend"
$console = Join-Path $root "console"
$dist = Join-Path $console "dist"
$logs = Join-Path $root "data\launcher-logs"
$apiOrigin = "http://127.0.0.1:8010"
$apiUrl = "$apiOrigin/api/v1/health"
$uiUrl = if ($Dev) { "http://127.0.0.1:5173/" } else { "$apiOrigin/" }

if ($ApiOnly -and ($Dev -or $Rebuild)) { throw "-ApiOnly cannot be combined with -Dev or -Rebuild." }
if ($Rebuild -and $SkipInstall) { throw "-Rebuild and -SkipInstall are mutually exclusive." }

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
        throw "Unexpected console response at $uiUrl."
    }
    if (-not $Dev -and $reply.Headers["X-Vihanga-Console"] -ne "production") {
        throw "Expected a production console response at $uiUrl."
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
    throw "Vihanga console failed startup at $uiUrl. Log: $ErrorLog $diagnostic"
}

function Invoke-VihangaNpm {
    param([string[]]$TaskArgs)
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw "Install Node.js 20+ to build or develop the console."
    }
    Push-Location $console
    try {
        & npm.cmd @TaskArgs
        if ($LASTEXITCODE -ne 0) { throw "npm $($TaskArgs -join ' ') failed." }
    } finally { Pop-Location }
}

$health = Get-VihangaHealth
if (-not $ApiOnly -and -not $Dev) {
    if ($health -and $health.console_served -ne $true) {
        throw "The API on port 8010 is running in API-only mode. Stop that instance before starting the station, or use -Dev."
    }
    if ($health -and $Rebuild) {
        throw "Stop the running station before rebuilding its console."
    }
    if (-not $health -and ($Rebuild -or -not (Test-Path (Join-Path $dist "index.html")) -or -not (Test-Path (Join-Path $dist "assets") -PathType Container))) {
        if ($SkipInstall) { throw "Compiled console missing at $dist. Run once without -SkipInstall." }
        Write-Host "[1/3] Building the production console" -ForegroundColor Cyan
        Invoke-VihangaNpm -TaskArgs @("ci", "--no-audit", "--no-fund")
        Invoke-VihangaNpm -TaskArgs @("run", "build")
    } else {
        Write-Host "[1/3] Production console available" -ForegroundColor Cyan
    }
}

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
    $hasBackend = $false
    if (-not $SkipInstall -and -not $Rebuild -and (Test-Path $python)) {
        & $python -c "from importlib.util import find_spec; raise SystemExit(0 if find_spec('vihanga') else 1)"
        $hasBackend = $LASTEXITCODE -eq 0
    }
    if (-not $SkipInstall -and -not $hasBackend) {
        & $python -m pip install -e $backend
        if ($LASTEXITCODE -ne 0) { throw "Backend dependency installation failed." }
    }
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $apiStdout = Join-Path $logs "api.stdout.log"
    $apiStderr = Join-Path $logs "api.stderr.log"
    $apiArgs = @("-m", "uvicorn", "vihanga.app:app", "--host", "127.0.0.1", "--port", "8010", "--no-access-log")
    $previousDist = $env:VIHANGA_CONSOLE_DIST
    try {
        $env:VIHANGA_CONSOLE_DIST = if ($ApiOnly -or $Dev) { $null } else { $dist }
        $apiProcess = Start-Process -FilePath $python -ArgumentList $apiArgs -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $apiStdout -RedirectStandardError $apiStderr
    } finally {
        $env:VIHANGA_CONSOLE_DIST = $previousDist
    }
    $health = Wait-VihangaApi -Process $apiProcess -ErrorLog $apiStderr
    Write-Host "Vihanga API started (PID $($apiProcess.Id))." -ForegroundColor Green
} else {
    Write-Host "Using existing Vihanga API at $apiUrl." -ForegroundColor Cyan
}

if ($BenchRead) {
    if ($health.bench_read_configured -ne $true) {
        throw "Existing API was started without bench-read mode. Stop that API and relaunch with -BenchRead -PropellersRemoved. No request was sent."
    }
}
Write-Host "[2/3] Local API ready at $apiUrl" -ForegroundColor Green
if ($ApiOnly) { return }

if ($Dev -and -not (Test-VihangaConsole)) {
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw "Install Node.js 20+ to run the development console."
    }
    if (-not $SkipInstall) { Invoke-VihangaNpm -TaskArgs @("ci", "--no-audit", "--no-fund") }
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $uiStdout = Join-Path $logs "console.stdout.log"
    $uiStderr = Join-Path $logs "console.stderr.log"
    $uiProcess = Start-Process -FilePath "cmd.exe" -ArgumentList "/d", "/c", "npm.cmd run dev -- --strictPort" -WorkingDirectory $console -WindowStyle Hidden -PassThru -RedirectStandardOutput $uiStdout -RedirectStandardError $uiStderr
    Wait-VihangaConsole -Process $uiProcess -ErrorLog $uiStderr
    Write-Host "Vihanga console started (PID $($uiProcess.Id))." -ForegroundColor Green
} elseif (-not (Test-VihangaConsole)) {
    throw "The production console at $uiUrl failed its readiness check. See $logs."
}
Write-Host "[3/3] Station ready at $uiUrl" -ForegroundColor Green
Write-Host "LOGS: $logs" -ForegroundColor DarkGray
if (-not $NoOpen) {
    $edge = if (${env:ProgramFiles(x86)}) {
        Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
    }
    if (-not $Dev -and $edge -and (Test-Path $edge -PathType Leaf)) {
        Start-Process -FilePath $edge -ArgumentList "--app=$uiUrl"
    } else {
        Start-Process $uiUrl
    }
}
